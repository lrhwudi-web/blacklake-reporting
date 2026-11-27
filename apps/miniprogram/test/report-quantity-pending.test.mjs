import {workTimeBreakdown} from '../../api/src/work-time.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const assignment = (extra = {}) => ({ id: "pending-quantity-task", attemptNumber: 1, status: "IN_PROGRESS", isDispatched: true, stationName: "A-03", quantity: 100, goodQuantity: 100, quantityPolicy: "PENDING_REVIEW", ...extra });
function fixture(request) {
  let page;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const modals = [];
  vm.runInNewContext(readFileSync(new URL("../pages/report/report.js", import.meta.url), "utf8"), {
    Page(value) { page = value; }, getApp: () => ({ globalData: {} }),
    require: (path) => path.endsWith("work-time") ? {workTimeBreakdown} : { request: async (path, options) => { calls.push({ path, options }); return request(path, options); } },
    wx: { showToast() {}, showModal(value) { modals.push(value); }, vibrateShort() {} },
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); }, Date
  });
  page.setData = (values) => Object.assign(page.data, values);
  Object.assign(page.data, { ready: true, stage: "working", assignment: assignment(), activeAssignments: [assignment()], reportQuantity: "100" });
  return { page, calls, modals, timers };
}
const receipt = () => assignment({ status: "QUANTITY_PENDING", endedAt: "2026-10-22 10:00:00", durationSeconds: 60 });
const nextTask = () => assignment({ id: "task-b", status: "READY" });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("历史在途待核量回执兼容，连点不重复提交且不冒充数量报工", async () => {
  let finish;
  const { page, calls } = fixture(() => new Promise((resolve) => { finish = resolve; }));
  const jobs = Array.from({ length: 8 }, () => page.finishWork());
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options.data)), { quantityPolicy: "PENDING_REVIEW" });
  assert.equal(page.data.headline, "正在登记完工");
  finish({ assignment: assignment({ status: "QUANTITY_PENDING", endedAt: "2026-10-22 10:00:00", durationSeconds: 60 }) });
  await Promise.all(jobs);
  assert.equal(page.data.stage, "success");
  assert.equal(page.data.headline, "完工已登记");
  assert.equal(page.data.assignment, null);
  assert.equal(page.data.activeAssignments.length, 0);
  assert.equal(page.data.lastAssignment.status, "QUANTITY_PENDING");
  assert.equal(page.data.previousQuantityNotice, "已登记完工，数量待核对，可继续接单");
  await page.finishWork();
  assert.equal(calls.length, 1);
});

test("兼容当前接口中的旧待核量任务，转为登记回执而不是卡在working", async () => {
  const { page, calls } = fixture(async () => ({ assignments: [assignment({ status: "QUANTITY_PENDING" })] }));
  await page.loadAssignment();
  assert.equal(page.data.headline, "完工已登记");
  page.selectActiveAssignment({ currentTarget: { dataset: { assignmentId: "pending-quantity-task" } } });
  assert.equal(page.data.headline, "完工已登记");
  assert.equal(page.data.assignment, null);
  assert.equal(page.data.stage, "success");
  await page.finishWork();
  assert.equal(calls.length, 1);
});

test("正常8楼缺少旧策略时先读默认数量，不自动整批报工", async () => {
 const {page,calls}=fixture(async()=>({quantityPolicy:'SERVER_DEFAULT',defaultQuantity:72,remainingQuantity:72}));page.data.assignment=assignment({quantityPolicy:undefined});await page.confirmFinish();assert.equal(calls.length,1);assert.match(calls[0].path,/finish-default$/);assert.equal(page.data.stage,'finish');assert.equal(page.data.reportQuantity,'72');
});

test("完工响应丢失且current为空时按A的ID确认待核量，不重发或冒充报工", async () => {
  const { page, calls, modals } = fixture(async (path) => {
    if (path.endsWith("/finish")) throw new Error("offline");
    if (path.endsWith("/current")) return { assignment: null, assignments: [] };
    assert.equal(path, "/v1/assignments/pending-quantity-task");
    return { assignment: receipt() };
  });
  await page.finishWork();
  assert.equal(calls.filter((call) => call.options?.method === "POST").length, 1);
  assert.equal(page.data.headline, "完工已登记");
  assert.equal(page.data.lastAssignment.id, "pending-quantity-task");
  assert.equal(page.data.assignment, null);
  assert.equal(modals.length, 0, "已经权威确认成功，不再弹出结果未知提示");
  await page.finishWork();
  assert.equal(calls.filter((call) => call.options?.method === "POST").length, 1);
});

