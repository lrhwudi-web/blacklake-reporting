import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { BlacklakeClient } from "../src/blacklake-client.mjs";
import { WechatClient } from "../src/wechat-client.mjs";
import { createApp } from "../src/app.mjs";
import { AppError } from "../src/errors.mjs";
import { AdminSync } from "../src/admin-sync.mjs";
import { loadDefectReasons } from "../src/defect-reasons.mjs";

test("正式配置的图案不符可供质检选择，校验并保留真实编号与名称，生成对应黑湖不良项", async () => {
  const reasons = await loadDefectReasons(new URL("../../../data/analysis/defect-reasons.json", import.meta.url));
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake, undefined, {}, undefined, reasons);
  try {
    const auth = await login(server);
    server.store.setQualityProfile(31001, 'quality', 0, 'TEST');
    const started = await startProcess(server, auth, 880102);
    const id = started.body.assignment.id;
    const defaults = await finishDefault(server, auth, id);
    assert.deepEqual(defaults.body.defectReasons.find(r => r.name === '图案不符'), { code: 'BL202504030001', name: '图案不符' });
    const done = await json(`${server.baseUrl}/v1/assignments/${id}/finish`, { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'pattern_mismatch_real_code_01' }, body: JSON.stringify({ quantity: 18, defectQuantity: 2, defectCodes: ['BL202504030001'] }) });
    assert.equal(done.status, 201);
    assert.equal(done.body.assignment.defectReasonName, '图案不符');
    assert.deepEqual(blacklake.outputs[0].defectCodes, ['BL202504030001']);
    const payload = await new BlacklakeClient({ mode: 'mock', approveStatus: 0 }).createOutput({operator:{blacklakeOperatorId:31001,name:'隔离质检'},task:TASKS[1],amount:20,defectAmount:2,defectCodes:['BL202504030001'],outputTime:'2026-11-06 10:00:00'});
    assert.deepEqual(payload.payload.defectList, [{code:'BL202504030001',amount:2}]);
    assert.equal(payload.payload.fineAmount, 18);
  } finally { await server.close(); }
});

const ADMIN_KEY = "test-admin-key-that-is-at-least-32-characters";
const ADMIN_PROXY_SECRET = "test-proxy-secret-that-is-at-least-32-characters";
const ZHANG = { name: "张师傅", phone: "13800138001" };
const WANG = { name: "王阿姨", phone: "13800138002" };
const DEFECT_REASONS = [
  { code: "BL202501090006", name: "车缝不良" },
  { code: "BL202501090005", name: "染色不良" }
];
const TASKS = [
  {
    taskId: 880101, projectId: 65001, projectCode: "GD-2026-0812-01",
    productName: "铝合金支架 A12", processName: "去毛刺", processCode: "GX-01",
    stationName: "3号工作台", plannedAmount: 20, defaultReportAmount: 20,
    sequence: 1, processStatusDisplay: "执行中", dueDate: "2026-09-12"
  },
  {
    taskId: 880102, projectId: 65001, projectCode: "GD-2026-0812-01",
    productName: "铝合金支架 A12", processName: "外观检查", processCode: "GX-02",
    stationName: "质检台", plannedAmount: 20, defaultReportAmount: 20,
    sequence: 2, processStatusDisplay: "未开始", dueDate: "2026-09-15"
  }
];

function flowBlacklake({ timeoutAfterWrite = false, explicitFailure = false, deletedWorkOrder = false, invalidPlan = false } = {}) {
  const tasks = TASKS.map((task) => ({
    ...task,
    reportedGoodAmount: 0,
    remnantAmount: task.plannedAmount,
    completed: false
  }));
  const outputs = [];
  return {
    outputs,
    verifyOperator: async ({ name, phone }) => {
      const known = [ZHANG, WANG].find((item) => item.name === name && item.phone === phone);
      if (!known) throw new AppError(404, "OPERATOR_NOT_FOUND", "姓名或手机号不对。");
      return { ...known, blacklakeOperatorId: name === ZHANG.name ? 31001 : 31002 };
    },
    listOperators: async () => [
      { name: ZHANG.name, blacklakeOperatorId: 31001, groupNames: ["三楼绣花部"] },
      { name: WANG.name, blacklakeOperatorId: 31002, groupNames: ["生产二组"] }
    ],
    listTasks: async ({ projectCode }) => TASKS.filter((task) => task.projectCode === projectCode),
    listProjectTasks: async ({ projectIds = [], projectCodes = [] } = {}) => TASKS.filter((task) =>
      (!projectIds.length || projectIds.includes(task.projectId)) &&
      (!projectCodes.length || projectCodes.includes(task.projectCode))
    ),
    queryOutputs: async () => [],
    findTask: async ({ taskId, projectCode }) => TASKS.find((task) => task.taskId === taskId && (!projectCode || task.projectCode === projectCode)),
    findTaskById: async (taskId) => {
      const task = [
        ...tasks,
        { ...TASKS[1], taskId: 990102, projectId: 99001, projectCode: "REFERENCE-WORK-ORDER" }
      ].find((item) => item.taskId === Number(taskId));
      if (!task) throw new AppError(404, "STATION_PROCESS_NOT_FOUND", "工序码不存在。");
      return { ...task };
    },
    listWorkOrderProcesses: async () => tasks.filter((task) => !task.completed).map((task) => ({ ...task })),
    findWorkOrderProcess: async (_flowCode, taskId) => {
      const task = tasks.find((item) => item.taskId === Number(taskId) && !item.completed);
      if (!task) throw new AppError(409, "PROCESS_NOT_AVAILABLE", "工序不可选。");
      return invalidPlan ? { ...task, defaultReportAmount: 0, plannedAmount: 0 } : { ...task };
    },
    createOutput: async ({ task, amount, defectAmount = 0, defectCode = "", defectCodes = [] }) => {
      if (deletedWorkOrder) throw new AppError(422, "BLACKLAKE_REJECTED", "黑湖未接受这次报工：工单编号不存在");
      if (explicitFailure) throw new AppError(422, "BLACKLAKE_REJECTED", "黑湖明确拒绝。");
      outputs.push({
        taskId: task.taskId,
        amount,
        ...(defectAmount || defectCode || defectCodes.length ? { defectAmount, defectCode, defectCodes } : {})
      });
      const completed = tasks.find((item) => item.taskId === task.taskId);
      if (completed) {
        completed.reportedGoodAmount += amount - defectAmount;
        completed.reportedDefectAmount = (completed.reportedDefectAmount || 0) + defectAmount;
        completed.completedAmount = completed.reportedGoodAmount + completed.reportedDefectAmount;
        completed.remnantAmount = Math.max(0, completed.plannedAmount - completed.reportedGoodAmount);
        completed.completed = true;
      }
      const next = tasks.find((item) => item.sequence === (completed?.sequence || 0) + 1);
      if (next) next.defaultReportAmount = completed.reportedGoodAmount;
      if (timeoutAfterWrite) throw new AppError(504, "BLACKLAKE_TIMEOUT", "响应超时。");
      return { id: `OUTPUT-${outputs.length}` };
    }
  };
}

async function createTestServer(blacklake = flowBlacklake(), processInferenceRules, stationCodeAliases = {}, review = {
  enabled: false,
  accessCode: "",
  operatorId: 0,
  allowedProjectIds: [],
  sessionHours: 24
}, defectReasons = DEFECT_REASONS, reportingModeAdminOperatorIds = []) {
  const directory = mkdtempSync(join(tmpdir(), "reporting-api-"));
  const config = {
    databasePath: join(directory, "test.sqlite"),
    sessionSecret: "test-secret-that-is-at-least-32-characters-long",
    adminApiKey: ADMIN_KEY,
    adminProxySecret: ADMIN_PROXY_SECRET,
    sessionDays: 30,
    reportingModeAdminOperatorIds,
    stationCodeAliases,
    review,
    wechat: { mock: true },
    anomalyRules: {
      deadlineGraceSeconds: 30 * 60,
      durationBaselineMinSamples: 5,
      durationMultiplier: 3,
      durationMinimumExcessSeconds: 60 * 60
    },
    blacklake: {
      mode: "mock", baseUrl: "https://example.invalid", staticToken: "", loginPath: "",
      factoryCode: "", account: "", phone: "", password: "",
      taskQueryPath: "/api/dytin/external/task/queryList2",
      userQueryPath: "/api/dytin/external/user/queryList2",
      currentProcessPath: "/api/dytin/external/project/queryList/expand",
      outputAddPath: "/api/dytin/external/output/add", approveStatus: 0, timeoutMs: 1000
    }
  };
  const store = new Store(config.databasePath, config);
  // These fixtures exercise the legacy self-reporting flow with explicit admin permission.
  for(const id of [31001,31002])store.setSelfServicePermission(id,true,0,'TEST:authorized-self-service');
  const wechat = { exchangeCode: async (code) => `test-openid:${code}` };
  const adminSync = new AdminSync(blacklake);
  const server = createServer(createApp({ config, store, blacklake, wechat, processInferenceRules, defectReasons, adminSync }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    store,
    adminSync,
    close: () => new Promise((resolve) => server.close(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
      resolve();
    }))
  };
}

async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

async function login(server, person = ZHANG) {
  const code = `wechat-${person.phone}`;
  const started = await json(`${server.baseUrl}/v1/auth/wechat`, {
    method: "POST", body: JSON.stringify({ code })
  });
  assert.equal(started.status, 200);
  if (started.body.status === "BOUND") {
    return { Authorization: `Bearer ${started.body.token}` };
  }

  const choices = await json(`${server.baseUrl}/v1/auth/operators`, {
    method: "POST", body: JSON.stringify({ bindingToken: started.body.bindingToken })
  });
  assert.equal(choices.status, 200);
  assert.equal(JSON.stringify(choices.body).includes("phone"), false);
  const operator = choices.body.operators.find((item) => item.name === person.name);
  assert(operator);
  const confirmation = await json(`${server.baseUrl}/v1/admin/binding-codes`, {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ blacklakeOperatorId: operator.blacklakeOperatorId })
  });
  assert.equal(confirmation.status, 201);
  const bound = await json(`${server.baseUrl}/v1/auth/bind`, {
    method: "POST",
    body: JSON.stringify({
      bindingToken: started.body.bindingToken,
      blacklakeOperatorId: operator.blacklakeOperatorId,
      confirmationCode: confirmation.body.confirmationCode
    })
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.operator.name, person.name);
  assert.equal("maskedPhone" in bound.body.operator, false);
  return { Authorization: `Bearer ${bound.body.token}` };
}

