import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { createApp } from "../src/app.mjs";
import { compileDispatchPredictionRules, predictDispatch, predictProcessForEmployees } from "../src/dispatch-prediction.mjs";

const analysis = { generatedAt: "2026-08-24T12:00:00Z", summary: { recordCount: 500,
  period: { from: "2026-01-01T00:00:00Z", to: "2026-08-24T00:00:00Z" } }, staffProfiles: [
  { staff: "测试甲", dominantProcess: "P-1", reportCount: 100, workOrderCount: 10, dominantShare: .95 },
  { staff: "测试乙", dominantProcess: "P-1", reportCount: 80, workOrderCount: 8, dominantShare: .85 },
  { staff: "测试丙", dominantProcess: "P-2", reportCount: 30, workOrderCount: 4, dominantShare: .7 }
] };
const rules = compileDispatchPredictionRules(analysis);
const processes = [1, 2].map((number) => ({ taskId: number, projectId: 200, projectCode: "TEST-WO", processCode: `P-${number}`,
  processName: `测试工序${number}`, productName: "测试产品", plannedAmount: 100, defaultReportAmount: 100 }));
const staff = [103, 104, 105].map((id, index) => ({ blacklakeOperatorId: id, name: ["测试甲", "测试乙", "测试丙"][index],
  groupNames: ["测试生产组"], boundUnitIds: [`A-0${index + 1}`], available: true }));

test("人员先由组长指定，只判断所选人员工序；缺工位不影响预测，分歧或无历史不猜",()=>{
  const predict=(ids,employees=staff)=>predictProcessForEmployees({rules,employees,processes,selectedEmployeeIds:ids});
  assert.equal(predict([103,104]).taskId,1);
  assert.deepEqual(predict([105]).employees.map(p=>p.blacklakeOperatorId),[105]);assert.equal(predict([105]).taskId,2);
  assert.equal(predict([103],[{...staff[0],boundUnitIds:[]}]).taskId,1);
  assert.equal(predict([103,105]).taskId,null);
  assert.equal(predict([103,999],[...staff,{blacklakeOperatorId:999,name:'无历史',available:true}]).taskId,null);
  assert.equal(predict([103],[...staff,{...staff[0],blacklakeOperatorId:999}]).taskId,null);
});

test("工序预测接口验证已选人员，保持人工名单，反馈只比较工序与工位",async()=>{
  const f=await fixture();try{
    assert.equal((await f.predict({blacklakeOperatorIds:[]})).status,422);
    assert.equal((await f.predict({blacklakeOperatorIds:[106]})).status,409);
    const p=(await f.predict({blacklakeOperatorIds:[104]})).body.prediction;
    assert.equal(p.mode,'PERSON_FIRST');assert.deepEqual(p.employees.map(p=>p.blacklakeOperatorId),[104]);assert.equal(p.taskId,1);
    const payload=f.bodyFor(p);
    assert.equal((await f.assign({...payload,blacklakeOperatorIds:[103],placements:[{blacklakeOperatorId:103,unitId:'A-01',source:'binding'}]})).status,409);
    assert.equal((await f.assign({...payload,taskId:2})).status,201);
    const row=f.store.predictions.listFeedback().records[0];assert.deepEqual(row.changedFields,['PROCESS']);assert.equal(row.outcome,'ADJUSTED');
  }finally{await f.close();}
});

