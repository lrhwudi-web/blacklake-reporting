const { request } = require("../../utils/api");
const { workTimeBreakdown } = require("../../utils/work-time");
const app = getApp();

Page({
  data: {
    todaySummary:null,summaryLoading:true,summaryCountText:'—',summaryCountKnown:false,summaryHoursText:'—',summaryHoursKnown:false,summaryError:'',summaryNote:'',
    ready: false,
    loadError: "",
    assignmentError: "",
    entry: null,
    operator: null,
    draftOwnerId: "",
    operatorInitial: "",
    reviewMode: false,
    reportingMode: "standard",
    reportingModes: ["standard"],
    canSwitchReportingMode: false,
    cuttingSelfService: false, selfServiceMode: false, selfWorkUnits: [], selfWorkUnitOptions: [], selfWorkUnitIndex: 0,
    selfServiceConfigured: false, selfServiceChecking: false, selfServicePermissionError: '',
    selfWorkUnitId: "", selfStartKey: "", scanError: "", scanning: false,
    skuQuery: "", skuResults: [], skuSearching: false, skuSearchError: "",
    assignment: null,
    assignmentImageUrls: [], assignmentImageStatus: "", assignmentImageOwnerId: "", assignmentImageProjectId: null, assignmentImageProjectCode: "",
    activeAssignments: [], queueAssignments: [], queueEnabled:false,
    addingParallel: false,
    stage: "waiting",
    headline: "扫描工单码",
    subheadline: "",
    elapsedText: "00:00:00",
    totalElapsedText: "00:00:00", lunchText: "00:00:00", pauseText: "00:00:00",
    timerStatus: "计时中", timerResting: false, timerNote: "", timerError: "",
    submitting: false,
    submissionUncertain: false,
    draftNotice: "",
    lastAssignment: null,
    lastDurationText: "",
    previousQuantityNotice: "",
    flowCode: "",
    workOrder: null,
    processes: [],
    selfProcessOverview: [],
    featuredTitle: "",
    featuredProcesses: [],
    showAllProcesses: false,
    selectedProcess: null,
    selfRecommendedTaskId: null,
    selfProcessScrollTarget: "",
    machineId: "",
    machineName: "",
    embroideryParts: ["前幅", "后幅"],
    embroideryPart: "",
    reportQuantity: "",
    reportDefectQuantity: "0",
    reportKeyboardHeight: 0, reportInputFocused: false,
    defectReasons: [],
    reportDefectCodes: [],
    hasDefects: false,
    finishRemainingQuantity: null,
    selectionMode: "station"
  },

  async onLoad(options = {}) {
    if (!app.globalData.sessionToken) return wx.reLaunch({ url: "/pages/login/login" });
    if (this.profileLoading) return;
    this.profileLoading = true;
    this.setData({ loadError: "" });
    try {
      const result = await request("/v1/me");
      if (this.pageUnloaded) return;
      if (result.entry && result.entry.entryView !== "employee-reporting") {
        app.globalData.entry = result.entry;
        wx.setStorageSync("entry", result.entry);
        return wx.reLaunch({ url: "/pages/dispatch/dispatch" });
      }
      app.globalData.operator = result.operator;
      app.globalData.entry = result.entry || { entryView: "employee-reporting", appRole: "employee" };
      app.globalData.reviewMode = Boolean(result.reviewMode);
      const reportingModes = Array.isArray(result.operator.reportingModes)
        ? result.operator.reportingModes
        : ["standard"];
      const explicitStandard=options.legacyMode==='standard'&&reportingModes.includes('standard');
      this.legacyStandard=explicitStandard;
      this.legacyEmbroidery=options.legacyMode==='embroidery'&&reportingModes.includes('embroidery');
      if(this.legacyEmbroidery&&!result.reviewMode)return wx.reLaunch({url:'/workspace/pages/worker/worker?mode=embroidery'});
      if(!explicitStandard&&!this.legacyEmbroidery&&typeof app.homeUrl==='function'&&app.homeUrl().startsWith('/workspace/'))return wx.reLaunch({url:app.homeUrl()});
      const reportingMode = explicitStandard?'standard':this.legacyEmbroidery?'embroidery':reportingModes.includes(result.operator.defaultReportingMode)
        ? result.operator.defaultReportingMode
        : reportingModes[0];
      this.setData({
        ready: true,
        entry: app.globalData.entry,
        operator: result.operator,
        draftOwnerId: typeof result.draftOwnerId === "string" ? result.draftOwnerId : "",
        operatorInitial: result.operator.name.slice(0, 1),
        reviewMode: Boolean(result.reviewMode),
        cuttingSelfService: Boolean(result.selfServiceEnabled),
        selfServiceConfigured: typeof result.selfServiceEnabled === 'boolean',
        reportingModes,
        reportingMode,
        canSwitchReportingMode: reportingModes.includes("standard") && reportingModes.includes("embroidery"),
        headline: "我的报工"
      });
      await this.loadAssignment();
    } catch (error) {
      if (error.status !== 401) this.setData({ loadError: error.message || "暂时无法读取人员信息，请重试。" });
    } finally {
      this.profileLoading = false;
    }
  },

  onShow() {
    this.pageVisible = true;
    if(this.data.ready&&this.data.selfServiceConfigured){return this.refreshSelfServicePermission().then(()=>{if(!this.pageUnloaded&&this.pageVisible)return this.loadAssignment();}).finally(()=>this.syncAssignmentPolling());}
    if (this.data.ready && (["waiting", "working", "finish"].includes(this.data.stage)
      || this.data.stage === "success" && this.data.lastAssignment?.status === "QUANTITY_PENDING")) {
      this.loadAssignment();
    }
    this.syncAssignmentPolling();
  },

  async refreshSelfServicePermission() {
    if(this.data.selfServiceChecking||!this.data.ready)return;
    this.setData({selfServiceChecking:true,selfServicePermissionError:''});
    try{
      const result=await request('/v1/me');if(this.pageUnloaded)return;
      if(typeof result.selfServiceEnabled!=='boolean')throw new Error('未读取到后台自主报工权限');
      const enabled=result.selfServiceEnabled,values={cuttingSelfService:enabled,selfServiceConfigured:true};
      if(!enabled&&this.data.selfServiceMode&&!this.data.assignment){this.selfFlowRevision=(this.selfFlowRevision||0)+1;Object.assign(values,{selfServiceMode:false,stage:'waiting',selectedProcess:null,flowCode:'',selfStartKey:'',skuResults:[]});}
      if(result.entry?.entryView&&result.entry.entryView!=='employee-reporting'){return wx.reLaunch({url:'/pages/dispatch/dispatch'});}
      if(result.operator&&!this.data.assignment&&!this.data.submitting){values.operator=result.operator;values.reportingModes=result.operator.reportingModes||['standard'];values.reportingMode=this.legacyStandard&&values.reportingModes.includes('standard')?'standard':result.operator.defaultReportingMode||'standard';values.canSwitchReportingMode=values.reportingModes.includes('standard')&&values.reportingModes.includes('embroidery');}
      this.setData(values);
      if(this.legacyEmbroidery&&values.reportingModes?.includes('embroidery'))this.setData({reportingMode:'embroidery'});
    }catch(error){if(!this.pageUnloaded)this.setData({selfServicePermissionError:error.message||'暂时无法核对自主报工权限，请重试。'});}
    finally{if(!this.pageUnloaded)this.setData({selfServiceChecking:false});}
  },

  onHide() { this.saveReportDraft(); this.setData({reportKeyboardHeight:0,reportInputFocused:false}); this.pageVisible = false; this.stopAssignmentPolling(); this.stopTimer(); },

  onUnload() { this.saveReportDraft(); this.pageVisible = false; this.pageUnloaded = true; this.selfFlowRevision=(this.selfFlowRevision||0)+1; this.stopAssignmentPolling(); this.stopTimer(); },

  retryLoad() { return this.onLoad(); },

  stopAssignmentPolling() {
    if (this.assignmentPollTimer) clearInterval(this.assignmentPollTimer);
    this.assignmentPollTimer = null;
  },

  syncAssignmentPolling() {
    const waitingForNext = this.data.stage === "waiting"
      || this.data.stage === "success" && this.data.lastAssignment?.status === "QUANTITY_PENDING";
    const watchingQueue=this.data.queueEnabled&&['working','finish','success'].includes(this.data.stage);
    if (!this.pageVisible || !this.data.ready || !waitingForNext && !watchingQueue && !this.pendingQuantityRecovery) {
      this.stopAssignmentPolling();
      return;
    }
    if (!this.assignmentPollTimer) {
      this.assignmentPollTimer = setInterval(() => this.data.submitting ? undefined : this.loadAssignment({ silent: true }), 10000);
    }
  },

  async loadAssignment({ silent = false } = {}) {
    if (this.assignmentLoading) return this.assignmentLoading;
    const pending = this.fetchAssignment({ silent });
    this.assignmentLoading = pending;
    try { return await pending; } finally { this.assignmentLoading = null; }
  },

  async fetchAssignment({ silent = false } = {}) {
    const revision = this.assignmentRevision || 0;
    try {
      const result = await request("/v1/assignments/current", { showLoading: !silent && !this.data.assignment && this.data.stage !== "waiting" });
      if (this.pageUnloaded || revision !== (this.assignmentRevision || 0)) return false;
      if (!result || (!Array.isArray(result.assignments) && !("assignment" in result))) throw new Error("任务状态未能确认，请重试。");
      this.syncTimerClock(result.serverTime);
      this.setData({timerError:''});
      this.updateTodaySummary(result.todaySummary,result.todaySummaryError);
      if (this.data.assignmentError) this.setData({ assignmentError: "" });
      const rawAssignments = Array.isArray(result.assignments)
        ? result.assignments
        : (result.assignment ? [result.assignment] : []);
      if(this.legacyStandard&&rawAssignments.some(item=>item.machineId))return wx.reLaunch({url:'/workspace/pages/worker/worker?mode=embroidery'});
      if(typeof result.queueEnabled==='boolean')this.setData({queueEnabled:result.queueEnabled});
      const quantityReceipt = rawAssignments.find((item) => item.status === "QUANTITY_PENDING"
        && (!this.data.assignment || item.id === this.data.assignment.id || item.id === this.pendingQuantityRecovery?.id));
      const operation = this.assignmentSubmission;
      if (operation?.kind === "quantity-finish"
        && !rawAssignments.some((item) => item.id === operation.assignment.id && item.status !== "QUANTITY_PENDING")) {
        // current 已确认旧单不再占用人员；其慢响应不能继续锁住新任务。
        if (!this.pendingQuantityRecovery) this.pendingQuantityRecovery = operation.assignment;
        this.assignmentSubmission = null;
        this.setData({ submitting: false });
      }
      const recovering = this.pendingQuantityRecovery;
      if (recovering) {
        const current = rawAssignments.find((item) => item.id === recovering.id);
        if (current) {
          this.pendingQuantityRecovery = null;
          if (current.status !== "QUANTITY_PENDING") this.setData({ previousQuantityNotice: "" });
        }
        if (this.pendingQuantityRecovery) this.setData({ previousQuantityNotice: "上一单登记结果待确认，请刷新或查看最近记录。" });
      }
      const activeAssignments = rawAssignments.filter((item) => item.status !== "QUANTITY_PENDING").map((item) => this.decorateAssignment(item));
      const sequential=activeAssignments.some(item=>!item.machineId);
      const primary=sequential?activeAssignments[0]:(activeAssignments.find(item=>item.id===this.data.assignment?.id)||activeAssignments.find(item=>item.id===result.assignment?.id)||activeAssignments[0]);
      this.setData({queueAssignments:activeAssignments.filter(item=>item.status==='READY'&&item.isDispatched&&!item.machineId&&item.id!==primary?.id)});
      this.reconcileReportDrafts(activeAssignments);
      this.setData({ submissionUncertain: Boolean(this.pendingQuantityRecovery
        && activeAssignments.some((item) => item.id === this.pendingQuantityRecovery.id)) });
      if (this.data.stage === "success" && this.data.lastAssignment?.status !== "QUANTITY_PENDING" && !quantityReceipt) {
        this.setData({ activeAssignments });
        return;
      }
      if (this.data.stage === "success" && !activeAssignments.length && !quantityReceipt) return true;
      if (this.data.addingParallel && this.data.stage === "scan" && activeAssignments.length) {
        this.setData({ activeAssignments });
        this.stopTimer();
        return;
      }
      const assignment = primary || null;
      if (assignment) {
        const finishing = this.data.stage === "finish" && assignment.id === this.data.assignment?.id
          && assignment.attemptNumber === this.data.assignment?.attemptNumber && assignment.status === "IN_PROGRESS";
        this.setData({
          assignment,
          activeAssignments,
          addingParallel: false,
          stage: finishing ? "finish" : "working",
          headline: finishing ? (this.data.submitting ? "正在提交报工" : "确认报工数量") : assignmentHeadline(assignment),
          subheadline: "",
          draftNotice: this.draftReadError || (finishing ? this.data.draftNotice : ""),
          reportQuantity: finishing ? this.data.reportQuantity : String(assignment.goodQuantity ?? assignment.quantity),
          reportDefectQuantity: finishing ? this.data.reportDefectQuantity : String(assignment.defectQuantity || 0),
          reportDefectCodes: finishing ? this.data.reportDefectCodes : (assignment.defectCodes || (assignment.defectCode ? [assignment.defectCode] : [])),
          hasDefects: finishing ? this.data.hasDefects : Number(assignment.defectQuantity || 0) > 0,
          finishRemainingQuantity: finishing ? this.data.finishRemainingQuantity : null
        });
        this.loadAssignmentImage();
      } else if (this.data.selfServiceMode && ['scan','select','confirm-start'].includes(this.data.stage)) {
        this.setData({activeAssignments:[]});
      } else if (!["success"].includes(this.data.stage)) {
        this.setData({
          assignment: null,
          activeAssignments: [],
          addingParallel: false,
          stage: "waiting",
          defectReasons: [],
          reportDefectCodes: [],
          hasDefects: false,
          finishRemainingQuantity: null,
          draftNotice: "",
          headline: this.data.cuttingSelfService ? "自主开工" : "等待分配",
          subheadline: ""
        });
      }
      if (assignment?.status === "IN_PROGRESS") this.startTimer(); else this.stopTimer();
      if (quantityReceipt) this.completeQuantityPending(quantityReceipt);
      return true;
    } catch (error) {
      if (this.pageUnloaded || revision !== (this.assignmentRevision || 0)) return false;
      this.failTodaySummary('今日统计暂未更新，请重试。');
      this.setData({ assignmentError: error.message || "暂时无法读取任务，请重试。" });
      if (!silent) wx.showToast({ title: this.data.assignmentError, icon: "none" });
      return false;
    } finally {
      // 先让 current 的任务可操作，旧单详情独立恢复，不占用页面加载或提交锁。
      if (!this.pageUnloaded && this.pendingQuantityRecovery) this.recoverQuantityPending(this.pendingQuantityRecovery);
      this.syncAssignmentPolling();
    }
  },

  updateTodaySummary(summary,errorText) {
    if(!summary||errorText)return this.failTodaySummary(errorText||(this.data.reviewMode?'体验模式不显示个人统计。':'暂未取得今日统计，请重试。'));
    const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(summary.date||'')||!nonnegative(summary.completedCount)
      ||!(summary.workSeconds===null||nonnegative(summary.workSeconds))
      ||!nonnegative(summary.quantityPendingCount)||!nonnegative(summary.resultPendingCount)||!nonnegative(summary.unknownDurationCount)||!nonnegative(summary.undatedCount))return this.failTodaySummary('统计结果未能确认，请重试。');
    const notes=[];
    if(summary.quantityPendingCount)notes.push(summary.quantityPendingCount+'单完工待核量');
    if(summary.resultPendingCount)notes.push(summary.resultPendingCount+'单结果待核对');
    if(summary.unknownDurationCount)notes.push('部分工时待核实');
    if(summary.undatedCount)notes.push('有任务结束日期待核实');
    this.setData({todaySummary:summary,summaryLoading:false,summaryCountText:summary.undatedCount?'待核实':String(summary.completedCount),summaryCountKnown:summary.undatedCount===0,
      summaryHoursText:summary.workSeconds===null?'待核实':(summary.workSeconds/3600).toFixed(1),summaryHoursKnown:summary.workSeconds!==null,summaryError:'',summaryNote:notes.join(' · ')});
  },

  failTodaySummary(message) {
    const localDate=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const cached=this.data.todaySummary?.date===localDate;
    this.setData({summaryLoading:false,summaryError:cached?'统计更新失败，显示上次数据。':message,
      ...(!cached?{todaySummary:null,summaryCountText:'—',summaryCountKnown:false,summaryHoursText:'—',summaryHoursKnown:false,summaryNote:''}:{})});
  },

  recoverQuantityPending(assignment) {
    if (this.quantityRecoveryRequest?.assignment === assignment) return this.quantityRecoveryRequest.promise;
    const recovery = { assignment };
    this.quantityRecoveryRequest = recovery;
    recovery.promise = (async () => {
      try {
        const { assignment: detail } = await request(`/v1/assignments/${encodeURIComponent(assignment.id)}`);
        if (this.pageUnloaded || this.pendingQuantityRecovery !== assignment) return;
        if (!detail || detail.id !== assignment.id) throw new Error("上一单登记结果尚未确认");
        if (detail.status === "QUANTITY_PENDING") this.completeQuantityPending(detail);
        else if (["COMPLETED", "CANCELLED"].includes(detail.status)) {
          this.pendingQuantityRecovery = null;
          this.setData({ previousQuantityNotice: "上一单状态已更新，请在最近记录查看。" });
        }
      } catch {
        if (!this.pageUnloaded && this.pendingQuantityRecovery === assignment) {
          this.setData({ previousQuantityNotice: "上一单登记结果待确认，请刷新或查看最近记录。" });
        }
      } finally {
        if (this.quantityRecoveryRequest === recovery) this.quantityRecoveryRequest = null;
        if (!this.pageUnloaded) this.syncAssignmentPolling();
      }
    })();
    return recovery.promise;
  },

  completeQuantityPending(assignment) {
    if (this.pageUnloaded) return;
    if (this.pendingQuantityRecovery?.id === assignment.id) this.pendingQuantityRecovery = null;
    this.removeReportDraft(assignment.id);
    const activeAssignments = this.data.activeAssignments.filter((item) => item.id !== assignment.id && item.status !== "QUANTITY_PENDING");
    const current = this.data.assignment;
    const nextAssignment = activeAssignments.find((item) => item.id === current?.id) || activeAssignments[0] || null;
    const values = {
      activeAssignments,
      lastAssignment: assignment,
      lastDurationText: this.formatDuration(assignment.durationSeconds || 0),
      previousQuantityNotice: "已登记完工，数量待核对，可继续接单"
    };
    if (current && current.id !== assignment.id) {
      // 回执只归属旧单，不能改新单的阶段、计时或结果不确定标记。
      this.setData(values);
      this.syncAssignmentPolling();
      return;
    }
    this.assignmentRevision = (this.assignmentRevision || 0) + 1;
    values.submissionUncertain = false;
    if (!nextAssignment) {
      this.stopTimer();
      Object.assign(values, {
        assignment: null, stage: "success", headline: "完工已登记", subheadline: "",
        draftNotice: "", finishRemainingQuantity: null
      });
    } else if (current?.id !== nextAssignment.id) {
      Object.assign(values, { assignment: nextAssignment, stage: "working", headline: assignmentHeadline(nextAssignment), subheadline: "" });
    }
    this.setData(values);
    this.loadAssignmentImage();
    if (nextAssignment?.status === "IN_PROGRESS") this.startTimer();
    this.syncAssignmentPolling();
  },

  decorateAssignment(assignment) {
    const machineText = assignment.isEmbroidery && assignment.machineId
      ? `${assignment.machineId} 号机${assignment.embroideryPart ? ` · ${assignment.embroideryPart}` : ""}`
      : "绣花任务";
    return { ...assignment, machineText };
  },

  async loadAssignmentImage(force = false) {
    const assignment = this.data.assignment;
    const key = assignment?.id && assignment.projectId && assignment.projectCode
      ? JSON.stringify([assignment.id, assignment.projectId, assignment.projectCode]) : "";
    if (!force && key === this.assignmentImageKey) return;
    this.assignmentImageKey = key;
    const revision = this.assignmentImageRevision = (this.assignmentImageRevision || 0) + 1;
    this.setData({ assignmentImageUrls: [], assignmentImageStatus: key ? "loading" : "",
      assignmentImageOwnerId: assignment?.id || "", assignmentImageProjectId: assignment?.projectId || null, assignmentImageProjectCode: assignment?.projectCode || "" });
    if (!key || this.pageUnloaded) return;
    const token = app.globalData.sessionToken;
    const current = () => !this.pageUnloaded && revision === this.assignmentImageRevision
      && token === app.globalData.sessionToken && this.data.assignment?.id === assignment.id
      && this.data.assignment?.projectId === assignment.projectId && this.data.assignment?.projectCode === assignment.projectCode;
    try {
      const result = await request(`/v1/assignments/${encodeURIComponent(assignment.id)}/product-images`);
      if (!current()) return;
      if (result.assignmentId !== assignment.id || result.projectId !== assignment.projectId || result.projectCode !== assignment.projectCode
        || !Array.isArray(result.productImageUrls)) throw new Error("图片对应工单未能确认");
      const urls = [...new Set(result.productImageUrls.filter(url => typeof url === "string" && /^https:\/\//.test(url)))].slice(0, 8);
      this.setData({ assignmentImageUrls: urls, assignmentImageStatus: urls.length ? "ready" : "empty" });
    } catch {
      if (current()) this.setData({ assignmentImageUrls: [], assignmentImageStatus: "error" });
    }
  },

  onAssignmentImageError(event) {
    if (event.currentTarget.dataset.assignmentId === this.data.assignment?.id
      && event.currentTarget.dataset.imageUrl === this.data.assignmentImageUrls[0]) this.setData({ assignmentImageStatus: "error" });
  },

  previewAssignmentImage() {
    if (this.data.assignmentImageStatus !== "ready" || this.data.assignmentImageOwnerId !== this.data.assignment?.id
      || this.data.assignmentImageProjectId !== this.data.assignment?.projectId || this.data.assignmentImageProjectCode !== this.data.assignment?.projectCode) return;
    wx.previewImage({ current: this.data.assignmentImageUrls[0], urls: this.data.assignmentImageUrls,
      fail: () => wx.showToast({ title: "图片暂时无法预览，请稍后重试", icon: "none" }) });
  },

  retryAssignmentImage() { if (this.data.assignmentImageStatus === "error") this.loadAssignmentImage(true); },

  async startAssignedWork() {
    if (this.data.submitting || !this.data.assignment || this.data.assignment.status !== "READY") return;
    const startingAssignment = this.data.assignment;
    const submission = { assignment: startingAssignment, kind: "start" };
    this.assignmentSubmission = submission;
    this.assignmentRevision = (this.assignmentRevision || 0) + 1;
    this.setData({ submitting: true });
    try {
      const result = await request(`/v1/assignments/${encodeURIComponent(this.data.assignment.id)}/start`, {
        method: "POST",
        showLoading: true
      });
      if (this.pageUnloaded || this.data.assignment?.id !== startingAssignment.id) return;
      const assignment = this.decorateAssignment(result.assignment);
      this.setData({
        assignment,
        activeAssignments: this.data.activeAssignments.map((item) => item.id === assignment.id ? assignment : item),
        stage: "working",
        headline: "正在生产",
        subheadline: ""
      });
      this.loadAssignmentImage();
      this.startTimer();
      wx.vibrateShort({ type: "medium" });
    } catch (error) {
      if (this.pageUnloaded) return;
      wx.showModal({ title: "暂时不能开始", content: error.message, showCancel: false });
      await this.loadAssignment();
    } finally {
      if (this.assignmentSubmission === submission) {
        this.assignmentSubmission = null;
        if (!this.pageUnloaded) this.setData({ submitting: false });
      }
    }
  },

  selectActiveAssignment(event) {
    if (this.data.submitting || this.data.submissionUncertain) return;
    const assignment = this.data.activeAssignments.find((item) => item.id === event.currentTarget.dataset.assignmentId);
    if (!assignment) return;
    if(!assignment.machineId&&assignment.id!==this.data.activeAssignments[0]?.id)return wx.showToast({title:'请按顺序完成当前任务',icon:'none'});
    this.saveReportDraft();
    this.assignmentRevision = (this.assignmentRevision || 0) + 1;
    this.setData({ assignment, addingParallel: false, stage: "working", headline: assignmentHeadline(assignment), subheadline: "", draftNotice: "" });
    this.loadAssignmentImage();
    if (assignment.status === "IN_PROGRESS") this.startTimer(); else this.stopTimer();
  },

  startAnotherEmbroidery() {
    if(!this.data.cuttingSelfService||this.data.selfServiceChecking||this.data.selfServicePermissionError)return;
    if (!this.data.assignment?.isEmbroidery || this.data.submitting || this.data.submissionUncertain) return;
    this.stopTimer();
    this.setData({
      assignment: null,
      addingParallel: true,
      reportingMode: "embroidery",
      stage: "scan",
      flowCode: "",
      workOrder: null,
      processes: [],
      selectedProcess: null,
      machineId: "",
      machineName: "",
      embroideryPart: "",
      headline: "再开一台绣花机",
      subheadline: "扫描下一张工单和机器码；已有机台继续计时"
    });
  },

  cancelParallelSetup() {
    const assignment = this.data.activeAssignments[0];
    if (!assignment) return this.restartScan();
    this.setData({ assignment, addingParallel: false, stage: "working", headline: assignmentHeadline(assignment), subheadline: "" });
    if (assignment.status === "IN_PROGRESS") this.startTimer();
  },

  scanFlowCode() {
    if (this.pageUnloaded || this.data.submitting || this.data.scanning) return;
    this.setData({scanning:true,scanError:''});
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ["qrCode", "barCode"],
      success: (result) => {
        if(this.pageUnloaded)return;
        this.setData({scanning:false});
        const code=String(result.result||'').trim();
        if(!code)return this.setData({scanError:'未识别到工单，请重试或输入 SKU。'});
        return this.loadFlowOptions(code);
      },
      fail: (error) => { if(!this.pageUnloaded)this.setData({scanning:false,scanError:/cancel/i.test(error.errMsg||'')?'已取消扫码，可重新扫描。':'扫码未完成，请重试或输入 SKU。'}); }
    });
  },

  openSelfWork() {
    if(!this.data.cuttingSelfService||this.data.selfServiceChecking||this.data.selfServicePermissionError||this.data.submitting||this.data.activeAssignments.length||this.data.submissionUncertain)return false;
    this.assignmentRevision=(this.assignmentRevision||0)+1;
    this.setData({selfServiceMode:true,stage:'scan',reportingMode:this.legacyStandard?'standard':this.data.operator?.defaultReportingMode||this.data.reportingMode||'standard',selectionMode:'manual',headline:'自主开工',subheadline:'',scanError:''});
    this.syncAssignmentPolling();return true;
  },
  scanSelfWork() { if(this.openSelfWork())this.scanFlowCode(); },
  onSkuInput(event) { this.selfSearchRevision=(this.selfSearchRevision||0)+1;this.setData({skuQuery:event.detail.value,skuResults:[],skuSearchError:''}); },
  async searchSkuWorkOrders() {
    if(!this.data.cuttingSelfService||this.data.selfServiceChecking||this.data.selfServicePermissionError||this.data.submitting||this.data.skuSearching)return;
    const sku=String(this.data.skuQuery||'').normalize('NFKC').trim();
    if(!sku)return this.setData({skuSearchError:'请输入 SKU。'});
    const sequence=this.selfSearchRevision=(this.selfSearchRevision||0)+1;
    this.setData({skuSearching:true,skuSearchError:'',skuResults:[]});
    try{const result=await request('/v1/flow/work-orders/search',{method:'POST',data:{sku},timeout:60000});
      if(this.pageUnloaded||sequence!==this.selfSearchRevision)return;
      const skuResults=(result.workOrders||[]).map(row=>({...row,productImageUrls:Array.isArray(row.productImageUrls)?row.productImageUrls:[],imageFailed:false}));
      this.setData({skuResults,skuSearchError:skuResults.length?'':'未找到对应工单，请核对 SKU。'});
    }catch(error){if(!this.pageUnloaded&&sequence===this.selfSearchRevision)this.setData({skuSearchError:error.message||'查询失败，请重试。'});}
    finally{if(!this.pageUnloaded)this.setData({skuSearching:false});}
  },
  onSkuImageError(event) {
    const {projectId,imageUrl}=event.currentTarget.dataset;
    if(this.pageUnloaded)return;
    this.setData({skuResults:this.data.skuResults.map(row=>row.projectId===Number(projectId)&&row.productImageUrls[0]===imageUrl?{...row,imageFailed:true}:row)});
  },
  previewSkuImage(event) {
    const {projectId,imageUrl}=event.currentTarget.dataset;
    const row=this.data.skuResults.find(item=>item.projectId===Number(projectId));
    if(!row||row.imageFailed||!imageUrl||row.productImageUrls[0]!==imageUrl||this.data.submitting)return;
    wx.previewImage({current:imageUrl,urls:row.productImageUrls,fail:()=>wx.showToast({title:'图片暂时无法预览，请稍后重试',icon:'none'})});
  },
  selectSkuWorkOrder(event) {
    const projectId=Number(event.currentTarget.dataset.projectId);
    if(this.data.skuSearching||!this.data.skuResults.some(row=>row.projectId===projectId)||!this.openSelfWork())return;
    return this.loadFlowOptions('projectId='+projectId);
  },
  chooseSelfWorkUnit(event) {
    const index=Number(event.detail.value);this.setData({selfWorkUnitIndex:index,selfWorkUnitId:this.data.selfWorkUnits[index-1]||'',selfStartKey:''});
  },
  openMyMenu(){wx.showActionSheet({itemList:['退出登录'],success:result=>{if(result.tapIndex===0)this.logout();}});},
  returnToTasks(){if(this.data.submitting)return;this.selfFlowRevision=(this.selfFlowRevision||0)+1;this.setData({selfServiceMode:false,stage:'waiting',headline:'我的报工'});void this.loadAssignment();},

  async loadFlowOptions(flowCode) {
    const revision=this.selfFlowRevision=(this.selfFlowRevision||0)+1;
    this.setData({ submitting: true });
    try {
      const result = await request("/v1/flow/options", {
        method: "POST", data: { flowCode, reportingMode: this.data.reportingMode,
          ...(this.data.selfServiceMode?{selfService:'employee',includeProgress:true}:{}) }, showLoading: true
      });
      if(this.pageUnloaded||revision!==this.selfFlowRevision)return;
      const processes = result.processes.map((process) => ({
        ...process,
        sequenceText: String(process.sequence || "-").padStart(2, "0")
      }));
      const availableIds = new Set(processes.map(process => process.taskId));
      const selfProcessOverview = (result.processOverview || processes).map(process => ({
        ...process, sequenceText: String(process.sequence || "-").padStart(2, "0"),
        selectable: availableIds.has(process.taskId) && process.closed !== true && process.selectable !== false,
        percentLabel: typeof process.percentLabel === 'string' ? process.percentLabel : '—',
        statusLabel: process.statusLabel || '进度未确认'
      }));
      const featuredIds = new Set((result.featuredProcesses || result.favoriteProcesses || []).map((process) => process.taskId));
      const selfService = this.data.selfServiceMode;
      const stationMode = !selfService && this.data.selectionMode === "station";
      const recommendedProcess = result.recommendedProcess
        ? processes.find((process) => process.taskId === result.recommendedProcess.taskId)
        : null;
      const evidence = result.recommendationEvidence;
      const recommendationText = this.data.selfServiceMode ? (recommendedProcess?'历史建议，可修改':'') : recommendedProcess && evidence
        ? `根据今年 ${evidence.reportCount} 条历史报工，匹配度 ${Math.round(evidence.confidence * 100)}%`
        : "";
      const embroideryProcess = result.embroideryProcess
        ? processes.find((process) => process.taskId === result.embroideryProcess.taskId)
        : null;
      this.setData({
        stage: embroideryProcess ? "scan-machine" : (selfService ? "select" : (recommendedProcess ? "confirm-start" : "select")),
        flowCode,
        workOrder: result.workOrder,
        processes,
        selfProcessOverview,
        featuredTitle: result.featuredTitle || "前两道未完成工序",
        featuredProcesses: processes.filter((process) => featuredIds.has(process.taskId)),
        showAllProcesses: selfService || featuredIds.size === 0,
        selectedProcess: embroideryProcess || recommendedProcess,
        selfRecommendedTaskId: selfService ? (recommendedProcess?.taskId || null) : null,
        selfProcessScrollTarget: selfService && recommendedProcess ? `self-process-${recommendedProcess.taskId}` : "",
        selfWorkUnits:result.selfWorkUnits||[], selfWorkUnitOptions:['请选择工位',...(result.selfWorkUnits||[])], selfWorkUnitIndex:0,
        selfWorkUnitId:result.selfWorkUnits?.length===1?result.selfWorkUnits[0]:'',selfStartKey:'',
        machineId: "",
        machineName: "",
        embroideryPart: "",
        headline: embroideryProcess ? "扫描机器码" : selfService ? "选择工序" : (recommendedProcess ? "系统已判断工序" : (stationMode ? "扫描工序码" : "你现在做哪一道？")),
        subheadline: embroideryProcess ? "确认工单后，扫描当前操作的绣花机" : selfService ? "" : recommendationText
      });
    } catch (error) {
      if(!this.pageUnloaded&&revision===this.selfFlowRevision)wx.showModal({ title: "无法读取工序", content: error.message, showCancel: false });
    } finally {
      if(!this.pageUnloaded&&revision===this.selfFlowRevision)this.setData({ submitting: false });
    }
  },

  chooseProcess(event) {
    if (this.data.submitting) return;
    const taskId = Number(event.currentTarget.dataset.taskId);
    const selectedProcess = this.data.processes.find((process) => process.taskId === taskId);
    if (!selectedProcess) return;
    if (this.data.selfServiceMode && !this.data.selfProcessOverview.some(process => process.taskId === taskId && process.selectable)) return;
    this.setData({
      stage: this.data.selfServiceMode ? "select" : "confirm-start",
      selectedProcess,
      selfStartKey:'',
      headline: this.data.selfServiceMode ? "选择工序" : "确认工序",
      subheadline: ""
    });
  },

  showAllProcesses() { this.setData({ showAllProcesses: true }); },

  setReportingMode(event) {
    if (this.data.submitting || this.data.activeAssignments.length || this.data.addingParallel) return;
    const reportingMode = String(event.currentTarget.dataset.mode || "");
    if (!this.data.reportingModes.includes(reportingMode) || reportingMode === this.data.reportingMode) return;
    this.stopTimer();
    this.setData({
      reportingMode,
      stage: "scan",
      flowCode: "",
      workOrder: null,
      processes: [],
      featuredProcesses: [],
      selectedProcess: null,
      machineId: "",
      machineName: "",
      embroideryPart: "",
      showAllProcesses: false,
      headline: scanHeadline(reportingMode),
      subheadline: ""
    });
    wx.vibrateShort({ type: "light" });
  },

  setSelectionMode(event) {
    if (this.data.selfServiceMode) return;
    const selectionMode = event.currentTarget.dataset.mode;
    if (!["manual", "station"].includes(selectionMode)) return;
    const stationMode = selectionMode === "station";
    this.setData({
      selectionMode,
      showAllProcesses: false,
      headline: stationMode ? "扫描工序码" : "选择工序",
      subheadline: ""
    });
  },

  scanStationProcessCode() {
    if (this.data.submitting || !this.data.flowCode) return;
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ["qrCode", "barCode"],
      success: (result) => this.resolveStationProcessCode(result.result)
    });
  },

  async resolveStationProcessCode(processCode) {
    this.setData({ submitting: true });
    try {
      const result = await request("/v1/flow/process-code", {
        method: "POST",
        data: { flowCode: this.data.flowCode, processCode, reportingMode: this.data.reportingMode },
        showLoading: true
      });
      const selectedProcess = {
        ...result.process,
        sequenceText: String(result.process.sequence || "-").padStart(2, "0")
      };
      this.setData({
        stage: "confirm-start",
        selectedProcess,
        headline: "工序码已识别",
        subheadline: ""
      });
      wx.vibrateShort({ type: "medium" });
    } catch (error) {
      wx.showModal({
        title: "无法识别工序码",
        content: error.message,
        showCancel: false,
        confirmText: "重新扫描"
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  scanEmbroideryMachineCode() {
    if (this.data.submitting || !this.data.flowCode || !this.data.selectedProcess) return;
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ["qrCode", "barCode"],
      success: (result) => this.resolveEmbroideryMachineCode(result.result)
    });
  },

  async resolveEmbroideryMachineCode(machineCode) {
    this.setData({ submitting: true });
    try {
      const result = await request("/v1/flow/embroidery-machine", {
        method: "POST",
        data: {
          flowCode: this.data.flowCode,
          taskId: this.data.selectedProcess.taskId,
          machineCode
        },
        showLoading: true
      });
      this.setData({
        stage: "select-embroidery-part",
        machineId: result.machine.id,
        machineName: result.machine.name,
        embroideryParts: result.parts || ["前幅", "后幅"],
        embroideryPart: "",
        headline: "选择绣花部位",
        subheadline: `${result.machine.name} · 请选择前幅或后幅`
      });
      wx.vibrateShort({ type: "medium" });
    } catch (error) {
      wx.showModal({
        title: "无法使用这台机器",
        content: error.message,
        showCancel: false,
        confirmText: "重新扫描"
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  chooseEmbroideryPart(event) {
    const embroideryPart = String(event.currentTarget.dataset.part || "");
    if (!this.data.embroideryParts.includes(embroideryPart)) return;
    this.setData({
      stage: "confirm-start",
      embroideryPart,
      headline: "确认开工",
      subheadline: ""
    });
    wx.vibrateShort({ type: "light" });
  },

  cancelProcessChoice() {
    if (this.data.machineId) {
      this.setData({
        stage: "select-embroidery-part",
        embroideryPart: "",
        headline: "选择绣花部位",
        subheadline: `${this.data.machineName} · 请选择前幅或后幅`
      });
      return;
    }
    const stationMode = !this.data.selfServiceMode && this.data.selectionMode === "station";
    this.setData({
      stage: "select",
      selfProcessScrollTarget: this.data.selfServiceMode && this.data.selectedProcess ? `self-process-${this.data.selectedProcess.taskId}` : "",
      selectedProcess: null,
      machineId: "",
      machineName: "",
      embroideryPart: "",
      headline: stationMode ? "扫描工序码" : "选择工序",
      subheadline: ""
    });
  },

  restartScan() {
    this.setData({
      stage: "scan",
      flowCode: "",
      workOrder: null,
      processes: [],
      featuredTitle: "",
      featuredProcesses: [],
      selectedProcess: null,
      showAllProcesses: false,
      selfRecommendedTaskId: null,
      selfProcessScrollTarget: "",
      defectReasons: [],
      reportDefectCodes: [],
      hasDefects: false,
      headline: scanHeadline(this.data.reportingMode),
      subheadline: ""
    });
  },

  async startSelectedProcess() {
    if (this.data.submitting || !this.data.selectedProcess) return;
    if(this.data.selfServiceMode&&(this.data.selfServiceChecking||this.data.selfServicePermissionError||!this.data.cuttingSelfService))return wx.showToast({title:'请先核对后台开工权限',icon:'none'});
    if(this.data.selfServiceMode&&this.data.selfWorkUnits.length>1&&!this.data.selfWorkUnitId)return wx.showToast({title:'请选择本次工位',icon:'none'});
    this.setData({ submitting: true });
    if(this.data.selfServiceMode&&!this.data.selfStartKey)this.setData({selfStartKey:'cut-'+Date.now()+'-'+Math.random().toString(36).slice(2)});
    try {
      const result = await request("/v1/flow/start", {
        method: "POST",
        data: {
          flowCode: this.data.flowCode,
          taskId: this.data.selectedProcess.taskId,
          reportingMode: this.data.reportingMode,
          ...(this.data.selfServiceMode?{selfService:'employee',workUnitId:this.data.selfWorkUnitId}:{}),
          ...(this.data.machineId ? {
            machineId: this.data.machineId,
            embroideryPart: this.data.embroideryPart
          } : {})
        },
        showLoading: true,
        ...(this.data.selfServiceMode?{idempotencyKey:this.data.selfStartKey}:{})
      });
      if(this.pageUnloaded)return;
      const assignment = this.decorateAssignment(result.assignment);
      this.setData({
        assignment,
        activeAssignments: [...this.data.activeAssignments.filter((item) => item.id !== result.assignment.id), assignment],
        addingParallel: false,
        stage: "working",
        reportQuantity: String(result.assignment.quantity),
        reportDefectQuantity: "0",
        defectReasons: [],
        reportDefectCodes: [],
        hasDefects: false,
        finishRemainingQuantity: null,
        headline: "正在生产",
        subheadline: ""
      });
      this.loadAssignmentImage();
      this.startTimer();
      wx.vibrateShort({ type: "medium" });
    } catch (error) {
      wx.showModal({
        title: "无法开始这道工序",
        content: error.message,
        showCancel: false,
        success: () => this.data.selfServiceMode ? this.loadAssignment() : this.loadFlowOptions(this.data.flowCode)
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async confirmFinish() {
    if (this.data.submitting || this.data.submissionUncertain || this.data.timerError || this.data.assignment?.status !== "IN_PROGRESS") return;
    if (this.data.assignment.isDispatched && this.data.assignment.machineId && !this.data.assignment.isQualityInspection) {
      return this.finishWork({ managedQuantity: Number(this.data.assignment.goodQuantity ?? this.data.assignment.quantity) });
    }
    this.setData({ submitting: true });
    const assignment = this.data.assignment;
    this.assignmentRevision = (this.assignmentRevision || 0) + 1;
    try {
      const result = await request(
        `/v1/assignments/${encodeURIComponent(this.data.assignment.id)}/finish-default`,
        { showLoading: true }
      );
      if (this.pageUnloaded || this.data.assignment?.id !== assignment.id
        || this.data.assignment.attemptNumber !== assignment.attemptNumber || this.data.assignment.status !== "IN_PROGRESS") return;
      // finish-default 在服务端验证本任务仍可报工后，才允许应用本机草稿。
      const draft = this.readReportDraft(assignment);
      const validCodes = new Set((result.defectReasons || []).map((reason) => reason.code));
      const selectedCodes = draft ? draft.defectCodes : (result.defectCodes || (result.defectCode ? [result.defectCode] : []));
      const reportDefectCodes = assignment.isQualityInspection ? selectedCodes.filter((code) => validCodes.has(code)) : [];
      const reportDefectQuantity = assignment.isQualityInspection ? (draft ? draft.defectQuantity : String(assignment.defectQuantity || 0)) : "0";
      this.setData({
        stage: "finish",
        assignment: { ...this.data.assignment, quantityPolicy: result.quantityPolicy || this.data.assignment.quantityPolicy },
        reportQuantity: draft ? draft.quantity : (result.defaultQuantity === null ? "" : String(result.defaultQuantity)),
        reportDefectQuantity,
        defectReasons: decorateDefectReasons(result.defectReasons || [], reportDefectCodes),
        reportDefectCodes,
        hasDefects: Number(reportDefectQuantity || 0) > 0,
        finishRemainingQuantity: result.remainingQuantity,
        headline: "确认报工数量",
        subheadline: "",
        draftNotice: draft ? (selectedCodes.length !== reportDefectCodes.length ? "已恢复数量草稿，不良原因已变化，请重新选择。" : "已恢复本机未提交草稿，请核对数量后再确认。") : (this.draftReadError || "")
      });
    } catch (error) {
      if (this.pageUnloaded) return;
      this.setData({ assignmentError: "暂时无法核对任务状态，请恢复网络后重试。" });
      wx.showToast({ title: "未能核对任务，请重试", icon: "none" });
      if (error.status === 409 || error.status === 404) await this.loadAssignment();
    } finally {
      if (!this.pageUnloaded) this.setData({ submitting: false });
    }
  },

  onQuantityInput(event) {
    if (this.data.submitting) return;
    this.setData({ reportQuantity: String(event.detail.value || "").replace(/\D/g, "") });
    this.saveReportDraft();
  },
  onDefectInput(event) {
    if (this.data.submitting) return;
    const reportDefectQuantity = String(event.detail.value || "").replace(/\D/g, "");
    const hasDefects = Number(reportDefectQuantity || 0) > 0;
    const reportDefectCodes = hasDefects ? this.data.reportDefectCodes.slice(0, Number(reportDefectQuantity)) : [];
    this.setData({
      reportDefectQuantity,
      hasDefects,
      reportDefectCodes,
      defectReasons: decorateDefectReasons(this.data.defectReasons, reportDefectCodes)
    });
    this.saveReportDraft();
  },

  chooseDefectReason(event) {
    if (this.data.submitting) return;
    const code = String(event.currentTarget.dataset.code || "");
    if (!this.data.defectReasons.some((reason) => reason.code === code)) return;
    const selected = this.data.reportDefectCodes || [];
    const reportDefectCodes = selected.includes(code)
      ? selected.filter((item) => item !== code)
      : [...selected, code];
    if (reportDefectCodes.length > Number(this.data.reportDefectQuantity || 0)) {
      return wx.showToast({ title: "原因不能多于不良件数", icon: "none" });
    }
    this.setData({
      reportDefectCodes,
      defectReasons: decorateDefectReasons(this.data.defectReasons, reportDefectCodes)
    });
    this.saveReportDraft();
    wx.vibrateShort({ type: "light" });
  },

  onReportInputFocus(event) {
    this.setData({reportInputFocused:true});
    if (event.detail && event.detail.height !== undefined) this.onReportKeyboardHeightChange(event);
  },
  onReportKeyboardHeightChange(event) {
    const height = Number(event.detail?.height);
    if (!Number.isFinite(height) || height < 0 || (!this.data.reportInputFocused && height > 0)) return;
    this.setData({reportKeyboardHeight:height});
  },
  onReportInputBlur() { this.setData({reportInputFocused:false,reportKeyboardHeight:0}); },

  backToWork() {
    if (this.data.submitting) return;
    this.saveReportDraft();
    this.setData({ stage: "working", reportKeyboardHeight:0, reportInputFocused:false, finishRemainingQuantity: null, headline: assignmentHeadline(this.data.assignment), subheadline: "" });
  },

  async finishWork(options = {}) {
    if (this.data.submitting || this.data.submissionUncertain || this.data.timerError || this.data.assignment?.status !== "IN_PROGRESS") return;
    const quantityPending = this.data.assignment.quantityPolicy === "PENDING_REVIEW";
    const quantity = Number.isSafeInteger(options.managedQuantity)
      ? options.managedQuantity
      : (this.data.reportQuantity === "" ? Number.NaN : Number(this.data.reportQuantity));
    const defectQuantity = this.data.assignment.isQualityInspection ? Number(this.data.reportDefectQuantity || 0) : 0;
    const defectCodes = defectQuantity > 0 ? this.data.reportDefectCodes : [];
    if (!quantityPending && (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(defectQuantity) || defectQuantity < 0 || quantity + defectQuantity <= 0)) {
      return wx.showToast({ title: "请填写正确数量", icon: "none" });
    }
    if (!quantityPending && defectQuantity > 0 && this.data.defectReasons.length === 0) {
      return wx.showToast({ title: "不良原因未配置", icon: "none" });
    }
    if (!quantityPending && defectQuantity > 0 && defectCodes.length === 0) {
      return wx.showToast({ title: "请选择不良原因", icon: "none" });
    }
    this.saveReportDraft();
    const assignment = this.data.assignment;
    const submission = { assignment, kind: quantityPending ? "quantity-finish" : "finish" };
    this.assignmentSubmission = submission;
    this.assignmentRevision = (this.assignmentRevision || 0) + 1;
    this.setData({ submitting: true, headline: quantityPending ? "正在登记完工" : "正在提交报工" });
    // 同一任务始终使用同一提交键。即使结束时断网，重试也不会在黑湖产生第二笔报工。
    const key = `assignment_finish_${this.data.assignment.id.replace(/-/g, "")}_${this.data.assignment.attemptNumber}`;
    try {
      const result = await request(`/v1/assignments/${encodeURIComponent(this.data.assignment.id)}/finish`, {
        method: "POST", data: quantityPending ? { quantityPolicy: "PENDING_REVIEW" } : { quantity, defectQuantity, defectCodes }, idempotencyKey: key
      });
      if (quantityPending && (!result.assignment || result.assignment.id !== assignment.id
        || result.assignment.status !== "QUANTITY_PENDING")) throw new Error("任务登记结果未能确认");
      this.removeReportDraft(assignment.id);
      if (this.pageUnloaded) return;
      if (result.assignment.status === "QUANTITY_PENDING") {
        this.completeQuantityPending(result.assignment);
        wx.vibrateShort({ type: "medium" });
        return;
      }
      if (this.data.assignment && this.data.assignment.id !== assignment.id) return;
      this.stopTimer();
      this.setData({
        stage: "success",
        activeAssignments: this.data.activeAssignments.filter((item) => item.id !== result.assignment.id),
        finishRemainingQuantity: null,
        pendingGroupApproval: result.pendingGroupApproval === true,
        lastAssignment: result.assignment,
        lastDurationText: this.formatDuration(result.assignment.durationSeconds)
      });
      wx.vibrateShort({ type: "medium" });
    } catch (error) {
      if (this.pageUnloaded) return;
      if (error.code === "WORK_ORDER_NOT_FOUND") {
        this.setData({ submitting: false });
        await this.loadAssignment();
        await this.cancelUnavailableAssignment();
        return;
      }
      const unknown = ["REPORT_PENDING", "REPORT_RESULT_UNKNOWN"].includes(error.code);
      const transportUnknown = !error.status && !error.code || Number(error.status) >= 500;
      const taskClosed = error.code === "TASK_CLOSED";
      const uncertainTitle = quantityPending ? "登记结果待确认" : "提交结果待确认";
      if (unknown || transportUnknown) {
        if (quantityPending && (this.data.assignment?.id === assignment.id
          || !this.pendingQuantityRecovery || this.pendingQuantityRecovery.id === assignment.id)) {
          this.pendingQuantityRecovery = assignment;
        }
        if (this.data.assignment?.id === assignment.id || !quantityPending && !this.data.assignment) {
          this.setData({ submissionUncertain: true, stage: "working", headline: uncertainTitle, subheadline: "" });
        } else if (quantityPending) {
          if (this.pendingQuantityRecovery?.id === assignment.id) {
            this.setData({ previousQuantityNotice: "上一单登记结果待确认，请刷新或查看最近记录。" });
          }
          if (!this.data.assignment) this.setData({ stage: "waiting", headline: "等待分配", submissionUncertain: false });
        }
        if (quantityPending && this.data.assignment && this.data.assignment.id !== assignment.id) {
          if (this.pendingQuantityRecovery?.id === assignment.id) this.recoverQuantityPending(this.pendingQuantityRecovery);
          return;
        }
        // 查询失败保持锁定，查询成功后由服务器状态决定是否可以再次操作。
        await this.loadAssignment({ silent: true });
        if (this.pageUnloaded) return;
        if (quantityPending && this.data.assignment?.id !== assignment.id) return;
        if (quantityPending && !this.pendingQuantityRecovery && this.data.lastAssignment?.id === assignment.id
          && this.data.lastAssignment.status === "QUANTITY_PENDING") return;
        if (this.data.submissionUncertain && this.data.assignment?.id === assignment.id) this.setData({ headline: uncertainTitle });
      } else {
        this.setData({ headline: this.data.stage === "finish" ? "确认报工数量" : assignmentHeadline(this.data.assignment) });
      }
      wx.showModal({
        title: quantityPending ? (unknown || transportUnknown ? uncertainTitle : "完工登记失败") : (taskClosed ? "工序已结束" : (unknown ? "需要班组长核对" : (transportUnknown ? uncertainTitle : "结束报工失败"))),
        content: quantityPending && (unknown || transportUnknown) ? "完工登记结果待确认，请恢复网络后刷新任务状态。本次只登记参与时间，不提交产量。" : (transportUnknown ? "未收到明确结果，报工可能已经提交。请恢复网络后刷新任务状态；若显示待核对，请联系班组长。" : error.message),
        showCancel: false,
        success: () => { if (!this.pageUnloaded) this.loadAssignment(); }
      });
    } finally {
      if (this.assignmentSubmission === submission) {
        this.assignmentSubmission = null;
        if (!this.pageUnloaded) this.setData({ submitting: false });
      }
      if (!this.pageUnloaded) this.syncAssignmentPolling();
    }
  },

  async cancelUnavailableAssignment() {
    if (this.data.submitting || !this.data.assignment?.canWorkerCancel) return;
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: "工单已删除",
      content: "黑湖已找不到这张工单。退出后不会提交数量，可以重新扫码报工。",
      confirmText: "退出这单",
      confirmColor: "#b84232",
      cancelText: "先不退出",
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ submitting: true });
    try {
      await request(`/v1/assignments/${encodeURIComponent(this.data.assignment.id)}/cancel`, {
        method: "POST", data: {}, showLoading: true
      });
      this.removeReportDraft(this.data.assignment.id);
      this.stopTimer();
      const remainingAssignments = this.data.activeAssignments.filter((item) => item.id !== this.data.assignment.id);
      const nextAssignment = remainingAssignments[0] || null;
      this.setData({
        assignment: nextAssignment,
        activeAssignments: remainingAssignments,
        stage: nextAssignment ? "working" : "waiting",
        headline: nextAssignment ? assignmentHeadline(nextAssignment) : "等待分配",
        subheadline: "",
        flowCode: "",
        workOrder: null,
        processes: [],
        selectedProcess: null,
        defectReasons: [],
        reportDefectCodes: [],
        hasDefects: false,
        finishRemainingQuantity: null
      });
      if (nextAssignment?.status === "IN_PROGRESS") this.startTimer();
      wx.showToast({ title: "已退出这单", icon: "success" });
    } catch (error) {
      wx.showModal({ title: "暂时不能退出", content: error.message, showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async nextAssignment() {
    if (this.data.submitting) return;
    this.assignmentRevision = (this.assignmentRevision || 0) + 1;
    this.setData({
      stage: "waiting",
      assignment: null,
      defectReasons: [],
      reportDefectCodes: [],
      hasDefects: false,
      finishRemainingQuantity: null,
      headline: "等待分配",
      subheadline: ""
    });
    this.syncAssignmentPolling();
    if (this.assignmentLoading) await this.assignmentLoading;
    if (!this.pageUnloaded) return this.loadAssignment();
  },

  reportDraftKey() {
    const owner = this.data.draftOwnerId;
    return !owner ? "" : `report_drafts_v1:${encodeURIComponent(app.globalData.apiBaseUrl || "")}:${encodeURIComponent(owner)}`;
  },

  readReportDrafts() {
    this.draftReadError = "";
    const key = this.reportDraftKey();
    if (!key) {
      this.draftReadError = "当前服务暂不支持草稿保存，退出前请记下数量。";
      if (!this.pageUnloaded) this.setData({ draftNotice: this.draftReadError });
      return null;
    }
    try {
      const drafts = wx.getStorageSync(key);
      return drafts && typeof drafts === "object" && !Array.isArray(drafts) ? drafts : {};
    } catch {
      this.draftReadError = "本机暂时无法读取草稿，请核对并保留当前数量。";
      if (!this.pageUnloaded) this.setData({ draftNotice: this.draftReadError });
      return null;
    }
  },

  writeReportDrafts(drafts) {
    const key = this.reportDraftKey();
    if (!key || !drafts) return false;
    try { wx.setStorageSync(key, drafts); return true; }
    catch {
      if (!this.pageUnloaded) this.setData({ draftNotice: "本机无法保存草稿，退出前请记下数量；当前页面仍可继续报工。" });
      return false;
    }
  },

  readReportDraft(assignment) {
    const draft = this.readReportDrafts()?.[assignment.id];
    if (!draft || draft.version !== 1 || draft.attemptNumber !== assignment.attemptNumber
      || typeof draft.quantity !== "string" || !/^\d{0,9}$/.test(draft.quantity)
      || typeof draft.defectQuantity !== "string" || !/^\d{0,9}$/.test(draft.defectQuantity)
      || !Array.isArray(draft.defectCodes) || !draft.defectCodes.every((code) => typeof code === "string")) return null;
    return draft;
  },

  saveReportDraft() {
    const assignment = this.data.assignment;
    if (this.data.stage !== "finish" || assignment?.status !== "IN_PROGRESS" || assignment.isDispatched) return;
    const drafts = this.readReportDrafts();
    if (!drafts) return;
    drafts[assignment.id] = {
      version: 1, attemptNumber: assignment.attemptNumber,
      quantity: this.data.reportQuantity, defectQuantity: this.data.reportDefectQuantity,
      defectCodes: [...this.data.reportDefectCodes]
    };
    if (this.writeReportDrafts(drafts) && !this.pageUnloaded) this.setData({ draftNotice: "未提交数量已保存在本机。" });
  },

  removeReportDraft(id) {
    const drafts = this.readReportDrafts();
    if (drafts && Object.prototype.hasOwnProperty.call(drafts, id)) {
      delete drafts[id];
      this.writeReportDrafts(drafts);
    }
  },

  reconcileReportDrafts(assignments) {
    const drafts = this.readReportDrafts();
    if (!drafts) return;
    const active = new Map(assignments.map((item) => [item.id, item]));
    let changed = false;
    for (const id of Object.keys(drafts)) {
      const assignment = active.get(id);
      if (!assignment || !["IN_PROGRESS", "REPORTING", "NEEDS_REVIEW"].includes(assignment.status)
        || drafts[id]?.attemptNumber !== assignment.attemptNumber) {
        delete drafts[id];
        changed = true;
      }
    }
    if (changed) this.writeReportDrafts(drafts);
  },

  startTimer() {
    this.stopTimer();
    this.updateElapsed();
    if (this.pageUnloaded || this.pageVisible === false) return;
    this.timer = setInterval(() => this.updateElapsed(), 1000);
  },
  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; },
  updateElapsed() {
    const started = this.data.assignment?.startedAt;
    if (!started) return;
    if(this.data.timerError){this.setData({elapsedText:'--:--:--',timerStatus:'待确认',timerResting:true,timerNote:'请刷新，确认本次计时状态'});return;}
    const assignment=this.data.assignment;
    const time=workTimeBreakdown(started, assignment.endedAt || (Date.now()+(this.timerClockOffset||0)), assignment.pauses || []);
    if(!Number.isFinite(time.effectiveSeconds)) {
      this.setData({elapsedText:'--:--:--',timerStatus:'时间待核对',timerNote:'任务时间异常，请联系组长核对'});return;
    }
    const paused=assignment.paused&&!assignment.endedAt, lunch=time.lunchActive&&!assignment.endedAt;
    this.setData({ elapsedText: this.formatClock(time.effectiveSeconds), totalElapsedText:this.formatClock(time.elapsedSeconds),
      lunchText:this.formatClock(time.lunchSeconds),pauseText:this.formatClock(time.pauseSeconds),
      timerStatus:paused?'已暂停':lunch?'午休中':'计时中', timerResting:paused||lunch,
      timerNote:paused?'点击继续后累计有效工时':lunch?'13:30 自动继续累计有效工时':'午休 12:00–13:30 自动扣除' });
  },
  syncTimerClock(serverTime) {
    if(!serverTime)return;
    const milliseconds=Date.parse(String(serverTime).replace(' ','T')+'+08:00');
    if(Number.isFinite(milliseconds))this.timerClockOffset=milliseconds-Date.now();
  },
  async toggleTimer() {
    if(this.data.submitting||this.data.submissionUncertain)return;
    if(this.data.timerError){await this.loadAssignment();return;}
    const assignment=this.data.assignment;
    if(!assignment||assignment.status!=='IN_PROGRESS'||assignment.endedAt)return;
    this.assignmentRevision=(this.assignmentRevision||0)+1;
    this.setData({submitting:true,timerError:''});
    try {
      const result=await request(`/v1/assignments/${encodeURIComponent(assignment.id)}/${assignment.paused?'resume':'pause'}`,{
        method:'POST',data:{expectedRevision:assignment.timingRevision||0},
        idempotencyKey:'timer-'+Date.now()+'-'+Math.random().toString(36).slice(2)
      });
      if(this.pageUnloaded||this.data.assignment?.id!==assignment.id)return;
      this.assignmentRevision=(this.assignmentRevision||0)+1;
      this.syncTimerClock(result.serverTime);
      const updated=this.decorateAssignment(result.assignment);
      this.setData({assignment:updated,activeAssignments:this.data.activeAssignments.map(a=>a.id===assignment.id?updated:a)});
      this.updateElapsed();
    } catch(error) {
      if(this.pageUnloaded||this.data.assignment?.id!==assignment.id)return;
      this.setData({timerError:'操作尚未确认，请刷新计时状态。'});
      this.updateElapsed();
      wx.showToast({title:error.message||'请刷新计时状态',icon:'none'});
    } finally { if(!this.pageUnloaded)this.setData({submitting:false}); }
  },
  formatClock(seconds) {
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor(seconds % 3600 / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hours}:${minutes}:${secs}`;
  },
  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const secs = seconds % 60;
    return `${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分钟` : ""}${secs}秒`;
  },
  openRecent() { wx.navigateTo({ url: "/pages/recent/recent" }); },
  logout() {
    wx.showModal({ title: "要退出登录吗？", confirmText: "退出", success: async (result) => {
      if (!result.confirm) return;
      try { await request("/v1/auth/logout", { method: "POST" }); } catch {}
      app.clearSession();
      wx.reLaunch({ url: "/pages/login/login" });
    }});
  }
});

function assignmentHeadline(assignment) {
  if (!assignment) return "等待分配";
  switch (assignment.status) {
    case "READY": return "待开始";
    case "REPORTING": return "正在提交报工";
    case "NEEDS_REVIEW": return "报工待核对";
    case "QUANTITY_PENDING": return "完工待核量";
    case "IN_PROGRESS": return assignment.endedAt ? "报工待提交" : "正在生产";
    default: return "任务状态已更新";
  }
}

function decorateDefectReasons(reasons, selectedCodes) {
  const selected = new Set(selectedCodes || []);
  return (reasons || []).map((reason) => ({ ...reason, selected: selected.has(reason.code) }));
}

function scanHeadline(reportingMode) {
  return reportingMode === "embroidery" ? "绣花机报工" : "扫描工单码";
}
