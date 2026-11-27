import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { BlacklakeClient } from "../src/blacklake-client.mjs";
import { WeeklyStore } from "../src/weekly-store.mjs";
import { resolveWeek, collectWeeklyData, buildLocalFinding, buildTaskFinding } from "../src/weekly-data.mjs";

const NOW = Date.parse("2026-10-22T04:00:00Z");
const currentStart = "2026-10-12 00:00:00";
const previousStart = "2026-10-05 00:00:00";
const output = (value, extra = {}) => ({ id: value, projectId: 7, projectCode: "TEST-WO", taskId: 11,
  productCode: "TEST-SKU", productName: "测试产品", processCode: "TEST-PROCESS", processName: "测试工序", stockUnit: "件",
  productionStaff: "测试员工",
  createdAt: "2026-10-13 10:00:00", workreportQuantity: 12, numberofgoodProducts: 10, numberofDefectives: 2, approvalStatus: 10, ...extra });
const task = (extra = {}) => ({ taskId: 11, projectId: 7, projectCode: "TEST-WO", processName: "测试工序", processCode: "TEST-PROCESS",
  plannedAmount: 100, reportedGoodAmount: 110, processStatus: 10, processStatusDisplay: "进行中", unit: "件", sequence: 1,
  quantityPresence: { plannedAmount: true, reportedGoodAmount: true }, dueDate: "2026-10-10", ...extra });

function fixture({ current = [], previous = [], tasks = [task()], queryOutputPage } = {}) {
  const store = new Store(":memory:", { sessionSecret: "weekly-data-tests", sessionDays: 30 });
  const operator = store.upsertBlacklakeOperator({ name: "不应输出个人姓名", blacklakeOperatorId: 1 });
  const calls = [];
  const blacklake = { config: { mode: "live" }, listProjectTasks: async () => tasks,
    queryOutputPage: async (filters, options) => {
      calls.push({ filters, options });
      if (queryOutputPage) return queryOutputPage(filters, options);
      const rows = filters.createdAtGte === currentStart ? current : previous;
      return { records: rows.slice((options.pageNum - 1) * options.pageSize, options.pageNum * options.pageSize), total: rows.length };
    } };
  const seed = (id, status, extra = {}) => {
    store.db.prepare(`INSERT INTO assignments(id, operator_id, task_id, project_id, project_code, product_name, process_name,
      quantity, min_duration_seconds, max_duration_seconds, status, published_at, started_at, ended_at, updated_at)
      VALUES (?, ?, 11, 7, 'TEST-WO', '测试产品', '测试工序', 100, 0, 2147483647, ?, '2000-01-01 09:00:00', '2026-10-20 09:00:00', ?, ?)`)
      .run(id, operator.id, status, extra.endedAt ?? "2026-10-20 10:00:00", extra.updatedAt ?? "2026-10-20 02:00:00");
  };
  return { store, blacklake, calls, seed, run: (options = {}) => collectWeeklyData({ blacklake, store, now: () => NOW, ...options }), close: () => store.close() };
}

test("周边界按上海周一，默认上个完整自然周，拒绝非周一、未来周及不存在日期", () => {
  const period = resolveWeek(undefined, NOW);
  assert.equal(period.startDate, "2026-10-12");
  assert.equal(period.endDate, "2026-10-19");
  assert.equal(period.start, "2026-10-12T00:00:00.000+08:00");
  assert.equal(period.isPartial, false);
  assert.equal(period.basis, "createdAt");
  assert.equal(resolveWeek("2026-10-19", NOW).isPartial, true);
  for (const input of ["2026-10-20", "2026-10-26", "2026-02-30", "2026-10-12T00:00:00", "invalid"]) assert.throws(() => resolveWeek(input, NOW), { code: "INVALID_WEEK" });
  assert.equal(resolveWeek(undefined, Date.parse("2026-10-18T16:00:00Z")).startDate, "2026-10-12");
});

test("严格报工单页识别合法空列表，异常结构不能冒充空结果，旧queryOutputs契约保留", async () => {
  let body = { data: { list: [], total: 0 } };
  const client = new BlacklakeClient({ mode: "live", baseUrl: "https://example.invalid", staticToken: "test-only", outputQueryPath: "/outputs", timeoutMs: 1000 }, async () => new Response(JSON.stringify(body)));
  assert.deepEqual(await client.queryOutputPage({}, { pageNum: 1, pageSize: 100 }), { records: [], total: 0, pageNum: 1, pageSize: 100 });
  for (const invalid of [{ data: {} }, { data: { list: {} } }, { data: { list: [null] } }, { data: { list: [], total: "bad" } }]) {
    body = invalid;
    await assert.rejects(client.queryOutputPage(), { code: "BLACKLAKE_OUTPUT_PAGE_FORMAT" });
  }
  await assert.rejects(client.queryOutputPage({}, { pageNum: 0 }), { code: "INVALID_OUTPUT_PAGE" });
  body = { data: { list: [{ id: 1 }] } };
  assert.deepEqual(await client.queryOutputs({}), [{ id: 1 }]);
});

