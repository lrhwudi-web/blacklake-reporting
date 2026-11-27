import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function workspace() {
  let source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  // Execute the real application functions without starting authentication or timers.
  source = source.slice(0, source.lastIndexOf('  // Start the workspace after installing handlers.'));
  source += "globalThis.qa = { state, liveOrders, selectedOrder, formatDuration, render, loadAssignments, loadAudit, startAutoRefresh, syncEmbroideryMachines, csvText, processTable, exportOrder, analyticsData, analyticsModule, auditModule, filteredOrders, embroideryWorkspace, peopleModuleData, peopleTableRows, stationRecommendationGrid, secondaryModule, useDemo, ledgerProgress, recentLedgerRecords, reportingWorkspace, reviewPanel, recordDrawer };})();";
  const nodes = new Map();
  const listeners = new Map();
  const intervals = [];
  const context = vm.createContext({
    URLSearchParams, structuredClone, setTimeout, clearTimeout, clearInterval, setInterval(fn) { intervals.push(fn); return intervals.length; },
    document: { activeElement: null, querySelectorAll: () => [], addEventListener(name, handler) { listeners.set(name, handler); }, querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", addEventListener() {}, classList: { add() {}, remove() {} } });
      return nodes.get(selector);
    } },
    window: { location: { search: "" }, addEventListener() {} }, fetch: async () => ({ ok: true, json: async () => ({ assignments: [] }) })
  });
  vm.runInContext(source, context);
  return { ...context.qa, context, nodes, listeners, intervals };
}
const assignment = (code) => ({ id: code, projectCode: code, productName: code, taskId: code === "A" ? 1 : 2, operatorName: "工人", processName: "缝制", status: "COMPLETED", quantity: 5 });

test('后台返回相同数据时保留页面DOM，错误恢复与真实变化仍重新绘制',async()=>{
 const f=await workspace();let payload={assignments:[assignment('A')]};
 f.context.fetch=async()=>({ok:true,json:async()=>payload});
 await f.loadAssignments();
 const root=f.nodes.get('#app');let html=root.innerHTML,writes=0;
 Object.defineProperty(root,'innerHTML',{get:()=>html,set:v=>{html=v;writes++;}});
 await f.loadAssignments({preserveSelection:true});assert.equal(writes,0);
 f.state.syncWarning='刷新失败';await f.loadAssignments({preserveSelection:true});assert.equal(writes,1);
 payload={assignments:[assignment('B')]};await f.loadAssignments({preserveSelection:true});assert.equal(writes,2);assert.equal(f.state.orders[0].code,'B');
});

test('独立模块和隐藏页面不每分钟拉取整批工单，报工模块仍更新',async()=>{
 const f=await workspace();let calls=0;f.context.fetch=async()=>{calls++;return {ok:true,json:async()=>({assignments:[]})};};
 f.startAutoRefresh();
 for(const key of ['management','data-sync','task-recovery','weekly','dispatch-predictions','production']){f.state.activeModule=key;await f.intervals[0]();}
 assert.equal(calls,0);
 f.state.activeModule='report';await f.intervals[0]();assert.equal(calls,1);
 f.context.document.hidden=true;await f.intervals[0]();assert.equal(calls,1);
});

