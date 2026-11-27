import test from "node:test";
import assert from "node:assert/strict";
import { createProductionTools } from "../src/agent-tools.mjs";
import { BlacklakeClient } from "../src/blacklake-client.mjs";
import { AdminSync } from "../src/admin-sync.mjs";

const NOW = Date.parse("2026-10-22T04:00:00Z");
const timestamp = new Date(NOW).toISOString();
const task = (id, changes = {}) => ({
  projectId: 7, taskId: id, projectCode: "GD-2026-7", productName: "产品", processName: `工序${id}`,
  sequence: id, plannedAmount: 100, reportedGoodAmount: 40, reportedDefectAmount: 0,
  processStatus: 10, processStatusDisplay: "进行中", unit: "件",
  quantityPresence: { sequence: true, plannedAmount: true, reportedGoodAmount: true, reportedDefectAmount: true }, ...changes
});
function fixture({ tasks = [task(1)], syncStatus = "fresh", updatedAt = timestamp, assignments = [], blacklake = {}, store = {}, timeoutMs } = {}) {
  const client = { config: { mode: "live" }, searchWorkOrdersBySku: async () => [], listProjectTasks: async () => [], ...blacklake };
  const storage = { listAssignments: () => assignments, activeAssignmentsByUnit: () => [], ...store };
  const tools = createProductionTools({ blacklake: client, store: storage,
    adminSync: { processes: async () => [{ tasks, sync: { status: syncStatus, updatedAt } }] }, now: () => NOW, timeoutMs });
  return { tools, client, storage, run: (name, input = {}, options = {}) => tools[name].execute(input, options) };
}

test("工具白名单不包含派单、报工、SQL或任意请求，参数越界不调用业务层", async () => {
  let calls = 0;
  const f = fixture({ blacklake: { searchWorkOrdersBySku: async () => { calls++; return []; } } });
  assert.deepEqual(Object.keys(f.tools), ["searchWorkOrders", "getWorkOrderProgress", "getProductionSnapshot", "listNeedsReview", "explainProductionRules"]);
  assert.equal((await f.run("searchWorkOrders", { kind: "sku", query: "A", limit: 500 })).status, "invalid_input");
  assert.equal((await f.run("searchWorkOrders", { kind: "sku", query: "A", url: "https://evil.invalid" })).status, "invalid_input");
  assert.equal((await f.run("getWorkOrderProgress", { projectId: -1 })).status, "invalid_input");
  assert.equal(calls, 0);
});

test("同工序按任务去重，不把跨工序累计相加，数量达标不推断关闭或交付", async () => {
  const f = fixture({ tasks: [task(1, { reportedGoodAmount: 100 }), task(1, { reportedGoodAmount: 100 }), task(2, { reportedGoodAmount: 120 })] });
  const result = await f.run("getWorkOrderProgress", { projectId: 7 });
  assert.equal(result.data.summary.processCount, 2);
  assert.equal(result.data.summary.allProcessesClosed, false);
  assert.equal(result.data.summary.totalFinishedGoods, null);
  assert.equal(result.data.summary.delivered, null);
  assert.equal(result.data.summary.lastProcessQuantityProgress.reportedGoodAmount, 120);
  assert.equal(result.data.processes[1].quantityCompletionPercent, 120);
  assert.equal(result.data.processes[1].remainingToPlan, 0);
});

test("显式零、字段缺失和无完整性标记的旧零值保持区别", async () => {
  const f = fixture({ tasks: [task(1, { reportedGoodAmount: 0 }), task(2, { reportedGoodAmount: 0, quantityPresence: { sequence: true, plannedAmount: true, reportedGoodAmount: false } }), task(3, { reportedGoodAmount: 0, quantityPresence: undefined })] });
  const result = await f.run("getWorkOrderProgress", { projectId: 7 });
  assert.deepEqual(result.data.processes.map((row) => row.reportedGoodAmount), [0, null, null]);
  assert.deepEqual(result.data.processes.map((row) => row.remainingToPlan), [100, null, null]);
  assert.deepEqual(result.data.processes.map((row) => row.quantityCompletionPercent), [0, null, null]);
  assert.match(result.warnings.join(" "), /未知/);
});

