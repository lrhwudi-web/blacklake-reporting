import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/store.mjs";
import { createApp } from "../src/app.mjs";

async function fixture() {
  const config = { sessionSecret: "placement-fixture-secret", sessionDays: 30, reportingModeAdminOperatorIds: [], agent: { enabled: false } };
  const store = new Store(":memory:", config);
  const people = [{ blacklakeOperatorId: 101, name: "测试组长" }, { blacklakeOperatorId: 103, name: "测试甲" },
    { blacklakeOperatorId: 104, name: "测试乙" }, { blacklakeOperatorId: 105, name: "测试丙" }];
  const operators = people.map((person) => store.upsertBlacklakeOperator(person));
  store.setEntryProfile(101, { appRole: "floor8_leader" });
  const tokens = operators.map((operator) => store.createSession(operator.id).token);
  const task = { taskId: 100, projectId: 200, projectCode: "TEST-WO", productName: "测试产品", processName: "测试工序",
    plannedAmount: 100, defaultReportAmount: 100, reportedGoodAmount: 0 };
  const blacklake = { listOperators: async () => people, findWorkOrderProcess: async () => task, listWorkOrderProcesses: async () => [task] };
  const server = createServer(createApp({ config, store, blacklake, wechat: {} }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = async (path, { person = 0, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens[person]}` },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json() };
  };
  const assign = (input = {}, person = 0) => call("/v1/dispatch/assign", { person,
    body: { flowCode: "FLOW-TEST", taskId: 100, blacklakeOperatorIds: [103, 104], ...input } });
  const count = () => store.db.prepare("SELECT COUNT(*) AS n FROM assignments").get().n;
  return { store, operators, call, assign, count, close: async () => { await new Promise((resolve) => server.close(resolve)); store.close(); } };
}

test("总览返回每人完整绑定，正常多人派工自动进入各自工位并保留同批标识", async () => {
  const f = await fixture();
  try {
    f.store.setDispatchUnitRecommendations("A-03", [103]);
    f.store.setDispatchUnitRecommendations("B-02", [104, 105]);
    const overview = await f.call("/v1/dispatch/overview");
    assert.deepEqual(overview.body.employees.find((row) => row.blacklakeOperatorId === 103).boundUnitIds, ["A-03"]);
    assert.deepEqual(overview.body.employees.find((row) => row.blacklakeOperatorId === 104).boundUnitIds, ["B-02"]);
    const result = await f.assign({ placements: [
      { blacklakeOperatorId: 103, unitId: "A-03", source: "binding" },
      { blacklakeOperatorId: 104, unitId: "B-02", source: "binding" }
    ] });
    assert.equal(result.status, 201);
    assert.deepEqual(result.body.assignments.map((row) => row.stationName), ["A-03", "B-02"]);
    assert.equal(result.body.assignments[0].dispatchBatchId, result.body.assignments[1].dispatchBatchId);
    assert.ok(result.body.assignments.every((row) => row.quantityPolicy === "SERVER_DEFAULT" && row.status === "READY"));
    const sameStation = await f.assign({ blacklakeOperatorIds: [105] });
    assert.equal(sameStation.status, 201);
    assert.equal(sameStation.body.assignment.stationName, "B-02");
  } finally { await f.close(); }
});

test("未绑定和多工位不能猜选，明确临时选位不修改常驻绑定", async () => {
  const f = await fixture();
  try {
    f.store.setDispatchUnitRecommendations("A-03", [103]);
    f.store.setDispatchUnitRecommendations("B-02", [103]);
    const before = f.store.dispatchUnitRecommendations();
    const missing = await f.assign();
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error.code, "WORK_UNIT_SELECTION_REQUIRED");
    assert.equal(f.count(), 0);
    const manual = await f.assign({ placements: [
      { blacklakeOperatorId: 103, unitId: "B-02", source: "manual" },
      { blacklakeOperatorId: 104, unitId: "裁床一区", source: "manual" }
    ] });
    assert.equal(manual.status, 201);
    assert.deepEqual(manual.body.assignments.map((row) => row.stationName), ["B-02", "裁床一区"]);
    assert.deepEqual(f.store.dispatchUnitRecommendations(), before);
  } finally { await f.close(); }
});

test("确认前换绑拒绝旧工位，伪造跨楼层、空工位与重复漏人均不产生派单", async () => {
  const f = await fixture();
  try {
    f.store.setDispatchUnitRecommendations("B-02", [103]);
    f.store.setDispatchUnitRecommendations("A-04", [104]);
    const bound = [{ blacklakeOperatorId: 103, unitId: "A-03", source: "binding" }, { blacklakeOperatorId: 104, unitId: "A-04", source: "binding" }];
    const stale = await f.assign({ placements: bound });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "WORK_UNIT_BINDING_CHANGED");
    for (const placements of [
      [{ blacklakeOperatorId: 103, unitId: "3F-01", source: "manual" }, bound[1]],
      [{ blacklakeOperatorId: 103, unitId: "", source: "manual" }, bound[1]],
      [bound[1], bound[1]], [bound[1]],
      [{ blacklakeOperatorId: 999, unitId: "A-03", source: "manual" }, bound[1]],
      [{ blacklakeOperatorId: 103, unitId: "B-02", source: "unknown" }, bound[1]]
    ]) assert.equal((await f.assign({ placements })).status, 422);
    assert.equal((await f.assign({}, 1)).status, 403);
    assert.equal(f.count(), 0);
  } finally { await f.close(); }
});

test("多人跨工位派工中任一人员已忙碌时整批回滚，旧单不被覆盖", async () => {
  const f = await fixture();
  try {
    f.store.setDispatchUnitRecommendations("A-03", [103]);
    f.store.setDispatchUnitRecommendations("B-02", [104]);
    const first = await f.assign({ blacklakeOperatorIds: [104] });
    assert.equal(first.status, 201);
    assert.equal((await f.assign()).status, 409);
    assert.equal(f.count(), 1);
    assert.equal(f.store.activeAssignments(f.operators[1].id).length, 0);
    assert.equal(f.store.activeAssignments(f.operators[2].id)[0].id, first.body.assignment.id);
  } finally { await f.close(); }
});

test("人员工序推荐不再要求先指定工位，同时仍校验角色与人员身份", async () => {
  const f = await fixture();
  try {
    const body = { flowCode: "FLOW-TEST", blacklakeOperatorIds: [103, 104] };
    assert.equal((await f.call("/v1/dispatch/process-recommendations", { body })).status, 200);
    assert.equal((await f.call("/v1/dispatch/process-recommendations", { person: 1, body })).status, 403);
    assert.equal((await f.call("/v1/dispatch/process-recommendations", { body: { ...body, unitId: "3F-01" } })).status, 422);
  } finally { await f.close(); }
});

test("写事务内再次校验自动工位，换绑和新增第二工位均拒绝写入", async () => {
  const f = await fixture();
  try {
    const assignment = { id: "binding-race", operatorId: f.operators[1].id, stationName: "A-03", expectedBoundUnitId: "A-03" };
    f.store.setDispatchUnitRecommendations("B-02", [103]);
    assert.equal(f.store.dispatchAssignments([assignment]), undefined);
    f.store.setDispatchUnitRecommendations("A-03", [103]);
    assert.equal(f.store.dispatchAssignments([assignment]), undefined);
    assert.equal(f.count(), 0);
  } finally { await f.close(); }
});