test("登记与状态查询都断网时锁定并准确提示，联网查回待核量后不重复写", async () => {
  let offline = true;
  const { page, calls, modals } = fixture(async (path) => {
    if (path.endsWith("/finish") || offline) throw new Error("offline");
    if (path.endsWith("/current")) return { assignment: null, assignments: [] };
    return { assignment: receipt() };
  });
  await page.finishWork();
  assert.equal(page.data.submissionUncertain, true);
  assert.equal(page.data.headline, "登记结果待确认");
  assert.equal(modals[0].title, "登记结果待确认");
  assert.match(modals[0].content, /完工登记结果待确认/);
  assert.doesNotMatch(modals[0].content, /报工可能已经提交|核对黑湖/);
  await page.finishWork();
  assert.equal(calls.filter((call) => call.options?.method === "POST").length, 1);
  offline = false;
  await page.loadAssignment();
  await page.quantityRecoveryRequest?.promise;
  assert.equal(page.data.headline, "完工已登记");
  assert.equal(page.data.lastAssignment.status, "QUANTITY_PENDING");
  assert.equal(page.data.assignment, null);
  await page.finishWork();
  assert.equal(calls.filter((call) => call.options?.method === "POST").length, 1);
});

test("登记成功停留回执页仍自动轮询，新B出现后直接进入且停止等待轮询", async () => {
  let current = null;
  const { page, calls, timers } = fixture(async (path) => path.endsWith("/finish")
    ? { assignment: receipt() } : { assignment: current, assignments: current ? [current] : [] });
  page.pageVisible = true;
  await page.finishWork();
  assert.equal(page.data.stage, "success");
  assert.equal(timers.size, 1);
  await [...timers.values()][0].callback();
  assert.equal(page.data.stage, "success");
  current = nextTask();
  await [...timers.values()][0].callback();
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.stage, "working");
  assert.equal(page.data.headline, "待开始");
  assert.equal(page.data.lastAssignment.id, "pending-quantity-task");
  assert.equal(timers.size, 0);
  assert.equal(calls.filter((call) => call.options?.method === "POST").length, 1);
});

test("登记回执可继续等待并刷新下一单，隐藏和卸载均停止轮询", async () => {
  const { page, timers } = fixture(async (path) => path.endsWith("/finish")
    ? { assignment: receipt() } : { assignment: null, assignments: [] });
  page.pageVisible = true;
  await page.finishWork();
  await page.nextAssignment();
  assert.equal(page.data.stage, "waiting");
  assert.equal(page.data.headline, "等待分配");
  assert.equal(page.data.lastAssignment.id, "pending-quantity-task");
  assert.equal(timers.size, 1);
  page.onHide();
  assert.equal(timers.size, 0);
  page.onShow();
  await flush();
  assert.equal(timers.size, 1);
  page.onUnload();
  assert.equal(timers.size, 0);
});

test("A响应丢失后current已有新B，精确确认A并保留B的待开始状态", async () => {
  const { page, calls, modals } = fixture(async (path) => {
    if (path.endsWith("/finish")) throw new Error("response lost");
    if (path.endsWith("/current")) return { assignment: nextTask(), assignments: [nextTask()] };
    return { assignment: receipt() };
  });
  await page.finishWork();
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.assignment.status, "READY");
  assert.equal(page.data.headline, "待开始");
  assert.equal(page.data.stage, "working");
  assert.equal(page.data.lastAssignment.id, "pending-quantity-task");
  assert.equal(page.data.submissionUncertain, false);
  assert.equal(modals.length, 0);
  assert.equal(calls.filter((call) => call.options?.method === "POST").length, 1);
});

test("current为空但A精确查询失败不能宣称登记成功，恢复后只读确认", async () => {
  let available = false;
  const { page, calls } = fixture(async (path) => {
    if (path.endsWith("/finish")) throw new Error("response lost");
    if (path.endsWith("/current")) return { assignment: null, assignments: [] };
    if (!available) throw new Error("detail offline");
    return { assignment: receipt() };
  });
  await page.finishWork();
  assert.equal(page.data.stage, "waiting");
  assert.equal(page.data.lastAssignment, null);
  assert.match(page.data.previousQuantityNotice, /上一单登记结果待确认/);
  await page.finishWork();
  available = true;
  await page.loadAssignment();
  await page.quantityRecoveryRequest?.promise;
  assert.equal(page.data.stage, "success");
  assert.equal(page.data.lastAssignment.id, "pending-quantity-task");
  assert.equal(calls.filter((call) => call.options?.method === "POST").length, 1);
});

