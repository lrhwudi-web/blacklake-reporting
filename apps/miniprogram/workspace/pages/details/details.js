const layerBack=require('../../utils/layer-back');
const {refreshProcessReports:refreshRemoteReports}=require('../../utils/process-report-refresh');
const api = require('../../utils/api');
const {refreshCurrentOrder}=require('../../utils/order-refresh');
const model = require('../../utils/detail-model');
const reportModel = require('../../utils/report-model');
const reportMenuModel = require('../../utils/report-menu');
const photo = require('../../utils/glass-image-viewer');
const segments = require('../../utils/glass-segments');
Page(layerBack.page({
  ...segments.methods,
  data: { ...segments.data, ...photo.data, ready: false, hasContext: false, order: null, loading: false, detailRefreshText: '', loadError: '', processLoading: false, processError: '',
    processes: [], visibleProcesses: [], selectedProcessId: null, selectedProcessName: '', expandedProcessId: null,
    tab: 'progress', processFilter: 'all', processResultsMinHeight: 0, summaryExpanded: false, detailScrollTarget: '', canDispatch: false, dispatchEnabled: false,employeeView:false,
    processSheetHeight:0,processSheetDragging:false,processReportsRefreshing:false,processReports:[],processReportsLoading:false,processReportsError:'',processReportsComplete:false,processReportsPending:false,processReportsStatusText:'',processReportsUpdatedText:'',canCreateProcessReports:false,
    sections: {materials:{items:[],loaded:false,loading:false,error:'',pageNum:0,hasMore:false},history:{items:[],loaded:false,loading:false,error:'',pageNum:0,hasMore:false},outsource:{items:[],loaded:false,loading:false,error:'',pageNum:0,hasMore:false}},
    activeSection: {items:[],loading:false,error:'',loaded:false},
    sourceLabel: '', updatedLabel: '', upstreamUpdatedLabel: '', processTime: '', completeProcesses: false,
    processCounts: { all: 0, paused: '—', running: '—' }, sourceMode: '', imageFailed: false, pageTitle: '工单详情',
    executionAssignments: [], executionLoaded: false, executionLoading: false, executionError: '', executionVersion: null, canManageExecution: false,canEditProcessReports:false,processReportAssignments:[],
    deletedAssignmentId: '', actionBusy: false, reportPanel: null, reportGood: '', reportBad: '', reportError: '',
    swipeProcessId:'',processSwipeOffset:0,processSwipeDragging:false,processDetail:null,processDetailMounted:false,processDetailOpen:false,
    reportOptions:{employees:[],defectReasons:[]},reportEditor:null,reportExtra:false,reportDefectsOpen:false,reportEditorHeight:520,reportExpandStyle:'',reportDefectText:'',assignmentMetaId:'',
    reportPeopleMounted:false,reportPeopleOpen:false,reportPeopleQuery:'',reportPeopleGroups:[],reportPeopleExpanded:[],reportPeopleCollapsed:[],reportPeopleTotal:0,reportPeopleInstant:false,
    reportTimeWheel:null,reportTimeOpen:false,reportTimePicking:false,reportTimeError:'',reportMenu:null,reportMenuOpen:false },
  async onLoad(options = {}) {
    this.filterRevision=(this.filterRevision||0)+1;
    this.setupGlassSegments?.();
    const current = getApp().globalData.viewOrder;
    if (!current || String(current.id) !== String(options.projectId)) {
      this.setData({ loadError: '请从工单列表重新打开这张工单。' }); return;
    }
    this.orderId = current.id;
    this.setData({ hasContext: true, canDispatch: getApp().globalData.entry?.appRole === 'floor8_leader',employeeView:getApp().globalData.entry?.appRole==='employee' });
    if(this.data.employeeView)this.setData({executionAssignments:[],canManageExecution:false,processFilter:'all'});
    this._loadPromise = this.loadDetail();
    await this._loadPromise;
  },
  onUnload() { this.unloaded = true;this.clearReportEditorMotion();this.disposeGlassSegments?.();this.disposeProductPreview?.();this.clearReportMenuMotion(); this.clearProcessDetailMotion();this.processSwipe=null;this.clearReportPeopleMotion();this.clearReportTimeMotion();this.requestRevision = (this.requestRevision || 0) + 1; },
  onShow() {this.processReportsHidden=false;if(this.data.ready)this.loadExecution();this.resumeProcessReportPolling();},
  onHide(){this.pauseProcessReportPolling();},
  onResize(){const info=typeof wx.getWindowInfo==='function'?wx.getWindowInfo():wx.getSystemInfoSync?.();if(this.reportMenuViewport&&this.reportMenuViewport!==info?.windowWidth+'x'+info?.windowHeight)this.resetReportMenu();},
  refreshDetail(){return this.loadDetail({force:true});},
  async loadDetail({force=false}={}) {
    if (this.data.loading || this.orderId == null) return;
    const revision = this.requestRevision = (this.requestRevision || 0) + 1;
    this.processRevision = (this.processRevision || 0) + 1;
    this.sectionRevisions ||= {};
    for(const key of ['materials','history','outsource'])this.sectionRevisions[key]=(this.sectionRevisions[key]||0)+1;
    const sections=Object.fromEntries(Object.entries(this.data.sections).map(([key,value])=>[key,{...value,loaded:false,loading:false,stale:!!value.items.length}]));
    this.setData({sections,activeSection:sections[this.data.tab]||this.data.activeSection});
    this.setData({ loading: true, detailRefreshText:force?'正在更新当前工单…':'', loadError: '', processLoading: false, dispatchEnabled: false });
    try {
      const response = force?await refreshCurrentOrder(api,this.orderId,{active:()=>!this.unloaded&&!this.processReportsHidden&&revision===this.requestRevision,status:sync=>this.setData({detailRefreshText:sync.phase==='cooldown'?'黑湖冷却中，这张工单已排队更新…':sync.phase==='updating'?'正在从黑湖更新这张工单…':'这张工单已排队更新…'})}):await api.loadOrderDetail(this.orderId);
      if (revision !== this.requestRevision || this.unloaded) return;
      if (!response.order || String(response.order.id) !== String(this.orderId)) throw new Error('工单信息未能确认，请重新打开。');
      const selected = getApp().globalData.viewOrder;
      if (response.order.code !== selected.code&&!force) throw new Error('工单编号已变化，请返回列表核对。');
      if(force&&String(selected.id)===String(this.orderId))getApp().globalData.viewOrder={...selected,...response.order};
      const order = model.presentOrder(response.order);
      const mirrored=response.source==='blacklake-snapshot',live = response.source === 'blacklake-live'||mirrored;
      this.setData({ ready: true, order, loading: false, detailRefreshText:force?'当前工单已更新':'', imageFailed: false, sourceMode: response.source,
        sourceLabel: mirrored?'后台共享资料 · 上次同步':live ? '来源：黑湖 · 当前工单' : response.source === 'ui-fixture' ? '界面演示' : '截图样本 · 仅展示已知字段',
        updatedLabel: live ? model.time(response.fetchedAt) : '', upstreamUpdatedLabel: response.order.upstreamUpdatedAt || '未提供' });
      this.updateView();
      await this.loadExecution();
      await this.loadProcesses();
      if(['materials','history','outsource'].includes(this.data.tab))await this.loadSection();
    } catch (error) {
      if (revision !== this.requestRevision || this.unloaded) return;
      this.setData({ loading: false, detailRefreshText:'', loadError: error.code==='ORDER_REFRESH_CANCELLED'?'':error.message || '工单读取失败，请稍后重试。', dispatchEnabled: false });
    }
  },
  async loadProcesses() {
    if (!this.data.ready || this.data.processLoading) return;
    const revision = this.processRevision = (this.processRevision || 0) + 1;
    this.setData({ processLoading: true, processError: '', dispatchEnabled: false });
    try {
      const response = await api.loadOrderProcesses(this.orderId);
      if (revision !== this.processRevision || this.unloaded) return;
      if (String(response.orderId) !== String(this.orderId) || !Array.isArray(response.processes)) throw new Error('工序资料未能确认。');
      const processes = model.presentProcesses(response.processes);
      const selected = processes.find(row => row.id === this.data.selectedProcessId && row.selectable);
      this.setData({ processes, processLoading: false, completeProcesses: response.complete === true,
        processTime: ['blacklake-live','blacklake-snapshot'].includes(response.source) ? model.time(response.fetchedAt) : '',
        selectedProcessId: selected?.id || null, selectedProcessName: selected?.name || '' });
      this.updateView();
    } catch (error) {
      if (revision !== this.processRevision || this.unloaded) return;
      this.setData({ processLoading: false, processError: error.message || '工序读取失败，请重试。', dispatchEnabled: false });
    }
  },
  updateView() {
    const all = this.data.processes;
    const enriched=all.map(row=>{
      const assignments=this.data.executionAssignments.filter(task=>String(task.processId)===String(row.id));
      const paused=assignments.filter(task=>task.status==='PAUSED').length,running=assignments.filter(task=>task.status==='IN_PROGRESS').length;
      const people=assignments.map(task=>({...task,deletedCount:task.reports.filter(report=>report.deleted).length,
        visibleReports:task.reports.filter(report=>!report.deleted||this.data.deletedAssignmentId===task.id)}));
      const lines=people.reduce((total,task)=>total+Math.max(1,task.visibleReports.length),0);
      return {...row,assignments:people,ledgerHeight:Math.min(480,216+Math.max(0,lines-1)*124+paused*70+(this.data.canDispatch&&row.selectable?66:0)),pausedCount:paused,runningCount:running};
    });
    const visibleProcesses = enriched.filter(row=>this.data.employeeView||this.data.processFilter==='all'||(this.data.processFilter==='paused'?row.pausedCount>0:row.runningCount>0));
    const dispatchEnabled = this.data.canDispatch && ['NOT_STARTED', 'IN_PROGRESS'].includes(this.data.order?.status) && all.some(row => row.selectable) && !this.data.loading && !this.data.loadError && !this.data.processLoading && !this.data.processError;
    let processDetail=this.data.processDetailMounted?enriched.find(row=>row.id===this.data.expandedProcessId):null;
    if(processDetail)processDetail={...processDetail,ledgerHeight:this.employeeLedgerHeight()};
    this.setData({ visibleProcesses, processDetail:processDetail||null, processCounts: { all: all.length, paused:this.data.executionLoaded?enriched.filter(row=>row.pausedCount>0).length:'—',running:this.data.executionLoaded?enriched.filter(row=>row.runningCount>0).length:'—' }, dispatchEnabled });
    if(this.data.processDetailMounted&&!processDetail)this.resetProcessDetail();
  },
  async loadExecution() {
    if(this.data.employeeView)return;
    if(typeof api.loadOrderExecution!=='function'||this.orderId==null)return;
    this.resetReportMenu();
    const revision=this.executionRevision=(this.executionRevision||0)+1;
    this.setData({executionLoading:true,executionError:''});
    try{
      const response=await api.loadOrderExecution(this.orderId);
      if(this.unloaded||revision!==this.executionRevision)return;
      if(String(response.orderId)!==String(this.orderId)||!Array.isArray(response.assignments)||!Number.isSafeInteger(response.version))throw new Error('员工任务资料未能确认。');
      
      this.setData({executionAssignments:model.presentAssignments(response.assignments),executionLoaded:true,executionLoading:false,executionVersion:response.version,reportOptions:response.reportOptions||{employees:[],defectReasons:[]},
        canManageExecution:response.canManage===true&&getApp().globalData.entry?.appRole==='floor8_leader'});this.updateView();
    }catch(error){if(this.unloaded||revision!==this.executionRevision)return;this.setData({executionLoading:false,executionError:error.message||'员工任务读取失败。',canManageExecution:false});this.updateView();}
  },
  async setTab(event) {
    const tab=event.currentTarget.dataset.tab;
    if(!['progress','materials','history','outsource'].includes(tab))return;
    
    this.resetProcessDetail();this.closeProcessSwipe();
    this.setData({tab,activeSection:this.data.sections[tab]||{items:[],loaded:false,loading:false,error:''}},()=>this.alignSection());
    if(tab!=='progress'&&!this.data.sections[tab].loaded)await this.loadSection();
  },
  toggleSummary() {this.setData({summaryExpanded:!this.data.summaryExpanded});},
  alignSection() {this.setData({detailScrollTarget:''},()=>this.setData({detailScrollTarget:'detail-section-start'}));},
  updateSection(key,values) {
    const section={...this.data.sections[key],...values};
    this.setData({sections:{...this.data.sections,[key]:section},...(this.data.tab===key?{activeSection:section}:{})});
  },
  async loadSection(event) {
    const key=this.data.tab;
    if(!['materials','history','outsource'].includes(key)||!this.data.ready||this.data.loading||this.data.loadError)return;
    const previous=this.data.sections[key];
    if(previous.loading)return;
    const more=event?.currentTarget?.dataset?.more===true||event?.currentTarget?.dataset?.more==='true';
    if(more&&!previous.hasMore)return;
    const pageNum=more?previous.pageNum+1:1;
    this.sectionRevisions ||= {};
    const revision=this.sectionRevisions[key]=(this.sectionRevisions[key]||0)+1;
    this.updateSection(key,{loading:true,error:''});
    try{
      const response=await api.loadOrderSection(this.orderId,key,pageNum);
      if(this.unloaded||this.sectionRevisions[key]!==revision)return;
      if(String(response.orderId)!==String(this.orderId)||response.section!==key||response.pageNum!==pageNum||!Array.isArray(response.items)||response.items.some(row=>!row||typeof row!=='object'||Array.isArray(row)||row.id==null||String(row.id)===''))throw new Error('明细资料未能确认，请重试。');
      const rows=more?previous.items.concat(model.presentSection(key,response.items)):model.presentSection(key,response.items);
      const items=[...new Map(rows.map(row=>[row.id,row])).values()].map((row,index)=>({...row,indexLabel:String(index+1).padStart(2,'0')}));
      this.updateSection(key,{items,loaded:true,loading:false,stale:false,pageNum,hasMore:response.hasMore===true,complete:response.complete===true,
        available:response.available!==false,scopeNote:response.scopeNote||'',updatedLabel:response.source==='blacklake-live'?model.time(response.fetchedAt):'',
        demo:response.source!=='blacklake-live',sourceLabel:response.source==='blacklake-live'?'黑湖 · 当前工单':response.source==='ui-fixture'?'界面演示 · 明细为样本数据':'截图样本 · 仅已知资料'});
      if(this.data.tab===key)this.alignSection();
    }catch(error){
      if(this.unloaded||this.sectionRevisions[key]!==revision)return;
      this.updateSection(key,{loading:false,error:error.message||'读取失败，请稍后重试。',stale:!!previous.items.length});
    }
  },
  previewMaterial(event) {
    const row=this.data.sections.materials.items.find(item=>String(item.id)===String(event.currentTarget.dataset.id));
    if(row?.imageUrl&&!row.imageFailed)this.openProductPreview?.(row.imageUrl,'#material-image-'+row.id);
  },
  materialImageError(event) {
    this.updateSection('materials',{items:this.data.sections.materials.items.map(row=>String(row.id)===String(event.currentTarget.dataset.id)?{...row,imageFailed:true}:row)});
  },
  setFilter(event) {
    if(this.data.employeeView)return;
    const filter=event.currentTarget.dataset.filter;
    if(!['all','paused','running'].includes(filter)||filter!=='all'&&!this.data.executionLoaded||filter===this.data.processFilter)return;
    const revision=this.filterRevision=(this.filterRevision||0)+1;
    // Accept the selection synchronously; retain the old rows until its viewport floor is ready.
    this.setData({processFilter:filter});
    const apply=rects=>{
      if(this.unloaded||revision!==this.filterRevision||this.data.tab!=='progress')return;
      const [viewport,results]=rects||[];
      const valid=viewport&&results&&[viewport.top,viewport.height,results.top].every(Number.isFinite)&&viewport.height>0;
      const floor=valid?Math.max(0,Math.ceil(viewport.top+viewport.height-results.top)+1):this.data.processResultsMinHeight;
      this.resetProcessDetail();this.closeProcessSwipe();
      this.setData({processResultsMinHeight:floor});this.updateView();
    };
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();
    if(!query)return apply();
    query.select('.detail-scroll').boundingClientRect();
    query.select('#process-results').boundingClientRect().exec(apply);
  },
  closeProcessSwipe(){this.processSwipe=null;this.setData({swipeProcessId:'',processSwipeOffset:0,processSwipeDragging:false});},
  onProcessSwipeStart(event){
    if(this.data.employeeView)return;
    const id=String(event.currentTarget.dataset.id),point=event.touches?.[0];
    if(this.data.processDetailMounted||this.data.reportPanel||event.touches?.length!==1||!point||!this.data.visibleProcesses.some(row=>String(row.id)===id))return;
    const base=this.data.swipeProcessId===id?this.data.processSwipeOffset:0;
    this.processSwipe={id,identifier:point.identifier,x:point.clientX,y:point.clientY,base,axis:''};this.setData({swipeProcessId:id,processSwipeOffset:base,processSwipeDragging:false});
  },
  onProcessSwipeMove(event){
    const drag=this.processSwipe;if(!drag)return;if(event.touches?.length!==1){this.closeProcessSwipe();return;}
    const point=event.touches.find(row=>row.identifier===drag.identifier);if(!point)return;const dx=point.clientX-drag.x,dy=point.clientY-drag.y;
    if(!drag.axis){if(Math.max(Math.abs(dx),Math.abs(dy))<8)return;drag.axis=Math.abs(dx)>Math.abs(dy)*1.2?'x':'y';}if(drag.axis!=='x')return;
    this.setData({processSwipeDragging:true,processSwipeOffset:Math.round(Math.max(-76,Math.min(0,drag.base+dx)))});
  },
  onProcessSwipeEnd(event){
    const drag=this.processSwipe;if(!drag)return;if(event.changedTouches?.length&&!event.changedTouches.some(point=>point.identifier===drag.identifier))return;
    this.processSwipe=null;const open=drag.axis==='x'?this.data.processSwipeOffset < -30:drag.base<0;if(drag.axis==='x')this.processSwipeTapUntil=Date.now()+240;
    this.setData({swipeProcessId:open?drag.id:'',processSwipeOffset:open?-76:0,processSwipeDragging:false});
  },
  onProcessSwipeCancel(){this.closeProcessSwipe();},
  onProcessRowTap(event){
    if(Date.now()<(this.processSwipeTapUntil||0)||this.data.processDetailMounted||this.data.reportPanel||this.data.actionBusy)return;
    const revealed=this.data.processSwipeOffset<0;
    this.closeProcessSwipe();
    if(this.data.employeeView)return this.openProcessDetail(event);
    if(!revealed)this.chooseProcess(event);
  },
  revealProcessActions(event){if(this.data.employeeView)return this.openProcessDetail(event);const id=String(event.currentTarget.dataset.id);if(this.data.processDetailMounted||this.data.reportPanel||!this.data.visibleProcesses.some(row=>String(row.id)===id))return;this.processSwipe=null;this.setData({swipeProcessId:id,processSwipeOffset:-76,processSwipeDragging:false});},
  clearProcessDetailMotion(){if(this.processReportsTimer!=null)clearTimeout(this.processReportsTimer);this.processReportsTimer=null;if(this.processDetailFrame!=null)clearTimeout(this.processDetailFrame);if(this.processDetailTimer!=null)clearTimeout(this.processDetailTimer);this.processDetailFrame=null;this.processDetailTimer=null;this.processDetailRevision=(this.processDetailRevision||0)+1;},
  resetProcessDetail(){this.resetReportMenu();this.clearProcessDetailMotion();this.setData({processDetailMounted:false,processDetailOpen:false,processDetail:null,expandedProcessId:null,processReports:[],processReportsLoading:false,processReportsError:'',canCreateProcessReports:false,canEditProcessReports:false,processReportAssignments:[]});},
  employeeLedgerHeight(count=this.data.processReports.length){const info=wx.getWindowInfo?.()||{};return Math.min(520,Math.max(240,(info.windowHeight||740)-48),Math.max(360,208+count*124));},
  pauseProcessReportPolling(){this.processReportsHidden=true;if(this.processReportsTimer!=null)clearTimeout(this.processReportsTimer);this.processReportsTimer=null;this.processReportReadRevision=(this.processReportReadRevision||0)+1;this.setData({processReportsLoading:false});},
  resumeProcessReportPolling(){this.processReportsHidden=false;if(this.data.processDetailMounted&&this.data.processDetailOpen&&!this.data.reportPanel&&!this.data.reportMenu)return this.loadProcessReports();},
  scheduleProcessReportPoll(){
    if(this.processReportsTimer!=null)clearTimeout(this.processReportsTimer);this.processReportsTimer=null;
    if(this.unloaded||this.processReportsHidden||!this.data.processDetailMounted||!this.data.processDetailOpen||!this.data.processReportsPending||this.data.processReportsRefreshing)return;
    const revision=this.processDetailRevision,delay=Math.min(30000,2500*2**Math.min(this.processReportsPollCount||0,4));this.processReportsPollCount=(this.processReportsPollCount||0)+1;
    this.processReportsTimer=setTimeout(()=>{this.processReportsTimer=null;if(this.unloaded||this.processReportsHidden||revision!==this.processDetailRevision)return;if(this.data.reportPanel||this.data.reportMenu)this.scheduleProcessReportPoll();else this.loadProcessReports();},delay);
  },
  async refreshProcessReports(){
    const id=this.data.processDetail?.id;if(id==null||!this.data.processDetailOpen||this.data.processReportsRefreshing||this.data.reportPanel||this.data.actionBusy)return;
    const revision=this.processDetailRevision,active=()=>!this.unloaded&&!this.processReportsHidden&&this.data.processDetailMounted&&revision===this.processDetailRevision;
    this.processReportsRefreshRevision=(this.processReportsRefreshRevision||0)+1;this.processReportReadRevision=(this.processReportReadRevision||0)+1;
    if(this.processReportsTimer!=null)clearTimeout(this.processReportsTimer);this.processReportsTimer=null;this.resetReportMenu();this.setData({processReportsRefreshing:true,processReportsLoading:false,processReportsError:'',processReportsStatusText:'正在请求黑湖更新…'});
    try{await refreshRemoteReports(api,this.orderId,id,{active,status:sync=>{if(active())this.setData({processReportsStatusText:sync.phase==='cooldown'?'黑湖读取冷却中 · 已保留记录':sync.refresh?.completed?'黑湖报工已更新':'正在拉取黑湖报工 · 已保留记录'});}});if(active()){await this.loadProcesses();if(active())await this.loadProcessReports();if(active())this.setData({processReportsStatusText:'黑湖报工已更新'});}}
    catch(error){if(active())this.setData({processReportsError:error.message,processReportsPending:true,processReportsStatusText:'更新尚未完成 · 已保留记录'});}
    finally{if(active()){this.setData({processReportsRefreshing:false});this.scheduleProcessReportPoll();}}
  },
  processSheetResizeStart(event){const point=event.touches?.[0];if(event.touches?.length!==1||!point||this.data.reportPanel||this.data.actionBusy||!this.data.processDetailOpen)return;this.processSheetDrag={y:point.clientY,height:this.data.processSheetHeight||this.data.processDetail.ledgerHeight};this.setData({processSheetDragging:true});},
  processSheetResizeMove(event){const point=event.touches?.[0],drag=this.processSheetDrag;if(!point||!drag)return;const max=(wx.getWindowInfo?.().windowHeight||740)-48;this.setData({processSheetHeight:Math.max(Math.min(310,max),Math.min(max,drag.height+drag.y-point.clientY))});},
  processSheetResizeEnd(){this.processSheetDrag=null;if(this.data.processSheetDragging)this.setData({processSheetDragging:false});},
  async loadProcessReports(){
    const id=this.data.processDetail?.id;if(id==null||!this.data.processDetailMounted||this.data.processReportsLoading||this.processReportsHidden)return;
    const revision=this.processReportReadRevision=(this.processReportReadRevision||0)+1,presentation=this.processDetailRevision;
    if(this.processReportsTimer!=null)clearTimeout(this.processReportsTimer);this.processReportsTimer=null;this.resetReportMenu();this.setData({processReportsLoading:true,processReportsError:''});
    try{
      const response=await api.loadProcessReports(this.orderId,id);
      if(this.unloaded||revision!==this.processReportReadRevision||presentation!==this.processDetailRevision)return;
      if(String(response.orderId)!==String(this.orderId)||String(response.processId)!==String(id)||!Array.isArray(response.reports)||response.reports.some(row=>!row||row.id==null||String(row.orderId)!==String(this.orderId)||String(row.processId)!==String(id)))throw new Error('工序报工资料归属未能确认。');
      const status=model.processReportStatus(response);this.setData({...(!response.notModified?{processReports:model.presentProcessReports(response.reports)}:{}),processReportsLoading:false,processReportsComplete:response.complete===true,processReportsPending:response.sync?.pending===true,...status,canCreateProcessReports:response.canCreateReports===true,canEditProcessReports:response.canEditReports===true&&['all-process-reports','own-dispatch-reports'].includes(response.permission)});if(!response.notModified)this.updateView();this.scheduleProcessReportPoll();
    }catch(error){if(!this.unloaded&&revision===this.processReportReadRevision&&presentation===this.processDetailRevision){this.setData({processReportsLoading:false,processReportsError:error.message||'报工记录读取失败，请重试。',processReportsStatusText:this.data.processReports.length?'更新失败 · 已保留记录':'读取失败，请重试',processReportsPending:true});this.scheduleProcessReportPoll();}}
  },
  openProcessDetail(event){
    if(this.data.reportPanel||this.data.actionBusy)return;
    const row=this.data.visibleProcesses.find(item=>String(item.id)===String(event.currentTarget.dataset.id));if(!row)return;
    this.clearProcessDetailMotion();this.processSheetResizeEnd();this.setData({processSheetHeight:0,processReportsRefreshing:false});this.closeProcessSwipe();this.processReportsPollCount=0;const revision=this.processDetailRevision;
    const cached=api.peekProcessReports?.(this.orderId,row.id),cachedRows=cached?.reports||[];
    this.setData({processDetail:{...row,ledgerHeight:this.employeeLedgerHeight(cachedRows.length)},expandedProcessId:row.id,processDetailMounted:true,processDetailOpen:false,processReports:model.presentProcessReports(cachedRows),processReportsLoading:false,processReportsError:'',processReportsComplete:false,processReportsPending:false,processReportsStatusText:cachedRows.length?'已有记录 · 正在检查更新':'正在读取本地记录…',processReportsUpdatedText:cached?.sync?.updatedAt?'最近同步 '+model.time(cached.sync.updatedAt).slice(0,19):'',canCreateProcessReports:false,canEditProcessReports:false,processReportAssignments:[]},()=>{this.processDetailFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.processDetailRevision){this.setData({processDetailOpen:true});this.scheduleProcessReportPoll();}},16);});
    return this.loadProcessReports();
  },
  closeProcessDetail(){
    if(this.data.reportPanel||this.data.actionBusy)return;this.processSheetResizeEnd();this.setData({processReportsRefreshing:false});this.resetReportMenu();this.clearProcessDetailMotion();const revision=this.processDetailRevision;
    this.setData({processDetailOpen:false});this.processDetailTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.processDetailRevision)this.setData({processDetailMounted:false,processDetail:null,expandedProcessId:null});},this.data.reduceMotion?100:180);
  },
  selectDetailProcess(){const row=this.data.processDetail;if(!row?.selectable||!this.data.dispatchEnabled)return;this.chooseProcess({currentTarget:{dataset:{id:row.id}}});this.closeProcessDetail();},
  toggleDeletedReports(event) {const id=String(event.currentTarget.dataset.id);this.setData({deletedAssignmentId:this.data.deletedAssignmentId===id?'':id});this.updateView();},
  reportManagementAllowed(){return this.data.processDetailMounted?this.data.canEditProcessReports===true:this.data.canManageExecution===true;},
  async openCreateProcessReport(){
    if(!this.data.canCreateProcessReports||!this.reportManagementAllowed()||this.data.actionBusy||this.data.reportPanel)return;
    const processId=this.data.processDetail?.id,revision=this.processDetailRevision;this.resetReportMenu();this.setData({actionBusy:true,processReportsError:''});
    try{
      const response=await api.loadProcessReportCreateContext(this.orderId,processId);
      if(this.unloaded||revision!==this.processDetailRevision||!this.data.processDetailMounted)return;
      if(response.canCreate!==true||response.permission!=='all-process-reports'||String(response.orderId)!==String(this.orderId)||String(response.processId)!==String(processId))throw Error('新建报工权限或工序归属未能确认。');
      this.resetReportPeople();this.resetReportDateTime();this.reportOperationId='manual-report-'+Date.now()+'-'+Math.random().toString(36).slice(2,10);
      const at=new Date(Math.floor(Date.parse(response.serverTime)/60000)*60000).toISOString(),task={orderId:this.orderId,processId,processName:response.processName,segments:[],workerId:''},options=response.reportOptions;
      const editor=reportModel.editor({productionWorkerId:'',actualStartedAt:at,actualEndedAt:at,reportedSeconds:0},task,options);editor.workerId='';editor.workerName='选择人员';
      this.reportTask=task;this.setData({reportPanel:{action:'createReport',isEditor:true,title:'新建报工',processName:response.processName},reportGood:'',reportBad:'0',reportOptions:options,reportEditor:editor,reportError:'',reportEditorHeight:this.reportEditorBaseHeight(),reportExpandStyle:'',reportExtra:false,reportDefectsOpen:false,reportDefectText:''});
    }catch(error){if(!this.unloaded&&revision===this.processDetailRevision)this.setData({processReportsError:error.message||'新建报工资料读取失败。'});}finally{if(!this.unloaded)this.setData({actionBusy:false});}
  },
  async openProcessReportEditor(event){
    const id=String(event.currentTarget.dataset.id),action=event.currentTarget.dataset.action||'editReport',processId=this.data.processDetail?.id,revision=this.processDetailRevision;
    if(!['editReport','deleteReport'].includes(action)||!this.data.canEditProcessReports||this.data.actionBusy||this.data.reportPanel||!this.data.processReports.some(row=>String(row.id)===id&&row[action==='deleteReport'?'canDelete':'canEdit']))return;
    this.setData({actionBusy:true,processReportsError:''});
    let loaded=false;
    try{
      const response=await api.loadProcessReportEditor(this.orderId,processId,id);
      if(this.unloaded||revision!==this.processDetailRevision||!this.data.processDetailMounted)return;
      const task=response.assignment,report=response.report;
      const validVersion=Number.isSafeInteger(response.version)&&response.version>=0||typeof response.version==='string'&&/^[a-f0-9]{64}$/.test(response.version);
      if(!['all-process-reports','own-dispatch-reports'].includes(response.permission)||response.canEdit!==true||!validVersion||String(response.orderId)!==String(this.orderId)||String(response.processId)!==String(processId)||String(report?.id)!==id||String(task?.orderId)!==String(this.orderId)||String(task?.processId)!==String(processId)||String(report?.assignmentId)!==String(task?.id)||report.deleted)throw new Error('报工权限或工序归属未能确认，请刷新后重试。');
      if(action==='deleteReport'&&response.canDelete!==true)throw new Error('当前报工不能删除，请刷新核对。');
      this.setData({processReportAssignments:[{...task,reports:[{...report,canEdit:true,canDelete:response.canDelete===true,canRestore:false}]}],reportOptions:response.reportOptions||{employees:[],defectReasons:[]},executionVersion:response.version});loaded=true;
    }catch(error){if(!this.unloaded&&revision===this.processDetailRevision)this.setData({processReportsError:error.message||'报工资料读取失败。'});}
    finally{if(!this.unloaded)this.setData({actionBusy:false});}
    if(loaded&&!this.unloaded&&revision===this.processDetailRevision)this.openReportAction({currentTarget:{dataset:{id,action}}});
  },
  toggleAssignmentMeta(event) {const id=String(event.currentTarget.dataset.id);this.setData({assignmentMetaId:this.data.assignmentMetaId===id?'':id});},
  reportForEvent(event){const id=String(event.currentTarget.dataset.id);if(this.data.processDetailMounted)return this.data.processReports.find(row=>String(row.id)===id);const task=(this.taskRecordRows?.()||this.data.executionAssignments).find(row=>row.reports.some(report=>String(report.id)===id));return task?.reports.find(row=>String(row.id)===id);},
  clearReportMenuMotion(){if(this.reportMenuFrame!=null)clearTimeout(this.reportMenuFrame);if(this.reportMenuTimer!=null)clearTimeout(this.reportMenuTimer);this.reportMenuFrame=null;this.reportMenuTimer=null;this.reportMenuRevision=(this.reportMenuRevision||0)+1;},
  resetReportMenu(){this.clearReportMenuMotion();this.setData({reportMenu:null,reportMenuOpen:false});},
  closeReportMenu(){
    if(!this.data.reportMenu){this.clearReportMenuMotion();return;}this.clearReportMenuMotion();const revision=this.reportMenuRevision;this.setData({reportMenuOpen:false});
    this.reportMenuTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.reportMenuRevision)this.setData({reportMenu:null});},this.data.reduceMotion?100:150);
  },
  showReportActions(event){
    const report=this.reportForEvent(event);if(!this.reportManagementAllowed()||this.data.actionBusy||this.data.reportPanel||!report)return;
    if(this.data.reportMenu?.reportId===String(report.id)&&this.data.reportMenuOpen){this.closeReportMenu();return;}
    const options=[{action:'editReport',label:'修改报工',icon:'edit',allowed:report.canEdit},{action:'deleteReport',label:'删除报工',icon:'delete',allowed:report.canDelete},{action:'restoreReport',label:'恢复报工',icon:'restore',allowed:report.canRestore}].filter(item=>item.allowed);
    if(!options.length){if(report.managementBlockedReason)wx.showToast({title:report.managementBlockedReason,icon:'none'});return;}
    const anchorId=event.currentTarget.dataset.anchor;if(!/^report-more-\d+-\d+$/.test(anchorId||''))return;
    this.resetReportMenu();const revision=this.reportMenuRevision;
    let query=typeof this.createSelectorQuery==='function'?this.createSelectorQuery():wx.createSelectorQuery?.();if(!query)return;if(query.in&&this.properties)query=query.in(this);
    query.select('#'+anchorId).boundingClientRect().exec(results=>{
      if(this.unloaded||revision!==this.reportMenuRevision||!this.reportManagementAllowed()||this.data.reportPanel)return;
      const viewport=typeof wx.getWindowInfo==='function'?wx.getWindowInfo():wx.getSystemInfoSync?.(),geometry=reportMenuModel.layout(results?.[0],viewport,options.length);
      if(!geometry)return;
      this.reportMenuViewport=viewport.windowWidth+'x'+viewport.windowHeight;
      this.setData({reportMenu:{...geometry,reportId:String(report.id),anchorId,options},reportMenuOpen:false},()=>{this.reportMenuFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.reportMenuRevision)this.setData({reportMenuOpen:true});},16);});
    });
  },
  chooseReportMenuAction(event){
    const menu=this.data.reportMenu,action=event.currentTarget.dataset.action;if(!menu||!this.data.reportMenuOpen||!menu.options.some(option=>option.action===action))return;
    this.closeReportMenu();if(this.data.processDetailMounted)return this.openProcessReportEditor({currentTarget:{dataset:{id:menu.reportId,action}}});this.openReportAction({currentTarget:{dataset:{id:menu.reportId,action}}});
  },
  async resumeAssignment(event) {
    if(!this.data.canManageExecution||this.data.actionBusy)return;
    const task=this.data.executionAssignments.find(row=>String(row.id)===String(event.currentTarget.dataset.id));if(!task?.canResume)return;
    this.setData({actionBusy:true});
    try{await api.executeExecutionAction('resume',{assignmentId:task.id},{expectedVersion:this.data.executionVersion,operationId:'resume-'+Date.now()+'-'+task.id});await this.loadExecution();wx.showToast({title:'已由组长继续启动',icon:'none'});}
    catch(error){this.setData({executionError:error.message||'未能继续启动，请刷新。'});}finally{this.setData({actionBusy:false});}
  },
  async openReportAction(event) {
    if(!this.reportManagementAllowed()||this.data.actionBusy)return;
    const action=event.currentTarget.dataset.action,reportId=String(event.currentTarget.dataset.id);
    if(this.data.employeeView&&!['editReport','deleteReport'].includes(action))return;
    const task=(this.data.processDetailMounted?this.data.processReportAssignments:this.data.executionAssignments).find(row=>row.reports.some(report=>String(report.id)===reportId));
    let report=task?.reports.find(row=>String(row.id)===reportId);
    if(!report||!(['editReport','deleteReport','restoreReport'].includes(action))||!report[action==='editReport'?'canEdit':action==='deleteReport'?'canDelete':'canRestore'])return;
    
    if(action==='editReport'&&!this.data.employeeView&&!this.data.processDetailMounted){
      this.setData({actionBusy:true,executionError:''});
      try{const remote=await api.loadReportEdit(reportId);if(this.unloaded)return;report={...report,...remote.report};this.setData({reportOptions:remote.options});}
      catch(error){if(!this.unloaded)this.setData({executionError:error.message||'报工读取失败，请重试。'});return;}
      finally{if(!this.unloaded)this.setData({actionBusy:false});}
    }
    this.resetReportPeople();
    this.resetReportDateTime();
    this.reportOperationId='report-'+Date.now()+'-'+reportId+'-'+action;
    this.reportTask=task;
    if(action==='editReport')wx.hideKeyboard?.();
    this.setData({reportPanel:{action,isEditor:action==='editReport',reportId,workerName:report.productionWorkerName||task.workerName,processName:task.processName,version:this.data.executionVersion,
      title:action==='editReport'?'编辑报工':action==='deleteReport'?'删除报工':'恢复报工'},reportGood:String(report.goodQuantity),reportBad:String(report.defectiveQuantity),reportError:'',
      reportEditor:action==='editReport'?reportModel.editor(report,task,this.data.reportOptions):null,reportEditorHeight:this.reportEditorBaseHeight(),reportExpandStyle:'',reportExtra:false,reportDefectsOpen:false,reportDefectText:report.defectItems?.length?'已选 '+report.defectItems.length+' 项':''},()=>{if(action==='editReport'&&this.data.reportPanel?.reportId===reportId)wx.hideKeyboard?.();});
  },
  closeReportPanel() {if(!this.data.actionBusy){this.clearReportEditorMotion();this.resetReportPeople();this.resetReportDateTime();this.setData({reportPanel:null,reportError:''});}},
  closeReportLayer(){if(this.data.reportTimeWheel)this.closeReportDateTime();else this.data.reportPeopleMounted?this.closeReportPeople():this.closeReportPanel();},
  clearReportTimeMotion(){if(this.timeOpenFrame!=null)clearTimeout(this.timeOpenFrame);if(this.timeCloseTimer!=null)clearTimeout(this.timeCloseTimer);this.timeOpenFrame=null;this.timeCloseTimer=null;this.timeMotionRevision=(this.timeMotionRevision||0)+1;},
  resetReportDateTime(){this.clearReportTimeMotion();this.setData({reportTimeWheel:null,reportTimeOpen:false,reportTimePicking:false,reportTimeError:''});},
  openReportDateTime(event){
    const part=event.currentTarget.dataset.part;
    if(!['start','end'].includes(part)||this.data.actionBusy||!this.reportManagementAllowed()||!this.data.reportPanel?.isEditor||this.data.reportPeopleMounted)return;
    try{const wheel=reportModel.createDateWheel(this.data.reportEditor,part);this.clearReportTimeMotion();const revision=this.timeMotionRevision;
      this.setData({reportTimeWheel:wheel,reportTimeOpen:false,reportTimePicking:false,reportTimeError:''},()=>{this.timeOpenFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.timeMotionRevision&&this.data.reportPanel)this.setData({reportTimeOpen:true});},16);});
    }catch(error){this.setData({reportError:error.message});}
  },
  onReportDateWheelChange(event){if(!this.data.reportTimeOpen||!this.data.reportTimeWheel)return;try{this.setData({reportTimeWheel:reportModel.updateDateWheel(this.data.reportTimeWheel,event.detail.value),reportTimeError:''});}catch(error){this.setData({reportTimeError:error.message});}},
  onReportDateWheelStart(){if(this.data.reportTimeOpen)this.setData({reportTimePicking:true});},
  onReportDateWheelEnd(){this.setData({reportTimePicking:false});},
  closeReportDateTime(){this.clearReportTimeMotion();const revision=this.timeMotionRevision;this.setData({reportTimeOpen:false,reportTimePicking:false});this.timeCloseTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.timeMotionRevision)this.setData({reportTimeWheel:null,reportTimeError:''});},this.data.reduceMotion?100:180);},
  confirmReportDateTime(){
    const wheel=this.data.reportTimeWheel;if(!wheel||!this.data.reportTimeOpen||this.data.reportTimePicking)return;
    try{const {date,time}=reportModel.dateWheelStrings(wheel),part=wheel.part,form=this.data.reportEditor;
      if(date!==form[part+'Date']||time!==form[part+'Time']){const values={[part+'Date']:date,[part+'Time']:time,[part+'Changed']:true},draft={...form,...values},times=reportModel.editorTimes(draft);reportModel.effectiveSeconds(this.reportTask,times.actualStartedAt,times.actualEndedAt);this.updateReportEditor(values);this.recalculateReport();}
      this.closeReportDateTime();
    }catch(error){this.setData({reportTimeError:error.message});}
  },
  clearReportPeopleMotion(){if(this.peopleOpenFrame!=null)clearTimeout(this.peopleOpenFrame);if(this.peopleCloseTimer!=null)clearTimeout(this.peopleCloseTimer);this.peopleOpenFrame=null;this.peopleCloseTimer=null;this.peopleMotionRevision=(this.peopleMotionRevision||0)+1;},
  resetReportPeople(){this.clearReportPeopleMotion();this.setData({reportPeopleMounted:false,reportPeopleOpen:false,reportPeopleQuery:'',reportPeopleGroups:[],reportPeopleCollapsed:[]});},
  updateReportPeople(){
    const employees=this.data.reportOptions.employees,selected=employees.find(person=>String(person.id)===String(this.data.reportEditor?.workerId));
    const result=reportModel.peopleGroups(employees,this.data.reportPeopleQuery,this.data.reportPeopleExpanded,selected?.id,this.data.reportPeopleCollapsed,this.data.reportOptions.peopleGroupConfig);
    this.setData({reportPeopleGroups:result.groups,reportPeopleTotal:result.total});
  },
  openReportPeople(){
    if(this.data.actionBusy||!this.reportManagementAllowed()||!this.data.reportPanel?.isEditor)return;
    this.clearReportPeopleMotion();const revision=this.peopleMotionRevision,selected=this.data.reportOptions.employees.find(person=>String(person.id)===String(this.data.reportEditor.workerId));
    const departments=Array.isArray(selected?.departments)?selected.departments.filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()):[];
    this.setData({reportPeopleMounted:true,reportPeopleOpen:false,reportPeopleQuery:'',reportPeopleExpanded:departments.length?departments:['未分部门'],reportPeopleCollapsed:[],reportPeopleInstant:false},()=>{
      this.updateReportPeople();this.peopleOpenFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.peopleMotionRevision&&this.data.reportPanel)this.setData({reportPeopleOpen:true});},16);
    });
  },
  closeReportPeople(){
    this.clearReportPeopleMotion();const revision=this.peopleMotionRevision;this.setData({reportPeopleOpen:false});
    this.peopleCloseTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.peopleMotionRevision)this.setData({reportPeopleMounted:false});},this.data.reduceMotion?100:180);
  },
  onReportPeopleSearch(event){this.setData({reportPeopleQuery:event.detail.value,reportPeopleCollapsed:[],reportPeopleInstant:true});this.updateReportPeople();},
  clearReportPeopleSearch(){this.onReportPeopleSearch({detail:{value:''}});},
  toggleReportDepartment(event){
    const key=event.currentTarget.dataset.key,group=this.data.reportPeopleGroups.find(row=>row.key===key);if(!group)return;
    const field=this.data.reportPeopleQuery.trim()?'reportPeopleCollapsed':'reportPeopleExpanded',values=this.data[field];
    this.setData({[field]:values.includes(key)?values.filter(value=>value!==key):values.concat(key),reportPeopleInstant:false});this.updateReportPeople();
  },
  selectReportEmployee(event){
    if(!this.data.reportPeopleOpen||this.data.actionBusy)return;const id=String(event.currentTarget.dataset.id),index=this.data.reportOptions.employees.findIndex(person=>String(person.id)===id);
    if(index<0)return;this.onReportWorker({detail:{value:index}});this.closeReportPeople();
  },
  stopProcessBubble() {},
  onReportGood(event) {this.setData({reportGood:event.detail.value,reportError:''});},
  onReportBad(event) {this.setData({reportBad:event.detail.value,reportError:''});if(event.detail.value==='0'&&this.data.reportEditor)this.updateReportEditor({defects:this.data.reportEditor.defects.map(row=>({...row,selected:false,quantity:''}))});},
  toggleReportExtra(){this.setData({reportExtra:!this.data.reportExtra});},
  reportEditorBaseHeight(){const viewport=wx.getWindowInfo?.()||wx.getSystemInfoSync?.()||{};return Math.max(280,Math.min(520,(viewport.windowHeight||740)-48));},
  clearReportEditorMotion(){if(this.reportExpandFrame!=null)clearTimeout(this.reportExpandFrame);this.reportExpandFrame=null;this.reportEditorDrag=null;},
  reportEditorResizeStart(event){
    if(event.touches?.length!==1||!this.data.reportPanel?.isEditor||this.data.actionBusy||this.data.reportPeopleMounted||this.data.reportTimeWheel)return;
    this.clearReportEditorMotion();this.reportEditorDrag={y:event.touches[0].clientY,height:this.data.reportEditorHeight};
    this.setData({reportExpandStyle:''});
  },
  reportEditorResizeMove(event){
    const point=event.touches?.[0],drag=this.reportEditorDrag;if(!point||!drag)return;
    const max=(wx.getWindowInfo?.()?.windowHeight||740)-32;
    this.setData({reportEditorHeight:Math.max(Math.min(310,max),Math.min(max,drag.height+drag.y-point.clientY))});
  },
  reportEditorResizeEnd(){this.reportEditorDrag=null;},
  toggleReportDefects(){
    if(this.data.actionBusy||!this.data.reportPanel?.isEditor)return;
    this.clearReportEditorMotion();const open=!this.data.reportDefectsOpen,viewport=wx.getWindowInfo?.()||wx.getSystemInfoSync?.()||{},height=open?Math.max(280,(viewport.windowHeight||740)-32):this.reportEditorBaseHeight(),from=this.data.reportEditorHeight||this.reportEditorBaseHeight();
    this.setData({reportDefectsOpen:open,reportEditorHeight:height,reportExpandStyle:this.data.reduceMotion?'':'transform:scaleY('+from/height+');transition:none;'},()=>{this.reportExpandFrame=setTimeout(()=>{if(!this.unloaded&&this.data.reportPanel)this.setData({reportExpandStyle:this.data.reduceMotion?'':'transform:scaleY(1);transition:transform 240ms cubic-bezier(.32,.72,0,1);'});},16);});
  },
  updateReportEditor(values){const editor={...this.data.reportEditor,...values},count=editor.defects.filter(row=>row.selected).length;this.setData({reportEditor:editor,reportError:'',reportDefectText:count?'已选 '+count+' 项':''});},
  onReportWorker(event){const index=Number(event.detail.value),person=this.data.reportOptions.employees[index];if(person)this.updateReportEditor({workerIndex:index,workerId:String(person.id),workerName:person.name});},
  onReportField(event){const field=event.currentTarget.dataset.field;if(!['hours','minutes','materialProcess'].includes(field))return;this.updateReportEditor({[field]:event.detail.value});},
  onReportTime(event){
    const field=event.currentTarget.dataset.field;if(!['startDate','startTime','endDate','endTime'].includes(field))return;
    this.updateReportEditor({[field]:event.detail.value,[field.startsWith('start')?'startChanged':'endChanged']:true});this.recalculateReport();
  },
  recalculateReport(){
    try{const times=reportModel.editorTimes(this.data.reportEditor),seconds=reportModel.effectiveSeconds(this.reportTask,times.actualStartedAt,times.actualEndedAt);this.updateReportEditor({...reportModel.editorDurationFields(seconds),punchMinutes:reportModel.punchMinutesBetween(times.actualStartedAt,times.actualEndedAt)?.toFixed(2)??''});}
    catch(error){this.setData({reportError:error.message});}
  },
  toggleReportDefect(event){const code=event.currentTarget.dataset.code;this.updateReportEditor({defects:this.data.reportEditor.defects.map(row=>row.code===code?{...row,selected:!row.selected,quantity:row.quantity||this.data.reportBad}:row)});},
  onReportDefectQuantity(event){const code=event.currentTarget.dataset.code;this.updateReportEditor({defects:this.data.reportEditor.defects.map(row=>row.code===code?{...row,quantity:event.detail.value}:row)});},
  async confirmReportAction() {
    const panel=this.data.reportPanel;if(!panel||this.data.actionBusy||!this.reportManagementAllowed()||this.data.reportPeopleMounted||this.data.reportTimeWheel)return;
    if(this.data.employeeView&&!['createReport','editReport','deleteReport'].includes(panel.action))return;
    const input={reportId:panel.reportId};
    if(panel.isEditor){
      if(!/^\d+$/.test(this.data.reportGood)||!/^\d+$/.test(this.data.reportBad))return this.setData({reportError:'请填写非负整数的合格数和不良数。'});
      input.goodQuantity=Number(this.data.reportGood);input.defectiveQuantity=Number(this.data.reportBad);
      try{Object.assign(input,reportModel.editorPayload(this.data.reportEditor,this.data.reportOptions.employees));}
      catch(error){return this.setData({reportError:error.message});}
    }
    this.setData({actionBusy:true,reportError:''});
    try{const meta={expectedVersion:panel.version,operationId:this.reportOperationId},result=this.data.processDetailMounted?await api[panel.action==='createReport'?'createProcessReport':panel.action==='deleteReport'?'deleteProcessReport':'editProcessReport'](this.orderId,this.data.processDetail.id,input,meta):await api.executeExecutionAction(panel.action,input,meta);this.setData({reportPanel:null});this.processReportsPollCount=0;if(this.data.processDetailMounted)await this.loadProcessReports();else await this.loadExecution();wx.showToast({title:result?.pendingGroupApproval?'已保存，待组长审批':result?.queued?'已保存，正在同步':panel.action==='createReport'?'报工已新建':panel.action==='deleteReport'?'已删除':'报工记录已更新',icon:'none'});}
    catch(error){this.setData({reportError:error.message||'操作失败，请重试。'});}finally{this.setData({actionBusy:false});}
  },
  chooseProcess(event) {
    if(!this.data.dispatchEnabled||!this.data.canDispatch)return;
    const row = this.data.processes.find(item => item.id === Number(event?.currentTarget?.dataset?.id));
    if (!row) return;
    
    if(this.data.canDispatch&&row.selectable)this.setData({selectedProcessId:row.id,selectedProcessName:row.name});
  },
  openDispatch() {
    this.updateView();
    if (!this.data.dispatchEnabled) return;
    const selected = this.data.processes.find(row => row.id === this.data.selectedProcessId && row.selectable);
    getApp().globalData.dispatchOrder = { ...this.data.order };
    getApp().globalData.dispatchPreferredProcess = selected?.id || null;
    wx.navigateTo({ url: '/workspace/pages/dispatch/dispatch?projectId=' + encodeURIComponent(this.orderId) });
  },
  previewImage() {
    if (this.data.order?.imageUrl && !this.data.imageFailed) this.openProductPreview?.(this.data.order.imageUrl,'#detail-product-photo');
  },
  ...photo.methods,
  imageError() { this.setData({ imageFailed: true }); },
  returnToOrders() { wx.navigateBack(); }
},'details'));