test("完整分页、半开创建时间和按产品工序单位统计，数量不跨工序合计", async () => {
  const current = Array.from({ length: 100 }, (_, i) => output(i + 1, { createdAt: `2026-10-13 10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}` }));
  current.push(output(101, { processCode: "SECOND", numberofgoodProducts: 5, workreportQuantity: 5, numberofDefectives: 0 }));
  current.push(output(102, { createdAt: "2026-10-19 00:00:00" }));
  const f = fixture({ current, previous: [output(999, { createdAt: "2026-10-06 10:00:00", numberofgoodProducts: 0, workreportQuantity: 0, numberofDefectives: 0 })] });
  try {
    const result = await f.run();
    assert.equal(result.coverage.current.complete, true);
    assert.equal(result.coverage.current.pages, 2);
    assert.equal(result.coverage.current.rawCount, 102);
    assert.equal(result.coverage.current.inRangeCount, 101);
    assert.equal(result.coverage.current.outsideRangeCount, 1);
    assert.equal(result.metrics.current.recordCount, 101);
    assert.equal(result.metrics.current.projectCount, 1);
    assert.equal(result.metrics.current.groups.length, 2);
    assert.equal(result.metrics.current.groups[0].goodQuantity, 1000);
    assert.equal("totalFinishedGoods" in result.metrics.current, false);
    assert.equal(result.metrics.comparison.groups[0].percentChange, null);
    assert.match(result.metrics.comparison.groups[0].note, /基数为零/);
    assert.equal(result.progress[0].closed, false);
    assert.match(result.progress[0].timeMeaning, /不是.*历史状态/);
    assert.equal(result.findings.some((item) => item.kind === "quantity_over_plan"), true);
    assert.equal(result.findings.some((item) => /延期/.test(item.title)), false);
    assert.ok(result.sources.every((source) => source.queriedAt && source.url.startsWith("/admin?")));
    assert.doesNotMatch(JSON.stringify(result), /不应输出个人姓名/);
  } finally { f.close(); }
});

test("本周部分区间与前周相同已过时长比较，不把整周当同期", async () => {
  const f = fixture();
  try {
    const result = await f.run({ startDate: "2026-10-19" });
    assert.equal(result.period.isPartial, true);
    assert.equal(result.coverage.current.range.end, "2026-10-22T12:00:00.000+08:00");
    assert.equal(result.coverage.previous.range.end, "2026-10-15T12:00:00.000+08:00");
    assert.match(result.metrics.comparison.basis, /相同时长/);
    assert.equal(result.metrics.comparison.durationSeconds, 3.5 * 86400);
    assert.deepEqual(f.calls.map((call) => call.filters.createdAtGte).sort(), [currentStart, "2026-10-19 00:00:00"]);
  } finally { f.close(); }
});

test("缺ID、错误时间、冲突重复记录都降级完整性，未知数量不当零", async () => {
  const f = fixture({ current: [output(1), output(1, { numberofgoodProducts: 11 }), output(null), output(2, { createdAt: "bad" }),
    output(3, { numberofgoodProducts: null, approvalStatus: null, productionStaff: "secret-person", token: "secret-token" })] });
  try {
    const result = await f.run();
    assert.equal(result.coverage.current.complete, false);
    assert.equal(result.coverage.current.conflictingIdCount, 1);
    assert.equal(result.coverage.current.missingIdCount, 1);
    assert.equal(result.coverage.current.invalidTimeCount, 1);
    assert.equal(result.metrics.current.recordCount, 1);
    assert.equal(result.metrics.current.groups[0].goodQuantity, null);
    assert.equal(result.metrics.current.unknownApprovalCount, 1);
    assert.equal(result.metrics.comparison.available, false);
    assert.equal(result.findings.some((item) => item.kind === "duplicate_output_id"), true);
    assert.doesNotMatch(JSON.stringify(result), /secret-person|secret-token/);
  } finally { f.close(); }
});

