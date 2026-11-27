import {assert} from './errors.mjs';
import {createHash} from 'node:crypto';
import {timestampMs} from './work-time.mjs';
import {SyncRecovery} from './sync-recovery.mjs';
import {assertNewOutputLink} from './report-create-receipt.mjs';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class ReportOutbox {
 constructor({store,sync,blacklake,leaderReports,upstreamReports,manualReports,approvals,now=Date.now,allowNext=true}){
  Object.assign(this,{store,sync,blacklake,leaderReports,upstreamReports,manualReports,approvals,now,allowNext});this.db=store.db;this.jobs=sync.jobs;
  sync.writeHandler=job=>this.execute(job);
  sync.onWriteError=(job,error,state)=>{if(job.kind==='report-create'&&!this.recoverReceipt(job))store[state==='UNKNOWN'?'markReportUnknown':'markReportFailed'](job.payload.idempotencyKey,error.code||'SYNC_FAILED',state==='UNKNOWN'?'报工已保存，系统继续核对黑湖结果，请勿重复提交。':state==='RETRY'?'已保存，等待后台重试。':'同步异常，请在后台核对处理。');};
  sync.onRecovered=job=>{if(job.kind.startsWith('upstream-report-'))this.upstreamReports?.().recoverReceipt(job);if(job.kind==='report-create'&&job.state==='UNKNOWN'&&!this.recoverReceipt(job))store.markReportUnknown(job.payload.idempotencyKey,'WORKER_RESTART','同步期间服务重启，黑湖结果待后台核对。');};
  const onError=sync.onWriteError,onRecovered=sync.onRecovered;
  sync.onWriteError=(job,error,state)=>job.kind==='manual-report-create'?(this.recoverReceipt(job)||this.manualReports().onError(job,error,state)):onError(job,error,state);
  sync.onRecovered=job=>{if(job.kind!=='manual-report-create')return onRecovered(job);if(!this.recoverReceipt(job)&&job.state==='UNKNOWN')this.manualReports().onError(job,{code:'WORKER_RESTART'},'UNKNOWN');};
  new SyncRecovery({sync,outbox:this});
 }
 acceptCreate({report,assignment,operator,endedAt}){
  this.store.rememberReportSubmitter(report.id,operator);
  const job=this.enqueueCreate({report,assignment,operator,endedAt});
  if(this.allowNext)this.store.completeAssignment(assignment.id);
  return job;
 }
 enqueueCreate({report,assignment,operator,endedAt,approveStatus}){
  const person={id:operator.id,blacklakeOperatorId:operator.blacklakeOperatorId,name:operator.name};
  return this.jobs.enqueue({key:'create:'+report.idempotencyKey,mode:'write',kind:'report-create',target:assignment.id,reportId:report.id,actor:'employee:'+person.blacklakeOperatorId,
   payload:{idempotencyKey:report.idempotencyKey,assignmentId:assignment.id,projectId:assignment.projectId,reportId:report.id,input:{reportId:report.id,operator:person,task:{taskId:assignment.taskId,projectId:assignment.projectId,projectCode:assignment.projectCode},amount:report.amount,defectAmount:report.defectAmount,defectCodes:String(report.defectCode||'').split(',').filter(Boolean),...(report.defectItems?{defectItems:report.defectItems}:{}),...(approveStatus!==undefined?{approveStatus}:{}),outputTime:endedAt,actualStartedAt:assignment.startedAt,actualEndedAt:endedAt}}});
 }
 async enqueueChange(id,input,context){
  const key='change:'+context.operationId,prior=this.jobs.byKey(key),payload={assignmentId:id,input,context:{ownerId:context.ownerId,unitIds:context.unitIds,scope:context.scope||null,action:context.action,operationId:context.operationId}};
  if(prior){assert(prior.request_hash===digest(payload),409,'SYNC_IDEMPOTENCY_CONFLICT','操作标识已用于其他内容。');return this.receipt(prior);}
  const service=this.leaderReports();await service.change(id,input,{...context,prepareOnly:true});
  this.db.exec('BEGIN IMMEDIATE');try{const row=service.owned(id,context);assert(service.version(row)===input.expectedVersion,409,'REPORT_VERSION_CHANGED','报工记录已变化，请刷新。');const job=this.jobs.enqueue({key,mode:'write',kind:'report-'+context.action,target:id,reportId:row.local_report_id,payload,actor:(this.store.entryProfile(context.ownerId).appRole==='employee'?'quality-leader:':'dispatcher:')+context.ownerId});this.db.exec('COMMIT');return this.receipt(job);}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 receipt(job){return {accepted:true,queued:['QUEUED','RETRY','RUNNING'].includes(job.state),status:job.state,sync:this.sync.publicJob(job)};}
 reportSync(reportId){const row=this.db.prepare("SELECT id FROM integration_jobs WHERE mode='write' AND report_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(reportId);return row?this.sync.publicJob(this.jobs.get(row.id)):null;}
 pending(reportId){return this.jobs.pendingReport(reportId)||(()=>{const id=this.store.reportById(reportId)?.blacklake_output_id;return id?this.jobs.pendingReport('blacklake:'+id):null;})();}
 enqueueReopen(change){return this.jobs.enqueue({key:'reopen:'+change.operationId,mode:'write',kind:'process-reopen',target:change.assignmentId,payload:change,actor:'report-manager:'+change.ownerId});}
 recoverReceipt(job){
  const report=this.store.reportById(job.report_id);if(report?.status!=='SUCCEEDED'||!report.blacklake_output_id)return false;
  this.db.exec('BEGIN IMMEDIATE');try{const changed=this.db.prepare("UPDATE integration_jobs SET state='SUCCEEDED',error_code='',safe_retry=0,lease_until=NULL,result_json=?,updated_at=? WHERE id=? AND state IN ('UNKNOWN','FAILED','RETRY')").run(JSON.stringify({outputId:report.blacklake_output_id,localReceiptRecovered:true}),this.now(),job.id);if(changed.changes)this.jobs.event(job.id,'LOCAL_RECEIPT_RECOVERED');this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}this.sync.invalidateOrder(report.project_id,{outputId:report.blacklake_output_id});return true;
 }
 recover(){for(const job of this.jobs.recover())this.sync.onRecovered(job);for(const row of this.db.prepare("SELECT j.id FROM integration_jobs j JOIN reports r ON r.id=j.report_id WHERE j.state='UNKNOWN' AND j.kind IN ('report-create','manual-report-create') AND r.status IN ('PENDING','SUCCEEDED')").all())this.sync.onRecovered(this.jobs.get(row.id));for(const row of this.db.prepare("SELECT id FROM integration_jobs WHERE kind IN ('upstream-report-edit','upstream-report-delete') AND state='UNKNOWN'").all())this.upstreamReports?.().recoverReceipt(this.jobs.get(row.id));}
 async execute(job){
  if(job.kind==='report-approval')return this.approvals.execute(job);
  if(job.kind==='manual-report-create')return this.manualReports().execute(job);
  if(job.kind.startsWith('upstream-report-'))return this.upstreamReports().execute(job);
  if(job.kind==='process-reopen'){
   const {taskId,projectId}=job.payload,task=await this.blacklake.findTaskById(taskId,{fresh:true});
   assert(Number(task.taskId)===Number(taskId)&&Number(task.projectId)===Number(projectId),409,'REPORT_TASK_CHANGED','工单工序归属已变化，未自动开启。');
   const known=v=>v!=null&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0;
   assert(task.processStatus!=null&&[0,10,20].includes(Number(task.processStatus)),409,'PROCESS_STATE_UNKNOWN','工序状态未能确认，未自动开启。');
   if(Number(task.processStatus)!==20)return {skipped:'already-open',projectId,taskId};
   assert(known(task.plannedAmount)&&known(task.reportedGoodAmount)&&task.quantityPresence?.plannedAmount!==false&&task.quantityPresence?.reportedGoodAmount!==false,409,'PROCESS_QUANTITY_UNKNOWN','工序累计数量未能确认，未自动开启。');
   if(Number(task.reportedGoodAmount)>=Number(task.plannedAmount))return {skipped:'plan-still-met',projectId,taskId};
   this.jobs.sending(job.id,job.attempts);await this.blacklake.reopenProcessConfirmed(taskId,projectId);this.sync.assertClaim(job);this.sync.invalidateOrder(projectId);return {reopened:true,projectId,taskId};
  }
  if(job.kind==='report-create'){
   const {input,assignmentId,idempotencyKey,reportId}=job.payload,report=this.store.reportById(reportId),assignment=this.store.assignmentById(assignmentId);
   assert(report&&assignment?.reportId===reportId,409,'REPORT_LINK_CHANGED','本地报工关联已变化。');
   if(report.status==='SUCCEEDED')return {outputId:report.blacklake_output_id};
   assert(!this.store.orderRemoved(input.task.projectId),409,'WORK_ORDER_DELETED','黑湖已删除工单，已保存的报工未提交。');
   const person=this.db.prepare('SELECT active,blacklake_operator_id FROM operators WHERE id=?').get(input.operator.id);assert(person?.active&&person.blacklake_operator_id===input.operator.blacklakeOperatorId&&report.operator_id===input.operator.id,409,'REPORT_PERSON_CHANGED','报工人员状态已变化，尚未提交黑湖。');
   const task=await this.blacklake.findTaskById(input.task.taskId,{fresh:true});
   assert(Number(task.projectId)===Number(input.task.projectId)&&Number(task.taskId)===Number(input.task.taskId),409,'REPORT_TASK_CHANGED','黑湖工单工序已变化，本次尚未提交。');
   assert(task.processStatus!=null&&[0,10].includes(Number(task.processStatus)),409,'TASK_CLOSED','黑湖工序已关闭或状态未知，请后台处理这条已保存报工。');
   this.store.markReportFailed(idempotencyKey,'SYNC_PREPARING','后台正在核对并同步。');this.db.prepare("UPDATE reports SET status='PENDING' WHERE id=?").run(reportId);
   this.jobs.sending(job.id,job.attempts);
   const result=await this.blacklake.createOutput({...input,onCreateEvidence:evidence=>this.jobs.event(job.id,'CREATE_RESPONSE_EVIDENCE','SYSTEM',{attempt:job.attempts,...evidence})});this.sync.assertClaim(job);
   this.db.exec('BEGIN IMMEDIATE');try{assertNewOutputLink(this.db,reportId,result?.id);this.store.markReportSucceeded(idempotencyKey,result.id);this.store.completeAssignment(assignmentId);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
   this.sync.invalidateOrder(input.task.projectId,{outputId:result.id});return {outputId:String(result.id),projectId:input.task.projectId,...(result.readbackConfirmed?{readbackConfirmed:true}:{})};
  }
  const payload=job.payload;assert(payload.context.scope||this.store.entryProfile(payload.context.ownerId).appRole==='floor8_leader',403,'REPORT_OWNER_ROLE_CHANGED','原操作人的组长权限已变化，尚未提交黑湖。');
  const context={...payload.context,operationId:payload.context.operationId.slice(0,100)+'_a'+job.attempts,queuedJobId:job.id,beforeWrite:()=>this.jobs.sending(job.id,job.attempts)};
  const result=await this.leaderReports().change(payload.assignmentId,payload.input,context);
  return {jobOutcome:{state:result.status==='SUCCEEDED'?'SUCCEEDED':result.status==='UNKNOWN'?'UNKNOWN':result.retryable?'RETRY':'FAILED',safeRetry:result.status==='FAILED'&&result.safeToRetry===true,code:result.error?.code||''},result};
 }
 async adminAction(id,action,input,actor){
  const job=this.jobs.get(id);assert(job?.mode==='write',404,'SYNC_JOB_NOT_FOUND','没有找到这条同步任务。');
  const unchanged=()=>assert(this.sync.jobVersion(this.jobs.get(id))===input.expectedVersion,409,'SYNC_JOB_CHANGED','同步状态已变化，请刷新后核对。');unchanged();
  if(action==='retry')return this.receipt(this.jobs.retry(id,actor,job));
  if(action==='reconcile'){
   assert(job.state==='UNKNOWN',409,'SYNC_NOT_UNKNOWN','仅待核对任务可核对结果。');
   if(job.kind==='manual-report-create')return this.manualReports().reconcile(job,input,actor,unchanged);
   if(job.kind==='report-approval')return this.approvals.reconcile(job);
   if(job.kind==='order-process-edit')return this.sync.routeEdits.reconcile(job);
   if(job.kind.startsWith('upstream-report-'))return this.upstreamReports().reconcile(job,actor);
   if(job.kind==='process-reopen'){
    const task=await this.blacklake.findTaskById(job.payload.taskId,{fresh:true});unchanged();
    if(Number(task.taskId)===Number(job.payload.taskId)&&Number(task.projectId)===Number(job.payload.projectId)&&Number(task.processStatus)===10){this.db.prepare("UPDATE integration_jobs SET state='SUCCEEDED',error_code='',result_json=?,updated_at=? WHERE id=? AND state='UNKNOWN'").run(JSON.stringify({reopened:true,readbackConfirmed:true}),this.now(),id);this.jobs.event(id,'READBACK_CONFIRMED',actor);this.sync.invalidateOrder(job.payload.projectId);}
    return this.receipt(this.jobs.get(id));
   }
   if(job.kind==='report-create'){
    assert(input.outputId!=null&&/^\d+$/.test(String(input.outputId)),422,'OUTPUT_ID_REQUIRED','请填写核对到的黑湖报工编号。');
    const remote=await this.blacklake.readOutputForCorrection(input.outputId),expected=job.payload.input,identity=this.store.members.snapshot(job.report_id),operatorId=identity?.submitAsId??expected.operator.blacklakeOperatorId;
    assert(Number(remote.projectId)===Number(expected.task.projectId)&&Number(remote.projectProcessId)===Number(expected.task.taskId)&&Number(remote.operatorId)===Number(operatorId)&&remote.fineAmount===expected.amount-expected.defectAmount&&remote.defectsAmount===expected.defectAmount&&Number.isFinite(timestampMs(remote.startedAt))&&timestampMs(remote.startedAt)===timestampMs(expected.actualStartedAt)&&timestampMs(remote.endedAt)===timestampMs(expected.actualEndedAt)&&JSON.stringify([...(remote.defectCodes||[])].sort())===JSON.stringify([...(expected.defectCodes||[])].sort()),409,'SYNC_RECONCILE_MISMATCH','这条黑湖记录与本次报工身份、数量或时间不一致。');
    assert(!this.db.prepare('SELECT id FROM reports WHERE blacklake_output_id=? AND id<>?').get(String(input.outputId),job.report_id),409,'SYNC_OUTPUT_ALREADY_LINKED','这条黑湖记录已关联其他本地报工，不能重复登记。');
    this.db.exec('BEGIN IMMEDIATE');try{unchanged();this.store.markReportSucceeded(job.payload.idempotencyKey,input.outputId);this.store.completeAssignment(job.payload.assignmentId);this.db.prepare("UPDATE integration_jobs SET state='SUCCEEDED',error_code='',result_json=?,updated_at=? WHERE id=? AND state='UNKNOWN'").run(JSON.stringify({outputId:String(input.outputId),readbackConfirmed:true}),this.now(),id);this.jobs.event(id,'READBACK_CONFIRMED',actor,{outputId:String(input.outputId)});this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.sync.invalidateOrder(expected.task.projectId,{outputId:input.outputId});
   }else{
    const context={...job.payload.context,operationId:job.payload.context.operationId.slice(0,100)+'_a'+job.attempts,adminReview:true,auditActor:actor},result=await this.leaderReports().reconcile(job.payload.assignmentId,context);unchanged();
    if(result.status==='SUCCEEDED'){this.db.prepare("UPDATE integration_jobs SET state='SUCCEEDED',result_json=?,error_code='',updated_at=? WHERE id=? AND state='UNKNOWN'").run(JSON.stringify(result),this.now(),id);this.jobs.event(id,'READBACK_CONFIRMED',actor);}
   }
   return this.receipt(this.jobs.get(id));
  }
  if(action==='confirm-absent'){
   assert((job.kind==='report-create'||job.kind==='manual-report-create'&&!this.store.reportById(job.report_id)?.blacklake_output_id)&&job.state==='UNKNOWN'&&input.confirmedAbsent===true,409,'SYNC_ABSENCE_CONFIRMATION_REQUIRED','请先核对黑湖，明确确认本次报工未产生记录。');
   this.db.exec('BEGIN IMMEDIATE');try{unchanged();assert(this.store.reportById(job.report_id).status!=='SUCCEEDED',409,'SYNC_ALREADY_CONFIRMED','已收到黑湖成功回执，不能确认未写入。');this.store.markReportFailed(job.payload.idempotencyKey,'ADMIN_CONFIRMED_ABSENT','管理员核对确认黑湖未产生记录，可安全重试。');this.db.prepare("UPDATE integration_jobs SET state='FAILED',phase='CHECKING',safe_retry=1,error_code='ADMIN_CONFIRMED_ABSENT',updated_at=? WHERE id=? AND state='UNKNOWN'").run(this.now(),id);this.jobs.event(id,'ADMIN_CONFIRMED_ABSENT',actor);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return this.receipt(this.jobs.get(id));
  }
  if(action==='cancel'){
   assert((job.kind==='report-create'||job.kind==='manual-report-create'&&!this.store.reportById(job.report_id)?.blacklake_output_id)&&['QUEUED','RETRY','FAILED'].includes(job.state),409,'SYNC_CANCEL_UNSAFE','已发出或结果待核对的操作不能直接取消。');
   this.db.exec('BEGIN IMMEDIATE');try{unchanged();this.store.markReportFailed(job.payload.idempotencyKey,'SYNC_CANCELLED','后台取消了本次黑湖同步，保留本地记录。');this.db.prepare("UPDATE integration_jobs SET state='CANCELLED',safe_retry=0,updated_at=? WHERE id=?").run(this.now(),id);this.jobs.event(id,'CANCELLED',actor);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return this.receipt(this.jobs.get(id));
  }
  assert(false,422,'SYNC_ACTION_INVALID','同步操作不支持。');
 }
}
