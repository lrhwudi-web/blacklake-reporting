import {createHash,randomUUID} from 'node:crypto';
import {assert,AppError} from './errors.mjs';
import {TaskRecovery,inputShape,shanghaiTime,assertDispatchedTaskOpen} from './task-recovery.mjs';
import {FLOOR8_UNIT_IDS} from './dispatch.mjs';
import {workerRouting} from './worker-type.mjs';
import {effectiveWorkSecondsBetween} from './work-time.mjs';
import {agentOwner} from './homepage-agent.mjs';
import {reportedTaskAmount} from './quality.mjs';

const STATES=['READY','IN_PROGRESS','REPORTING','NEEDS_REVIEW','QUANTITY_PENDING','COMPLETED','CANCELLED'];
const text=v=>String(v??'').normalize('NFKC').trim();
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const timestamp=v=>Date.parse(String(v||'').replace(' ','T')+'+08:00');
function positive(v){const n=Number(v);assert(Number.isSafeInteger(n)&&n>0,422,'MANAGEMENT_INVALID_ID','人员或任务编号无效。');return n;}
function reason(v){const s=text(v);assert(s.length<=300&&!/[\u0000-\u001f\u007f]/.test(s),422,'MANAGEMENT_REASON_REQUIRED','操作备注最多300字，且不能包含控制字符。');return s;}
function day(v){assert(/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(timestamp(v+' 00:00:00'))&&shanghaiTime(timestamp(v+' 00:00:00')).slice(0,10)===v,422,'MANAGEMENT_INVALID_DATE','日期不正确。');return v;}
function actual(v,now){const s=text(v).replace('T',' ');const full=s.length===16?s+':00':s;assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(full)&&Number.isFinite(timestamp(full))&&shanghaiTime(timestamp(full))===full&&timestamp(full)<=now,422,'MANAGEMENT_INVALID_TIME','请填写有效且不晚于当前的北京时间。');return full;}

