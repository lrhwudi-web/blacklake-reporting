import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const scriptPath = new URL("../pages/dispatch/dispatch.js", import.meta.url);

async function createDispatchPage(overrides = {}, requestImpl = async () => ({})) {
  const source = await readFile(scriptPath, "utf8");
  let definition;
  const modals = [];
  const toasts = [];
  const scans = [];
  const sandbox = {
    Map,
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
    require: () => ({ request: requestImpl }),
    getApp: () => ({ globalData: {}, clearSession() {} }),
    Page: (value) => { definition = value; },
    wx: {
      getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }),
      getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667 }),
      setStorageSync() {},
      showModal: (options) => { modals.push(options); },
      showToast: (options) => { toasts.push(options); },
      scanCode: (options) => { scans.push(options); },
      vibrateShort() {}
    }
  };

  vm.runInNewContext(source, sandbox, { filename: scriptPath.pathname });
  const page = {
    ...definition,
    data: { ...definition.data, ...overrides },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    }
  };
  return { page, modals, toasts, scans };
}

test("8楼翻内袋地图热点读取共享工位，手工剪线仍是独立工位", async () => {
  const id = "翻内袋";
  const calls = [];
  const { page } = await createDispatchPage({ isFloor3: false, stage: "map" }, async (path) => {
    calls.push(path);
    if (path === "/v1/dispatch/overview") return { units: [{ id, state: "scheduled" }], employees: [] };
    return { unitId: id, residents: [{ name: "测试人员" }], assignments: [] };
  });
  await page.fetchOverview();
  assert.equal(page.data.units.find((unit) => unit.id === id)?.kind, "turning");
  assert.equal(page.data.units.find((unit) => unit.id === id)?.state, "scheduled");
  assert.ok(page.data.units.some((unit) => unit.id === "手工剪线"));
  await page.selectUnit({ currentTarget: { dataset: { unitId: id } } });
  assert.equal(page.data.unitDetail.residents[0].name, "测试人员");
  assert.equal(calls.at(-1), "/v1/dispatch/units/" + encodeURIComponent(id));
});

test("扫描入口在查询和读取期间不重复启动，扫码结果继续读取原工单", async () => {
  const { page, scans } = await createDispatchPage();
  let selectedCode = '';
  page.loadWorkOrder = (code) => { selectedCode = code; };
  page.scanWorkOrder();
  assert.equal(scans.length, 1);
  assert.equal(scans[0].onlyFromCamera, true);
  scans[0].success({ result: 'projectId=102' });
  assert.equal(selectedCode, 'projectId=102');
  page.setData({ skuSearching: true });
  page.scanWorkOrder();
  page.setData({ skuSearching: false, submitting: true });
  page.scanWorkOrder();
  assert.equal(scans.length, 1);
});

test("SKU 为空时只显示输入错误，不查询或切换首屏布局", async () => {
  const { page } = await createDispatchPage({}, async () => { assert.fail('空 SKU 不应发起请求'); });
  await page.searchSkuWorkOrders();
  assert.equal(page.data.skuSearchStarted, false);
  assert.equal(page.data.skuSearchError, '请输入 SKU。');
});

test("原生扫码失败或空结果有可见反馈，并可重新扫描",async()=>{
 const {page,scans}=await createDispatchPage();page.scanWorkOrder();
 scans[0].fail({errMsg:'scanCode:fail unsupported'});assert.ok(page.data.scanError);assert.equal(page.data.scanning,false);
 page.scanWorkOrder();scans[1].success({result:''});assert.ok(page.data.scanError);assert.equal(page.data.scanning,false);
});

test("相机页面隐藏事件不作废本次扫码的工单读取，卸载后仍丢弃回调",async()=>{
 let finish;const {page,scans}=await createDispatchPage({},async path=>path.endsWith('/work-order')?new Promise(resolve=>finish=resolve):{units:[],employees:[]});
 page.scanWorkOrder();const pending=scans[0].success({result:'projectId=102'});page.onHide();finish({workOrder:{projectCode:'WO-102'},processes:[]});await pending;
 assert.equal(page.data.stage,'people');
 page.onUnload();page.scanWorkOrder();assert.equal(scans.length,1);
});

test("3楼可分配机台点击后立即打开确认弹层", async () => {
  const unit = { id: "3F-01", state: "available", operatorMapped: true };
  const { page, modals, toasts } = await createDispatchPage({
    isFloor3: true,
    units: [unit],
    recommendedProcess: { taskId: 101, processName: "绣花" }
  });

  page.selectUnit({ currentTarget: { dataset: { unitId: "3F-01" } } });

  assert.equal(page.data.sheetOpen, true);
  assert.equal(page.data.selectedUnit.id, "3F-01");
  assert.equal(page.data.selectedProcessId, 101);
  assert.equal(page.data.selectedEmbroideryPart, "");
  assert.equal(modals.length, 0);
  assert.equal(toasts.length, 0);
});