test("第二页失败保留部分证据但暂停环比，未知响应不能变成完整空周", async () => {
  const f = fixture({ queryOutputPage: async (filters, { pageNum }) => {
    if (filters.createdAtGte === previousStart) return { wrong: [] };
    if (pageNum === 2) throw new Error("private upstream details");
    return { records: Array.from({ length: 100 }, (_, i) => output(i + 1)) };
  } });
  try {
    const result = await f.run();
    assert.equal(result.coverage.current.complete, false);
    assert.equal(result.coverage.current.pages, 1);
    assert.equal(result.metrics.current.recordCount, 100);
    assert.equal(result.coverage.previous.complete, false);
    assert.equal(result.metrics.comparison.available, false);
    assert.doesNotMatch(JSON.stringify(result), /private upstream details/);
  } finally { f.close(); }
});

test("上游重复同页提前停止，声明总数矛盾与页数上限均不能伪完整", async () => {
  for (const behavior of ["repeat", "total", "limit"]) {
    let currentCalls = 0;
    const f = fixture({ queryOutputPage: async (filters, { pageNum }) => {
      if (filters.createdAtGte === previousStart) return { records: [] };
      currentCalls++;
      if (behavior === "total") return { records: [output(1)], total: 99 };
      return { records: Array.from({ length: 100 }, (_, i) => output((behavior === "repeat" ? 0 : pageNum * 100) + i + 1)) };
    } });
    try {
      const result = await f.run();
      assert.equal(result.coverage.current.complete, false);
      assert.equal(result.coverage.current.terminal, behavior === "repeat" ? "repeated-page" : behavior === "limit" ? "page-limit" : "short-page");
      assert.equal(currentCalls, behavior === "repeat" ? 2 : behavior === "limit" ? 200 : 1);
      assert.ok(result.coverage.current.warnings.length);
    } finally { f.close(); }
  }
});

test("本地超过300笔未处理任务全量计数，展示截断显式说明且待核量不计产量", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 305; i++) f.seed(`pending-${i}`, "QUANTITY_PENDING");
    f.seed("old-review", "NEEDS_REVIEW");
    f.seed("recent-review", "NEEDS_REVIEW", { endedAt: "2026-10-22 11:00:00" });
    const result = await f.run();
    assert.equal(result.coverage.local.complete, true);
    assert.equal(result.coverage.local.scannedCount, 307);
    assert.equal(result.coverage.local.quantityPendingCount, 305);
    assert.equal(result.coverage.local.needsReviewCount, 2);
    assert.equal(result.coverage.local.needsReviewOver24hCount, 1);
    assert.equal(result.metrics.current.recordCount, 0);
    assert.equal(result.coverage.findingsTotal, 307);
    assert.equal(result.coverage.findingsReturned, 40);
    assert.equal(result.coverage.findingsTruncated, true);
    assert.equal(result.findings[0].kind, "needs_review_over_24h");
    assert.match(result.findings.find((item) => item.kind === "quantity_pending").facts[0], /人员和工位已释放/);
  } finally { f.close(); }
});

test("纯函数异常规则可用于详情复核，数量缺失/仅达标/未知状态不推断交付或延期", () => {
  assert.equal(buildTaskFinding(task({ plannedAmount: null }), NOW), null);
  assert.equal(buildTaskFinding(task({ reportedGoodAmount: 100 }), NOW), null);
  assert.equal(buildTaskFinding(task({ quantityPresence: { plannedAmount: false } }), NOW), null);
  assert.equal(buildTaskFinding(task(), NOW).kind, "quantity_over_plan");
  assert.equal(buildLocalFinding({ id: "a", status: "NEEDS_REVIEW", endedAt: "2026-10-21 12:00:00" }, NOW), null);
  assert.equal(buildLocalFinding({ id: "a", status: "NEEDS_REVIEW", endedAt: "2026-10-20 12:00:00" }, NOW).kind, "needs_review_over_24h");
  assert.equal(buildLocalFinding({ id: "a", status: "QUANTITY_PENDING" }, NOW).key, "quantity-pending:a");
});