async function reviewLogin(server, { code = "review-access-2026", wechatCode = "wechat-reviewer" } = {}) {
  const started = await json(`${server.baseUrl}/v1/auth/wechat`, {
    method: "POST", body: JSON.stringify({ code: wechatCode })
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "UNBOUND");
  assert.equal(started.body.reviewAvailable, true);
  const reviewed = await json(`${server.baseUrl}/v1/auth/review`, {
    method: "POST",
    body: JSON.stringify({ bindingToken: started.body.bindingToken, accessCode: code })
  });
  return { started, reviewed };
}

async function flowOptions(server, auth, flowCode = "FLOW-001") {
  return json(`${server.baseUrl}/v1/flow/options`, {
    method: "POST", headers: auth, body: JSON.stringify({ flowCode })
  });
}

async function startProcess(server, auth, taskId, flowCode = "FLOW-001", details = {}) {
  return json(`${server.baseUrl}/v1/flow/start`, {
    method: "POST", headers: auth, body: JSON.stringify({ flowCode, taskId, ...details })
  });
}

async function resolveProcessCode(server, auth, processCode, flowCode = "FLOW-001") {
  return json(`${server.baseUrl}/v1/flow/process-code`, {
    method: "POST", headers: auth, body: JSON.stringify({ flowCode, processCode })
  });
}

async function finishDefault(server, auth, assignmentId) {
  return json(`${server.baseUrl}/v1/assignments/${assignmentId}/finish-default`, { headers: auth });
}

test("草稿身份跨登录保持、按员工隔离且不暴露会话令牌", async () => {
  const server = await createTestServer();
  try {
    const firstAuth = await login(server, ZHANG);
    const nextAuth = await login(server, ZHANG);
    const otherAuth = await login(server, WANG);
    assert.notEqual(firstAuth.Authorization, nextAuth.Authorization);
    const responses = await Promise.all([firstAuth, nextAuth, otherAuth].map((headers) => json(`${server.baseUrl}/v1/me`, { headers })));
    responses.forEach((response) => assert.equal(response.status, 200));
    const [first, next, other] = responses.map((response) => response.body);
    const firstToken = firstAuth.Authorization.slice("Bearer ".length);
    const employeeId = server.store.session(firstToken).id;
    assert.equal(first.draftOwnerId, `operator:${employeeId}`);
    assert.equal(next.draftOwnerId, first.draftOwnerId);
    assert.notEqual(other.draftOwnerId, first.draftOwnerId);
    for (const body of [first, next, other]) {
      for (const auth of [firstAuth, nextAuth, otherAuth]) {
        assert.equal(JSON.stringify(body).includes(auth.Authorization.slice("Bearer ".length)), false);
      }
      assert.equal("token" in body, false);
      assert.equal("tokenHash" in body, false);
      assert.equal("id" in body.operator, false, "不扩充公开员工资料，只提供专用草稿身份");
    }
  } finally { await server.close(); }
});

test("审核体验草稿身份与同一底层员工隔离且跨审核会话保持", async () => {
  const server = await createTestServer(flowBlacklake(), undefined, {}, {
    enabled: true, accessCode: "review-access-2026", operatorId: 31001,
    allowedProjectIds: [65001], sessionHours: 24
  });
  try {
    const workerAuth = await login(server, ZHANG);
    const { reviewed: firstLogin } = await reviewLogin(server, { wechatCode: "draft-reviewer-one" });
    const { reviewed: nextLogin } = await reviewLogin(server, { wechatCode: "draft-reviewer-two" });
    assert.equal(firstLogin.status, 200);
    assert.equal(nextLogin.status, 200);
    assert.notEqual(firstLogin.body.token, nextLogin.body.token);
    const worker = await json(`${server.baseUrl}/v1/me`, { headers: workerAuth });
    const first = await json(`${server.baseUrl}/v1/me`, { headers: { Authorization: `Bearer ${firstLogin.body.token}` } });
    const next = await json(`${server.baseUrl}/v1/me`, { headers: { Authorization: `Bearer ${nextLogin.body.token}` } });
    assert.equal(first.status, 200);
    assert.equal(next.status, 200);
    const employeeId = server.store.session(firstLogin.body.token).id;
    assert.equal(worker.body.draftOwnerId, `operator:${employeeId}`);
    assert.equal(first.body.draftOwnerId, `review:${employeeId}`);
    assert.equal(next.body.draftOwnerId, first.body.draftOwnerId);
    assert.notEqual(first.body.draftOwnerId, worker.body.draftOwnerId);
    assert.deepEqual(first.body.operator, { name: "审核体验" });
    for (const body of [first.body, next.body]) {
      assert.equal(JSON.stringify(body).includes(firstLogin.body.token), false);
      assert.equal(JSON.stringify(body).includes(nextLogin.body.token), false);
      assert.equal("tokenHash" in body, false);
      assert.equal("token" in body, false);
    }
  } finally { await server.close(); }
});

test("首次由班组长确认微信绑定，以后自动登录且不下发手机号", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server, ZHANG);
    const automatic = await json(`${server.baseUrl}/v1/auth/wechat`, {
      method: "POST",
      body: JSON.stringify({ code: `wechat-${ZHANG.phone}` })
    });
    assert.equal(automatic.status, 200);
    assert.equal(automatic.body.status, "BOUND");
    assert.deepEqual(automatic.body.operator, {
      name: ZHANG.name,
      reportingModes: ["embroidery", "standard"],
      defaultReportingMode: "embroidery"
    });

    server.store.db.prepare("UPDATE operators SET group_names_json = '[]' WHERE blacklake_operator_id = ?").run(31001);
    const me = await json(`${server.baseUrl}/v1/me`, { headers: auth });
    assert.deepEqual(me.body.operator.reportingModes, ["embroidery", "standard"]);
    assert.equal(me.body.operator.defaultReportingMode, "embroidery");

    const people = await json(`${server.baseUrl}/v1/admin/operators`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    assert.equal(people.body.operators.find((item) => item.name === ZHANG.name).bound, true);

    const unbound = await json(`${server.baseUrl}/v1/admin/bindings/31001`, {
      method: "DELETE",
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    assert.equal(unbound.status, 204);
    const expiredSession = await json(`${server.baseUrl}/v1/me`, { headers: auth });
    assert.equal(expiredSession.status, 401);
    const afterUnbind = await json(`${server.baseUrl}/v1/auth/wechat`, {
      method: "POST",
      body: JSON.stringify({ code: `wechat-${ZHANG.phone}` })
    });
    assert.equal(afterUnbind.body.status, "UNBOUND");
  } finally { await server.close(); }
});

test("管理员即使不在绣花部也可切换绣花机报工，但默认仍是普通报工", async () => {
  const blacklake = flowBlacklake();
  const embroideryTask = {
    ...TASKS[0],
    taskId: 990211,
    projectId: 88011,
    projectCode: "WO-ADMIN-EMB-001",
    processName: "外协加工KL",
    processCode: "WXJG-KL"
  };
  blacklake.listWorkOrderProcesses = async () => [{ ...embroideryTask }];
  const server = await createTestServer(blacklake, undefined, {}, undefined, undefined, [31002]);
  try {
    const auth = await login(server, WANG);
    const me = await json(`${server.baseUrl}/v1/me`, { headers: auth });
    assert.deepEqual(me.body.operator, {
      name: WANG.name,
      reportingModes: ["embroidery", "standard"],
      defaultReportingMode: "standard"
    });

    const people = await json(`${server.baseUrl}/v1/admin/operators`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    const administrator = people.body.operators.find((item) => item.blacklakeOperatorId === 31002);
    assert.equal(administrator.defaultReportingMode, "standard");
    assert.equal(administrator.canSwitchReportingMode, true);
    assert.equal(administrator.permissionSource, "config");

    const options = await json(`${server.baseUrl}/v1/flow/options`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flowCode: "FLOW-ADMIN-EMB", reportingMode: "embroidery" })
    });
    assert.equal(options.status, 200);
    assert.equal(options.body.embroideryProcess.taskId, embroideryTask.taskId);
  } finally { await server.close(); }
});

test("人员管理按黑湖人员ID保存切换权限，并在扫码和开工接口即时校验", async () => {
  const blacklake = flowBlacklake();
  const embroideryTask = {
    ...TASKS[0],
    taskId: 990311,
    projectId: 88031,
    projectCode: "WO-PERMISSION-EMB-001",
    processName: "外协加工KL",
    processCode: "WXJG-KL"
  };
  blacklake.listWorkOrderProcesses = async () => [{ ...embroideryTask }];
  blacklake.findWorkOrderProcess = async () => ({ ...embroideryTask });
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server, WANG);
    const before = await json(`${server.baseUrl}/v1/admin/operators`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    const zhangBefore = before.body.operators.find((item) => item.blacklakeOperatorId === 31001);
    const wangBefore = before.body.operators.find((item) => item.blacklakeOperatorId === 31002);
    assert.equal(wangBefore.description, "生产二组");
    assert.equal(wangBefore.defaultReportingMode, "standard");
    assert.equal(wangBefore.canSwitchReportingMode, false);
    assert.equal(zhangBefore.canSwitchReportingMode, true);

    const invalid = await json(`${server.baseUrl}/v1/admin/operators/31002/reporting-permission`, {
      method: "PATCH",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ allowSwitch: "yes" })
    });
    assert.equal(invalid.status, 422);

    const allowed = await json(`${server.baseUrl}/v1/admin/operators/31002/reporting-permission`, {
      method: "PATCH",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ allowSwitch: true })
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.operator.blacklakeOperatorId, 31002);
    assert.equal(allowed.body.operator.canSwitchReportingMode, true);
    assert.equal(allowed.body.operator.permissionSource, "manual");
    assert.equal(server.store.reportingModeSwitchPermission(31002), true);
    assert.equal(server.store.reportingModeSwitchPermission(31001), undefined);

    const meAllowed = await json(`${server.baseUrl}/v1/me`, { headers: auth });
    assert.deepEqual(meAllowed.body.operator.reportingModes, ["embroidery", "standard"]);
    assert.equal(meAllowed.body.operator.defaultReportingMode, "standard");
    const optionsAllowed = await json(`${server.baseUrl}/v1/flow/options`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flowCode: "FLOW-PERMISSION", reportingMode: "embroidery" })
    });
    assert.equal(optionsAllowed.status, 200);

    const denied = await json(`${server.baseUrl}/v1/admin/operators/31002/reporting-permission`, {
      method: "PATCH",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ allowSwitch: false })
    });
    assert.equal(denied.body.operator.canSwitchReportingMode, false);
    assert.equal(server.store.reportingModeSwitchPermission(31002), false);

    const forgedOptions = await json(`${server.baseUrl}/v1/flow/options`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flowCode: "FLOW-PERMISSION", reportingMode: "embroidery" })
    });
    assert.equal(forgedOptions.status, 403);
    assert.equal(forgedOptions.body.error.code, "EMBROIDERY_MODE_NOT_ALLOWED");

    const forgedMachine = await json(`${server.baseUrl}/v1/flow/embroidery-machine`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flowCode: "FLOW-PERMISSION", taskId: embroideryTask.taskId, machineCode: "08" })
    });
    assert.equal(forgedMachine.status, 403);

    const forgedStart = await json(`${server.baseUrl}/v1/flow/start`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        flowCode: "FLOW-PERMISSION",
        taskId: embroideryTask.taskId,
        reportingMode: "embroidery",
        machineId: "08",
        embroideryPart: "前幅"
      })
    });
    assert.equal(forgedStart.status, 403);
  } finally { await server.close(); }
});

test("微信审核入口不建立永久绑定，且只能操作配置的测试工单", async () => {
  const review = {
    enabled: true,
    accessCode: "review-access-2026",
    operatorId: 31001,
    allowedProjectIds: [65001],
    sessionHours: 24
  };
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake, undefined, {}, review);
  try {
    const failedStart = await json(`${server.baseUrl}/v1/auth/wechat`, {
      method: "POST", body: JSON.stringify({ code: "wechat-reviewer-wrong" })
    });
    const failed = await json(`${server.baseUrl}/v1/auth/review`, {
      method: "POST",
      body: JSON.stringify({ bindingToken: failedStart.body.bindingToken, accessCode: "wrong-code" })
    });
    assert.equal(failed.status, 422);
    assert.equal(failed.body.error.code, "REVIEW_CODE_INVALID");

    const { reviewed } = await reviewLogin(server);
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.reviewMode, true);
    assert.deepEqual(reviewed.body.operator, { name: "审核体验" });
    const auth = { Authorization: `Bearer ${reviewed.body.token}` };

    const me = await json(`${server.baseUrl}/v1/me`, { headers: auth });
    assert.equal(me.status, 200);
    assert.equal(me.body.reviewMode, true);
    assert.deepEqual(me.body.operator, { name: "审核体验" });

    const options = await flowOptions(server, auth);
    assert.equal(options.status, 200);
    assert.equal(options.body.workOrder.projectId, 65001);
    const resolved = await resolveProcessCode(server, auth, "GX-01");
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.process.taskId, 880101);
    const started = await startProcess(server, auth, 880101);
    assert.equal(started.status, 201);
    const finished = await json(`${server.baseUrl}/v1/assignments/${started.body.assignment.id}/finish`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "review_experience_finish_01" },
      body: JSON.stringify({ quantity: 20 })
    });
    assert.equal(finished.status, 201);
    assert.equal(blacklake.outputs.length, 1);
    assert.deepEqual(blacklake.outputs[0], { taskId: 880101, amount: 20 });

    const sameWechatAfterReview = await json(`${server.baseUrl}/v1/auth/wechat`, {
      method: "POST", body: JSON.stringify({ code: "wechat-reviewer" })
    });
    assert.equal(sameWechatAfterReview.status, 200);
    assert.equal(sameWechatAfterReview.body.status, "UNBOUND");
  } finally { await server.close(); }

  const blockedServer = await createTestServer(flowBlacklake(), undefined, {}, {
    ...review,
    allowedProjectIds: [99999]
  });
  try {
    const { reviewed } = await reviewLogin(blockedServer, { wechatCode: "wechat-reviewer-blocked" });
    assert.equal(reviewed.status, 200);
    const blocked = await flowOptions(blockedServer, { Authorization: `Bearer ${reviewed.body.token}` });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "REVIEW_WORK_ORDER_ONLY");
  } finally { await blockedServer.close(); }
});

test("仅选择姓名不能登录，确认码错误五次后本次绑定失效", async () => {
  const server = await createTestServer();
  try {
    const started = await json(`${server.baseUrl}/v1/auth/wechat`, {
      method: "POST", body: JSON.stringify({ code: "wrong-code-attempts" })
    });
    const confirmation = await json(`${server.baseUrl}/v1/admin/binding-codes`, {
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ blacklakeOperatorId: 31001 })
    });
    const wrongCode = confirmation.body.confirmationCode === "999999" ? "888888" : "999999";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await json(`${server.baseUrl}/v1/auth/bind`, {
        method: "POST",
        body: JSON.stringify({
          bindingToken: started.body.bindingToken,
          blacklakeOperatorId: 31001,
          confirmationCode: wrongCode
        })
      });
      assert.equal(failed.status, attempt === 5 ? 429 : 422);
    }
    const listAfterLock = await json(`${server.baseUrl}/v1/auth/operators`, {
      method: "POST", body: JSON.stringify({ bindingToken: started.body.bindingToken })
    });
    assert.equal(listAfterLock.status, 401);
  } finally { await server.close(); }
});

test("人员有进行中报工时班组长不能解除微信绑定", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server, ZHANG);
    const started = await startProcess(server, auth, 880101, "FLOW-BINDING-GUARD");
    assert.equal(started.status, 201);
    const rejected = await json(`${server.baseUrl}/v1/admin/bindings/31001`, {
      method: "DELETE",
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "OPERATOR_HAS_ACTIVE_ASSIGNMENT");
    const current = await json(`${server.baseUrl}/v1/assignments/current`, { headers: auth });
    assert.equal(current.body.assignment.id, started.body.assignment.id);
  } finally { await server.close(); }
});