export class Management {
 constructor({store,blacklake,config,now=Date.now}){
  Object.assign(this,{store,blacklake,config,now});this.db=store.db;this.recovery=new TaskRecovery(store,{now});
  this.db.exec(`CREATE TABLE IF NOT EXISTS management_corrections(
   id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL REFERENCES assignments(id),status TEXT NOT NULL,
   proposal_json TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,evidence TEXT NOT NULL DEFAULT '',
   resolution_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS management_corrections_assignment_idx ON management_corrections(assignment_id,created_at);`);
 }
 coverage(){return{source:'local_sqlite',completeWithinScope:true,scopeDescription:'仅本系统已保存的任务与报工，按当前筛选完整分页；不含黑湖其他入口未导入的历史，不等于全厂报工历史。',updatedAt:shanghaiTime(this.now()),timezone:'Asia/Shanghai'};}
 async workOptions(code){code=text(code);assert(code&&code.length<=300,422,'MANAGEMENT_INVALID_WORK','请填写工单编号或工单二维码内容。');const byCode=!/https?:|projectId=|^\d+$/.test(code);const raw=byCode?await this.blacklake.listProjectTasks({projectCodes:[code]},{deadline:this.now()+30000}):await this.blacklake.listWorkOrderProcesses(code);const rows=raw.filter(r=>(!byCode||r.projectCode===code)&&Number.isSafeInteger(r.taskId)&&Number.isSafeInteger(r.projectId)&&r.projectId>0&&r.processStatus!=null&&String(r.processStatus).trim()!==''&&Number.isFinite(Number(r.processStatus))&&Number(r.processStatus)!==20&&!/已完成|已结束|已关闭|已取消|已作废/.test(r.processStatusDisplay||''));assert(rows.length,404,'MANAGEMENT_WORK_NOT_FOUND','未取得该工单可登记的未结束工序，请核对工单。');assert(new Set(rows.map(r=>r.projectId)).size===1,409,'MANAGEMENT_WORK_AMBIGUOUS','存在同名工单，请使用具体工单二维码内容查询。');return{flowCode:'projectId='+rows[0].projectId,processes:rows.map(r=>({taskId:r.taskId,processName:r.processName,projectCode:r.projectCode})),source:'blacklake',updatedAt:shanghaiTime(this.now())};}
 person(id){id=positive(id);const p=this.store.findOperatorByBlacklakeId(id)||this.db.prepare('SELECT id,name,blacklake_operator_id AS blacklakeOperatorId,1 AS inactive FROM operators WHERE blacklake_operator_id=? ORDER BY id DESC LIMIT 1').get(id);assert(p,404,'OPERATOR_NOT_REGISTERED','未在本系统登记该人员。');return p;}
 directory(){
  const rows=this.db.prepare('SELECT id,name,active,blacklake_operator_id AS blacklakeOperatorId FROM operators WHERE (active=1 OR id IN (SELECT operator_id FROM local_members)) AND blacklake_operator_id IS NOT NULL ORDER BY id DESC LIMIT 2001').all(),map=new Map();
  for(const r of rows)if(!map.has(r.blacklakeOperatorId))map.set(r.blacklakeOperatorId,{id:r.blacklakeOperatorId,name:r.name,role:this.store.entryProfile(r.blacklakeOperatorId).appRole,...(this.store.members.byKey(r.blacklakeOperatorId,{includeInactive:true})?{identitySource:'LOCAL',inactive:!r.active}:{})});
  return{people:[...map.values()].slice(0,2000),truncated:rows.length>2000,scopeDescription:'本系统已登记的有效人员及保留历史的停用本系统成员；不是黑湖全员名册。',units:FLOOR8_UNIT_IDS,...this.coverage()};
 }
 present(row){return{...this.recovery.present(row),publishedBy:row.published_by,publishedByOperatorId:row.published_by_operator_id??null,assignmentMode:row.assignment_mode,queuePosition:row.queue_position??null};}
 list(filters={}){
  const from=day(text(filters.from)||shanghaiTime(this.now()-30*86400000).slice(0,10)),to=day(text(filters.to)||shanghaiTime(this.now()).slice(0,10));assert(from<=to,422,'MANAGEMENT_INVALID_DATE','开始日期不能晚于结束日期。');
  const status=text(filters.status)||'ALL',kind=text(filters.kind)||'ALL',dateField=text(filters.dateField)||'work';
  assert(['ALL',...STATES].includes(status)&&['ALL','DISPATCHED'].includes(kind)&&['work','published'].includes(dateField),422,'MANAGEMENT_INVALID_FILTER','筛选条件无效。');
  const limit=Number(filters.limit??20),offset=Number(filters.offset??0);assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(offset)&&offset>=0&&offset<=1000000,422,'MANAGEMENT_INVALID_PAGE','分页参数无效。');
  const end=shanghaiTime(timestamp(to+' 00:00:00')+86400000).slice(0,10),clock=dateField==='published'?'a.published_at':'COALESCE(a.ended_at,a.started_at,a.published_at)';
  const where=[`${clock}>=?`,`${clock}<?`],args=[from+' 00:00:00',end+' 00:00:00'];
  if(filters.employeeId){where.push('o.blacklake_operator_id=?');args.push(positive(filters.employeeId));}
  if(filters.dispatcherId){where.push('a.published_by_operator_id=?');args.push(positive(filters.dispatcherId));}
  if(status!=='ALL'){where.push('a.status=?');args.push(status);}if(kind==='DISPATCHED')where.push("a.assignment_mode='DISPATCHED'");
  const q=text(filters.q);assert(q.length<=100,422,'MANAGEMENT_INVALID_FILTER','搜索内容过长。');if(q){where.push('(a.project_code LIKE ? OR a.process_name LIKE ? OR o.name LIKE ? OR a.id=?)');args.push('%'+q+'%','%'+q+'%','%'+q+'%',q);}
  const joined='FROM assignments a JOIN operators o ON o.id=a.operator_id WHERE '+where.join(' AND '),total=this.db.prepare('SELECT COUNT(*) AS n '+joined).get(...args).n;
  const rows=this.db.prepare('SELECT a.*,o.name AS operator_name,o.blacklake_operator_id '+joined+` ORDER BY ${clock} DESC,a.id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
  return{assignments:rows.map(r=>this.present(r)),total,limit,offset,from,to,dateField,coverage:this.coverage()};
 }
 queue(id){const p=this.person(id),rows=this.store.activeAssignments(p.id).filter(r=>r.status==='READY'&&!r.machineId&&FLOOR8_UNIT_IDS.includes(r.stationName));const ids=rows.map(r=>r.id);return{employeeId:p.blacklakeOperatorId,assignments:ids.map(id=>this.present(this.recovery.raw(id))),version:hash(ids.map(id=>this.recovery.version(this.recovery.raw(id)))),coverage:this.coverage()};}
 personDetail(id){const p=this.person(id);return{person:{id:p.blacklakeOperatorId,name:p.name,role:this.store.entryProfile(p.blacklakeOperatorId).appRole},current:this.store.activeAssignments(p.id).map(r=>this.present(this.recovery.raw(r.id))),queue:this.queue(id),coverage:this.coverage()};}
 detail(id){const row=this.recovery.raw(id),report=row.report_id?this.db.prepare('SELECT id,status,amount,good_amount AS goodAmount,defect_amount AS defectAmount,blacklake_output_id AS blacklakeOutputId,error_code AS errorCode,error_message AS errorMessage,output_time AS outputTime,created_at AS createdAt FROM reports WHERE id=?').get(row.report_id):null;
  if(report){const identity=this.store.members.snapshot(report.id);if(identity)report.submissionIdentity=identity;}
  const actions=this.db.prepare('SELECT id,action,reason,actor,created_at AS createdAt FROM assignment_actions WHERE assignment_id=? ORDER BY id DESC LIMIT 200').all(id);
  const corrections=this.db.prepare('SELECT * FROM management_corrections WHERE assignment_id=? ORDER BY created_at DESC,id DESC').all(id).map(r=>({...r,proposal:JSON.parse(r.proposal_json),resolution:r.resolution_json?JSON.parse(r.resolution_json):null}));
  const reassignable=row.status==='READY'&&row.assignment_mode==='DISPATCHED'&&!row.started_at&&!row.report_id&&!row.machine_id&&FLOOR8_UNIT_IDS.includes(row.station_name);
  return{...this.recovery.detail(id),assignment:{...this.present(row),canReassign:reassignable,canRequestCorrection:row.status==='COMPLETED'&&report?.status==='SUCCEEDED'},report:report||null,actions,actionsTruncated:actions.length===200,corrections,coverage:this.coverage()};
 }
 target(id){const p=this.person(id);assert(!p.inactive&&workerRouting(p,this.store.entryProfile(p.blacklakeOperatorId),this.store.workerTypeProfile(p.blacklakeOperatorId),this.config.floor8EmployeeIds||[]).canReceiveFloor8Assignments,409,'MANAGEMENT_WRONG_WORKER','目标必须是当前有效且可接8楼派工的员工。');return p;}
 async reassign(id,input,context){inputShape(input,['expectedVersion','reason','employeeId','unitId']);const why=reason(input.reason),targetId=positive(input.employeeId),unit=text(input.unitId);assert(FLOOR8_UNIT_IDS.includes(unit),422,'INVALID_UNIT','请选择有效8楼工位。');
  const replay=this.receipt(context);if(replay)return this.recovery.transact(context.operationId,context.actor,'reassign:'+id,input,()=>{});
  assert(this.detail(id).assignment.canReassign,409,'MANAGEMENT_NOT_REASSIGNABLE','只能改派8楼尚未开始且未提交的任务。');
  const liveTask=await assertDispatchedTaskOpen(this.blacklake,this.store.assignmentById(id));
  return this.recovery.transact(context.operationId,context.actor,'reassign:'+id,input,()=>{
   const row=this.recovery.raw(id);assert(input.expectedVersion===this.recovery.version(row),409,'RECOVERY_VERSION_CHANGED','任务已变化，请刷新。');assert(this.detail(id).assignment.canReassign,409,'MANAGEMENT_NOT_REASSIGNABLE','任务已开始或状态已变化。');
   const target=this.target(targetId);assert(target.id!==row.operator_id,422,'MANAGEMENT_SAME_WORKER','请选择另一位员工。');assert(this.store.dispatchQueueState(targetId).canQueue,409,'MANAGEMENT_TARGET_BUSY','目标有待核对任务或绣花任务，请先处理。');
   const duplicate=this.db.prepare("SELECT id FROM assignments WHERE operator_id=? AND task_id=? AND project_id IS ? AND status IN ('READY','IN_PROGRESS','REPORTING','NEEDS_REVIEW') AND id<>?").get(target.id,row.task_id,row.project_id,id);assert(!duplicate,409,'DUPLICATE_QUEUED_TASK','目标已有同一工单工序任务。');
   const before=this.present(row),queue=this.queue(targetId).assignments,quality=this.store.isQualityOperator(target.id);
   for(const [i,item]of queue.entries())this.db.prepare('UPDATE assignments SET queue_position=? WHERE id=?').run(i+1,item.id);
   const baseline=this.store.succeededAmountForTaskSince({taskId:row.task_id,projectId:row.project_id,since:'',includeDefects:quality});
   this.db.prepare("UPDATE assignments SET operator_id=?,station_name=?,queue_position=?,quality_inspection=?,local_report_baseline=?,baseline_reported_amount=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='READY'").run(target.id,unit,queue.length+1,quality?1:0,baseline,Math.max(reportedTaskAmount(liveTask,quality),baseline),id);
   const after=this.present(this.recovery.raw(id));this.recovery.event({row,action:'ADMIN_REASSIGN_READY',actor:context.actor,reason:why,before:{...before,targetQueue:queue.map(r=>r.id)},after:{...after,targetQueue:[...queue.map(r=>r.id),id]}});return{assignment:after,action:'ADMIN_REASSIGN_READY'};
  });
 }
 receipt({actor,operationId}){return this.db.prepare('SELECT 1 FROM task_recovery_operations WHERE actor=? AND operation_id=?').get(actor,operationId);}
 reorder(employeeId,input,context){inputShape(input,['expectedVersion','reason','assignmentIds']);const why=reason(input.reason);assert(Array.isArray(input.assignmentIds)&&input.assignmentIds.length>0&&input.assignmentIds.length<=200&&input.assignmentIds.every(x=>typeof x==='string'),422,'MANAGEMENT_INVALID_QUEUE','队列最多200项且必须完整提交。');
  return this.recovery.transact(context.operationId,context.actor,'reorder:'+employeeId,input,()=>{
   this.target(employeeId);assert(this.store.dispatchQueueState(Number(employeeId)).canQueue,409,'MANAGEMENT_QUEUE_BLOCKED','有结果待核对任务时不能调整队列。');const current=this.queue(employeeId),ids=current.assignments.map(r=>r.id);
   assert(input.expectedVersion===current.version,409,'RECOVERY_VERSION_CHANGED','队列已变化，请刷新。');assert(ids.length===input.assignmentIds.length&&new Set(input.assignmentIds).size===ids.length&&ids.every(id=>input.assignmentIds.includes(id)),409,'MANAGEMENT_QUEUE_CHANGED','必须提交该员工完整待开始队列，不能包含已开始或他人的任务。');
   for(const[i,id]of input.assignmentIds.entries())this.db.prepare("UPDATE assignments SET queue_position=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='READY'").run(i+1,id);
   const row=this.recovery.raw(ids[0]);this.recovery.event({row,action:'ADMIN_REORDER_QUEUE',actor:context.actor,reason:why,before:{assignmentIds:ids},after:{assignmentIds:input.assignmentIds}});return{queue:this.queue(employeeId),action:'ADMIN_REORDER_QUEUE'};
  });
 }
 async missing(input,context){inputShape(input,['employeeId','flowCode','taskId','unitId','actualStartedAt','actualEndedAt','reason']);const why=reason(input.reason),employeeId=positive(input.employeeId),taskId=positive(input.taskId),unit=text(input.unitId),flow=text(input.flowCode);assert(FLOOR8_UNIT_IDS.includes(unit)&&flow&&flow.length<=300,422,'MANAGEMENT_INVALID_WORK','请选择8楼工位并填写工单码。');
  if(this.receipt(context))return this.recovery.transact(context.operationId,context.actor,'missing-work',input,()=>{});
  const started=actual(input.actualStartedAt,this.now()),ended=actual(input.actualEndedAt,this.now());assert(ended>started,422,'MANAGEMENT_INVALID_TIME','实际结束必须晚于实际开始。');
  const task=await this.blacklake.findWorkOrderProcess(flow,taskId);assert(task&&task.taskId===taskId&&Number.isSafeInteger(task.projectId)&&task.projectId>0,409,'MANAGEMENT_TASK_UNKNOWN','未核实该工单工序。');
  assert(task.processStatus!=null&&String(task.processStatus).trim()!==''&&Number.isFinite(Number(task.processStatus))&&Number(task.processStatus)!==20&&!/已关闭|已结束|已完成/.test(task.processStatusDisplay||''),409,'TASK_CLOSED','工序已关闭或状态未知，不能补登记。');const quantity=Number(task.plannedAmount);assert(Number.isSafeInteger(quantity)&&quantity>0,422,'BLACKLAKE_PLAN_AMOUNT_INVALID','未取得有效计划数量。');
  return this.recovery.transact(context.operationId,context.actor,'missing-work',input,()=>{
   const worker=this.target(employeeId);const overlap=this.db.prepare("SELECT id FROM assignments WHERE operator_id=? AND status<>'CANCELLED' AND ((started_at IS NOT NULL AND started_at<? AND (ended_at IS NULL OR ended_at>?)) OR (status='READY' AND task_id=? AND project_id IS ?)) LIMIT 1").get(worker.id,ended,started,taskId,task.projectId);assert(!overlap,409,'MANAGEMENT_WORK_OVERLAP','时间与已有任务重叠，或已有同工序待开始单；请先核对原任务，勿重复补记。');
   const id=randomUUID(),quality=this.store.isQualityOperator(worker.id);this.db.prepare(`INSERT INTO assignments(id,operator_id,task_id,project_id,project_code,product_name,process_name,station_name,quantity,min_duration_seconds,max_duration_seconds,status,assignment_mode,published_by,published_at,started_at,ended_at,duration_seconds,quantity_policy,quality_inspection) VALUES(?,?,?,?,?,?,?,?,?,0,2147483647,'QUANTITY_PENDING','SELF_SCAN',?,?,?,?,?,'PENDING_REVIEW',?)`).run(id,worker.id,taskId,task.projectId,task.projectCode,task.productName||'',task.processName,unit,quantity,'管理员补登记',shanghaiTime(this.now()),started,ended,effectiveWorkSecondsBetween(started,ended),quality?1:0);
   const row=this.recovery.raw(id);this.recovery.event({row,action:'ADMIN_REGISTER_MISSING_WORK',actor:context.actor,reason:why,before:null,after:this.present(row)});return{assignment:this.present(row),action:'ADMIN_REGISTER_MISSING_WORK',quantityNotSubmitted:true};
  });
 }
 correction(id,input,context){inputShape(input,['expectedVersion','reason','goodQuantity','defectQuantity','actualEndedAt']);const why=reason(input.reason),good=Number(input.goodQuantity),bad=Number(input.defectQuantity);assert(Number.isSafeInteger(good)&&good>=0&&Number.isSafeInteger(bad)&&bad>=0&&good+bad>0,422,'INVALID_QUANTITY','请填写有效的拟更正合格/不良数量。');
  const ended=input.actualEndedAt?actual(input.actualEndedAt,this.now()):null;
  return this.recovery.transact(context.operationId,context.actor,'correction:'+id,input,()=>{
   const row=this.recovery.raw(id);assert(input.expectedVersion===this.recovery.version(row),409,'RECOVERY_VERSION_CHANGED','任务已变化，请刷新。');assert(this.detail(id).assignment.canRequestCorrection,409,'MANAGEMENT_NOT_REPORTED','只有已确认提交黑湖的记录需要登记外部更正。');assert(!ended||ended>=row.started_at,422,'MANAGEMENT_INVALID_TIME','拟更正结束不能早于开始。');assert(!this.db.prepare("SELECT id FROM management_corrections WHERE assignment_id=? AND status='OPEN'").get(id),409,'MANAGEMENT_CORRECTION_OPEN','已有未完成的更正事项。');
   const correctionId=randomUUID(),proposal={goodQuantity:good,defectQuantity:bad,actualEndedAt:ended},at=shanghaiTime(this.now());this.db.prepare("INSERT INTO management_corrections(id,assignment_id,status,proposal_json,reason,actor,created_at,updated_at) VALUES(?,?,'OPEN',?,?,?,?,?)").run(correctionId,id,JSON.stringify(proposal),why,context.actor,at,at);
   this.recovery.event({row,action:'ADMIN_REQUEST_REPORT_CORRECTION',actor:context.actor,reason:why,before:{reportId:row.report_id},after:{correctionId,proposal,upstreamChanged:false}});return{assignment:this.present(this.recovery.raw(id)),correctionId,upstreamChanged:false};
  });
 }
 resolveCorrection(id,input,context){inputShape(input,['expectedVersion','reason','evidence','blacklakeOutputId','confirmedExternally']);const why=reason(input.reason),evidence=text(input.evidence),outputId=text(input.blacklakeOutputId);assert(input.confirmedExternally===true&&evidence.length>=10&&evidence.length<=2000&&outputId.length>=1&&outputId.length<=128,422,'MANAGEMENT_EVIDENCE_REQUIRED','请先在黑湖处理并核实，填写记录编号与至少10字的处理凭据并确认。');
  return this.recovery.transact(context.operationId,context.actor,'resolve-correction:'+id,input,()=>{
   const c=this.db.prepare('SELECT * FROM management_corrections WHERE id=?').get(id);assert(c,404,'NOT_FOUND','更正事项不存在。');assert(hash(c)===input.expectedVersion&&c.status==='OPEN',409,'RECOVERY_VERSION_CHANGED','更正事项已变化。');const resolution={blacklakeOutputId:outputId,declaredVerifiedBy:context.actor,verifiedAutomatically:false};
   this.db.prepare("UPDATE management_corrections SET status='EXTERNAL_RECORDED',evidence=?,resolution_json=?,updated_at=? WHERE id=?").run(evidence,JSON.stringify(resolution),shanghaiTime(this.now()),id);const row=this.recovery.raw(c.assignment_id);this.recovery.event({row,action:'ADMIN_RECORD_EXTERNAL_CORRECTION',actor:context.actor,reason:why,before:{correctionId:id,status:c.status},after:{correctionId:id,status:'EXTERNAL_RECORDED',resolution,evidence,originalReportPreserved:true}});return{assignment:this.present(this.recovery.raw(row.id)),correctionId:id,originalReportPreserved:true,verifiedAutomatically:false};
  });
 }
}

export function createManagementHandler(options){const service=new Management(options);return async(req,res,url,{send,jsonBody})=>{
 const base='/v1/admin/management',parts=url.pathname.slice(base.length).split('/').filter(Boolean).map(p=>decodeURIComponent(p));
 const context={actor:`ADMIN:${agentOwner(req,options.config).slice(0,24)}`,operationId:String(req.headers['idempotency-key']||'')};
 if(req.method!=='GET'){assert(req.headers['sec-fetch-site']!=='cross-site',403,'MANAGEMENT_ORIGIN_REJECTED','请从管理后台操作。');if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{}assert(origin?.host===req.headers.host,403,'MANAGEMENT_ORIGIN_REJECTED','请从管理后台操作。');}}
 if(req.method==='GET'){
  if(parts[0]==='people'&&parts.length===1)return send(res,200,service.directory());
  if(parts[0]==='work-orders'&&parts[1]==='options'&&parts.length===2)return send(res,200,await service.workOptions(url.searchParams.get('code')));
  if(parts[0]==='people'&&parts.length===2)return send(res,200,service.personDetail(parts[1]));
  if(parts[0]==='tasks'&&parts.length===1)return send(res,200,service.list(Object.fromEntries(url.searchParams)));
  if(parts[0]==='tasks'&&parts.length===2){const value=service.detail(parts[1]);value.corrections=value.corrections.map(c=>({...c,version:hash(service.db.prepare('SELECT * FROM management_corrections WHERE id=?').get(c.id))}));return send(res,200,value);}
  if(parts[0]==='operations'&&parts.length===2)return send(res,200,service.recovery.operation(parts[1],context.actor));
 }
 if(req.method==='POST'){
  const input=await jsonBody(req);
  if(parts[0]==='people'&&parts[2]==='queue'&&parts.length===3)return send(res,200,service.reorder(parts[1],input,context));
  if(parts[0]==='tasks'&&parts[1]==='missing'&&parts.length===2)return send(res,201,await service.missing(input,context));
  if(parts[0]==='tasks'&&parts[2]==='reassign'&&parts.length===3)return send(res,200,await service.reassign(parts[1],input,context));
  if(parts[0]==='tasks'&&parts[2]==='corrections'&&parts.length===3)return send(res,201,service.correction(parts[1],input,context));
  if(parts[0]==='corrections'&&parts[2]==='resolve'&&parts.length===3)return send(res,200,service.resolveCorrection(parts[1],input,context));
 }
 throw new AppError(404,'NOT_FOUND','管理接口不存在。');
};}