test("末道并行或工序顺序未知时不推断整单进度，关闭状态只来自黑湖", async () => {
  for (const tasks of [[task(1, { sequence: 2 }), task(2, { sequence: 2 })], [task(1, { sequence: 0, quantityPresence: {} })]]) {
    assert.equal((await fixture({ tasks }).run("getWorkOrderProgress", { projectId: 7 })).data.summary.lastProcessQuantityProgress, null);
  }
  const closed = await fixture({ tasks: [task(1, { processStatus: 20, reportedGoodAmount: 30 })] }).run("getWorkOrderProgress", { projectId: 7 });
  assert.equal(closed.data.summary.allProcessesClosed, true);
  assert.equal(closed.data.processes[0].quantityCompletionPercent, 30);
  assert.equal(closed.data.summary.delivered, null);
});

test("空、不可用、滞后快照不伪装为零进度或当前完整事实", async () => {
  for (const status of ["empty", "unavailable"]) {
    const result = await fixture({ tasks: [], syncStatus: status, updatedAt: null }).run("getWorkOrderProgress", { projectId: 7 });
    assert.equal(result.data.summary, null);
    assert.equal(result.freshness.updatedAt, null);
    assert.equal(result.freshness.ageSeconds, null);
    assert.match(result.completeness, /未知|不可用/);
  }
  const stale = await fixture({ syncStatus: "stale", updatedAt: new Date(NOW - 120_000).toISOString() }).run("getWorkOrderProgress", { projectId: 7 });
  assert.equal(stale.freshness.ageSeconds, 120);
  assert.equal(stale.freshness.upstreamCacheWindowSeconds, 30);
  assert.match(stale.sources[0].scope, /stale.*120 秒/);
  assert.match(stale.completeness, /滞后/);
});

test("别的工单与冲突任务不混入，完整性降级", async () => {
  const result = await fixture({ tasks: [task(1), task(1, { reportedGoodAmount: 90 }), task(2, { projectId: 8 }), task(3)] }).run("getWorkOrderProgress", { projectId: 7 });
  assert.deepEqual(result.data.processes.map((row) => row.taskId), [3]);
  assert.equal(result.data.summary.allProcessesClosed, null);
  assert.equal(result.data.summary.lastProcessQuantityProgress, null);
  assert.match(result.completeness, /部分/);
});

test("真实客户端完整分页路径保留已关闭工序，输出截断不缩小总工序数", async () => {
  const pages = [];
  const client = new BlacklakeClient({ mode: "live", baseUrl: "https://example.invalid", staticToken: "test-token", taskQueryPath: "/tasks", timeoutMs: 1000 }, async (_url, options) => {
    const input = JSON.parse(options.body); pages.push(input.page.pageNum);
    const count = input.page.pageNum === 1 ? 100 : 1;
    const list = Array.from({ length: count }, (_, i) => ({ id: (input.page.pageNum - 1) * 100 + i + 1, projectId: 7, seq: (input.page.pageNum - 1) * 100 + i + 1, processStatus: 20, planAmount: 100, fineAmount: 0 }));
    return new Response(JSON.stringify({ code: "01000000", data: { list } }));
  });
  const tools = createProductionTools({ blacklake: client, store: {}, adminSync: new AdminSync(client, { now: () => NOW, log: () => {} }), now: () => NOW });
  const result = await tools.getWorkOrderProgress.execute({ projectId: 7 }, {});
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.data.summary.processCount, 101);
  assert.equal(result.data.summary.closedProcessCount, 101);
  assert.equal(result.data.processes.length, 60);
  assert.equal(result.data.processes[0].reportedGoodAmount, 0);
  assert.equal(result.data.processes[0].quantityCompletionPercent, 0);
  assert.match(result.completeness, /展示列表已截断/);
});