test("307笔待核量不会挤掉疑似重复和超计划线索，各来源计数保留完整值", async () => {
  const f = fixture({ current: [output(1), output(2, { createdAt: "2026-10-13 10:04:00" })] });
  try {
    for (let i = 0; i < 307; i++) f.seed(`pending-${i}`, "QUANTITY_PENDING");
    f.seed("old-review", "NEEDS_REVIEW");
    const result = await f.run();
    assert.deepEqual(result.findings.slice(0, 3).map((item) => item.kind), ["needs_review_over_24h", "possible_duplicate_output", "quantity_over_plan"]);
    assert.equal(result.coverage.local.quantityPendingCount, 307);
    assert.equal(result.coverage.local.findingsTotal, 308);
    assert.equal(result.coverage.tasks.findingsTotal, 1);
    assert.equal(result.coverage.findingsTotal, 310);
    assert.equal(result.coverage.findingsReturned, 40);
    assert.equal(result.coverage.findingsTruncated, true);
    assert.equal(result.findings.filter((item) => item.kind === "quantity_pending").length, 37);
    assert.equal(result.metrics.current.recordCount, 2);
  } finally { f.close(); }
});

test("疑似重复独立取样，超过展示上限时仍统计所有分组", async () => {
  const current = Array.from({ length: 45 }, (_, index) => [output(index * 2 + 1, { numberofgoodProducts: index }),
    output(index * 2 + 2, { numberofgoodProducts: index, createdAt: "2026-10-13 10:04:00" })]).flat();
  const f = fixture({ current, tasks: Array.from({ length: 45 }, (_, index) => task({ taskId: index + 1 })) });
  try {
    for (let i = 0; i < 50; i++) f.seed(`pending-${i}`, "QUANTITY_PENDING");
    const result = await f.run();
    assert.equal(result.coverage.local.findingsTotal, 50);
    assert.equal(result.coverage.tasks.findingsTotal, 45);
    assert.equal(result.coverage.findingsTotal, 140);
    assert.equal(result.findings.length, 40);
    assert.ok(result.findings.every((item) => item.kind === "possible_duplicate_output"));
    assert.equal(result.coverage.findingsTruncated, true);
  } finally { f.close(); }
});

test("疑似同人员重复使用已知姓名与5分钟弱线索，不推断唯一身份；停止信号不启动查询", async () => {
  const f = fixture({ current: [output(1), output(2, { createdAt: "2026-10-13 10:04:00" }), output(3, { productionStaff: "另一员工" }), output(4, { productionStaff: "" }), output(5, { createdAt: "2026-10-13 10:10:00" })] });
  try {
    const result = await f.run();
    const duplicate = result.findings.find((item) => item.kind === "possible_duplicate_output");
    assert.ok(duplicate);
    assert.match(duplicate.facts[0], /5分钟/);
    assert.match(duplicate.facts[1], /姓名相同不等于同一人/);
    assert.match(duplicate.possibleCauses[0], /同名人员/);
    assert.equal(duplicate.evidence.filter((row) => row.recordId).length, 2);
    assert.equal(duplicate.evidence[0].productionStaff, "测试员工");
    assert.deepEqual(duplicate.evidence.filter((row) => row.recordId).map((row) => row.recordId), ["1", "2"]);
    assert.equal(duplicate.evidence.find((row) => row.evidenceType === "group_summary").recordCount, 2);
    assert.equal(result.findings.filter((item) => item.kind === "possible_duplicate_output").length, 1);
    const count = f.calls.length;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.run({ signal: controller.signal }), { name: "AbortError" });
    assert.equal(f.calls.length, count);
  } finally { f.close(); }
});

test("重复组超过5条展示样本后新增成员仍重开核查，读取顺序变化不重开", async () => {
  const current = Array.from({ length: 6 }, (_, index) => output(index + 1));
  const f = fixture({ current });
  const records = new WeeklyStore(f.store.db);
  const read = async () => (await f.run()).findings.find((item) => item.kind === "possible_duplicate_output");
  const confirm = (item) => records.feedbackFinding(item.key, { revision: item.revision, status: "CONFIRMED_NORMAL", reason: "OTHER", note: "已核对当前成员" }, "test-reviewer");
  try {
    const first = await read();
    const saved = confirm(records.upsertFindings([first])[0]);
    current.push(output(7));
    const next = await read();
    assert.deepEqual(first.evidence.slice(0, 5), next.evidence.slice(0, 5));
    assert.equal(next.evidence.find((row) => row.evidenceType === "group_summary").recordCount, 7);
    const reopened = records.upsertFindings([next])[0];
    assert.equal(reopened.status, "INVESTIGATING");
    assert.equal(reopened.revision, saved.revision + 1);
    assert.notEqual(reopened.evidenceVersion, saved.evidenceVersion);
    const confirmed = confirm(reopened);
    current.reverse();
    const reordered = records.upsertFindings([await read()])[0];
    assert.equal(reordered.revision, confirmed.revision);
    assert.equal(reordered.status, "CONFIRMED_NORMAL");
  } finally { f.close(); }
});

