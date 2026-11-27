import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProductionAnomalies, summarizeProductionAnomalies } from "../src/anomaly-rules.mjs";

const BASE = {
  projectId: 1,
  projectCode: "WO-1",
  taskId: 10,
  productName: "手提袋",
  processName: "袋口压明线",
  quantity: 10,
  operatorName: "刘师傅"
};

test("长周期工单即使持续一个月也不会仅因经过时间被判异常", () => {
  const [assignment] = evaluateProductionAnomalies([{
    ...BASE,
    id: "month-long",
    status: "IN_PROGRESS",
    startedAt: "2026-07-25 09:00:00"
  }], { now: "2026-08-25 16:30:00" });

  assert.equal(assignment.hasProductionAnomaly, false);
  assert.equal(assignment.productionStatus, "IN_PROGRESS");
  assert.deepEqual(assignment.productionAnomalies, []);
});

test("只有超过明确计划节点和预计结束时间才判异常", () => {
  const [assignment] = evaluateProductionAnomalies([{
    ...BASE,
    id: "planned-1",
    status: "IN_PROGRESS",
    startedAt: "2026-08-25 09:00:00",
    expectedProgressAt: "2026-08-25 15:00:00",
    expectedEndAt: "2026-08-25 15:30:00"
  }], {
    now: "2026-08-25 16:30:00",
    rules: { deadlineGraceSeconds: 30 * 60 }
  });

  assert.deepEqual(assignment.productionAnomalies.map((item) => item.code), [
    "PROCESS_STALLED",
    "OPERATOR_NOT_FINISHED"
  ]);
  assert.equal(assignment.productionStatus, "EXCEPTION");
  assert.match(assignment.productionAnomalies[0].message, /计划进度节点/);
});

test("计划节点仍在宽限期内不判异常", () => {
  const [assignment] = evaluateProductionAnomalies([{
    ...BASE,
    id: "within-grace",
    status: "IN_PROGRESS",
    expectedProgressAt: "2026-08-25 16:15:00",
    expectedEndAt: "2026-08-25 16:15:00"
  }], {
    now: "2026-08-25 16:30:00",
    rules: { deadlineGraceSeconds: 30 * 60 }
  });

  assert.deepEqual(assignment.productionAnomalies, []);
});

test("普通生产历时包含停工时不参与净作业用时异常判定", () => {
  const [assignment] = evaluateProductionAnomalies([{
    ...BASE,
    id: "paused-for-days",
    status: "COMPLETED",
    durationSeconds: 7 * 24 * 3600,
    expectedDurationSeconds: 3600
  }]);

  assert.deepEqual(assignment.productionAnomalies, []);
});

test("明确提供净作业用时和基准后识别明显偏长", () => {
  const [assignment] = evaluateProductionAnomalies([{
    ...BASE,
    id: "net-active-outlier",
    status: "COMPLETED",
    durationSeconds: 7 * 24 * 3600,
    netActiveDurationSeconds: 4 * 3600,
    expectedDurationSeconds: 3600
  }], {
    rules: { durationMultiplier: 3, durationMinimumExcessSeconds: 60 * 60 }
  });

  assert.equal(assignment.productionAnomalies[0].code, "DURATION_TOO_LONG");
  assert.match(assignment.productionAnomalies[0].message, /明确作业基准/);
});

test("同产品同工序净工时样本足够后才使用统计基准", () => {
  const assignments = [600, 620, 580, 610, 590, 3600].map((netActiveDurationSeconds, index) => ({
    ...BASE,
    id: `done-${index}`,
    status: "COMPLETED",
    durationSeconds: netActiveDurationSeconds,
    netActiveDurationSeconds
  }));
  const evaluated = evaluateProductionAnomalies(assignments, {
    rules: {
      durationBaselineMinSamples: 5,
      durationMultiplier: 3,
      durationMinimumExcessSeconds: 30 * 60
    }
  });

  assert.equal(evaluated.at(-1).productionAnomalies[0].code, "DURATION_TOO_LONG");
  assert.equal(evaluated.at(-1).productionAnomalies[0].baselineSampleCount, 6);
  assert.match(evaluated.at(-1).productionAnomalies[0].message, /同产品同工序/);
});

test("同一工序多人超过同一计划节点只汇总为一项工序异常", () => {
  const evaluated = evaluateProductionAnomalies([
    { ...BASE, id: "parallel-1", status: "IN_PROGRESS", expectedProgressAt: "2026-08-25 15:00:00" },
    { ...BASE, id: "parallel-2", operatorName: "王师傅", status: "IN_PROGRESS", expectedProgressAt: "2026-08-25 15:00:00" }
  ], {
    now: "2026-08-25 16:30:00",
    rules: { deadlineGraceSeconds: 30 * 60 }
  });

  assert.equal(evaluated.every((item) => item.hasProductionAnomaly), true);
  assert.equal(summarizeProductionAnomalies(evaluated).total, 1);
});