test("真实字段映射保留明确的零，缺失计划与良品不因原默认零而生成进度", async () => {
  const client = new BlacklakeClient({ mode: "live", baseUrl: "https://example.invalid", staticToken: "test-token", taskQueryPath: "/tasks", timeoutMs: 1000 }, async () => new Response(JSON.stringify({ code: "01000000", data: { list: [
    { id: 1, projectId: 7, seq: 1, planAmount: 100, fineAmount: 0 },
    { id: 2, projectId: 7, seq: 2, planAmount: 100 },
    { id: 3, projectId: 7, fineAmount: 30 }
  ] } })));
  const tools = createProductionTools({ blacklake: client, store: {}, adminSync: new AdminSync(client, { now: () => NOW, log: () => {} }), now: () => NOW });
  const result = await tools.getWorkOrderProgress.execute({ projectId: 7 }, {});
  assert.deepEqual(result.data.processes.map((row) => row.reportedGoodAmount), [0, null, 30]);
  assert.deepEqual(result.data.processes.map((row) => row.plannedAmount), [100, 100, null]);
  assert.deepEqual(result.data.processes.map((row) => row.quantityCompletionPercent), [0, null, null]);
  assert.equal(result.data.summary.lastProcessQuantityProgress, null);
});

test("第二页失败不把第一页当成完整路线，不暴露上游错误内容", async () => {
  const client = new BlacklakeClient({ mode: "live", baseUrl: "https://example.invalid", staticToken: "private-test-token", taskQueryPath: "/tasks", timeoutMs: 1000 }, async (_url, options) => {
    const page = JSON.parse(options.body).page.pageNum;
    if (page === 2) throw new Error("private-test-token secret upstream");
    return new Response(JSON.stringify({ code: "01000000", data: { list: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, projectId: 7, seq: i + 1 })) } }));
  });
  const tools = createProductionTools({ blacklake: client, store: {}, adminSync: new AdminSync(client, { now: () => NOW, log: () => {} }), now: () => NOW });
  const result = await tools.getWorkOrderProgress.execute({ projectId: 7 }, {});
  assert.equal(result.status, "unavailable");
  assert.equal(result.data.summary, null);
  assert.deepEqual(result.data.processes, []);
  assert.doesNotMatch(JSON.stringify(result), /private-test-token|secret upstream/);
});

test("SKU搜索保留年份范围、旧目录年龄和截断信息，过滤不匹配数据", async () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({ projectId: i + 1, projectCode: `GD-2026-${i}`, productCode: "A-1", productName: "产品" }));
  rows.push({ projectId: 99, productCode: "OTHER" });
  const result = await fixture({ blacklake: { workOrderCatalog: { expiresAt: NOW - 1000 }, searchWorkOrdersBySku: async () => rows } }).run("searchWorkOrders", { kind: "sku", query: " a-1 ", limit: 5 });
  assert.equal(result.data.matchCount, 24);
  assert.equal(result.data.workOrders.length, 5);
  assert.equal(result.freshness.status, "stale");
  assert.equal(result.freshness.ageSeconds, 601);
  assert.match(result.scope, /2026.*2025/);
  assert.match(result.completeness, /截断/);
});

test("同一工单编号多项目不能擅自归为单工单，精确匹配避免串单", async () => {
  const result = await fixture({ blacklake: { listProjectTasks: async () => [task(1), task(2), task(3, { projectId: 8 }), task(4, { projectCode: "OTHER" })] } }).run("searchWorkOrders", { kind: "workOrder", query: "GD-2026-7" });
  assert.deepEqual(result.data.workOrders.map((row) => row.projectId), [7, 8]);
  assert.equal(result.data.matchCount, 2);
  assert.match(result.warnings.join(" "), /多个 projectId/);
});

