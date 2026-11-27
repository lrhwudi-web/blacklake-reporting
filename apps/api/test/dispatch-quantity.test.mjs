import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { createApp } from "../src/app.mjs";
import { unitState } from "../src/dispatch.mjs";

async function fixture() {
  const config = { sessionSecret: "dispatch-quantity-test-secret", adminApiKey: "dispatch-quantity-admin-test-key", sessionDays: 30, reportingModeAdminOperatorIds: [], review: { enabled: true, allowedProjectIds: [999] }, agent: { enabled: false } };
  const store = new Store(":memory:", config);
  const people = [
    { name: "组长测试", blacklakeOperatorId: 101 }, { name: "员工甲", blacklakeOperatorId: 103 }, { name: "员工乙", blacklakeOperatorId: 104 }
  ];
  const operators = people.map((person) => store.upsertBlacklakeOperator(person));
  store.setEntryProfile(101, { appRole: "floor8_leader" });
  const tokens = operators.map((person) => store.createSession(person.id).token);
  const outputs = [];
  const task = { taskId: 100, projectId: 200, projectCode: "TEST-WO", productName: "测试产品", processName: "测试工序", processStatus: 10, plannedAmount: 100, defaultReportAmount: 100, reportedGoodAmount: 0 };
  const blacklake = { listOperators: async () => people, findWorkOrderProcess: async () => task, findTaskById: async () => task,
    createOutput: async (value) => { outputs.push(value); return { id: "output-test-"+outputs.length }; } };
  const server = createServer(createApp({ config, store, blacklake, wechat: {} }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = async (path, { person = 0, method = "GET", body, key, admin = false, token = tokens[person] } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { "Content-Type": "application/json", ...(admin ? { "X-Admin-Key": config.adminApiKey } : { Authorization: `Bearer ${token}` }), ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const assign = () => call("/v1/dispatch/assign", { method: "POST", body: { flowCode: "FLOW-TEST", unitId: "A-03", taskId: 100, blacklakeOperatorIds: [103, 104], quantityPolicy: "PENDING_REVIEW" } });
  return { store, call, assign, task, operators, outputs, close: async () => { await new Promise((resolve) => server.close(resolve)); store.close(); } };
}

test("正常8楼多人分别确认数量并报工，默认数随已报累计扣减",async()=>{
 const f=await fixture();try{
  const rows=(await f.assign()).body.assignments;assert.ok(rows.every(r=>r.quantityPolicy==='SERVER_DEFAULT'));
  for(const [index,row]of rows.entries()){
   const person=index+1;assert.equal((await f.call('/v1/assignments/'+row.id+'/start',{person,method:'POST'})).status,200);
   const defaults=await f.call('/v1/assignments/'+row.id+'/finish-default',{person});assert.equal(defaults.status,200);assert.equal(defaults.body.defaultQuantity,index===0?100:60);
   const body={quantity:index===0?40:60,defectQuantity:0},key='normal_multi_finish_'+index;
   const done=await f.call('/v1/assignments/'+row.id+'/finish',{person,method:'POST',key,body});assert.equal(done.status,201);assert.equal(done.body.assignment.status,'COMPLETED');
   assert.equal((await f.call('/v1/assignments/'+row.id+'/finish',{person,method:'POST',key,body})).body.replayed,true);
   assert.equal((await f.call('/v1/assignments/current',{person})).body.assignment,null);
  }
  assert.equal(f.outputs.length,2);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE status='QUANTITY_PENDING'").get().n,0);
 }finally{await f.close();}
});
test("旧8楼空策略或宽泛待核量标记恢复普通数量流程，客户端策略不能跳过确认",async()=>{
 const f=await fixture();try{
  const rows=(await f.assign()).body.assignments;
  for(const[index,row]of rows.entries()){
   const person=index+1;f.store.db.prepare('UPDATE assignments SET quantity_policy=? WHERE id=?').run(index?'PENDING_REVIEW':'',row.id);f.store.startDispatchedAssignment(row.id,f.operators[person].id,'2026-10-22 09:00:00');
   assert.equal((await f.call('/v1/assignments/current',{person})).body.assignment.quantityPolicy,'SERVER_DEFAULT');assert.equal((await f.call('/v1/assignments/'+row.id+'/finish-default',{person})).status,200);
   assert.equal((await f.call('/v1/assignments/'+row.id+'/finish',{person,method:'POST',key:'blocked_legacy_'+index,body:{quantityPolicy:'PENDING_REVIEW'}})).status,409);
  }
  assert.equal(f.outputs.length,0);
 }finally{await f.close();}
});
test("后台代完工仍待核量、释放人员；历史重放不报产量也不影响下一单",async()=>{
 const f=await fixture();try{
  const row=(await f.assign()).body.assignments[0];f.store.startDispatchedAssignment(row.id,f.operators[1].id,'2026-10-22 09:00:00');
  const detail=await f.call('/v1/admin/task-recovery/assignments/'+row.id,{admin:true});
  const done=await f.call('/v1/admin/task-recovery/assignments/'+row.id+'/finish',{admin:true,method:'POST',key:'admin_pending_quantity_01',body:{expectedVersion:detail.body.assignment.version,reason:'漏结束且数量未确认',actualEndedAt:'2026-10-22 10:00:00'}});
  assert.equal(done.status,200);assert.equal(done.body.assignment.status,'QUANTITY_PENDING');assert.equal(f.store.hasActiveAssignmentForBlacklakeOperator(103),false);
  const replay=await f.call('/v1/assignments/'+row.id+'/finish',{person:1,method:'POST',key:'legacy_pending_replay',body:{quantity:999}});assert.equal(replay.body.replayed,true);assert.equal(f.outputs.length,0);
  assert.equal((await f.call('/v1/assignments/'+row.id+'/finish-default',{person:1})).status,409);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions WHERE action='ADMIN_FINISH_PENDING_QUANTITY'").get().n,1);
 }finally{await f.close();}
});
test("旧明确失败或核实未创建的报工恢复后正常报数量，保留失败证据与原结束时间",async()=>{
 const f=await fixture();try{
  const row=(await f.assign()).body.assignments[0];f.store.startDispatchedAssignment(row.id,f.operators[1].id,'2026-10-22 09:00:00');
  const report={id:'old-failed',idempotencyKey:'old_failed_key',requestHash:'old-failed-hash',operatorId:f.operators[1].id,taskId:100,projectId:200,projectCode:'TEST-WO',productName:'测试产品',processName:'测试工序',amount:100,goodAmount:100,defectAmount:0,defectCode:'',outputTime:'2026-10-22 09:10:00'};
  f.store.prepareAssignmentCompletion({assignmentId:row.id,operatorId:f.operators[1].id,endedAt:report.outputTime,durationSeconds:600,assessment:null,report});f.store.markReportFailed(report.idempotencyKey,'TEST_FAILED','模拟明确失败');f.store.restoreAssignmentAfterFailure(row.id);
  const done=await f.call('/v1/assignments/'+row.id+'/finish',{person:1,method:'POST',key:'normal_after_failure_01',body:{quantity:15,defectQuantity:0}});assert.equal(done.status,201);assert.equal(done.body.assignment.status,'COMPLETED');assert.equal(done.body.assignment.endedAt,report.outputTime);assert.equal(f.store.reportById(report.id).status,'FAILED');assert.equal(f.store.reportById(report.id).amount,100);assert.equal(f.outputs.length,1);
 }finally{await f.close();}
});

test("旧8楼仍关联未决或成功报工时，不能在恢复数量时重复报工", async () => {
  const f = await fixture();
  try {
    const row = (await f.assign()).body.assignments[0];
    f.store.startDispatchedAssignment(row.id, f.operators[1].id, "2026-10-22 09:00:00");
    const report = { id: "legacy-linked-report", idempotencyKey: "legacy_linked_finish", requestHash: "legacy-linked-hash",
      operatorId: f.operators[1].id, taskId: 100, projectId: 200, projectCode: "TEST-WO", productName: "测试产品", processName: "测试工序",
      amount: 100, goodAmount: 100, defectAmount: 0, defectCode: "", outputTime: "2026-10-22 09:10:00" };
    f.store.prepareAssignmentCompletion({ assignmentId: row.id, operatorId: f.operators[1].id,
      endedAt: report.outputTime, durationSeconds: 600, assessment: null, report });
    // Even inconsistent legacy state cannot bypass a linked upstream report.
    f.store.db.prepare("UPDATE assignments SET status='IN_PROGRESS', quantity_policy='' WHERE id=?").run(row.id);
    for (const status of ["PENDING", "UNKNOWN", "SUCCEEDED"]) {
      f.store.db.prepare("UPDATE reports SET status=? WHERE id=?").run(status, report.id);
      const result = await f.call(`/v1/assignments/${row.id}/finish`, { person: 1, method: "POST", key: `linked_guard_${status}`, body: { quantity: 100, defectQuantity: 0 } });
      assert.equal(result.status, 409);
      assert.equal(result.body.error.code, "REPORT_RESULT_UNKNOWN");
      assert.equal(f.store.assignmentById(row.id).status, "IN_PROGRESS");
      assert.equal(f.store.assignmentById(row.id).reportId, report.id);
      assert.equal(f.store.reportById(report.id).status, status);
    }
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions WHERE action='FINISH_PENDING_QUANTITY'").get().n, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reports").get().n, 1);
    assert.equal(f.outputs.length, 0);
  } finally { await f.close(); }
});

test("3楼机器派单保持原报工路径，不进入8楼待核量策略", async () => {
  const f = await fixture();
  try {
    const row = f.store.dispatchAssignment({ id: "floor3-existing", operatorId: f.operators[1].id, ...f.task,
      processName: "外协加工", machineId: "3F-01", embroideryPart: "前幅", quantity: 100,
      publishedAt: "2026-10-22 09:00:00", flowCodeHash: "test" });
    await f.call(`/v1/assignments/${row.id}/start`, { person: 1, method: "POST" });
    const result = await f.call(`/v1/assignments/${row.id}/finish`, { person: 1, method: "POST", key: "floor3_original_finish", body: { quantity: 100, defectQuantity: 0 } });
    assert.equal(result.status, 201);
    assert.equal(result.body.assignment.status, "COMPLETED");
    assert.equal(f.outputs.length, 1);
  } finally { await f.close(); }
});

test("旧库增列迁移保留历史数量，完工待核量重启后不占用且不会恢复成报工", () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-quantity-restart-"));
  const databasePath = join(directory, "reporting.sqlite");
  const config = { sessionSecret: "dispatch-quantity-restart-test-secret", sessionDays: 30 };
  let store;
  try {
    store = new Store(databasePath, config);
    const person = store.upsertBlacklakeOperator({ name: "迁移员工", blacklakeOperatorId: 8101 });
    const old = { id: "legacy-completed", operatorId: person.id, taskId: 100, projectId: 200, projectCode: "TEST-WO",
      productName: "测试产品", processName: "测试工序", stationName: "A-03", quantity: 40,
      publishedAt: "2026-10-22 09:00:00", flowCodeHash: "test" };
    store.dispatchAssignment(old);
    store.db.prepare("UPDATE assignments SET status='COMPLETED', good_quantity=40 WHERE id=?").run(old.id);
    store.dispatchAssignment({ ...old, id: "legacy-in-progress", quantity: 100 });
    store.startDispatchedAssignment("legacy-in-progress", person.id, "2026-10-22 09:01:00");
    // Recreate the exact pre-change schema for the two additive metadata columns.
    store.db.exec("ALTER TABLE assignments DROP COLUMN quantity_policy; ALTER TABLE assignments DROP COLUMN dispatch_batch_id;");
    store.close();
    store = new Store(databasePath, config);
    assert.equal(store.assignmentById(old.id).quantity, 40);
    assert.equal(store.assignmentById(old.id).goodQuantity, 40);
    assert.equal(store.assignmentById(old.id).quantityPolicy, "SERVER_DEFAULT");
    assert.equal(store.db.prepare("SELECT quantity_policy FROM assignments WHERE id=?").get(old.id).quantity_policy, "", "旧库存储原值不被改写，正常状态采用新有效口径");
    assert.equal(store.assignmentById("legacy-in-progress").dispatchBatchId, "");
    const pending = store.finishAssignmentPendingQuantity({ assignmentId: "legacy-in-progress", operatorId: person.id,
      endedAt: "2026-10-22 09:02:00", durationSeconds: 60, actor: "WORKER:8101:迁移员工" });
    assert.equal(pending.status, "QUANTITY_PENDING");
    store.close();
    store = new Store(databasePath, config);
    store.recoverInterruptedReports();
    store.recoverInterruptedReports();
    const restored = store.assignmentById(pending.id);
    assert.equal(restored.status, "QUANTITY_PENDING");
    assert.equal(restored.quantityPolicy, "PENDING_REVIEW");
    assert.equal(restored.endedAt, pending.endedAt);
    assert.equal(restored.durationSeconds, 60);
    assert.equal(restored.dispatchBatchId, "");
    assert.equal(restored.reportId, null);
    assert.deepEqual(store.activeAssignments(person.id), []);
    assert.deepEqual(store.activeAssignmentsByUnit("A-03"), []);
    assert.equal(store.hasActiveAssignmentForBlacklakeOperator(8101), false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM reports").get().n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions WHERE action='FINISH_PENDING_QUANTITY'").get().n, 1);
    assert.equal(store.resolveUnknownAsConfirmed(pending.id, "must-not-apply"), undefined);
    assert.equal(store.resolveUnknownAsNotCreated(pending.id), undefined);
    assert.equal(store.assignmentById(pending.id).status, "QUANTITY_PENDING");
    assert.equal(store.assignmentById(old.id).quantity, 40);
    assert.ok(store.dispatchAssignment({ ...old, id: "next-after-restart" }));
    assert.equal(store.startDispatchedAssignment("next-after-restart", person.id, "2026-10-23 09:00:00").status, "IN_PROGRESS");
    assert.equal(store.currentAssignment(person.id).id, "next-after-restart");
    assert.equal(store.assignmentById(pending.id).status, "QUANTITY_PENDING");
  } finally {
    store?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("报工提交中或上游结果未知仍占用人员，不能被待核量释放策略绕过", async () => {
  const f = await fixture();
  try {
    const rows = (await f.assign()).body.assignments;
    for (const [index, row] of rows.entries()) {
      const person = index + 1;
      f.store.startDispatchedAssignment(row.id, f.operators[person].id, "2026-10-22 09:00:00");
      const report = { id: `unresolved-report-${index}`, idempotencyKey: `unresolved_finish_${index}`, requestHash: `unresolved-hash-${index}`,
        operatorId: f.operators[person].id, taskId: 100, projectId: 200, projectCode: "TEST-WO", productName: "测试产品", processName: "测试工序",
        amount: 100, goodAmount: 100, defectAmount: 0, defectCode: "", outputTime: "2026-10-22 09:10:00" };
      assert.equal(f.store.prepareAssignmentCompletion({ assignmentId: row.id, operatorId: f.operators[person].id,
        endedAt: report.outputTime, durationSeconds: 600, assessment: null, report }), true);
      if (index === 1) {
        f.store.markReportUnknown(report.idempotencyKey, "BLACKLAKE_TIMEOUT", "结果未知");
        f.store.reviewAssignment(row.id);
      }
      const current = await f.call("/v1/assignments/current", { person });
      assert.equal(current.body.assignment.status, index === 0 ? "REPORTING" : "NEEDS_REVIEW");
      assert.equal(f.store.hasActiveAssignmentForBlacklakeOperator(index === 0 ? 103 : 104), true);
      const replay = await f.call(`/v1/assignments/${row.id}/finish`, { person, method: "POST", key: `pending_cannot_clear_unknown_${index}`, body: { quantity: 100 } });
      assert.equal(replay.status, 409);
    }
    assert.equal((await f.assign()).status, 409);
    const overview = await f.call("/v1/dispatch/overview");
    assert.equal(overview.body.units.find((item) => item.id === "A-03").state, "attention");
    assert.ok(overview.body.employees.every((item) => !item.available));
    assert.equal(f.outputs.length, 0);
  } finally { await f.close(); }
});
