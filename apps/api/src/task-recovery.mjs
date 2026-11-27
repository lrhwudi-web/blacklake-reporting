import { createHash, createHmac, randomUUID } from "node:crypto";
import { AppError, assert } from "./errors.mjs";
import { hashConfirmationCode } from "./crypto.mjs";
import { effectiveWorkSecondsBetween } from "./work-time.mjs";
import { FLOOR8_UNIT_IDS } from "./dispatch.mjs";
import { agentOwner } from "./homepage-agent.mjs";

const OPEN = ["READY", "IN_PROGRESS", "REPORTING", "NEEDS_REVIEW"];
const STATUSES = [...OPEN, "QUANTITY_PENDING", "COMPLETED", "CANCELLED"];
const normalize = (v) => String(v ?? "").normalize("NFKC").trim();
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = (v) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
export const shanghaiTime = (ms = Date.now()) => new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const millis = (s) => Date.parse(String(s || "").replace(" ", "T") + (/(Z|[+-]\d{2}:?\d{2})$/i.test(String(s || "")) ? "" : "+08:00"));
export function inputShape(value, keys) {
  assert(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)), 422, "RECOVERY_INVALID_INPUT", "处置参数不正确，请刷新后操作。");
  return value;
}
function reasonText(value) {
  const text = normalize(value);
  assert(text.length <= 300 && !/[\u0000-\u001f\u007f]/.test(text), 422, "RECOVERY_REASON_REQUIRED", "操作备注最多300字，且不能包含控制字符。");
  return text;
}
function actualEnd(value, startedAt, now) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(String(value || ""));
  const text = match ? `${match[1]} ${match[2]}:${match[3] || "00"}` : "";
  const at = millis(text);
  assert(Number.isFinite(at) && shanghaiTime(at) === text, 422, "RECOVERY_INVALID_END", "请填写有效的实际结束时间（北京时间）。");
  assert(Number.isFinite(millis(startedAt)) && at >= millis(startedAt) && at <= now, 422, "RECOVERY_INVALID_END", "实际结束时间不能早于开工时间，也不能晚于当前时间。");
  return text;
}
const quantityTask = (row) => row.assignment_mode === "DISPATCHED" && !row.machine_id && FLOOR8_UNIT_IDS.includes(row.station_name);
function snapshot(row) {
  return { id: row.id, status: row.status, operatorId: row.operator_id, projectId: row.project_id, taskId: row.task_id,
    stationName: row.station_name, machineId: row.machine_id, startedAt: row.started_at, endedAt: row.ended_at,
    durationSeconds: row.duration_seconds, quantityPolicy: row.quantity_policy, reportId: row.report_id, cancellationReason: row.cancellation_reason,
    goodQuantity: row.good_quantity, defectQuantity: row.defect_quantity, defectCodes: String(row.defect_code||'').split(',').filter(Boolean) };
}

