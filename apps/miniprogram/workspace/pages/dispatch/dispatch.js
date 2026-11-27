const layerBack=require('../../utils/layer-back');
// Detail selections use process -> people -> review; direct entry retains people -> process.
// Local simulation can exercise dispatch; unconnected native sessions keep draft-only behavior.
const api = require('../../utils/api');
const model = require('../../utils/dispatch-model');
const glass = require('../../utils/dispatch-glass');
const segments = require('../../utils/glass-segments');
Page(layerBack.page({
  ...segments.methods,
  data: {
    ...glass.data, ...segments.data, reduceMotion:false, ready: false, stage: 'people', processFirst:false, isFloor3: false, floorName: '8楼', operator: {}, workOrder: {},
    employees: [], units: [], peopleGroups: [], peopleGroupConfig:null,selectedPeopleGroupId:'',departmentIndex: 0, employeeQuery: '', groupEmployees: [],
    selectedEmployeeIds: [], selectedChips: [], peopleGroupAvailableCount: 0, selectedPanelOpen: false,
    manualUnitByEmployee: {}, employeePlacements: [], stationOptions: [], placementsReady: false,
    selectedProcessId: null, selectedProcessName: '待选择工序', processWheelItems: [], processes: [],
    prediction: null, predicting: false, predictionError: '', processScrollTarget: '',
    submitting: false, processWheelMoving: false, reviewOpen: false, placementOnly: false,
    overviewLoaded: false, overviewError: '', selectionWarning: '', notice: '', loadError: '',
    orderOrbOpen: false, orderOrbKeyboardOpen: false, draft: null,
    executionMode:'draft',dispatchPriority:'NORMAL',pausePreview:[],impactLoading:false,impactLoaded:false,impactVersion:null,impactDispatchVersion:null,impactPeople:null,impactBlocked:[],impactReady:false,dispatchError:''
  },
  async onLoad(options = {}) {
    this.dispatchDisposed=false;this.peopleRefreshRevision=0;
    this.setupGlassSegments?.();
    const app = getApp();
    if (app.globalData.entry?.appRole !== 'floor8_leader') { this.setData({ loadError: '当前身份没有组长派工权限。' }); return; }
    const order = app.globalData.dispatchOrder;
    if (!order || String(order.id) !== String(options.projectId)) { this.setData({ loadError: '请从工单列表重新进入派工。' }); return; }
    this.setupDispatchGlass?.();
    this.order = order;
    this.preferredTaskId = Number(app.globalData.dispatchPreferredProcess) || null;
    this.setData({processFirst:!!this.preferredTaskId});
    this.contextRevision = 0;
    this._loadPromise = this.loadOverview();
    await this._loadPromise;
  },
  onShow(){if(this.data.ready)return this.refreshPeople();},
  onUnload() { this.dispatchDisposed=true;this.peopleRefreshRevision++;if(this.processRetryTimer)clearTimeout(this.processRetryTimer);this.disposeGlassSegments?.();this.disposeDispatchGlass?.(); },
  async loadOverview() {
    if(this.processRetryTimer)clearTimeout(this.processRetryTimer);
    try {
      const context = await api.loadDispatchContext(this.order);
      if(this.unloaded||this.dispatchDisposed)return;
      if (context.workOrder.projectId !== this.order.id || context.workOrder.projectCode !== this.order.code) throw new Error('工单资料不一致，请重新选择。');
      this.contextRevision++;
      const processes=(context.processes||[]).filter(process=>process.selectable!==false&&!process.closed);
      const preferred=this.data.processFirst?processes.find(row=>row.taskId===(this.data.selectedProcessId||this.preferredTaskId)):null;
      this.setData({ ready: true, operator: context.operator || {}, workOrder: context.workOrder,
        executionMode:context.executionMode||'draft',
        employees: context.employees || [], peopleGroupConfig:context.peopleGroups||null,units: context.units || [],
        stationOptions: [{ id: '请选择工位' }, ...(context.units || [])],
        processes,
        ...(this.data.processFirst?{selectedProcessId:preferred?.taskId||null,stage:preferred?'people':'process',prediction:null,predictionError:preferred?'':'原选工序已不可派，请重新选择。'}:{}),
        processWheelItems: (context.processes || []).map((process, index) => ({ ...process, orderLabel: String(index + 1).padStart(2, '0') })),
        overviewLoaded: true,processesPending:context.processesLoaded===false, overviewError: '', loadError: '' });
      if(context.processesLoaded===false){
        this.processRetryCount=(this.processRetryCount||0)+1;
        if(this.processRetryCount<=5)this.processRetryTimer=setTimeout(()=>this.loadOverview(),2500);
      }else this.processRetryCount=0;
      this.updateEmployeeView();
      this.updateConfirmationSummary();
    } catch (error) { this.setData({ loadError: error.message || '派工资料读取失败。', overviewError: this.data.ready ? '读取失败，请重试' : '' }); }
  },
  async refreshPeople(){
    if(!this.data.ready||this.dispatchDisposed||this.unloaded||this.peopleRefreshing||this.data.stage!=='people'||this.data.submitting||this.data.reviewOpen||this.data.selectedPanelMounted||this.data.peopleMenu||this.data.placementOnly||typeof api.loadDispatchPeople!=='function')return;
    this.peopleRefreshing=true;const revision=++this.peopleRefreshRevision,contextRevision=this.contextRevision;
    try{
      const response=await api.loadDispatchPeople();
      if(this.dispatchDisposed||this.unloaded||revision!==this.peopleRefreshRevision||contextRevision!==this.contextRevision||this.data.stage!=='people'||this.data.submitting||this.data.reviewOpen||this.data.selectedPanelMounted||this.data.peopleMenu||this.data.placementOnly)return;
      this.setData({employees:response.employees||[],peopleGroupConfig:response.peopleGroups||null,overviewError:''});this.updateEmployeeView();this.updateConfirmationSummary();
    }catch(error){if(!this.dispatchDisposed&&!this.unloaded&&revision===this.peopleRefreshRevision)this.setData({overviewError:error.message||'分类刷新失败，保留当前名单'});}
    finally{if(revision===this.peopleRefreshRevision)this.peopleRefreshing=false;}
  },
  updateEmployeeView() {
    const groups = model.groups(this.data.employees,this.data.peopleGroupConfig);
    const retained=groups.findIndex(group=>group.id===this.data.selectedPeopleGroupId),departmentIndex=retained>=0?retained:Math.min(this.data.departmentIndex,groups.length-1),group=groups[departmentIndex];
    const query = this.data.employeeQuery.trim().toLowerCase();
    const selected = new Set(this.data.selectedEmployeeIds);
    const rows = this.data.employees.map(employee => ({ ...employee, selected: selected.has(employee.blacklakeOperatorId) }));
    const visible = rows.filter(employee => (group.isAll||group.memberIds.includes(String(employee.blacklakeOperatorId))) && (!query || employee.name.toLowerCase().includes(query)));
    this.setData({ peopleGroups: groups, departmentIndex, selectedPeopleGroupId:group.id,groupEmployees: visible,
      peopleGroupAvailableCount: visible.filter(model.canChoose).length, selectedChips: rows.filter(employee => employee.selected) });
    this.syncSelectedPanel?.();
  },
  choosePeopleGroup(event) { const index=Number(event.currentTarget.dataset.groupIndex),group=this.data.peopleGroups[index];if(!Number.isInteger(index)||!group)return;this.setData({departmentIndex:index,selectedPeopleGroupId:group.id});this.updateEmployeeView(); },
  onEmployeeQuery(event) { this.setData({ employeeQuery: event.detail.value }); this.updateEmployeeView(); },
  onPeopleSearchFocus() {}, onPeopleSearchBlur() {},
  chooseEmployee(event) {
    const id = Number(event.currentTarget.dataset.operatorId);
    const selected = new Set(this.data.selectedEmployeeIds);
    if (selected.has(id)) selected.delete(id);
    else if (model.canChoose(this.data.employees.find(employee => employee.blacklakeOperatorId === id))) selected.add(id);
    else return;
    this.invalidateRecommendation();
    this.setData({ selectedEmployeeIds: [...selected], draft: null, notice: '' });
    this.updateEmployeeView(); this.updateConfirmationSummary();
  },
  selectGroupAvailable() {
    const selected = new Set(this.data.selectedEmployeeIds);
    this.data.groupEmployees.filter(model.canChoose).forEach(employee => selected.add(employee.blacklakeOperatorId));
    this.invalidateRecommendation(); this.setData({ selectedEmployeeIds: [...selected], draft: null, notice: '' });
    this.updateEmployeeView(); this.updateConfirmationSummary();
  },
  clearSelectedEmployees() { this.invalidateRecommendation(); this.setData({ selectedEmployeeIds: [], selectedProcessId: this.data.processFirst?this.data.selectedProcessId:null, draft: null, notice: '' }); this.updateEmployeeView(); this.updateConfirmationSummary(); },
  ...glass.methods,
  invalidateRecommendation() { this.recommendRevision = (this.recommendRevision || 0) + 1; this.setData({ prediction: null, predictionError: '' }); },
  async continueToProcess() {
    if (!this.data.selectedEmployeeIds.length || this.data.selectionWarning) return;
    if(this.data.processFirst)return this.dispatchSelectedPeople();
    this.resetDispatchGlass?.();
    this.setData({ stage: 'process', selectedPanelOpen: false, selectedProcessId: null });
    this.updateConfirmationSummary();
    if (this.preferredTaskId) {
      const preferred = this.data.processes.find(row => row.taskId === this.preferredTaskId);
      this.setData({ selectedProcessId: preferred?.taskId || null, prediction: null, predictionError: preferred ? '' : '原选工序已不可派，请重新选择。',
        processScrollTarget: preferred ? 'process-card-' + preferred.taskId : '' });
      this.updateConfirmationSummary();
      return;
    }
    const revision = this.recommendRevision = (this.recommendRevision || 0) + 1;
    this.setData({ predicting: true });
    try {
      const prediction = await api.recommendDispatchProcess(this.order, [...this.data.selectedEmployeeIds]);
      if (revision !== this.recommendRevision || this.data.stage !== 'process') return;
      const process = this.data.processes.find(row => row.taskId === prediction?.taskId);
      this.setData({ prediction: process ? prediction : null, selectedProcessId: process?.taskId || null,
        processScrollTarget: process ? 'process-card-' + process.taskId : '' });
      this.updateConfirmationSummary();
    } catch { if (revision === this.recommendRevision) this.setData({ predictionError: '暂无推荐，请手动选择工序。' }); }
    finally { if (revision === this.recommendRevision) this.setData({ predicting: false }); }
  },
  backToPeople() {
    if(this.data.submitting||this.data.processFirst&&!this.data.processes.some(row=>row.taskId===this.data.selectedProcessId))return;
    this.invalidateRecommendation();this.resetDispatchGlass?.();this.setData({stage:'people',predicting:false,reviewOpen:false});
  },
  editChosenProcess(){
    if(!this.data.processFirst||this.data.submitting)return;
    this.invalidateRecommendation();this.resetDispatchGlass?.();this.setData({stage:'process',predicting:false,reviewOpen:false,processScrollTarget:this.data.selectedProcessId?'process-card-'+this.data.selectedProcessId:''});
  },
  continueFromProcess(){if(this.data.processFirst)this.backToPeople();else return this.dispatchSelectedPeople();},
  selectPersonProcess(event) {
    const id = Number(event.currentTarget.dataset.taskId);
    if (!this.data.processes.some(process => process.taskId === id)) return;
    this.preferredTaskId = null;
    // A late recommendation cannot overwrite an explicit manual choice.
    this.recommendRevision = (this.recommendRevision || 0) + 1;
    this.setData({ selectedProcessId: id, predicting: false, predictionError:'', draft: null }); this.updateConfirmationSummary();
  },
  updateConfirmationSummary() {
    const employeePlacements = model.placements(this.data.employees, this.data.selectedEmployeeIds, this.data.manualUnitByEmployee, this.data.units);
    const process = this.data.processes.find(row => row.taskId === this.data.selectedProcessId);
    const invalid = this.data.selectedEmployeeIds.some(id => !model.canChoose(this.data.employees.find(employee => employee.blacklakeOperatorId === id)));
    const validPlacement=row=>this.data.units.some(unit=>unit.id===row.unitId);
    const allowed=this.data.impactPeople===null?employeePlacements:employeePlacements.filter(row=>this.data.impactPeople.includes(String(row.blacklakeOperatorId)));
    this.setData({ employeePlacements, placementsReady: employeePlacements.length > 0 && employeePlacements.every(validPlacement),impactReady:allowed.length>0&&allowed.every(validPlacement),
      selectedProcessName: process?.processName || '待选择工序', selectionWarning: invalid&&this.data.executionMode==='draft' ? '所选人员状态已变化，请重新核对。' : '' });
  },
  async dispatchSelectedPeople() {
    this.updateConfirmationSummary();
    if (!this.data.processes.some(row=>row.taskId===this.data.selectedProcessId) || !this.data.selectedEmployeeIds.length || this.data.selectionWarning) return;
    this.setData({ reviewOpen: true, placementOnly: !this.data.placementsReady });
    if(this.data.executionMode==='formal')await this.refreshDispatchImpact();
  },
  closeReview() { if(!this.data.submitting)this.setData({ reviewOpen: false }); },
  assignmentInput(workerIds=this.data.selectedEmployeeIds.map(String)) {return {orderId:this.order.id,processId:this.data.selectedProcessId,workerIds,priority:this.data.dispatchPriority,
    placements:this.data.employeePlacements.filter(row=>workerIds.includes(String(row.blacklakeOperatorId))).map(row=>({workerId:String(row.blacklakeOperatorId),unitId:row.unitId}))};},
  async setDispatchPriority(event) {
    const priority=event.currentTarget.dataset.priority;if(!['NORMAL','URGENT'].includes(priority)||this.data.submitting)return;
    this.dispatchOperationId=null;this.setData({dispatchPriority:priority,dispatchError:''});await this.refreshDispatchImpact();
  },
  async refreshDispatchImpact() {
    if(this.data.executionMode!=='formal')return;
    const revision=this.impactRevision=(this.impactRevision||0)+1;
    this.setData({impactLoading:true,impactLoaded:false,impactPeople:null,impactBlocked:[],dispatchError:''});
    try{
      const input=this.assignmentInput(),plan=await api.previewAssignment(input);if(revision!==this.impactRevision||this.unloaded||this.dispatchDisposed)return;
      if(!Number.isSafeInteger(plan.version)||!Array.isArray(plan.affected))throw Error('人员核对结果未能确认，请重试。');
      const eligible=new Set((plan.workerIds||input.workerIds).map(String));
      this.setData({pausePreview:plan.affected,impactVersion:plan.version,impactDispatchVersion:plan.dispatchVersion??null,impactPeople:input.workerIds.filter(id=>eligible.has(id)),impactBlocked:plan.blocked||[],impactLoaded:true});
      this.updateConfirmationSummary();
    }
    catch(error){if(revision===this.impactRevision)this.setData({dispatchError:error.message||'请重新核对派工状态。'});}
    finally{if(revision===this.impactRevision)this.setData({impactLoading:false});}
  },
  chooseEmployeeUnit(event) {
    const id = Number(event.currentTarget.dataset.operatorId), unit = this.data.stationOptions[Number(event.detail.value)];
    if (!this.data.selectedEmployeeIds.includes(id) || !unit || !this.data.units.some(row => row.id === unit.id)) return;
    this.setData({ manualUnitByEmployee: { ...this.data.manualUnitByEmployee, [id]: unit.id }, draft: null }); this.updateConfirmationSummary();
  },
  async confirmAssignment() {
    if(this.data.submitting)return;
    this.updateConfirmationSummary();
    if (!this.data.processes.some(row=>row.taskId===this.data.selectedProcessId) || this.data.selectionWarning) return;
    if(this.data.executionMode==='formal'){
      if(this.data.impactLoading||!this.data.impactLoaded||!this.data.impactReady)return;
      const input=this.assignmentInput(this.data.impactPeople??undefined), skipped=this.data.selectedEmployeeIds.filter(id=>!input.workerIds.includes(String(id)));
      this.setData({submitting:true,dispatchError:''});
      this.dispatchOperationId ||= 'dispatch-'+Date.now()+'-'+this.contextRevision;
      try{
        const result=await api.executeExecutionAction('dispatch',input,{expectedVersion:this.data.impactVersion,dispatchVersion:this.data.impactDispatchVersion,operationId:this.dispatchOperationId});
        if(this.dispatchDisposed||this.unloaded)return;
        const remaining=Object.fromEntries(Object.entries(this.data.manualUnitByEmployee).filter(([id])=>skipped.includes(Number(id))));
        this.setData({stage:'people',reviewOpen:false,placementOnly:false,selectedEmployeeIds:skipped,manualUnitByEmployee:remaining,draft:null,impactLoaded:false,impactPeople:null,impactBlocked:[],
          notice:'已派遣 '+result.assignmentIds.length+' 人'+(result.pausedAssignmentIds.length?'，原任务已暂停 '+result.pausedAssignmentIds.length+' 人':'')+(skipped.length?'，已保留 '+skipped.length+' 人待处理':'')});
        this.dispatchOperationId=null;getApp().globalData.replicaDispatchDraft=null;
        this.updateEmployeeView();this.updateConfirmationSummary();
      }catch(error){
        if(error.cause||error.status>=500)this.setData({dispatchError:'暂未收到派工回执，可再点确认核对同一笔操作。'});
        else {this.dispatchOperationId=null;this.setData({dispatchError:error.message||'派工未完成，请重新核对。',impactLoaded:false});}
      }
      finally{this.setData({submitting:false});}
      return;
    }
    if(!this.data.placementsReady)return;
    const draft = { projectId: this.order.id, projectCode: this.order.code, taskId: this.data.selectedProcessId,
      blacklakeOperatorIds: [...this.data.selectedEmployeeIds], placements: this.data.employeePlacements.map(({ blacklakeOperatorId, unitId, source }) => ({ blacklakeOperatorId, unitId, source })),
      status: 'DRAFT', submitted: false };
    getApp().globalData.replicaDispatchDraft = draft;
    this.setData({ draft, stage: 'people', reviewOpen: false, notice: '已生成派工草稿，尚未派出。' });
  },
  openHistory() { wx.showToast({ title: this.data.executionMode==='formal'?(this.data.notice||'可返回工单查看人员任务'):(this.data.draft ? '已有派工草稿，尚未派出' : '暂无派工草稿'), icon: 'none' }); },
  returnToOrders() { wx.navigateBack(); }
},'dispatch'));
