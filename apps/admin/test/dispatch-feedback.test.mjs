import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const record = { predictionId: "p", projectCode: "TEST-WO", dispatcherName: "测试组长", createdAt: "2026-11-02T00:00:00Z",
  outcome: "ADJUSTED", batchId: "batch", reason: '<img src=x onerror="bad()">', changedFields: ["EMPLOYEES"],
  prediction: { processName: "车耳朵", employees: [{ name: "<script>bad()</script>", unitId: "A-01", evidence: { reportCount: 20, workOrderCount: 3, dominantShare: .8 } }],
    source: { version: "v-test", sourceRecordCount: 500, sourcePeriod: { from: "2026-01-01", to: "2026-08-24" } } },
  finalSelection: { processName: "车耳朵", employees: [{ name: "测试甲", unitId: "B-01" }] } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const sandbox = { window: {}, URLSearchParams, Date };
  vm.runInNewContext(readFileSync(new URL("../dispatch-feedback.js", import.meta.url), "utf8"), sandbox);
  const element = () => ({ innerHTML: "", dataset: {}, isConnected: true, listeners: {}, addEventListener(event, listener) { this.listeners[event] = listener; } });
  return { module: sandbox.window.BlacklakeDispatchFeedback, element };
}
test("后台反馈对比与证据完整显示，人员、工单和说明中的HTML被转义", async () => {
  const { module, element } = fixture(); const root = element();
  module.mount(root, { api: async () => ({ records: [record], total: 1, summary: { ADJUSTED: 1 } }) });
  await tick();
  assert.match(root.innerHTML, /人工调整/);
  assert.match(root.innerHTML, /初始预测[\s\S]*最终确认/);
  assert.match(root.innerHTML, /v-test/);
  assert.match(root.innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(root.innerHTML, /<script>|<img src=x/);
  assert.match(root.innerHTML, /不代表预测正确率/);
});
test("失败保留已有记录，筛选/分页以结构化参数发送且空态不伪装成成功", async () => {
  const { module, element } = fixture(); const root = element(); const calls = []; let fail = false;
  module.mount(root, { api: async (path) => { calls.push(path); if (fail) throw new Error("offline"); return { records: [record], total: 40, summary: {} }; } });
  await tick();
  root.listeners.submit({ preventDefault() {}, target: { elements: { query: { value: "  测试  " }, outcome: { value: "ADJUSTED" } } } });
  await tick();
  assert.match(calls.at(-1), /outcome=ADJUSTED/);
  assert.match(calls.at(-1), /q=%E6%B5%8B%E8%AF%95/);
  fail = true;
  root.listeners.click({ target: { closest: () => ({ dataset: { predictionAction: "next" } }) } });
  await tick();
  assert.match(calls.at(-1), /offset=30/);
  assert.match(root.innerHTML, /TEST-WO/);
  assert.match(root.innerHTML, /offline/);
  assert.doesNotMatch(root.innerHTML, /暂无已确认/);
});
test("离开模块后迟到结果不能写回新页面，演示模式不请求或泄漏正式缓存", async () => {
  const { module, element } = fixture(); const old = element(), next = element(); const resolves = [];
  const api = () => new Promise((resolve) => resolves.push(resolve));
  module.mount(old, { api });
  module.mount(null);
  module.mount(next, { api });
  resolves[0]({ records: [record], total: 1, summary: {} });
  resolves[1]({ records: [], total: 0, summary: {} });
  await tick();
  assert.doesNotMatch(next.innerHTML, /TEST-WO/);
  assert.match(next.innerHTML, /暂无已确认/);
  const demo = element(); let requests = 0;
  module.mount(demo, { demo: true, api: async () => { requests++; return {}; } });
  await tick();
  assert.equal(requests, 0);
  assert.doesNotMatch(demo.innerHTML, /TEST-WO/);
  assert.match(demo.innerHTML, /演示模式/);
});
