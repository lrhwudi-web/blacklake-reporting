import {workTimeBreakdown} from '../../api/src/work-time.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const task = (extra = {}) => ({ id: "task-a", status: "IN_PROGRESS", attemptNumber: 1, quantity: 10, goodQuantity: 10, isQualityInspection: true, ...extra });
const defaults = { defaultQuantity: 10, remainingQuantity: 10, defectReasons: [{ code: "D1", name: "原因一" }] };
function pageWith({ storage = new Map(), employee = "employee-a", request, wxOverrides = {} } = {}) {
  let page;
  const app = { globalData: { sessionToken: "test", apiBaseUrl: "https://example.test" } };
  const calls = [];
  vm.runInNewContext(readFileSync(new URL("../pages/report/report.js", import.meta.url), "utf8"), {
    Page(definition) { page = definition; }, getApp: () => app,
    require: (path) => path.endsWith("work-time") ? {workTimeBreakdown} : {
      request: async (path, options) => { calls.push({ path, options }); return request ? request(path, options) : path.endsWith("finish-default") ? defaults : { assignments: [task()] }; }
    },
    wx: {
      getStorageSync: (key) => structuredClone(storage.get(key)),
      setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
      showToast() {}, showModal() {}, vibrateShort() {}, ...wxOverrides
    }, setInterval: () => 1, clearInterval() {}, Date
  });
  page.setData = (values) => Object.assign(page.data, values);
  Object.assign(page.data, { ready: true, operator: { name: "同名员工" }, draftOwnerId: `operator:${employee}`, assignment: task(), activeAssignments: [task()], stage: "working" });
  return { page, storage, calls };
}
async function editDraft(page) {
  await page.confirmFinish();
  page.onQuantityInput({ detail: { value: "27" } });
  page.onDefectInput({ detail: { value: "2" } });
  page.chooseDefectReason({ currentTarget: { dataset: { code: "D1" } } });
}

test("状态标题覆盖待开始、提交中和待核对，切换机台也一致", async () => {
  for (const [status, headline] of [["READY", "待开始"], ["REPORTING", "正在提交报工"], ["NEEDS_REVIEW", "报工待核对"]]) {
    const { page } = pageWith({ request: async () => ({ assignments: [task({ status })] }) });
    await page.loadAssignment();
    assert.equal(page.data.headline, headline);
    page.data.headline = "旧标题";
    page.selectActiveAssignment({ currentTarget: { dataset: { assignmentId: "task-a" } } });
    assert.equal(page.data.headline, headline);
  }
});

test("数量和不良原因持久化，新页面先查服务器再恢复同一员工任务", async () => {
  const { page, storage } = pageWith();
  await editDraft(page);
  page.onUnload();
  const next = pageWith({ storage });
  await next.page.loadAssignment();
  assert.equal(next.page.data.stage, "working");
  await next.page.confirmFinish();
  assert.equal(next.page.data.reportQuantity, "27");
  assert.equal(next.page.data.reportDefectQuantity, "2");
  assert.deepEqual(Array.from(next.page.data.reportDefectCodes), ["D1"]);
  assert.match(next.page.data.draftNotice, /已恢复/);
  assert.equal(next.calls.filter((call) => call.options?.method === "POST").length, 0);
});

test("真实身份响应只含姓名时，页面使用服务端草稿标识而非姓名", async () => {
  const { page } = pageWith({ request: async (path) => path === "/v1/me"
    ? { operator: { name: "同名员工" }, draftOwnerId: "operator:stable-id" }
    : path.endsWith("finish-default") ? defaults : { assignments: [task()] } });
  page.data.draftOwnerId = "";
  await page.onLoad();
  assert.equal(page.data.draftOwnerId, "operator:stable-id");
  await editDraft(page);
  assert.match(page.data.draftNotice, /已保存/);
});

test("编辑中服务端切换提交轮次会退出旧编辑，不能将旧数量存入新轮次", async () => {
  let current = task();
  const { page, storage } = pageWith({ request: async (path) => path.endsWith("finish-default") ? defaults : { assignments: [current] } });
  await editDraft(page);
  current = task({ attemptNumber: 2, quantity: 5, goodQuantity: 5 });
  await page.loadAssignment();
  assert.equal(page.data.stage, "working");
  assert.equal(page.data.reportQuantity, "5");
  page.onHide();
  const reopened = pageWith({ storage });
  reopened.page.data.assignment = current;
  await reopened.page.confirmFinish();
  assert.notEqual(reopened.page.data.reportQuantity, "27");
});