test("扫工单码后再扫固定工序码，可识别工序、开工并正式报工", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const recognized = await resolveProcessCode(server, auth, "GX-01", "FLOW-STATION");
    assert.equal(recognized.status, 200);
    assert.equal(recognized.body.process.taskId, 880101);
    assert.equal(recognized.body.process.processName, "去毛刺");
    assert.equal(recognized.body.process.stationName, "3号工作台");
    assert.equal(recognized.body.process.defaultQuantity, 20);

    const started = await startProcess(server, auth, recognized.body.process.taskId, "FLOW-STATION");
    assert.equal(started.status, 201);
    assert.equal(started.body.assignment.processName, "去毛刺");

    const finished = await json(`${server.baseUrl}/v1/assignments/${started.body.assignment.id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "station_finish_complete_flow_01" },
      body: JSON.stringify({ quantity: 16 })
    });
    assert.equal(finished.status, 201);
    assert.deepEqual(blacklake.outputs, [{ taskId: 880101, amount: 16 }]);
  } finally { await server.close(); }
});

test("工位码支持带 processCode 参数的二维码链接，并拒绝不属于工单的编码", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server);
    const recognized = await resolveProcessCode(
      server,
      auth,
      "https://reporting.example/station?processCode=GX-02",
      "FLOW-STATION-URL"
    );
    assert.equal(recognized.status, 200);
    assert.equal(recognized.body.process.taskId, 880102);

    const missing = await resolveProcessCode(server, auth, "GX-NOT-EXISTS", "FLOW-STATION-URL");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "STATION_PROCESS_NOT_FOUND");
  } finally { await server.close(); }
});

test("黑湖 taskId 二维码先解析固定工序编码，再匹配当前工单任务", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server);
    const recognized = await resolveProcessCode(
      server,
      auth,
      "taskId=990102",
      "FLOW-STATION-TASK-ID"
    );
    assert.equal(recognized.status, 200);
    assert.equal(recognized.body.process.taskId, 880102);
    assert.equal(recognized.body.process.processName, "外观检查");

    const missing = await resolveProcessCode(
      server,
      auth,
      "taskId=999999",
      "FLOW-STATION-TASK-ID"
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "STATION_PROCESS_NOT_FOUND");
  } finally { await server.close(); }
});

test("黑湖旧 taskId 已无法查询时，使用受控别名匹配当前工单的固定工序编码", async () => {
  const server = await createTestServer(
    flowBlacklake(),
    undefined,
    { "684456181": "GX-01" }
  );
  try {
    const auth = await login(server);
    const recognized = await resolveProcessCode(
      server,
      auth,
      "taskId=684456181",
      "FLOW-STATION-LEGACY-TASK-ID"
    );
    assert.equal(recognized.status, 200);
    assert.equal(recognized.body.process.taskId, 880101);
    assert.equal(recognized.body.process.processName, "去毛刺");
  } finally { await server.close(); }
});

test("扫码后人工选择工序，下一道只取自己的计划数量", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const choices = await flowOptions(server, auth);
    assert.equal(choices.status, 200);
    assert.deepEqual(choices.body.processes.map((item) => item.taskId), [880101, 880102]);
    assert.equal(choices.body.featuredTitle, "前两道未完成工序");
    assert.deepEqual(choices.body.featuredProcesses.map((item) => item.taskId), [880101, 880102]);

    const first = await startProcess(server, auth, 880101);
    assert.equal(first.status, 201);
    assert.equal(first.body.assignment.processName, "去毛刺");
    assert.equal(first.body.assignment.quantity, 20);
    assert.equal(first.body.assignment.status, "IN_PROGRESS");

    const finished = await json(`${server.baseUrl}/v1/assignments/${first.body.assignment.id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "flow_finish_first_process_01" },
      body: JSON.stringify({ quantity: 17, processName: "伪造工序", defectAmount: 99 })
    });
    assert.equal(finished.status, 201);
    assert.equal(finished.body.report.goodAmount, 17);
    assert.equal(finished.body.report.defectAmount, 0);
    assert.equal(finished.body.assignment.quantity, 17);
    assert.deepEqual(blacklake.outputs, [{ taskId: 880101, amount: 17 }]);
    const completedOperatorId = server.store.listAssignments()[0].operatorId;
    assert.deepEqual(server.store.favoriteProcessNames(completedOperatorId, 2), ["去毛刺"]);
    assert.equal(finished.body.assignment.durationAssessment, null);
    assert.equal(typeof finished.body.assignment.durationSeconds, "number");

    const nextChoices = await flowOptions(server, auth);
    assert.deepEqual(nextChoices.body.processes.map((item) => item.taskId), [880102]);
    assert.equal(nextChoices.body.processes[0].defaultQuantity, 20);
    const second = await startProcess(server, auth, 880102);
    assert.equal(second.status, 201);
    assert.equal(second.body.assignment.processName, "外观检查");
    assert.equal(second.body.assignment.quantity, 20);
    assert.equal(second.body.assignment.minDurationSeconds, null);
    assert.equal(second.body.assignment.maxDurationSeconds, null);
  } finally { await server.close(); }
});

test("年度人员主工序只在当前工单唯一命中时进入确认，且不会自动开工", async () => {
  const blacklake = flowBlacklake();
  const rules = {
    sourcePeriod: { from: "2026-01-01", to: "2026-08-24" },
    staffRules: {
      [ZHANG.name]: {
        staff: ZHANG.name,
        processCode: "gx_01",
        reportCount: 1882,
        workOrderCount: 1507,
        confidence: 0.991,
        enabled: true
      }
    }
  };
  const server = await createTestServer(blacklake, rules);
  try {
    const auth = await login(server);
    const choices = await flowOptions(server, auth, "FLOW-INFERENCE");
    assert.equal(choices.status, 200);
    assert.equal(choices.body.recommendedProcess.taskId, 880101);
    assert.equal(choices.body.recommendationEvidence.source, "STAFF_HISTORY");
    assert.equal(choices.body.recommendationEvidence.reportCount, 1882);
    assert.equal(choices.body.recommendationEvidence.confidence, 0.991);
    assert.equal(server.store.listAssignments().length, 0);
    assert.deepEqual(blacklake.outputs, []);
  } finally { await server.close(); }
});

test("人员规则在当前工单没有匹配工序时保持原人工流程", async () => {
  const rules = {
    staffRules: {
      [ZHANG.name]: { staff: ZHANG.name, processCode: "GX-NOT-IN-ORDER", reportCount: 50, confidence: 0.95 }
    }
  };
  const server = await createTestServer(flowBlacklake(), rules);
  try {
    const auth = await login(server);
    const choices = await flowOptions(server, auth, "FLOW-INFERENCE-MISS");
    assert.equal(choices.status, 200);
    assert.equal(choices.body.recommendedProcess, null);
    assert.equal(choices.body.recommendationEvidence, null);
    assert.deepEqual(choices.body.processes.map((item) => item.taskId), [880101, 880102]);
  } finally { await server.close(); }
});

test("同一道工序多人数量合并、用时分开，第二人取剩余数但下一工序不继承累计数", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const zhangAuth = await login(server, ZHANG);
    const wangAuth = await login(server, WANG);
    const [first, second] = await Promise.all([
      startProcess(server, zhangAuth, 880101, "FLOW-RACE"),
      startProcess(server, wangAuth, 880101, "FLOW-RACE")
    ]);
    assert.deepEqual([first.status, second.status], [201, 201]);
    assert.notEqual(first.body.assignment.id, second.body.assignment.id);

    const firstFinished = await json(`${server.baseUrl}/v1/assignments/${first.body.assignment.id}/finish`, {
      method: "POST",
      headers: { ...zhangAuth, "Idempotency-Key": "parallel_finish_worker_a_01" },
      body: JSON.stringify({ quantity: 8 })
    });
    assert.equal(firstFinished.status, 201);

    const secondDefault = await finishDefault(server, wangAuth, second.body.assignment.id);
    assert.equal(secondDefault.status, 200);
    assert.deepEqual(secondDefault.body, {
      quantityPolicy: "SERVER_DEFAULT",
      targetQuantity: 20,
      cumulativeQuantity: 8,
      remainingQuantity: 12,
      defaultQuantity: 12
    });

    const secondFinished = await json(`${server.baseUrl}/v1/assignments/${second.body.assignment.id}/finish`, {
      method: "POST",
      headers: { ...wangAuth, "Idempotency-Key": "parallel_finish_worker_b_01" },
      body: JSON.stringify({ quantity: 15 })
    });
    assert.equal(secondFinished.status, 201);
    assert.deepEqual(blacklake.outputs, [
      { taskId: 880101, amount: 8 },
      { taskId: 880101, amount: 15 }
    ]);
    assert.equal(typeof firstFinished.body.assignment.durationSeconds, "number");
    assert.equal(typeof secondFinished.body.assignment.durationSeconds, "number");

    const nextChoices = await flowOptions(server, zhangAuth, "FLOW-RACE");
    assert.equal(nextChoices.status, 200);
    assert.equal(nextChoices.body.processes[0].taskId, 880102);
    assert.equal(nextChoices.body.processes[0].defaultQuantity, 20);
    const nextStarted = await startProcess(server, zhangAuth, 880102, "FLOW-RACE");
    assert.equal(nextStarted.body.assignment.quantity, 20);
  } finally { await server.close(); }
});

test("累计已经达到计划时结束页不默认填 0，但仍允许继续填写超计划数量", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const zhangAuth = await login(server, ZHANG);
    const wangAuth = await login(server, WANG);
    const [first, second] = await Promise.all([
      startProcess(server, zhangAuth, 880101, "FLOW-OVER-PLAN"),
      startProcess(server, wangAuth, 880101, "FLOW-OVER-PLAN")
    ]);
    await json(`${server.baseUrl}/v1/assignments/${first.body.assignment.id}/finish`, {
      method: "POST",
      headers: { ...zhangAuth, "Idempotency-Key": "over_plan_finish_worker_a_01" },
      body: JSON.stringify({ quantity: 20 })
    });

    const defaultAtPlan = await finishDefault(server, wangAuth, second.body.assignment.id);
    assert.equal(defaultAtPlan.body.remainingQuantity, 0);
    assert.equal(defaultAtPlan.body.defaultQuantity, null);

    const overPlan = await json(`${server.baseUrl}/v1/assignments/${second.body.assignment.id}/finish`, {
      method: "POST",
      headers: { ...wangAuth, "Idempotency-Key": "over_plan_finish_worker_b_01" },
      body: JSON.stringify({ quantity: 3 })
    });
    assert.equal(overPlan.status, 201);
    assert.deepEqual(blacklake.outputs, [
      { taskId: 880101, amount: 20 },
      { taskId: 880101, amount: 3 }
    ]);
  } finally { await server.close(); }
});

test("无需本地工序配置，直接采用黑湖计划数开始计时", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server);
    const response = await startProcess(server, auth, 880101, "FLOW-NO-CONFIG");
    assert.equal(response.status, 201);
    assert.equal(response.body.assignment.quantity, 20);
    assert.equal(response.body.assignment.durationAssessment, null);
    assert.equal(response.body.assignment.minDurationSeconds, null);
    assert.equal(response.body.assignment.maxDurationSeconds, null);
  } finally { await server.close(); }
});

test("黑湖计划数缺失时拒绝开工，避免报错数量", async () => {
  const server = await createTestServer(flowBlacklake({ invalidPlan: true }));
  try {
    const auth = await login(server);
    const response = await startProcess(server, auth, 880101, "FLOW-NO-PLAN");
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "BLACKLAKE_PLAN_AMOUNT_INVALID");
  } finally { await server.close(); }
});

test("一名工人报工结果待核对时，不阻塞另一名工人选择其他工序", async () => {
  const server = await createTestServer(flowBlacklake({ timeoutAfterWrite: true }));
  try {
    const zhangAuth = await login(server, ZHANG);
    const wangAuth = await login(server, WANG);
    const first = await startProcess(server, zhangAuth, 880101, "FLOW-TIMEOUT");
    const timedOut = await json(`${server.baseUrl}/v1/assignments/${first.body.assignment.id}/finish`, {
      method: "POST", headers: { ...zhangAuth, "Idempotency-Key": "flow_finish_timeout_000001" },
      body: JSON.stringify({ quantity: 18 })
    });
    assert.equal(timedOut.status, 504);
    const parallel = await startProcess(server, wangAuth, 880102, "FLOW-TIMEOUT");
    assert.equal(parallel.status, 201);
    assert.equal(parallel.body.assignment.quantity, 20);

    const resolved = await json(`${server.baseUrl}/v1/admin/assignments/${first.body.assignment.id}/resolve`, {
      method: "POST", headers: { "X-Admin-Key": ADMIN_KEY }, body: JSON.stringify({ outcome: "CONFIRMED" })
    });
    assert.equal(resolved.body.assignment.status, "COMPLETED");
  } finally { await server.close(); }
});

