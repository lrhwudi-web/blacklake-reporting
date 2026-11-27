import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { normalizeEmbroideryMachineCode } from "../src/embroidery.mjs";

const config = {
  sessionSecret: "embroidery-machine-test-secret-long-enough",
  sessionDays: 30
};

test("绣花机二维码支持网址、标准文本和两位机号，只接受01至12号机", () => {
  assert.equal(normalizeEmbroideryMachineCode("08"), "08");
  assert.equal(normalizeEmbroideryMachineCode("machine-8"), "08");
  assert.equal(normalizeEmbroideryMachineCode("绣花机 12"), "12");
  assert.equal(normalizeEmbroideryMachineCode("https://bh.kairaygolf.com/embroidery/machine?machineId=03"), "03");
  assert.equal(normalizeEmbroideryMachineCode("https://bh.kairaygolf.com/embroidery/machine/7"), "07");
  assert.equal(normalizeEmbroideryMachineCode("13"), "");
  assert.equal(normalizeEmbroideryMachineCode("普通工序码"), "");
});

test("同一工人可在不同机器操作同一绣花任务，机位占用和前后幅在重启后保留", () => {
  const directory = mkdtempSync(join(tmpdir(), "embroidery-machine-restart-"));
  const databasePath = join(directory, "reporting.sqlite");
  let store;
  try {
    store = new Store(databasePath, config);
    const operator = store.upsertBlacklakeOperator({ name: "绣花工人", blacklakeOperatorId: 8101 });
    const other = store.upsertBlacklakeOperator({ name: "另一工人", blacklakeOperatorId: 8102 });
    for (const [index, [machineId, embroideryPart]] of [["01", "前幅"], ["02", "后幅"]].entries()) {
      const assignment = store.claimFlowAssignment({
        id: `embroidery-active-${index}`, operatorId: operator.id, taskId: 99100,
        projectId: 88100, projectCode: "WO-EMB-1",
        productName: "绣花产品", processName: "外协加工KL", quantity: 100,
        machineId, embroideryPart,
        startedAt: `2026-09-11 10:0${index}:00`, flowCodeHash: "flow-1"
      }, { allowParallel: true });
      assert.ok(assignment);
    }
    assert.equal(store.activeAssignments(operator.id).length, 2);
    assert.equal(store.activeAssignmentByMachine("01").operatorId, operator.id);

    const occupied = store.claimFlowAssignment({
      id: "embroidery-conflict", operatorId: other.id, taskId: 99101,
      projectId: 88101, projectCode: "WO-EMB-2", productName: "绣花补单",
      processName: "外协加工", quantity: 50, machineId: "01", embroideryPart: "前幅",
      startedAt: "2026-09-11 10:02:00", flowCodeHash: "flow-2"
    }, { allowParallel: true });
    assert.equal(occupied, undefined);

    store.close();
    store = new Store(databasePath, config);
    assert.deepEqual(store.activeAssignments(operator.id).map((item) => [item.machineId, item.embroideryPart]), [["01", "前幅"], ["02", "后幅"]]);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("报工模式切换权限按黑湖人员ID持久化并区分同名人员", () => {
  const directory = mkdtempSync(join(tmpdir(), "reporting-permission-restart-"));
  const databasePath = join(directory, "reporting.sqlite");
  let store;
  try {
    store = new Store(databasePath, config);
    assert.equal(store.reportingModeSwitchPermission(4412231), undefined);
    assert.deepEqual(store.setReportingModeSwitchPermission(4412231, true), {
      blacklakeOperatorId: 4412231,
      canSwitch: true
    });
    store.setReportingModeSwitchPermission(4412232, false);
    store.close();
    store = new Store(databasePath, config);
    assert.equal(store.reportingModeSwitchPermission(4412231), true);
    assert.equal(store.reportingModeSwitchPermission(4412232), false);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("8楼旧单人驻位记录迁移为多人列表，重启后保留完整安排", () => {
  const directory = mkdtempSync(join(tmpdir(), "station-recommendations-restart-"));
  const databasePath = join(directory, "reporting.sqlite");
  let store;
  try {
    store = new Store(databasePath, config);
    store.db.prepare("INSERT INTO dispatch_unit_recommendations(unit_id, blacklake_operator_id) VALUES (?, ?)")
      .run("A-01", 31002);
    store.close();
    store = new Store(databasePath, config);
    assert.deepEqual(store.dispatchUnitRecommendations().map((item) => item.blacklakeOperatorId), [31002]);
    store.setDispatchUnitRecommendations("A-01", [31002, 31003], "admin");
    store.close();
    store = new Store(databasePath, config);
    assert.deepEqual(store.dispatchUnitRecommendations().map((item) => item.blacklakeOperatorId), [31002, 31003]);
    assert.equal(store.db.prepare("SELECT blacklake_operator_id AS id FROM dispatch_unit_recommendations WHERE unit_id = ?")
      .get("A-01").id, 31002);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
