import {workTimeBreakdown} from '../../api/src/work-time.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function pageWith(request, time = () => 60, wxOverrides = {}) {
  let page;
  vm.runInNewContext(readFileSync(new URL("../pages/report/report.js", import.meta.url), "utf8"), {
    Page: (definition) => { page = definition; },
    getApp: () => ({ globalData: {} }),
    require: (path) => path.endsWith("work-time") ? { workTimeBreakdown:(...args)=>{time(...args);return workTimeBreakdown(...args);} } : { request },
    wx: { showToast() {}, showModal() {}, vibrateShort() {}, ...wxOverrides },
    setInterval: () => 1, clearInterval() {}, Date
  });
  page.setData = (values) => Object.assign(page.data, values);
  return page;
}

test("质检有不良数时可以多选原因且不分别填数量", async () => {
  let submitted;
  const toasts = [];
  const page = pageWith(async (_path, options) => {
    submitted = options.data;
    return { assignment: { durationSeconds: 60 } };
  }, () => 60, {
    showToast(options) { toasts.push(options); }
  });
  page.data.assignment = { id: "test-quality-assignment", status: "IN_PROGRESS", attemptNumber: 1, isQualityInspection: true };
  page.data.defectReasons = [
    { code: "BL202501090006", name: "车缝不良" },
    { code: "BL202501090005", name: "染色不良" }
  ];
  page.data.reportQuantity = "0";
  page.data.reportDefectQuantity = "1";

  await page.finishWork();
  assert.equal(submitted, undefined);
  assert.equal(toasts.at(-1).title, "请选择不良原因");

  page.chooseDefectReason({ currentTarget: { dataset: { code: "BL202501090006" } } });
  page.chooseDefectReason({ currentTarget: { dataset: { code: "BL202501090005" } } });
  assert.equal(toasts.at(-1).title, "原因不能多于不良件数");
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.reportDefectCodes)), ["BL202501090006"]);
  page.onDefectInput({ detail: { value: "3" } });
  page.chooseDefectReason({ currentTarget: { dataset: { code: "BL202501090005" } } });
  await page.finishWork();
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), {
    quantity: 0,
    defectQuantity: 3,
    defectCodes: ["BL202501090006", "BL202501090005"]
  });
  assert.equal(page.data.stage, "success");
});

test("提交结果未知后退出数量编辑，不再误显示可提交状态", async () => {
  const page = pageWith(async () => ({ assignment: { id: "pending", quantity: 10, status: "NEEDS_REVIEW" } }));
  page.data.stage = "finish";
  await page.loadAssignment();
  assert.equal(page.data.stage, "working");
  assert.equal(page.data.assignment.status, "NEEDS_REVIEW");
});

test("失败重试页面使用服务器首次结束时间，等待期间不增加计时", () => {
  let end;
  const page = pageWith(async () => ({}), (_start, value) => { end = value; return 600; });
  page.data.assignment = { startedAt: "2026-09-07 10:00:00", endedAt: "2026-09-07 10:10:00" };
  page.updateElapsed();
  assert.equal(end, "2026-09-07 10:10:00");
  assert.equal(page.data.elapsedText, "00:10:00");
});

test("工单删除导致报工失败时，确认后取消本地任务并回到等待分配", async () => {
  const calls = [];
  const modals = [];
  const page = pageWith(async (path) => {
    calls.push(path);
    if (path.endsWith("/finish")) {
      const error = new Error("黑湖中已找不到这张工单。");
      error.code = "WORK_ORDER_NOT_FOUND";
      throw error;
    }
    if (path === "/v1/assignments/current") {
      return { assignment: {
        id: "deleted-assignment", attemptNumber: 1, status: "IN_PROGRESS",
        quantity: 20, goodQuantity: 20, defectQuantity: 0,
        startedAt: "2026-09-08 13:00:00", endedAt: "2026-09-08 13:10:00",
        canWorkerCancel: true
      } };
    }
    if (path.endsWith("/cancel")) return { assignment: { id: "deleted-assignment", status: "CANCELLED" } };
    throw new Error(`unexpected request: ${path}`);
  }, () => 600, {
    showModal(options) {
      modals.push(options);
      options.success?.({ confirm: true, cancel: false });
    }
  });
  page.data.assignment = {
    id: "deleted-assignment", attemptNumber: 1, status: "IN_PROGRESS",
    quantity: 20, goodQuantity: 20, defectQuantity: 0,
    startedAt: "2026-09-08 13:00:00"
  };
  page.data.stage = "finish";
  page.data.reportQuantity = "20";

  await page.finishWork();

  assert.equal(modals.length, 1);
  assert.equal(modals[0].title, "工单已删除");
  assert.equal(calls.some((path) => path.endsWith("/cancel")), true);
  assert.equal(page.data.assignment, null);
  assert.equal(page.data.stage, "waiting");
  assert.equal(page.data.headline, "等待分配");
});