test("B已分配而A查询失败时旧提示不锁住B，后续确认A也不覆盖B", async () => {
  let available = false;
  const { page, calls } = fixture(async (path) => {
    if (path.endsWith("/finish")) throw new Error("response lost");
    if (path.endsWith("/current")) return { assignment: nextTask(), assignments: [nextTask()] };
    if (!available) throw new Error("detail offline");
    return { assignment: receipt() };
  });
  await page.finishWork();
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.headline, "待开始");
  assert.equal(page.data.submissionUncertain, false);
  assert.equal(page.data.submitting, false);
  assert.match(page.data.previousQuantityNotice, /上一单登记结果待确认/);
  available = true;
  await page.loadAssignment();
  await page.quantityRecoveryRequest?.promise;
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.headline, "待开始");
  assert.equal(page.data.lastAssignment.id, "pending-quantity-task");
  assert.equal(calls.filter((call) => call.options?.method === "POST").length, 1);
});

test("current先返回B后旧A的POST成功才到达，不能把B改回A或成功页", async () => {
  let finish;
  const { page } = fixture((path) => path.endsWith("/finish")
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve({ assignment: nextTask(), assignments: [nextTask()] }));
  const pending = page.finishWork();
  await page.loadAssignment();
  assert.equal(page.data.assignment.id, "task-b");
  finish({ assignment: receipt() });
  await pending;
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.stage, "working");
  assert.equal(page.data.headline, "待开始");
  assert.equal(page.data.lastAssignment.id, "pending-quantity-task");
});

test("A登记完成后旧current的IN_PROGRESS迟到不会复活已结束任务", async () => {
  let finish;
  let current;
  const { page } = fixture((path) => new Promise((resolve) => {
    if (path.endsWith("/finish")) finish = resolve; else current = resolve;
  }));
  const pending = page.finishWork();
  const refresh = page.loadAssignment();
  finish({ assignment: receipt() });
  await pending;
  current({ assignment: assignment(), assignments: [assignment()] });
  await refresh;
  assert.equal(page.data.stage, "success");
  assert.equal(page.data.assignment, null);
  assert.equal(page.data.activeAssignments.length, 0);
});

test("先刷新为空再收到A的超时，后续断网仍保留等待页和独立待确认提示", async () => {
  let rejectFinish;
  let currentCalls = 0;
  const { page } = fixture((path) => {
    if (path.endsWith("/finish")) return new Promise((_resolve, reject) => { rejectFinish = reject; });
    if (++currentCalls === 1) return Promise.resolve({ assignment: null, assignments: [] });
    return Promise.reject(new Error("offline"));
  });
  const pending = page.finishWork();
  await page.loadAssignment();
  rejectFinish(new Error("timeout"));
  await pending;
  assert.equal(page.data.stage, "waiting");
  assert.equal(page.data.assignment, null);
  assert.equal(page.data.headline, "等待分配");
  assert.match(page.data.previousQuantityNotice, /上一单登记结果待确认/);
  assert.equal(page.pendingQuantityRecovery.id, "pending-quantity-task");
});

test("current B立即到达而A详情悬挂时即可开始B，A回执不清B的提交锁", async () => {
  let resolveDetail;
  let resolveStart;
  const { page, calls } = fixture((path) => {
    if (path.endsWith("/finish")) return Promise.reject(new Error("response lost"));
    if (path.endsWith("/current")) return Promise.resolve({ assignment: nextTask(), assignments: [nextTask()] });
    if (path.endsWith("/start")) return new Promise((resolve) => { resolveStart = resolve; });
    return new Promise((resolve) => { resolveDetail = resolve; });
  });
  await page.finishWork();
  assert.equal(typeof resolveDetail, "function", "旧A详情仍悬挂");
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.submitting, false);
  assert.equal(page.assignmentLoading, null, "current加载不等待A详情");
  const starting = page.startAssignedWork();
  assert.equal(typeof resolveStart, "function", "无需等待A详情即可开始B");
  assert.equal(page.data.submitting, true);
  resolveDetail({ assignment: receipt() });
  await page.quantityRecoveryRequest?.promise;
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.submitting, true, "A回执不能解锁B的在途开工");
  resolveStart({ assignment: { ...nextTask(), status: "IN_PROGRESS" } });
  await starting;
  assert.equal(page.data.submitting, false);
  assert.equal(page.data.assignment.status, "IN_PROGRESS");
  assert.equal(calls.filter((call) => call.path.endsWith("/finish")).length, 1);
});

