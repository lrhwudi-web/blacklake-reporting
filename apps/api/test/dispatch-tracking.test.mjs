import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/store.mjs";
import { createApp } from "../src/app.mjs";

function shanghaiDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
async function fixture() {
  const config = { sessionSecret: "dispatch-tracking-test-secret", adminApiKey: "dispatch-tracking-admin-key", sessionDays: 30, reportingModeAdminOperatorIds: [], review: { enabled: true, allowedProjectIds: [200] }, agent: { enabled: false } };
  const store = new Store(":memory:", config);
  const leader = store.upsertBlacklakeOperator({ name: "组长测试", blacklakeOperatorId: 101 });
  const supervisor = store.upsertBlacklakeOperator({ name: "主管测试", blacklakeOperatorId: 102 });
  const employee = store.upsertBlacklakeOperator({ name: "员工测试", blacklakeOperatorId: 103 });
  store.setEntryProfile(101, { appRole: "floor8_leader" });
  store.setEntryProfile(102, { appRole: "floor3_supervisor" });
  const tokens = { leader: store.createSession(leader.id), supervisor: store.createSession(supervisor.id), employee: store.createSession(employee.id), review: store.createSession(leader.id, { scope: "review" }) };
  const server = createServer(createApp({ config, store, blacklake: {}, wechat: {} }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let next = 1000;
  const seed = ({ id, unit = "A-03", date = shanghaiDate(), status = "READY", mode = "DISPATCHED" } = {}) => {
    const worker = store.upsertBlacklakeOperator({ name: `测试员工${++next}`, blacklakeOperatorId: next });
    const assignment = store.dispatchAssignment({ id: id || `assignment-${next}`, operatorId: worker.id, taskId: 100, projectId: 200,
      projectCode: "TEST-WO", productName: "测试产品", processName: "测试工序", quantity: 100,
      stationName: unit.startsWith("3F-") ? "" : unit, machineId: unit.startsWith("3F-") ? unit : "",
      publishedBy: unit.startsWith("3F-") ? supervisor.name : leader.name, publishedByOperatorId: unit.startsWith("3F-") ? 102 : 101, publishedAt: `${date} 12:00:00`, flowCodeHash: "test-flow" });
    assert(assignment);
    store.db.prepare("UPDATE assignments SET status = ?, assignment_mode = ? WHERE id = ?").run(status, mode, assignment.id);
    return store.assignmentById(assignment.id);
  };
  const call = async (path, { role = "leader", method = "GET", body, key } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: {
      "Content-Type": "application/json", ...(role === "admin" ? { "X-Admin-Key": config.adminApiKey } : role ? { Authorization: `Bearer ${tokens[role].token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { store, seed, call, tokens, close: async () => { await new Promise((resolve) => server.close(resolve)); store.close(); } };
}

test("今日派单记录按上海日期与本楼层过滤，明确截断且未完成不冒充实际量", async () => {
  const f = await fixture();
  try {
    f.seed({ id: "a-ready" });
    const done = f.seed({ id: "b-completed", status: "COMPLETED" });
    f.store.db.prepare("UPDATE assignments SET good_quantity = 40, defect_quantity = 3 WHERE id = ?").run(done.id);
    f.seed({ id: "c-review", status: "NEEDS_REVIEW" });
    f.seed({ id: "old", date: "2000-01-01" });
    f.seed({ id: "other-floor", unit: "3F-01" });
    f.seed({ id: "self-scan", mode: "SELF_SCAN" });
    const all = await f.call("/v1/dispatch/history");
    assert.equal(all.status, 200);
    assert.equal(all.body.date, shanghaiDate());
    assert.equal(all.body.timezone, "Asia/Shanghai");
    assert.equal(all.body.total, 3);
    assert.equal(all.body.truncated, false);
    assert.deepEqual(all.body.assignments.map((item) => item.id), ["c-review", "b-completed", "a-ready"]);
    assert.equal(all.body.assignments.find((item) => item.id === done.id).actualQuantity, 43);
    const ready = all.body.assignments.find((item) => item.id === "a-ready");
    assert.equal(ready.actualQuantity, null);
    assert.equal(ready.canCancel, true);
    assert.equal(ready.unitId, "A-03");
    assert.equal("operatorPhoneLast4" in ready, false);
    const limited = await f.call("/v1/dispatch/history?limit=2");
    assert.equal(limited.body.assignments.length, 2);
    assert.equal(limited.body.limit, 2);
    assert.equal(limited.body.total, 3);
    assert.equal(limited.body.truncated, true);
    const floor3 = await f.call("/v1/dispatch/history", { role: "supervisor" });
    assert.deepEqual(floor3.body.assignments.map((item) => item.id), ["other-floor"]);
    assert.equal((await f.call("/v1/dispatch/history?limit=201")).status, 422);
  } finally { await f.close(); }
});

test("派单记录与撤销拒绝员工及审核会话，跨楼层任务先鉴权再返回状态", async () => {
  const f = await fixture();
  try {
    const own = f.seed();
    const other = f.seed({ unit: "3F-01", status: "IN_PROGRESS" });
    for (const role of ["employee", "review"]) {
      assert.equal((await f.call("/v1/dispatch/history", { role })).status, 403);
      assert.equal((await f.call(`/v1/dispatch/assignments/${own.id}/cancel`, { role, method: "POST", body: { reason: "误派" } })).status, 403);
    }
    assert.equal((await f.call("/v1/dispatch/history", { role: null })).status, 401);
    const denied = await f.call(`/v1/dispatch/assignments/${other.id}/cancel`, { method: "POST", body: { reason: "误派" } });
    assert.equal(denied.status, 404);
    assert.equal(f.store.assignmentById(other.id).status, "IN_PROGRESS");
    assert.equal(f.store.assignmentById(own.id).status, "READY");
  } finally { await f.close(); }
});

test("持续跟踪包括往日占用任务和已释放的待核量，排除往日已完成与其他楼层", async () => {
  const f = await fixture();
  try {
    f.seed({ id: "today-completed", status: "COMPLETED" });
    for (const status of ["READY", "IN_PROGRESS", "REPORTING", "NEEDS_REVIEW", "QUANTITY_PENDING"]) {
      f.seed({ id: `old-${status}`, date: "2000-01-01", status });
    }
    f.seed({ id: "old-completed", date: "2000-01-01", status: "COMPLETED" });
    f.seed({ id: "old-cancelled", date: "2000-01-01", status: "CANCELLED" });
    f.seed({ id: "old-other-floor", date: "2000-01-01", status: "QUANTITY_PENDING", unit: "3F-01" });
    const result = await f.call("/v1/dispatch/history?includeActive=true");
    assert.equal(result.status, 200);
    assert.equal(result.body.scope, "today-and-open");
    assert.match(result.body.scopeDescription, /跨日完工待核量.*不占用人员或工位/);
    assert.equal(result.body.total, 6);
    assert.deepEqual(result.body.assignments.map(item => item.id).sort(), ["today-completed", "old-READY", "old-IN_PROGRESS", "old-REPORTING", "old-NEEDS_REVIEW", "old-QUANTITY_PENDING"].sort());
    assert.equal(result.body.assignments.find(item => item.status === "QUANTITY_PENDING").actualQuantity, null);
    assert.equal(result.body.assignments.find(item => item.status === "QUANTITY_PENDING").canCancel, false);
    const limited = await f.call("/v1/dispatch/history?includeActive=true&limit=2");
    assert.equal(limited.body.total, 6);
    assert.equal(limited.body.limit, 2);
    assert.equal(limited.body.truncated, true);
    const today = await f.call("/v1/dispatch/history?includeActive=false");
    assert.equal(today.body.scope, "today");
    assert.deepEqual(today.body.assignments.map(item => item.id), ["today-completed"]);
    assert.equal((await f.call("/v1/dispatch/history?includeActive=anything")).status, 422);
  } finally { await f.close(); }
});

test("撤销待开始派单无需填写原因，持久化真实操作人且释放任务", async () => {
  const f = await fixture();
  try {
    const assignment = f.seed();
    const path = `/v1/dispatch/assignments/${assignment.id}/cancel`;
    assert.equal((await f.call(path, { method: "POST", body: { reason: "\u0001" } })).status, 422);
    const result = await f.call(path, { method: "POST", body: { actor: "伪造操作人" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.assignment.status, "CANCELLED");
    assert.equal(result.body.assignment.canCancel, false);
    assert.equal(result.body.assignment.startedAt, null);
    assert.equal(result.body.assignment.actualQuantity, null);
    assert.equal(f.store.activeAssignments(assignment.operatorId).length, 0);
    const actions = f.store.db.prepare("SELECT * FROM assignment_actions WHERE assignment_id = ?").all(assignment.id);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].reason, "");
    assert.equal(actions[0].actor, "DISPATCHER:101:组长测试");
    assert.equal((await f.call(path, { method: "POST", body: { reason: "重复点击" } })).status, 409);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions WHERE assignment_id = ?").get(assignment.id).n, 1);
  } finally { await f.close(); }
});

test("已开始、提交中、待核对及已完成任务均不能通过派单撤销", async () => {
  const f = await fixture();
  try {
    for (const status of ["IN_PROGRESS", "REPORTING", "NEEDS_REVIEW", "COMPLETED"]) {
      const assignment = f.seed({ status });
      const result = await f.call(`/v1/dispatch/assignments/${assignment.id}/cancel`, { method: "POST", body: { reason: "误派" } });
      assert.equal(result.status, 409);
      assert.equal(f.store.assignmentById(assignment.id).status, status);
    }
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions").get().n, 0);
  } finally { await f.close(); }
});

test("员工抢先开始与撤销竞争时，READY比较更新不覆盖进行中状态", async () => {
  const f = await fixture();
  try {
    const assignment = f.seed();
    const original = f.store.cancelDispatchedAssignment.bind(f.store);
    f.store.cancelDispatchedAssignment = (input) => {
      assert(f.store.startDispatchedAssignment(assignment.id, assignment.operatorId, `${shanghaiDate()} 13:00:00`));
      return original(input);
    };
    const result = await f.call(`/v1/dispatch/assignments/${assignment.id}/cancel`, { method: "POST", body: { reason: "误派" } });
    assert.equal(result.status, 409);
    assert.equal(f.store.assignmentById(assignment.id).status, "IN_PROGRESS");
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions WHERE action='CANCEL'").get().n, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions WHERE action='EMPLOYEE_START'").get().n, 1);
  } finally { await f.close(); }
});

test("撤销审计记录失败时事务回滚，不产生没有操作依据的已撤销任务", async () => {
  const f = await fixture();
  try {
    const assignment = f.seed();
    f.store.db.exec("CREATE TRIGGER reject_cancel_audit BEFORE INSERT ON assignment_actions BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END;");
    assert.throws(() => f.store.cancelDispatchedAssignment({ id: assignment.id, unitIds: ["A-03"], reason: "误派", endedAt: `${shanghaiDate()} 13:00:00`, actor: "DISPATCHER:101:组长测试", publishedByOperatorId: 101 }), /test audit unavailable/);
    assert.equal(f.store.assignmentById(assignment.id).status, "READY");
    assert.equal(f.store.assignmentById(assignment.id).cancellationReason, null);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions").get().n, 0);
  } finally { await f.close(); }
});

test("待核量派单持续出现在今日记录中，不展示实际量且不能按未开始任务撤销", async () => {
  const f = await fixture();
  try {
    const assignment = f.seed({ status: "QUANTITY_PENDING" });
    const history = await f.call("/v1/dispatch/history");
    assert.equal(history.status, 200);
    assert.equal(history.body.assignments[0].id, assignment.id);
    assert.equal(history.body.assignments[0].status, "QUANTITY_PENDING");
    assert.equal(history.body.assignments[0].actualQuantity, null);
    assert.equal(history.body.assignments[0].canCancel, false);
    assert.deepEqual(f.store.activeAssignments(assignment.operatorId), []);
    assert.deepEqual(f.store.activeAssignmentsByUnit("A-03"), []);
    const cancellation = await f.call(`/v1/dispatch/assignments/${assignment.id}/cancel`, { method: "POST", body: { reason: "误派" } });
    assert.equal(cancellation.status, 409);
    assert.equal(f.store.assignmentById(assignment.id).status, "QUANTITY_PENDING");
  } finally { await f.close(); }
});

test("新派单撤销及待核量操作的真实 actor 可从审计选项精确筛选", async () => {
  const f = await fixture();
  try {
    const cancelled = f.seed();
    assert.equal((await f.call(`/v1/dispatch/assignments/${cancelled.id}/cancel`, { method: "POST", body: { reason: "选错员工" } })).status, 200);
    const finished = f.seed({ status: "IN_PROGRESS" });
    f.store.db.prepare("UPDATE assignments SET started_at = ? WHERE id = ?").run(new Date(Date.now() + 8 * 3600000 - 3600000).toISOString().slice(0, 19).replace('T',' '), finished.id);
    const detail = await f.call(`/v1/admin/task-recovery/assignments/${finished.id}`, { role: "admin" });
    const actualEndedAt = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
    assert.equal((await f.call(`/v1/admin/task-recovery/assignments/${finished.id}/finish`, { role: "admin", method: "POST", key: "audit_finish_pending_001", body: {
      expectedVersion: detail.body.assignment.version, actualEndedAt, reason: "员工漏结束，数量待确认"
    } })).status, 200);
    const all = await f.call("/v1/admin/audit", { role: "admin" });
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 2);
    assert.ok(all.body.facets.actors.some(actor => actor === "DISPATCHER:101:组长测试"));
    assert.ok(all.body.facets.actors.some(actor => actor.startsWith("ADMIN:")));
    for (const actor of all.body.facets.actors) {
      const filtered = await f.call(`/v1/admin/audit?actor=${encodeURIComponent(actor)}`, { role: "admin" });
      assert.equal(filtered.status, 200);
      assert.equal(filtered.body.total, 1);
      assert.equal(filtered.body.events[0].actor, actor);
      assert.equal(filtered.body.events[0].assignmentId, actor.startsWith("ADMIN:") ? finished.id : cancelled.id);
    }
    for (const actor of ["bad\nactor", "bad\u007factor", "a".repeat(201)]) {
      const response = await f.call(`/v1/admin/audit?actor=${encodeURIComponent(actor)}`, { role: "admin" });
      assert.equal(response.status, 422);
      assert.equal(response.body.error.code, "INVALID_AUDIT_ACTOR");
    }
  } finally { await f.close(); }
});