test("模拟数据及未知模式明确标注，来源仅为受控页面且不携带个人身份", async () => {
  for (const mode of ["mock", "unknown"]) {
    const item = { id: "a", status: "NEEDS_REVIEW", operatorName: "secret-person", operatorPhoneLast4: "9876", sessionToken: "secret-token" };
    const result = await fixture({ blacklake: { config: { mode } }, assignments: [item] }).run("listNeedsReview", {});
    assert.equal(result.mode, mode);
    assert.match(result.warnings[0], /不能作为正式生产事实/);
    assert.doesNotMatch(JSON.stringify(result), /secret-person|9876|secret-token/);
    assert.equal(result.sources[0].url, "/admin?view=audit");
    assert.equal(typeof result.sources[0].scope, "string");
    assert.equal(typeof result.sources[0].completeness, "string");
  }
});

test("现场位置按别名去重、保留待开始与待核对状态，不引入库存与在线推断", async () => {
  const result = await fixture({ store: { activeAssignmentsByUnit: (id) => ["3F-01", "MACHINE-01", "01"].includes(id) ? [{ id: "same", status: "READY", machineId: "3F-01" }] : id === "3F-02" ? [{ id: "review", status: "NEEDS_REVIEW" }] : [] } }).run("getProductionSnapshot", { floor: "3" });
  assert.equal(result.data.unitCount, 12);
  assert.equal(result.data.units[0].assignmentCount, 1);
  assert.equal(result.data.units[0].state, "scheduled");
  assert.equal(result.data.units[1].state, "attention");
  assert.equal(result.data.stateCounts.available, 10);
  assert.equal(result.data.warehouse.connected, false);
  assert.match(result.warnings.join(" "), /不等于设备在线/);
});

test("待核量释放现场占用，新任务独立展示，上游结果未知仍需核对", async () => {
  const pending = { id: "quantity-pending", stationName: "A-03", status: "QUANTITY_PENDING", targetQuantity: 100, endedAt: "2026-10-22 10:00:00" };
  const unknown = { id: "upstream-unknown", stationName: "A-04", status: "NEEDS_REVIEW" };
  const assignments = [pending, unknown];
  const f = fixture({ assignments, store: {
    activeAssignmentsByUnit: (id) => assignments.filter((item) => item.stationName === id)
  } });
  const snapshot = await f.run("getProductionSnapshot", { floor: "8" });
  const unit = snapshot.data.units.find((item) => item.id === "A-03");
  assert.equal(unit.state, "available");
  assert.equal(unit.assignmentCount, 0);
  assert.deepEqual(unit.assignments, []);
  assert.equal(snapshot.data.stateCounts.attention, 1);
  assert.match(snapshot.warnings.join(" "), /待核量.*释放占用/);
  assignments.push({ id: "next-job", stationName: "A-03", status: "IN_PROGRESS" });
  const nextSnapshot = await f.run("getProductionSnapshot", { floor: "8" });
  const nextUnit = nextSnapshot.data.units.find((item) => item.id === "A-03");
  assert.equal(nextUnit.state, "running");
  assert.equal(nextUnit.assignmentCount, 1);
  assert.deepEqual(nextUnit.assignments.map((item) => item.assignmentId), ["next-job"]);
  const reviews = await f.run("listNeedsReview");
  assert.equal(reviews.data.needsReviewInScope, 1);
  assert.deepEqual(reviews.data.assignments.map((item) => item.assignmentId), [unknown.id]);
  assert.equal(reviews.data.assignments[0].quantityPending, false);
  assert.equal(reviews.data.automaticRetryAllowed, false);
});

test("现场明细总量受限但位置状态和数量仍涵盖全部读取结果", async () => {
  const result = await fixture({ store: { activeAssignmentsByUnit: (id) => id.startsWith("3F-") || id.startsWith("A-") || id.startsWith("B-") ? Array.from({ length: 12 }, (_, i) => ({ id: `${id}-${i}`, status: "READY" })) : [] } }).run("getProductionSnapshot", { floor: "all" });
  assert.equal(result.data.unitCount, 36);
  assert.equal(result.data.units.reduce((sum, row) => sum + row.assignments.length, 0), 40);
  assert.equal(result.data.units[0].assignmentCount, 12);
  assert.ok(result.data.units.some((row) => row.truncated));
});