export class TaskRecovery {
  constructor(store, { now = Date.now } = {}) {
    this.store = store; this.db = store.db; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_recovery_events (
      id TEXT PRIMARY KEY, assignment_id TEXT, blacklake_operator_id INTEGER NOT NULL,
      action TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, actual_at TEXT,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_recovery_assignment_idx ON task_recovery_events(assignment_id, created_at);
      CREATE INDEX IF NOT EXISTS task_recovery_operator_idx ON task_recovery_events(blacklake_operator_id, created_at);
      CREATE TABLE IF NOT EXISTS task_recovery_operations (
      actor TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor, operation_id));`);
  }
  raw(id) {
    const row = this.db.prepare(`SELECT a.*,o.name AS operator_name,o.blacklake_operator_id FROM assignments a JOIN operators o ON o.id=a.operator_id WHERE a.id=?`).get(id);
    assert(row, 404, "ASSIGNMENT_NOT_FOUND", "没有找到这笔任务。"); return row;
  }
  version(row) {
    const event = this.db.prepare("SELECT MAX(rowid) AS revision FROM task_recovery_events WHERE assignment_id=?").get(row.id);
    const assignment=this.store.assignmentRecord(row);
    return digest({ row, isQualityInspection:assignment.isQualityInspection, timingRevision:assignment.timingRevision, revision: event.revision });
  }
  present(row, waitingMinutes = 60) {
    const now = this.now(), flags = [];
    if (row.status === "READY" && Number.isFinite(millis(row.published_at)) && now - millis(row.published_at) >= waitingMinutes * 60000) flags.push("WAITING_LONG");
    if (row.status === "IN_PROGRESS" && row.started_at && shanghaiTime(millis(row.started_at)).slice(0,10) < shanghaiTime(now).slice(0,10)) flags.push("CROSS_DAY");
    if (["REPORTING", "NEEDS_REVIEW"].includes(row.status)) flags.push("RESULT_UNKNOWN");
    if (row.status === "QUANTITY_PENDING") flags.push("QUANTITY_PENDING");
    return { ...snapshot(row), blacklakeOperatorId: row.blacklake_operator_id, operatorName: row.operator_name,
      projectCode: row.project_code, productName: row.product_name, processName: row.process_name,
      publishedAt: row.published_at, version: this.version(row), flags,
      canFinish: row.status === "IN_PROGRESS" && quantityTask(row) && !row.report_id,
      canCorrectTime: row.status === "QUANTITY_PENDING" && quantityTask(row) && !row.report_id,
      canConfirmQuantity: row.status === "QUANTITY_PENDING" && !row.report_id && Boolean(row.started_at && row.ended_at),
      canVoidQuantity: row.status === "QUANTITY_PENDING" && !row.report_id,
      canCancelReady: row.status === "READY" && row.assignment_mode === "DISPATCHED" };
  }
  list({ status = "OPEN", query = "", category = "ALL", offset = 0, limit = 50, waitingMinutes = 60 } = {}) {
    assert(["OPEN", "ALL", ...STATUSES].includes(status) && ["ALL", "WAITING_LONG", "CROSS_DAY", "RESULT_UNKNOWN", "QUANTITY_PENDING"].includes(category), 422, "RECOVERY_INVALID_FILTER", "任务筛选条件不正确。");
    assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(waitingMinutes) && waitingMinutes >= 1 && waitingMinutes <= 10080, 422, "RECOVERY_INVALID_FILTER", "分页或待开始提醒时间不正确。");
    query = normalize(query); assert(query.length <= 100, 422, "RECOVERY_INVALID_FILTER", "搜索内容过长。");
    const clauses = [], args = [];
    if (status !== "ALL") { const selected = status === "OPEN" ? OPEN : [status]; clauses.push(`a.status IN (${selected.map(()=>"?").join(",")})`); args.push(...selected); }
    if (query) { clauses.push("(o.name LIKE ? OR a.project_code LIKE ? OR a.process_name LIKE ? OR CAST(o.blacklake_operator_id AS TEXT)=? OR a.id=?)"); args.push(...Array(3).fill(`%${query}%`),query,query); }
    if (category === "WAITING_LONG") { clauses.push("a.status='READY' AND a.published_at<=?"); args.push(shanghaiTime(this.now()-waitingMinutes*60000)); }
    if (category === "CROSS_DAY") { clauses.push("a.status='IN_PROGRESS' AND a.started_at<?"); args.push(shanghaiTime(this.now()).slice(0,10)+" 00:00:00"); }
    if (category === "RESULT_UNKNOWN") clauses.push("a.status IN ('REPORTING','NEEDS_REVIEW')");
    if (category === "QUANTITY_PENDING") clauses.push("a.status='QUANTITY_PENDING'");
    const from = `FROM assignments a JOIN operators o ON o.id=a.operator_id ${clauses.length?"WHERE "+clauses.join(" AND "):""}`;
    const total = this.db.prepare("SELECT COUNT(*) AS n "+from).get(...args).n;
    const rows = this.db.prepare(`SELECT a.*,o.name AS operator_name,o.blacklake_operator_id ${from}
      ORDER BY CASE a.status WHEN 'NEEDS_REVIEW' THEN 0 WHEN 'REPORTING' THEN 1 WHEN 'IN_PROGRESS' THEN 2 WHEN 'READY' THEN 3 WHEN 'QUANTITY_PENDING' THEN 4 ELSE 5 END,
      COALESCE(a.started_at,a.published_at) ASC,a.id ASC LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const summary = Object.fromEntries(this.db.prepare("SELECT status,COUNT(*) AS n FROM assignments GROUP BY status").all().map(r=>[r.status,r.n]));
    return { assignments: rows.map(r=>this.present(r,waitingMinutes)), total, offset, limit, summary, serverTime: shanghaiTime(this.now()),
      scopeDescription: "仅本系统本地任务；停留过久与跨日仅提示待核实，不认定生产异常。" };
  }
  detail(id) {
    const row = this.raw(id);
    const events = this.db.prepare("SELECT * FROM task_recovery_events WHERE assignment_id=? ORDER BY rowid DESC LIMIT 100").all(id).map(e=>({id:e.id,action:e.action,actor:e.actor,reason:e.reason,actualAt:e.actual_at,createdAt:e.created_at,before:JSON.parse(e.before_json),after:JSON.parse(e.after_json)}));
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM task_recovery_events WHERE assignment_id=?").get(id).n;
    const overnight=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='overnight_clockout_items'").get()
      ? this.db.prepare('SELECT business_date,reference_kind,reference_at,pause_at,status,detail_json FROM overnight_clockout_items WHERE assignment_id=? ORDER BY business_date DESC LIMIT 1').get(id):null;
    return { assignment:this.present(row), events, eventsTotal:total, eventsTruncated:total>events.length,
      ...(overnight?{overnightClockout:{businessDate:overnight.business_date,referenceKind:overnight.reference_kind,referenceAt:overnight.reference_at,pauseAt:overnight.pause_at,status:overnight.status,...JSON.parse(overnight.detail_json)}}:{}) };
  }
  event({ row, operatorId, action, actor, reason, actualAt, before, after }) {
    this.db.prepare("INSERT INTO task_recovery_events VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),row?.id||null,operatorId??row.blacklake_operator_id,action,actor,reason,actualAt||null,JSON.stringify(before),JSON.stringify(after),shanghaiTime(this.now()));
    if (row) this.db.prepare("INSERT INTO assignment_actions(assignment_id,action,reason,actor) VALUES (?,?,?,?)").run(row.id,action,reason,actor);
  }
  operation(id, actor) {
    const entry = this.db.prepare("SELECT response_json FROM task_recovery_operations WHERE actor=? AND operation_id=?").get(actor,id);
    assert(entry,404,"RECOVERY_OPERATION_NOT_FOUND","尚未找到本次处置回执，请刷新任务状态后核对。");
    return this.response(JSON.parse(entry.response_json), actor, id, true);
  }
  response(value, actor, id, replayed = false) {
    if (value.bindingRecovery) {
      const expired = Date.parse(value.expiresAt) <= this.now();
      const code = String(100000+createHmac("sha256",this.store.sessionSecret).update(`binding-recovery:${actor}:${id}`).digest().readUInt32BE(0)%900000);
      const operator=value.blacklakeOperatorId?this.store.findOperatorByBlacklakeId(value.blacklakeOperatorId):null;
      const issued=operator?this.db.prepare("SELECT used_at FROM operator_binding_codes WHERE operator_id=? AND code_hash=? AND expires_at=? ORDER BY rowid DESC LIMIT 1").get(operator.id,hashConfirmationCode(operator.id,code,this.store.sessionSecret),value.expiresAt):null;
      const codeUsed=Boolean(issued?.used_at);
      return { ...value, confirmationCode:expired||codeUsed?"":code, codeExpired:expired, codeUsed, replayed };
    }
    return { ...value, replayed };
  }
  transact(id, actor, action, input, work) {
    assert(/^[a-zA-Z0-9_-]{16,128}$/.test(id),400,"INVALID_IDEMPOTENCY_KEY","处置标识无效，请刷新后重新操作。");
    const hash = digest({ action, input });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT * FROM task_recovery_operations WHERE actor=? AND operation_id=?").get(actor,id);
      if (previous) {
        assert(previous.request_hash===hash,409,"RECOVERY_OPERATION_CHANGED","本次处置标识已用于其他内容，请刷新后核对。");
        this.db.exec("COMMIT"); return this.response(JSON.parse(previous.response_json),actor,id,true);
      }
      const result=work();
      this.db.prepare("INSERT INTO task_recovery_operations VALUES (?,?,?,?,?)").run(actor,id,hash,JSON.stringify(result),shanghaiTime(this.now()));
      this.db.exec("COMMIT");return this.response(result,actor,id);
    } catch(error) { try{this.db.exec("ROLLBACK");}catch{} throw error; }
  }
  act(assignmentId, action, input, { actor, operationId }) {
    inputShape(input,["expectedVersion","reason","actualEndedAt","blacklakeOutputId"]);
    assert(["finish","correct-time","cancel-ready","void-quantity","confirm-result","missing-result"].includes(action),404,"NOT_FOUND","处置动作不存在。");
    const reason=reasonText(input.reason);
    return this.transact(operationId,actor,`${action}:${assignmentId}`,input,()=>{
      const row=this.raw(assignmentId);
      assert(input.expectedVersion===this.version(row),409,"RECOVERY_VERSION_CHANGED","任务已被员工或其他管理员更新，请刷新后核对。");
      const before=snapshot(row);let at=null,eventAction;
      if(action==='void-quantity') {
        assert(row.status==='QUANTITY_PENDING'&&!row.report_id,409,'QUANTITY_NOT_VOIDABLE','只能作废尚未报量的记录，未知报工必须先核对黑湖。');
        eventAction='VOID_PENDING_QUANTITY';
        this.db.prepare("UPDATE assignments SET status='CANCELLED',cancellation_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reason,row.id);
      }else if(['confirm-result','missing-result'].includes(action)) {
        assert(row.status==='NEEDS_REVIEW'&&row.report_id,409,'ASSIGNMENT_NOT_REVIEWABLE','任务不在结果待核对状态，请刷新。');
        const report=this.db.prepare("SELECT * FROM reports WHERE id=? AND status='UNKNOWN'").get(row.report_id);
        assert(report,409,'ASSIGNMENT_NOT_REVIEWABLE','没有可核对的未知报工。');
        assert(typeof(input.blacklakeOutputId??'')==='string'&&String(input.blacklakeOutputId||'').length<=128,422,'INVALID_OUTPUT_ID','黑湖记录编号过长或无效。');
        if(action==='confirm-result') {
          this.db.prepare("UPDATE reports SET status='SUCCEEDED',blacklake_output_id=?,error_code=NULL,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(input.blacklakeOutputId||'',row.report_id);
          this.db.prepare("UPDATE assignments SET status='COMPLETED',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
          eventAction='CONFIRM_REPORT_RESULT';
        }else {
          this.db.prepare("UPDATE reports SET status='FAILED',error_code='AUDIT_NOT_CREATED',error_message='管理员核对黑湖无记录',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.report_id);
          this.db.prepare("UPDATE assignments SET status=?,report_id=NULL,attempt_number=attempt_number+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.quantity_policy==='PENDING_REVIEW'?'QUANTITY_PENDING':'IN_PROGRESS',row.id);
          eventAction='REPORT_RESULT_NOT_CREATED';
        }
      }else if(action==="cancel-ready") {
        assert(row.status==="READY"&&row.assignment_mode==="DISPATCHED",409,"ASSIGNMENT_NOT_CANCELLABLE","只能撤销尚未开始的派单，请刷新任务。");
        at=shanghaiTime(this.now());eventAction="ADMIN_CANCEL_READY";
        this.db.prepare("UPDATE assignments SET status='CANCELLED',cancellation_reason=?,ended_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='READY'").run(reason,at,row.id);
      }else {
        assert(quantityTask(row)&&!row.report_id,409,"RECOVERY_QUANTITY_FLOW_REQUIRED","首批仅支持8楼待核量任务；其他报工请继续按原流程确认数量，已报黑湖记录不能在这里改写。");
        assert(row.status===(action==="finish"?"IN_PROGRESS":"QUANTITY_PENDING"),409,"RECOVERY_STATE_CHANGED","任务状态不支持此操作；提交中或结果待核对的报工必须先核对黑湖。");
        at=actualEnd(input.actualEndedAt,row.started_at,this.now());
        const seconds=effectiveWorkSecondsBetween(row.started_at,at,this.store.assignmentPauses(row.id));
        eventAction=action==="finish"?"ADMIN_FINISH_PENDING_QUANTITY":"ADMIN_CORRECT_END_TIME";
        this.db.prepare("UPDATE assignments SET status='QUANTITY_PENDING',ended_at=?,duration_seconds=?,quantity_policy='PENDING_REVIEW',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(at,seconds,row.id);
      }
      this.event({row,action:eventAction,actor,reason,actualAt:at,before,after:snapshot(this.raw(row.id))});
      return { assignment:this.present(this.raw(row.id)), action:eventAction };
    });
  }
  operatorContext(operatorId) {
    const operator=this.store.findOperatorByBlacklakeId(operatorId);
    assert(operator,404,"OPERATOR_NOT_REGISTERED","该人员尚未在本系统登记，请到人员页使用首次绑定流程。");
    const rows=this.db.prepare("SELECT * FROM operators WHERE blacklake_operator_id=? ORDER BY id").all(operatorId);
    const ids=rows.map(r=>r.id),marks=ids.map(()=>"?").join(",");
    const bindings=this.db.prepare(`SELECT subject_hash,operator_id,bound_at FROM wechat_bindings WHERE operator_id IN (${marks}) ORDER BY operator_id`).all(...ids);
    const sessions=this.db.prepare(`SELECT token_hash,operator_id,expires_at FROM sessions WHERE operator_id IN (${marks}) ORDER BY token_hash`).all(...ids);
    const codes=this.db.prepare(`SELECT id,used_at,expires_at FROM operator_binding_codes WHERE operator_id IN (${marks}) ORDER BY id`).all(...ids);
    const active=this.db.prepare(`SELECT a.*,o.name AS operator_name,o.blacklake_operator_id FROM assignments a JOIN operators o ON o.id=a.operator_id WHERE o.blacklake_operator_id=? AND a.status IN ('READY','IN_PROGRESS','REPORTING','NEEDS_REVIEW') ORDER BY a.id`).all(operatorId);
    const events=this.db.prepare("SELECT MAX(rowid) AS revision FROM task_recovery_events WHERE blacklake_operator_id=?").get(operatorId);
    return { operator, ids, bound:bindings.length>0, sessionCount:sessions.length, version:digest({rows:rows.map(r=>({id:r.id,name:r.name,active:r.active,blacklakeOperatorId:r.blacklake_operator_id})),bindings,sessions,codes,active,events}),activeAssignments:active.map(r=>this.present(r)) };
  }
  publicOperator(operatorId) {
    const value=this.operatorContext(operatorId);
    return { blacklakeOperatorId:operatorId,name:value.operator.name,bound:value.bound,activeAssignments:value.activeAssignments,canRecover:!value.activeAssignments.length,version:value.version };
  }
  recoverBinding(operatorId,input,{actor,operationId}) {
    inputShape(input,["expectedVersion","reason","identityConfirmed","confirmedName"]);
    const reason=reasonText(input.reason);
    assert(input.identityConfirmed===true,422,"RECOVERY_IDENTITY_REQUIRED","请先核验人员本人身份并勾选确认。");
    return this.transact(operationId,actor,`recover-binding:${operatorId}`,input,()=>{
      const context=this.operatorContext(operatorId);
      assert(input.expectedVersion===context.version,409,"RECOVERY_VERSION_CHANGED","人员绑定或活动任务已变化，请刷新后重新核验。");
      assert(normalize(input.confirmedName)===normalize(context.operator.name),422,"RECOVERY_IDENTITY_REQUIRED","请输入当前人员完整姓名以确认身份。");
      assert(context.activeAssignments.length===0,409,"OPERATOR_HAS_ACTIVE_ASSIGNMENT","请先处理此人的待开始、进行中或待核对任务，再恢复换绑；不能跳过未知报工结果。");
      const marks=context.ids.map(()=>"?").join(","),expiresAt=new Date(this.now()+600000).toISOString();
      const code=this.response({bindingRecovery:true,expiresAt},actor,operationId).confirmationCode;
      this.db.prepare(`DELETE FROM wechat_bindings WHERE operator_id IN (${marks})`).run(...context.ids);
      this.db.prepare(`DELETE FROM sessions WHERE operator_id IN (${marks})`).run(...context.ids);
      this.db.prepare(`UPDATE operator_binding_codes SET used_at=CURRENT_TIMESTAMP WHERE operator_id IN (${marks}) AND used_at IS NULL`).run(...context.ids);
      this.db.prepare("INSERT INTO operator_binding_codes(id,operator_id,code_hash,expires_at) VALUES (?,?,?,?)").run(randomUUID(),context.operator.id,hashConfirmationCode(context.operator.id,code,this.store.sessionSecret),expiresAt);
      this.event({operatorId,action:"ADMIN_RECOVER_BINDING",actor,reason,before:{bound:context.bound,sessionCount:context.sessionCount},after:{bound:false,sessionCount:0,confirmationCodeIssued:true,expiresAt}});
      return { bindingRecovery:true,blacklakeOperatorId:operatorId,name:context.operator.name,expiresAt };
    });
  }
}

export async function assertDispatchedTaskOpen(blacklake, assignment, { readTask } = {}) {
  assert(assignment.status==="READY",409,"ASSIGNMENT_START_CONFLICT","这笔任务已不在待开始状态，请刷新任务。");
  let task;
  try { task=await (readTask?readTask(assignment.taskId):blacklake.findTaskById(assignment.taskId,{fresh:true})); }
  catch(error) {
    if(error instanceof AppError && ["STATION_PROCESS_NOT_FOUND","TASK_NOT_FOUND","WORK_ORDER_NOT_FOUND","TASK_CLOSED"].includes(error.code)) throw new AppError(409,"DISPATCH_TASK_UNAVAILABLE","黑湖工单或工序已关闭、删除或不可用，请联系组长在后台核实并撤销待开始任务。");
    throw new AppError(503,"DISPATCH_TASK_CHECK_FAILED","暂时无法核验黑湖工序，任务仍保留待开始，请稍后重试。");
  }
  assert(task&&Number(task.taskId)===assignment.taskId&&(!assignment.projectId||Number(task.projectId)===assignment.projectId),409,"DISPATCH_TASK_CHANGED","黑湖工序归属已变化或未能确认，请联系组长核实。");
  assert((task.processStatus!==null&&task.processStatus!==undefined&&String(task.processStatus).trim()!==""&&Number.isFinite(Number(task.processStatus)))||String(task.processStatusDisplay||"").trim(),503,"DISPATCH_TASK_STATE_UNKNOWN","黑湖返回的工序状态未能确认，任务仍保留待开始，请联系组长核实。");
  assert(Number(task.processStatus)!==20&&!/^(已完成|完成|已完工|完工|已结束|已关闭|已取消|已作废)$/.test(String(task.processStatusDisplay||"").trim()),409,"DISPATCH_TASK_UNAVAILABLE","黑湖工序已关闭，请联系组长在后台核实并撤销待开始任务。");
  return task;
}

// Blacklake permits an identical task query once per ten seconds. Share the
// bounded confirmation (and in-flight read) across workers; never use its 60s cache.
export function createDispatchedStartCheck(blacklake, {now=Date.now} = {}) {
  const reads=new Map();
  const readTask=(taskId)=>{
    const at=Number(now());let entry=reads.get(taskId);
    if(!entry||(!entry.pending&&entry.expiresAt<=at)) {
      entry={pending:true,expiresAt:at+10000};
      entry.promise=Promise.resolve().then(()=>blacklake.findTaskById(taskId,{fresh:true})).finally(()=>{entry.pending=false;});
      reads.set(taskId,entry);
      if(reads.size>1000)for(const [key,value]of reads)if(!value.pending&&value.expiresAt<=at)reads.delete(key);
    }
    return entry.promise;
  };
  return async assignment=>{
    try { await assertDispatchedTaskOpen(blacklake,assignment,{readTask}); }
    catch(error) { if(error.code!=="ASSIGNMENT_START_CONFLICT")reads.delete(assignment.taskId);throw error; }
  };
}

export function createTaskRecoveryHandler({store,config,now,quantities}) {
  const recovery=new TaskRecovery(store,{now});
  return async(req,res,url,{jsonBody,send})=>{
    const actor=`ADMIN:${agentOwner(req,config).slice(0,24)}`;
    if(req.method!=="GET") {
      assert(req.headers["sec-fetch-site"]!=="cross-site",403,"RECOVERY_ORIGIN_REJECTED","请从管理后台操作。");
      if(req.headers.origin) { let origin;try{origin=new URL(req.headers.origin);}catch{}assert(origin?.host===req.headers.host,403,"RECOVERY_ORIGIN_REJECTED","请从管理后台操作。"); }
    }
    const root="/v1/admin/task-recovery",id=(raw)=>{let value;try{value=decodeURIComponent(raw);}catch{}assert(/^[\w-]{1,128}$/.test(value||""),400,"RECOVERY_INVALID_ID","编号不正确。");return value;};
    if(req.method==="GET"&&url.pathname===root) return send(res,200,recovery.list({status:url.searchParams.get("status")||"OPEN",category:url.searchParams.get("category")||"ALL",query:url.searchParams.get("q")||"",offset:Number(url.searchParams.get("offset")||0),limit:Number(url.searchParams.get("limit")||50),waitingMinutes:Number(url.searchParams.get("waitingMinutes")||60)}));
    const operation=url.pathname.match(/^\/v1\/admin\/task-recovery\/operations\/([^/]+)$/);
    if(operation&&req.method==="GET")return send(res,200,quantities.currentReceipt(recovery.operation(id(operation[1]),actor)));
    const quantity=url.pathname.match(/^\/v1\/admin\/task-recovery\/assignments\/([^/]+)\/quantity$/);
    if(quantity&&req.method==='POST')return send(res,200,await quantities.submit(id(quantity[1]),await jsonBody(req),{actor,operationId:String(req.headers['idempotency-key']||'')}));
    const assignment=url.pathname.match(/^\/v1\/admin\/task-recovery\/assignments\/([^/]+)(?:\/(finish|correct-time|cancel-ready|void-quantity|confirm-result|missing-result))?$/);
    if(assignment) {
      if(req.method==="GET"&&!assignment[2])return send(res,200,{...recovery.detail(id(assignment[1])),...quantities.detail(id(assignment[1]))});
      if(req.method==="POST"&&assignment[2])return send(res,200,recovery.act(id(assignment[1]),assignment[2],await jsonBody(req),{actor,operationId:String(req.headers["idempotency-key"]||"")}));
    }
    const person=url.pathname.match(/^\/v1\/admin\/task-recovery\/operators\/(\d+)(\/recover-binding)?$/);
    if(person) {
      const operatorId=Number(person[1]);assert(Number.isSafeInteger(operatorId)&&operatorId>0,422,"INVALID_OPERATOR","人员编号不正确。");
      if(req.method==="GET"&&!person[2])return send(res,200,recovery.publicOperator(operatorId));
      if(req.method==="POST"&&person[2])return send(res,200,recovery.recoverBinding(operatorId,await jsonBody(req),{actor,operationId:String(req.headers["idempotency-key"]||"")}));
    }
    throw new AppError(404,"NOT_FOUND","任务处置接口不存在。");
  };
}