test("A的迟到失败和finally不能清除B在途开工的锁", async () => {
  let rejectFinish;
  let resolveStart;
  let resolveDetail;
  const { page } = fixture((path) => {
    if (path.endsWith("/finish")) return new Promise((_resolve, reject) => { rejectFinish = reject; });
    if (path.endsWith("/current")) return Promise.resolve({ assignment: nextTask(), assignments: [nextTask()] });
    if (path.endsWith("/start")) return new Promise((resolve) => { resolveStart = resolve; });
    return new Promise((resolve) => { resolveDetail = resolve; });
  });
  const finishing = page.finishWork();
  await page.loadAssignment();
  assert.equal(page.data.submitting, false);
  const starting = page.startAssignedWork();
  rejectFinish(new Error("late timeout"));
  await finishing;
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.submitting, true);
  resolveDetail({ assignment: receipt() });
  await page.quantityRecoveryRequest?.promise;
  assert.equal(page.data.submitting, true);
  resolveStart({ assignment: { ...nextTask(), status: "IN_PROGRESS" } });
  await starting;
  assert.equal(page.data.assignment.status, "IN_PROGRESS");
});

test("A迟到成功不能清除新B自己的提交结果不确定标记", async () => {
  let resolveFinishA;
  let currentOffline = false;
  const taskB = { ...nextTask(), status: "IN_PROGRESS" };
  const { page } = fixture((path) => {
    if (path === "/v1/assignments/pending-quantity-task/finish") return new Promise((resolve) => { resolveFinishA = resolve; });
    if (path === "/v1/assignments/task-b/finish") { currentOffline = true; return Promise.reject(new Error("B timeout")); }
    if (path.endsWith("/current") && !currentOffline) return Promise.resolve({ assignment: taskB, assignments: [taskB] });
    return Promise.reject(new Error("offline"));
  });
  const finishingA = page.finishWork();
  await page.loadAssignment();
  await page.finishWork();
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.submissionUncertain, true);
  assert.equal(page.data.headline, "登记结果待确认");
  resolveFinishA({ assignment: receipt() });
  await finishingA;
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.submissionUncertain, true);
  assert.equal(page.data.headline, "登记结果待确认");
  assert.equal(page.pendingQuantityRecovery.id, "task-b");
});

test("A详情迟到时B已开始，旧查询不能把B从进行中改回待开始", async () => {
  let detailMode = "offline";
  let detail;
  let taskB = nextTask();
  const { page } = fixture(async (path) => {
    if (path.endsWith("/finish")) throw new Error("response lost");
    if (path.endsWith("/current")) return { assignment: taskB, assignments: [taskB] };
    if (path.endsWith("/start")) {
      taskB = { ...taskB, status: "IN_PROGRESS", startedAt: "2026-10-22 10:01:00" };
      return { assignment: taskB };
    }
    if (detailMode === "offline") throw new Error("detail offline");
    if (detailMode === "pending") return new Promise((resolve) => { detail = resolve; });
    return { assignment: receipt() };
  });
  await page.finishWork();
  detailMode = "pending";
  const refresh = page.loadAssignment();
  await flush();
  await page.startAssignedWork();
  assert.equal(page.data.assignment.status, "IN_PROGRESS");
  detail({ assignment: receipt() });
  await refresh;
  await page.quantityRecoveryRequest?.promise;
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.assignment.status, "IN_PROGRESS");
  detailMode = "ready";
  await page.loadAssignment();
  assert.equal(page.data.assignment.id, "task-b");
  assert.equal(page.data.assignment.status, "IN_PROGRESS");
  assert.equal(page.data.lastAssignment.id, "pending-quantity-task");
});

test("登记回执不展示参考数量并提供下一单和最近记录入口", () => {
  const markup = readFileSync(new URL("../pages/report/report.wxml", import.meta.url), "utf8");
  assert.match(markup, /已登记完工，数量待核对，可继续接单/);
  assert.match(markup, /bindtap="nextAssignment"[^>]*>[\s\S]*?继续接单/);
  assert.match(markup, /lastAssignment.status !== 'QUANTITY_PENDING' && lastAssignment.isQualityInspection/);
  assert.match(markup, /lastAssignment.status === 'QUANTITY_PENDING' \? '待核对' : lastAssignment.quantity \+ ' 件'/);
  assert.match(markup, /bindtap="openRecent"/);
  assert.doesNotMatch(markup, /暂不能接下一单|待核量暂保留任务占用/);
});
