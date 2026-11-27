import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";

function fixture() {
  const store = new Store(":memory:", { sessionSecret: "test-recovery-secret-not-for-production", sessionDays: 30 });
  const operator = store.upsertBlacklakeOperator({ name: "测试工人", blacklakeOperatorId: 1 });
  const assignment = store.claimFlowAssignment({
    id: "test-assignment", operatorId: operator.id, taskId: 100, projectId: 200,
    projectCode: "TEST", productName: "测试产品", processName: "测试工序", quantity: 100,
    startedAt: "2026-09-07 10:00:00", flowCodeHash: "test-flow"
  });
  return { store, operator, assignment };
}

test("进程重启把未确认提交转为待核对，不自动重发或释放人员", () => {
  const { store, operator, assignment } = fixture();
  try {
    store.prepareAssignmentCompletion({ assignmentId: assignment.id, operatorId: operator.id,
      endedAt: "2026-09-07 10:10:00", durationSeconds: 600, assessment: null,
      report: { id: "report-1", idempotencyKey: "restart-report-key-1", requestHash: "hash-1",
        operatorId: operator.id, taskId: 100, projectId: 200, projectCode: "TEST",
        productName: "测试产品", processName: "测试工序", amount: 50, goodAmount: 50,
        defectAmount: 0, defectCode: "", outputTime: "2026-09-07 10:10:00" }
    });
    store.recoverInterruptedReports();
    assert.equal(store.assignmentById(assignment.id).status, "NEEDS_REVIEW");
    assert.equal(store.reportById("report-1").status, "UNKNOWN");
    assert.equal(store.currentAssignment(operator.id).id, assignment.id);
    store.resolveUnknownAsNotCreated(assignment.id);
    assert.equal(store.assignmentById(assignment.id).targetQuantity, 100);
    assert.equal(store.assignmentById(assignment.id).endedAt, "2026-09-07 10:10:00");
    store.recoverInterruptedReports();
    assert.equal(store.assignmentById(assignment.id).status, "IN_PROGRESS");
  } finally { store.close(); }
});

test("重启时本地已成功的报工只补全任务状态，不要求再次提交", () => {
  const { store, assignment } = fixture();
  try {
    store.db.prepare("UPDATE assignments SET status = 'REPORTING' WHERE id = ?").run(assignment.id);
    store.insertPendingReport({ id: "done", idempotencyKey: "already-done-1", requestHash: "done-hash", operatorId: assignment.operatorId,
      taskId: 100, projectId: 200, projectCode: "TEST", productName: "测试", processName: "测试", amount: 100, goodAmount: 100, defectAmount: 0, defectCode: "", outputTime: "2026-09-07 10:10:00" });
    store.markReportSucceeded("already-done-1", "blacklake-output-1");
    store.db.prepare("UPDATE assignments SET report_id = 'done' WHERE id = ?").run(assignment.id);
    store.recoverInterruptedReports();
    assert.equal(store.assignmentById(assignment.id).status, "COMPLETED");
    assert.equal(store.reportById("done").blacklake_output_id, "blacklake-output-1");
  } finally { store.close(); }
});