test("黑湖明确失败时任务保持进行中，不会推进流转码", async () => {
  const server = await createTestServer(flowBlacklake({ explicitFailure: true }));
  try {
    const auth = await login(server);
    const claimed = await startProcess(server, auth, 880101, "FLOW-FAIL");
    const failed = await json(`${server.baseUrl}/v1/assignments/${claimed.body.assignment.id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "flow_finish_explicit_fail_1" },
      body: JSON.stringify({ quantity: 19 })
    });
    assert.equal(failed.status, 422);
    const current = await json(`${server.baseUrl}/v1/assignments/current`, { headers: auth });
    assert.equal(current.body.assignment.status, "IN_PROGRESS");
    assert.equal(current.body.assignment.processName, "去毛刺");
  } finally { await server.close(); }
});

test("黑湖工序已结束时自动退出本地任务，工人不再卡在报工页", async () => {
  const blacklake = flowBlacklake();
  blacklake.createOutput = async () => {
    throw new AppError(409, "TASK_CLOSED", "这个任务已经结束，不能再报工，请联系班组长。");
  };
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101, "FLOW-CLOSED");
    const id = started.body.assignment.id;
    server.store.db.prepare("UPDATE assignments SET machine_id = '02', embroidery_part = '后幅' WHERE id = ?").run(id);
    const failed = await json(`${server.baseUrl}/v1/assignments/${id}/finish`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "closed_task_finish_01" },
      body: JSON.stringify({ quantity: 20 })
    });

    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, "TASK_CLOSED");
    assert.match(failed.body.error.message, /自动退出/);
    assert.equal(server.store.assignmentById(id).status, "CANCELLED");
    assert.match(server.store.assignmentById(id).cancellationReason, /黑湖工序已结束/);
    assert.equal(server.store.reportByKey("closed_task_finish_01").status, "FAILED");
    assert.equal(server.store.reportByKey("closed_task_finish_01").error_code, "TASK_CLOSED");
    assert.equal(server.store.db.prepare("SELECT actor FROM assignment_actions WHERE assignment_id = ?").get(id).actor, "SYSTEM");

    const audit = await json(`${server.baseUrl}/v1/admin/audit?q=${encodeURIComponent("张师傅")}&errorCode=TASK_CLOSED`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.total, 2);
    assert.deepEqual(new Set(audit.body.events.map((event) => event.eventType)), new Set(["REPORT_FAILED", "ASSIGNMENT_CANCELLED"]));
    assert.equal(audit.body.events.every((event) => event.machineId === "02" && event.embroideryPart === "后幅"), true);
    assert.equal(audit.body.events.find((event) => event.eventType === "REPORT_FAILED").reason, "黑湖工序已结束，本地任务已自动退出，可以重新扫码。");
    assert.equal(audit.body.events.find((event) => event.eventType === "ASSIGNMENT_CANCELLED").actor, "SYSTEM");
    assert.equal(audit.body.facets.errorCodes.includes("TASK_CLOSED"), true);

    const systemOnly = await json(`${server.baseUrl}/v1/admin/audit?actor=SYSTEM&eventType=ASSIGNMENT_CANCELLED&from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    assert.equal(systemOnly.body.total, 1);
    assert.equal(systemOnly.body.events[0].assignmentId, id);

    const deniedAudit = await json(`${server.baseUrl}/v1/admin/audit`);
    assert.equal(deniedAudit.status, 401);

    const current = await json(`${server.baseUrl}/v1/assignments/current`, { headers: auth });
    assert.equal(current.body.assignment, null);
    assert.deepEqual(current.body.assignments, []);
  } finally { await server.close(); }
});

test("黑湖工单删除后工人可取消自己的未完成报工并退出", async () => {
  const blacklake = flowBlacklake({ deletedWorkOrder: true });
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101, "FLOW-DELETED");
    const id = started.body.assignment.id;
    const premature = await json(`${server.baseUrl}/v1/assignments/${id}/cancel`, {
      method: "POST", headers: auth, body: "{}"
    });
    assert.equal(premature.status, 409);
    assert.equal(premature.body.error.code, "WORKER_CANCELLATION_NOT_ALLOWED");
    const failed = await json(`${server.baseUrl}/v1/assignments/${id}/finish`, {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "deleted_work_order_finish_01" },
      body: JSON.stringify({ quantity: 19 })
    });
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, "WORK_ORDER_NOT_FOUND");

    const stuck = await json(`${server.baseUrl}/v1/assignments/current`, { headers: auth });
    assert.equal(stuck.body.assignment.status, "IN_PROGRESS");
    assert.equal(stuck.body.assignment.canWorkerCancel, true);

    const otherAuth = await login(server, WANG);
    const otherWorker = await json(`${server.baseUrl}/v1/assignments/${id}/cancel`, {
      method: "POST", headers: otherAuth, body: "{}"
    });
    assert.equal(otherWorker.status, 404);

    const cancelled = await json(`${server.baseUrl}/v1/assignments/${id}/cancel`, {
      method: "POST", headers: auth, body: "{}"
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.assignment.status, "CANCELLED");
    assert.match(cancelled.body.assignment.cancellationReason, /工单.*删除/);
    assert.equal(server.store.db.prepare("SELECT actor FROM assignment_actions WHERE assignment_id = ?").get(id).actor, "AUTHENTICATED_OPERATOR");
    assert.equal(blacklake.outputs.length, 0);
    assert.equal((await json(`${server.baseUrl}/v1/assignments/current`, { headers: auth })).body.assignment, null);
  } finally { await server.close(); }
});

test("失败重试保留原目标数量和第一次结束时间", async () => {
  const blacklake = flowBlacklake({ explicitFailure: true });
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101);
    const id = started.body.assignment.id;
    server.store.db.prepare("UPDATE assignments SET baseline_reported_amount = 10 WHERE id = ?").run(id);
    await json(`${server.baseUrl}/v1/assignments/${id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "regression_failed_quantity_01" },
      body: JSON.stringify({ quantity: 10 })
    });
    const suggestion = await finishDefault(server, auth, id);
    assert.equal(suggestion.body.targetQuantity, 20);
    assert.equal(suggestion.body.remainingQuantity, 10);
    const failed = server.store.assignmentById(id);
    assert.ok(failed.endedAt, "失败等待时间不应重新计入生产");
    const frozenEnd = "2026-09-07 10:10:00";
    server.store.db.prepare("UPDATE assignments SET started_at = ?, ended_at = ? WHERE id = ?")
      .run("2026-09-07 10:00:00", frozenEnd, id);
    blacklake.createOutput = async (input) => {
      assert.equal(input.actualEndedAt, frozenEnd);
      return { id: "RECOVERED-OUTPUT" };
    };
    const retried = await json(`${server.baseUrl}/v1/assignments/${id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "regression_failed_quantity_02" },
      body: JSON.stringify({ quantity: 10 })
    });
    assert.equal(retried.status, 201);
    assert.equal(retried.body.assignment.quantity, 10);
    assert.equal(retried.body.assignment.durationSeconds, 600);
  } finally { await server.close(); }
});

test("管理员取消误开工可省略原因，保留记录且不产生黑湖报工", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101);
    const id = started.body.assignment.id;
    const endpoint = `${server.baseUrl}/v1/admin/assignments/${id}/cancel`;
    assert.equal((await json(endpoint, { method: "POST", headers: auth, body: JSON.stringify({ reason: "扫错了" }) })).status, 401);
    assert.equal((await json(endpoint, { method: "POST", headers: { "X-Admin-Key": ADMIN_KEY }, body: JSON.stringify({reason:"\u0001"}) })).status, 422);
    const cancelled = await json(endpoint, { method: "POST", headers: { "X-Admin-Key": ADMIN_KEY }, body: "{}" });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.assignment.status, "CANCELLED");
    assert.equal(cancelled.body.assignment.cancellationReason, null);
    assert.equal(server.store.db.prepare("SELECT COUNT(*) AS n FROM assignment_actions").get().n, 1);
    assert.equal(blacklake.outputs.length, 0);
    assert.equal(server.store.currentAssignment(server.store.assignmentById(id).operatorId), undefined);
    assert.equal((await json(`${server.baseUrl}/v1/admin/bindings/31001`, { method: "DELETE", headers: { "X-Admin-Key": ADMIN_KEY } })).status, 204);
  } finally { await server.close(); }
});

test("黑湖结果未知时不能取消开工以绕过核对", async () => {
  const server = await createTestServer(flowBlacklake({ timeoutAfterWrite: true }));
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101);
    const id = started.body.assignment.id;
    await json(`${server.baseUrl}/v1/assignments/${id}/finish`, { method: "POST", headers: { ...auth, "Idempotency-Key": "unknown_cannot_cancel_01" }, body: JSON.stringify({ quantity: 10 }) });
    const denied = await json(`${server.baseUrl}/v1/admin/assignments/${id}/cancel`, { method: "POST", headers: { "X-Admin-Key": ADMIN_KEY }, body: JSON.stringify({ reason: "尝试取消" }) });
    assert.equal(denied.status, 409);
    assert.equal(server.store.assignmentById(id).status, "NEEDS_REVIEW");
  } finally { await server.close(); }
});