test("待核对仅扫描最近300笔，不能把范围内零条说成全厂无待核对", async () => {
  let requestedLimit;
  const items = Array.from({ length: 301 }, (_, i) => ({ id: String(i), status: i === 300 ? "NEEDS_REVIEW" : "COMPLETED" }));
  const result = await fixture({ store: { listAssignments: (limit) => { requestedLimit = limit; return items; } } }).run("listNeedsReview", {});
  assert.equal(requestedLimit, 301);
  assert.equal(result.data.scannedCount, 300);
  assert.equal(result.data.needsReviewInScope, 0);
  assert.equal(result.data.automaticRetryAllowed, false);
  assert.match(result.completeness, /限定范围/);
  assert.match(result.warnings.join(" "), /可能不在范围/);
});

test("上游异常与超时返回未知而非空成功，停止信号不会再执行工具", async () => {
  const failed = await fixture({ blacklake: { searchWorkOrdersBySku: async () => { throw new Error("sensitive-payload"); } } }).run("searchWorkOrders", { kind: "sku", query: "A" });
  assert.equal(failed.status, "unavailable"); assert.equal(failed.data, null);
  assert.doesNotMatch(JSON.stringify(failed), /sensitive-payload/);
  const timeout = await fixture({ timeoutMs: 5, blacklake: { searchWorkOrdersBySku: () => new Promise(() => {}) } }).run("searchWorkOrders", { kind: "sku", query: "A" });
  assert.equal(timeout.status, "unavailable"); assert.match(timeout.warnings.join(" "), /超过等待时间/);
  let calls = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(fixture({ blacklake: { searchWorkOrdersBySku: async () => { calls++; return []; } } }).run("searchWorkOrders", { kind: "sku", query: "A" }, { abortSignal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("规则说明不调用黑湖或本地业务存储，包含时间与写入不确定性边界", async () => {
  const unavailable = new Proxy({}, { get() { throw new Error("Rules must not query data"); } });
  const tools = createProductionTools({ blacklake: { config: { mode: "live" } }, store: unavailable, now: () => NOW });
  const result = await tools.explainProductionRules.execute({ topic: "all" }, {});
  assert.equal(result.source, "application_rules");
  assert.match(result.data.rules.time.join(" "), /不是净作业工时/);
  assert.match(result.data.rules.needsReview.join(" "), /禁止.*自动重试/);
});

test("真实工具schema接受quantityPending主题，单独调用与数量口径均说明8楼只登记不报产量", async () => {
  const unavailable = new Proxy({}, { get() { throw new Error("Rules must not query data"); } });
  const tools = createProductionTools({ blacklake: { config: { mode: "live" } }, store: unavailable, now: () => NOW });
  const ruleTool = tools.explainProductionRules;
  const input = ruleTool.inputSchema.parse({ topic: "quantityPending" });
  const pending = await ruleTool.execute(input, {});
  assert.equal(pending.status, "ok");
  assert.deepEqual(Object.keys(pending.data.rules), ["quantityPending"]);
  assert.match(pending.data.rules.quantityPending.join(" "), /没有向黑湖提交产量/);
  assert.match(pending.data.rules.quantityPending.join(" "), /释放人员和工位占用.*继续接单/);
  assert.match(pending.data.rules.quantityPending.join(" "), /后续核量提交尚未实现/);
  const quantity = await ruleTool.execute(ruleTool.inputSchema.parse({ topic: "quantity" }), {});
  assert.match(quantity.data.rules.quantity.join(" "), /8 楼派单.*只登记.*暂不向黑湖提交产量/);
  assert.match(quantity.data.rules.quantity.join(" "), /同批多人不得各自计入整批数量/);
  assert.match(quantity.data.rules.quantity.join(" "), /参考批次数不等于个人完成量/);
});
