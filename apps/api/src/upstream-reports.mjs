import {assert} from './errors.mjs';
import {validReportTime,balanceReportDuration} from './report-production.mjs';
import {timestampMs,workTimeBreakdown} from './work-time.mjs';
import {MATERIAL_FIELD,PUNCH_FIELD} from './report-custom-fields.mjs';
import {nativeFingerprint,nativePlanMatches} from './native-report-correction.mjs';

const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const types=['upstream-report-edit','upstream-report-delete'];
const asIso=v=>new Date(timestampMs(v)).toISOString();
// Manage upstream history without manufacturing local assignments, timers or reports.
export class UpstreamReports {
 constructor({store,sync,blacklake,listPeople,getPeopleGroups,defectReasons=[],now=Date.now,onQuantityReduced=()=>{}}){
  Object.assign(this,{store,sync,blacklake,listPeople,getPeopleGroups,defectReasons,now,onQuantityReduced});this.db=store.db;this.jobs=sync.jobs;
 }
 authorize(ownerId){
  const role=this.store.entryProfile(ownerId).appRole,active=this.db.prepare('SELECT active FROM operators WHERE blacklake_operator_id=?').get(ownerId)?.active;
  assert(active===1&&(role==='floor8_leader'||role==='employee'&&this.store.qualityProfile(ownerId).qualityRole==='quality_leader'),403,'REPORT_MANAGEMENT_FORBIDDEN','当前人员没有报工管理权限。');
 }
 identity(reportId){assert(/^blacklake:\d+$/.test(String(reportId))&&positive(String(reportId).slice(10)),422,'BLACKLAKE_OUTPUT_ID_INVALID','黑湖报工编号无效。');return String(Number(String(reportId).slice(10)));}
 row(projectId,processId,reportId){
  const id=this.identity(reportId),row=this.db.prepare('SELECT * FROM blacklake_output_index WHERE output_id=? AND project_id=? AND task_id=?').get(id,Number(projectId),Number(processId));
  assert(row&&!row.deleted,404,'REPORT_NOT_FOUND','报工与当前工单工序不匹配，或已经删除。');
  assert(!this.db.prepare('SELECT id FROM reports WHERE blacklake_output_id=?').get(id),409,'REPORT_LINK_CHANGED','报工已关联本系统任务，请刷新列表后重新打开。');
  return row;
 }
 rights(reportId){
  const pending=this.jobs.pendingReport(reportId),blocked=!!pending;
  return {canManage:true,canEdit:!blocked,canDelete:!blocked,...(pending?{sync:this.sync.publicJob(pending)}:{}),managementBlockedReason:blocked?(pending.state==='UNKNOWN'?'上次操作结果待核对，请在后台核对后再修改。':'这条报工正在同步，请稍后再修改。'):''};
 }
 matches(row,remote){return String(remote?.id)===row.output_id&&Number(remote.projectId??remote.native?.projectId)===row.project_id&&Number(remote.projectProcessId)===row.task_id;}
 async cached(row,{wait=true}={}){
  for(let n=0;;n++){
   try{const remote=this.sync.outputEditor(row.output_id);assert(this.matches(row,remote),409,'REPORT_REMOTE_CHANGED','黑湖报工工单或工序归属不一致，请核对。');return remote;}
   catch(error){if(error.code!=='BLACKLAKE_DATA_SYNCING'||!wait||n>=10)throw error;await new Promise(resolve=>setTimeout(resolve,600));}
  }
 }
 async editor(projectId,processId,reportId,ownerId){
  this.authorize(ownerId);const row=this.row(projectId,processId,reportId),rights=this.rights(reportId);assert(rights.canEdit,409,'REPORT_NOT_EDITABLE',rights.managementBlockedReason);
  const remote=await this.cached(row);assert(remote.native&&!remote.native.blInApprove,409,'BLACKLAKE_REPORT_IN_APPROVAL','该报工正在黑湖审批，暂不能修改。');
  const people=[...await this.listPeople()],name=remote.native.operatorName;
  // Historical operators can be absent from today's active roster. Keep the
  // original identity selectable without granting it a new account or role.
  if(!people.some(p=>Number(p.blacklakeOperatorId)===Number(remote.operatorId)))people.push({blacklakeOperatorId:Number(remote.operatorId),name});
  const config=this.getPeopleGroups(people),material=remote.customFieldValues?.find(f=>Number(f.fieldId)===MATERIAL_FIELD.id),punch=remote.customFieldValues?.find(f=>Number(f.fieldId)===PUNCH_FIELD.id);
  const version=nativeFingerprint(remote),id=String(reportId),started=asIso(remote.startedAt),ended=asIso(remote.endedAt),raw=JSON.parse(row.raw_json);
  return {orderId:Number(projectId),processId:Number(processId),permission:'all-process-reports',canEdit:true,canDelete:true,
   assignment:{id,orderId:Number(projectId),processId:Number(processId),processName:remote.native.processName||raw.processName||'',workerId:String(remote.operatorId),workerName:name,segments:[{start:started,end:ended}]},
   report:{id,reportId:id,operatorId:remote.operatorId,operatorName:name,originalOperatorName:name,goodQuantity:remote.fineAmount,defectQuantity:remote.defectsAmount,quantity:remote.fineAmount+remote.defectsAmount,
    startedAt:remote.startedAt,endedAt:remote.endedAt,durationSeconds:remote.effectiveTime,production:{materialProcess:typeof material?.value==='string'?material.value:'',punchMinutes:punch?.value!=null&&Number.isFinite(Number(punch.value))?Number(punch.value):null},
    defectCodes:remote.defectCodes||[],defectItems:remote.defectItems||[],defectReasons:this.defectReasons,version,remoteVersion:version,fullSyncReady:this.blacklake.supportsFullReportCorrection===true,canEdit:true,canDelete:true,deleted:false},
   people:people.map(p=>({operatorId:p.blacklakeOperatorId,name:p.name,departments:config.groups.filter(g=>g.operatorIds.includes(p.blacklakeOperatorId)).map(g=>g.name)})),peopleGroupConfig:config};
 }
 async target(remote,input){
  assert(integer(input.goodQuantity)&&integer(input.defectQuantity)&&Number.isSafeInteger(input.goodQuantity+input.defectQuantity)&&input.goodQuantity+input.defectQuantity>0,422,'INVALID_REPORT_QUANTITY','良品和不良须为非负整数，合计大于0。');
  assert(Array.isArray(input.defectCodes)&&new Set(input.defectCodes).size===input.defectCodes.length,422,'INVALID_DEFECT_REASON','请核对不良品项。');
  const codes=input.defectQuantity?input.defectCodes:[],items=input.defectItems||[];
  assert((!input.defectQuantity||codes.length>0)&&codes.every(c=>this.defectReasons.some(d=>d.code===c))&&Array.isArray(items)&&items.length===codes.length&&new Set(items.map(i=>i?.code)).size===items.length&&items.every(i=>i&&codes.includes(i.code)&&integer(i.amount)&&i.amount>0)&&items.reduce((n,i)=>n+i.amount,0)===input.defectQuantity,422,'INVALID_DEFECT_ALLOCATION','各不良品项数量合计须等于不良数。');
  const people=await this.listPeople(),operatorId=input.operatorId??remote.operatorId,person=people.find(p=>Number(p.blacklakeOperatorId)===Number(operatorId));
  assert(positive(operatorId)&&(person||Number(operatorId)===Number(remote.operatorId)),422,'REPORT_PERSON_NOT_ALLOWED','所选人员不在当前有效名单。');
  const startedAt=validReportTime(input.startedAt??remote.startedAt,this.now()),endedAt=validReportTime(input.endedAt??remote.endedAt,this.now()),elapsed=(timestampMs(endedAt)-timestampMs(startedAt))/1000;
  assert(elapsed>=0,422,'INVALID_REPORT_TIME','结束时间不能早于开始时间。');
  const sameTimes=startedAt===remote.startedAt&&endedAt===remote.endedAt,breakdown=workTimeBreakdown(startedAt,endedAt,[]),rest=sameTimes?remote.native.planRestTime:breakdown.lunchSeconds,pause=sameTimes?remote.native.unplanShutdownTime:0,seconds=input.durationSeconds??(sameTimes?remote.effectiveTime:breakdown.effectiveSeconds);
  const balanced=balanceReportDuration(elapsed,seconds,rest,pause);
  const materialProcess=input.materialProcess??'',punchMinutes=elapsed/60;
  assert(typeof materialProcess==='string'&&materialProcess.length<=100&&!/[\u0000-\u001f]/.test(materialProcess)&&(input.punchMinutes===undefined||Number.isFinite(input.punchMinutes)&&Math.abs(input.punchMinutes-punchMinutes)<0.000001),422,'INVALID_REPORT_EXTRA','请核对用料工序和打卡时长。');
  return {goodAmount:input.goodQuantity,defectAmount:input.defectQuantity,defectCodes:codes,defectItems:items,operatorId:Number(operatorId),operatorName:person?.name||remote.native.operatorName,startedAt,endedAt,durationSeconds:seconds,...balanced,materialProcess,punchMinutes};
 }
 async enqueue(projectId,processId,reportId,action,input,operationId,ownerId){
  this.authorize(ownerId);assert(['edit','delete'].includes(action)&&typeof operationId==='string'&&/^[A-Za-z0-9_.:-]{8,120}$/.test(operationId),422,'REPORT_OPERATION_INVALID','报工操作编号无效，请重新打开。');
  const requestHash=nativeFingerprint({projectId,processId,reportId,action,input,ownerId}),key='upstream-change:'+operationId,prior=this.jobs.byKey(key);
  if(prior){assert(prior.payload.requestHash===requestHash,409,'SYNC_IDEMPOTENCY_CONFLICT','操作编号已用于其他内容。');return this.receipt(prior);}
  const row=this.row(projectId,processId,reportId),rights=this.rights(reportId);assert(rights.canEdit,409,'REPORT_NOT_EDITABLE',rights.managementBlockedReason);
  const remote=await this.cached(row);assert(remote.native&&!remote.native.blInApprove,409,'BLACKLAKE_REPORT_IN_APPROVAL','该报工正在审批，暂不能修改或删除。');assert(input.expectedVersion===nativeFingerprint(remote)&&(!input.expectedRemoteVersion||input.expectedRemoteVersion===nativeFingerprint(remote)),409,'REPORT_REMOTE_CHANGED','报工已变化，请刷新后重新编辑。');
  const target=action==='edit'?await this.target(remote,input):null;
  this.db.exec('BEGIN IMMEDIATE');try{
   this.authorize(ownerId);this.row(projectId,processId,reportId);assert(!this.jobs.pendingReport(reportId),409,'REPORT_SYNC_PENDING','报工正在同步，请稍后再试。');
   const payload={requestHash,outputId:row.output_id,projectId:Number(projectId),processId:Number(processId),projectCode:remote.native.projectCode,processName:remote.native.processName||'',operatorName:remote.native.operatorName,ownerId,action,remoteVersion:nativeFingerprint(remote),original:remote,target};
   const job=this.jobs.enqueue({key,mode:'write',kind:'upstream-report-'+action,target:reportId,reportId,payload,actor:'report-manager:'+ownerId});this.db.exec('COMMIT');return this.receipt(job);
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 receipt(job){return {accepted:true,queued:['QUEUED','RUNNING','RETRY'].includes(job.state),status:job.state,sync:this.sync.publicJob(job)};}
 async execute(job){
  const p=job.payload;this.authorize(p.ownerId);const row=this.row(p.projectId,p.processId,job.target),remote=await this.blacklake.readOutputForCorrection(p.outputId,{production:true});
  assert(this.matches(row,remote)&&nativeFingerprint(remote)===p.remoteVersion,409,'REPORT_REMOTE_CHANGED','黑湖报工已被其他操作修改，本次未覆盖。');
  let plan=null,verified=null;
  if(p.action==='edit'){assert(this.blacklake.supportsFullReportCorrection===true,409,'BLACKLAKE_EFFECTIVE_TIME_NOT_VERIFIED','完整报工编辑尚未就绪。');plan=await this.blacklake.prepareOutputCorrection(remote,p.target);}
  this.authorize(p.ownerId);this.row(p.projectId,p.processId,job.target);this.sync.assertClaim(job);this.jobs.event(job.id,'UPSTREAM_CHANGE_PREPARED',job.actor,{plan});this.jobs.sending(job.id,job.attempts);
  if(p.action==='delete')await this.blacklake.deleteOutputConfirmed(p.outputId);
  else{verified=await this.blacklake.updateOutputConfirmed(remote,{...p.target,nativePlan:plan});if(!verified)verified=await this.blacklake.readOutputForCorrection(p.outputId,{production:true});assert(nativePlanMatches(verified,plan),409,'BLACKLAKE_REPORT_UPDATE_UNCONFIRMED','黑湖修改回读尚未确认，请勿重复提交。');}
  return this.confirm(job,verified);
 }
 confirm(job,verified,{reconciled=false,actor=job.actor}={}){
  const p=job.payload,receipt={confirmed:true,jobId:job.id,outputId:p.outputId,action:p.action,readbackConfirmed:reconciled};
  this.db.exec('BEGIN IMMEDIATE');try{
   if(!reconciled)this.sync.assertClaim(job);else assert(this.jobs.get(job.id)?.state==='UNKNOWN',409,'SYNC_JOB_CHANGED','同步状态已变化。');
   const row=this.row(p.projectId,p.processId,job.target);
   if(p.action==='delete')this.db.prepare('UPDATE blacklake_output_index SET deleted=1,updated_at=? WHERE output_id=?').run(this.now(),p.outputId);
   else{assert(this.matches(row,verified),409,'REPORT_REMOTE_CHANGED','报工回读身份不一致。');const raw={...JSON.parse(row.raw_json),productionStaffId:verified.operatorId,productionStaff:verified.native.operatorName,productionStaffName:verified.native.operatorName,numberofgoodProducts:verified.fineAmount,numberofDefectives:verified.defectsAmount,effectiveTime:verified.effectiveTime,defectItemList:verified.defectItems,updatedAt:verified.native.updatedAt};
    this.db.prepare('UPDATE blacklake_output_index SET raw_json=?,correction_json=?,correction_at=?,updated_at=? WHERE output_id=?').run(JSON.stringify(raw),JSON.stringify(verified),this.now(),this.now(),p.outputId);
    if(verified.fineAmount<p.original.fineAmount||verified.fineAmount+verified.defectsAmount<p.original.fineAmount+p.original.defectsAmount)this.onQuantityReduced({operationId:job.id,assignmentId:job.target,reportId:job.target,projectId:p.projectId,taskId:p.processId,ownerId:p.ownerId});
   }
   this.sync.invalidateOrder(p.projectId,{outputId:p.outputId,deleted:p.action==='delete'});
   this.db.prepare("UPDATE integration_jobs SET result_json=?,state=CASE WHEN ? THEN 'SUCCEEDED' ELSE state END,error_code='' WHERE id=?").run(JSON.stringify({externalReceipt:receipt}),reconciled?1:0,job.id);
   this.jobs.event(job.id,reconciled?'READBACK_CONFIRMED':'UPSTREAM_REPORT_CONFIRMED',actor,{outputId:p.outputId,action:p.action});this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}return {externalReceipt:receipt};
 }
 recoverReceipt(job){
  if(!types.includes(job.kind)||job.result?.externalReceipt?.confirmed!==true||job.result.externalReceipt.jobId!==job.id)return false;
  this.db.prepare("UPDATE integration_jobs SET state='SUCCEEDED',error_code='',safe_retry=0,lease_until=NULL,updated_at=? WHERE id=? AND state IN ('UNKNOWN','FAILED','RETRY')").run(this.now(),job.id);this.jobs.event(job.id,'LOCAL_RECEIPT_RECOVERED');return true;
 }
 async reconcile(job,actor){
  const p=job.payload;try{
   const remote=await this.blacklake.readOutputForCorrection(p.outputId,{production:true}),row=this.row(p.projectId,p.processId,job.target),event=this.db.prepare("SELECT data_json FROM integration_job_events WHERE job_id=? AND event='UPSTREAM_CHANGE_PREPARED' ORDER BY id DESC LIMIT 1").get(job.id),plan=event?JSON.parse(event.data_json).plan:null;
   if(p.action==='edit'&&plan&&this.matches(row,remote)&&nativePlanMatches(remote,plan))this.confirm(job,remote,{reconciled:true,actor});
  }catch(error){if(p.action==='delete'&&error.definiteAbsence===true)this.confirm(job,null,{reconciled:true,actor});}
  return this.receipt(this.jobs.get(job.id));
 }
}
