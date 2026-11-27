import {timestampMs} from './work-time.mjs';
import {assert} from './errors.mjs';

const delays=[5*60000,30*60000,2*3600000,6*3600000,24*3600000];
const stamp=at=>new Date(at+8*3600000).toISOString().slice(0,19).replace('T',' ');
const number=v=>v!=null&&String(v).trim()!==''&&Number.isFinite(Number(v))?Number(v):NaN;
const defects=items=>JSON.stringify((items||[]).map(i=>({code:String(i.code||i.defectCode||''),amount:number(i.amount??i.defectAmount??i.quantity)})).sort((a,b)=>a.code.localeCompare(b.code)));
const humanErrors=new Set(['TASK_CLOSED','REPORT_PERSON_CHANGED','REPORT_TASK_CHANGED','REPORT_VERSION_CHANGED','REPORT_REMOTE_CHANGED','SUBMIT_IDENTITY_CHANGED','REPORT_OWNER_ROLE_CHANGED','ADMIN_CONFIRMED_ABSENT']);
const ambiguousMatch='有多条相同报工，系统不能判断应关联哪一条';

// Recovery only retries read jobs or confirms existing write receipts. A missing
// match is never proof of absence and must never enqueue another create/delete.
export class SyncRecovery {
 constructor({sync,outbox}){
  this.sync=sync;this.outbox=outbox;this.db=sync.db;this.jobs=sync.jobs;this.now=sync.now;
  this.db.exec('CREATE INDEX IF NOT EXISTS integration_events_job ON integration_job_events(job_id,id)');
  sync.recovery=this;sync.scheduleRecovery=()=>this.schedule();
  sync.handlers.set('write-review',job=>this.review(job));
 }
 meta(id){return this.sync.snapshot('control','recovery:'+id).data||{};}
 save(id,data){this.sync.save('control','recovery:'+id,data);}
 status(job){
  if(job.kind==='write-review')return {category:'automatic',label:'自动核对',reason:'只读核对已提交结果'};
  if(!['UNKNOWN','FAILED','RETRY'].includes(job.state))return null;
  if(job.kind==='order-operation-write')return job.state==='UNKNOWN'?
    {category:'automatic',label:'工单核对中',reason:'系统定向读取工单，必要时可在工单操作中刷新'}:
    {category:'system',label:'工单修改未完成',reason:'可在工单操作中查看并重新编辑'};
  if(job.kind==='order-process-edit'&&job.state==='UNKNOWN')return {category:'automatic',label:'工序核对中',reason:'正在只读核对本次工序修改，其他工序可继续使用'};
  const meta=this.meta(job.id);
  if(job.mode==='read')return {category:'automatic',label:job.state==='FAILED'?'等待自动恢复':'自动恢复中',reason:'系统会按退避计划重新读取，无需逐条点击重试',nextAt:meta.nextAt?new Date(meta.nextAt).toISOString():new Date(job.updated_at+delays[0]).toISOString()};
  if(job.state==='UNKNOWN'){
   if(!meta.systemError&&meta.needsHuman&&meta.reason===ambiguousMatch)return {category:'human',label:'需要确认',reason:ambiguousMatch};
   if(meta.systemError||meta.needsHuman||meta.round>=3)return {category:'system',label:'系统核对受阻',reason:meta.systemError?
    '黑湖查询异常，系统会继续低频核对。原报工已保留。':
    '黑湖尚无可确认的结果，系统继续低频只读核对。原报工已保留。'};
   return {category:'automatic',label:'自动核对中',reason:'系统正在只读核对黑湖结果',nextAt:meta.nextAt?new Date(meta.nextAt).toISOString():null};
  }
  if(job.state==='RETRY')return {category:'automatic',label:'自动重试中',reason:'已确认可以安全继续的操作由后台处理'};
  const humanReason=({
   TASK_CLOSED:'上次发送前工序不可报工。确认工序已开放且仍需提交后，可重试原报工。',
   ADMIN_CONFIRMED_ABSENT:'已确认黑湖没有产生这笔报工，可重试原提交。'
  })[job.error_code];
  return humanErrors.has(job.error_code)?{category:'human',label:'需要确认',reason:humanReason||'业务资料或权限已变化，需确认原操作是否仍有效'}:{category:'system',label:'系统异常',reason:'系统接口或校验异常，应由维护处理，无需反复点重试'};
 }
 attentionGroups(){
  const groups={automatic:[],system:[],human:[]};
  const rows=this.db.prepare("SELECT id,mode,kind,state,error_code FROM integration_jobs WHERE state IN ('UNKNOWN','FAILED','RETRY') AND kind<>'write-review' ORDER BY updated_at DESC,id").all();
  for(const row of rows){const status=this.status(row);if(status)groups[status.category].push(row.id);}
  return groups;
 }
 summary(groups=this.attentionGroups()){return Object.fromEntries(Object.entries(groups).map(([category,ids])=>[category,ids.length]));}
 listAttention(category,{offset=0,limit=50,groups=this.attentionGroups()}={}){
  assert(Object.hasOwn(groups,category),422,'SYNC_STATE_INVALID','同步处理分类无效。');
  assert(Number.isSafeInteger(offset)&&offset>=0,422,'SYNC_PAGE_INVALID','分页参数无效。');
  const ids=groups[category];return {total:ids.length,jobs:ids.slice(offset,offset+limit).map(id=>this.jobs.get(id))};
 }
 schedule(){
  const at=this.now(),control=this.sync.snapshot('control','auto-recovery-schedule').data;
  if(control&&at-control.at<60000)return;
  this.sync.save('control','auto-recovery-schedule',{at});
  // One slow probe per minute. After a probe fails, wait longer; pages, visitors,
  // and service restarts cannot reset this persisted delay.
  for(const row of this.db.prepare("SELECT id FROM integration_jobs WHERE mode='read' AND state='FAILED' AND safe_retry=1 AND kind<>'write-review' ORDER BY updated_at,id").all()){
   const job=this.jobs.get(row.id),prior=job.result.autoProbe?this.meta(job.id):{},round=prior.round||0;
   if(at<(prior.nextAt||job.updated_at+delays[0]))continue;
   const changed=this.db.prepare("UPDATE integration_jobs SET state='QUEUED',due_at=?,lease_until=NULL,result_json=?,updated_at=? WHERE id=? AND state='FAILED' AND updated_at=?").run(at,JSON.stringify({...job.result,autoProbe:true,consecutiveFailures:this.sync.maxReadFailures-1}),at,job.id,job.updated_at);
   if(changed.changes){this.save(job.id,{round:round+1,nextAt:at+delays[Math.min(round+1,delays.length-1)]});this.jobs.event(job.id,'AUTO_READ_PROBE','SYSTEM',{round:round+1});break;}
  }
  for(const row of this.db.prepare("SELECT id FROM integration_jobs WHERE mode='write' AND state='UNKNOWN' AND kind<>'order-operation-write' ORDER BY updated_at,id").all()){
   const parent=this.jobs.get(row.id),meta=this.meta(parent.id);
   if(meta.nextAt>at)continue;
   const existing=this.jobs.byKey('read:write-review:'+parent.id);
   if(existing&&['QUEUED','RUNNING','RETRY'].includes(existing.state))continue;
   if(existing?.state==='FAILED'){
    if(!existing.safe_retry)continue;
    this.jobs.retry(existing.id,'SYSTEM_AUTO_REVIEW',existing);
   }
   const version=this.sync.jobVersion(parent);
   this.sync.request('write-review',parent.id,{jobId:parent.id,version},existing?.state==='FAILED'&&existing.payload.version!==version);
   this.save(parent.id,{...meta,nextAt:at+delays[Math.min(meta.round||0,delays.length-1)]});break;
  }
 }
 matches(raw,parent){
  const input=parent.payload.input,identity=this.outbox.store.members.snapshot(parent.report_id),operator=identity?.submitAsId??input?.operator.blacklakeOperatorId;
  return input&&number(raw.projectId)===number(input.task.projectId)&&number(raw.taskId??raw.projectProcessId)===number(input.task.taskId)
   &&number(raw.productionStaffId??raw.operatorId)===number(operator)&&number(raw.numberofgoodProducts??raw.fineAmount)===input.amount-input.defectAmount
   &&number(raw.numberofDefectives??raw.defectsAmount)===input.defectAmount
   &&Number.isFinite(timestampMs(input.actualStartedAt))&&timestampMs(raw.starttimeofReport??raw.planStartTime)===timestampMs(input.actualStartedAt)
   &&Number.isFinite(timestampMs(input.actualEndedAt))&&timestampMs(raw.endtimeofReport??raw.planEndTime)===timestampMs(input.actualEndedAt)
   &&defects(raw.defectItemList??raw.defectList)===defects(input.defectItems??[]);
 }
 async review(job){
  const parent=this.jobs.get(job.payload.jobId);
  if(!parent||parent.state!=='UNKNOWN'||this.sync.jobVersion(parent)!==job.payload.version)return {skipped:'parent-changed'};
  const meta=this.meta(parent.id),round=(meta.round||0)+1;
  let reason='',needsHuman=false;
  try{
   let outputId;
   if(['report-create','manual-report-create'].includes(parent.kind)&&!this.outbox.store.reportById(parent.report_id)?.blacklake_output_id){
    const steps=this.jobs.progress(job),pageNum=steps.pageNum||1,boundary=this.db.prepare("SELECT MIN(created_at) first,MAX(created_at) last FROM integration_job_events WHERE job_id=? AND event='WRITE_BOUNDARY'").get(parent.id);
    const from=steps.from||stamp((boundary.first||parent.created_at)-60000),to=steps.to||stamp((boundary.last||parent.updated_at)+5*60000),page=await this.outbox.blacklake.queryOutputPage({projectCode:parent.payload.input.task.projectCode,createdAtGte:from,createdAtLte:to},{pageNum,pageSize:100});
    this.sync.assertClaim(job);
    const ids=[...new Set([...(steps.ids||[]),...page.records.filter(r=>this.matches(r,parent)).map(r=>String(r.reportingId??r.id??r.outputId)).filter(id=>/^\d+$/.test(id))])];
    const more=page.total==null?page.records.length===100:pageNum*100<page.total;
    if(ids.length>1){reason=ambiguousMatch;needsHuman=true;}
    else if(more){if(pageNum>=20){reason='候选记录超过核对范围，需维护检查';}else{this.jobs.checkpoint(job,{from,to,ids,pageNum:pageNum+1});return {readContinuation:true};}}
    else if(ids.length===1)outputId=ids[0];
    else reason='暂未查到唯一匹配报工；系统继续核对，未重新提交';
   }
   if(!reason){
    await this.outbox.adminAction(parent.id,'reconcile',{expectedVersion:job.payload.version,...(outputId?{outputId}:{})},'SYSTEM_AUTO_REVIEW');
    this.sync.assertClaim(job);
    if(this.jobs.get(parent.id).state==='UNKNOWN')reason='黑湖当前状态尚未达到原操作目标，系统继续只读核对';
   }
  }catch(error){if(['BLACKLAKE_REQUEST_DEFERRED','BLACKLAKE_RATE_COOLDOWN'].includes(error.code))throw error;reason=error.code||'SYNC_AUTO_REVIEW_FAILED';}
  const current=this.jobs.get(parent.id),confirmed=current.state==='SUCCEEDED',receiptFound=current.state==='QUEUED'&&!!this.outbox.store.reportById(parent.report_id)?.blacklake_output_id;
  const systemError=!confirmed&&/^[A-Z][A-Z0-9_]+$/.test(reason);
  this.save(parent.id,{round,nextAt:this.now()+delays[Math.min(round,delays.length-1)],needsHuman:!confirmed&&!receiptFound&&!systemError&&needsHuman,systemError,reason:confirmed?'已自动确认黑湖结果':receiptFound?'已确认创建编号，后续字段由原任务继续同步':reason});
  this.jobs.event(parent.id,confirmed?'AUTO_REVIEW_CONFIRMED':'AUTO_REVIEW_PENDING','SYSTEM',{round,reason,readOnly:true});
  return {confirmed,round};
 }
}
