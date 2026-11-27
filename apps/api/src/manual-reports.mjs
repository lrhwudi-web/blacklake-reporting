import {randomUUID,createHash} from 'node:crypto';
import {assert} from './errors.mjs';
import {reportEditProduction,reportProduction} from './report-production.mjs';
import {isLocalMemberKey} from './local-members.mjs';
import {nativePlanMatches} from './native-report-correction.mjs';
import {timestampMs} from './work-time.mjs';
import {shanghaiTime} from './task-recovery.mjs';
import {outputId,unknownCreateOutcome} from './report-create-receipt.mjs';
import {processEditLocksTask} from './order-process-edits.mjs';
import {groupApprovalPending} from './group-report-review.mjs';
import {readApproval} from './report-approvals.mjs';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const allocations=v=>JSON.stringify((v||[]).map(i=>({code:i.code,amount:i.amount})).sort((a,b)=>a.code.localeCompare(b.code)));

// Retrospective reports have a completed history link, never a live assignment.
// A receipt is checkpointed BEFORE full-field correction. A retry can therefore
// never create the same output again after the upstream creation succeeded.
export class ManualReports {
 constructor({store,sync,blacklake,leaderReports,groupReview,now=Date.now,defectReasons=[]}){Object.assign(this,{store,sync,blacklake,leaderReports,groupReview,now,defectReasons});this.db=store.db;}
 authorize(ownerId){const person=this.db.prepare('SELECT active FROM operators WHERE blacklake_operator_id=?').get(ownerId),role=this.store.entryProfile(ownerId).appRole;assert(person?.active===1&&(role==='floor8_leader'||role==='employee'&&this.store.qualityProfile(ownerId).qualityRole==='quality_leader'),403,'REPORT_MANAGEMENT_FORBIDDEN','只有组长或已授权的质检组长可以新建报工。');}
 requireEnabled(){assert(this.sync&&this.blacklake.supportsFullReportCorrection===true,409,'MANUAL_REPORT_UNAVAILABLE','新建报工同步尚未启用。');}
 async context(order,processId,ownerId){
  this.authorize(ownerId);this.requireEnabled();const process=order.processes.find(p=>String(p.id)===String(processId));
  assert(process,404,'WORKSPACE_PROCESS_NOT_FOUND','工单工序不匹配。');assert(process.selectable&&order.status!=='FINISHED',409,'TASK_CLOSED','工单或工序已关闭，不能新建报工。');
  const people=await this.leaderReports().listPeople({scope:'all-process-reports'}),peopleGroupConfig=this.leaderReports().getPeopleGroupConfig?.(people);
  return {orderId:order.id,processId:Number(processId),permission:'all-process-reports',canCreate:true,processName:process.name,serverTime:shanghaiTime(this.now()),people:people.map(p=>({operatorId:p.blacklakeOperatorId,name:p.name,departments:peopleGroupConfig?peopleGroupConfig.groups.filter(g=>g.operatorIds.includes(p.blacklakeOperatorId)).map(g=>g.name):p.departments||p.groupNames||[]})),peopleGroupConfig,defectReasons:this.defectReasons.map(({code,name})=>({code,name}))};
 }
 async create(order,processId,input,operationId,ownerId){
  this.authorize(ownerId);this.requireEnabled();assert(/^[A-Za-z0-9_-]{16,128}$/.test(operationId),422,'INVALID_REPORT_OPERATION','请重新打开新建报工后操作。');
  const key='manual-create:'+ownerId+':'+operationId,requestHash=hash({ownerId,orderId:order.id,processId:Number(processId),input});
  const prior=this.replayCreation(key,requestHash);
  if(prior)return prior;
  assert(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['operatorId','goodQuantity','defectQuantity','defectItems','startedAt','endedAt','durationSeconds','materialProcess','punchMinutes'].includes(k)),422,'INVALID_REPORT_CHANGE','报工参数不正确。');
  const context=await this.context(order,processId,ownerId),person=context.people.find(p=>p.operatorId===input.operatorId);
  assert(person,422,'REPORT_PERSON_NOT_ALLOWED','请选择有效的生产人员。');
  const good=input.goodQuantity,bad=input.defectQuantity,items=input.defectItems;
  assert([good,bad,good+bad].every(v=>Number.isSafeInteger(v)&&v>=0)&&good+bad>0,422,'INVALID_REPORT_QUANTITY','合格数和不良数须为非负整数，合计大于0。');
  assert(Array.isArray(items)&&new Set(items.map(i=>i?.code)).size===items.length&&items.every(i=>i&&Object.keys(i).every(k=>['code','amount'].includes(k))&&this.defectReasons.some(d=>d.code===i.code)&&Number.isSafeInteger(i.amount)&&i.amount>0)&&items.reduce((n,i)=>n+i.amount,0)===bad,422,'INVALID_DEFECT_ALLOCATION','各不良品项数量合计须等于不良数。');
  const id=randomUUID(),reportId=randomUUID(),details=reportEditProduction(this.store,{id,local_report_id:reportId,started_at:input.startedAt,ended_at:input.endedAt},input,this.now());
  assert(details.endedAt>details.startedAt,422,'INVALID_REPORT_TIME','新建报工请填写实际起止时间，结束时间须晚于开始时间。');
  assert(details.durationSeconds>0,422,'INVALID_REPORT_DURATION','请核对有效工时。有效工时为 0 时，黑湖无法计算达标率。');
  const member=isLocalMemberKey(input.operatorId)?this.store.members.byKey(input.operatorId):null;
  assert(!isLocalMemberKey(input.operatorId)||member,409,'LOCAL_MEMBER_DISABLED','所选人员已停用。');
  const submitter=context.people.find(p=>p.operatorId===(member?.submitAsId??input.operatorId));assert(submitter&&!isLocalMemberKey(submitter.operatorId),409,'REPORT_SUBMIT_PERSON_UNAVAILABLE','无法确认所选人员的黑湖提交身份。');
  this.db.exec('BEGIN IMMEDIATE');try{
   this.authorize(ownerId);
   const replay=this.replayCreation(key,requestHash);
   if(replay){this.db.exec('COMMIT');return replay;}
   assert(!this.sync.routeEdits||!processEditLocksTask(this.db,order.id,processId),409,'PROCESS_EDIT_PENDING','该工序正在修改或已经移除，请选其他工序。');
   const operator=this.store.findOperatorByBlacklakeId(input.operatorId)||this.store.upsertBlacklakeOperator({blacklakeOperatorId:input.operatorId,name:person.name,groupNames:person.departments});
   assert(this.db.prepare('SELECT active FROM operators WHERE id=?').get(operator.id)?.active===1,409,'REPORT_PERSON_NOT_ALLOWED','所选人员已停用。');
   const report=this.store.insertPendingReport({id:reportId,idempotencyKey:key,requestHash,operatorId:operator.id,taskId:Number(processId),projectId:order.id,projectCode:order.code,productName:order.productName||order.product||'',processName:context.processName,amount:good+bad,goodAmount:good,defectAmount:bad,defectCode:items.map(i=>i.code).join(','),defectItems:items,outputTime:details.endedAt});
   this.db.prepare(`INSERT INTO assignments(id,operator_id,task_id,project_id,project_code,product_name,process_name,quantity,min_duration_seconds,max_duration_seconds,status,assignment_mode,published_by,published_at,started_at,ended_at,duration_seconds,report_id) VALUES(?,?,?,?,?,?,?,?,0,2147483647,'COMPLETED','MANUAL_REPORT',?,?,?,?,?,?)`).run(id,operator.id,Number(processId),order.id,order.code,order.productName||order.product||'',context.processName,good+bad,'',shanghaiTime(this.now()),details.startedAt,details.endedAt,details.durationSeconds,reportId);
   const production={...details,blacklakeFieldsRequired:true,operatorId:operator.id,personId:input.operatorId,operatorName:person.name,upstreamOperatorId:submitter.operatorId,upstreamOperatorName:submitter.name,defectItems:items,manual:true};
   this.saveProduction(reportId,production);
   if(member)this.db.prepare('INSERT INTO report_submission_identities(report_id,actual_operator_id,actual_name,submit_as_id,submit_as_name,member_revision) VALUES(?,?,?,?,?,?)').run(reportId,operator.id,person.name,submitter.operatorId,submitter.name,member.revision);
   const needsApproval=this.groupReview.requiresApproval(input.operatorId);
   if(needsApproval)this.groupReview.hold(reportId);
   const job=needsApproval?null:this.enqueueCreation(report,this.store.assignmentById(id),ownerId);
   this.db.prepare('INSERT INTO assignment_actions(assignment_id,action,reason,actor) VALUES(?,?,?,?)').run(id,'MANUAL_REPORT_CREATED',JSON.stringify({reportId,goodQuantity:good,defectQuantity:bad}),'report-manager:'+ownerId);
   this.db.exec('COMMIT');return job?this.receipt(job):this.draftReceipt(reportId);
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 draftReceipt(reportId,replayed=false){return {accepted:true,queued:false,status:'SUCCEEDED',pendingGroupApproval:true,reportId,replayed};}
 replayCreation(key,requestHash){
  const job=this.sync.jobs.byKey(key);
  if(job){
   assert(job.payload.requestHash===requestHash,409,'SYNC_IDEMPOTENCY_CONFLICT','提交内容已变化，请重新打开新建报工。');
   return this.receipt(job,true);
  }
  const report=this.store.reportByKey(key);
  if(!report)return null;
  assert(report.request_hash===requestHash,409,'SYNC_IDEMPOTENCY_CONFLICT','提交内容已变化，请重新打开新建报工。');
  assert(report.status===groupApprovalPending,409,'REPORT_LINK_CHANGED','报工状态已变化，请刷新后核对。');
  return this.draftReceipt(report.id,true);
 }
 enqueueCreation(report,assignment,ownerId,approveStatus){
  this.requireEnabled();
  const production=reportProduction(this.store,report.id);
  assert(production?.manual===true,409,'REPORT_LINK_CHANGED','代建报工资料已变化，请刷新后核对。');
  const {defectItems,startedAt,endedAt}=production;
  return this.sync.jobs.enqueue({key:report.idempotency_key,mode:'write',kind:'manual-report-create',
   target:assignment.id,reportId:report.id,actor:'report-manager:'+ownerId,payload:{
    idempotencyKey:report.idempotency_key,requestHash:report.request_hash,ownerId,
    projectId:report.project_id,assignmentId:assignment.id,input:{
     reportId:report.id,operator:{id:report.operator_id,blacklakeOperatorId:production.personId,name:production.operatorName},
     task:{taskId:report.task_id,projectId:report.project_id,projectCode:report.project_code},
     amount:report.amount,defectAmount:report.defect_amount,defectCodes:defectItems.map(i=>i.code),defectItems,
     outputTime:endedAt,actualStartedAt:startedAt,actualEndedAt:endedAt,
     ...(approveStatus===undefined?{}:{approveStatus})
    }
   }});
 }
 saveProduction(id,data){this.db.prepare('INSERT INTO report_production_details(report_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(report_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(id,JSON.stringify(data),shanghaiTime(this.now()));}
 receipt(job,replayed=false){return {accepted:true,queued:['QUEUED','RUNNING','RETRY'].includes(job.state),status:job.state,reportId:job.report_id,sync:this.sync.publicJob(job),replayed};}
 matches(remote,job){const expected=job.payload.input,p=reportProduction(this.store,job.report_id);return Number(remote.projectId)===Number(expected.task.projectId)&&Number(remote.projectProcessId)===Number(expected.task.taskId)&&Number(remote.operatorId)===p.upstreamOperatorId&&remote.fineAmount===expected.amount-expected.defectAmount&&remote.defectsAmount===expected.defectAmount&&timestampMs(remote.startedAt)===timestampMs(expected.actualStartedAt)&&timestampMs(remote.endedAt)===timestampMs(expected.actualEndedAt)&&allocations(remote.defectItems)===allocations(expected.defectItems);}
 checkpoint(job,outputId){
  assert(!this.db.prepare('SELECT id FROM reports WHERE blacklake_output_id=? AND id<>?').get(String(outputId),job.report_id),409,'SYNC_OUTPUT_ALREADY_LINKED','这条黑湖报工已关联其他记录。');
  this.db.prepare("UPDATE reports SET blacklake_output_id=?,status='PENDING',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(outputId),job.report_id);
  this.db.prepare("UPDATE integration_jobs SET phase='CHECKING',updated_at=? WHERE id=?").run(this.now(),job.id);this.sync.jobs.event(job.id,'CREATE_RECEIPT_SAVED','SYSTEM',{outputId:String(outputId)});
 }
 finish(job){this.store.markReportSucceeded(this.store.reportById(job.report_id).idempotency_key,this.store.reportById(job.report_id).blacklake_output_id);this.sync.invalidateOrder(job.payload.projectId,{outputId:this.store.reportById(job.report_id).blacklake_output_id});}
 onError(job,error,state){const report=this.store.reportById(job.report_id);this.store[state==='UNKNOWN'?'markReportUnknown':'markReportFailed'](report.idempotency_key,error.code||'SYNC_FAILED',state==='UNKNOWN'?'新建报工已保存，系统继续核对黑湖结果，请勿重复新建。':'已保存，后台同步尚未完成。');}
 async execute(job){
  this.authorize(job.payload.ownerId);this.requireEnabled();let report=this.store.reportById(job.report_id);assert(report&&this.store.assignmentById(job.target)?.reportId===report.id,409,'REPORT_LINK_CHANGED','本地报工关联已变化。');
  if(report.status==='SUCCEEDED')return {outputId:report.blacklake_output_id};
  const input=job.payload.input,production=reportProduction(this.store,report.id);
  if(!report.blacklake_output_id){
   assert(!this.store.orderRemoved(input.task.projectId),409,'WORK_ORDER_DELETED','黑湖已删除这张工单，新建报工未提交。');
   const person=this.db.prepare('SELECT * FROM operators WHERE id=?').get(report.operator_id);assert(person?.active===1&&person.blacklake_operator_id===input.operator.blacklakeOperatorId,409,'REPORT_PERSON_CHANGED','报工人员状态已变化，尚未提交。');
   if(isLocalMemberKey(person.blacklake_operator_id))assert(this.store.members.byKey(person.blacklake_operator_id)?.submitAsId===production.upstreamOperatorId,409,'SUBMIT_IDENTITY_CHANGED','代报身份已变化，尚未提交。');
   const task=await this.blacklake.findTaskById(input.task.taskId,{fresh:true});assert(Number(task.projectId)===Number(input.task.projectId)&&Number(task.taskId)===Number(input.task.taskId),409,'REPORT_TASK_CHANGED','工单工序归属已变化，尚未提交。');assert(task.processStatus!=null&&[0,10].includes(Number(task.processStatus)),409,'TASK_CLOSED','黑湖工序已关闭，已保存的报工需后台处理。');
   this.db.prepare("UPDATE reports SET status='PENDING' WHERE id=?").run(report.id);this.sync.jobs.sending(job.id,job.attempts);
   const result=await this.blacklake.createOutput({...input,onCreateEvidence:evidence=>this.sync.jobs.event(job.id,'CREATE_RESPONSE_EVIDENCE','SYSTEM',{attempt:job.attempts,...evidence})});this.sync.assertClaim(job);
   if(!outputId(result?.id))throw unknownCreateOutcome('BLACKLAKE_OUTPUT_ID_MISSING');
   this.db.exec('BEGIN IMMEDIATE');try{this.checkpoint(job,result.id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
   report=this.store.reportById(report.id);
  }
  const remote=await this.blacklake.readOutputForCorrection(report.blacklake_output_id,{production:true});this.sync.assertClaim(job);
  assert(input.approveStatus!==10||readApproval(remote.native)===10,409,'BLACKLAKE_REPORT_APPROVAL_UNCONFIRMED','黑湖已创建报工，审批状态尚未回读确认。');
  if(production.manualNativePlan&&nativePlanMatches(remote,production.manualNativePlan)){this.finish(job);return {outputId:report.blacklake_output_id,fullFieldsConfirmed:true};}
  assert(this.matches(remote,job),409,'SYNC_RECONCILE_MISMATCH','黑湖记录与本次报工身份、数量或时间不一致，请后台核对。');
  const plan=await this.blacklake.prepareOutputCorrection(remote,{goodAmount:report.good_amount,defectAmount:report.defect_amount,defectItems:input.defectItems,operatorId:production.upstreamOperatorId,operatorName:production.upstreamOperatorName,startedAt:production.startedAt,endedAt:production.endedAt,durationSeconds:production.durationSeconds,planRestTime:production.planRestTime,unplanShutdownTime:production.unplanShutdownTime,materialProcess:production.materialProcess});this.sync.assertClaim(job);
  this.saveProduction(report.id,{...production,manualNativePlan:plan});this.sync.jobs.sending(job.id,job.attempts);
  const verified=await this.blacklake.updateOutputConfirmed(remote,{nativePlan:plan,durationSeconds:production.durationSeconds});this.sync.assertClaim(job);assert(nativePlanMatches(verified,plan),409,'BLACKLAKE_REPORT_UPDATE_UNCONFIRMED','完整报工资料尚未回读确认，请后台核对。');
  this.finish(job);return {outputId:report.blacklake_output_id,fullFieldsConfirmed:true};
 }
 async reconcile(job,input,actor,unchanged){
  const report=this.store.reportById(job.report_id),outputId=report.blacklake_output_id||input.outputId;assert(/^\d+$/.test(String(outputId||'')),422,'OUTPUT_ID_REQUIRED','请填写核对到的黑湖报工编号。');
  const remote=await this.blacklake.readOutputForCorrection(outputId,{production:true}),production=reportProduction(this.store,job.report_id);unchanged();
  if(report.blacklake_output_id){
   if(production.manualNativePlan&&nativePlanMatches(remote,production.manualNativePlan)){this.db.exec('BEGIN IMMEDIATE');try{unchanged();this.finish(job);this.db.prepare("UPDATE integration_jobs SET state='SUCCEEDED',error_code='',safe_retry=0,updated_at=? WHERE id=?").run(this.now(),job.id);this.sync.jobs.event(job.id,'READBACK_CONFIRMED',actor);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
  }else{
   assert(this.matches(remote,job),409,'SYNC_RECONCILE_MISMATCH','黑湖记录与本次报工身份、数量、不良品项或时间不一致。');
   this.db.exec('BEGIN IMMEDIATE');try{unchanged();this.checkpoint(job,outputId);this.db.prepare("UPDATE integration_jobs SET state='QUEUED',safe_retry=0,error_code='',due_at=?,updated_at=? WHERE id=?").run(this.now(),this.now(),job.id);this.sync.jobs.event(job.id,'CREATE_READBACK_CONFIRMED',actor,{outputId:String(outputId)});this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  return this.receipt(this.sync.jobs.get(job.id));
 }
}