async function fixture({ persistent = false, predictionRules = rules } = {}) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), "dispatch-prediction-")) : null;
  const dbPath = directory ? join(directory, "reporting.sqlite") : ":memory:";
  const config = { sessionSecret: "dispatch-prediction-test-secret", adminApiKey: "dispatch-prediction-test-admin",
    sessionDays: 30, reportingModeAdminOperatorIds: [], agent: { enabled: false } };
  const store = new Store(dbPath, config);
  const people = [{ blacklakeOperatorId: 101, name: "测试组长" }, { blacklakeOperatorId: 102, name: "另一组长" }, ...staff,
    { blacklakeOperatorId: 106, name: "绣花测试", groupNames: ["绣花部"] }];
  const tokens = new Map();
  for (const person of people) {
    const operator = store.upsertBlacklakeOperator(person);
    tokens.set(person.blacklakeOperatorId, store.createSession(operator.id).token);
  }
  store.setEntryProfile(101, { appRole: "floor8_leader" });
  store.setEntryProfile(102, { appRole: "floor8_leader" });
  for (const person of staff) store.setDispatchUnitRecommendations(person.boundUnitIds[0], [person.blacklakeOperatorId]);
  let taskReads = 0;
  const blacklake = { listOperators: async () => people,
    listWorkOrderProcesses: async () => processes,
    findWorkOrderProcess: async (flow, id) => { taskReads++; return processes.find((row) => row.taskId === Number(id)); } };
  const server = createServer(createApp({ config, store, blacklake, wechat: {}, dispatchPredictionRules: predictionRules }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = async (path, { person = 101, method = "GET", body, admin = false } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { "Content-Type": "application/json", ...(admin ? { "X-Admin-Key": config.adminApiKey } : person ? { Authorization: `Bearer ${tokens.get(person)}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const predict = (input = {}, person = 101) => call("/v1/dispatch/prediction", { person, method: "POST", body: { flowCode: "FLOW-TEST", ...input } });
  const bodyFor = (prediction) => ({ flowCode: "FLOW-TEST", taskId: prediction.taskId, predictionId: prediction.id,
    blacklakeOperatorIds: prediction.employees.map((person) => person.blacklakeOperatorId),
    placements: prediction.employees.map((person) => ({ blacklakeOperatorId: person.blacklakeOperatorId, unitId: person.unitId, source: "binding" })) });
  const assign = (body, person = 101) => call("/v1/dispatch/assign", { method: "POST", body, person });
  let closed = false;
  return { store, config, dbPath, directory, people, call, predict, assign, bodyFor, getTaskReads: () => taskReads,
    close: async () => { if (!closed) { closed = true; await new Promise((resolve) => server.close(resolve)); store.close(); } } };
}

test("历史强/中等依据只对当前唯一工序预选，初始并列时不猜工序", () => {
  const prediction = predictDispatch({ rules, processes, employees: staff });
  assert.equal(prediction.taskId, 1);
  assert.deepEqual(prediction.employees.map((row) => row.blacklakeOperatorId), [103, 104]);
  assert.equal(prediction.source.sourceRecordCount, 500);
  const chosen = predictDispatch({ rules, processes, employees: staff, taskId: 2 });
  assert.equal(chosen.employees[0].tier, "SUGGESTED");
  const tied = predictDispatch({ rules, processes, employees: [staff[0], staff[2]] });
  assert.equal(tied.taskId, null);
  assert.deepEqual(tied.employees, []);
});

test("忙碌、同名、工序编码重复、未绑/多绑、禁用或弱依据均不自动勾人", () => {
  const cases = [
    { employees: [{ ...staff[0], available: false }] },
    { employees: [{ ...staff[0], identityAmbiguous: true }] },
    { employees: [staff[0], { ...staff[0], blacklakeOperatorId: 999 }] },
    { processes: [processes[0], { ...processes[0], taskId: 9 }] },
    { employees: [{ ...staff[0], boundUnitIds: [] }] },
    { employees: [{ ...staff[0], boundUnitIds: ["A-01", "A-02"] }] },
    { rules: compileDispatchPredictionRules({ ...analysis, staffProfiles: [{ ...analysis.staffProfiles[0], enabled: false }] }) },
    { rules: compileDispatchPredictionRules({ ...analysis, staffProfiles: [{ ...analysis.staffProfiles[0], dominantShare: .59 }] }) },
    { rules: compileDispatchPredictionRules({ ...analysis, summary: {} }) }
  ];
  for (const change of cases) assert.deepEqual(predictDispatch({ rules, employees: [staff[0]], processes: [processes[0]], ...change }).employees, []);
});

test("预测只能由组长创建，服务器快照不接受客户端伪造选择与证据", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.predict({}, 103)).status, 403);
    const result = await f.predict({ employees: [{ blacklakeOperatorId: 999 }], source: { version: "forged" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.prediction.source.version, rules.version);
    assert.deepEqual(result.body.prediction.employees.map((row) => row.blacklakeOperatorId), [103, 104]);
    assert.equal((await f.predict({ taskId: 99 })).status, 422);
  } finally { await f.close(); }
});

test("直接采纳与派工同事务持久化，重复回执不再次写入或读取已关闭工序", async () => {
  const f = await fixture({ persistent: true });
  try {
    const prediction = (await f.predict()).body.prediction;
    const body = f.bodyFor(prediction);
    const assigned = await f.assign(body);
    assert.equal(assigned.status, 201);
    const reads = f.getTaskReads();
    const replay = await f.assign(body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(f.getTaskReads(), reads);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignments").get().n, 2);
    assert.equal(f.store.predictions.listFeedback().records[0].outcome, "ADOPTED");
    assert.equal((await f.assign({ ...body, blacklakeOperatorIds: [103], placements: [body.placements[0]] })).status, 409);
    await f.close();
    const reopened = new Store(f.dbPath, f.config);
    try { assert.equal(reopened.predictions.listFeedback().records[0].outcome, "ADOPTED"); }
    finally { reopened.close(); }
  } finally {
    await f.close();
    for (const name of ["reporting.sqlite", "reporting.sqlite-wal", "reporting.sqlite-shm"]) {
      const file = join(f.directory, name); if (existsSync(file)) unlinkSync(file);
    }
    rmdirSync(f.directory);
  }
});

test("人工改工序后仍对照初始预测，后台保留后续建议、实际名单、原因与版本", async () => {
  const f = await fixture();
  try {
    const initial = (await f.predict()).body.prediction;
    const next = (await f.predict({ taskId: 2, initialPredictionId: initial.id })).body.prediction;
    const body = { ...f.bodyFor(next), predictionId: initial.id, appliedPredictionId: next.id,
      predictionAdjustmentReason: "现场临时调整 <需核查>" };
    const assigned = await f.assign(body);
    assert.equal(assigned.status, 201);
    const feedback = await f.call("/v1/admin/dispatch-predictions?outcome=ADJUSTED", { admin: true });
    assert.equal(feedback.status, 200);
    const record = feedback.body.records[0];
    assert.equal(record.prediction.taskId, 1);
    assert.equal(record.finalSelection.taskId, 2);
    assert.equal(record.finalSelection.appliedPrediction.id, next.id);
    assert.equal(record.reason, "现场临时调整 <需核查>");
    assert.deepEqual(record.changedFields, ["PROCESS", "EMPLOYEES"]);
    assert.equal(record.prediction.source.version, rules.version);
    assert.equal((await f.call("/v1/admin/dispatch-predictions", { person: null })).status, 401);
    assert.equal((await f.call("/v1/admin/dispatch-predictions?outcome=WRONG", { admin: true })).status, 422);
  } finally { await f.close(); }
});

test("预测所有权、工单、期限均重验；任一员工忙碌不会写半批或反馈", async () => {
  const f = await fixture();
  try {
    const prediction = (await f.predict()).body.prediction;
    const body = f.bodyFor(prediction);
    assert.equal((await f.assign(body, 102)).status, 403);
    assert.equal((await f.assign({ ...body, flowCode: "OTHER-FLOW" })).status, 409);
    f.store.db.prepare("UPDATE dispatch_predictions SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(prediction.id);
    assert.equal((await f.assign(body)).status, 409);
    const fresh = (await f.predict()).body.prediction;
    const other = (await f.predict({}, 102)).body.prediction;
    assert.equal((await f.assign(f.bodyFor(other), 102)).status, 201);
    assert.equal((await f.assign(f.bodyFor(fresh))).status, 409);
    assert.equal(f.store.predictions.feedback(fresh.id), null);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM assignments").get().n, 2);
    assert.equal(f.store.predictions.listFeedback().total, 1);
  } finally { await f.close(); }
});

test("无历史建议也可手动派工，记录为无初始建议而不是预测错误", async () => {
  const f = await fixture({ predictionRules: compileDispatchPredictionRules() });
  try {
    const prediction = (await f.predict()).body.prediction;
    assert.equal(prediction.taskId, null);
    assert.deepEqual(prediction.employees, []);
    assert.equal((await f.assign({ ...f.bodyFor(prediction), taskId: 1, blacklakeOperatorIds: [103],
      placements: [{ blacklakeOperatorId: 103, unitId: "A-01", source: "binding" }] })).status, 201);
    assert.equal(f.store.predictions.listFeedback().records[0].outcome, "NO_SUGGESTION");
  } finally { await f.close(); }
});

test("扫码首页工位维护受角色与并发保护，多人绑定保存并记录真实操作人", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("/v1/dispatch/stations", { person: 103 })).status, 403);
    const path = "/v1/dispatch/stations/A-01";
    const update = (body, person = 101) => f.call(path, { method: "PATCH", body, person });
    const result = await update({ blacklakeOperatorIds: [103, 104], expectedOperatorIds: [103] });
    assert.equal(result.status, 200);
    assert.equal((await update({ blacklakeOperatorIds: [], expectedOperatorIds: [103] })).status, 409);
    assert.equal((await update({ blacklakeOperatorIds: [106], expectedOperatorIds: [103, 104] })).status, 409);
    assert.equal((await f.call("/v1/dispatch/stations/3F-01", { method: "PATCH", body: { blacklakeOperatorIds: [], expectedOperatorIds: [] } })).status, 422);
    assert.equal((await update({ blacklakeOperatorIds: [], expectedOperatorIds: [103, 104] }, 103)).status, 403);
    const event = f.store.db.prepare("SELECT * FROM dispatch_station_binding_events").get();
    assert.match(event.actor, /^leader:101:/);
    assert.deepEqual(JSON.parse(event.previous_json), [103]);
    assert.deepEqual(JSON.parse(event.next_json), [103, 104]);
    const overview = await f.call("/v1/dispatch/overview");
    assert.deepEqual(overview.body.employees.find((row) => row.blacklakeOperatorId === 104).boundUnitIds, ["A-01", "A-02"]);
    assert.equal(overview.body.employees.some((row) => row.blacklakeOperatorId === 106), false);
  } finally { await f.close(); }
});
