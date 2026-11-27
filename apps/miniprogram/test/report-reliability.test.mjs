import {workTimeBreakdown} from '../../api/src/work-time.mjs';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Run the real page lifecycle with a controlled transport. These are not device tests.
function reportPage(request, storage = new Map()) {
  let page;
  let nextTimer = 0;
  const timers = new Map();
  const modals = [];
  const app = { globalData: { sessionToken: "test-only-session", operator: { id: "worker-a", name: "测试员工" } } };
  const wx = {
    showToast() {}, vibrateShort() {}, reLaunch() {},
    showModal(options) { modals.push(options); },
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, structuredClone(value)); },
    removeStorageSync(key) { storage.delete(key); }
  };
  const dependencies = (path) => {
    if (path.endsWith("api")) return { request };
    if (path.endsWith("work-time")) return {workTimeBreakdown};
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(new URL(`${path}.js`, new URL("../pages/report/report.js", import.meta.url)), "utf8"), {
      module, exports: module.exports, wx, getApp: () => app, Date
    });
    return module.exports;
  };
  vm.runInNewContext(readFileSync(new URL("../pages/report/report.js", import.meta.url), "utf8"), {
    Page(definition) { page = definition; }, getApp: () => app, require: dependencies, wx,
    setInterval(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }, Date
  });
  page.setData = (values) => Object.assign(page.data, values);
  Object.assign(page.data, { ready: true, operator: app.globalData.operator, draftOwnerId: "worker:worker-a" });
  return { page, modals, timers };
}

const assignment = (status = "IN_PROGRESS") => ({
  id: "task-a", attemptNumber: 1, status, quantity: 12, goodQuantity: 12,
  startedAt: "2026-10-22 08:00:00", processName: "测试工序", projectCode: "TEST-ONLY"
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
function editing(page) {
  page.data.assignment = assignment();
  page.data.activeAssignments = [page.data.assignment];
  page.data.stage = "finish";
  page.data.reportQuantity = "12";
}

test("结束报工连续点击十次仅发出一次写请求", async () => {
  const calls = [];
  let finish;
  const { page } = reportPage((path, options) => {
    calls.push({ path, options });
    return new Promise((resolve) => { finish = resolve; });
  });
  editing(page);
  const submissions = Array.from({ length: 10 }, () => page.finishWork());
  assert.equal(calls.length, 1);
  assert.equal(page.data.submitting, true);
  assert.ok(calls[0].options.idempotencyKey);
  finish({ assignment: { ...assignment("COMPLETED"), durationSeconds: 60 } });
  await Promise.all(submissions);
  assert.equal(page.data.stage, "success");
  assert.equal(page.data.submitting, false);
});

test("提交响应丢失不自动重发，用户重试沿用同一提交标识", async () => {
  const writes = [];
  const { page } = reportPage(async (path, options = {}) => {
    if (!path.endsWith("/finish")) return { assignment: assignment() };
    writes.push(options);
    if (writes.length === 1) throw new Error("模拟响应丢失");
    return { assignment: { ...assignment("COMPLETED"), durationSeconds: 60 }, replayed: true };
  });
  editing(page);
  await page.finishWork();
  await flush();
  assert.equal(writes.length, 1, "客户端不能因网络错误自动重发写请求");
  await page.finishWork();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].idempotencyKey, writes[0].idempotencyKey);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[1].data)), JSON.parse(JSON.stringify(writes[0].data)));
  assert.equal(page.data.stage, "success");
});

test("提交期间隐藏再显示只查询服务端状态，不重复结束报工", async () => {
  const calls = [];
  let finish;
  const { page, timers } = reportPage((path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith("/finish")) return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve({ assignment: assignment("REPORTING") });
  });
  editing(page);
  page.startTimer();
  const pending = page.finishWork();
  page.onHide();
  assert.equal(timers.size, 0);
  page.onShow();
  await flush();
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(page.data.assignment.status, "REPORTING");
  assert.notEqual(page.data.stage, "finish");
  finish({ assignment: { ...assignment("COMPLETED"), durationSeconds: 60 } });
  await pending;
  assert.equal(page.data.stage, "success");
});

test("页面销毁重进后读取待核对任务，保留任务且不自动重报", async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    return { assignment: assignment("NEEDS_REVIEW") };
  };
  const first = reportPage(request);
  editing(first.page);
  first.page.startTimer();
  first.page.onUnload();
  assert.equal(first.timers.size, 0);
  const reopened = reportPage(request);
  reopened.page.onShow();
  await flush();
  assert.equal(reopened.page.data.assignment.id, "task-a");
  assert.equal(reopened.page.data.assignment.status, "NEEDS_REVIEW");
  assert.equal(reopened.page.data.stage, "working");
  assert.equal(calls.some((call) => call.options.method === "POST"), false);
});

test("提交与状态查询都断网时持续锁定，恢复查询为待核对后仍不允许提交", async () => {
  let online = false;
  let writes = 0;
  const { page } = reportPage(async (path, options = {}) => {
    if (options.method === "POST") { writes += 1; throw new Error("模拟提交超时"); }
    if (!online) throw new Error("模拟网络仍中断");
    return { assignment: assignment("NEEDS_REVIEW") };
  });
  editing(page);
  await page.finishWork();
  assert.match(page.data.headline, /待确认/);
  assert.equal(page.data.assignment.id, "task-a");
  await page.finishWork();
  await page.confirmFinish();
  assert.equal(writes, 1, "查询失败期间必须拦住重复提交");
  online = true;
  await page.loadAssignment();
  assert.equal(page.data.assignment.status, "NEEDS_REVIEW");
  assert.match(page.data.headline, /核对/);
  await page.finishWork();
  assert.equal(writes, 1, "服务端待核对不能重报");
});

test("退出后旧提交成功响应不重建已销毁页面，也不改变新页面任务", async () => {
  let finish;
  const first = reportPage(() => new Promise((resolve) => { finish = resolve; }));
  editing(first.page);
  const pending = first.page.finishWork();
  first.page.onUnload();
  let oldPageUpdates = 0;
  first.page.setData = () => { oldPageUpdates += 1; };
  const reopened = reportPage(async () => ({ assignment: { ...assignment(), id: "task-b" } }));
  await reopened.page.loadAssignment();
  finish({ assignment: { ...assignment("COMPLETED"), durationSeconds: 60 } });
  await pending;
  assert.equal(oldPageUpdates, 0);
  assert.equal(first.modals.length, 0);
  assert.equal(reopened.page.data.assignment.id, "task-b");
  assert.equal(reopened.page.data.stage, "working");
});

test("网络异常后的状态查询晚于页面销毁返回，不再弹出旧任务提示", async () => {
  let finishRefresh;
  const first = reportPage(async (path, options = {}) => {
    if (options.method === "POST") throw new Error("模拟提交响应丢失");
    return new Promise((resolve) => { finishRefresh = resolve; });
  });
  editing(first.page);
  const pending = first.page.finishWork();
  await flush();
  assert.equal(typeof finishRefresh, "function");
  first.page.onUnload();
  let oldPageUpdates = 0;
  first.page.setData = () => { oldPageUpdates += 1; };
  const reopened = reportPage(async () => ({ assignment: { ...assignment(), id: "task-b" } }));
  await reopened.page.loadAssignment();
  finishRefresh({ assignment: assignment("NEEDS_REVIEW") });
  await pending;
  assert.equal(oldPageUpdates, 0);
  assert.equal(first.modals.length, 0);
  assert.equal(reopened.page.data.assignment.id, "task-b");
});