test("黑湖工序已结束后提示已自动退出并回到等待分配，不让工人卡住", async () => {
  const modals = [];
  const page = pageWith(async (path) => {
    if (path.endsWith("/finish")) {
      const error = new Error("黑湖工序已结束，本地任务已自动退出，可以重新扫码。");
      error.code = "TASK_CLOSED";
      throw error;
    }
    if (path === "/v1/assignments/current") return { assignment: null, assignments: [] };
    throw new Error(`unexpected request: ${path}`);
  }, () => 60, {
    showModal(options) {
      modals.push(options);
      options.success?.({ confirm: true, cancel: false });
    }
  });
  page.data.assignment = {
    id: "closed-assignment", attemptNumber: 1, status: "IN_PROGRESS",
    quantity: 1000, goodQuantity: 1000, defectQuantity: 0,
    startedAt: "2026-09-14 09:00:00"
  };
  page.data.activeAssignments = [page.data.assignment];
  page.data.stage = "finish";
  page.data.reportQuantity = "1000";

  await page.finishWork();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(modals.length, 1);
  assert.equal(modals[0].title, "工序已结束");
  assert.match(modals[0].content, /自动退出/);
  assert.equal(page.data.assignment, null);
  assert.equal(page.data.stage, "waiting");
  assert.equal(page.data.headline, "等待分配");
});

test("绣花工人按工单、机器码、前后幅开工，并在多台机器任务间切换", async () => {
  const assignments = [
    { id: "emb-1", taskId: 101, projectCode: "WO-1", processName: "外协加工", quantity: 50, status: "IN_PROGRESS", isEmbroidery: true, machineId: "01", embroideryPart: "前幅" },
    { id: "emb-2", taskId: 102, projectCode: "WO-2", processName: "外协加工KL", quantity: 80, status: "IN_PROGRESS", isEmbroidery: true, machineId: "02", embroideryPart: "后幅" }
  ];
  const calls = [];
  const page = pageWith(async (path, options = {}) => {
    calls.push({ path, data: options.data });
    if (path === "/v1/assignments/current") return { assignment: assignments[0], assignments };
    if (path === "/v1/flow/options") return {
      workOrder: { projectCode: "WO-3" },
      processes: [{ taskId: 103, processName: "外协加工KL", sequence: 20, defaultQuantity: 100 }],
      embroideryProcess: { taskId: 103, processName: "外协加工KL", sequence: 20, defaultQuantity: 100 }
    };
    if (path === "/v1/flow/embroidery-machine") return { machine: { id: "08", name: "08 号绣花机" }, parts: ["前幅", "后幅"] };
    if (path === "/v1/flow/start") return { assignment: { ...assignments[0], id: "emb-3", taskId: 103, projectCode: "WO-3", machineId: "08", embroideryPart: "前幅" } };
    throw new Error(`unexpected request: ${path}`);
  });

  page.data.reportingMode = "embroidery";
  page.data.cuttingSelfService = true;

  await page.loadAssignment();
  assert.equal(page.data.activeAssignments.length, 2);
  assert.equal(page.data.activeAssignments[0].machineText, "01 号机 · 前幅");
  page.selectActiveAssignment({ currentTarget: { dataset: { assignmentId: "emb-2" } } });
  assert.equal(page.data.assignment.id, "emb-2");
  assert.equal(page.data.assignment.machineText, "02 号机 · 后幅");
  page.startAnotherEmbroidery();
  assert.equal(page.data.stage, "scan");
  assert.equal(page.data.addingParallel, true);
  await page.loadAssignment();
  assert.equal(page.data.stage, "scan", "打开下一台时后台刷新不能把用户弹回原任务");

  await page.loadFlowOptions("WORK-ORDER-QR");
  assert.equal(page.data.stage, "scan-machine");
  assert.equal(page.data.selectedProcess.taskId, 103);
  await page.resolveEmbroideryMachineCode("MACHINE-08");
  assert.equal(page.data.stage, "select-embroidery-part");
  assert.equal(page.data.machineId, "08");
  page.chooseEmbroideryPart({ currentTarget: { dataset: { part: "前幅" } } });
  assert.equal(page.data.stage, "confirm-start");
  await page.startSelectedProcess();
  const started = calls.find((call) => call.path === "/v1/flow/start");
  assert.deepEqual(JSON.parse(JSON.stringify(started.data)), {
    flowCode: "WORK-ORDER-QR", taskId: 103, reportingMode: "embroidery", machineId: "08", embroideryPart: "前幅"
  });
  assert.equal(page.data.assignment.machineText, "08 号机 · 前幅");
  assert.equal(calls.some((call) => call.path === "/v1/embroidery/schedule"), false);
});

test("绣花部无需选择便默认进入绣花机报工，必要时仍可切换普通报工", () => {
  const vibrations = [];
  const page = pageWith(async () => ({}), () => 60, {
    vibrateShort(options) { vibrations.push(options.type); }
  });
  page.data.reportingModes = ["embroidery", "standard"];
  page.data.reportingMode = "embroidery";
  page.data.canSwitchReportingMode = true;

  page.setReportingMode({ currentTarget: { dataset: { mode: "standard" } } });

  assert.equal(page.data.reportingMode, "standard");
  assert.equal(page.data.stage, "scan");
  assert.equal(page.data.headline, "扫描工单码");
  assert.deepEqual(vibrations, ["light"]);
});
