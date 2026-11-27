const { request } = require("../../utils/api");
const app = getApp();

const FLOOR3_UNITS = [
  ["3F-01", 28.8, 26.7], ["3F-02", 28.8, 39.0], ["3F-03", 28.8, 51.3], ["3F-04", 28.8, 63.6],
  ["3F-05", 50.8, 26.7], ["3F-06", 50.8, 39.0], ["3F-07", 50.8, 51.3], ["3F-08", 50.8, 63.6],
  ["3F-09", 72.8, 26.7], ["3F-10", 72.8, 39.0], ["3F-11", 72.8, 51.3], ["3F-12", 72.8, 63.6]
];

const FLOOR8_UNITS = [
  ["A-01", 28.3, 81.6, "A-01", "station"], ["A-02", 28.3, 77.0, "A-02", "station"],
  ["A-03", 28.3, 72.4, "A-03", "station"], ["A-04", 28.3, 67.8, "A-04", "station"],
  ["A-05", 28.3, 63.2, "A-05", "station"], ["A-06", 28.3, 58.6, "A-06", "station"],
  ["A-07", 28.3, 54.0, "A-07", "station"], ["A-08", 28.3, 49.4, "A-08", "station"],
  ["A-09", 28.3, 44.8, "A-09", "station"], ["A-10", 28.3, 40.1, "A-10", "station"],
  ["B-01", 52.1, 68.4, "B-01", "station"], ["B-02", 52.1, 63.7, "B-02", "station"],
  ["B-03", 52.1, 59.0, "B-03", "station"], ["B-04", 52.1, 54.3, "B-04", "station"],
  ["B-05", 52.1, 49.6, "B-05", "station"], ["B-06", 52.1, 44.9, "B-06", "station"],
  ["B-07", 52.1, 40.2, "B-07", "station"],
  ["翻内袋", 52.05, 78.1, "翻内袋", "turning"],
  ["手工剪线", 33.4, 24.4, "剪线", "auxiliary"], ["包装/质检", 33.4, 29.5, "包/检", "auxiliary"],
  ["刺绣片检验", 33.4, 34.5, "片检", "auxiliary"], ["裁床一区", 39.0, 14.8, "裁1", "cutter-horizontal"],
  ["裁床二区-1", 69.1, 26.5, "裁2-1", "cutter-vertical"], ["裁床二区-2", 79.9, 26.5, "裁2-2", "cutter-vertical"]
];

function baseUnits(isFloor3) {
  return (isFloor3 ? FLOOR3_UNITS : FLOOR8_UNITS).map(([id, x, y, shortLabel, kind]) => ({
    id, x, y, shortLabel: shortLabel || id, kind: kind || "machine", state: "available", operatorMapped: true
  }));
}

function mapGeometry(isFloor3) {
  const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const windowWidth = Number(info.windowWidth) || 375;
  const windowHeight = Number(info.windowHeight) || 667;
  const viewportWidth = windowWidth * (1 - 92 / 750);
  const canvasHeight = viewportWidth * 1.5;
  const desiredViewportHeight = viewportWidth * (isFloor3 ? 1.18 : 1.5);
  const reservedHeight = windowWidth * 390 / 750;
  const minimumHeight = viewportWidth * (isFloor3 ? 0.96 : 0.94);
  const viewportHeight = Math.max(minimumHeight, Math.min(desiredViewportHeight, windowHeight - reservedHeight));
  const canvasSize = Math.max(canvasHeight, viewportHeight);
  return {
    mapViewportHeight: Math.round(viewportHeight),
    mapCanvasSize: Math.round(canvasSize),
    mapCanvasOffsetX: Math.round((viewportWidth - canvasSize) / 2),
    mapCanvasOffsetY: Math.round((viewportHeight - canvasSize) / 2)
  };
}

function rankEmployees(employees, recommendedBlacklakeOperatorIds, selectedEmployeeIds = []) {
  const recommendedIds = new Set((Array.isArray(recommendedBlacklakeOperatorIds)
    ? recommendedBlacklakeOperatorIds : [recommendedBlacklakeOperatorIds]).map(Number).filter((id) => id > 0));
  const selectedIds = new Set(selectedEmployeeIds || []);
  return (employees || []).map((employee) => ({
    ...employee,
    stationAssigned: recommendedIds.has(Number(employee.blacklakeOperatorId)),
    selected: (employee.available||employee.canQueue) && selectedIds.has(employee.blacklakeOperatorId)
  })).sort((left, right) => Number(right.stationAssigned) - Number(left.stationAssigned));
}

function employeeStations(employees, units) {
  return employees.map((employee) => {
    const boundUnitIds = Array.isArray(employee.boundUnitIds) ? employee.boundUnitIds : units.filter((unit) =>
      (unit.recommendedBlacklakeOperatorIds || [unit.recommendedBlacklakeOperatorId]).includes(employee.blacklakeOperatorId)).map((unit) => unit.id);
    return { ...employee, boundUnitIds,
      boundUnitLabel: boundUnitIds.length ? boundUnitIds.join("、") : "未绑定工位" };
  });
}