test("刷新排序改变时工单身份不改变", async () => {
  const { liveOrders } = await workspace();
  const before = liveOrders([assignment("A"), assignment("B")]);
  const after = liveOrders([assignment("B"), assignment("A")]);
  assert.equal(before[0].id, after[1].id);
  assert.notEqual(before[0].id, after[0].id);
});
test("相同工单编号但不同黑湖projectId不会串台账", async () => {
  const { liveOrders } = await workspace();
  const current = { ...assignment("test"), id: "current", projectId: 125393397, taskId: 695476001, processName: "运两边翅膀", quantity: 100 };
  const historical = { ...assignment("test"), id: "historical", projectId: 124919014, taskId: 692298157, processName: "外厂车缝", quantity: 150 };
  const workOrders = [
    { projectId: 125393397, projectCode: "test", processes: [{ taskId: 695476001, processName: "运两边翅膀", plannedAmount: 100 }] },
    { projectId: 124919014, projectCode: "test", processes: [{ taskId: 692298157, processName: "外厂车缝", plannedAmount: 150 }] }
  ];

  const orders = liveOrders([current, historical], workOrders);

  assert.equal(orders.length, 2);
  assert.deepEqual([...orders].map((order) => order.projectId).sort(), [124919014, 125393397]);
  assert.deepEqual([...orders.find((order) => order.projectId === 125393397).records].map((record) => record.id), ["current"]);
  assert.deepEqual([...orders.find((order) => order.projectId === 124919014).records].map((record) => record.id), ["historical"]);
});
test("缺少projectId的历史记录不会并入同编号的新工单", async () => {
  const { liveOrders } = await workspace();
  const current = { ...assignment("test"), id: "current", projectId: 125393397, taskId: 695476001 };
  const legacy = { ...assignment("test"), id: "legacy", projectId: null, taskId: 692298157 };
  const orders = liveOrders([current, legacy], [
    { projectId: 125393397, projectCode: "test", processes: [{ taskId: 695476001, processName: "新工序" }] },
    { projectId: null, projectCode: "test", processes: [] }
  ]);

  assert.equal(orders.length, 2);
  assert.deepEqual([...orders].map((order) => [...order.records].map((record) => record.id)), [["current"], ["legacy"]]);
});
test("空搜索保留左侧搜索框且不显示无关工单", async () => {
  const { state, liveOrders, selectedOrder, render, nodes } = await workspace();
  state.orders = liveOrders([assignment("A")]);
  state.search = "不存在";
  assert.equal(selectedOrder(), undefined);
  render();
  assert.match(nodes.get("#app").innerHTML, /id="order-search"/);
  assert.match(nodes.get("#app").innerHTML, /没有匹配的工单/);
  assert.doesNotMatch(nodes.get("#app").innerHTML, /class="detail-summary/);
});
test("不足一分钟的生产历时不显示为零分钟", async () => {
  const { formatDuration } = await workspace();
  assert.equal(formatDuration(35), "35 秒");
  assert.equal(formatDuration(3600), "1 小时 0 分钟");
});
test("刷新等待期间切换工单，响应返回不会选回旧工单", async () => {
  const { state, liveOrders, context, loadAssignments } = await workspace();
  const items = [assignment("A"), assignment("B")];
  state.orders = liveOrders(items);
  state.selectedId = state.orders[0].id;
  let finish;
  context.fetch = () => new Promise((resolve) => { finish = resolve; });
  const pending = loadAssignments({ preserveSelection: true });
  state.selectedId = state.orders[1].id;
  finish({ ok: true, json: async () => ({ assignments: items }) });
  await pending;
  assert.equal(state.selectedId, liveOrders(items)[1].id);
});
test("旧刷新响应晚到时不会覆盖较新的结果", async () => {
  const { state, context, loadAssignments } = await workspace();
  const responses = [];
  context.fetch = () => new Promise((resolve) => responses.push(resolve));
  const first = loadAssignments();
  const second = loadAssignments();
  responses[1]({ ok: true, json: async () => ({ assignments: [assignment("B")] }) });
  await second;
  responses[0]({ ok: true, json: async () => ({ assignments: [assignment("A")] }) });
  await first;
  assert.equal(state.orders[0].code, "B");
});
test("刷新失败保留数据并提供可见提示", async () => {
  const { state, context, loadAssignments, liveOrders } = await workspace();
  state.orders = liveOrders([assignment("A")]);
  context.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(loadAssignments(), /offline/);
  assert.equal(state.orders[0].code, "A");
  assert.match(state.syncWarning, /刷新失败/);
});
test("展开全部确实展开每道工序，再次点击可全部收起", async () => {
  const { state, liveOrders, listeners, processTable } = await workspace();
  state.orders = liveOrders([assignment("A")], [{ projectCode: "A", processes: [{taskId: 1, sequence: 1}, {taskId: 2, sequence: 2}] }]);
  const click = () => listeners.get("click")({ target: { closest: () => ({ dataset: { action: "collapse-all" } }) } });
  await click();
  assert.equal(state.expandedProcesses.size, 2);
  assert.equal((processTable(state.orders[0]).match(/aria-expanded="true"/g) || []).length, 2);
  await click();
  assert.equal(state.expandedProcesses.size, 0);
});
test("中文组合输入期间不重建输入框", async () => {
  const { listeners, nodes, state } = await workspace();
  const app = nodes.get("#app");
  app.innerHTML = "原始输入框";
  const target = { id: "order-search", value: "测试" };
  listeners.get("compositionstart")({ target });
  listeners.get("input")({ target, isComposing: true });
  assert.equal(app.innerHTML, "原始输入框");
  listeners.get("compositionend")({ target });
  assert.equal(state.search, "测试");
  assert.match(app.innerHTML, /order-search/);
});
test("绣花看板固定展示12台机器、工人和部位，不再提供派单排队操作", async () => {
  const { state, embroideryWorkspace } = await workspace();
  state.demo = true;
  const html = embroideryWorkspace();
  assert.equal(state.embroideryMachines.length, 12);
  assert.equal(state.embroideryMachines.filter((machine) => machine.status === "RUNNING").length, 7);
  assert.equal(state.embroideryMachines.filter((machine) => machine.status === "IDLE").length, 5);
  assert.match(html, /使用中 <b>7<\/b>/);
  assert.match(html, /空闲 <b>5<\/b>/);
  assert.doesNotMatch(html, /待机|保养/);
  assert.equal((html.match(/class="embroidery-station/g) || []).length, 12);
  assert.match(html, /绣花区通道/);
  assert.equal((html.match(/class="station-summary/g) || []).length, 12);
  assert.match(html, /class="embroidery-inspector/);
  assert.match(html, /08 号机/);
  assert.match(html, /机位编号/);
  assert.match(html, /设备型号/);
  assert.match(html, /刘芮华/);
  assert.match(html, /WO-260907-003 · 前幅/);
  assert.match(html, /开工后自动更新/);
  assert.match(html, /按人员绑定的位置显示/);
  assert.doesNotMatch(html, /draggable="true"|data-machine-drop|保存排程|待分配工单|排队任务|修改分配|移出排队/);
  assert.doesNotMatch(html, /class="embroidery-summary-sidebar/);
});
test("扫码产生的实时任务映射到机台，同一工人可同时显示在多台机器", async () => {
  const { state, syncEmbroideryMachines, embroideryWorkspace } = await workspace();
  syncEmbroideryMachines([
    { id: "a1", projectCode: "WO-1", productName: "帽子", taskId: 11, operatorName: "刘芮华", processName: "外协加工KL", status: "IN_PROGRESS", quantity: 100, targetQuantity: 100, isEmbroidery: true, machineId: "01", embroideryPart: "前幅", startedAt: "2026-09-11 08:00:00" },
    { id: "a2", projectCode: "WO-2", productName: "帽子", taskId: 12, operatorName: "刘芮华", processName: "外协加工", status: "IN_PROGRESS", quantity: 80, targetQuantity: 80, isEmbroidery: true, machineId: "02", embroideryPart: "后幅", startedAt: "2026-09-11 08:05:00" },
    { id: "done", operatorName: "王师傅", status: "COMPLETED", isEmbroidery: true, machineId: "03", embroideryPart: "前幅" },
    { id: "ordinary", operatorName: "陈师傅", status: "IN_PROGRESS", isEmbroidery: false, machineId: "04" },
    { id: "bound", operatorName: "位置绑定员工", status: "IN_PROGRESS", isEmbroidery: true, machineId: "", stationName: "3F-05" }
  ]);
  assert.equal(state.embroideryMachines.find((machine) => machine.id === "01").current.operatorName, "刘芮华");
  assert.equal(state.embroideryMachines.find((machine) => machine.id === "02").current.operatorName, "刘芮华");
  assert.equal(state.embroideryMachines.find((machine) => machine.id === "03").current, null);
  assert.equal(state.embroideryMachines.find((machine) => machine.id === "05").current.operatorName, "位置绑定员工");
  state.embroiderySelectedMachineId = "01";
  const html = embroideryWorkspace();
  assert.match(html, /刘芮华 · 前幅/);
  assert.match(html, /WO-1/);
  assert.match(html, /外协加工KL/);
});

test("绣花看板保留平板和手机断点，移动端机台列表可连续滚动", async () => {
  const { state, embroideryWorkspace } = await workspace();
  state.demo = true;
  const html = embroideryWorkspace();
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /开工后自动更新/);
  assert.doesNotMatch(html, /先选工单|拖拽工单/);
  assert.match(css, /@media \(max-width: 1100px\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /--mobile-nav-h: 64px/);
  assert.match(css, /\.embroidery-workspace\.read-only[^}]*grid-template-rows: auto auto/);
});

test("人员管理按黑湖人员ID展示默认模式，并配置8楼工位驻位员工", async () => {
  const { state, peopleModuleData, peopleTableRows, stationRecommendationGrid, secondaryModule, listeners, nodes } = await workspace();
  state.demo = true;
  state.operatorsLoaded = true;
  state.operators = [
    { blacklakeOperatorId: 4412231, name: "刘芮华", description: "未设置", appRole: "floor8_leader", defaultReportingMode: "standard", canSwitchReportingMode: true, bound: true },
    { blacklakeOperatorId: 51002, name: "绣花工人", description: "三楼绣花部", appRole: "employee", defaultReportingMode: "embroidery", canSwitchReportingMode: true, bound: true },
    { blacklakeOperatorId: 51003, name: "普通工人", description: "生产部", appRole: "employee", defaultReportingMode: "standard", canSwitchReportingMode: false, bound: false }
  ];
  state.unitRecommendations = [{ unitId: "A-03", blacklakeOperatorId: 51003 }];
  const html = peopleTableRows(peopleModuleData());
  const moduleHtml = secondaryModule("people");
  const recommendationHtml = stationRecommendationGrid();
  assert.match(moduleHtml, /人员与工位/);
  assert.match(moduleHtml, /8楼工位安排/);
  assert.match(moduleHtml, /class="people-workspace station-workspace"/);
  assert.doesNotMatch(moduleHtml, /class="module-panel people-directory-panel"/);
  assert.match(moduleHtml, /1 \/ 24/);
  assert.match(moduleHtml, /登录正式页面/);
  assert.match(recommendationHtml, /data-unit-id="A-03"/);
  assert.match(recommendationHtml, /未安排/);
  assert.match(recommendationHtml, /A区<span>10 个工位/);
  assert.match(recommendationHtml, /B区<span>7 个工位/);
  assert.match(recommendationHtml, /辅助工位<span>7 处/);
  assert.equal((recommendationHtml.match(/data-action="select-station"/g) || []).length, 24);
  assert.match(recommendationHtml, /data-unit-id="翻内袋"/);
  assert.match(recommendationHtml, /data-unit-id="A-03"[\s\S]*普通工人/);
  state.peopleTab = "permissions";
  assert.match(secondaryModule("people"), /class="module-panel people-directory-panel"/);
  assert.match(html, /<span>人员<\/span>/);
  assert.match(html, /<span>报工归属<\/span>/);
  assert.match(html, /<span>开工方式<\/span>/);
  assert.match(html, /<span>报工身份<\/span>/);
  assert.equal((html.match(/data-quality-role/g)||[]).length,3);
  assert.match(html,/普通人员/);
  assert.match(html,/质检人员/);
  assert.match(html, /<span>微信绑定<\/span>/);
  assert.match(html, /刘芮华/);
  assert.match(html, /ID 4412231/);
  assert.match(html, /三楼绣花部/);
  assert.match(html, /data-worker-type/);
  assert.match(html, /自动（当前绣花）/);
  assert.match(html, /value="floor8"[^>]*>8楼员工/);
  assert.match(html, /value="embroidery"[^>]*>绣花员工/);
  assert.match(html, /自动（当前8楼）/);
  assert.equal((html.match(/data-self-service/g) || []).length, 3);
  assert.match(html,/仅接派工/);
  assert.match(html,/可自主报工/);
  assert.equal((html.match(/role="switch"/g) || []).length, 3, '演示模式保留测试用切换');
  state.demo=false;
  assert.doesNotMatch(peopleTableRows(peopleModuleData()),/role="switch"/,'真实人员页只通过后台归属和开工方式设置');
  state.demo=true;

  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.people-workspace\.station-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(290px, 340px\)/);
  assert.match(css, /\.binding-table\.permission-table \.module-table-row\s*\{[^}]*min-width:\s*800px[^}]*grid-template-columns:[^}]*176px/);

});

test("演示页8楼工位直接选择具体演示人员，不显示绣花工人", async () => {
  const { useDemo, stationRecommendationGrid, secondaryModule, state, listeners } = await workspace();
  useDemo();
  const recommendationHtml = stationRecommendationGrid();
  assert.match(recommendationHtml, /演示员工甲/);
  assert.match(recommendationHtml, /裁床一区/);
  assert.match(recommendationHtml, /裁床二区-1/);
  assert.match(recommendationHtml, /裁床二区-2/);
  assert.match(recommendationHtml, /手工剪线/);
  assert.match(recommendationHtml, /包装\/质检/);
  assert.match(recommendationHtml, /刺绣片检验/);
  assert.doesNotMatch(recommendationHtml, /绣花工人/);
  assert.match(secondaryModule("people"), /登录正式页面/);
  const click = async (action, dataset = {}) => {
    const target = { dataset: { action, ...dataset }, disabled: false, closest() { return this; } };
    await listeners.get("click")({ target });
  };
  await click("select-station", { unitId: "裁床一区" });
  await click("choose-station-person", { id: "51004" });
  await click("choose-station-person", { id: "51005" });
  await click("save-station-person");
  assert.deepEqual(Array.from(state.unitRecommendations.filter((item) => item.unitId === "裁床一区"), (item) => item.blacklakeOperatorId), [51004, 51005]);
  assert.match(stationRecommendationGrid(), /已安排 2 人/);
  await click("choose-station-person", { id: "51004" });
  await click("save-station-person");
  assert.deepEqual(Array.from(state.unitRecommendations.filter((item) => item.unitId === "裁床一区"), (item) => item.blacklakeOperatorId), [51005]);
  await click("clear-station-person");
  assert.equal(state.unitRecommendations.some((item) => item.unitId === "裁床一区"), false);
});
test("审计日志独立入口展示失败、自动取消和完整筛选条件", async () => {
  const { state, auditModule, secondaryModule } = await workspace();
  state.auditLoaded = true;
  state.auditTotal = 2;
  state.auditFacets = { errorCodes: ["TASK_CLOSED"], actors: ["AUTHENTICATED_OPERATOR", "SYSTEM"] };
  state.auditEvents = [
    { eventId: "report:1", eventType: "REPORT_FAILED", eventTime: "2026-09-14T02:09:09.000Z", operatorName: "刘芮华", blacklakeOperatorId: 4412231, projectCode: "WO-001", processName: "外协加工KL", taskId: 990201, machineId: "02", embroideryPart: "后幅", errorCode: "TASK_CLOSED", reason: "工序状态已结束无法报工", actor: "AUTHENTICATED_OPERATOR", amount: 1000 },
    { eventId: "action:1", eventType: "ASSIGNMENT_CANCELLED", eventTime: "2026-09-14T02:09:10.000Z", operatorName: "刘芮华", blacklakeOperatorId: 4412231, projectCode: "WO-001", processName: "外协加工KL", taskId: 990201, machineId: "02", embroideryPart: "后幅", errorCode: "TASK_CLOSED", reason: "本地任务已自动退出", actor: "SYSTEM", amount: 1000 }
  ];
  const html = auditModule();
  assert.equal(secondaryModule("audit"), html);
  assert.match(html, /审计日志/);
  assert.match(html, /搜索工人、工单、机器、任务ID或原因/);
  assert.match(html, /开始日期/);
  assert.match(html, /结束日期/);
  assert.match(html, /全部错误码/);
  assert.match(html, /刘芮华/);
  assert.match(html, /02 号机 · 后幅/);
  assert.match(html, /TASK_CLOSED/);
  assert.match(html, /工序状态已结束无法报工/);
  assert.match(html, /系统/);
  assert.match(html, /共 2 条记录/);
});
test("CSV支持中文、引号换行转义并防止公式注入", async () => {
  const { csvText } = await workspace();
  assert.equal(csvText([["中文", 'a"b', "换\n行", "=1+1"]]), '\ufeff"中文","a""b","换\n行","\'=1+1"');
});
test("并行汇总只计已确认良品，不把在制和待核对算成报工成功", async () => {
  const { liveOrders, processTable, state } = await workspace();
  const order = liveOrders([
    { ...assignment("A"), quantity: 10, goodQuantity: 8, defectQuantity: 2 },
    { ...assignment("A"), id: "pending", quantity: 20, status: "NEEDS_REVIEW" },
    { ...assignment("A"), id: "active", quantity: 30, status: "IN_PROGRESS" }
  ])[0];
  state.expandedProcesses.add(order.processes[0].id);
  assert.match(processTable(order), /本系统已确认：1 笔，良品 8 件/);
});
test("导出工序和统计报表生成真实CSV文件，统计不受左侧搜索影响", async () => {
  const { state, liveOrders, exportOrder, context } = await workspace();
  state.orders = liveOrders([assignment("A"), assignment("B")]);
  let blob;
  const link = { click() { this.clicked = true; }, remove() {} };
  context.Blob = Blob;
  context.URL = { createObjectURL(value) { blob = value; return "blob:fixture"; }, revokeObjectURL() {} };
  context.document.body = { append() {} };
  context.document.createElement = () => link;
  exportOrder("processes");
  assert.equal(link.download, "A-全部工序.csv");
  assert.equal(link.clicked, true);
  assert.match(await blob.text(), /已报良品/);
  state.search = "不存在";
  state.activeModule = "analytics";
  exportOrder();
  assert.equal(link.download, "生产分析摘要.csv");
  assert.match(await blob.text(), /"已载入工单","2"/);
  assert.doesNotMatch(await blob.text(), /"A"|"B"/);
});

function analysisOrder(id, amounts, options = {}) {
  return { id, code: id, name: id, product: id, planned: 100, completed: amounts.at(-1), status: "IN_PROGRESS", routeComplete: true, workers: [], records: [], anomalies: [],
    processes: amounts.map((reported, i) => ({ id: `${id}-${i}`, seq: i + 1, sequenceKnown: true, planKnown: true, name: `工序${i + 1}`, planned: 100, reported, status: "IN_PROGRESS" })), ...options };
}
test("收尾判断要求全部工序达到90%，不以末道报满认定", async () => {
  const { analyticsData } = await workspace();
  const data = analyticsData([analysisOrder("末道满", [20, 100]), analysisOrder("接近", [100, 90]), analysisOrder("低于门槛", [100, 89])]);
  assert.equal(data.count("closing"), 1);
  assert.equal(data.groups.get("closing").ids[0], "接近");
});
test("缺失完整工艺或计划时不猜测收尾，待核对先确认", async () => {
  const { analyticsData } = await workspace();
  const unknown = analysisOrder("缺资料", [100], { routeComplete: false });
  const noPlan = analysisOrder("无计划", [100]); noPlan.processes[0].planKnown = false;
  const review = analysisOrder("待核对", [100], { records: [{ assignmentStatus: "NEEDS_REVIEW", status: "EXCEPTION" }] });
  const data = analyticsData([unknown, noPlan, review]);
  assert.equal(data.count("closing"), 0);
  assert.equal(data.count("unknown"), 1);
  assert.equal(data.reviewCount, 1);
  assert.equal(data.insights[0].key, "review");
});
test("同序号并行、缺序号或计划不同的工序不比较数量差", async () => {
  const { analyticsData } = await workspace();
  const parallel = analysisOrder("并行", [100, 0, 0]); parallel.processes[1].seq = 1;
  const mismatch = analysisOrder("不同计划", [100, 0]); mismatch.processes[1].planned = 200;
  const missing = analysisOrder("无真实顺序", [100, 0]); missing.processes[0].sequenceKnown = false;
  assert.equal(analyticsData([parallel, mismatch, missing]).rankedGaps.length, 0);
});
test("前后差只观察可比工序，超产部分不放大差距", async () => {
  const { analyticsData } = await workspace();
  const data = analyticsData([analysisOrder("超产", [300, 70]), analysisOrder("差很小", [100, 81])]);
  assert.equal(data.rankedGaps.length, 1);
  assert.equal(data.rankedGaps[0].difference, 30);
  assert.equal(data.rankedGaps[0].ids.size, 1);
});
test("长周期和暂无报工不自动视为异常，阶段总数不重叠", async () => {
  const { analyticsData } = await workspace();
  const orders = [analysisOrder("长单", [0, 0], { updatedAt: "2020-01-01" }), analysisOrder("推进", [60, 20]), analysisOrder("收尾", [100, 95]), analysisOrder("未知", [100], { routeComplete: false })];
  const data = analyticsData(orders);
  assert.equal(data.anomalyCount, 0);
  assert.equal(data.count("unreported"), 1);
  assert.equal(["closed", "closing", "moving", "unreported", "unknown"].reduce((sum, key) => sum + data.count(key), 0), orders.length);
});
test("分析默认只展示摘要，最多三项建议、三类报工差", async () => {
  const { state, analyticsModule, analyticsData } = await workspace();
  state.orders = [analysisOrder("秘密工单名称", [100, 0]), analysisOrder("收尾单", [95, 95])];
  const html = analyticsModule();
  assert.doesNotMatch(html, /秘密工单名称|module-table-row|analytics-table/);
  assert.match(html, /建议先看/);
  assert.ok(analyticsData(state.orders).insights.length <= 3);
});
test("结论能下钻到对应工单，清除分析范围后恢复完整列表", async () => {
  const { state, listeners, filteredOrders } = await workspace();
  state.orders = [analysisOrder("推进", [50, 0]), analysisOrder("收尾", [100, 95])];
  state.search = "原搜索"; state.filter = "COMPLETED";
  const click = (dataset) => listeners.get("click")({ target: { closest: () => ({ dataset }) } });
  await click({ action: "analytics-drill", focus: "closing" });
  assert.equal(state.activeModule, "report");
  assert.equal(state.selectedId, "收尾");
  assert.equal(filteredOrders().length, 1);
  await click({ action: "clear-analysis-focus" });
  assert.equal(filteredOrders().length, 2);
});
test("空数据及同步失败时不显示虚假良好结论", async () => {
  const { state, analyticsModule } = await workspace();
  assert.match(analyticsModule(), /暂时没有足够数据/);
  state.syncWarning = "刷新失败";
  assert.match(analyticsModule(), /以下结论可能滞后/);
});

test("全部工序同步不可用时展示未知而不是零产出或要求补资料", async () => {
  const { state, liveOrders, analyticsModule } = await workspace();
  state.orders = liveOrders([assignment("A"), assignment("B")]);
  const html = analyticsModule();
  assert.match(html, /工序信息暂不可判定/);
  assert.equal((html.match(/—<small> 暂不可判定/g) || []).length, 4);
  assert.doesNotMatch(html, /需补齐工序资料|工序资料待补齐/);
});

test("工序快照降级保留分析并标注旧数据时间，空查询和失败分别说明", async () => {
  const { state, liveOrders, analyticsModule, processTable } = await workspace();
  const catalog = { projectCode: "A", processSync: { status: "stale", updatedAt: "2026-09-08T01:00:00.000Z" },
    processes: [{ taskId: 1, sequence: 1, processName: "缝制", plannedAmount: 100, reportedAmount: 50 }] };
  state.orders = liveOrders([assignment("A")], [catalog]);
  assert.equal(state.orders[0].routeComplete, true);
  assert.match(analyticsModule(), /沿用上次成功的工序数据/);
  assert.match(processTable(state.orders[0]), /2026.*不是实时进度/);
  for (const status of ["empty", "unavailable"]) {
    const order = liveOrders([assignment("A")], [{ ...catalog, processes: [], processSync: { status, updatedAt: null } }])[0];
    assert.equal(order.routeComplete, false);
    assert.match(processTable(order), status === "empty" ? /查询未返回工序/ : /工序暂时无法同步/);
  }
});

test("精简台账以末道65件计算87%及还差10件，不误取前道超报90件", async () => {
  const { liveOrders, ledgerProgress, reportingWorkspace } = await workspace();
  const order = liveOrders([{ ...assignment("A"), taskId: 6, processName: "包装", quantity: 65 }], [{ projectCode: "A", processes: Array.from({ length: 6 }, (_, i) => ({ taskId: i + 1, sequence: i + 1, processName: i === 5 ? "包装" : `工序${i + 1}`, plannedAmount: 75, reportedAmount: i === 1 ? 90 : i === 5 ? 65 : 0, processStatus: i === 1 ? 20 : 10 })) }])[0];
  const progress = ledgerProgress(order);
  assert.equal(progress.completed, 65);
  assert.equal(progress.remaining, 10);
  assert.equal(progress.percent, 87);
  assert.equal(order.status, "IN_PROGRESS");
  const html = reportingWorkspace(order);
  assert.match(html, /工序2已报 90 件，计划 75 件/);
  assert.match(html, /本笔已完成/);
  assert.match(html, /本笔完成不代表整单完成/);
});

test("工序超报进度封顶且余量非负，数量达到计划不擅自关闭工序", async () => {
  const { liveOrders, ledgerProgress, processTable } = await workspace();
  const order = liveOrders([{ ...assignment("A"), quantity: 120 }], [{ projectCode: "A", processes: [{ taskId: 1, sequence: 1, processName: "缝制", plannedAmount: 100, reportedAmount: 120, processStatus: 10 }] }])[0];
  assert.equal(order.processes[0].status, "IN_PROGRESS");
  assert.equal(order.status, "IN_PROGRESS");
  assert.equal(ledgerProgress(order).percent, 100);
  assert.equal(ledgerProgress(order).remaining, 0);
  const html = processTable(order);
  assert.match(html, /已报超计划 20 件，建议核对/);
  assert.doesNotMatch(html, /width:120%|class="status-badge green/);
});

test("完整工艺、顺序或计划未知时，精简台账不把末道累计显示为零进度", async () => {
  const { liveOrders, ledgerProgress, reportingWorkspace } = await workspace();
  const unavailable = liveOrders([assignment("A")])[0];
  assert.equal(ledgerProgress(unavailable).completed, null);
  assert.equal(ledgerProgress(unavailable).percent, null);
  assert.match(reportingWorkspace(unavailable), /完整工艺尚未取得/);
  const unknownSequence = liveOrders([assignment("A")], [{ projectCode: "A", processes: [{ taskId: 1, plannedAmount: 75, reportedAmount: 5 }] }])[0];
  assert.equal(ledgerProgress(unknownSequence).percent, null);
});

test("三项筛选中的进行中包含待核对和异常工单，不因精简入口丢失关注事项", async () => {
  const { state, liveOrders, filteredOrders, reportingWorkspace } = await workspace();
  state.orders = ["A", "B", "C", "D"].map((code, i) => ({ ...liveOrders([assignment(code)])[0], id: code, status: ["IN_PROGRESS", "NEEDS_REVIEW", "EXCEPTION", "COMPLETED"][i] }));
  state.filter = "IN_PROGRESS";
  assert.deepEqual([...filteredOrders()].map(order => order.id), ["A", "B", "C"]);
  const html = reportingWorkspace(state.orders[0]);
  assert.match(html, /data-filter="IN_PROGRESS">进行中<b>3/);
  assert.match(html, /data-filter="COMPLETED">已完成<b>1/);
});

test("最近报工按时间倒序，不把进行中任务的计划数量当成已提交报工", async () => {
  const { recentLedgerRecords } = await workspace();
  const records = [
    { id: "active", assignmentStatus: "IN_PROGRESS", time: "2026-10-19 10:00:00", amount: 200 },
    { id: "older", assignmentStatus: "COMPLETED", time: "2026-10-19 08:00:00", amount: 65 },
    { id: "review", assignmentStatus: "NEEDS_REVIEW", time: "2026-10-19 09:00:00", amount: 10 }
  ];
  assert.deepEqual([...recentLedgerRecords({ records })].map(record => record.id), ["review", "older"]);
  assert.equal(records[0].id, "active");
});

test("精简台账的待核对提醒入口保留，工序不同步时仍明确说明", async () => {
  const { liveOrders, reportingWorkspace } = await workspace();
  const order = liveOrders([{ ...assignment("A"), status: "NEEDS_REVIEW" }])[0];
  const html = reportingWorkspace(order);
  assert.match(html, /有 1 笔报工待核对/);
  assert.match(html, /data-action="ledger-attention"/);
  assert.match(html, /工序暂时无法同步/);
  assert.match(html, /data-action="open-record" data-id="A"/);
});

test("同一笔待核对报工又有异常提示时，提醒和抽屉仍提供核对入口", async () => {
  const { state, liveOrders, reviewPanel, recordDrawer } = await workspace();
  const order = liveOrders([{ ...assignment("A"), status: "NEEDS_REVIEW", productionStatus: "EXCEPTION" }])[0];
  state.drawerRecordId = "A";
  assert.match(reviewPanel(order), /黑湖已有记录/);
  assert.match(recordDrawer(order), /核对黑湖结果/);
});
