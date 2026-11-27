import test from "node:test";
import assert from "node:assert/strict";
import { AdminSync } from "../src/admin-sync.mjs";
import { BlacklakeClient } from "../src/blacklake-client.mjs";

const ref = (id) => ({ projectId: id, projectCode: `QA-${id}` });
const task = (id, amount = 20) => ({ taskId: id * 10, projectId: id, projectCode: `QA-${id}`, reportedGoodAmount: amount });
const failure = () => Object.assign(new Error("must-not-log-secret"), { code: "BLACKLAKE_TIMEOUT", status: 504 });
function fixture(client, options = {}) {
  let now = 100000;
  const logs = [];
  const sync = new AdminSync({ queryOutputs: async () => [], ...client }, { now: () => now, log: (event) => logs.push(event), batchSize: 1, ...options });
  return { sync, logs, advance(ms = 61000) { now += ms; } };
}

test("一张工单查询失败仍返回其他成功工单，失败单保留完整旧快照", async () => {
  let fail = false;
  const f = fixture({ listProjectTasks: async ({ projectIds }) => { if (fail && projectIds[0] === 1) throw failure(); return [task(projectIds[0], fail ? 30 : 20)]; } });
  await f.sync.processes([ref(1), ref(2)]);
  f.advance(); fail = true;
  const result = await f.sync.processes([ref(1), ref(2)]);
  assert.equal(result[0].sync.status, "stale");
  assert.equal(result[0].tasks[0].reportedGoodAmount, 20);
  assert.equal(result[1].sync.status, "fresh");
  assert.equal(result[1].tasks[0].reportedGoodAmount, 30);
  assert.equal(f.logs[0].code, "BLACKLAKE_TIMEOUT");
  assert.doesNotMatch(JSON.stringify(f.logs), /must-not-log-secret/);
});
test("首次失败与成功查询无工序明确区分，不伪装成完整工艺", async () => {
  const f = fixture({ listProjectTasks: async ({ projectIds }) => { if (projectIds[0] === 1) throw failure(); return []; } });
  const result = await f.sync.processes([ref(1), ref(2)]);
  assert.deepEqual(result.map((x) => x.sync.status), ["unavailable", "empty"]);
  assert.equal(result[0].sync.updatedAt, null);
});
test("多用户同时刷新合并取数，失败后短期不重复冲击接口", async () => {
  let calls = 0, unblock;
  const f = fixture({ listProjectTasks: async () => { calls++; await new Promise((resolve) => { unblock = resolve; }); throw failure(); } });
  const first = f.sync.processes([ref(1)]), second = f.sync.processes([ref(1)]);
  await new Promise((resolve) => setImmediate(resolve));
  unblock();
  await Promise.all([first, second]);
  await f.sync.processes([ref(1)]);
  assert.equal(calls, 1);
});
test("恢复后更新快照并清除过期标记", async () => {
  let fail = true;
  const f = fixture({ listProjectTasks: async () => { if (fail) throw failure(); return [task(1)]; } });
  await f.sync.processes([ref(1)]);
  fail = false; f.advance();
  assert.equal((await f.sync.processes([ref(1)]))[0].sync.status, "fresh");
});
test("没有projectId时按工单编码查询，null不会被当成ID零", async () => {
  const f = fixture({ listProjectTasks: async (criteria) => { assert.deepEqual(criteria, { projectCodes: ["QA-1"] }); return [task(1)]; } });
  const result = await f.sync.processes([{ projectId: null, projectCode: "QA-1" }]);
  assert.equal(result[0].tasks.length, 1);
});
test("报工列表同步失败也保留上次记录，防止整批工单消失", async () => {
  let fail = false;
  const f = fixture({ queryOutputs: async () => { if (fail) throw failure(); return [{ id: 1 }]; } });
  await f.sync.outputs(); f.advance(); fail = true;
  const result = await f.sync.outputs();
  assert.equal(result.sync.status, "stale");
  assert.deepEqual(result.records, [{ id: 1 }]);
});
test("过旧快照停止当作可用数据返回", async () => {
  let fail = false;
  const f = fixture({ listProjectTasks: async () => { if (fail) throw failure(); return [task(1)]; } });
  await f.sync.processes([ref(1)]); f.advance(86400001); fail = true;
  const result = await f.sync.processes([ref(1)]);
  assert.equal(result[0].sync.status, "unavailable");
  assert.equal(result[0].tasks.length, 0);
});

test("真实客户端第二页超时不把第一页当完整工艺，也不清空其他工单", async () => {
  let fail = false;
  const client = new BlacklakeClient({ mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TOKEN",
    taskQueryPath: "/tasks", timeoutMs: 1000 }, async (_url, options) => {
    const request = JSON.parse(options.body);
    const id = request.projectIds[0];
    if (fail && id === 1 && request.page.pageNum === 2) throw Object.assign(new Error(), { name: "TimeoutError" });
    const count = id === 1 && request.page.pageNum === 1 ? 100 : 1;
    const list = Array.from({ length: count }, (_, index) => ({ id: id * 1000 + request.page.pageNum * 100 + index,
      projectId: id, projectCode: `QA-${id}`, processName: `工序${index}`, seq: index, planAmount: 100 }));
    return new Response(JSON.stringify({ code: "01000000", data: { list } }));
  });
  const f = fixture({ listProjectTasks: (criteria) => client.listProjectTasks(criteria) });
  const first = await f.sync.processes([ref(1), ref(2)]);
  assert.equal(first[0].tasks.length, 101);
  f.advance(); client.taskCache.clear(); fail = true;
  const result = await f.sync.processes([ref(1), ref(2)]);
  assert.equal(result[0].sync.status, "stale");
  assert.equal(result[0].tasks.length, 101);
  assert.equal(result[1].sync.status, "fresh");
  assert.equal(result[1].tasks.length, 1);
});