test("组长输入 SKU 后从多张工单中选中指定工单", async () => {
  const calls = [];
  const { page } = await createDispatchPage({}, async (path, options) => {
    calls.push({ path, options });
    return { workOrders: [
      { projectId: 101, projectCode: "WO-1", productCode: "SKU-A" },
      { projectId: 102, projectCode: "WO-2", productCode: "SKU-A" }
    ] };
  });
  let selectedCode = "";
  page.loadWorkOrder = (code) => { selectedCode = code; };
  page.onSkuInput({ detail: { value: " SKU-A " } });
  await page.searchSkuWorkOrders();
  assert.equal(calls[0].path, "/v1/dispatch/work-orders/search");
  assert.equal(calls[0].options.data.sku, "SKU-A");
  assert.equal(page.data.skuSearchStarted, true);
  assert.equal(page.data.skuResults.length, 2);
  page.onSkuInput({ detail: { value: "SKU-B" } });
  assert.equal(page.data.skuSearchStarted, true);
  assert.equal(page.data.skuResults.length, 0);
  page.onSkuInput({ detail: { value: "SKU-A" } });
  await page.searchSkuWorkOrders();
  page.selectSkuWorkOrder({ currentTarget: { dataset: { projectId: 102 } } });
  assert.equal(selectedCode, "projectId=102");
});

test("3楼确认分配前必须选择前幅或后幅", async () => {
  const { page } = await createDispatchPage({
    isFloor3: true,
    selectedEmbroideryPart: ""
  });

  page.chooseDispatchPart({ currentTarget: { dataset: { part: "前幅" } } });
  assert.equal(page.data.selectedEmbroideryPart, "前幅");

  page.chooseDispatchPart({ currentTarget: { dataset: { part: "未知" } } });
  assert.equal(page.data.selectedEmbroideryPart, "前幅");
});

test("3楼已分配但尚未开始的机器仍可继续进入分配", async () => {
  const unit = { id: "3F-01", state: "scheduled", canAssign: true, operatorMapped: true };
  const { page, toasts } = await createDispatchPage({
    isFloor3: true,
    units: [unit],
    recommendedProcess: { taskId: 101, processName: "绣花" }
  });

  page.selectUnit({ currentTarget: { dataset: { unitId: "3F-01" } } });

  assert.equal(page.data.sheetOpen, true);
  assert.equal(page.data.selectedUnit.id, "3F-01");
  assert.equal(toasts.length, 0);
});

test("3楼不可分配与未绑定机台点击后不会静默", async () => {
  const { page, modals, toasts } = await createDispatchPage({
    isFloor3: true,
    units: [
      { id: "3F-01", state: "running", canAssign: false, operatorMapped: true },
      { id: "3F-02", state: "available", operatorMapped: false }
    ],
    recommendedProcess: { taskId: 101, processName: "绣花" }
  });

  page.selectUnit({ currentTarget: { dataset: { unitId: "3F-01" } } });
  page.selectUnit({ currentTarget: { dataset: { unitId: "3F-02" } } });

  assert.equal(toasts[0].title, "3F-01 正在生产");
  assert.match(modals[0].title, /3F-02 尚未绑定员工/);
  assert.equal(page.data.sheetOpen, false);
});

test("8楼直接选人支持多选和取消选择，不要求先点工位", async () => {
  const { page, toasts } = await createDispatchPage({
    isFloor3: false,
    units: [{ id: "A-05", state: "scheduled", canAssign: true }],
    employees: [
      { blacklakeOperatorId: 31002, name: "王阿姨", available: true, selected: false },
      { blacklakeOperatorId: 31003, name: "李师傅", available: true, selected: false }
    ],
    selectedEmployeeIds: []
  });

  assert.equal(toasts.length, 0);

  page.chooseEmployee({ currentTarget: { dataset: { operatorId: "31002" } } });
  page.chooseEmployee({ currentTarget: { dataset: { operatorId: "31003" } } });
  assert.deepEqual(Array.from(page.data.selectedEmployeeIds), [31002, 31003]);
  assert.equal(page.data.employees.filter((employee) => employee.selected).length, 2);

  page.chooseEmployee({ currentTarget: { dataset: { operatorId: "31002" } } });
  assert.deepEqual(Array.from(page.data.selectedEmployeeIds), [31003]);
});