test("分页重复完整计数和样本外成员变化触发版本，摘要大小保持有界", async () => {
  const current = Array.from({ length: 6 }, (_, index) => [output(index + 1), output(index + 1)]).flat();
  const f = fixture({ current });
  const records = new WeeklyStore(f.store.db);
  const read = async () => (await f.run()).findings.find((item) => item.kind === "duplicate_output_id");
  const confirm = (item) => records.feedbackFinding(item.key, { revision: item.revision, status: "CONFIRMED_NORMAL", reason: "SYSTEM_ISSUE", note: "已核对当前分页问题" }, "test-reviewer");
  try {
    const first = await read();
    const saved = confirm(records.upsertFindings([first])[0]);
    current.push(output(7), output(7));
    const next = await read();
    assert.deepEqual(first.evidence.slice(0, 5), next.evidence.slice(0, 5));
    const summary = next.evidence.find((row) => row.evidenceType === "pagination_summary");
    assert.equal(summary.duplicateCount, 7);
    assert.match(summary.membersDigest, /^[a-f0-9]{64}$/);
    assert.equal(next.evidence.length, 6);
    const reopened = records.upsertFindings([next])[0];
    assert.equal(reopened.status, "INVESTIGATING");
    assert.equal(reopened.revision, saved.revision + 1);
    const confirmed = confirm(reopened);
    current.splice(-2, 2, output(8), output(8));
    const memberChanged = records.upsertFindings([await read()])[0];
    assert.equal(memberChanged.status, "INVESTIGATING");
    assert.equal(memberChanged.revision, confirmed.revision + 1);
  } finally { f.close(); }
});

test("未知单位不能合并为同单位数量，重复分页问题键带周起始日期", async () => {
  const f = fixture({ current: [output(1, { stockUnit: null }), output(2, { stockUnit: null }), output(3), output(3)], previous: [output(9, { createdAt: "2026-10-06 10:00:00" }), output(9, { createdAt: "2026-10-06 10:00:00" })] });
  try {
    const result = await f.run();
    const unknownGroups = result.metrics.current.groups.filter((group) => group.unit === "未知单位");
    assert.equal(unknownGroups.length, 2);
    assert.ok(unknownGroups.every((group) => group.recordCount === 1));
    assert.ok(result.metrics.comparison.groups.every((group) => group.unit !== "未知单位" || (!group.comparable && group.change === null)));
    assert.deepEqual(result.findings.filter((item) => item.kind === "duplicate_output_id").map((item) => item.key), ["duplicate-id:2026-10-12", "duplicate-id:2026-10-05"]);
  } finally { f.close(); }
});

test("空白数量、对象单位、未证实审批字段和非法日历时间不会被强制解释为有效数据", async () => {
  const f = fixture({ current: [output(1, { numberofgoodProducts: " ", stockUnit: {}, approvalStatus: undefined, approveStatus: 10 }), output(2, { createdAt: "2026-02-30T10:00:00Z" })] });
  try {
    const result = await f.run();
    assert.equal(result.metrics.current.groups[0].goodQuantity, null);
    assert.equal(result.metrics.current.groups[0].unit, "未知单位");
    assert.equal(result.metrics.current.unknownApprovalCount, 1);
    assert.equal(result.coverage.current.invalidTimeCount, 1);
  } finally { f.close(); }
});

test("取数中停止会中断等待，不继续查询本地任务或工序", async () => {
  const controller = new AbortController();
  const f = fixture({ queryOutputPage: () => new Promise(() => {}) });
  let taskCalls = 0;
  f.blacklake.listProjectTasks = async () => { taskCalls++; return []; };
  try {
    const pending = f.run({ signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(taskCalls, 0);
  } finally { f.close(); }
});

test("工序读取失败与缺工单关联均不声称路线完整，输出数量与异常证据受限", async () => {
  const f = fixture({ current: [output(1)], tasks: [] });
  try {
    const result = await f.run();
    assert.equal(result.coverage.tasks.complete, false);
    assert.deepEqual(result.progress, []);
    assert.match(result.coverage.tasks.warnings.join(" "), /未返回工序/);
    f.blacklake.listProjectTasks = async () => { throw new Error("private task detail"); };
    const unavailable = await f.run();
    assert.equal(unavailable.coverage.tasks.complete, false);
    assert.doesNotMatch(JSON.stringify(unavailable), /private task detail/);
  } finally { f.close(); }
});
