import {assert,AppError} from './errors.mjs';
import {outputId} from './report-create-receipt.mjs';
import {timestampMs} from './work-time.mjs';

export function readApproval(raw){
 const value=raw?.approveStatus??raw?.approvalStatus;
 if(value===0||value==='0'||value==='未审批'||value==='待审批')return 0;
 if(value===10||value==='10'||value==='已审批'||value==='审批通过')return 10;
 return null;
}
export function approvalProjection(raw,receipt){
 return receipt&&!(timestampMs(raw?.updatedAt)>timestampMs(receipt.remoteUpdatedAt))?receipt.status:readApproval(raw);
}

// Blacklake's first-party web client sends outputApproveList to the same
// endpoint for both approve (10) and revoke (0). Never edit quantities to
// change approval and never infer success from the batch write receipt.
export class ReportApprovals{
 constructor({store,sync,blacklake,authorize}){Object.assign(this,{store,sync,blacklake,authorize});this.db=store.db;this.jobs=sync.jobs;}
 link(orderId,processId,reportId){
  const local=this.store.reportById(reportId),id=outputId(local?.blacklake_output_id??(/^blacklake:\d+$/.test(reportId)?reportId.slice(10):null));
  assert(id&&(!local||local.status==='SUCCEEDED'),409,'REPORT_NOT_APPROVABLE','报工尚未关联到黑湖。');
  const raw=this.db.prepare('SELECT * FROM blacklake_output_index WHERE output_id=? AND project_id=? AND task_id=? AND deleted=0').get(id,orderId,processId);
  assert(raw&&(!local||local.project_id===Number(orderId)&&local.task_id===Number(processId)),404,'REPORT_NOT_FOUND','报工与当前工单和工序不一致。');
  const mirror=this.db.prepare("SELECT id FROM reports WHERE blacklake_output_id=? LIMIT 1").get(id);
  assert(!mirror||mirror.id===reportId,409,'REPORT_LINK_CHANGED','报工关联已变化，请刷新报表。');
  return {id,raw:JSON.parse(raw.raw_json)};
 }
 enqueue(orderId,processId,reportId,input,operationId,ownerId){
  this.authorize(ownerId);
  assert(typeof input?.approved==='boolean'&&[0,10].includes(input.expectedStatus)&&/^[A-Za-z0-9_-]{16,120}$/.test(operationId),422,'REPORT_APPROVAL_INPUT','请刷新后提交有效的报工审批。');
  const target=input.approved?10:0,key='approval:'+ownerId+':'+operationId,prior=this.jobs.byKey(key);
  if(prior){
   const p=prior.payload;assert(prior.report_id===reportId&&p.orderId===orderId&&p.processId===processId&&p.target===target&&p.expected===input.expectedStatus,409,'SYNC_IDEMPOTENCY_CONFLICT','操作编号已用于其他内容。');
   return this.receipt(prior);
  }
  const linked=this.link(orderId,processId,reportId);
  assert(approvalProjection(linked.raw,this.sync.snapshot('report-approval',linked.id).data)===input.expectedStatus,409,'REPORT_APPROVAL_CHANGED','黑湖审批状态已变化，请刷新。');
  assert(!this.jobs.pendingReport(reportId)&&!this.jobs.pendingReport('blacklake:'+linked.id),409,'REPORT_SYNC_PENDING','这笔报工正在同步，可继续处理其他报工。');
  const payload={ownerId,orderId,processId,id:linked.id,target,expected:input.expectedStatus};
  const job=this.jobs.enqueue({key,mode:'write',kind:'report-approval',reportId,target:linked.id,payload,actor:'report-manager:'+ownerId});
  return this.receipt(job);
 }
 receipt(job){return {accepted:true,queued:['QUEUED','RUNNING','RETRY'].includes(job.state),status:job.state,sync:this.sync.publicJob(job)};}
 async read(job){
  const p=job.payload,response=await this.blacklake.nativeRequest('/api/dytin/output/web/detail',{outputId:Number(p.id)}),row=response?.data;
  assert(String(response?.code)==='01000000'&&outputId(row?.outputId??row?.id)===p.id&&Number(row.projectId)===p.orderId&&Number(row.projectProcessId)===p.processId&&typeof row.blInApprove==='boolean'&&readApproval(row)!==null,502,'BLACKLAKE_REPORT_APPROVAL_READ_INVALID','无法确认这笔报工的黑湖审批状态。');
  return row;
 }
 async execute(job){
  const p=job.payload;this.authorize(p.ownerId);this.link(p.orderId,p.processId,job.report_id);
  const before=await this.read(job);
  if(readApproval(before)===p.target&&!before.blInApprove)return this.confirm(job,before,{refreshOrder:false});
  assert(!before.blInApprove&&readApproval(before)===p.expected,409,'REPORT_APPROVAL_CHANGED','黑湖审批状态已变化，本次未修改。');
  this.authorize(p.ownerId);this.sync.assertClaim(job);this.jobs.sending(job.id,job.attempts);
  let error;
  try{await this.blacklake.nativeRequest('/api/dytin/output/approve',{outputApproveList:[{outputId:Number(p.id),approveStatus:p.target}]},{write:true,retryAuth:false});}
  catch(e){if(e.writeNotSent)throw e;error=e;}
  try{const row=await this.read(job);if(!row.blInApprove&&readApproval(row)===p.target)return this.confirm(job,row);}catch{}
  throw new AppError(409,'BLACKLAKE_REPORT_APPROVAL_UNCONFIRMED',error?'黑湖审批提交结果不明，系统继续核对。':'黑湖审批尚未回读确认，系统继续核对。');
 }
 confirm(job,row,{reconcile=false,refreshOrder=true}={}){
  if(!reconcile)this.sync.assertClaim(job);
  const p=job.payload,receipt={outputId:p.id,approved:p.target===10,readbackConfirmed:true};
  this.db.exec('BEGIN IMMEDIATE');try{
   assert(!reconcile||this.jobs.get(job.id)?.state==='UNKNOWN',409,'SYNC_JOB_CHANGED','同步状态已变化。');
   this.sync.save('report-approval',p.id,{status:p.target,remoteUpdatedAt:row.updatedAt??null});
   if(refreshOrder)this.sync.invalidateOrder(p.orderId,{outputId:p.id});
   this.db.prepare("UPDATE integration_jobs SET state=CASE WHEN ? THEN 'SUCCEEDED' ELSE state END,safe_retry=0,error_code='',result_json=?,updated_at=? WHERE id=?").run(reconcile?1:0,JSON.stringify(receipt),this.sync.now(),job.id);
   this.jobs.event(job.id,'APPROVAL_READBACK_CONFIRMED','SYSTEM',receipt);this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  return receipt;
 }
 async reconcile(job){
  const row=await this.read(job);
  if(!row.blInApprove&&readApproval(row)===job.payload.target)this.confirm(job,row,{reconcile:true});
  return this.receipt(this.jobs.get(job.id));
 }
}