test("8楼总览在每个人员旁显示已绑定工位，不自动选择人员", async () => {
  const { page } = await createDispatchPage({
    isFloor3: false,
    units: [{ id: "A-03", state: "available", canAssign: true, recommendedBlacklakeOperatorIds: [31003, 31004] }],
    employees: [
      { blacklakeOperatorId: 31002, name: "王阿姨", available: true, selected: false },
      { blacklakeOperatorId: 31003, name: "李师傅", available: true, selected: false },
      { blacklakeOperatorId: 31004, name: "陈师傅", available: true, selected: false }
    ]
  }, async () => ({ units: [{ id: "A-03", recommendedBlacklakeOperatorIds: [31003, 31004] }], employees: [
    { blacklakeOperatorId: 31002, name: "王阿姨", available: true },
    { blacklakeOperatorId: 31003, name: "李师傅", available: true },
    { blacklakeOperatorId: 31004, name: "陈师傅", available: true }
  ] }));

  await page.loadOverview();
  assert.equal(page.data.employees[0].boundUnitLabel, "未绑定工位");
  assert.equal(page.data.employees[1].boundUnitLabel, "A-03");
  assert.equal(page.data.employees[2].boundUnitLabel, "A-03");
  assert.deepEqual(Array.from(page.data.selectedEmployeeIds), []);
});