test("两人分批质检分别记录合格与不良，剩余扣已检总数", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const a = await login(server, ZHANG);
    const b = await login(server, WANG);
    server.store.setQualityProfile(31001,'quality',0,'TEST');
    server.store.setQualityProfile(31002,'quality',0,'TEST');
    const first = await startProcess(server, a, 880102);
    const second = await startProcess(server, b, 880102);
    assert.equal(first.body.assignment.isQualityInspection, true);
    const submit = (auth, id, quantity, defectQuantity, key) => json(`${server.baseUrl}/v1/assignments/${id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": key }, body: JSON.stringify({ quantity, defectQuantity, defectCode: "BL202501090006" })
    });
    const r1 = await submit(a, first.body.assignment.id, 8, 2, "quality_parallel_first_01");
    assert.equal(r1.status, 201);
    assert.equal(r1.body.assignment.quantity, 10);
    assert.equal(r1.body.assignment.goodQuantity, 8);
    assert.equal(r1.body.assignment.defectQuantity, 2);
    assert.equal(r1.body.assignment.defectCode, "BL202501090006");
    assert.deepEqual(r1.body.assignment.defectCodes, ["BL202501090006"]);
    assert.equal(r1.body.assignment.defectReasonName, "车缝不良");
    const finishDefaults = await finishDefault(server, b, second.body.assignment.id);
    assert.equal(finishDefaults.body.remainingQuantity, 10);
    assert.deepEqual(finishDefaults.body.defectReasons, DEFECT_REASONS);
    const r2 = await submit(b, second.body.assignment.id, 9, 1, "quality_parallel_second_01");
    assert.equal(r2.status, 201);
    const totals = server.store.db.prepare("SELECT SUM(amount) AS inspected, SUM(good_amount) AS good, SUM(defect_amount) AS bad FROM reports WHERE status = 'SUCCEEDED'").get();
    assert.deepEqual({ ...totals }, { inspected: 20, good: 17, bad: 3 });
    assert.deepEqual(blacklake.outputs.map((output) => output.defectCode), ["BL202501090006", "BL202501090006"]);
    assert.equal((await submit(b, second.body.assignment.id, 9, 1, "quality_parallel_second_01")).status, 200);
    assert.equal(blacklake.outputs.length, 2);
    assert.equal((await submit(b, second.body.assignment.id, 9, 2, "quality_parallel_second_01")).status, 409);
  } finally { await server.close(); }
});

test("质检人员允许整批全不良，普通人员不能填写不良数", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server);
    const normal = await startProcess(server, auth, 880101);
    const wrong = await json(`${server.baseUrl}/v1/assignments/${normal.body.assignment.id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "non_quality_defect_reject_01" }, body: JSON.stringify({ quantity: 10, defectQuantity: 1 })
    });
    assert.equal(wrong.status, 422);
    await json(`${server.baseUrl}/v1/admin/assignments/${normal.body.assignment.id}/cancel`, {
      method: "POST", headers: { "X-Admin-Key": ADMIN_KEY }, body: JSON.stringify({ reason: "测试换工序" })
    });
    server.store.setQualityProfile(31001,'quality',0,'TEST');
    const quality = await startProcess(server, auth, 880102);
    for (const defectQuantity of [-1, 0.5, "abc"]) {
      const invalid = await json(`${server.baseUrl}/v1/assignments/${quality.body.assignment.id}/finish`, {
        method: "POST", headers: { ...auth, "Idempotency-Key": "quality_invalid_defect_01" }, body: JSON.stringify({ quantity: 1, defectQuantity })
      });
      assert.equal(invalid.status, 422);
    }
    const missingReason = await json(`${server.baseUrl}/v1/assignments/${quality.body.assignment.id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "quality_missing_reason_01" }, body: JSON.stringify({ quantity: 0, defectQuantity: 20 })
    });
    assert.equal(missingReason.status, 422);
    assert.equal(missingReason.body.error.code, "DEFECT_REASON_REQUIRED");
    const unknownReason = await json(`${server.baseUrl}/v1/assignments/${quality.body.assignment.id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "quality_unknown_reason_01" }, body: JSON.stringify({ quantity: 0, defectQuantity: 20, defectCode: "NOT-CONFIGURED" })
    });
    assert.equal(unknownReason.status, 422);
    assert.equal(unknownReason.body.error.code, "INVALID_DEFECT_REASON");
    const tooManyReasons = await json(`${server.baseUrl}/v1/assignments/${quality.body.assignment.id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "quality_too_many_reasons_01" }, body: JSON.stringify({ quantity: 1, defectQuantity: 1, defectCodes: ["BL202501090006", "BL202501090005"] })
    });
    assert.equal(tooManyReasons.status, 422);
    assert.equal(tooManyReasons.body.error.code, "TOO_MANY_DEFECT_REASONS");
    const allBad = await json(`${server.baseUrl}/v1/assignments/${quality.body.assignment.id}/finish`, {
      method: "POST", headers: { ...auth, "Idempotency-Key": "quality_all_defective_01" }, body: JSON.stringify({ quantity: 0, defectQuantity: 20, defectCodes: ["BL202501090005", "BL202501090006"] })
    });
    assert.equal(allBad.status, 201);
    assert.equal(allBad.body.assignment.goodQuantity, 0);
    assert.equal(allBad.body.assignment.quantity, 20);
    assert.deepEqual(allBad.body.assignment.defectCodes, ["BL202501090005", "BL202501090006"]);
    assert.equal(allBad.body.assignment.defectReasonName, "染色不良、车缝不良");
  } finally { await server.close(); }
});

test("多个不良原因自动平均分摊并写入黑湖 defectList", async () => {
  const client = new BlacklakeClient({ mode: "mock", approveStatus: 0 });
  const result = await client.createOutput({ operator: { blacklakeOperatorId: 1, name: "质检员" }, task: { taskId: 1, projectId: 2, projectCode: "TEST" }, amount: 50, defectAmount: 5, defectCodes: ["BL202501090006", "BL202501090005", "BL202501090003"], outputTime: "2026-09-07 10:00:00" });
  assert.equal(result.payload.outputAmount, 50);
  assert.equal(result.payload.fineAmount, 45);
  assert.equal(result.payload.defectsAmount, 5);
  assert.deepEqual(result.payload.defectList, [
    { code: "BL202501090006", amount: 2 },
    { code: "BL202501090005", amount: 2 },
    { code: "BL202501090003", amount: 1 }
  ]);
});

test("黑湖报工接口把工单不存在识别为可恢复的明确错误", async () => {
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    outputAddPath: "/api/dytin/external/output/add", approveStatus: 0, timeoutMs: 1000
  }, async () => new Response(JSON.stringify({
    code: -1,
    message: "工单编号不存在"
  }), { status: 200 }));

  await assert.rejects(
    () => client.createOutput({
      operator: { blacklakeOperatorId: 31001, name: "张师傅" },
      task: { taskId: 880101, projectId: 65001, projectCode: "GD-DELETED" },
      amount: 1, defectAmount: 0, defectCode: "", outputTime: "2026-09-08 14:00:00"
    }),
    (error) => error.code === "WORK_ORDER_NOT_FOUND" && error.status === 409
  );
});

test("黑湖“工序状态已结束无法报工”映射为任务关闭", async () => {
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    outputAddPath: "/api/dytin/external/output/add", approveStatus: 0, timeoutMs: 1000
  }, async () => new Response(JSON.stringify({
    code: -1,
    message: "工序状态已结束无法报工"
  }), { status: 200 }));

  await assert.rejects(
    () => client.createOutput({
      operator: { blacklakeOperatorId: 31001, name: "张师傅" },
      task: { taskId: 880101, projectId: 65001, projectCode: "GD-CLOSED" },
      amount: 20, defectAmount: 0, defectCode: "", outputTime: "2026-09-14 10:00:00"
    }),
    (error) => error.code === "TASK_CLOSED" && error.status === 409
  );
});

test("黑湖暂时不可用时仍返回本地任务并明确提示未同步", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101);
    blacklake.queryOutputs = async () => { throw new AppError(503, "BLACKLAKE_UNAVAILABLE", "暂不可用"); };
    blacklake.listProjectTasks = blacklake.queryOutputs;
    const result = await json(`${server.baseUrl}/v1/admin/assignments`, { headers: { "X-Admin-Key": ADMIN_KEY } });
    assert.equal(result.status, 200);
    assert.equal(result.body.assignments[0].id, started.body.assignment.id);
    assert.match(result.body.syncWarning, /黑湖/);
    assert.equal(result.body.workOrders[0].processSync.status, "unavailable");
  } finally { await server.close(); }
});

test("黑湖确认查空且没有未结束本地任务时，不再用历史报工复活已删除工单", async () => {
  const blacklake = flowBlacklake();
  blacklake.queryOutputs = async () => [{
    id: 77101,
    taskId: 977101,
    projectId: 677101,
    projectCode: "DELETED-TEST-WORK-ORDER",
    productName: "已删除测试产品",
    processName: "外协加工",
    workreportQuantity: 10,
    numberofgoodProducts: 10,
    createdAt: "2026-09-01T01:00:00.000Z"
  }];
  blacklake.listProjectTasks = async () => [];
  const server = await createTestServer(blacklake);
  try {
    const result = await json(`${server.baseUrl}/v1/admin/assignments`, { headers: { "X-Admin-Key": ADMIN_KEY } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.assignments, []);
    assert.deepEqual(result.body.workOrders, []);
    assert.doesNotMatch(result.body.syncWarning, /查询未返回工序/);
  } finally { await server.close(); }
});

test("黑湖工序确认查空时仍保留未结束的本地任务并提醒管理员", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101);
    blacklake.listProjectTasks = async () => [];
    const result = await json(`${server.baseUrl}/v1/admin/assignments`, { headers: { "X-Admin-Key": ADMIN_KEY } });
    assert.equal(result.status, 200);
    assert.equal(result.body.assignments[0].id, started.body.assignment.id);
    assert.equal(result.body.workOrders[0].projectCode, TASKS[0].projectCode);
    assert.match(result.body.syncWarning, /查询未返回工序/);
  } finally { await server.close(); }
});

test("真实管理接口同步失败保留完整工艺和恢复工单，恢复后清除警告", async () => {
  let fail = false, now = 100000;
  const blacklake = flowBlacklake();
  const list = blacklake.listProjectTasks;
  blacklake.queryOutputs = async () => {
    if (fail) throw new AppError(504, "BLACKLAKE_TIMEOUT", "模拟超时");
    return [{ id: 1, projectId: 65001, projectCode: TASKS[0].projectCode, taskId: 880101, workreportQuantity: 20 }];
  };
  blacklake.listProjectTasks = async (criteria) => {
    if (fail) throw new AppError(504, "BLACKLAKE_TIMEOUT", "模拟超时");
    return list(criteria);
  };
  const server = await createTestServer(blacklake);
  server.adminSync.now = () => now;
  try {
    const read = () => json(`${server.baseUrl}/v1/admin/assignments`, { headers: { "X-Admin-Key": ADMIN_KEY } });
    const fresh = await read();
    assert.equal(fresh.body.workOrders[0].processSync.status, "fresh");
    now += 61000; fail = true;
    const stale = await read();
    assert.equal(stale.status, 200);
    assert.equal(stale.body.assignments.length, 1);
    assert.equal(stale.body.workOrders[0].processes.length, 2);
    assert.equal(stale.body.workOrders[0].processSync.status, "stale");
    assert.equal(stale.body.outputSync.status, "stale");
    assert.match(stale.body.syncWarning, /沿用上次成功/);
    now += 61000; fail = false;
    const recovered = await read();
    assert.equal(recovered.body.workOrders[0].processSync.status, "fresh");
    assert.equal(recovered.body.syncWarning, "");
  } finally { await server.close(); }
});

test("同一秒内开工不会把基线中已有的单人报工再累计一次", async () => {
  const blacklake = flowBlacklake();
  const server = await createTestServer(blacklake);
  try {
    const a = await login(server, ZHANG);
    const b = await login(server, WANG);
    const first = await startProcess(server, a, 880101);
    await json(`${server.baseUrl}/v1/assignments/${first.body.assignment.id}/finish`, {
      method: "POST", headers: { ...a, "Idempotency-Key": "baseline_first_report_01" }, body: JSON.stringify({ quantity: 10 })
    });
    blacklake.findWorkOrderProcess = async () => ({ ...TASKS[0], reportedGoodAmount: 10 });
    const second = await startProcess(server, b, 880101);
    server.store.db.prepare("UPDATE reports SET output_time = ?").run(second.body.assignment.startedAt);
    assert.equal((await finishDefault(server, b, second.body.assignment.id)).body.remainingQuantity, 10);
  } finally { await server.close(); }
});

test("正式报工数量必须是正整数", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server);
    const claimed = await startProcess(server, auth, 880101, "FLOW-BAD-AMOUNT");
    for (const quantity of [0, 1.5, "abc"]) {
      const failed = await json(`${server.baseUrl}/v1/assignments/${claimed.body.assignment.id}/finish`, {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": `flow_finish_bad_amount_${String(quantity).replace(".", "_")}` },
        body: JSON.stringify({ quantity })
      });
      assert.equal(failed.status, 422);
      assert.equal(failed.body.error.code, "INVALID_REPORT_QUANTITY");
    }
  } finally { await server.close(); }
});

test("8楼组长派单后员工开始计时，结束登记待核量并释放当前任务", async () => {
  const server = await createTestServer();
  try {
    const leaderAuth = await login(server, ZHANG);
    const employeeAuth = await login(server, WANG);
    const profile = await json(`${server.baseUrl}/v1/admin/operators/31001/entry-profile`, {
      method: "PATCH",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ appRole: "floor8_leader", workUnitId: "" })
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.operator.entryView, "leader-assignment");
    assert.equal(profile.body.operator.floor, 8);

    const me = await json(`${server.baseUrl}/v1/me`, { headers: leaderAuth });
    assert.equal(me.body.entry.entryView, "leader-assignment");

    const workOrder = await json(`${server.baseUrl}/v1/dispatch/work-order`, {
      method: "POST",
      headers: leaderAuth,
      body: JSON.stringify({ flowCode: "FLOW-001" })
    });
    assert.equal(workOrder.status, 200);
    assert.equal(workOrder.body.processes.length, 2);

    const assigned = await json(`${server.baseUrl}/v1/dispatch/assign`, {
      method: "POST",
      headers: leaderAuth,
      body: JSON.stringify({
        flowCode: "FLOW-001",
        unitId: "A-03",
        taskId: 880101,
        blacklakeOperatorId: 31002
      })
    });
    assert.equal(assigned.status, 201);
    assert.equal(assigned.body.assignment.status, "READY");
    assert.equal(assigned.body.assignment.stationName, "A-03");
    assert.equal(assigned.body.assignment.isDispatched, true);

    const current = await json(`${server.baseUrl}/v1/assignments/current`, { headers: employeeAuth });
    assert.equal(current.body.assignment.id, assigned.body.assignment.id);
    assert.equal(current.body.assignment.status, "READY");

    const started = await json(`${server.baseUrl}/v1/assignments/${assigned.body.assignment.id}/start`, {
      method: "POST",
      headers: employeeAuth
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.assignment.status, "IN_PROGRESS");

    const finished = await json(`${server.baseUrl}/v1/assignments/${assigned.body.assignment.id}/finish`, {
      method: "POST",
      headers: { ...employeeAuth, "Idempotency-Key": `dispatch_finish_${assigned.body.assignment.id.replaceAll("-", "")}` },
      body: JSON.stringify({ quantity: 20, defectQuantity: 0, defectCodes: [] })
    });
    assert.equal(finished.status, 201);
    assert.equal(finished.body.assignment.status, "COMPLETED");
    assert.equal(finished.body.quantityReviewPending, undefined);
    const afterFinish = await json(`${server.baseUrl}/v1/assignments/current`, { headers: employeeAuth });
    assert.equal(afterFinish.body.assignment, null);
    assert.deepEqual(afterFinish.body.assignments, []);
  } finally { await server.close(); }
});

test("8楼同一工位支持多选员工并可继续追加并行报工", async () => {
  const blacklake = flowBlacklake();
  const originalListOperators = blacklake.listOperators;
  const extraOperators = [
    { name: "李师傅", blacklakeOperatorId: 31003, groupNames: ["生产二组"] },
    { name: "陈师傅", blacklakeOperatorId: 31004, groupNames: ["生产二组"] }
  ];
  blacklake.listOperators = async () => [...await originalListOperators(), ...extraOperators];
  const server = await createTestServer(blacklake);
  try {
    const leaderAuth = await login(server, ZHANG);
    await json(`${server.baseUrl}/v1/admin/operators/31001/entry-profile`, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ appRole: "floor8_leader", workUnitId: "" })
    });
    for (const operator of extraOperators) {
      server.store.upsertBlacklakeOperator(operator);
      server.store.setEntryProfile(operator.blacklakeOperatorId, { appRole: "employee" });
    }

    const firstBatch = await json(`${server.baseUrl}/v1/dispatch/assign`, {
      method: "POST", headers: leaderAuth,
      body: JSON.stringify({
        flowCode: "FLOW-001", unitId: "A-05", taskId: 880101,
        blacklakeOperatorIds: [31002, 31003]
      })
    });
    assert.equal(firstBatch.status, 201);
    assert.equal(firstBatch.body.assignments.length, 2);
    assert.ok(firstBatch.body.assignments.every((assignment) => assignment.stationName === "A-05"));

    const appended = await json(`${server.baseUrl}/v1/dispatch/assign`, {
      method: "POST", headers: leaderAuth,
      body: JSON.stringify({
        flowCode: "FLOW-001", unitId: "A-05", taskId: 880101,
        blacklakeOperatorIds: [31004]
      })
    });
    assert.equal(appended.status, 201);
    assert.equal(appended.body.assignments.length, 1);

    const overview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: leaderAuth });
    const station = overview.body.units.find((unit) => unit.id === "A-05");
    assert.equal(station.state, "scheduled");
    assert.equal(station.assignmentCount, 3);
    assert.equal(station.assignments.length, 3);
    assert.equal(station.canAssign, true);
  } finally { await server.close(); }
});

test("8楼工位驻位员工可在后台配置，工序按主管常选和历史报工分组且去重", async () => {
  const server = await createTestServer(flowBlacklake(), {
    schemaVersion: 1,
    sourcePeriod: { from: "2026-01-01T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z" },
    staffRules: {
      [WANG.name]: {
        staff: WANG.name,
        processCode: "GX-02",
        reportCount: 42,
        workOrderCount: 18,
        confidence: 0.91,
        enabled: true
      }
    },
    transitionRules: []
  });
  try {
    const leaderAuth = await login(server, ZHANG);
    await login(server, WANG);
    const embroideryRecommendation = await json(`${server.baseUrl}/v1/admin/dispatch-units/A-03/recommended-operator`, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ blacklakeOperatorId: 31001 })
    });
    assert.equal(embroideryRecommendation.status, 409);
    assert.equal(embroideryRecommendation.body.error.code, "OPERATOR_NOT_FLOOR8_EMPLOYEE");
    await json(`${server.baseUrl}/v1/admin/operators/31001/entry-profile`, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ appRole: "floor8_leader" })
    });

    const configured = await json(`${server.baseUrl}/v1/admin/dispatch-units/A-03/recommended-operator`, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ blacklakeOperatorId: 31002 })
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.recommendation.blacklakeOperatorId, 31002);

    const overview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: leaderAuth });
    assert.equal(overview.body.units.find((unit) => unit.id === "A-03").recommendedBlacklakeOperatorId, 31002);
    const people = await json(`${server.baseUrl}/v1/admin/operators`, { headers: { "X-Admin-Key": ADMIN_KEY } });
    assert.deepEqual(people.body.unitRecommendations.map(({ unitId, blacklakeOperatorId }) => ({ unitId, blacklakeOperatorId })), [
      { unitId: "A-03", blacklakeOperatorId: 31002 }
    ]);

    const target = server.store.findOperatorByBlacklakeId(31002);
    const dispatched = server.store.dispatchAssignment({
      id: "recommendation-history-assignment",
      operatorId: target.id,
      ...TASKS[0],
      stationName: "A-03",
      quantity: 20,
      baselineReportedAmount: 0,
      flowCodeHash: "history",
      flowCodeHint: "0001",
      publishedBy: ZHANG.name,
      publishedByOperatorId: 31001,
      publishedAt: "2026-09-20T08:00:00.000Z"
    });
    assert.ok(dispatched);
    server.store.db.prepare("UPDATE assignments SET status = 'COMPLETED' WHERE id = ?")
      .run(dispatched.id);

    for (const [index, processName] of ["去毛刺", "旧工单工序"].entries()) {
      const idempotencyKey = `recommendation_history_${String(index).padStart(2, "0")}`;
      server.store.insertPendingReport({
        id: `recommendation-report-${index}`,
        idempotencyKey,
        requestHash: `history-${index}`,
        operatorId: target.id,
        taskId: 990000 + index,
        projectId: 99000,
        projectCode: "HISTORY",
        productName: "历史产品",
        processName,
        amount: 10,
        goodAmount: 10,
        defectAmount: 0,
        defectCode: "",
        outputTime: `2026-09-${10 + index}T08:00:00.000Z`
      });
      server.store.markReportSucceeded(idempotencyKey, `OUTPUT-HISTORY-${index}`);
    }

    const recommendations = await json(`${server.baseUrl}/v1/dispatch/process-recommendations`, {
      method: "POST", headers: leaderAuth,
      body: JSON.stringify({
        flowCode: "FLOW-001",
        unitId: "A-03",
        blacklakeOperatorIds: [31002]
      })
    });
    assert.equal(recommendations.status, 200);
    assert.deepEqual(recommendations.body.supervisorFrequent.map((item) => item.processName), ["去毛刺"]);
    assert.deepEqual(recommendations.body.systemRecommended.map((item) => item.processName), ["外观检查"]);
    assert.deepEqual(recommendations.body.otherProcesses, []);
    assert.equal(
      [...recommendations.body.supervisorFrequent, ...recommendations.body.systemRecommended]
        .filter((item) => item.processName === "去毛刺").length,
      1
    );
    const auxiliaryUnits = ["裁床一区", "裁床二区-1", "裁床二区-2", "手工剪线", "翻内袋", "包装/质检", "刺绣片检验"];
    for (const unitId of auxiliaryUnits) {
      const saved = await json(`${server.baseUrl}/v1/admin/dispatch-units/${encodeURIComponent(unitId)}/recommended-operator`, {
        method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
        body: JSON.stringify({ blacklakeOperatorId: 31002 })
      });
      assert.equal(saved.status, 200, unitId);
    }
    const updatedOverview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: leaderAuth });
    for (const unitId of auxiliaryUnits) {
      assert.equal(updatedOverview.body.units.find((unit) => unit.id === unitId).recommendedBlacklakeOperatorId, 31002);
    }
  } finally { await server.close(); }
});

test("8楼一个工位可保存多名员工，覆盖与清空均同步到组长派工", async () => {
  const blacklake = flowBlacklake();
  const originalList = blacklake.listOperators;
  blacklake.listOperators = async () => [
    ...await originalList(),
    { name: "李师傅", blacklakeOperatorId: 31003, groupNames: ["生产二组"] }
  ];
  const server = await createTestServer(blacklake);
  try {
    const leaderAuth = await login(server, ZHANG);
    await json(`${server.baseUrl}/v1/admin/operators/31001/entry-profile`, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ appRole: "floor8_leader" })
    });
    const endpoint = `${server.baseUrl}/v1/admin/dispatch-units/${encodeURIComponent("裁床一区")}/recommended-operator`;
    const save = async (ids) => json(endpoint, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ blacklakeOperatorIds: ids })
    });
    const saved = await save([31002, 31003]);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.recommendations.map((item) => item.blacklakeOperatorId), [31002, 31003]);
    let overview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: leaderAuth });
    assert.deepEqual(overview.body.units.find((unit) => unit.id === "裁床一区").recommendedBlacklakeOperatorIds, [31002, 31003]);
    const invalid = await save([31002, 31001]);
    assert.equal(invalid.status, 409);
    assert.deepEqual(server.store.dispatchUnitRecommendations().filter((item) => item.unitId === "裁床一区")
      .map((item) => item.blacklakeOperatorId), [31002, 31003]);
    const replaced = await save([31003]);
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.body.recommendations.map((item) => item.blacklakeOperatorId), [31003]);
    const cleared = await save([]);
    assert.equal(cleared.status, 200);
    overview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: leaderAuth });
    assert.deepEqual(overview.body.units.find((unit) => unit.id === "裁床一区").recommendedBlacklakeOperatorIds, []);
  } finally { await server.close(); }
});

test("组长按 SKU 查到多张工单并选择唯一 projectId，员工无权搜索", async () => {
  const blacklake = flowBlacklake();
  blacklake.searchWorkOrdersBySku = async (sku) => sku === "SKU-A12" ? [
    { projectId: 65001, projectCode: "WO-A", productCode: sku, productName: "产品 A" },
    { projectId: 65002, projectCode: "WO-B", productCode: sku, productName: "产品 A" }
  ] : [];
  const server = await createTestServer(blacklake);
  try {
    const leaderAuth = await login(server, ZHANG);
    const workerAuth = await login(server, WANG);
    await json(`${server.baseUrl}/v1/admin/operators/31001/entry-profile`, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ appRole: "floor8_leader" })
    });
    const search = (sku, headers) => json(`${server.baseUrl}/v1/dispatch/work-orders/search`, {
      method: "POST", headers, body: JSON.stringify({ sku })
    });
    const found = await search(" SKU-A12 ", leaderAuth);
    assert.equal(found.status, 200);
    assert.deepEqual(found.body.workOrders.map((order) => order.projectId), [65001, 65002]);
    assert.equal((await search("SKU-A12", workerAuth)).status, 403);
    assert.equal((await search("", leaderAuth)).status, 422);
  } finally { await server.close(); }
});

test("SKU 工单索引分页去重，并按产品编码精确筛选", async () => {
  const client = new BlacklakeClient({ mode: "live" });
  const year = new Date().getFullYear();
  const calls = [];
  client.request = async (_path, input) => {
    calls.push(input);
    if (input.projectCode === String(year) && input.page.pageNum === 1) {
      return { data: [
        { id: 101, projectCode: `${year}/1-001`, productCode: "SKU-A", productName: "产品 A", createTime: "2026-01-01" },
        { id: 102, projectCode: `${year}/1-002`, productCode: "SKU-B", productName: "产品 B", createTime: "2026-01-02" }
      ] };
    }
    return { data: [
      { id: 103, projectCode: `${year - 1}/1-003`, productCode: "SKU-A", productName: "产品 A", createTime: "2025-01-01" }
    ] };
  };
  const found = await client.searchWorkOrdersBySku(" sku-a ");
  assert.deepEqual(found.map((order) => order.projectId), [101, 103]);
  assert.equal(calls.length, 2);
  await client.searchWorkOrdersBySku("SKU-B");
  assert.equal(calls.length, 2, "十分钟内复用工单索引");
});

test("3楼主管按纵向编号选机，机器必须先在后台绑定员工", async () => {
  const blacklake = flowBlacklake();
  const embroideryTask = {
    ...TASKS[0], taskId: 991301, projectId: 77003, projectCode: "WO-3F-001",
    processName: "外协加工KL", processCode: "WXJG-KL", defaultReportAmount: 120, plannedAmount: 120
  };
  blacklake.findTaskById = async () => ({ ...embroideryTask });
  blacklake.listWorkOrderProcesses = async () => [{ ...embroideryTask }];
  blacklake.findWorkOrderProcess = async (_flowCode, taskId) => {
    if (Number(taskId) !== embroideryTask.taskId) throw new AppError(404, "TASK_NOT_FOUND", "没有找到任务");
    return { ...embroideryTask };
  };
  const server = await createTestServer(blacklake);
  try {
    const supervisorAuth = await login(server, ZHANG);
    const workerAuth = await login(server, WANG);
    await json(`${server.baseUrl}/v1/admin/operators/31001/entry-profile`, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ appRole: "floor3_supervisor" })
    });

    const unmapped = await json(`${server.baseUrl}/v1/dispatch/assign`, {
      method: "POST", headers: supervisorAuth,
      body: JSON.stringify({ flowCode: "FLOW-3F", unitId: "3F-01", taskId: embroideryTask.taskId })
    });
    assert.equal(unmapped.status, 409);
    assert.equal(unmapped.body.error.code, "WORK_UNIT_OPERATOR_NOT_CONFIGURED");

    await json(`${server.baseUrl}/v1/admin/operators/31002/entry-profile`, {
      method: "PATCH", headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ appRole: "employee", workUnitId: "3F-01" })
    });
    const overview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: supervisorAuth });
    assert.deepEqual(overview.body.units.slice(0, 5).map((unit) => unit.id), ["3F-01", "3F-02", "3F-03", "3F-04", "3F-05"]);
    assert.equal(overview.body.units[0].operatorMapped, true);

    const missingPart = await json(`${server.baseUrl}/v1/dispatch/assign`, {
      method: "POST", headers: supervisorAuth,
      body: JSON.stringify({ flowCode: "FLOW-3F", unitId: "3F-01", taskId: embroideryTask.taskId })
    });
    assert.equal(missingPart.status, 422);
    assert.equal(missingPart.body.error.code, "INVALID_EMBROIDERY_PART");

    const assigned = await json(`${server.baseUrl}/v1/dispatch/assign`, {
      method: "POST", headers: supervisorAuth,
      body: JSON.stringify({
        flowCode: "FLOW-3F", unitId: "3F-01", taskId: embroideryTask.taskId,
        embroideryPart: "前幅"
      })
    });
    assert.equal(assigned.status, 201);
    assert.equal(assigned.body.assignment.machineId, "3F-01");
    assert.equal(assigned.body.assignment.embroideryPart, "前幅");
    assert.equal(assigned.body.assignment.status, "READY");

    const scheduledOverview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: supervisorAuth });
    const scheduledMachine = scheduledOverview.body.units.find((unit) => unit.id === "3F-01");
    assert.equal(scheduledMachine.state, "scheduled");
    assert.equal(scheduledMachine.canAssign, true);

    const appended = await json(`${server.baseUrl}/v1/dispatch/assign`, {
      method: "POST", headers: supervisorAuth,
      body: JSON.stringify({
        flowCode: "FLOW-3F", unitId: "3F-01", taskId: embroideryTask.taskId,
        embroideryPart: "后幅"
      })
    });
    assert.equal(appended.status, 201);
    assert.equal(appended.body.assignment.machineId, "3F-01");
    assert.equal(appended.body.assignment.embroideryPart, "后幅");

    const appendedOverview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: supervisorAuth });
    const queuedMachine = appendedOverview.body.units.find((unit) => unit.id === "3F-01");
    assert.equal(queuedMachine.assignmentCount, 2);
    assert.equal(queuedMachine.canAssign, true);

    const started = await json(`${server.baseUrl}/v1/assignments/${assigned.body.assignment.id}/start`, {
      method: "POST", headers: workerAuth
    });
    assert.equal(started.status, 200);

    const runningOverview = await json(`${server.baseUrl}/v1/dispatch/overview`, { headers: supervisorAuth });
    const runningMachine = runningOverview.body.units.find((unit) => unit.id === "3F-01");
    assert.equal(runningMachine.state, "running");
    assert.equal(runningMachine.canAssign, false);

    const blockedWhileRunning = await json(`${server.baseUrl}/v1/dispatch/assign`, {
      method: "POST", headers: supervisorAuth,
      body: JSON.stringify({
        flowCode: "FLOW-3F", unitId: "3F-01", taskId: embroideryTask.taskId,
        embroideryPart: "前幅"
      })
    });
    assert.equal(blockedWhileRunning.status, 409);
  } finally { await server.close(); }
});

test("管理页只展示报工记录，不再提供重复工序配置", async () => {
  const server = await createTestServer();
  try {
    const adminPage = await fetch(`${server.baseUrl}/admin`);
    assert.equal(adminPage.status, 200);
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /现场报工记录/);
    assert.match(adminHtml, /正在连接钉钉/);
    assert.match(adminHtml, /rel="preload" href="\/admin\/assets\/embroidery-machine-list\.0390558efd\.webp" as="image" type="image\/webp"/);
    assert.doesNotMatch(adminHtml, /admin-key|管理密钥/);
    assert.doesNotMatch(adminHtml, /合理最短|保存工序参数/);
    const adminScript = await (await fetch(`${server.baseUrl}/admin/app.js`)).text();
    assert.match(adminScript, /\/api\/auth\/dingtalk\/start/);
    assert.match(adminScript, /result\.workOrders/);
    assert.match(adminScript, /NOT_STARTED/);
    assert.match(adminScript, /绣花机看板/);
    assert.match(adminScript, /embroidery-machine-list\.0390558efd\.webp/);
    assert.match(adminScript, /embroidery-machine-detail\.c8f650b45a\.webp/);
    assert.match(adminScript, /loading="lazy" decoding="async"/);
    assert.doesNotMatch(adminScript, /X-Admin-Key/);
    const loginBootstrap = adminScript.match(/async function enterWithDingTalk\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  function showToast/)?.[0] || "";
    assert.match(loginBootstrap, /await loadAssignments\(\)/);
    assert.doesNotMatch(loginBootstrap, /\/v1\/admin\/embroidery-schedule|loadEmbroiderySchedule/);
    const listMachineAsset = await fetch(`${server.baseUrl}/admin/assets/embroidery-machine-list.0390558efd.webp`);
    assert.equal(listMachineAsset.status, 200);
    assert.match(listMachineAsset.headers.get("content-type"), /image\/webp/);
    assert.equal(listMachineAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const listMachineBytes = (await listMachineAsset.arrayBuffer()).byteLength;
    assert.ok(listMachineBytes > 1000 && listMachineBytes < 250_000);
    const detailMachineAsset = await fetch(`${server.baseUrl}/admin/assets/embroidery-machine-detail.c8f650b45a.webp`);
    assert.equal(detailMachineAsset.status, 200);
    assert.match(detailMachineAsset.headers.get("content-type"), /image\/webp/);
    assert.equal(detailMachineAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.ok((await detailMachineAsset.arrayBuffer()).byteLength > listMachineBytes);
    const denied = await json(`${server.baseUrl}/v1/admin/assignments`);
    assert.equal(denied.status, 401);
    const unauthorized = await json(`${server.baseUrl}/v1/assignments/current`);
    assert.equal(unauthorized.status, 401);
  } finally { await server.close(); }
});

test("取消后台派单后不再暴露绣花排程读写接口", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server);
    const adminRead = await json(`${server.baseUrl}/v1/admin/embroidery-schedule`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    const adminWrite = await json(`${server.baseUrl}/v1/admin/embroidery-schedule`, {
      method: "PUT",
      headers: { "X-Admin-Key": ADMIN_KEY },
      body: JSON.stringify({ revision: 0, machines: [] })
    });
    const workerRead = await json(`${server.baseUrl}/v1/embroidery/schedule`, { headers: auth });
    assert.deepEqual([adminRead.status, adminWrite.status, workerRead.status], [404, 404, 404]);
  } finally { await server.close(); }
});

test("绣花工人扫工单、机器码和前后幅后可跨机并行，后台只读展示实时机位", async () => {
  const blacklake = flowBlacklake();
  const embroideryTasks = [
    {
      ...TASKS[0], taskId: 990201, projectId: 88001, projectCode: "WO-EMB-001",
      productName: "棒球帽", processName: "外协加工KL", processCode: "WXJG-KL"
    },
    {
      ...TASKS[0], taskId: 990202, projectId: 88002, projectCode: "WO-EMB-002",
      productName: "卫衣", processName: "外协加工", processCode: "WXJG"
    },
    {
      ...TASKS[0], taskId: 990203, projectId: 88003, projectCode: "WO-EMB-003",
      productName: "绣花补单", processName: "外协加工", processCode: "WXJG-003"
    }
  ];
  const allTasks = [...embroideryTasks, ...TASKS];
  blacklake.findWorkOrderProcess = async (_flowCode, taskId) => {
    const task = allTasks.find((item) => item.taskId === Number(taskId));
    if (!task) throw new AppError(409, "PROCESS_NOT_AVAILABLE", "工序不可选。");
    return { ...task };
  };
  blacklake.listWorkOrderProcesses = async (flowCode) => flowCode === "FLOW-MIXED"
    ? [embroideryTasks[2], TASKS[0]].map((task) => ({ ...task }))
    : allTasks.map((task) => ({ ...task }));

  const server = await createTestServer(blacklake);
  try {
    const auth = await login(server);
    const options = await json(`${server.baseUrl}/v1/flow/options`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ flowCode: "FLOW-EMB-001", reportingMode: "embroidery" })
    });
    assert.equal(options.status, 200);
    assert.equal(options.body.embroideryProcess.taskId, 990201);

    const machine = await json(`${server.baseUrl}/v1/flow/embroidery-machine`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ flowCode: "FLOW-EMB-001", taskId: 990201, machineCode: "https://bh.kairaygolf.com/embroidery/machine?machineId=08" })
    });
    assert.equal(machine.status, 200);
    assert.deepEqual(machine.body.machine, { id: "08", name: "08 号绣花机" });
    assert.deepEqual(machine.body.parts, ["前幅", "后幅"]);

    const first = await startProcess(server, auth, 990201, "FLOW-EMB-001", { machineId: "08", embroideryPart: "前幅" });
    const second = await startProcess(server, auth, 990201, "FLOW-EMB-001", { machineId: "09", embroideryPart: "后幅" });
    assert.deepEqual([first.status, second.status], [201, 201]);

    const current = await json(`${server.baseUrl}/v1/assignments/current`, { headers: auth });
    assert.deepEqual(current.body.assignments.map((item) => item.id), [first.body.assignment.id, second.body.assignment.id]);
    assert.equal(current.body.assignments.every((item) => item.isEmbroidery), true);
    assert.deepEqual(current.body.assignments.map((item) => [item.machineId, item.embroideryPart]), [["08", "前幅"], ["09", "后幅"]]);

    const parallelOptions = await json(`${server.baseUrl}/v1/flow/options`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ flowCode: "FLOW-MIXED", reportingMode: "embroidery" })
    });
    assert.equal(parallelOptions.status, 200);
    assert.deepEqual(parallelOptions.body.processes.map((item) => item.taskId), [990203]);

    const occupied = await startProcess(server, auth, 990202, "FLOW-EMB-002", { machineId: "08", embroideryPart: "前幅", reportingMode: "embroidery" });
    assert.equal(occupied.status, 409);
    assert.equal(occupied.body.error.code, "EMBROIDERY_MACHINE_IN_USE");

    const otherWorker = await login(server, WANG);
    const forbidden = await startProcess(server, otherWorker, 990202, "FLOW-EMB-002", { machineId: "10", embroideryPart: "前幅", reportingMode: "embroidery" });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, "EMBROIDERY_MODE_NOT_ALLOWED");

    const ordinary = await startProcess(server, auth, 880101, "FLOW-NORMAL");
    assert.equal(ordinary.status, 409);
    assert.equal(ordinary.body.error.code, "OPERATOR_ALREADY_WORKING");

    const admin = await json(`${server.baseUrl}/v1/admin/assignments`, { headers: { "X-Admin-Key": ADMIN_KEY } });
    const live = admin.body.assignments.filter((item) => item.status === "IN_PROGRESS" && item.isEmbroidery);
    assert.deepEqual(live.map((item) => [item.operatorName, item.machineId, item.embroideryPart]).sort((a,b)=>a[1].localeCompare(b[1])), [[ZHANG.name, "08", "前幅"], [ZHANG.name, "09", "后幅"]]);
  } finally { await server.close(); }
});

test("管理接口接受可信反向代理注入的钉钉会话凭据", async () => {
  const server = await createTestServer();
  try {
    const accepted = await json(`${server.baseUrl}/v1/admin/assignments`, {
      headers: { "X-Admin-Proxy-Secret": ADMIN_PROXY_SECRET }
    });
    assert.equal(accepted.status, 200);

    const rejected = await json(`${server.baseUrl}/v1/admin/assignments`, {
      headers: { "X-Admin-Proxy-Secret": "forged-proxy-secret-that-is-at-least-32-characters" }
    });
    assert.equal(rejected.status, 401);
  } finally { await server.close(); }
});

test("管理台账返回已报工工单的全部黑湖工序", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101, "FLOW-ALL-PROCESSES");
    assert.equal(started.status, 201);

    const response = await json(`${server.baseUrl}/v1/admin/assignments`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.workOrders[0].processes.map((process) => process.taskId), [880101, 880102]);
    assert.equal(response.body.workOrders[0].dueDate, "2026-09-15");
    assert.equal(response.body.workOrders[0].processes[0].reportedAmount, 0);
    assert.equal(response.body.workOrders[0].processes[1].processStatusDisplay, "未开始");
  } finally { await server.close(); }
});

test("本地台账缺失时从黑湖已报记录恢复工单并合并全部工序", async () => {
  const blacklake = flowBlacklake();
  blacklake.queryOutputs = async () => [{
    id: 442356564,
    projectId: 65001,
    projectCode: "GD-2026-0812-01",
    taskId: 880101,
    productName: "铝合金支架 A12",
    productionStaff: "张师傅",
    productionStaffId: 31001,
    workreportQuantity: "20.000000",
    numberofgoodProducts: "20.000000",
    effectiveTime: 35,
    starttimeofReport: "2026-09-07 15:16:19",
    endtimeofReport: "2026-09-07 15:16:54",
    createdAt: "2026-09-07 15:16:54"
  }];
  const server = await createTestServer(blacklake);
  try {
    const response = await json(`${server.baseUrl}/v1/admin/assignments`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.assignments.length, 1);
    assert.equal(response.body.assignments[0].source, "黑湖报工");
    assert.equal(response.body.assignments[0].operatorName, "张师傅");
    assert.deepEqual(response.body.workOrders[0].processes.map((process) => process.taskId), [880101, 880102]);
  } finally { await server.close(); }
});

test("管理接口按projectId隔离编号相同的不同黑湖工单", async () => {
  const blacklake = flowBlacklake();
  const tasks = [
    { ...TASKS[0], taskId: 710011, projectId: 71001, projectCode: "test", productName: "旧工单产品", processName: "旧工序" },
    { ...TASKS[0], taskId: 720011, projectId: 72001, projectCode: "test", productName: "新工单产品", processName: "新工序" }
  ];
  blacklake.queryOutputs = async () => tasks.map((task, index) => ({
    id: 450000000 + index,
    projectId: task.projectId,
    projectCode: task.projectCode,
    taskId: task.taskId,
    productName: task.productName,
    productionStaff: "刘芮华",
    productionStaffId: 31001,
    workreportQuantity: index ? 100 : 150,
    numberofgoodProducts: index ? 100 : 150,
    effectiveTime: 60,
    starttimeofReport: `2026-09-${index ? "14" : "07"} 10:00:00`,
    endtimeofReport: `2026-09-${index ? "14" : "07"} 10:01:00`,
    createdAt: `2026-09-${index ? "14" : "07"} 10:01:00`
  }));
  blacklake.listProjectTasks = async ({ projectIds = [], projectCodes = [] } = {}) => tasks.filter((task) =>
    projectIds.includes(task.projectId) || projectCodes.includes(task.projectCode));
  const server = await createTestServer(blacklake);
  try {
    const response = await json(`${server.baseUrl}/v1/admin/assignments`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.assignments.length, 2);
    assert.equal(response.body.workOrders.length, 2);
    assert.deepEqual(response.body.workOrders.map((order) => order.projectId).sort(), [71001, 72001]);
    assert.deepEqual(response.body.workOrders.map((order) => order.processes.map((process) => process.taskId)), [[710011], [720011]]);
  } finally { await server.close(); }
});

test("管理接口保留缺少projectId的历史工单为独立记录", async () => {
  const blacklake = flowBlacklake();
  const currentTask = { ...TASKS[0], taskId: 730011, projectId: 73001, projectCode: "test", processName: "当前工序" };
  blacklake.queryOutputs = async () => [
    {
      id: 460000001, projectId: 73001, projectCode: "test", taskId: 730011,
      productionStaff: "刘芮华", productionStaffId: 31001, workreportQuantity: 100,
      effectiveTime: 60, starttimeofReport: "2026-09-14 10:00:00", endtimeofReport: "2026-09-14 10:01:00"
    },
    {
      id: 460000002, projectId: null, projectCode: "test", taskId: 690011,
      productionStaff: "刘芮华", productionStaffId: 31001, workreportQuantity: 150,
      effectiveTime: 60, starttimeofReport: "2026-09-07 10:00:00", endtimeofReport: "2026-09-07 10:01:00"
    }
  ];
  blacklake.listProjectTasks = async () => [currentTask];
  const server = await createTestServer(blacklake);
  try {
    const response = await json(`${server.baseUrl}/v1/admin/assignments`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.workOrders.length, 2);
    assert.deepEqual(response.body.workOrders.map((order) => order.projectId), [73001, null]);
  } finally { await server.close(); }
});

test("管理台账不会把没有计划基准的长时间生产误判为异常", async () => {
  const server = await createTestServer();
  try {
    const auth = await login(server);
    const started = await startProcess(server, auth, 880101, "FLOW-ANOMALY");
    assert.equal(started.status, 201);
    const oldStart = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
    server.store.db.prepare("UPDATE assignments SET started_at = ? WHERE id = ?").run(oldStart, started.body.assignment.id);

    const response = await json(`${server.baseUrl}/v1/admin/assignments`, {
      headers: { "X-Admin-Key": ADMIN_KEY }
    });
    assert.equal(response.status, 200);
    const assignment = response.body.assignments.find((item) => item.id === started.body.assignment.id);
    assert.equal(assignment.productionStatus, "IN_PROGRESS");
    assert.equal(assignment.hasProductionAnomaly, false);
    assert.deepEqual(assignment.productionAnomalies, []);
    assert.equal(response.body.anomalySummary.total, 0);
    assert.equal(response.body.anomalyRules.deadlineGraceMinutes, 30);
  } finally { await server.close(); }
});

test("黑湖工单二维码解析 projectId，并精确匹配当前工序任务", async () => {
  const calls = [];
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    currentProcessPath: "/api/dytin/external/project/queryList/expand",
    taskQueryPath: "/api/dytin/external/task/queryList2", timeoutMs: 1000
  }, async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith("/project/queryList/expand")) {
      return new Response(JSON.stringify({
        code: "01000000",
        data: [{ projectId: 123059181, currentProcessId: 7001, currentProcessName: "切割" }]
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      code: "01000000",
      data: [
        { id: 880100, projectId: 123059181, projectCode: "GD-1", processId: 7000, processName: "备料", planAmount: 100 },
        { id: 880101, projectId: 123059181, projectCode: "GD-1", processId: 7001, processName: "切割", processCode: "GX-01", productName: "产品 A", planAmount: 100 }
      ]
    }), { status: 200 });
  });

  const task = await client.findCurrentProcess(
    "https://liteapp.blacklake.cn/pages/index/workOrderDetail/index?id=123059181"
  );
  assert.equal(calls[0].url, "https://blacklake.invalid/api/dytin/external/project/queryList/expand");
  assert.deepEqual(calls[0].body, { projectIds: [123059181] });
  assert.equal(calls[1].url, "https://blacklake.invalid/api/dytin/external/task/queryList2");
  assert.deepEqual(calls[1].body, {
    projectIds: [123059181], processIds: [7001], page: { pageNum: 1, pageSize: 100 }
  });
  assert.equal(task.taskId, 880101);
  assert.equal(task.projectId, 123059181);
  assert.equal(task.processName, "切割");
  assert.equal(task.reportAmount, 100);
});

test("黑湖打印标签的 projectId 工单码可查询全部工序", async () => {
  let requestBody;
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    taskQueryPath: "/api/dytin/external/task/queryList2", timeoutMs: 1000
  }, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      code: "01000000",
      data: [{
        id: 692662950, projectId: 124974363, projectCode: "审核test",
        processId: 3627075, processName: "运两边翅膀", planAmount: 100
      }]
    }), { status: 200 });
  });

  const tasks = await client.listWorkOrderProcesses("projectId=124974363");
  assert.deepEqual(requestBody, {
    projectIds: [124974363], page: { pageNum: 1, pageSize: 100 }
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].projectId, 124974363);
  assert.equal(tasks[0].processName, "运两边翅膀");
});

test("黑湖 taskId 工序码可查询出跨工单使用的固定 processCode", async () => {
  let requestBody;
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    taskQueryPath: "/api/dytin/external/task/queryList2", timeoutMs: 1000
  }, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      code: "01000000",
      data: [{
        id: 684456181, projectId: 123722460, projectCode: "test",
        processId: 3627075, processCode: "6012417", processName: "运两边翅膀"
      }]
    }), { status: 200 });
  });

  const task = await client.findTaskById(684456181);
  assert.deepEqual(requestBody, { id: 684456181, page: { pageNum: 1, pageSize: 20 } });
  assert.equal(task.processCode, "6012417");
  assert.equal(task.processName, "运两边翅膀");
});

test("后台按工单查询任务时自动分页并返回全部工序", async () => {
  const pageNumbers = [];
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    taskQueryPath: "/api/dytin/external/task/queryList2", timeoutMs: 1000
  }, async (_url, options) => {
    const request = JSON.parse(options.body);
    pageNumbers.push(request.page.pageNum);
    const start = request.page.pageNum === 1 ? 1 : 101;
    const count = request.page.pageNum === 1 ? 100 : 1;
    const list = Array.from({ length: count }, (_, index) => ({
      id: start + index,
      projectId: 65001,
      projectCode: "GD-2026-0812-01",
      processName: `工序 ${start + index}`,
      seq: start + index,
      processEndTime: start + index === 1 ? "2026-09-20 18:00:00" : null,
      planAmount: 150,
      fineAmount: 0,
      remnantAmount: 150
    }));
    return new Response(JSON.stringify({ code: "01000000", data: { list } }), { status: 200 });
  });

  const tasks = await client.listProjectTasks({ projectIds: [65001] });
  assert.equal(tasks.length, 101);
  assert.deepEqual(pageNumbers, [1, 2]);
  assert.equal(tasks.at(-1).processName, "工序 101");
  assert.equal(tasks[0].dueDate, "2026-09-20");
});

test("黑湖人员名单自动分页且不会保留手机号字段", async () => {
  const pages = [];
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    userQueryPath: "/api/dytin/external/user/queryList2", timeoutMs: 1000
  }, async (_url, options) => {
    const pageNum = JSON.parse(options.body).page.pageNum;
    pages.push(pageNum);
    const data = pageNum === 1
      ? Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          name: `工人${index + 1}`,
          phone: `1380000${String(index).padStart(4, "0")}`,
          groupNames: ["生产组"],
          fake: false
        }))
      : [{ id: 101, name: "最后一人", phone: "13900000000", fake: false }];
    return new Response(JSON.stringify({ code: "01000000", data: { data } }), { status: 200 });
  });

  const operators = await client.listOperators();
  assert.deepEqual(pages, [1, 2]);
  assert.equal(operators.length, 101);
  assert.deepEqual(Object.keys(operators[0]).toSorted(), ["blacklakeOperatorId", "groupNames", "name"]);
  assert.equal(operators.some((operator) => "phone" in operator), false);
});

test("微信 code2Session 只返回 OpenID，并按官方参数交换一次性 code", async () => {
  let requestedUrl;
  const client = new WechatClient({
    mock: false,
    appId: "wx-test-app",
    appSecret: "server-only-secret",
    code2SessionUrl: "https://api.weixin.qq.com/sns/jscode2session",
    timeoutMs: 1000
  }, async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({ openid: "openid-123", session_key: "not-stored" }), { status: 200 });
  });

  assert.equal(await client.exchangeCode("one-time-code"), "openid-123");
  assert.equal(requestedUrl.searchParams.get("appid"), "wx-test-app");
  assert.equal(requestedUrl.searchParams.get("secret"), "server-only-secret");
  assert.equal(requestedUrl.searchParams.get("js_code"), "one-time-code");
  assert.equal(requestedUrl.searchParams.get("grant_type"), "authorization_code");
});

test("人工工序列表隐藏已完成项，默认数量仅使用当前工序计划", async () => {
  let requestBody;
  let queryCount = 0;
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    taskQueryPath: "/api/dytin/external/task/queryList2", timeoutMs: 1000
  }, async (_url, options) => {
    queryCount += 1;
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      code: "01000000",
      data: [
        {
          id: 880100, projectId: 123059181, projectCode: "GD-1", processId: 7000,
          processName: "备料", productName: "产品 A", seq: 1, planAmount: 100,
          fineAmount: 86, remnantAmount: 0, processStatus: 20, processStatusDisplay: "已完成"
        },
        {
          id: 880101, projectId: 123059181, projectCode: "GD-1", processId: 7001,
          processName: "切割", productName: "产品 A", seq: 2, planAmount: 100,
          fineAmount: 0, remnantAmount: 100, processStatus: 0, processStatusDisplay: "未开始"
        },
        {
          id: 880102, projectId: 123059181, projectCode: "GD-1", processId: 7002,
          processName: "包装", productName: "产品 A", seq: 3, planAmount: 100,
          fineAmount: 0, remnantAmount: 100, processStatus: 0, processStatusDisplay: "未开始"
        }
      ]
    }), { status: 200 });
  });

  const processes = await client.listWorkOrderProcesses(
    "https://liteapp.blacklake.cn/pages/index/workOrderDetail/index?id=123059181"
  );
  assert.deepEqual(requestBody, { projectIds: [123059181], page: { pageNum: 1, pageSize: 100 } });
  assert.deepEqual(processes.map((item) => item.processName), ["切割", "包装"]);
  assert.equal(processes[0].defaultReportAmount, 100);
  assert.equal(processes[0].quantitySource, "PLAN_AMOUNT");
  assert.equal(processes[1].defaultReportAmount, 100);
  assert.equal(processes[1].quantitySource, "PLAN_AMOUNT");
  const selected = await client.findWorkOrderProcess(
    "https://liteapp.blacklake.cn/pages/index/workOrderDetail/index?id=123059181",
    880101
  );
  assert.equal(selected.processName, "切割");
  assert.equal(queryCount, 1);
});

test("黑湖客户端按文档格式登录，并将 data 字符串作为 X-AUTH Token", async () => {
  const calls = [];
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "",
    loginPath: "/api/user/v1/users/_login", loginType: "1", client: "lite-web",
    factoryCode: "991762", account: "api-user", password: "secret", phone: "",
    outputQueryPath: "/api/dytin/external/output/queryList3", timeoutMs: 1000
  }, async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    if (url.endsWith("/_login")) {
      return new Response(JSON.stringify({ statusCode: 200, message: "成功", data: "TOKEN-123" }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "01000000", message: "成功", data: { list: [] } }), { status: 200 });
  });

  await client.queryOutputs({ projectCode: "GD-1" });
  assert.deepEqual(calls[0].body, {
    type: "1", code: "991762", username: "api-user",
    password: "9817fd4e8ae39d6e41532989e4422c5a7e46411dab4d2fdfa2270dad"
  });
  assert.equal(calls[0].headers["X-CLIENT"], "lite-web");
  assert.equal(calls[1].headers["X-AUTH"], "TOKEN-123");
  assert.deepEqual(calls[1].body, { projectCode: "GD-1", page: { pageNum: 1, pageSize: 100 } });
});

test("黑湖客户端手机号登录同时发送 phone、username 和 password，且不发送 type", async () => {
  let loginBody;
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "",
    loginPath: "/api/user/v1/users/_login", loginType: "2", client: "lite-web",
    factoryCode: "", account: "api-user", phone: "13800138000", password: "secret",
    outputQueryPath: "/api/dytin/external/output/queryList3", timeoutMs: 1000
  }, async (url, options) => {
    if (url.endsWith("/_login")) {
      loginBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ statusCode: 200, data: "TOKEN-PHONE" }), { status: 200 });
    }
    return new Response(JSON.stringify({ statusCode: 200, data: { list: [] } }), { status: 200 });
  });

  await client.queryOutputs({});
  assert.deepEqual(loginBody, {
    phone: "13800138000", username: "api-user",
    password: "9817fd4e8ae39d6e41532989e4422c5a7e46411dab4d2fdfa2270dad"
  });
});

test("报工查询自动分页，并在业务 401 后重新登录一次", async () => {
  let loginCount = 0;
  const pageNumbers = [];
  let firstBusinessCall = true;
  const client = new BlacklakeClient({
    mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "",
    loginPath: "/api/user/v1/users/_login", loginType: "1", client: "lite-web",
    factoryCode: "991762", account: "api-user", password: "secret", phone: "",
    outputQueryPath: "/api/dytin/external/output/queryList3", timeoutMs: 1000
  }, async (url, options) => {
    if (url.endsWith("/_login")) {
      loginCount += 1;
      return new Response(JSON.stringify({ statusCode: 200, data: `TOKEN-${loginCount}` }), { status: 200 });
    }
    if (firstBusinessCall) {
      firstBusinessCall = false;
      return new Response(JSON.stringify({ code: "401", subCode: "USER_VERIFICATION_ERROR", msg: "用户认证失败" }), { status: 200 });
    }
    const page = JSON.parse(options.body).page.pageNum;
    pageNumbers.push(page);
    const list = page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
    return new Response(JSON.stringify({ statusCode: 200, data: { list } }), { status: 200 });
  });

  const outputs = await client.queryOutputs({}, { pageSize: 2 });
  assert.equal(loginCount, 2);
  assert.deepEqual(pageNumbers, [1, 2]);
  assert.deepEqual(outputs.map((item) => item.id), [1, 2, 3]);
});
