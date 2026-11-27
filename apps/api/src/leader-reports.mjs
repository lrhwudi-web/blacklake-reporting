import {createHash} from 'node:crypto';
import {assert,AppError} from './errors.mjs';
import {shanghaiTime} from './task-recovery.mjs';
import {reportProduction,reportEditProduction,reportSubmissionIdentity} from './report-production.mjs';
import {isLocalMemberKey} from './local-members.mjs';
import {productionFieldsMatch,MATERIAL_FIELD,PUNCH_FIELD} from './report-custom-fields.mjs';
import {nativePlanMatches,nativeOutputProjection} from './native-report-correction.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function dateRange(date) {
  const ms=Date.parse(date+'T00:00:00+08:00');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(ms)&&shanghaiTime(ms).slice(0,10)===date,422,'INVALID_REPORT_DATE','请选择有效日期。');
  return [date+' 00:00:00',shanghaiTime(ms+86400000)];
}

// Ordinary dispatch lists retain ownership. Explicit all-process-reports scope
// is reauthorized for leaders; a shared upstream submitter never grants access.
export class LeaderReports {
  constructor({store,blacklake,readBlacklake=blacklake,queueStatus=()=>null,defectReasons=[],now=Date.now,onChanged=()=>{},onQuantityReduced=()=>{},listPeople,getPeopleGroupConfig}) {
    Object.assign(this,{store,blacklake,readBlacklake,queueStatus,defectReasons,now,onChanged,onQuantityReduced,listPeople,getPeopleGroupConfig});this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS leader_report_states(
      report_id TEXT PRIMARY KEY REFERENCES reports(id),revision INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS leader_report_operations(
      id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES reports(id),assignment_id TEXT NOT NULL REFERENCES assignments(id),
      owner_id INTEGER NOT NULL,action TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,
      before_json TEXT NOT NULL,after_json TEXT,error_code TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS leader_report_operations_report_idx ON leader_report_operations(report_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS leader_report_unsettled_idx ON leader_report_operations(report_id) WHERE status IN ('CHECKING','PENDING','UNKNOWN');`);
    if(!store.leaderReportsRecovered) {
      this.db.prepare("UPDATE leader_report_operations SET status='FAILED',error_code='CHECK_INTERRUPTED' WHERE status='CHECKING'").run();
      this.db.prepare("UPDATE leader_report_operations SET status='UNKNOWN',error_code='WRITE_INTERRUPTED' WHERE status='PENDING'").run();
      store.leaderReportsRecovered=true;
    }
  }
  owned(id,{ownerId,unitIds,scope,adminReview=false}) {
    const row=this.db.prepare(`SELECT a.*,o.name AS operator_name,r.id AS local_report_id,r.status AS report_status,
      r.good_amount AS reported_good,r.defect_amount AS reported_defects,r.defect_code AS reported_defect_code,r.blacklake_output_id AS output_id,
      r.output_time AS output_time,r.operator_id AS report_operator_id,COALESCE(s.revision,0) AS report_revision,COALESCE(s.deleted,0) AS deleted
      FROM assignments a JOIN reports r ON r.id=a.report_id JOIN operators o ON o.id=r.operator_id
      LEFT JOIN leader_report_states s ON s.report_id=r.id WHERE a.id=?`).get(id);
    const role=this.store.entryProfile(ownerId).appRole,qualityManager=scope==='all-process-reports'&&(adminReview||this.db.prepare('SELECT active FROM operators WHERE blacklake_operator_id=?').get(ownerId)?.active===1&&(role==='floor8_leader'||role==='employee'&&this.store.qualityProfile(ownerId).qualityRole==='quality_leader'));
    assert(scope!=='all-process-reports'||qualityManager,403,'REPORT_MANAGEMENT_FORBIDDEN','当前人员没有报工管理权限。');
    assert(row&&(qualityManager||row.assignment_mode==='DISPATCHED'&&row.published_by_operator_id===ownerId&&unitIds.includes(row.machine_id||row.station_name)),404,'REPORT_NOT_FOUND','没有找到可管理的报工。');
    return row;
  }
  version(row) {return digest([row.local_report_id,row.report_revision,row.report_status,row.reported_good,row.reported_defects,row.deleted,row.output_id,row.report_operator_id,row.operator_id,row.started_at,row.ended_at,row.duration_seconds,reportProduction(this.store,row.local_report_id)]);}
  remoteMatches(row,remote,expected) {
    const sender=expected?.upstreamOperatorId??reportProduction(this.store,row.local_report_id)?.upstreamOperatorId??this.store.members?.snapshot(row.local_report_id)?.submitAsId??this.db.prepare('SELECT blacklake_operator_id id FROM operators WHERE id=?').get(row.report_operator_id).id;
    return remote&&String(remote.id)===String(row.output_id)
      &&(remote.projectId!=null?Number(remote.projectId)===row.project_id:remote.projectCode===row.project_code)
      &&Number(remote.projectProcessId)===row.task_id&&Number(remote.operatorId)===Number(sender);
  }
  present(row,{jobId}={}) {
    const production=reportProduction(this.store,row.local_report_id);
    const submissionIdentity=reportSubmissionIdentity(this.store,row.local_report_id);
    const pending=this.db.prepare("SELECT id,status FROM leader_report_operations WHERE report_id=? AND status IN ('CHECKING','PENDING','UNKNOWN')").get(row.local_report_id);
    const queued=this.queueStatus(row.local_report_id);
    const editable=row.status==='COMPLETED'&&row.report_status==='SUCCEEDED'&&Boolean(row.output_id)&&!row.deleted&&!pending&&(!queued||queued.id===jobId);
    return {id:row.id,reportId:row.local_report_id,operatorName:row.operator_name,unitId:row.machine_id||row.station_name,
      projectCode:row.project_code,processName:row.process_name,goodQuantity:row.reported_good,defectQuantity:row.reported_defects,
      quantity:row.reported_good+row.reported_defects,defectCodes:String(row.reported_defect_code||'').split(',').filter(Boolean),
      ...(submissionIdentity?{submissionIdentity}:{}),
      isQualityInspection:this.store.assignmentById(row.id).isQualityInspection,reportedAt:row.output_time,
      operatorId:this.db.prepare('SELECT blacklake_operator_id id FROM operators WHERE id=?').get(row.report_operator_id).id,
      originalOperatorName:this.db.prepare('SELECT name FROM operators WHERE id=?').get(row.operator_id).name,
      startedAt:production?.startedAt??row.started_at,endedAt:production?.endedAt??row.ended_at,
      durationSeconds:production?.durationSeconds??row.duration_seconds,production,version:this.version(row),deleted:Boolean(row.deleted),mutationStatus:pending?.status||'',
      canEdit:editable,canEditDefects:editable,canDelete:editable,canReconcile:pending?.status==='UNKNOWN',defectReasons:this.defectReasons.map(({code,name})=>({code,name}))};
  }
  async editor(id,context){
    const row=this.owned(id,context),report=this.present(row);
    assert(report.canEdit,409,'REPORT_NOT_EDITABLE','此报工不能编辑，请刷新核对。');
    const remote=await this.readBlacklake.readOutputForCorrection(row.output_id,{production:true});
    assert(this.remoteMatches(row,remote)&&remote.fineAmount===row.reported_good&&remote.defectsAmount===row.reported_defects,409,'REPORT_REMOTE_CHANGED','黑湖报工已变化，请后台核对后再编辑。');
    const people=await this.listPeople(context);
    const peopleGroupConfig=this.getPeopleGroupConfig?.(people)??null;
    const fields=Array.isArray(remote.customFieldValues)?remote.customFieldValues:[];
    const material=fields.find(f=>Number(f.fieldId)===MATERIAL_FIELD.id),punch=fields.find(f=>Number(f.fieldId)===PUNCH_FIELD.id);
    const upstreamProduction={...report.production,...(material&&(material.value===null||typeof material.value==='string')?{materialProcess:material.value??''}:{}),...(punch?.value!=null&&String(punch.value).trim()!==''&&Number.isFinite(Number(punch.value))?{punchMinutes:Number(punch.value)}:{})};
    const fullSyncReady=this.blacklake.supportsFullReportCorrection===true;
    return {report:{...report,production:upstreamProduction,...(remote.native?{startedAt:remote.startedAt,endedAt:remote.endedAt}:{}),...(Number.isSafeInteger(remote.effectiveTime)&&remote.effectiveTime>=0?{durationSeconds:remote.effectiveTime}:{}),fullSyncReady,remoteVersion:digest(remote),defectItems:remote.defectItems??report.production?.defectItems??[],pauses:this.store.assignmentPauses(row.id)},people:people.map(p=>({operatorId:p.blacklakeOperatorId,name:p.name,departments:peopleGroupConfig?peopleGroupConfig.groups.filter(g=>g.operatorIds.includes(p.blacklakeOperatorId)).map(g=>g.name):p.departments||p.groupNames||[]})),
      peopleGroupConfig,
      timingNote:fullSyncReady?'保存须经黑湖同步并回读确认。':'黑湖有效工时写入尚未验证，完整编辑暂不能保存。',extraScope:fullSyncReady?'BLACKLAKE_REQUIRED':'BLACKLAKE_REQUIRED_PENDING'};
  }
  list({ownerId,unitIds,date=shanghaiTime(this.now()).slice(0,10),offset=0,limit=30}) {
    assert(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=100,422,'INVALID_REPORT_PAGE','分页参数不正确。');
    const [from,to]=dateRange(date);
    const where=`a.assignment_mode='DISPATCHED' AND a.published_by_operator_id=? AND COALESCE(NULLIF(a.machine_id,''),a.station_name) IN (${unitIds.map(()=>'?').join(',')}) AND r.output_time>=? AND r.output_time<? AND r.status IN ('SUCCEEDED','DELETED')`;
    const args=[ownerId,...unitIds,from,to];
    const total=this.db.prepare('SELECT COUNT(*) n FROM assignments a JOIN reports r ON r.id=a.report_id WHERE '+where).get(...args).n;
    const ids=this.db.prepare('SELECT a.id FROM assignments a JOIN reports r ON r.id=a.report_id WHERE '+where+' ORDER BY r.output_time DESC,r.id DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
    return {reports:ids.map(({id})=>this.present(this.owned(id,{ownerId,unitIds}))),date,total,offset,limit,hasMore:offset+ids.length<total,
      source:'local_dispatch_reports',completeWithinScope:true,scopeDescription:'仅本人派工关联、在本系统提交的报工，按报工日期分页；不含其他入口或其他组长的历史。',serverTime:shanghaiTime(this.now())};
  }
  async change(id,input,context) {
    const {ownerId,unitIds,operationId,action}=context;
    assert(/^[A-Za-z0-9_-]{16,128}$/.test(operationId),422,'INVALID_REPORT_OPERATION','请重新打开报工后操作。');
    assert(['edit','delete'].includes(action),422,'INVALID_REPORT_ACTION','报工操作不正确。');
    assert(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['expectedVersion','expectedRemoteVersion','goodQuantity','defectQuantity','defectCodes','defectItems','operatorId','startedAt','endedAt','durationSeconds','materialProcess','punchMinutes'].includes(k)),422,'INVALID_REPORT_CHANGE','报工参数不正确。');
    let row=this.owned(id,context);const requestHash=digest({id,action,input});
    const prior=this.db.prepare('SELECT * FROM leader_report_operations WHERE id=?').get(operationId);
    if(prior){assert(prior.owner_id===ownerId&&prior.assignment_id===id&&prior.request_hash===requestHash,409,'REPORT_OPERATION_CONFLICT','操作标识已用于其他内容，请刷新。');return this.receipt(prior,context);}
    const state=this.present(row,{jobId:context.queuedJobId});
    assert(input.expectedVersion===state.version,409,'REPORT_VERSION_CHANGED','报工记录已变化，请刷新后核对。');
    assert(state.canEdit,409,'REPORT_NOT_EDITABLE',state.mutationStatus?'上次操作结果待核对，不能重复修改或删除。':'此报工尚未确认成功、已删除或缺少黑湖编号，不能修改。');
    const after={goodQuantity:row.reported_good,defectQuantity:row.reported_defects,defectCodes:state.defectCodes};
    if(action==='edit') {
      assert(integer(input.goodQuantity)&&integer(input.defectQuantity)&&Number.isSafeInteger(input.goodQuantity+input.defectQuantity)&&input.goodQuantity+input.defectQuantity>0,422,'INVALID_REPORT_QUANTITY','合格数和不良数须为非负整数，合计大于0。');
      assert(state.canEditDefects,409,'REPORT_NOT_EDITABLE','此报工暂不能更正不良，请刷新核对。');
      assert(Array.isArray(input.defectCodes),422,'INVALID_DEFECT_REASON','请选择不良原因。');
      const codes=[...new Set(input.defectCodes)];
      assert(!input.defectQuantity||(codes.length>0&&codes.length<=input.defectQuantity&&codes.every(c=>this.defectReasons.some(r=>r.code===c))),422,'INVALID_DEFECT_REASON','请核对不良原因和不良数量。');
      Object.assign(after,{goodQuantity:input.goodQuantity,defectQuantity:input.defectQuantity,defectCodes:input.defectQuantity?codes:[]});
      if(input.defectItems!==undefined){
        assert(Array.isArray(input.defectItems)&&input.defectItems.length===after.defectCodes.length&&new Set(input.defectItems.map(i=>i?.code)).size===input.defectItems.length
          &&input.defectItems.every(i=>i&&Object.keys(i).every(k=>['code','amount'].includes(k))&&after.defectCodes.includes(i.code)&&Number.isSafeInteger(i.amount)&&i.amount>0)
          &&input.defectItems.reduce((n,i)=>n+i.amount,0)===input.defectQuantity,422,'INVALID_DEFECT_ALLOCATION','各不良品项数量合计须等于不良数。');
        after.defectItems=input.defectItems;
      }
      if(['operatorId','startedAt','endedAt','durationSeconds','materialProcess','punchMinutes'].some(k=>input[k]!==undefined)){
        assert(typeof input.expectedRemoteVersion==='string'&&/^[a-f0-9]{64}$/.test(input.expectedRemoteVersion),422,'REPORT_REMOTE_VERSION_REQUIRED','请重新打开编辑界面，核对最新黑湖记录。');
        const details=reportEditProduction(this.store,row,input,this.now()),currentOperator=this.db.prepare('SELECT * FROM operators WHERE id=?').get(row.report_operator_id);
        assert(this.blacklake.supportsFullReportCorrection===true,422,'BLACKLAKE_EFFECTIVE_TIME_NOT_VERIFIED','黑湖有效工时写入接口尚未验证，完整编辑暂不能保存；本次未修改黑湖或本地报工。');
        let target=currentOperator,upstreamId=reportProduction(this.store,row.local_report_id)?.upstreamOperatorId??this.store.members.snapshot(row.local_report_id)?.submitAsId??currentOperator.blacklake_operator_id;
        let upstreamName=reportProduction(this.store,row.local_report_id)?.upstreamOperatorName??this.store.members.snapshot(row.local_report_id)?.submitAsName??currentOperator.name;
        if(input.operatorId!==undefined&&input.operatorId!==currentOperator.blacklake_operator_id){
          const people=await this.listPeople(context),person=people.find(p=>p.blacklakeOperatorId===input.operatorId);
          assert(person,422,'REPORT_PERSON_NOT_ALLOWED','所选生产人员不在当前可管理楼层名单，请刷新。');
          const directory=await this.readBlacklake.listOperators();
          const member=isLocalMemberKey(input.operatorId)?this.store.members.byKey(input.operatorId):null;
          const submitter=directory.find(p=>p.blacklakeOperatorId===(member?.submitAsId??input.operatorId)&&!isLocalMemberKey(p.blacklakeOperatorId));
          assert(submitter&&(!isLocalMemberKey(input.operatorId)||member),409,'REPORT_SUBMIT_PERSON_UNAVAILABLE','无法确认所选人员的黑湖提交身份。');
          const stored=this.store.findOperatorByBlacklakeId(input.operatorId)||this.store.upsertBlacklakeOperator(person);
          target=this.db.prepare('SELECT * FROM operators WHERE id=?').get(stored.id);
          assert(target.active,409,'REPORT_PERSON_NOT_ALLOWED','所选人员已停用，请刷新。');
          upstreamId=submitter.blacklakeOperatorId;upstreamName=submitter.name;
        }
        after.production={...details,blacklakeFieldsRequired:true,operatorId:target.id,personId:target.blacklake_operator_id,operatorName:target.name,upstreamOperatorId:upstreamId,upstreamOperatorName:upstreamName};
      }
    }
    if(context.prepareOnly)return {validated:true,reportId:row.local_report_id,version:state.version};
    const op={id:operationId,report_id:row.local_report_id,assignment_id:id,owner_id:ownerId,action,request_hash:requestHash,status:'CHECKING',before_json:JSON.stringify(state),after_json:JSON.stringify(after)};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      row=this.owned(id,context);assert(this.version(row)===input.expectedVersion&&this.present(row,{jobId:context.queuedJobId}).canEdit,409,'REPORT_VERSION_CHANGED','报工状态已变化，请刷新。');
      this.db.prepare('INSERT INTO leader_report_operations(id,report_id,assignment_id,owner_id,action,request_hash,status,before_json,after_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(op.id,op.report_id,id,ownerId,action,requestHash,op.status,op.before_json,op.after_json,shanghaiTime(this.now()),shanghaiTime(this.now()));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    let outcome='FAILED',code='',retryable=false;
    try {
      const remote=await this.blacklake.readOutputForCorrection(row.output_id,{production:Boolean(after.production)});
      assert(!input.expectedRemoteVersion||digest(remote)===input.expectedRemoteVersion,409,'REPORT_REMOTE_CHANGED','编辑期间黑湖报工已变化，请重新打开编辑。');
      assert(this.remoteMatches(row,remote),409,'REPORT_REMOTE_MISMATCH','黑湖报工身份或工单不一致，请后台核对。');
      assert(Number(remote.fineAmount)===row.reported_good&&Number(remote.defectsAmount)===row.reported_defects
        &&JSON.stringify([...(remote.defectCodes||[])].sort())===JSON.stringify([...state.defectCodes].sort()),409,'REPORT_REMOTE_CHANGED','黑湖报工已被其他入口修改，请后台核对。');
      assert(this.version(this.owned(id,context))===input.expectedVersion,409,'REPORT_VERSION_CHANGED','核验期间报工已变化，请刷新。');
      if(after.production&&after.production.personId!==state.operatorId){
        const target=this.store.findOperatorByBlacklakeId(after.production.personId);
        assert(target&&this.store.entryProfile(after.production.personId).appRole==='employee',409,'REPORT_PERSON_NOT_ALLOWED','所选人员状态已变化，请刷新。');
        assert((await this.listPeople(context)).some(p=>p.blacklakeOperatorId===after.production.personId),409,'REPORT_PERSON_NOT_ALLOWED','所选人员的楼层范围已变化，本次尚未提交。');
        if(isLocalMemberKey(after.production.personId))assert(this.store.members.byKey(after.production.personId)?.submitAsId===after.production.upstreamOperatorId,409,'REPORT_SUBMIT_PERSON_UNAVAILABLE','代报身份已变化，本次尚未提交。');
      }
      assert(this.version(this.owned(id,context))===input.expectedVersion,409,'REPORT_VERSION_CHANGED','核验期间报工或原执行时间已变化，请刷新。');
      if(after.production&&typeof this.blacklake.prepareOutputCorrection==='function'){
        after.nativePlan=await this.blacklake.prepareOutputCorrection(remote,{goodAmount:after.goodQuantity,defectAmount:after.defectQuantity,defectItems:after.defectItems,
          operatorId:after.production.upstreamOperatorId,operatorName:after.production.upstreamOperatorName,startedAt:after.production.startedAt,endedAt:after.production.endedAt,
          durationSeconds:after.production.durationSeconds,planRestTime:after.production.planRestTime,unplanShutdownTime:after.production.unplanShutdownTime,materialProcess:after.production.materialProcess});
        if(after.nativePlan){
          after.production.punchMinutes=after.nativePlan.punchMinutes;
          this.db.prepare('UPDATE leader_report_operations SET before_json=?,after_json=? WHERE id=?').run(JSON.stringify({...state,upstreamBefore:nativeOutputProjection(remote.native)}),JSON.stringify(after),op.id);
        }
        assert(this.version(this.owned(id,context))===input.expectedVersion,409,'REPORT_VERSION_CHANGED','核算期间报工已变化，本次未提交。');
      }
      this.db.prepare("UPDATE leader_report_operations SET status='PENDING',updated_at=? WHERE id=?").run(shanghaiTime(this.now()),op.id);
      context.beforeWrite?.();outcome='UNKNOWN';
      if(action==='delete')await this.blacklake.deleteOutputConfirmed(row.output_id);
      else await this.blacklake.updateOutputConfirmed(remote,{goodAmount:after.goodQuantity,defectAmount:after.defectQuantity,defectCodes:after.defectCodes,
        ...(after.defectItems?{defectItems:after.defectItems}:{}),...(after.production?{operatorId:after.production.upstreamOperatorId,operatorName:after.production.upstreamOperatorName,startedAt:after.production.startedAt,endedAt:after.production.endedAt,durationSeconds:after.production.durationSeconds,materialProcess:after.production.materialProcess,punchMinutes:after.production.punchMinutes,nativePlan:after.nativePlan}:{})});
      if(action==='edit'&&after.production){const verified=await this.blacklake.readOutputForCorrection(row.output_id,{production:true});assert(after.nativePlan?nativePlanMatches(verified,after.nativePlan):productionFieldsMatch(verified,after.production),409,'BLACKLAKE_REPORT_UPDATE_UNCONFIRMED','黑湖工时或附加字段尚未确认，不能重复提交。');}
      outcome='SUCCEEDED';
    }catch(e){code=e.code||'REPORT_CHANGE_ERROR';retryable=(outcome!=='UNKNOWN'||e.definiteFailure===true)&&(e.upstreamStatus===429||['BLACKLAKE_TIMEOUT','BLACKLAKE_UNAVAILABLE','BLACKLAKE_DATA_SYNCING','BLACKLAKE_REQUEST_DEFERRED','BLACKLAKE_RATE_COOLDOWN'].includes(code));if(outcome!=='UNKNOWN'||e.definiteFailure===true)outcome='FAILED';}
    return {...this.settle(op.id,outcome,code,context),...(retryable?{retryable:true}:{}),...(context.queuedJobId?{safeToRetry:outcome==='FAILED'}:{})};
  }
  async reconcile(id,context) {
    const row=this.owned(id,context),op=this.db.prepare("SELECT * FROM leader_report_operations WHERE report_id=? AND status IN ('CHECKING','PENDING','UNKNOWN')").get(row.local_report_id);
    if(!op)return {status:'NO_PENDING',report:this.present(row)};
    if(op.status!=='UNKNOWN')return this.receipt(op,context);
    const after=JSON.parse(op.after_json);
    try {
      const remote=await this.blacklake.readOutputForCorrection(row.output_id,{production:Boolean(after.nativePlan||after.production?.blacklakeFieldsRequired)});
      if(op.action==='edit'&&this.remoteMatches(row,remote,after.production)&&Number(remote.fineAmount)===after.goodQuantity&&Number(remote.defectsAmount)===after.defectQuantity
        &&JSON.stringify([...(remote.defectCodes||[])].sort())===JSON.stringify([...after.defectCodes].sort())
        &&productionFieldsMatch(remote,after.production)
        &&(!after.nativePlan||nativePlanMatches(remote,after.nativePlan))
        &&(!after.defectItems||JSON.stringify([...(remote.defectItems||[])].sort((a,b)=>a.code.localeCompare(b.code)))===JSON.stringify([...after.defectItems].sort((a,b)=>a.code.localeCompare(b.code)))))return this.settle(op.id,'SUCCEEDED','READBACK_CONFIRMED',context);
    }catch(error){if(op.action==='delete'&&error.definiteAbsence===true)return this.settle(op.id,'SUCCEEDED','READBACK_CONFIRMED',context);}
    return this.receipt(op,context);
  }
  settle(operationId,outcome,code,context) {
    const op=this.db.prepare('SELECT * FROM leader_report_operations WHERE id=?').get(operationId);
    if(op.status==='SUCCEEDED')return this.receipt(op,context);
    const row=this.owned(op.assignment_id,context),after=JSON.parse(op.after_json),id=op.assignment_id,action=op.action,ownerId=context.ownerId;
    // A local failure leaves the durable pending/unknown operation locked.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(outcome==='SUCCEEDED') {
        if(action==='delete') {
          this.db.prepare("UPDATE reports SET status='DELETED',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.local_report_id);
          this.db.prepare("UPDATE assignments SET status='CANCELLED',cancellation_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(this.store.entryProfile(ownerId).appRole==='employee'?'质检组长删除已同步黑湖的报工':'组长删除已同步黑湖的报工',id);
        } else {
          this.db.prepare('UPDATE reports SET amount=?,good_amount=?,defect_amount=?,defect_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(after.goodQuantity+after.defectQuantity,after.goodQuantity,after.defectQuantity,after.defectCodes.join(','),row.local_report_id);
          this.db.prepare('UPDATE assignments SET quantity=?,good_quantity=?,defect_quantity=?,defect_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(after.goodQuantity+after.defectQuantity,after.goodQuantity,after.defectQuantity,after.defectCodes.join(','),id);
          if(after.production){
            this.db.prepare('UPDATE reports SET operator_id=? WHERE id=?').run(after.production.operatorId,row.local_report_id);
            this.db.prepare('INSERT INTO report_production_details(report_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(report_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(row.local_report_id,JSON.stringify({...after.production,...(after.defectItems?{defectItems:after.defectItems}:{})}),shanghaiTime(this.now()));
          }
        }
        this.db.prepare('INSERT INTO leader_report_states(report_id,revision,deleted) VALUES(?,1,?) ON CONFLICT(report_id) DO UPDATE SET revision=revision+1,deleted=excluded.deleted').run(row.local_report_id,action==='delete'?1:0);
        this.db.prepare('INSERT INTO assignment_actions(assignment_id,action,reason,actor) VALUES(?,?,?,?)').run(id,action==='delete'?'LEADER_DELETE_REPORT':'LEADER_EDIT_REPORT',code==='READBACK_CONFIRMED'?'只读核对黑湖目标状态后同步，未重发写请求':'黑湖确认后同步本地；原值见报工操作审计',context.auditActor||(this.store.entryProfile(ownerId).appRole==='employee'?'quality-leader:':'dispatcher:')+ownerId);
        if(action==='edit'&&(after.goodQuantity<row.reported_good||after.goodQuantity+after.defectQuantity<row.reported_good+row.reported_defects))this.onQuantityReduced({operationId:op.id,assignmentId:id,reportId:row.local_report_id,projectId:row.project_id,taskId:row.task_id,ownerId});
      }
      this.db.prepare('UPDATE leader_report_operations SET status=?,error_code=?,updated_at=? WHERE id=?').run(outcome,code,shanghaiTime(this.now()),op.id);
      this.db.exec('COMMIT');
    }catch(e){
      this.db.exec('ROLLBACK');
      if(outcome==='SUCCEEDED')this.db.prepare("UPDATE leader_report_operations SET status='UNKNOWN',error_code='LOCAL_PROJECTION_FAILED',updated_at=? WHERE id=?").run(shanghaiTime(this.now()),op.id);
      throw new AppError(409,'REPORT_CHANGE_LOCAL_REVIEW','黑湖操作可能已成功，本地同步待核对，请勿重复操作。');
    }
    if(outcome==='SUCCEEDED'){this.blacklake.taskCache?.clear();this.onChanged({projectId:row.project_id,outputId:row.output_id,deleted:action==='delete'});}
    return this.receipt(this.db.prepare('SELECT * FROM leader_report_operations WHERE id=?').get(op.id),context);
  }
  receipt(op,context) {
    return {operationId:op.id,status:op.status,report:this.present(this.owned(op.assignment_id,context)),
      ...(op.status==='SUCCEEDED'?{}:{error:{code:op.error_code||'REPORT_CHANGE_PENDING',message:op.status==='FAILED'?'本次操作未完成，请刷新核对后再试。':op.status==='UNKNOWN'?'操作结果待核对，请关闭编辑后点击“核对结果”，不要重复修改或删除。':'正在处理上次操作，请稍后刷新。'}})};
  }
}
