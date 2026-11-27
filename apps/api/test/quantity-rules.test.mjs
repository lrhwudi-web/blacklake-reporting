import test from "node:test";
import assert from "node:assert/strict";
import { BlacklakeClient } from "../src/blacklake-client.mjs";

async function options(rows) {
  const client = new BlacklakeClient({ mode: "live", baseUrl: "https://blacklake.invalid", staticToken: "TEST", taskQueryPath: "/tasks", timeoutMs: 1000 },
    async () => new Response(JSON.stringify({ code: "01000000", data: rows.map((row) => ({ projectId: 123, projectCode: "TEST", planAmount: 100, ...row })) }), { status: 200 }));
  return client.listWorkOrderProcesses("https://liteapp.blacklake.cn/pages/index/workOrderDetail/index?id=123");
}

test("达到计划但黑湖未关闭的工序仍可继续超产报工", async () => {
  const result = await options([{ id: 1, seq: 1, processName: "缝制", fineAmount: 100, remnantAmount: 0, processStatus: 10 }, { id: 2, seq: 2, processName: "关闭任务", fineAmount: 100, processStatus: 20 }]);
  assert.deepEqual(result.map((row) => row.taskId), [1]);
});

test("上一道全部不良也不继承数量，下一道使用自己的计划100", async () => {
  const result = await options([{ id: 1, seq: 1, processName: "质检", fineAmount: 0, defectsAmount: 100, processStatus: 20 }, { id: 2, seq: 2, processName: "包装", fineAmount: 0 }]);
  assert.equal(result[0].defaultReportAmount, 100);
  assert.equal(result[0].quantitySource, "PLAN_AMOUNT");
});

test("同序号并行工序不按任务ID强行继承，使用计划参考数", async () => {
  const result = await options([{ id: 1, seq: 1, processName: "并行A", fineAmount: 30 }, { id: 2, seq: 1, processName: "并行B", fineAmount: 20 }, { id: 3, seq: 2, processName: "后道" }]);
  assert.equal(result[1].defaultReportAmount, 100);
  assert.equal(result[2].defaultReportAmount, 100);
});


test('前道少报或超报都不改变后道自己的计划；缺少本工序计划不能借用前道良品',async()=>{
 const result=await options([{id:1,seq:1,fineAmount:86},{id:2,seq:2,planAmount:120,fineAmount:450},{id:3,seq:3,planAmount:0}]);
 assert.equal(result[1].defaultReportAmount,120);assert.equal(result[1].quantitySource,'PLAN_AMOUNT');assert.equal(result[2].defaultReportAmount,undefined);assert.equal(result[2].quantitySource,'PLAN_AMOUNT');
});