test("手动更换工序不请求换人建议或改变已选人员", async () => {
  const calls = [];
  const frequent = { taskId: 102, processName: "车耳朵", defaultQuantity: 100 };
  const system = { taskId: 101, processName: "外发贴合", defaultQuantity: 100 };
  const other = { taskId: 103, processName: "固定织唛", defaultQuantity: 100 };
  const { page } = await createDispatchPage({
    flowCode: "FLOW-001",
    selectedUnit: { id: "A-03" },
    selectedEmployeeIds: [31002],
    employees: [{ blacklakeOperatorId: 31002, name: "王师傅", available: true, boundUnitIds: ["A-03"] }],
    processes: [system, frequent, other]
    ,processOptions: [{ taskId: null }, system, frequent, other]
  }, async (path, options) => {
    calls.push({ path, options });
    return { supervisorFrequent: [frequent], systemRecommended: [system], otherProcesses: [other] };
  });

  page.onProcessChange({ detail: { value: 2 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 0);
  assert.deepEqual(Array.from(page.data.selectedEmployeeIds), [31002]);
  assert.equal(page.data.selectedProcessId, 102);
});

test("双指缩放不回写临时位移，复位通过重建手势层完成", async () => {
  const { page } = await createDispatchPage({
    mapScaleText: "100",
    mapGestureReady: true
  });

  assert.equal(page.onMapChange, undefined);
  page.onMapScale({ detail: { scale: 2.2, x: -480, y: -620, source: "touch" } });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(page.data.mapScaleText, "220");
  assert.equal(page.data.mapX, undefined);
  assert.equal(page.data.mapY, undefined);

  page.resetMap();
  assert.equal(page.data.mapGestureReady, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(page.data.mapGestureReady, true);
  assert.equal(page.data.mapScaleText, "100");
});

test("8楼扫码直接选人员，跳过地图后按各人的绑定工位确认派工", async () => {
  const calls = [];
  const process = { taskId: 7, processName: "车耳朵" };
  const employees = [
    { blacklakeOperatorId: 103, name: "测试甲", available: true, boundUnitIds: ["A-03"] },
    { blacklakeOperatorId: 104, name: "测试乙", available: true, boundUnitIds: ["B-02"] }
  ];
  const { page } = await createDispatchPage({}, async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith("/work-order")) return { workOrder: { projectCode: "WO-TEST" }, processes: [process] };
    if (path.endsWith("/process-recommendations")) return { otherProcesses: [process] };
    if (path.endsWith("/assign")) return { assignments: [{ id: "a", stationName: "A-03" }, { id: "b", stationName: "B-02" }] };
    return { units: [], employees };
  });
  await page.loadWorkOrder("FLOW-TEST");
  assert.equal(page.data.stage, "people");
  assert.equal(page.data.sheetOpen, false);
  assert.equal(page.data.sheetStep, "employee");
  assert.equal(page.data.selectedUnit, null);
  for (const operatorId of [103, 104]) page.chooseEmployee({ currentTarget: { dataset: { operatorId } } });
  page.onProcessChange({ detail: { value: 1 } });
  page.reviewAssignment();
  assert.equal(page.data.sheetStep, "confirm");
  assert.equal(page.data.reviewOpen, true);
  assert.equal(calls.some((call) => call.path.endsWith("/assign")), false);
  await page.confirmAssignment();
  const payload = calls.find((call) => call.path.endsWith("/assign")).options.data;
  assert.deepEqual(JSON.parse(JSON.stringify(payload.placements)), [
    { blacklakeOperatorId: 103, unitId: "A-03", source: "binding" },
    { blacklakeOperatorId: 104, unitId: "B-02", source: "binding" }
  ]);
  assert.equal(page.data.sheetStep, "employee");
  assert.equal(page.data.selectedEmployeeIds.length, 0);
});

test("缺少或多工位在核对层补选，不增加工序或地图步骤", async () => {
  const calls = [];
  const { page } = await createDispatchPage({ stage: "people", sheetOpen: true,
    selectedEmployeeIds: [103, 104], selectedProcessId: 7,
    units: [{ id: "A-03" }, { id: "B-02" }],
    employees: [{ blacklakeOperatorId: 103, available: true, boundUnitIds: [] },
      { blacklakeOperatorId: 104, available: true, boundUnitIds: ["A-03", "B-02"] }]
  }, async (path) => { calls.push(path); return {}; });
  page.reviewAssignment();
  assert.equal(page.data.reviewOpen, true);
  assert.equal(calls.length, 0);
  assert.equal(page.data.placementsReady, false);
  page.chooseEmployeeUnit({ currentTarget: { dataset: { operatorId: 103 } }, detail: { value: 0 } });
  assert.equal(page.data.employeePlacements[0].unitId, "");
  page.chooseEmployeeUnit({ currentTarget: { dataset: { operatorId: 103 } }, detail: { value: 1 } });
  page.chooseEmployeeUnit({ currentTarget: { dataset: { operatorId: 104 } }, detail: { value: 2 } });
  assert.equal(page.data.stage, "people");
  assert.equal(page.data.sheetStep, "confirm");
  assert.equal(page.data.selectedEmployeeIds.length, 2);
  assert.equal(page.data.selectedProcessId, 7);
  assert.deepEqual(Array.from(page.data.employeePlacements, (item) => item.unitId), ["A-03", "B-02"]);
  assert.ok(page.data.employeePlacements.every((item) => item.source === "manual"));
  assert.equal(page.data.placementsReady, true);
});

test("确认中绑定变化保留已选人员并阻止直接派工，返回核对后才接受新绑定", async () => {
  const calls = [];
  const { page } = await createDispatchPage({ stage: "people", sheetOpen: true, sheetStep: "employee",
    selectedEmployeeIds: [103], employees: [{ blacklakeOperatorId: 103, name: "测试甲", available: true, boundUnitIds: ["A-03"] }]
  }, async (path) => {
    calls.push(path);
    if (path.endsWith("/overview")) return { units: [], employees: [{ blacklakeOperatorId: 103, name: "测试甲", available: true, boundUnitIds: ["B-02"] }] };
    return {};
  });
  page.data.selectedProcessId = 7;
  page.reviewAssignment();
  await page.loadOverview();
  assert.match(page.data.selectionWarning, /工位绑定已变化/);
  assert.equal(page.data.selectedEmployeeIds.length, 1);
  page.data.selectedProcessId = 7;
  await page.confirmAssignment();
  assert.equal(calls.some((path) => path.endsWith("/assign")), false);
  page.closeReview();
  page.reviewAssignment();
  assert.equal(page.data.selectionWarning, "");
  assert.equal(page.data.employeePlacements[0].unitId, "B-02");
});

test("3楼扫码仍进入机器地图，不进入8楼人员派工页面", async () => {
  const { page } = await createDispatchPage({ isFloor3: true }, async (path) => path.endsWith("/work-order")
    ? { workOrder: { projectCode: "WO-TEST" }, processes: [], recommendedProcess: { taskId: 7 } } : { units: [], employees: [] });
  await page.loadWorkOrder("FLOW-TEST");
  assert.equal(page.data.stage, "map");
  assert.equal(page.data.sheetOpen, false);
  assert.equal(page.data.selectedProcessId, 7);
});

test('现场地图点击工位读取人员任务和进度，按当前任务ID自动定位；不进入绑定编辑',async()=>{
 const calls=[],unit={id:'A-03'},detail={unitId:'A-03',residents:[{name:'测试员工'}],assignments:[{id:'a',taskId:108,status:'IN_PROGRESS',steps:[{taskId:100,percent:102,current:false},{taskId:108,percent:97,current:true}]}],coverage:{queriedAt:'2026-11-05T01:00:00Z'}};
 const {page}=await createDispatchPage({stage:'map',units:[unit]},async path=>{calls.push(path);return detail;});
 await page.selectUnit({currentTarget:{dataset:{unitId:'A-03'}}});assert.equal(page.data.stage,'map');assert.equal(page.data.unitDetailOpen,true);assert.equal(page.data.stationUnit,null);assert.equal(page.data.unitDetail.assignments[0].scrollTarget,'station-step-0-108');assert.equal(page.data.unitDetail.assignments[0].steps[0].tone,'over');assert.equal(calls.length,1);assert.equal(calls[0],'/v1/dispatch/units/A-03');page.closeUnitDetail();assert.equal(page.data.unitDetail,null);
});

test('快速切换工位或关闭后，旧详情回调不会覆盖当前工位',async()=>{
 const pending={}, {page}=await createDispatchPage({stage:'map',units:[{id:'A-03'},{id:'B-01'}]},path=>new Promise(resolve=>pending[path]=resolve));
 const first=page.selectUnit({currentTarget:{dataset:{unitId:'A-03'}}});const second=page.selectUnit({currentTarget:{dataset:{unitId:'B-01'}}});
 pending['/v1/dispatch/units/B-01']({unitId:'B-01',assignments:[],residents:[]});await second;pending['/v1/dispatch/units/A-03']({unitId:'A-03',assignments:[],residents:[]});await first;assert.equal(page.data.unitDetail.unitId,'B-01');
 const last=page.refreshUnitDetail();page.closeUnitDetail();pending['/v1/dispatch/units/B-01']({unitId:'B-01',assignments:[],residents:[]});await last;assert.equal(page.data.unitDetailOpen,false);assert.equal(page.data.unitDetail,null);
});

test('刷新失败保留上次详情并提示；隐藏后旧请求作废，返回重新读取',async()=>{
 let fail=false,resolve;const {page}=await createDispatchPage({stage:'map',units:[{id:'A-03'}]},async()=>{if(fail)throw Error('网络失败');return {unitId:'A-03',assignments:[],residents:[]};});await page.selectUnit({currentTarget:{dataset:{unitId:'A-03'}}});fail=true;await page.refreshUnitDetail();assert.equal(page.data.unitDetail.unitId,'A-03');assert.match(page.data.unitDetailError,/网络失败/);page.closeUnitDetail();
 const f=await createDispatchPage({stage:'map',units:[{id:'A-03'}]},()=>new Promise(r=>resolve=r));const request=f.page.selectUnit({currentTarget:{dataset:{unitId:'A-03'}}});f.page.onHide();resolve({unitId:'A-03',assignments:[],residents:[]});await request;assert.equal(f.page.data.unitDetail,null);assert.equal(f.page.data.unitDetailLoading,false);f.page.closeUnitDetail();
});

test('临时工位选择仍直接完成选位；3楼详情通过独立按钮进入原派工确认',async()=>{
 const f=await createDispatchPage({stage:'map',placementOperatorId:301,units:[{id:'A-03'}],selectedEmployeeIds:[]});f.page.selectUnit({currentTarget:{dataset:{unitId:'A-03'}}});assert.equal(f.page.data.manualUnitByEmployee[301],'A-03');assert.equal(f.page.data.unitDetailOpen,false);
 const {page}=await createDispatchPage({stage:'map',isFloor3:true,workOrder:{projectCode:'TEST'},units:[{id:'3F-01',operatorMapped:true,canAssign:true}]},async()=>({unitId:'3F-01',residents:[],assignments:[]}));await page.selectUnit({currentTarget:{dataset:{unitId:'3F-01'}}});assert.equal(page.data.unitDetailOpen,true);assert.equal(page.data.sheetOpen,false);page.dispatchFromUnitDetail();assert.equal(page.data.unitDetailOpen,false);assert.equal(page.data.sheetOpen,true);assert.equal(page.data.selectedUnit.id,'3F-01');
});


test('撤销待开始派工无原因输入即可提交，保留确认步骤且连点不重复请求',async()=>{
 const calls=[];let release;const {page,toasts}=await createDispatchPage({historyAssignments:[{id:'a',canCancel:true,status:'READY'}]},async(path,options)=>{calls.push({path,options});return new Promise(r=>release=r);});page.loadHistory=async()=>{};page.loadOverview=async()=>{};
 page.beginCancelAssignment({currentTarget:{dataset:{assignmentId:'a'}}});assert.equal(page.data.cancelAssignmentId,'a');const pending=page.cancelReadyAssignment();await page.cancelReadyAssignment();assert.equal(calls.length,1);assert.equal(Object.keys(calls[0].options.data).length,0);assert.equal(toasts.length,0);release({});await pending;assert.equal(page.data.cancelAssignmentId,'');
});
