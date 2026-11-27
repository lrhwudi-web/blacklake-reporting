import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function setup(request = async () => ({})) {
  let page;
  const intervals = new Map();
  let timerId = 0;
  const modals = [];
  vm.runInNewContext(readFileSync(new URL("../pages/dispatch/dispatch.js", import.meta.url), "utf8"), {
    Page: (value) => { page = value; }, require: () => ({ request }), getApp: () => ({ globalData: {} }),
    wx: { showToast() {}, showModal(options) { modals.push(options); }, vibrateShort() {}, getWindowInfo: () => ({windowWidth:375,windowHeight:667}) },
    setInterval(callback) { const id = ++timerId; intervals.set(id, callback); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout: () => ++timerId, clearTimeout() {}, Date
  });
  page.setData = (values, callback) => { Object.assign(page.data, values); callback?.(); };
  Object.assign(page.data, { ready: true, stage: "people", reviewOpen: true, selectedUnit: { id: "A-03" }, workOrder: {projectCode:"WO-100"}, flowCode: "FLOW", selectedEmployeeIds: [1,2],
    employees:[{blacklakeOperatorId:1,name:"王师傅",available:true,boundUnitIds:["A-03"]},{blacklakeOperatorId:2,name:"李师傅",available:true,boundUnitIds:["B-02"]}],
    processes:[{taskId:7,processName:"车耳朵",defaultQuantity:100}], selectedProcessId:7 });
  return {page,intervals,modals};
}
test("预测失败或返回无法确认的内容时保留人工人员与工序，不猜第一项", async () => {
  for (const request of [async () => { throw new Error("offline"); }, async () => ({otherProcesses:[{taskId:7,processName:"车耳朵"}]})]) {
    const {page} = setup(request);
    page.data.stage = "process";
    await page.loadPrediction();
    assert.equal(page.data.selectedProcessId, 7);
    assert.deepEqual(Array.from(page.data.selectedEmployeeIds), [1,2]);
    assert.match(page.data.predictionError, /手动选择/);
  }
});
test("选人摘要保留姓名，人员变化清空旧工序以重新判断", () => {
  const {page} = setup();
  page.updateConfirmationSummary();
  assert.equal(page.data.selectedEmployeeNames, "王师傅、李师傅");
  assert.equal(page.data.selectedProcessName, "车耳朵");
  page.chooseEmployee({currentTarget:{dataset:{operatorId:2}}});
  assert.equal(page.data.selectedEmployeeNames, "王师傅");
  assert.equal(page.data.selectedProcessName, "待选择工序");
});
test("总览请求不重叠，隐藏页后迟到结果不修改选择且停止轮询", async () => {
  let resolve;
  let requests = 0;
  const {page,intervals} = setup(() => { requests++; return new Promise((done) => { resolve = done; }); });
  page.onShow();
  const pending = page.loadOverview();
  assert.equal(requests,1);
  assert.ok(intervals.size > 0);
  page.onHide();
  assert.equal(intervals.size,0);
  resolve({units:[],employees:[]});
  await pending;
  assert.equal(page.data.selectedEmployeeIds.length,2);
});
test("弹层刷新发现人员忙碌时保留勾选并阻止确认，不静默改成另一批人", async () => {
  const calls=[];
  const {page} = setup(async(path) => { calls.push(path); return {units:[{id:"A-03",canAssign:true}],employees:[{blacklakeOperatorId:1,name:"王师傅",available:false},{blacklakeOperatorId:2,name:"李师傅",available:true}]}; });
  page.data.sheetOpen=true;
  page.data.sheetStep="process";
  await page.loadOverview();
  assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[1,2]);
  assert.match(page.data.selectionWarning,/重新/);
  await page.confirmAssignment();
  assert.equal(calls.includes("/v1/dispatch/assign"),false);
});
test("分配记录读取失败保留旧记录并显示错误，真实空列表才显示空态", async () => {
  let fail=false;
  const {page} = setup(async () => { if(fail) throw new Error("offline"); return {assignments:[{id:"record",status:"READY",operatorName:"王师傅",unitId:"A-03",canCancel:true}],date:"2026-10-22",total:1,limit:100,truncated:false}; });
  page.data.historyOpen=true;
  await page.loadHistory();
  assert.equal(page.data.historyAssignments[0].statusText,"待开始");
  fail=true;
  await page.loadHistory();
  assert.equal(page.data.historyAssignments.length,1);
  assert.match(page.data.historyError,/offline/);
});
test("待核量与结果待核对分开显示，未完成任务没有实际产量", async () => {
  const {page} = setup(async()=>({assignments:[{id:"q",status:"QUANTITY_PENDING",quantity:100},{id:"u",status:"NEEDS_REVIEW",quantity:100}],date:"2026-10-22",total:2}));
  page.data.historyOpen=true;
  await page.loadHistory();
  assert.equal(page.data.historyAssignments[0].statusText,"待核量");
  assert.equal(page.data.historyAssignments[1].statusText,"报工待核对");
  assert.equal(page.data.historyAssignments[0].actualQuantityText,"暂未计入产量");
});

test("撤销无需写原因，连续点击只发一次请求，成功后刷新权威状态", async () => {
  const calls=[];
  let resolveCancel;
  const {page} = setup((path,options={}) => {
    calls.push({path,options});
    if(path.endsWith("/cancel")) return new Promise((resolve)=>{resolveCancel=resolve;});
    if(path.startsWith("/v1/dispatch/history")) return Promise.resolve({assignments:[{id:"r1",status:"CANCELLED",canCancel:false}],total:1});
    return Promise.resolve({units:[],employees:[]});
  });
  page.data.historyOpen=true;
  page.data.historyAssignments=[{id:"r1",status:"READY",canCancel:true}];
  page.beginCancelAssignment({currentTarget:{dataset:{assignmentId:"r1"}}});
  const pending=page.cancelReadyAssignment();
  await page.cancelReadyAssignment();
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,"/v1/dispatch/assignments/r1/cancel");
  assert.deepEqual(Object.keys(calls[0].options.data),[]);
  resolveCancel({assignment:{id:"r1",status:"CANCELLED"}});
  await pending;
  assert.equal(page.data.historyAssignments[0].statusText,"已撤销");
  assert.equal(page.data.cancelAssignmentId,"");
});

test("分配完成保留本次记录标识和入口，8楼请求明确数量待核对", async () => {
  const calls=[];
  const {page} = setup(async(path,options={}) => {
    calls.push({path,options});
    if(path.endsWith("/assign")) return {assignments:[{id:"a"},{id:"b"}],assignment:{id:"a"}};
    return {units:[],employees:[]};
  });
  await page.confirmAssignment();
  assert.equal(calls[0].options.data.quantityPolicy,"PENDING_REVIEW");
  assert.deepEqual(Array.from(page.data.lastDispatchIds),["a","b"]);
  assert.match(page.data.notice,/今日分配/);
});

test("隐藏后重进等待旧总览结束再取新状态，旧响应不能恢复到旧人员", async () => {
  const resolvers=[];
  const {page} = setup(()=>new Promise((resolve)=>resolvers.push(resolve)));
  page.onShow();
  page.onHide();
  page.onShow();
  assert.equal(resolvers.length,1);
  resolvers[0]({units:[],employees:[]});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(resolvers.length,2);
  resolvers[1]({units:[],employees:[{blacklakeOperatorId:1,name:"新状态",available:true}]});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(page.data.employees[0].name,"新状态");
});