test("结束前读取最新并行剩余数，累计满计划后保留空白且可编辑", async () => {
  const { page, calls } = pageWith({ request: async () => ({ ...defaults, remainingQuantity: 0, defaultQuantity: null }) });
  await page.confirmFinish();
  assert.equal(calls[0].path, "/v1/assignments/task-a/finish-default");
  assert.equal(page.data.finishRemainingQuantity, 0);
  assert.equal(page.data.reportQuantity, "");
  page.onQuantityInput({ detail: { value: "8" } });
  assert.equal(page.data.reportQuantity, "8");
});

test("读取默认数期间发现提交轮次变化，迟到响应不能重开旧确认页", async () => {
  let finishDefault;
  const { page } = pageWith({ request: (path) => path.endsWith("finish-default")
    ? new Promise((resolve) => { finishDefault = resolve; })
    : Promise.resolve({ assignments: [task({ attemptNumber: 2, quantity: 5, goodQuantity: 5 })] }) });
  const pending = page.confirmFinish();
  await page.loadAssignment();
  finishDefault(defaults);
  await pending;
  assert.equal(page.data.stage, "working");
  assert.equal(page.data.assignment.attemptNumber, 2);
  assert.equal(page.data.reportQuantity, "5");
});

test("草稿按员工和任务隔离，不覆盖服务端最新状态或已变化的提交轮次", async () => {
  const { page, storage } = pageWith();
  await editDraft(page);
  for (const [employee, assignment] of [["employee-b", task()], ["employee-a", task({ id: "task-b" })], ["employee-a", task({ attemptNumber: 2 })]]) {
    const current = pageWith({ storage: new Map(storage), employee, request: async (path) => path.endsWith("finish-default") ? defaults : { assignments: [assignment] } });
    await current.page.loadAssignment();
    await current.page.confirmFinish();
    assert.equal(current.page.data.reportQuantity, "10");
  }
  for (const status of ["REPORTING", "NEEDS_REVIEW", "READY"]) {
    const current = pageWith({ storage: new Map(storage), request: async () => ({ assignments: [task({ status })] }) });
    await current.page.loadAssignment();
    await current.page.confirmFinish();
    assert.equal(current.page.data.stage, "working");
    assert.equal(current.calls.length, 1, "不可提交状态不打开编辑或触发请求");
  }
});

test("草稿恢复必须通过实时状态读取，失败不得冒充已核对", async () => {
  const { page, storage } = pageWith();
  await editDraft(page);
  const next = pageWith({ storage, request: async () => { throw new Error("offline"); } });
  await next.page.confirmFinish();
  assert.equal(next.page.data.stage, "working");
  assert.notEqual(next.page.data.reportQuantity, "27");
});

test("成功提交清草稿；服务端已完成的任务也不再恢复草稿", async () => {
  const { page, storage } = pageWith({ request: async (path) => path.endsWith("finish-default") ? defaults : { assignment: task({ status: "SUCCEEDED", durationSeconds: 60 }) } });
  await editDraft(page);
  await page.finishWork();
  const next = pageWith({ storage });
  await next.page.confirmFinish();
  assert.equal(next.page.data.reportQuantity, "10");
  await editDraft(next.page);
  const ended = pageWith({ storage, request: async () => ({ assignments: [] }) });
  await ended.page.loadAssignment();
  const reopened = pageWith({ storage });
  await reopened.page.confirmFinish();
  assert.equal(reopened.page.data.reportQuantity, "10");
});

test("存储失败不阻断输入且明确草稿未保存；失效不良原因必须重新选择", async () => {
  const failed = pageWith({ wxOverrides: { setStorageSync() { throw new Error("quota exceeded"); } } });
  await failed.page.confirmFinish();
  failed.page.onQuantityInput({ detail: { value: "31" } });
  assert.equal(failed.page.data.reportQuantity, "31");
  assert.match(failed.page.data.draftNotice, /无法保存/);
  const unreadable = pageWith({ wxOverrides: { getStorageSync() { throw new Error("unavailable"); } } });
  await unreadable.page.confirmFinish();
  assert.match(unreadable.page.data.draftNotice, /无法读取/);
  const { page, storage } = pageWith();
  await editDraft(page);
  const changed = pageWith({ storage, request: async () => ({ ...defaults, defectReasons: [{ code: "D2", name: "新原因" }] }) });
  await changed.page.confirmFinish();
  assert.equal(changed.page.data.reportQuantity, "27");
  assert.deepEqual(Array.from(changed.page.data.reportDefectCodes), []);
  assert.match(changed.page.data.draftNotice, /重新选择/);
});
