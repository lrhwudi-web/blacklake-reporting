import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const staff = [
  { blacklakeOperatorId: 103, name: "测试甲", description: "生产一组", departments: ["生产一组"], available: true, boundUnitIds: ["A-01"] },
  { blacklakeOperatorId: 104, name: "测试乙", description: "生产二组", departments: ["生产二组"], available: true, boundUnitIds: ["B-01"] },
  { blacklakeOperatorId: 105, name: "测试丙", description: "生产二组", departments: ["生产二组"], available: false, boundUnitIds: [] }
];
const processes = [{ taskId: 1, processName: "测试工序1" }, { taskId: 2, processName: "测试工序2" }];
const prediction = (id = "prediction-a", taskId = 1, people = [103, 104]) => ({
  id, taskId, processName: `测试工序${taskId}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7200000).toISOString(),
  notice: "已按历史预选，可直接调整", source: { sourcePeriod: { from: "2026-01-01", to: "2026-08-24" }, sourceRecordCount: 500, version: "test-v1" },
  employees: people.map((id) => ({ blacklakeOperatorId: id, name: staff.find((row) => row.blacklakeOperatorId === id)?.name,
    unitId: staff.find((row) => row.blacklakeOperatorId === id)?.boundUnitIds[0] }))
});
function setup(handler = async () => ({})) {
  let page;
  const calls = [], modals = [];
  vm.runInNewContext(readFileSync(new URL("../pages/dispatch/dispatch.js", import.meta.url), "utf8"), {
    Page: (value) => { page = value; }, getApp: () => ({ globalData: {} }), require: () => ({ request: async (path, options = {}) => {
      calls.push({ path, options }); return handler(path, options);
    } }), wx: { showToast() {}, showModal: (value) => modals.push(value), vibrateShort() {} },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, Date
  });
  page.setData = (values, callback) => { Object.assign(page.data, values); callback?.(); };
  Object.assign(page.data, { ready: true, stage: "people", flowCode: "FLOW-TEST", workOrder: { projectCode: "WO-TEST" },
    employees: staff.map((row) => ({ ...row, selected: false, boundUnitLabel: row.boundUnitIds.join("、") || "未绑定工位" })),
    processes, processOptions: [{ taskId: null, processName: "请选择工序" }, ...processes], units: [{ id: "A-01" }, { id: "B-01" }] });
  page.updateEmployeeView();
  return { page, calls, modals };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('组长完整进度路线保留关闭项只读，按所选人员推荐并自动定位',async()=>{
 const{page,calls}=setup(async()=>({prediction:prediction('leader-progress',2,[103])}));
 page.data.processOverview=[{taskId:99,sequence:1,processName:'已关闭',closed:true,selectable:false,percentLabel:'100%',statusLabel:'已关闭'},...processes.map((p,i)=>({...p,sequence:i+2,selectable:true,percentLabel:i?'109%':'45%',statusLabel:i?'超计划':'进行中',overPlan:!!i}))];
 await enterProcess(page,[103]);assert.equal(page.data.processWheelItems.length,3);assert.equal(page.data.processWheelItems[0].selectable,false);assert.equal(page.data.selectedProcessId,2);assert.equal(page.data.processScrollTarget,'process-card-2');
 page.selectPersonProcess({currentTarget:{dataset:{taskId:99}}});assert.equal(page.data.selectedProcessId,2);assert.equal(calls.some(c=>c.path.endsWith('/assign')),false);
 page.selectPersonProcess({currentTarget:{dataset:{taskId:1}}});assert.equal(page.data.selectedProcessId,1);assert.equal(page.data.prediction.taskId,2);assert.equal(page.data.predictionAdjusted,true);
});

test('组长遇旧后端进度保持未知，全部关闭不请求无效推荐或派工',async()=>{
 const{page,calls}=setup();page.updateConfirmationSummary();assert.equal(page.data.processWheelItems[0].percentLabel,'—');
 page.data.processes=[];page.data.processOptions=[{taskId:null}];page.data.processOverview=[{taskId:99,closed:true,selectable:false,statusLabel:'已关闭'}];
 await enterProcess(page,[103]);assert.equal(page.data.processWheelItems.length,1);assert.equal(page.data.selectedProcessId,null);assert.equal(calls.length,0);
});

const choose = (page,id) => page.chooseEmployee({currentTarget:{dataset:{operatorId:id}}});
async function enterProcess(page,ids=[103,104]) { for(const id of ids)choose(page,id);page.continueToProcess();await tick(); }

test("先明确选人再请求工序建议，响应中的人员不能改变组长选择",async()=>{
  const {page,calls}=setup(async path=>path.endsWith('/prediction')?{prediction:prediction('p',1,[103,104,105])}:path.endsWith('/assign')?{assignments:[{id:'a'}]}:{units:[],employees:staff});
  await page.loadPrediction();assert.equal(calls.length,0);assert.equal(page.data.selectedEmployeeIds.length,0);
  await enterProcess(page,[103]);assert.equal(page.data.stage,'process');assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103]);assert.equal(page.data.selectedProcessId,1);
  assert.equal(page.data.processScrollTarget,'process-card-1');
  assert.deepEqual(Array.from(calls.find(c=>c.path.endsWith('/prediction')).options.data.blacklakeOperatorIds),[103]);
  assert.equal(calls.some(c=>c.path.endsWith('/assign')),false);page.reviewAssignment();await page.confirmAssignment();
  const payload=calls.find(c=>c.path.endsWith('/assign')).options.data;assert.equal(payload.predictionId,'p');assert.deepEqual(Array.from(payload.blacklakeOperatorIds),[103]);assert.equal(page.data.stage,'people');
});
test("搜索与跨部门筛选保留选择，人员变更清除旧工序及预测",()=>{
  const {page}=setup();choose(page,103);page.onDepartmentChange({detail:{value:2}});assert.deepEqual(Array.from(page.data.visibleEmployees,p=>p.blacklakeOperatorId),[104]);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103]);
  page.data.selectedProcessId=1;page.data.predictionRootId='old';choose(page,104);assert.equal(page.data.selectedProcessId,null);assert.equal(page.data.predictionRootId,'');
});
test("迟到工序建议不覆盖人工工序，隐藏或重新选人后的响应丢弃",async()=>{
  for(const action of ['manual','hide','people']){let resolve;const {page}=setup(()=>new Promise(r=>resolve=r));choose(page,103);page.continueToProcess();
    if(action==='manual')page.onProcessChange({detail:{value:2}});if(action==='hide')page.onHide();if(action==='people'){page.backToPeople();choose(page,104);}
    resolve({prediction:prediction()});await tick();assert.equal(page.data.selectedProcessId,action==='manual'?2:null);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),action==='people'?[103,104]:[103]);
    assert.equal(page.data.predictionRootId,action==='manual'?'prediction-a':'');
    assert.equal(page.data.processScrollTarget,'','迟到建议不得强行滚动人工选择');
  }
});
test("手动改工序不触发换人预测，重新推荐仅重选工序并保留初始对照",async()=>{
  const {page,calls}=setup(async()=>({prediction:prediction('prediction-a',1,[104])}));await enterProcess(page,[103]);const count=calls.length;
  page.onProcessChange({detail:{value:2}});assert.equal(calls.length,count);assert.equal(page.data.selectedProcessId,2);assert.equal(page.data.predictionAdjusted,true);
  page.usePredictionAgain();await tick();assert.equal(page.data.selectedProcessId,1);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103]);assert.equal(page.data.predictionRootId,'prediction-a');
});
test("建议失败仍可人工选工序并确认，不伪造反馈ID",async()=>{
  const {page,calls}=setup(async path=>{if(path.endsWith('/prediction'))throw Error('offline');return path.endsWith('/assign')?{assignments:[{id:'a'}]}:{units:[],employees:staff};});
  await enterProcess(page,[103]);assert.match(page.data.predictionError,/手动选择/);page.onProcessChange({detail:{value:1}});page.reviewAssignment();await page.confirmAssignment();
  assert.equal('predictionId' in calls.find(c=>c.path.endsWith('/assign')).options.data,false);
});
test("过期工序建议刷新建立新基线，不继承旧预测ID",async()=>{
  const {page}=setup(async()=>({prediction:prediction('fresh',1,[103])}));choose(page,103);page.data.stage='process';page.data.initialPrediction={expiresAt:'2000-01-01'};page.data.predictionRootId='expired';
  page.usePredictionAgain();assert.equal(page.data.predictionRootId,'');await tick();assert.equal(page.data.predictionRootId,'fresh');assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103]);
});

test("按组批选只加入当前可派人员，跨组选择保留，忙碌人员可见但不能新增",()=>{
  const {page}=setup();choose(page,103);page.choosePeopleGroup({currentTarget:{dataset:{groupIndex:2}}});
  assert.equal(page.data.peopleGroupName,'生产二组');assert.equal(page.data.peopleGroupTotal,2);assert.equal(page.data.peopleGroupAvailableCount,1);
  assert.deepEqual(Array.from(page.data.groupEmployees,p=>p.blacklakeOperatorId),[104,105]);page.selectGroupAvailable();
  assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103,104]);assert.equal(page.data.peopleGroupSelectedCount,1);
  choose(page,105);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103,104]);page.clearGroupSelection();assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103]);
});

test("搜索限制批选和清空范围，多部门人员不重复加入，查看已选可跨组移除",()=>{
  const {page}=setup();page.data.employees[1].departments=['生产一组','生产二组'];page.updateEmployeeView();choose(page,103);
  page.onEmployeeQuery({detail:{value:'B-01'}});page.selectGroupAvailable();page.selectGroupAvailable();assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103,104]);
  page.openSelectedPeople();assert.equal(page.data.selectedPanelOpen,true);choose(page,103);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[104]);page.closeSelectedPeople();
  page.clearGroupSelection();assert.equal(page.data.selectedEmployeeIds.length,0);
});

test("工序建议自动定位滚轮，手动切换保留人员且无额外推荐请求",async()=>{
  const {page,calls}=setup(async()=>({prediction:prediction('wheel',1,[103])}));await enterProcess(page,[103]);
  assert.equal(page.data.selectedProcessId,1);assert.deepEqual(Array.from(page.data.processWheelValue),[0]);
  page.onProcessWheelChange({detail:{value:[1]}});assert.equal(page.data.selectedProcessId,2);
  page.onProcessWheelChange({detail:{value:[99]}});assert.equal(page.data.selectedProcessId,2);assert.equal(calls.length,1);
  assert.deepEqual(Array.from(page.data.processWheelValue),[1]);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103]);
});

test("唯一绑定工位直接派遣，不弹核对层，携带工序反馈且重复点击只提交一次",async()=>{
  let finish;const {page,calls}=setup(async path=>path.endsWith('/prediction')?{prediction:prediction('direct',1,[103])}
    :path.endsWith('/assign')?new Promise(resolve=>finish=resolve):{units:[],employees:staff});
  await enterProcess(page,[103]);const pending=page.dispatchSelectedPeople();await tick();
  assert.equal(page.data.reviewOpen,false);assert.equal(page.data.submitting,true);await page.dispatchSelectedPeople();
  const assigns=calls.filter(row=>row.path.endsWith('/assign'));assert.equal(assigns.length,1);
  const payload=assigns[0].options.data;assert.equal(payload.taskId,1);assert.equal(payload.predictionId,'direct');
  assert.equal(payload.placements[0].unitId,'A-01');assert.equal(payload.placements[0].source,'binding');
  finish({assignments:[{id:'direct-assignment'}]});await pending;assert.equal(page.data.stage,'people');assert.equal(page.data.selectedEmployeeIds.length,0);
});

test("未绑定或多工位仅补选工位，滑动或人员变忙时不提交派遣",async()=>{
  for(const bindings of [[],['A-01','B-01']]){
    const {page,calls}=setup(async path=>path.endsWith('/prediction')?{prediction:prediction('placement',1,[103])}:path.endsWith('/assign')?{assignments:[{id:'placed'}]}:{units:[],employees:staff});
    page.data.employees[0].boundUnitIds=bindings;await enterProcess(page,[103]);
    page.onProcessWheelStart();await page.dispatchSelectedPeople();assert.equal(page.data.reviewOpen,false);assert.equal(calls.some(row=>row.path.endsWith('/assign')),false);
    page.onProcessWheelEnd();await page.dispatchSelectedPeople();assert.equal(page.data.reviewOpen,true);assert.equal(page.data.placementOnly,true);assert.equal(calls.some(row=>row.path.endsWith('/assign')),false);
    page.chooseEmployeeUnit({currentTarget:{dataset:{operatorId:103}},detail:{value:1}});await page.confirmAssignment();
    assert.equal(calls.filter(row=>row.path.endsWith('/assign')).length,1);assert.equal(calls.find(row=>row.path.endsWith('/assign')).options.data.placements[0].source,'manual');
  }
  const {page,calls}=setup(async()=>({prediction:prediction('busy',1,[103])}));await enterProcess(page,[103]);page.data.employees[0].available=false;
  await page.dispatchSelectedPeople();assert.equal(calls.some(row=>row.path.endsWith('/assign')),false);
});

test("直接派遣遇过期建议自动刷新依据，保留人工工序且不自动重提",async()=>{
  let predictions=0;const {page,calls}=setup(async path=>{
    if(path.endsWith('/prediction'))return {prediction:prediction(++predictions===1?'old':'fresh',1,[103])};
    if(path.endsWith('/assign'))throw Object.assign(Error('建议已过期'),{status:409,code:'PREDICTION_EXPIRED'});
    return {units:[],employees:staff};
  });await enterProcess(page,[103]);page.onProcessWheelChange({detail:{value:[1]}});await page.dispatchSelectedPeople();await tick();
  assert.equal(page.data.predictionRootId,'fresh');assert.equal(page.data.selectedProcessId,2);assert.equal(page.data.reviewOpen,false);
  assert.equal(calls.filter(row=>row.path.endsWith('/assign')).length,1);assert.deepEqual(Array.from(page.data.selectedEmployeeIds),[103]);
});

test("开始滑动后迟到建议不改工序，未选或滑动中不能进入核对",async()=>{
  let resolve;const {page}=setup(()=>new Promise(r=>resolve=r));choose(page,103);page.continueToProcess();
  assert.equal(page.data.selectedProcessId,null);assert.equal(page.data.processWheelIndex,-1);
  page.onProcessWheelStart();resolve({prediction:prediction()});await tick();assert.equal(page.data.selectedProcessId,null);
  page.reviewAssignment();assert.equal(page.data.reviewOpen,false);
  page.onProcessWheelChange({detail:{value:[1]}});assert.equal(page.data.selectedProcessId,2);
  page.onProcessWheelStart();const wheelValue=page.data.processWheelValue;page.updateConfirmationSummary();assert.equal(page.data.processWheelValue,wheelValue);
  page.reviewAssignment();assert.equal(page.data.reviewOpen,false);
  page.onProcessWheelEnd();page.reviewAssignment();assert.equal(page.data.reviewOpen,true);
});

test("扫码首页可维护多人常驻绑定，保存带旧值核对且不需要已扫工单", async () => {
  const unit = { id: "A-01", blacklakeOperatorIds: [103] };
  const { page, calls } = setup(async (path, options) => {
    if (options.method === "PATCH") { unit.blacklakeOperatorIds = options.data.blacklakeOperatorIds; return {}; }
    return { units: [unit], employees: staff };
  });
  page.data.stage = "scan"; page.data.flowCode = ""; page.data.workOrder = null;
  await page.openStationManager();
  assert.equal(page.data.stage, "stations");
  page.editStation({ currentTarget: { dataset: { unitId: "A-01" } } });
  page.toggleStationEmployee({ currentTarget: { dataset: { operatorId: 104 } } });
  await page.saveStationBinding();
  const saved = calls.find((row) => row.options.method === "PATCH");
  assert.deepEqual(Array.from(saved.options.data.expectedOperatorIds), [103]);
  assert.deepEqual(Array.from(saved.options.data.blacklakeOperatorIds), [103,104]);
  assert.equal(page.data.stationSaveUncertain, false);
});

test("工位保存回执未知或并发冲突会锁定再次写入，刷新核对后才能继续", async () => {
  for (const status of [undefined, 409]) {
    const { page, calls } = setup(async (path, options) => {
      if (options.method === "PATCH") throw Object.assign(new Error("changed"), { status });
      return { units: [{ id: "A-01", blacklakeOperatorIds: [103] }], employees: staff };
    });
    await page.openStationManager({ currentTarget: { dataset: { unitId: "A-01" } } });
    await page.saveStationBinding();
    assert.equal(page.data.stationSaveUncertain, true);
    await page.saveStationBinding();
    assert.equal(calls.filter((row) => row.options.method === "PATCH").length, 1);
    await page.refreshStationBindings();
    assert.equal(page.data.stationSaveUncertain, false);
    assert.deepEqual(Array.from(page.data.stationDraftIds), [103]);
  }
});

test("现场地图由扫码页进入并返回扫码页，不要求提前选择工单", () => {
  const { page } = setup();
  page.data.stage = "scan"; page.data.workOrder = null;
  page.openSiteMap();
  assert.equal(page.data.stage, "map");
  page.leaveMap();
  assert.equal(page.data.stage, "scan");
  assert.equal(page.data.workOrder, null);
});
