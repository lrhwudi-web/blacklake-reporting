import {workTimeBreakdown} from '../../api/src/work-time.mjs';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function reportPage(request) {
  let page;
  let nextTimerId = 0;
  const timers = new Map();
  const cleared = [];
  const app = { globalData: { sessionToken: "test-session" } };
  vm.runInNewContext(readFileSync(new URL("../pages/report/report.js", import.meta.url), "utf8"), {
    Page: (definition) => { page = definition; },
    getApp: () => app,
    require: (path) => path.endsWith("work-time")
      ? {workTimeBreakdown}
      : { request },
    wx: { showToast() {}, setStorageSync() {}, reLaunch() {} },
    setInterval(callback, delay) { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { cleared.push(id); timers.delete(id); },
    Date
  });
  page.setData = (values) => Object.assign(page.data, values);
  return { page, timers, cleared };
}

test("员工停留等待页时定时刷新，派单出现后停止轮询", async () => {
  let assignmentRequests = 0;
  const { page, timers } = reportPage(async (path) => {
    if (path === "/v1/me") return { operator: { name: "测试员工" }, entry: { entryView: "employee-reporting" } };
    if (path === "/v1/assignments/current") {
      assignmentRequests += 1;
      return assignmentRequests === 1 ? { assignments: [] } : {
        assignments: [{ id: "ready-task", status: "READY", quantity: 8, goodQuantity: 8 }]
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const loading = page.onLoad();
  page.onShow();
  await loading;
  assert.equal(page.data.stage, "waiting");
  assert.equal(assignmentRequests, 1);
  assert.equal(timers.size, 1);
  const poll = [...timers.values()][0];
  assert.ok(poll.delay > 0 && poll.delay <= 15000);
  await poll.callback();
  assert.equal(page.data.assignment.id, "ready-task");
  assert.equal(page.data.stage, "working");
  assert.equal(timers.size, 0);
});

test("首次身份读取失败显示原因与重试，隐藏页面停止轮询", async () => {
  let profileRequests = 0;
  const { page, timers } = reportPage(async (path) => {
    if (path === "/v1/me") {
      profileRequests += 1;
      if (profileRequests === 1) throw new Error("网络连接失败，请检查网络后再试。");
      return { operator: { name: "测试员工" }, entry: { entryView: "employee-reporting" } };
    }
    if (path === "/v1/assignments/current") return { assignments: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  page.onShow();
  await page.onLoad();
  assert.equal(page.data.ready, false);
  assert.match(page.data.loadError, /网络连接失败/);
  assert.equal(timers.size, 0);
  await page.retryLoad();
  assert.equal(page.data.ready, true);
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.stage, "waiting");
  assert.equal(timers.size, 1);
  page.onHide();
  assert.equal(timers.size, 0);
  const markup = readFileSync(new URL("../pages/report/report.wxml", import.meta.url), "utf8");
  assert.match(markup, /wx:elif="\{\{loadError\}\}"/);
  assert.match(markup, /bindtap="retryLoad"/);
});