Page({
  data: {
    ready: false,
    stage: "scan",
    operator: null,
    entry: null,
    isFloor3: false,
    floorName: "",
    roleName: "",
    workOrder: null,
    orderOrbScope: "", orderOrbOwner: "", orderOrbOpen: false, orderOrbKeyboardOpen: false,
    flowCode: "",
    skuQuery: "",
    skuSearchStarted: false,
    skuResults: [],
    skuSearchError: "",
    skuSearching: false,
    scanning: false, scanError: "",
    processes: [],
    recommendedProcess: null,
    units: [],
    stationOptions: [{ id: "请选择工位" }],
    employees: [],
    selectedUnit: null,
    unitDetailOpen: false, unitDetailId: "", unitDetail: null, unitDetailLoading: false, unitDetailError: "", unitDetailCanDispatch: false,
    selectedEmployeeIds: [],
    manualUnitByEmployee: {},
    employeePlacements: [],
    placementsReady: false,
    placementReviewKey: "",
    selectedStationSummary: "",
    placementOperatorId: null,
    selectedEmbroideryPart: "",
    selectedProcessId: null,
    selectedEmployeeNames: "",
    selectedProcessName: "待选择工序",
    processScrollTarget: "", processWheelItems: [], processOverview: [], processWheelValue: [0], processWheelIndex: -1, processWheelMoving: false,
    selectionWarning: "",
    recommendationNotice: "",
    overviewError: "",
    historyOpen: false,
    historyTab: 'dispatch', reportDate: '', reportMaxDate: '', reportRecords: [], reportLoading: false,
    reportLoaded: false, reportError: '', reportTotal: 0, reportHasMore: false, reportMenuId: '', reportScrollTarget: '',
    reportEditor: null, reportGoodInput: '', reportDefectInput: '', reportSelectedCodes: [], reportReasonOptions:[], reportSaving: false, reportActionError: '', reportActionLocked:false,
    reportEditorLoading:false,reportTimeInvalid:false,reportEditForm:null,reportPeopleOpen:false,reportPeopleQuery:'',reportPeopleAll:[],reportPeopleResults:[],reportPeopleGroupConfig:null,reportPeopleGroups:[],reportPeopleGroupId:'',reportDefectsOpen:false,reportExtraOpen:false,reportDefectText:'无不良',
    historyLoading: false,
    historyLoaded: false,
    historyError: "",
    historyAssignments: [],
    historyDate: "",
    historyTotal: 0,
    historyTruncated: false,
    lastDispatchIds: [],
    cancelAssignmentId: "",
    cancelling: false,
    sheetOpen: false,
    sheetStep: "employee",
    submitting: false,
    notice: "",
    mapGestureReady: true,
    mapScaleText: "100",
    mapAngle: 0,
    mapViewportHeight: 0,
    mapCanvasSize: 0,
    mapCanvasOffsetX: 0,
    mapCanvasOffsetY: 0,
    floorImageVisible: true,
    floorImageError: false,
    availableCount: 0,
    employeeQuery: "", employeeFilter: "available", departmentIndex: 0, departmentOptions: ["全部部门"],
    visibleEmployees: [], selectedChips: [], processOptions: [{ taskId: null, processName: "请选择工序" }], processIndex: 0,
    peopleGroups: [], peopleGroupConfig: null, selectedPeopleGroupId: "", groupEmployees: [], peopleGroupName: "全部", peopleGroupAvailableCount: 0,
    peopleGroupSelectedCount: 0, peopleGroupTotal: 0, selectedPanelOpen: false, peopleDateLabel: "",
    overviewLoaded: false, reviewOpen: false, placementOnly: false, prediction: null, predictionRootId: "", predictionAppliedId: "",
    initialPrediction: null, predictionPeriodLabel: "", predictionAdjusted: false,
    predictionError: "", predicting: false, selectionTouched: false,
    stationUnits: [], visibleStationUnits: [], stationEmployees: [], visibleBindingEmployees: [], stationUnit: null,
    stationDraftChips: [],
    stationDraftIds: [], stationExpectedIds: [], stationQuery: "", stationPersonQuery: "", stationLoading: false,
    stationSaving: false, stationError: "", stationSaveUncertain: false
  },

  async onLoad(options = {}) {
    if (!app.globalData.sessionToken) return wx.reLaunch({ url: "/pages/login/login" });
    try {
      const result = await request("/v1/me");
      if (this.pageUnloaded) return;
      if (!result.entry || result.entry.entryView === "employee-reporting") {
        app.globalData.entry = result.entry;
        return wx.reLaunch({ url: "/pages/report/report" });
      }
      const isFloor3 = result.entry.entryView === "floor3-supervisor";
      app.globalData.operator = result.operator;
      app.globalData.entry = result.entry;
      wx.setStorageSync("operator", result.operator);
      wx.setStorageSync("entry", result.entry);
      this.workspaceLegacyBoard=options.workspaceView==='board'&&result.entry.appRole==='floor8_leader';
      if(!this.workspaceLegacyBoard&&typeof app.homeUrl==='function'&&app.homeUrl().startsWith('/workspace/'))return wx.reLaunch({url:app.homeUrl()});
      this.setData({
        ...mapGeometry(isFloor3),
        ready: true,
        operator: result.operator,
        orderOrbScope: app.globalData.apiBaseUrl || "",
        orderOrbOwner: result.draftOwnerId || "",
        entry: result.entry,
        isFloor3,
        floorName: isFloor3 ? "3楼" : "8楼",
        roleName: isFloor3 ? "主管端" : "组长端",
        units: baseUnits(isFloor3)
      });
      await this.loadOverview();
      if(this.workspaceLegacyBoard)this.openSiteMap();
    } catch (error) {
      if (this.pageUnloaded) return;
      wx.showModal({ title: "无法进入派单界面", content: error.message, showCancel: false });
    }
  },

  onShow() {
    this.pageVisible = true;
    if (this.data.ready) this.loadOverview();
    if (this.data.historyOpen) this.loadHistory();
    if (this.data.unitDetailOpen) this.loadUnitDetail();
    this.syncRefreshTimer();
  },

  onHide() {
    this.unitDetailRevision = (this.unitDetailRevision || 0) + 1;
    this.unitDetailRequest = null;
    this.setData({ unitDetailLoading: false });
    this.pageVisible = false;
    if (!this.scanInProgress) this.viewRevision = (this.viewRevision || 0) + 1;
    this.stopRefreshTimer();
    this.setData({ historyLoading: false, processWheelMoving: false });
  },

  onUnload() {
    this.onHide();
    this.viewRevision = (this.viewRevision || 0) + 1;
    this.pageUnloaded = true;
    if (this.mapGestureTimer) clearTimeout(this.mapGestureTimer);
    if (this.mapResetTimer) clearTimeout(this.mapResetTimer);
  },

  stopRefreshTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  },

  syncNavigationTheme() {
    if (this.pageUnloaded || this.pageVisible === false || !this.data.ready) return;
    const dark = this.data.stage === "scan";
    const theme = dark ? "dark" : "light";
    if (this.navigationTheme === theme || typeof wx.setNavigationBarColor !== "function") return;
    this.navigationTheme = theme;
    wx.setNavigationBarColor({ frontColor: dark ? "#ffffff" : "#000000", backgroundColor: dark ? "#0F172A" : "#FFFFFF", animation: { duration: 0 } });
  },
  syncRefreshTimer() {
    this.syncNavigationTheme();
    if (!this.pageVisible || !this.data.ready || (!["map", "people", "process"].includes(this.data.stage) && !this.data.historyOpen)) return this.stopRefreshTimer();
    if (!this.refreshTimer) this.refreshTimer = setInterval(() => {
      this.loadOverview();
      if (this.data.historyOpen) this.loadHistory();
      if (this.data.unitDetailOpen) this.loadUnitDetail(true);
    }, 10000);
  },

  async loadOverview() {
    if (this.overviewRequest) return this.overviewRequest;
    const revision = this.viewRevision || 0;
    const pending = this.fetchOverview();
    this.overviewRequest = pending;
    try { return await pending; } finally {
      this.overviewRequest = null;
      if (!this.pageUnloaded && this.pageVisible && revision !== (this.viewRevision || 0)) await this.loadOverview();
    }
  },

  async fetchOverview() {
    const revision = this.viewRevision || 0;
    try {
      const result = await request("/v1/dispatch/overview");
      if (this.pageUnloaded || revision !== (this.viewRevision || 0)) return;
      const statusById = new Map((result.units || []).map((unit) => [unit.id, unit]));
      const units = baseUnits(this.data.isFloor3).map((unit) => ({ ...unit, ...(statusById.get(unit.id) || {}) }));
      const selectedIds = new Set(this.data.selectedEmployeeIds || []);
      const selectedUnit = units.find((unit) => unit.id === this.data.selectedUnit?.id) || this.data.selectedUnit;
      const employees = rankEmployees(
        employeeStations(result.employees || [], units),
        selectedUnit?.recommendedBlacklakeOperatorIds || selectedUnit?.recommendedBlacklakeOperatorId,
        [...selectedIds]
      );
      if (this.data.sheetOpen || !this.data.isFloor3) {
        for (const id of selectedIds) {
          const employee = employees.find((item) => item.blacklakeOperatorId === id);
          if (employee) employee.selected = true;
          else {
            const previous = this.data.employees.find((item) => item.blacklakeOperatorId === id);
            if (previous) employees.push({ ...previous, selected: true, available: false, canQueue:false });
          }
        }
      }
      this.setData({
        units,
        stationOptions: [{ id: "请选择工位" }, ...units],
        employees,
        peopleGroupConfig: result.peopleGroupConfig || null,
        overviewLoaded: true,
        selectedUnit,
        unitDetailCanDispatch: this.data.isFloor3 && !!this.data.workOrder && units.some(u=>u.id===this.data.unitDetailId&&u.canAssign!==false&&u.operatorMapped),
        selectedEmployeeIds: employees.filter((employee) => employee.selected).map((employee) => employee.blacklakeOperatorId),
        overviewError: "",
        availableCount: units.filter((unit) => unit.canAssign !== false && (!this.data.isFloor3 || unit.operatorMapped)).length
      });
      this.updateConfirmationSummary();
      this.updateEmployeeView();
    } catch (error) {
      if (!this.pageUnloaded && revision === (this.viewRevision || 0)) this.setData({ overviewError: error.message || "工位状态刷新失败，请重试。" });
    } finally {
      this.syncRefreshTimer();
    }
  },

  scanWorkOrder() {
    if (this.pageUnloaded || this.data.submitting || this.data.skuSearching || this.data.scanning) return;
    this.scanInProgress = true;
    this.setData({scanning:true,scanError:""});
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ["qrCode", "barCode"],
      success: async (result) => {
        if (this.pageUnloaded) return;
        const code = String(result.result || '').trim();
        this.setData({scanning:false});
        if (!code) { this.scanInProgress=false;return this.setData({scanError:'未识别到工单内容，请重新扫描。'}); }
        try { await this.loadWorkOrder(code); } finally { this.scanInProgress=false; }
      },
      fail: (error) => {
        this.scanInProgress=false;
        if (!this.pageUnloaded) this.setData({scanning:false,scanError:/cancel/i.test(error.errMsg||'')?'已取消扫码，可重新扫描。':'扫码没有完成，请重试或输入 SKU 查询工单。'});
      }
    });
  },

  onSkuInput(event) {
    this.skuSearchRevision = (this.skuSearchRevision || 0) + 1;
    this.setData({ skuQuery: event.detail.value, skuResults: [], skuSearchError: "" });
  },

  async searchSkuWorkOrders() {
    const sku = String(this.data.skuQuery || "").normalize("NFKC").trim();
    if (this.data.submitting || this.data.skuSearching) return;
    if (!sku) return this.setData({ skuSearchError: "请输入 SKU。", skuResults: [] });
    const sequence = this.skuSearchRevision = (this.skuSearchRevision || 0) + 1;
    const revision = this.viewRevision || 0;
    this.setData({ skuSearchStarted: true, skuSearching: true, skuSearchError: "", skuResults: [] });
    try {
      const result = await request("/v1/dispatch/work-orders/search", {
        method: "POST", data: { sku }, showLoading: true, timeout: 60000
      });
      if (this.pageUnloaded || sequence !== this.skuSearchRevision || revision !== (this.viewRevision || 0)) return;
      const workOrders = (result.workOrders || []).map(row => ({ ...row,
        productImageUrls: Array.isArray(row.productImageUrls) ? row.productImageUrls.filter(url=>typeof url==='string'&&/^https:\/\//i.test(url)) : [],
        imageFailed: false, imageRevision: sequence, imageKey: sequence + ':' + row.projectId }));
      this.setData({
        skuResults: workOrders,
        skuSearchError: workOrders.length ? "" : "没有找到这个 SKU 的工单，请核对 SKU 或扫描工单码。"
      });
    } catch (error) {
      if (!this.pageUnloaded && sequence === this.skuSearchRevision && revision === (this.viewRevision || 0)) this.setData({ skuSearchError: error.message || "查询失败，请重试。" });
    } finally {
      if (!this.pageUnloaded) this.setData({ skuSearching: false });
    }
  },

  onSkuImageError(event) {
    if (this.pageUnloaded) return;
    const {projectId,imageUrl,imageRevision}=event.currentTarget.dataset;
    this.setData({skuResults:this.data.skuResults.map(row=>row.projectId===Number(projectId)&&row.productImageUrls[0]===imageUrl&&row.imageRevision===Number(imageRevision)?{...row,imageFailed:true}:row)});
  },

  previewSkuImage(event) {
    const {projectId,imageUrl,imageRevision}=event.currentTarget.dataset;
    const row=this.data.skuResults.find(item=>item.projectId===Number(projectId));
    if(this.pageUnloaded||!row||row.imageFailed||!imageUrl||row.productImageUrls[0]!==imageUrl||row.imageRevision!==Number(imageRevision)||this.data.submitting||this.data.skuSearching)return;
    wx.previewImage({current:imageUrl,urls:row.productImageUrls,fail:()=>{if(!this.pageUnloaded)wx.showToast({title:'图片暂时无法预览，请稍后重试',icon:'none'});}});
  },

  selectSkuWorkOrder(event) {
    if (this.data.submitting || this.data.skuSearching) return;
    const projectId = Number(event.currentTarget.dataset.projectId);
    if (!this.data.skuResults.some((order) => order.projectId === projectId)) return;
    this.loadWorkOrder(`projectId=${projectId}`);
  },


  async loadWorkOrder(flowCode) {
    const revision = this.viewRevision = (this.viewRevision || 0) + 1;
    this.setData({ submitting: true });
    try {
      const result = await request("/v1/dispatch/work-order", {
        method: "POST",
        data: { flowCode, includeProgress: !this.data.isFloor3 },
        showLoading: true
      });
      if (this.pageUnloaded || revision !== (this.viewRevision || 0)) return;
      this.setData({
        stage: this.data.isFloor3 ? "map" : "people",
        flowCode,
        workOrder: result.workOrder,
        processes: result.processes || [],
        processOverview: result.processOverview || [],
        processOptions: [{ taskId: null, processName: "请选择工序" }, ...(result.processes || [])],
        processIndex: 0,
        recommendedProcess: result.recommendedProcess || null,
        selectedUnit: null,
        selectedEmployeeIds: [],
        manualUnitByEmployee: {},
        placementReviewKey: "",
        employeePlacements: [],
        employeeQuery: "", employeeFilter: "available", departmentIndex: 0, selectedPeopleGroupId: "", reviewOpen: false, selectedPanelOpen: false,
        prediction: null, initialPrediction: null, predictionRootId: "", predictionAppliedId: "", selectionTouched: false,
        predictionError: "",
        selectedEmbroideryPart: "",
        selectedProcessId: this.data.isFloor3 ? result.recommendedProcess?.taskId || null : null,
        sheetOpen: false,
        sheetStep: "employee",
        floorImageVisible: true,
        floorImageError: false,
        notice: ""
      });
      await this.loadOverview();
      this.syncRefreshTimer();
      wx.vibrateShort({ type: "medium" });
    } catch (error) {
      if (this.pageUnloaded || revision !== (this.viewRevision || 0)) return;
      wx.showModal({ title: "无法读取工单", content: error.message, showCancel: false });
    } finally {
      if (!this.pageUnloaded) this.setData({ submitting: false });
    }
  },

  backToScan() {
    if (this.data.submitting) return;
    this.closeUnitDetail();
    this.viewRevision = (this.viewRevision || 0) + 1;
    this.stopRefreshTimer();
    this.setData({
      stage: "scan",
      workOrder: null,
      flowCode: "",
      skuSearchStarted: false,
      skuResults: [],
      skuSearchError: "",
      processes: [],
      processOverview: [],
      selectedUnit: null,
      selectedEmployeeIds: [],
      manualUnitByEmployee: {},
      employeePlacements: [],
      placementReviewKey: "",
      placementOperatorId: null,
      reviewOpen: false,
      prediction: null, initialPrediction: null, predictionRootId: "", predictionAppliedId: "", predicting: false,
      selectedEmbroideryPart: "",
      sheetOpen: false,
      notice: ""
    });
  },

  selectUnit(event, forDispatch = false) {
    if (this.data.submitting) return;
    const unit = this.data.units.find((item) => item.id === event.currentTarget.dataset.unitId);
    if (!unit) return;
    if (!this.data.placementOperatorId && this.data.stage === "map" && !forDispatch) return this.openUnitDetail(unit);
    if (!this.data.isFloor3) {
      if (this.data.placementOperatorId) {
        this.setData({ manualUnitByEmployee: { ...this.data.manualUnitByEmployee, [this.data.placementOperatorId]: unit.id }, placementReviewKey: "" });
        this.updateConfirmationSummary();
        return this.leaveMap();
      }
      return this.openUnitDetail(unit);
    }
    if (unit.canAssign === false) {
      const stateName = {
        scheduled: "已分配",
        running: "正在生产",
        attention: "等待处理"
      }[unit.state] || "暂不可分配";
      return wx.showToast({ title: `${unit.id} ${stateName}`, icon: "none" });
    }
    if (this.data.isFloor3 && !unit.operatorMapped) {
      return wx.showModal({
        title: `${unit.id} 尚未绑定员工`,
        content: "请先在后台人员设置中，把负责该机器的员工绑定到此机台。",
        showCancel: false
      });
    }
    const employees = rankEmployees(
      this.data.employees,
      unit.recommendedBlacklakeOperatorIds || unit.recommendedBlacklakeOperatorId,
      []
    );
    this.setData({
      selectedUnit: unit,
      selectedEmployeeIds: [],
      selectedEmbroideryPart: "",
      employees,
      selectedProcessId: this.data.recommendedProcess?.taskId || null,
      selectionWarning: "",
      recommendationNotice: "",
      sheetStep: this.data.isFloor3 ? "confirm" : "employee",
      sheetOpen: true
    });
    this.updateConfirmationSummary();
    wx.vibrateShort({ type: "light" });
  },

  async openUnitDetail(unit) {
    this.closeUnitDetail();
    this.setData({unitDetailOpen:true,unitDetailId:unit.id,unitDetail:null,unitDetailError:"",unitDetailCanDispatch:this.data.isFloor3&&!!this.data.workOrder&&unit.canAssign!==false&&!!unit.operatorMapped});
    await this.loadUnitDetail();
  },

  async loadUnitDetail(automatic = false) {
    if (!this.data.unitDetailOpen || this.pageUnloaded) return;
    if (this.unitDetailRequest) return this.unitDetailRequest;
    const id=this.data.unitDetailId, revision=this.unitDetailRevision||0;
    this.setData({unitDetailLoading:true,...(!automatic?{unitDetailError:""}:{})});
    const pending=(async()=>{
      try {
        const result=await request("/v1/dispatch/units/"+encodeURIComponent(id));
        if(this.pageUnloaded||revision!==(this.unitDetailRevision||0)||!this.data.unitDetailOpen||this.data.unitDetailId!==id)return;
        if(result.unitId!==id||!Array.isArray(result.assignments)||!Array.isArray(result.residents))throw new Error("工位详情未能确认，请重试。");
        const assignments=result.assignments.map((row,index)=>{
          const steps=(row.steps||[]).map(p=>({...p,domId:"station-step-"+index+"-"+p.taskId,tone:p.percent>100?'over':p.percent===null?'unknown':p.percent>0?'reported':'zero'}));
          return{...row,steps,scrollTarget:steps.find(p=>p.current)?.domId||""};
        });
        const at=Date.parse(result.coverage?.queriedAt);
        this.setData({unitDetail:{...result,assignments,updatedLabel:Number.isFinite(at)?new Date(at+8*3600000).toISOString().slice(5,19).replace('T',' '):'时间未确认'},unitDetailError:""});
      } catch(error) {
        if(!this.pageUnloaded&&revision===(this.unitDetailRevision||0)&&this.data.unitDetailOpen&&this.data.unitDetailId===id)this.setData({unitDetailError:error.message||"工位详情刷新失败，请重试。"});
      } finally {
        if(!this.pageUnloaded&&revision===(this.unitDetailRevision||0))this.setData({unitDetailLoading:false});
      }
    })();
    this.unitDetailRequest=pending;
    try{return await pending;}finally{if(this.unitDetailRequest===pending)this.unitDetailRequest=null;}
  },

  refreshUnitDetail() { return this.loadUnitDetail(); },

  closeUnitDetail() {
    this.unitDetailRevision=(this.unitDetailRevision||0)+1;this.unitDetailRequest=null;
    this.setData({unitDetailOpen:false,unitDetailId:"",unitDetail:null,unitDetailLoading:false,unitDetailError:"",unitDetailCanDispatch:false});
  },

  maintainUnitResidents() {
    if(this.data.isFloor3)return;
    const id=this.data.unitDetailId;this.closeUnitDetail();
    return this.openStationManager({currentTarget:{dataset:{unitId:id}}});
  },

  dispatchFromUnitDetail() {
    if(!this.data.isFloor3||!this.data.unitDetailCanDispatch)return;
    const id=this.data.unitDetailId;this.closeUnitDetail();
    return this.selectUnit({currentTarget:{dataset:{unitId:id}}},true);
  },

  onFloorImageLoad() {
    if (this.data.floorImageError) this.setData({ floorImageError: false });
  },

  onFloorImageError() {
    this.setData({ floorImageError: true, floorImageVisible: false });
  },

  retryFloorImage() {
    this.setData({ floorImageError: false, floorImageVisible: false }, () => {
      setTimeout(() => this.setData({ floorImageVisible: true }), 30);
    });
  },

  closeSheet() {
    if (this.data.submitting) return;
    if (!this.data.isFloor3 && this.data.stage === "people") return this.backToScan();
    this.setData({ sheetOpen: false });
  },

  openSiteMap(event) {
    if (this.data.submitting) return;
    this.mapReturnStep = this.data.sheetStep;
    this.mapReturnStage = this.data.stage;
    this.setData({ stage: "map", sheetOpen: false,
      placementOperatorId: Number(event?.currentTarget?.dataset?.operatorId) || null });
    this.syncRefreshTimer();
  },

  leaveMap() {
    if(this.workspaceLegacyBoard)return wx.navigateBack();
    this.closeUnitDetail();
    if (this.data.isFloor3) return this.backToScan();
    this.setData({ stage: this.mapReturnStage || "scan", sheetOpen: false, sheetStep: this.mapReturnStep || "employee", placementOperatorId: null });
  },

  async openStationManager(event) {
    if (this.data.submitting || this.data.isFloor3) return;
    const unitId = event?.currentTarget?.dataset?.unitId;
    this.viewRevision = (this.viewRevision || 0) + 1;
    this.setData({ stage: "stations", sheetOpen: false, reviewOpen: false, stationUnit: null, stationQuery: "", stationError: "" });
    await this.loadStationBindings(unitId);
  },

  async loadStationBindings(unitId = this.data.stationUnit?.id) {
    if (this.data.stationLoading || this.data.stationSaving) return;
    const revision = this.viewRevision || 0;
    this.setData({ stationLoading: true, stationError: "" });
    try {
      const result = await request("/v1/dispatch/stations");
      if (this.pageUnloaded || revision !== (this.viewRevision || 0) || this.data.stage !== "stations") return;
      if (!Array.isArray(result.units) || !Array.isArray(result.employees)) throw new Error("工位绑定未能确认");
      const stationUnits = result.units.map((unit) => ({ ...unit, names: unit.blacklakeOperatorIds.map((id) =>
        result.employees.find((employee) => employee.blacklakeOperatorId === id)?.name || `人员${id}（需核对）`).join("、") }));
      this.setData({ stationUnits, stationEmployees: result.employees, stationSaveUncertain: false });
      this.updateStationView();
      if (unitId) this.editStation({ currentTarget: { dataset: { unitId } } });
    } catch (error) {
      if (!this.pageUnloaded && revision === (this.viewRevision || 0)) this.setData({ stationError: error.message || "工位读取失败" });
    } finally {
      if (!this.pageUnloaded) this.setData({ stationLoading: false });
    }
  },
  refreshStationBindings() { return this.loadStationBindings(); },
  updateStationView() {
    const query = this.data.stationQuery.trim().toLocaleLowerCase("zh-CN");
    const personQuery = this.data.stationPersonQuery.trim().toLocaleLowerCase("zh-CN");
    this.setData({ visibleStationUnits: this.data.stationUnits.filter((unit) => !query || `${unit.id} ${unit.names}`.toLocaleLowerCase("zh-CN").includes(query)),
      visibleBindingEmployees: this.data.stationEmployees.filter((employee) => !personQuery || `${employee.name} ${employee.description}`.toLocaleLowerCase("zh-CN").includes(personQuery))
        .map((employee) => ({ ...employee, selected: this.data.stationDraftIds.includes(employee.blacklakeOperatorId) })),
      stationDraftChips: this.data.stationDraftIds.map((id) => ({ blacklakeOperatorId: id,
        name: this.data.stationEmployees.find((employee) => employee.blacklakeOperatorId === id)?.name || `人员${id}（需核对）` })) });
  },
  onStationQuery(event) { this.setData({ stationQuery: event.detail.value }); this.updateStationView(); },
  onStationPersonQuery(event) { this.setData({ stationPersonQuery: event.detail.value }); this.updateStationView(); },
  editStation(event) {
    if (this.data.stationSaving) return;
    const unit = this.data.stationUnits.find((row) => row.id === event.currentTarget.dataset.unitId);
    if (!unit) return;
    this.setData({ stationUnit: unit, stationDraftIds: [...unit.blacklakeOperatorIds], stationExpectedIds: [...unit.blacklakeOperatorIds], stationPersonQuery: "" });
    this.updateStationView();
  },
  toggleStationEmployee(event) {
    if (this.data.stationSaving || this.data.stationSaveUncertain) return;
    const id = Number(event.currentTarget.dataset.operatorId);
    if (!this.data.stationDraftIds.includes(id) && !this.data.stationEmployees.some((employee) => employee.blacklakeOperatorId === id)) return;
    this.setData({ stationDraftIds: this.data.stationDraftIds.includes(id) ? this.data.stationDraftIds.filter((value) => value !== id) : [...this.data.stationDraftIds, id] });
    this.updateStationView();
  },
  backFromStation() {
    if (this.data.stationSaving) return;
    if (this.data.stationUnit) this.setData({ stationUnit: null });
    else { this.viewRevision = (this.viewRevision || 0) + 1; this.setData({ stage: "scan" }); void this.loadOverview(); }
  },
  async saveStationBinding() {
    if (!this.data.stationUnit || this.data.stationSaving || this.data.stationSaveUncertain) return;
    const revision = this.viewRevision || 0;
    const unitId = this.data.stationUnit.id;
    this.setData({ stationSaving: true, stationError: "" });
    try {
      await request(`/v1/dispatch/stations/${encodeURIComponent(unitId)}`, { method: "PATCH", data: {
        blacklakeOperatorIds: this.data.stationDraftIds, expectedOperatorIds: this.data.stationExpectedIds } });
      if (this.pageUnloaded || revision !== (this.viewRevision || 0)) return;
      this.setData({ stationSaving: false });
      await this.loadStationBindings(unitId);
      await this.loadOverview();
      wx.showToast({ title: "工位绑定已保存", icon: "success" });
    } catch (error) {
      if (!this.pageUnloaded && revision === (this.viewRevision || 0)) this.setData({ stationError: !error.status
        ? "未收到保存结果，请刷新核对后再操作" : error.message, stationSaveUncertain: true });
    } finally { if (!this.pageUnloaded) this.setData({ stationSaving: false }); }
  },

  chooseEmployeeUnit(event) {
    if (this.data.submitting) return;
    const id = Number(event.currentTarget.dataset.operatorId);
    const unit = this.data.units[Number(event.detail.value) - 1];
    if (!unit || !this.data.selectedEmployeeIds.includes(id)) return;
    this.manualRevision = (this.manualRevision || 0) + 1;
    this.setData({ manualUnitByEmployee: { ...this.data.manualUnitByEmployee, [id]: unit.id }, placementReviewKey: "", selectionTouched: true });
    this.updateConfirmationSummary();
  },

  chooseEmployee(event) {
    if (this.data.submitting) return;
    const employee = this.data.employees.find((item) => item.blacklakeOperatorId === Number(event.currentTarget.dataset.operatorId));
    if (!employee || (!employee.available && !employee.canQueue && !this.data.selectedEmployeeIds.includes(employee.blacklakeOperatorId))) return;
    const alreadySelected = this.data.selectedEmployeeIds.includes(employee.blacklakeOperatorId);
    const selectedEmployeeIds = alreadySelected
      ? this.data.selectedEmployeeIds.filter((id) => id !== employee.blacklakeOperatorId)
      : [...this.data.selectedEmployeeIds, employee.blacklakeOperatorId];
    this.setEmployeeSelection(selectedEmployeeIds);
  },

  setEmployeeSelection(selectedEmployeeIds) {
    this.invalidateProcessPrediction();
    this.manualRevision = (this.manualRevision || 0) + 1;
    this.setData({
      selectedEmployeeIds,
      selectionTouched: false,
      manualUnitByEmployee: Object.fromEntries(Object.entries(this.data.manualUnitByEmployee).filter(([id]) => selectedEmployeeIds.includes(Number(id)))),
      placementReviewKey: "",
      employees: this.data.employees.map((item) => ({
        ...item,
        selected: selectedEmployeeIds.includes(item.blacklakeOperatorId)
      }))
    });
    this.updateConfirmationSummary();
    this.updateEmployeeView();
  },

  updateEmployeeView() {
    const config = this.data.peopleGroupConfig;
    const configured = config && Array.isArray(config.groups) && Number.isSafeInteger(config.allPosition)
      && config.allPosition >= 0 && config.allPosition <= config.groups.length
      && config.groups.every(group => group && typeof group.id === "string" && group.id !== "@all" && typeof group.name === "string");
    const groups = configured ? config.groups.map(group => ({ id: group.id, label: group.name }))
      : [...new Set(this.data.employees.flatMap(employee => employee.departments || (employee.description ? [employee.description] : [])))]
        .map(name => ({ id: "legacy:" + name, label: name }));
    groups.splice(configured ? config.allPosition : 0, 0, { id: "@all", label: "全部" });
    const previous = this.data.selectedPeopleGroupId;
    const matchingIndex = previous ? groups.findIndex(group => group.id === previous) : 0;
    const departmentIndex = matchingIndex >= 0 ? matchingIndex : groups.findIndex(group => group.id === "@all");
    const department = groups[departmentIndex];
    const inGroup = employee => department.id === "@all" || (employee.departments || [employee.description]).includes(department.label);
    const options = groups.map(group => group.id === "@all" ? "全部部门" : group.label);
    const query = String(this.data.employeeQuery || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
    const visibleEmployees = this.data.employees.filter((employee) =>
      (this.data.employeeFilter !== "available" || employee.available || employee.canQueue || employee.selected)
      && inGroup(employee)
      && (!query || [employee.name, employee.description, ...(employee.boundUnitIds || [])].join(" ").normalize("NFKC").toLocaleLowerCase("zh-CN").includes(query)));
    const groupEmployees = this.data.employees.filter((employee) =>
      inGroup(employee)
      && (!query || [employee.name, employee.description, ...(employee.boundUnitIds || [])].join(" ").normalize("NFKC").toLocaleLowerCase("zh-CN").includes(query)));
    this.setData({ departmentOptions: options, departmentIndex, selectedPeopleGroupId: this.data.overviewLoaded ? department.id : previous || "", visibleEmployees,
      peopleGroups: groups.map((group,index) => ({ ...group, index, count: this.data.employees.filter(employee =>
        group.id === "@all" || (employee.departments || [employee.description]).includes(group.label)).length })),
      groupEmployees, peopleGroupName: department.id === "@all" ? "全部人员" : department.label,
      peopleGroupAvailableCount: groupEmployees.filter((person) => person.available||person.canQueue).length,
      peopleGroupSelectedCount: groupEmployees.filter((person) => this.data.selectedEmployeeIds.includes(person.blacklakeOperatorId)).length,
      peopleGroupTotal: groupEmployees.length,
      peopleDateLabel: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0,10),
      selectedChips: this.data.selectedEmployeeIds.map((id) => ({ blacklakeOperatorId: id,
        name: this.data.employees.find((employee) => employee.blacklakeOperatorId === id)?.name || "人员待刷新" })),
      processIndex: Math.max(0, this.data.processOptions.findIndex((process) => process.taskId === this.data.selectedProcessId)) });
  },

  onPeopleSearchFocus() { this.setData({orderOrbKeyboardOpen:true}); },
  onPeopleSearchBlur() { this.setData({orderOrbKeyboardOpen:false}); },
  onEmployeeQuery(event) { this.setData({ employeeQuery: event.detail.value }); this.updateEmployeeView(); },
  setEmployeeFilter(event) { this.setData({ employeeFilter: event.currentTarget.dataset.filter }); this.updateEmployeeView(); },
  onDepartmentChange(event) {
    const departmentIndex = Number(event.detail.value);
    const group = this.data.peopleGroups[departmentIndex];
    if (!group) return;
    this.setData({ departmentIndex, selectedPeopleGroupId: group.id }); this.updateEmployeeView();
  },
  choosePeopleGroup(event) { this.onDepartmentChange({ detail: { value: event.currentTarget.dataset.groupIndex } }); },
  selectGroupAvailable() {
    if (this.data.submitting) return;
    const ids = this.data.groupEmployees.filter((person) => person.available||person.canQueue).map((person) => person.blacklakeOperatorId);
    this.setEmployeeSelection([...new Set([...this.data.selectedEmployeeIds, ...ids])]);
  },
  clearGroupSelection() {
    if (this.data.submitting) return;
    const ids = new Set(this.data.groupEmployees.map((person) => person.blacklakeOperatorId));
    this.setEmployeeSelection(this.data.selectedEmployeeIds.filter((id) => !ids.has(id)));
  },
  openSelectedPeople() { this.setData({ selectedPanelOpen: true }); },
  closeSelectedPeople() { this.setData({ selectedPanelOpen: false }); },
  openPeopleMenu() {
    if (this.data.submitting) return;
    const actions = [...(this.data.stage === "process" && this.data.prediction ? ["查看推荐依据"] : []), "今日分配", "重新选择工单", "刷新人员", "退出登录"];
    wx.showActionSheet({ itemList: actions, success: (result) => {
      if (actions[result.tapIndex] === "查看推荐依据") this.showPredictionBasis();
      if (actions[result.tapIndex] === "今日分配") void this.openHistory();
      if (actions[result.tapIndex] === "重新选择工单") this.backToScan();
      if (actions[result.tapIndex] === "刷新人员") void this.loadOverview();
      if (actions[result.tapIndex] === "退出登录") this.logout();
    } });
  },
  backFromDispatchStep() { return this.data.stage === "process" ? this.backToPeople() : this.backToScan(); },
  clearSelectedEmployees() {
    if (this.data.submitting) return;
    this.invalidateProcessPrediction();
    this.manualRevision = (this.manualRevision || 0) + 1;
    this.setData({ selectedEmployeeIds: [], manualUnitByEmployee: {}, placementReviewKey: "", selectionTouched: false,
      employees: this.data.employees.map((employee) => ({ ...employee, selected: false })) });
    this.updateConfirmationSummary(); this.updateEmployeeView();
  },

  onProcessChange(event) {
    if (this.data.submitting) return;
    const process = this.data.processOptions[Number(event.detail.value)];
    this.manualRevision = (this.manualRevision || 0) + 1;
    this.setData({ selectedProcessId: process?.taskId || null, placementReviewKey: "", selectionTouched: true,
      predictionAppliedId: this.data.prediction?.taskId === process?.taskId ? this.data.prediction.id : "" });
    this.updateConfirmationSummary(); this.updateEmployeeView();
  },
  selectPersonProcess(event) {
    const index = this.data.processOptions.findIndex((row) => row.taskId === Number(event.currentTarget.dataset.taskId));
    if (index > 0) this.onProcessChange({ detail: { value: index } });
  },
  onProcessWheelStart() {
    if (this.data.submitting || this.data.stage !== "process") return;
    this.manualRevision = (this.manualRevision || 0) + 1;
    this.setData({ processWheelMoving: true });
  },
  onProcessWheelEnd() { this.setData({ processWheelMoving: false }); },
  onProcessWheelChange(event) {
    const index = Number(event.detail.value?.[0]);
    const process = this.data.processes[index];
    if (!process || this.data.submitting || this.data.stage !== "process") return;
    this.setData({ processWheelMoving: false });
    if (process.taskId !== this.data.selectedProcessId) this.selectPersonProcess({ currentTarget: { dataset: { taskId: process.taskId } } });
  },

  invalidateProcessPrediction() {
    this.predictionRevision = (this.predictionRevision || 0) + 1;
    this.setData({ selectedProcessId: null, prediction: null, initialPrediction: null,
      predictionRootId: "", predictionAppliedId: "", predicting: false, predictionError: "",
      predictionPeriodLabel: "", selectionTouched: false,
      processScrollTarget: "", processWheelValue: [0], processWheelIndex: -1, processWheelMoving: false });
  },
  onOrderOrbModal(event) { this.setData({orderOrbOpen:!!event.detail.open}); },
  continueToProcess() {
    if (this.data.submitting || this.data.orderOrbOpen || !this.data.selectedEmployeeIds.length) return;
    this.updateConfirmationSummary();
    if (this.data.selectionWarning) return wx.showToast({ title: "请重新核对所选人员", icon: "none" });
    this.viewRevision = (this.viewRevision || 0) + 1;
    this.setData({ stage: "process", processWheelMoving: false });
    this.syncRefreshTimer();
    if (!this.data.predictionRootId) void this.loadPrediction();
  },
  backToPeople() {
    if (this.data.submitting) return;
    this.viewRevision = (this.viewRevision || 0) + 1;
    this.setData({ stage: "people", reviewOpen: false, predicting: false, processWheelMoving: false });
  },

  async loadPrediction({ taskId, force = false } = {}) {
    if (!this.data.selectedEmployeeIds.length || !this.data.processes.length || this.data.stage !== "process") return;
    const sequence = this.predictionRevision = (this.predictionRevision || 0) + 1;
    const revision = this.viewRevision || 0, manualRevision = this.manualRevision || 0;
    const flowCode = this.data.flowCode;
    const selectedIds = [...this.data.selectedEmployeeIds].sort((a,b) => a-b);
    this.setData({ predicting: true, predictionError: "" });
    try {
      const result = await request("/v1/dispatch/prediction", { method: "POST", data: { flowCode,
        blacklakeOperatorIds: selectedIds,
        ...(this.data.predictionRootId ? { initialPredictionId: this.data.predictionRootId } : {}) } });
      if (this.pageUnloaded || sequence !== this.predictionRevision || revision !== (this.viewRevision || 0) || this.data.flowCode !== flowCode || this.data.stage !== "process"
        || JSON.stringify(selectedIds) !== JSON.stringify([...this.data.selectedEmployeeIds].sort((a,b) => a-b))) return;
      const prediction = result.prediction;
      if (!prediction?.id || !Array.isArray(prediction.employees)) throw new Error("预测内容未能确认");
      this.setData({ prediction, predictionPeriodLabel: String(prediction.source?.sourcePeriod?.to || "").slice(0, 10),
        predictionRootId: this.data.predictionRootId || prediction.id, initialPrediction: this.data.initialPrediction || prediction });
      this.updateConfirmationSummary();
      if (manualRevision === (this.manualRevision || 0) && !this.data.reviewOpen && (force || !this.data.selectionTouched)) {
        this.setData({ selectedProcessId: this.data.processes.some((process) => process.taskId === prediction.taskId) ? prediction.taskId : this.data.selectedProcessId,
          placementReviewKey: "", selectionTouched: false,
          predictionRootId: this.data.predictionRootId || prediction.id, predictionAppliedId: prediction.id,
          initialPrediction: this.data.initialPrediction || prediction });
        this.updateConfirmationSummary(); this.updateEmployeeView();
        if (this.data.selectedProcessId) this.setData({ processScrollTarget: `process-card-${this.data.selectedProcessId}` });
      }
    } catch (error) {
      if (!this.pageUnloaded && sequence === this.predictionRevision && revision === (this.viewRevision || 0)) this.setData({ predictionError: "建议暂不可用，可手动选择" });
    } finally {
      if (!this.pageUnloaded && sequence === this.predictionRevision) this.setData({ predicting: false });
    }
  },
  usePredictionAgain() {
    if (this.data.submitting) return;
    if (this.data.initialPrediction && Date.parse(this.data.initialPrediction.expiresAt) <= Date.now())
      this.setData({ initialPrediction: null, predictionRootId: "", predictionAppliedId: "" });
    void this.loadPrediction({ taskId: this.data.selectedProcessId, force: true });
  },
  showPredictionBasis() {
    const prediction = this.data.prediction;
    if (!prediction) return;
    const source = prediction.source || {}, period = source.sourcePeriod || {};
    const evidence = (prediction.candidates || prediction.employees || []).slice(0, 10).map((person) =>
      `${person.name}：${person.evidence?.reportCount || 0}条报工、${person.evidence?.workOrderCount || 0}张工单，主工序占比${Math.round((person.evidence?.dominantShare || 0) * 100)}%`).join("\n");
    wx.showModal({ title: "历史预选依据", content: `分析时段：${String(period.from || "未知").slice(0,10)} 至 ${String(period.to || "未知").slice(0,10)}\n源分析${source.sourceRecordCount || 0}条，版本${source.version || "未知"}\n${evidence}\n${prediction.exclusionNote || "历史不代表当前开工条件。"}`, showCancel: false });
  },

  placementKey() {
    return JSON.stringify(this.data.employeePlacements.map(({ blacklakeOperatorId, unitId, source }) => ({ blacklakeOperatorId, unitId, source })));
  },

  reviewAssignment() {
    if (this.data.submitting || this.data.processWheelMoving) return;
    if (!this.data.selectedProcessId) return wx.showToast({ title: "请选择工序", icon: "none" });
    if (!this.data.selectedEmployeeIds.length) return wx.showToast({ title: "请选择人员", icon: "none" });
    this.updateConfirmationSummary();
    if (this.data.selectionWarning) return wx.showToast({ title: "请返回核对人员与工位", icon: "none" });
    this.manualRevision = (this.manualRevision || 0) + 1;
    this.setData({ sheetStep: "confirm", reviewOpen: true, placementOnly: false, placementReviewKey: this.placementKey() });
  },

  async dispatchSelectedPeople() {
    if (this.data.isFloor3 || this.data.stage !== "process" || this.data.submitting || this.data.processWheelMoving) return;
    if (!this.data.selectedProcessId) return wx.showToast({ title: "请选择工序", icon: "none" });
    if (!this.data.selectedEmployeeIds.length) return wx.showToast({ title: "请选择人员", icon: "none" });
    this.updateConfirmationSummary();
    if (this.data.selectionWarning) return wx.showToast({ title: "请返回检查人员与工位", icon: "none" });
    this.manualRevision = (this.manualRevision || 0) + 1;
    this.setData({ placementReviewKey: this.placementKey() });
    if (!this.data.placementsReady) {
      this.setData({ placementOnly: true, reviewOpen: true });
      return;
    }
    return this.confirmAssignment({ direct: true });
  },

  closeReview() { if (!this.data.submitting) this.setData({ reviewOpen: false, placementReviewKey: "" }); },


  updateConfirmationSummary() {
    const chosen = this.data.selectedEmployeeIds.map((id) => this.data.employees.find((item) => item.blacklakeOperatorId === id));
    const process = this.data.processes.find((item) => item.taskId === this.data.selectedProcessId);
    const employeePlacements = chosen.map((employee, index) => {
      const id = this.data.selectedEmployeeIds[index];
      const boundUnitIds = employee?.boundUnitIds || [];
      const manual = this.data.manualUnitByEmployee[id];
      const unitId = manual || (boundUnitIds.length === 1 ? boundUnitIds[0] : "");
      return { blacklakeOperatorId: id, name: employee?.name || "人员信息待刷新", unitId,
        source: manual ? "manual" : "binding", boundUnitIds,
        unitLabel: unitId || (boundUnitIds.length ? "绑定多个工位，请选择" : "未绑定，请选择工位"),
        unitIndex: Math.max(0, this.data.units.findIndex((unit) => unit.id === unitId) + 1) };
    });
    const key = JSON.stringify(employeePlacements.map(({ blacklakeOperatorId, unitId, source }) => ({ blacklakeOperatorId, unitId, source })));
    const processWheelIndex = this.data.processes.findIndex((item) => item.taskId === this.data.selectedProcessId);
    this.setData({
      employeePlacements,
      processWheelIndex,
      ...(!this.data.processWheelMoving ? { processWheelValue: [Math.max(0, processWheelIndex)] } : {}),
      processWheelItems: (this.data.processOverview.length ? this.data.processOverview : this.data.processes).map((item, index) => ({ ...item,
        selectable: !item.closed && item.selectable !== false && this.data.processes.some(process => process.taskId === item.taskId),
        percentLabel: typeof item.percentLabel === 'string' ? item.percentLabel : '—', statusLabel: item.statusLabel || '进度未确认',
        orderLabel: String(Number(item.sequence) > 0 ? item.sequence : index + 1).padStart(2, "0") })),
      predictionAdjusted: Boolean(this.data.initialPrediction) && (this.data.initialPrediction.taskId !== this.data.selectedProcessId
        || JSON.stringify(this.data.initialPrediction.employees.map((row) => row.blacklakeOperatorId).sort((a,b) => a-b)) !== JSON.stringify([...this.data.selectedEmployeeIds].sort((a,b) => a-b))
        || employeePlacements.some((row) => this.data.initialPrediction.employees.some((previous) => previous.blacklakeOperatorId === row.blacklakeOperatorId && previous.unitId !== row.unitId))),
      placementsReady: employeePlacements.length > 0 && employeePlacements.every((item) => Boolean(item.unitId)),
      selectedStationSummary: employeePlacements.map((item) => `${item.name} · ${item.unitLabel}`).join("；"),
      selectedEmployeeNames: chosen.map((item) => item?.name || "人员信息待刷新").join("、"),
      selectedProcessName: process?.processName || "待选择工序",
      selectionWarning: chosen.some((item) => !item?.available&&!item?.canQueue) ? "所选人员状态已变化，请返回重新核对人员。"
        : this.data.placementReviewKey && key !== this.data.placementReviewKey ? "工位绑定已变化，请返回重新核对工位。" : ""
    });
  },

  chooseDispatchPart(event) {
    const part = String(event.currentTarget.dataset.part || "");
    if (["前幅", "后幅"].includes(part)) this.setData({ selectedEmbroideryPart: part });
  },

  async confirmAssignment({ direct = false } = {}) {
    if (this.data.submitting || this.data.processWheelMoving || (this.data.isFloor3 && !this.data.selectedUnit)) return;
    if (!this.data.isFloor3 && !this.data.reviewOpen && !direct) return this.reviewAssignment();
    if (!this.data.selectedProcessId) {
      return wx.showToast({ title: "当前工单没有可分配工序", icon: "none" });
    }
    if (this.data.isFloor3 && !this.data.selectedEmbroideryPart) {
      return wx.showToast({ title: "请选择前幅或后幅", icon: "none" });
    }
    if (!this.data.isFloor3 && !this.data.selectedEmployeeIds.length) return;
    this.updateConfirmationSummary();
    if (!this.data.isFloor3 && this.data.selectionWarning) return wx.showToast({ title: "请重新核对所选人员", icon: "none" });
    if (!this.data.isFloor3 && this.data.employeePlacements.some((item) => !item.unitId)) return wx.showToast({ title: "请补充所选人员的工位", icon: "none" });
    const unitId = this.data.selectedUnit?.id;
    const embroideryPart = this.data.selectedEmbroideryPart;
    this.setData({ submitting: true });
    this.viewRevision = (this.viewRevision || 0) + 1;
    try {
      const result = await request("/v1/dispatch/assign", {
        method: "POST",
        data: {
          flowCode: this.data.flowCode,
          taskId: this.data.selectedProcessId,
          ...(this.data.isFloor3
            ? { unitId, embroideryPart: this.data.selectedEmbroideryPart }
            : { blacklakeOperatorIds: this.data.selectedEmployeeIds, quantityPolicy: "PENDING_REVIEW",
                ...(this.data.predictionRootId ? { predictionId: this.data.predictionRootId,
                  appliedPredictionId: this.data.predictionAppliedId } : {}),
                placements: this.data.employeePlacements.map(({ blacklakeOperatorId, unitId, source }) => ({ blacklakeOperatorId, unitId, source })) })
        },
        showLoading: true
      });
      if (this.pageUnloaded) return;
      this.viewRevision = (this.viewRevision || 0) + 1;
      const assignedCount = Array.isArray(result.assignments) ? result.assignments.length : 1;
      const units = this.data.units.map((unit) => this.data.isFloor3 && unit.id === unitId
        ? {
            ...unit,
            state: unit.state === "available" ? "scheduled" : unit.state,
            assignment: result.assignment,
            assignmentCount: Number(unit.assignmentCount || 0) + assignedCount,
            canAssign: !this.data.isFloor3 || unit.operatorMapped !== false
          }
        : unit);
      this.setData({
        units,
        ...(!this.data.isFloor3 ? { stage: "people", selectedProcessId: null } : {}),
        selectedEmployeeIds: [],
        employees: this.data.employees.map((employee) => ({ ...employee, selected: false })),
        manualUnitByEmployee: {},
        employeePlacements: [],
        placementReviewKey: "",
        selectedEmbroideryPart: "",
        availableCount: units.filter((unit) => unit.canAssign !== false && (!this.data.isFloor3 || unit.operatorMapped)).length,
        sheetOpen: false,
        sheetStep: "employee",
        reviewOpen: false, prediction: null, initialPrediction: null, predictionRootId: "", predictionAppliedId: "",
        selectionTouched: false,
        lastDispatchIds: (result.assignments || [result.assignment]).filter(Boolean).map((item) => item.id),
        notice: this.data.isFloor3
          ? `${unitId} · ${embroideryPart} 已分配，可在今日分配中查看`
          : `已按各人工位分配给 ${assignedCount} 人，可在今日分配中查看`
      });
      wx.vibrateShort({ type: "medium" });
      await this.loadOverview();
      if (this.data.historyOpen) await this.loadHistory();
    } catch (error) {
      if (this.pageUnloaded) return;
      if (error.code === "PREDICTION_EXPIRED") this.setData({ reviewOpen: false, placementReviewKey: "", prediction: null,
        initialPrediction: null, predictionRootId: "", predictionAppliedId: "", selectionTouched: true,
        predictionError: "建议已过期，正在更新" });
      wx.showModal({ title: !error.status ? "分配结果待确认" : "分配没有完成", content: !error.status ? "未收到明确结果，请先查看今日分配和人员状态，避免重复分配。" : error.message, showCancel: false });
      await this.loadOverview();
      if (this.data.historyOpen) await this.loadHistory();
      if (error.code === "PREDICTION_EXPIRED" && this.data.stage === "process") void this.loadPrediction();
    } finally {
      if (!this.pageUnloaded) this.setData({ submitting: false });
    }
  },

  switchHistoryTab(event) {
    const tab=event.currentTarget.dataset.tab;
    if(!['dispatch','reports'].includes(tab)||this.data.reportSaving||this.data.cancelling)return;
    this.historyRevision=(this.historyRevision||0)+1;
    this.setData({historyTab:tab,reportMenuId:'',cancelAssignmentId:''});
    return this.loadHistory();
  },
  changeReportDate(event) {
    if(this.data.reportSaving)return;
    this.reportRequestRevision=(this.reportRequestRevision||0)+1;
    this.setData({reportDate:event.detail.value,reportRecords:[],reportLoaded:false,reportMenuId:'',reportError:''});
    return this.loadReportRecords();
  },
  async loadReportRecords({append=false,clearActionError=false}={}) {
    if(this.data.reportSaving||this.data.reportEditor)return;
    if(append&&(this.data.reportLoading||!this.data.reportHasMore))return;
    const requestRevision=this.reportRequestRevision=(this.reportRequestRevision||0)+1;
    const date=this.data.reportDate||new Date(Date.now()+8*3600000).toISOString().slice(0,10),offset=append?this.data.reportRecords.length:0;
    const current=()=>!this.pageUnloaded&&this.data.historyOpen&&this.data.historyTab==='reports'&&requestRevision===this.reportRequestRevision;
    this.setData({reportLoading:true,reportError:'',reportDate:date});
    try {
      const result=await request(`/v1/dispatch/reports?date=${encodeURIComponent(date)}&offset=${offset}&limit=30`);
      if(!current())return;
      if(!Array.isArray(result.reports)||result.date!==date)throw Error('报工记录未能确认，请重试。');
      const records=result.reports.map(row=>({...row,timeText:String(row.reportedAt||'').slice(5,16),durationText:reportClock(row.durationSeconds)}));
      this.setData({reportRecords:append?[...this.data.reportRecords,...records]:records,reportTotal:result.total,
        reportHasMore:Boolean(result.hasMore),reportLoaded:true,reportMaxDate:String(result.serverTime||'').slice(0,10)||date,
        ...(clearActionError?{reportActionError:''}:{})});
    }catch(error){if(current())this.setData({reportError:error.message||'报工记录加载失败，请重试。'});}
    finally{if(current())this.setData({reportLoading:false});}
  },
  loadMoreReports(){return this.loadReportRecords({append:true});},
  refreshReports(){return this.loadReportRecords({clearActionError:true});},
  async reconcileReport(event) {
    const record=this.data.reportRecords.find(r=>r.id===event.currentTarget.dataset.id);
    if(!record?.canReconcile||this.data.reportSaving)return;
    const revision=this.reportActionRevision=(this.reportActionRevision||0)+1;
    this.reportRequestRevision=(this.reportRequestRevision||0)+1;
    this.setData({reportSaving:true,reportLoading:false,reportMenuId:'',reportActionError:''});
    try {
      const result=await request(`/v1/dispatch/reports/${encodeURIComponent(record.id)}/reconcile`,{method:'POST',data:{}});
      if(this.pageUnloaded||revision!==this.reportActionRevision)return;
      if(['SUCCEEDED','NO_PENDING'].includes(result.status))wx.showToast({title:'已核对最新结果',icon:'success'});
      else this.setData({reportActionError:result.error?.message||'结果尚未确认，未重发修改或删除，请稍后核对。'});
    }catch(error){if(!this.pageUnloaded&&revision===this.reportActionRevision)this.setData({reportActionError:error.message||'暂时无法核对，请稍后再试。'});}
    finally{if(!this.pageUnloaded&&revision===this.reportActionRevision){this.setData({reportSaving:false});await this.loadReportRecords();}}
  },
  toggleReportMenu(event) {
    if(this.data.reportSaving)return;
    const id=event.currentTarget.dataset.id;
    this.setData({reportMenuId:this.data.reportMenuId===id?'':id,reportScrollTarget:'report-row-'+id,reportActionError:''});
  },
  closeReportMenu(){this.setData({reportMenuId:''});},
  async openReportEditor(event) {
    const record=this.data.reportRecords.find(r=>r.id===event.currentTarget.dataset.id);
    if(!record?.canEdit||this.data.reportSaving||this.data.reportEditor)return;
    const revision=this.reportEditorRevision=(this.reportEditorRevision||0)+1;
    this.reportOperationKey='leader-report-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    this.setData({reportEditor:record,reportTimeInvalid:false,reportEditorLoading:true,reportEditForm:null,reportPeopleOpen:false,reportMenuId:'',reportActionError:'',reportActionLocked:false,reportDefectsOpen:false,reportExtraOpen:false});
    try {
      const result=await request(`/v1/dispatch/reports/${encodeURIComponent(record.id)}/editor`);
      if(this.pageUnloaded||revision!==this.reportEditorRevision||!this.data.reportEditor)return;
      if(!result.report?.remoteVersion||!Array.isArray(result.people))throw Error('未取得完整编辑资料，请关闭后重试。');
      const row=result.report,options=(row.defectReasons||[]).map(r=>({...r,selected:(row.defectCodes||[]).includes(r.code),quantity:String((row.defectItems||[]).find(i=>i.code===r.code)?.amount??((row.defectCodes||[]).length===1?row.defectQuantity:''))}));
      this.setData({reportEditor:row,reportEditForm:require('../../utils/report-editor-model').form(row),reportGoodInput:String(row.goodQuantity),reportDefectInput:String(row.defectQuantity||0),reportSelectedCodes:row.defectCodes||[],reportReasonOptions:options,reportPeopleAll:result.people,reportPeopleResults:result.people,reportPeopleGroupConfig:result.peopleGroupConfig||null,reportPeopleGroupId:'',reportPeopleQuery:'',reportDefectText:options.filter(r=>r.selected).map(r=>r.name).join('、')||'无不良'});
    }catch(error){if(!this.pageUnloaded&&revision===this.reportEditorRevision)this.setData({reportActionError:error.message||'资料读取失败，请关闭后重试。',reportActionLocked:true});}
    finally{if(!this.pageUnloaded&&revision===this.reportEditorRevision)this.setData({reportEditorLoading:false});}
  },
  closeReportEditor(){if(this.data.reportSaving)return;if(this.data.reportPeopleOpen)return this.setData({reportPeopleOpen:false});this.reportEditorRevision=(this.reportEditorRevision||0)+1;this.setData({reportEditor:null,reportEditorLoading:false});return this.loadReportRecords();},
  onReportGoodInput(event){this.setData({reportGoodInput:event.detail.value});},
  onReportDefectInput(event){if(this.data.reportSaving||this.data.reportActionLocked||!this.data.reportEditor?.canEditDefects)return;const value=event.detail.value;this.setData({reportDefectInput:value,...(value==='0'?{reportSelectedCodes:[],reportReasonOptions:this.data.reportReasonOptions.map(r=>({...r,selected:false})),reportDefectText:'无不良'}:!this.data.reportSelectedCodes.length?{reportDefectText:'选择并分配数量'}:{})});},
  toggleReportDefect(event){if(this.data.reportSaving||this.data.reportActionLocked||!this.data.reportEditor?.canEditDefects)return;const code=event.currentTarget.dataset.code,codes=this.data.reportSelectedCodes,next=codes.includes(code)?codes.filter(c=>c!==code):[...codes,code],options=this.data.reportReasonOptions.map(r=>({...r,selected:next.includes(r.code),quantity:r.quantity||String(this.data.reportDefectInput)}));this.setData({reportSelectedCodes:next,reportReasonOptions:options,reportDefectText:options.filter(r=>r.selected).map(r=>r.name).join('、')||'选择并分配数量'});},
  onReportDefectAmount(event){if(this.data.reportSaving||this.data.reportActionLocked||!this.data.reportEditor?.canEditDefects)return;const code=event.currentTarget.dataset.code;this.setData({reportReasonOptions:this.data.reportReasonOptions.map(r=>r.code===code?{...r,quantity:event.detail.value}:r)});},
  toggleReportDefects(){if(!this.data.reportSaving&&!this.data.reportActionLocked&&this.data.reportEditor?.canEditDefects)this.setData({reportDefectsOpen:!this.data.reportDefectsOpen});},
  toggleReportExtra(){this.setData({reportExtraOpen:!this.data.reportExtraOpen});},
  onReportEditField(event){if(this.data.reportSaving||this.data.reportActionLocked)return;const field=event.currentTarget.dataset.field;if(['hours','minutes','materialProcess'].includes(field))this.setData({reportEditForm:{...this.data.reportEditForm,[field]:event.detail.value}});},
  openReportPeople(){if(!this.data.reportSaving&&!this.data.reportActionLocked){this.setData({reportPeopleOpen:true,reportPeopleQuery:''});this.updateReportPeopleView();}},
  updateReportPeopleView(){const view=require('../../utils/report-editor-model').peopleView(this.data.reportPeopleAll,this.data.reportPeopleGroupConfig,this.data.reportPeopleGroupId,this.data.reportPeopleQuery);this.setData({reportPeopleGroups:view.groups,reportPeopleGroupId:view.selectedId,reportPeopleResults:view.results});},
  chooseReportPeopleGroup(event){if(this.data.reportSaving||this.data.reportActionLocked)return;const id=event.currentTarget.dataset.id;if(!this.data.reportPeopleGroups.some(g=>g.id===id))return;this.setData({reportPeopleGroupId:id});this.updateReportPeopleView();},
  searchReportPeople(event){this.setData({reportPeopleQuery:event.detail.value});this.updateReportPeopleView();},
  selectReportPerson(event){if(this.data.reportSaving)return;const person=this.data.reportPeopleAll.find(p=>p.operatorId===Number(event.currentTarget.dataset.id));if(person)this.setData({reportEditForm:{...this.data.reportEditForm,operatorId:person.operatorId,operatorName:person.name},reportPeopleOpen:false});},
  recalculateReportHours(){if(this.data.reportSaving||this.data.reportActionLocked||!this.data.reportEditForm)return;try{this.setData({reportEditForm:require('../../utils/report-editor-model').recalculate(this.data.reportEditForm,this.data.reportEditor.pauses),reportActionError:''});}catch(error){this.setData({reportActionError:error.message});}},
  changeReportDateTime(event){
    if(this.data.reportSaving||this.data.reportActionLocked||!this.data.reportEditForm)return;
    const {part,field}=event.currentTarget.dataset,model=require('../../utils/report-editor-model');
    try{const draft=model.changeTime(this.data.reportEditForm,part,field,event.detail.value);
      try{this.setData({reportEditForm:model.recalculate(draft,this.data.reportEditor.pauses),reportActionError:'',reportTimeInvalid:false});}
      catch(error){this.setData({reportEditForm:draft,reportActionError:error.message,reportTimeInvalid:true});}
    }catch(error){this.setData({reportActionError:error.message});}
  },
  async saveReportEdit() {
    if(this.data.reportSaving||this.data.reportActionLocked||this.data.reportEditorLoading||this.data.reportPeopleOpen||!this.data.reportEditor)return;
    if(this.data.reportEditor.fullSyncReady!==true)return this.setData({reportActionError:'黑湖有效工时写入尚未验证，完整编辑暂不能保存。'});
    try{return this.submitReportChange(this.data.reportEditor,'edit',require('../../utils/report-editor-model').payload(this.data));}catch(error){this.setData({reportActionError:error.message});}
  },
  deleteReport(event) {
    const record=this.data.reportRecords.find(r=>r.id===event.currentTarget.dataset.id);
    if(!record?.canDelete||this.data.reportSaving)return;
    this.setData({reportMenuId:'',reportActionError:''});
    wx.showModal({title:'删除这条报工？',content:`${record.operatorName} · ${record.processName} · ${record.quantity}件。将删除黑湖对应报工，不能恢复；本系统保留操作审计。`,confirmText:'确认删除',confirmColor:'#DC2626',success:result=>{
      if(!result.confirm||this.pageUnloaded)return;
      this.reportOperationKey='leader-report-'+Date.now()+'-'+Math.random().toString(36).slice(2);
      this.submitReportChange(record,'delete',{});
    }});
  },
  async submitReportChange(record,action,data) {
    if(this.data.reportSaving)return;
    const ownerRevision=this.reportActionRevision=(this.reportActionRevision||0)+1;
    this.reportRequestRevision=(this.reportRequestRevision||0)+1;
    this.setData({reportSaving:true,reportLoading:false,reportActionError:''});
    try {
      const result=await request(`/v1/dispatch/reports/${encodeURIComponent(record.id)}/${action}`,{
        method:'POST',idempotencyKey:this.reportOperationKey,data:{expectedVersion:record.version,...data}
      });
      if(this.pageUnloaded||ownerRevision!==this.reportActionRevision)return;
      if(result.status!=='SUCCEEDED'){
        this.setData({reportActionLocked:result.status!=='FAILED'});
        if(result.status==='FAILED')this.reportOperationKey='leader-report-'+Date.now()+'-'+Math.random().toString(36).slice(2);
        throw Object.assign(Error(result.error?.message||'操作结果待核对，请勿重复操作。'),{confirmedFailure:result.status==='FAILED'});
      }
      this.setData({reportEditor:null});wx.showToast({title:action==='delete'?'报工已删除':'报工已修改',icon:'success'});
    }catch(error){if(!this.pageUnloaded&&ownerRevision===this.reportActionRevision){
      const definite=error.confirmedFailure||error.status===422;
      if(error.status===422)this.reportOperationKey='leader-report-'+Date.now()+'-'+Math.random().toString(36).slice(2);
      this.setData({reportActionError:error.message||'结果待确认，请刷新核对。',reportActionLocked:!definite});
    }}
    finally {
      if(!this.pageUnloaded&&ownerRevision===this.reportActionRevision){this.setData({reportSaving:false});if(!this.data.reportEditor)await this.loadReportRecords();}
    }
  },

  openHistory() {
    if (this.data.submitting) return;
    this.setData({ historyOpen: true, sheetOpen: false, reviewOpen: false });
    this.syncRefreshTimer();
    return this.loadHistory();
  },
  closeHistory() {
    if (this.data.cancelling || this.data.reportSaving) return;
    this.reportRequestRevision=(this.reportRequestRevision||0)+1;
    this.historyRevision = (this.historyRevision || 0) + 1;
    this.setData({ historyOpen: false, sheetOpen: false, cancelAssignmentId: "", historyLoading: false,reportMenuId:'',reportEditor:null,reportLoading:false });
    this.syncRefreshTimer();
  },
  async loadHistory() {
    if(this.data.historyTab==='reports')return this.loadReportRecords();
    if (this.historyRequest) return this.historyRequest;
    const revision = this.viewRevision || 0;
    const historyRevision = this.historyRevision || 0;
    const pending = this.fetchHistory();
    this.historyRequest = pending;
    try { return await pending; } finally {
      this.historyRequest = null;
      if (!this.pageUnloaded && this.pageVisible && this.data.historyOpen
        && (revision !== (this.viewRevision || 0) || historyRevision !== (this.historyRevision || 0))) await this.loadHistory();
    }
  },
  async fetchHistory() {
    const revision = this.viewRevision || 0;
    const historyRevision = this.historyRevision || 0;
    const isCurrent = () => !this.pageUnloaded && revision === (this.viewRevision || 0) && historyRevision === (this.historyRevision || 0) && this.data.historyOpen && this.data.historyTab!=='reports';
    this.setData({ historyLoading: true, historyError: "" });
    try {
      const result = await request("/v1/dispatch/history?includeActive=true");
      if (!isCurrent()) return;
      if (!Array.isArray(result.assignments)) throw new Error("分配记录未能确认，请重试。");
      const labels = { READY: "待开始", IN_PROGRESS: "生产中", REPORTING: "报工提交中", QUANTITY_PENDING: "待核量", NEEDS_REVIEW: "报工待核对", COMPLETED: "已完成", CANCELLED: "已撤销" };
      this.setData({
        historyAssignments: result.assignments.map((item) => ({ ...item, statusText: labels[item.status] || item.status,
          isLastDispatch: this.data.lastDispatchIds.includes(item.id),
          actualQuantityText: item.status === "COMPLETED" ? `良品 ${item.goodQuantity} 件 · 不良 ${item.defectQuantity || 0} 件` : "暂未计入产量" })),
        historyDate: result.date || "", historyTotal: result.total ?? result.assignments.length,
        historyTruncated: Boolean(result.truncated), historyLoaded: true
      });
    } catch (error) {
      if (isCurrent()) this.setData({ historyError: error.message || "分配记录加载失败，请重试。" });
    } finally {
      if (isCurrent()) this.setData({ historyLoading: false });
    }
  },
  beginCancelAssignment(event) {
    if (this.data.cancelling) return;
    const id = event.currentTarget.dataset.assignmentId;
    if (!this.data.historyAssignments.some((item) => item.id === id && item.canCancel && item.status === "READY")) return;
    this.setData({ cancelAssignmentId: id });
  },
  dismissCancelAssignment() { if (!this.data.cancelling) this.setData({ cancelAssignmentId: "" }); },
  async cancelReadyAssignment() {
    const id = this.data.cancelAssignmentId;
    if (this.data.cancelling || !id) return;
    this.setData({ cancelling: true });
    this.historyRevision = (this.historyRevision || 0) + 1;
    try {
      await request(`/v1/dispatch/assignments/${encodeURIComponent(id)}/cancel`, { method: "POST", data: {} });
      if (this.pageUnloaded) return;
      this.historyRevision = (this.historyRevision || 0) + 1;
      this.viewRevision = (this.viewRevision || 0) + 1;
      this.setData({ cancelAssignmentId: "" });
      await this.loadHistory();
      await this.loadOverview();
    } catch (error) {
      if (this.pageUnloaded) return;
      wx.showModal({ title: "撤销结果需确认", content: `${error.message} 请刷新记录确认；已开始的任务不能直接撤销。`, showCancel: false });
      await this.loadHistory();
    } finally {
      if (!this.pageUnloaded) this.setData({ cancelling: false });
    }
  },

  onMapScale(event) {
    const scale = Math.max(0.9, Math.min(2.2, Number(event.detail.scale) || 1));
    this.pendingMapScaleText = String(Math.round(scale * 100));
    if (this.mapGestureTimer) clearTimeout(this.mapGestureTimer);
    this.mapGestureTimer = setTimeout(() => {
      const mapScaleText = this.pendingMapScaleText;
      this.pendingMapScaleText = null;
      this.mapGestureTimer = null;
      if (mapScaleText) this.setData({ mapScaleText });
    }, 140);
  },

  resetMap() {
    if (this.mapGestureTimer) clearTimeout(this.mapGestureTimer);
    if (this.mapResetTimer) clearTimeout(this.mapResetTimer);
    this.mapGestureTimer = null;
    this.mapResetTimer = null;
    this.pendingMapScaleText = null;
    this.setData({
      mapGestureReady: false,
      mapScaleText: "100",
      mapAngle: 0
    }, () => {
      this.mapResetTimer = setTimeout(() => {
        this.mapResetTimer = null;
        this.setData({ mapGestureReady: true });
      }, 30);
    });
  },

  logout() {
    wx.showModal({
      title: "要退出登录吗？",
      confirmText: "退出",
      success: async (result) => {
        if (!result.confirm) return;
        try { await request("/v1/auth/logout", { method: "POST" }); } catch {}
        app.clearSession();
        wx.reLaunch({ url: "/pages/login/login" });
      }
    });
  }
});

function reportClock(value) {
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';
  const seconds=Math.max(0,Number(value));
  return String(Math.floor(seconds/3600)).padStart(2,'0')+':'+String(Math.floor(seconds%3600/60)).padStart(2,'0');
}
