const layerBack=require('../../utils/layer-back');
const formal=require('../../utils/live-workspace');
const api=require('../../utils/api');
const model=require('../../utils/detail-model');
const worker=require('../../utils/worker-model');
const photo=require('../../utils/glass-image-viewer');
const segments=require('../../utils/glass-segments');
const {morph}=require('../../utils/liquid-geometry');
const dates=require('../../utils/task-overview');
const selfService=require('../../utils/worker-self-service');
const embroidery=require('../../utils/worker-embroidery');
const orderTools=require('../../utils/worker-order-tools');
const orderOperations=require('../../utils/order-operations');
const navigation=require('../../utils/worker-navigation');
const selfDefects=require('../../utils/worker-self-defects');
const {refreshCurrentOrder}=require('../../utils/order-refresh');
Page(formal.wrap(layerBack.page({
  ...photo.methods,...segments.methods,...selfService.methods,...embroidery.methods,...orderTools.methods,...orderOperations.methods,...navigation.methods,...selfDefects.methods,
  data:{...photo.data,...segments.data,...selfService.data,...embroidery.data,...orderTools.data,...orderOperations.data,...navigation.data,...selfDefects.data,canOperateOrders:false,loading:false,error:'',version:null,current:null,next:null,activeTask:null,
    paused:[],queued:[],completed:[],records:[],busy:false,activeOrderRefreshing:false,quantityOpen:false,quantityDraftId:'',good:'',quantityError:'',workerName:'员工',workerAvatar:'员',source:'',
    reportsMounted:false,workerReportModal:false,workerTab:'tasks',clockText:'—',workerPanel:null,panelOpen:false,reduceMotion:false,
    visibleRecords:[],workerRecordContextId:'',workerRecordContextHeight:0,recordDateMode:'today',recordDateStart:'',recordDateEnd:'',recordToday:'',recordDateLabel:'今天',recordRangeText:'',recordTotalText:'—',recordTotalLabel:'总报工用时',recordUnknownDurationCount:0,recordUnknownDateCount:0,
    recordDateOptions:[{key:'today',label:'今天'},{key:'yesterday',label:'昨天'},{key:'month',label:'本月'},{key:'custom',label:'自选日期'}],recordFilterOpen:false,recordFilterHeight:0,recordDateCustom:false,recordDateDraft:{start:'',end:''},recordDateError:'',
    workerOrders:[],visibleWorkerOrders:[],workerOrdersLoaded:false,workerOrdersLoading:false,workerOrdersHasMore:false,workerOrdersPage:0,workerOrdersTotal:null,workerOrdersError:'',workerOrderSearchOpen:false,workerOrderKeyword:'',workerOrderStatus:'ALL',
    workerOrderStatuses:[{key:'ALL',label:'全部'},{key:'NOT_STARTED',label:'未开始'},{key:'IN_PROGRESS',label:'进行中'},{key:'FINISHED',label:'已结束'}],
    detailMounted:false,detailVisible:false,detailOrigin:null,detailOrderId:'',detailProcessId:'',
    workerTabs:[{key:'tasks',label:'任务',icon:'home'},{key:'orders',label:'工单',icon:'orders'},{key:'mine',label:'我的',icon:'users'}]},
  async onLoad(){
    if(getApp().globalData.entry?.appRole!=='employee'){this.setData({error:'当前身份不能进入员工任务。'});return;}
    this.setData({reduceMotion:getApp().globalData.reduceMotion===true,canOperateOrders:!this.data.embroideryMode&&getApp().globalData.entry?.canOperateOrders===true});
    if(this.data.canOperateOrders)this.setupOrderOperationMotion();
    this.setupGlassSegments();this.setupWorkerNavigation();
    this._loadPromise=this.refresh();await this._loadPromise;
  },
  onShow(){this.hidden=false;this.orderOperationPageHidden=false;if(this.data.operationPanel?.checking)this.reloadOrderOperations({poll:true});if(this.navGeometry){this.measureGlassNav();this.syncWorkerNavigation(true);}if(this.data.workerOrdersLoaded)this.loadWorkerOrders();if(this.data.version!==null)return this.refresh();},
  onHide(){this.hidden=true;this.orderOperationPageHidden=true;this.stopOrderOperationPolling();clearTimeout(this.clockTimer);this.stopGlassNav();this.navTouch=null;},
  onUnload(){this.unloaded=true;this.readRevision=(this.readRevision||0)+1;this.orderReadRevision=(this.orderReadRevision||0)+1;clearTimeout(this.clockTimer);this.disposeOrderOperationMotion();this.clearWorkerPanelMotion();this.disposeSelfDefects();this.disposeProductPreview();this.disposeGlassSegments();this.clearGlassNav();},
  applyOrderOperationUpdates(orders){
    const updates=new Map(orders.map(order=>[String(order.id),orderOperations.presentation(order)]));
    const workerOrders=this.data.workerOrders.map(row=>{
      const update=updates.get(String(row.id));
      return update?{...row,status:update.status,statusText:update.statusText,priority:update.priority,priorityKnown:update.priorityKnown}:row;
    });
    this.setData({workerOrders});
    this.filterWorkerOrders();
  },
  async refresh({quiet=false,afterReport=false}={}){
    if(this.unloaded||getApp().globalData.entry?.appRole!=='employee')return;
    const revision=this.readRevision=(this.readRevision||0)+1;clearTimeout(this.clockTimer);this.setData({loading:!quiet,error:''});
    try{const response=await api.loadEmployeeWork(this.data.embroideryMode);if(this.unloaded||revision!==this.readRevision)return;
      if(!Array.isArray(response.assignments)||!Number.isSafeInteger(response.version))throw new Error('任务资料未能确认。');
      const rows=model.presentAssignments(response.assignments).map(worker.present),machineMode=this.data.embroideryMode;
      const embroideryTasks=machineMode?rows.filter(row=>['READY','IN_PROGRESS','AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status)):[];
      const selected=machineMode?embroideryTasks.find(row=>row.id===this.selectedEmbroideryTaskId)||embroideryTasks[0]:rows.find(row=>row.isEmployeeCurrent===true);
      const running=selected&&!['READY','PAUSED'].includes(selected.status)?selected:null;
      const current=machineMode?running:running||rows.find(row=>['IN_PROGRESS','AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status));
      if(!machineMode&&selected&&rows.some(row=>row.status==='IN_PROGRESS'&&String(row.id)!==String(selected.id)))throw new Error('当前工单与计时状态不一致，请刷新核对。');
      const queued=machineMode?[]:rows.filter(row=>row.status==='READY').sort((a,b)=>(a.queuePosition??1e9)-(b.queuePosition??1e9)||(a.priority==='URGENT'?0:1)-(b.priority==='URGENT'?0:1)||Date.parse(a.assignedAt)-Date.parse(b.assignedAt));
      this.clockBaseAt=Date.now();this.clockBaseSeconds=(selected||current||queued[0])?.elapsedSeconds;
      this.setData({version:response.version,current:current||null,next:['READY','PAUSED'].includes(selected?.status)?selected:queued[0]||null,activeTask:selected||current||queued[0]||null,queued,
        paused:machineMode?[]:rows.filter(row=>row.status==='PAUSED'),embroideryTasks,completed:rows.filter(row=>row.status==='COMPLETED'),records:worker.records(rows),workerTaskOrderIds:[...new Set(rows.map(row=>String(row.orderId)))],loading:false,
        workerName:response.employee?.name||rows[0]?.workerName||'员工',workerAvatar:(response.employee?.name||rows[0]?.workerName||'员').trim().slice(-1),source:response.source==='workspace-live'?(machineMode?'绣花任务 · 报工同步黑湖':'本系统任务 · 报工同步黑湖'):'',updatedText:model.time(response.fetchedAt)});
      this.updateWorkerClock();
      this.updateWorkerRecords();
      this.filterWorkerOrders();
      this.syncSelfService(response,rows);
      return true;
    }catch(error){
      if(!this.unloaded&&revision===this.readRevision){
        const message=afterReport?'报工已保存，任务列表暂未刷新。':error.message||'任务读取失败。';
        this.setData({loading:false,...(quiet&&this.data.next?.canStart?{}:{error:message})});
      }
      return false;
    }
  },
  updateWorkerClock(){
    clearTimeout(this.clockTimer);if(this.unloaded||this.hidden)return;
    const task=this.data.current,running=task?.status==='IN_PROGRESS'&&!task.timerPaused;
    const seconds=typeof this.clockBaseSeconds==='number'?this.clockBaseSeconds+(running?Math.max(0,Date.now()-this.clockBaseAt)/1000:0):null;
    this.setData({clockText:worker.clockText(seconds)});
    if(running)this.clockTimer=setTimeout(()=>this.updateWorkerClock(),1000);
  },
  setWorkerTab(event){
    const tab=event.currentTarget.dataset.tab;if(!['orders','tasks','mine','reports'].includes(tab)||tab==='reports'&&(!this.data.selfServiceEnabled||this.data.embroideryMode)||this.data.workerReportModal||this.data.busy||this.data.workerPanel||this.data.operationPanel||this.data.imageViewer||this.data.detailMounted||this.openingDetail)return;
    if(tab!==this.data.workerTab)wx.hideKeyboard?.();
    this.setData({workerTab:tab,reportsMounted:this.data.reportsMounted||tab==='reports'});this.syncWorkerNavigation(event.detail?.keyboard===true);
    if(tab==='orders'&&!this.data.workerOrdersLoaded)return this.loadWorkerOrders();
  },
  onReportWorkspaceState(event){this.setData({workerReportModal:event.detail.modal===true||event.detail.busy===true});},
  async refreshCurrentView(){
    if(this.data.workerTab==='orders')return this.loadWorkerOrders();
    const task=this.data.activeTask;
    if(this.data.workerTab!=='tasks'||!task?.orderId)return this.refresh();
    if(this.data.activeOrderRefreshing)return;
    if(task.orderInfo?.status==='DELETED')return this.refresh();
    this.setData({activeOrderRefreshing:true,error:''});
    const sameTask=()=>!this.unloaded&&this.data.workerTab==='tasks'&&this.data.activeTask?.id===task.id;
    try{await refreshCurrentOrder(api,task.orderId,{active:sameTask,maxAttempts:6});}
    catch(error){if(sameTask())wx.showToast({title:error.message||'工序刷新失败，请稍后再试',icon:'none'});}
    finally{
      if(sameTask())await this.refresh();
      if(!this.unloaded)this.setData({activeOrderRefreshing:false});
    }
  },
  async loadWorkerOrders({more=false}={}){
    if(this.unloaded||this.data.workerOrdersLoading||more&&!this.data.workerOrdersHasMore||getApp().globalData.entry?.appRole!=='employee')return;
    const pageNum=more?this.data.workerOrdersPage+1:1;
    const revision=this.orderReadRevision=(this.orderReadRevision||0)+1;this.setData({workerOrdersLoading:true,workerOrdersError:''});
    try{
      const response=await api.loadEmployeeOrders(pageNum,this.data.workerOrderKeyword.trim(),{sort:this.data.workerOrderSort,status:this.data.workerOrderStatus});if(this.unloaded||revision!==this.orderReadRevision)return;
      if(!Array.isArray(response.orders))throw new Error('工单资料未能确认。');
      const loaded=more?this.data.workerOrders.concat(worker.presentOrders(response.orders)):worker.presentOrders(response.orders);
      this.setData({workerOrders:[...new Map(loaded.map(row=>[row.id,row])).values()],workerOrdersPage:pageNum,workerOrdersTotal:response.total??null,workerOrdersHasMore:response.hasMore===true,workerOrdersLoaded:true,workerOrdersLoading:false});this.filterWorkerOrders();
    }catch(error){if(!this.unloaded&&revision===this.orderReadRevision)this.setData({workerOrdersLoading:false,workerOrdersError:error.message||'工单读取失败，请重试。'});}
  },
  loadMoreWorkerOrders(){return this.loadWorkerOrders({more:true});},
  filterWorkerOrders(){this.setData({visibleWorkerOrders:worker.filterOrders(this.data.workerOrders,this.data.workerOrderKeyword,this.data.workerOrderStatus,{scope:this.data.workerOrderScope,taskOrderIds:this.data.workerTaskOrderIds,sort:this.data.workerOrderSort})});},
  toggleWorkerOrderSearch(){const open=!this.data.workerOrderSearchOpen;this.setData({workerOrderSearchOpen:open,workerOrderKeyword:open?this.data.workerOrderKeyword:''});this.filterWorkerOrders();},
  onWorkerOrderSearch(event){this.setData({workerOrderKeyword:event.detail.value,selfError:''});this.filterWorkerOrders();},
  selectWorkerOrderStatus(event){const status=event.currentTarget.dataset.status;if(!this.data.workerOrderStatuses.some(row=>row.key===status))return;this.setData({workerOrderStatus:status});this.filterWorkerOrders();if(getApp().globalData.dataMode==='live')this.loadWorkerOrders();},
  previewWorkerOrderImage(event){const order=this.data.workerOrders.find(row=>String(row.id)===String(event.currentTarget.dataset.id));if(order?.imageUrl&&!order.imageFailed)this.openProductPreview(order.imageUrl,'#worker-order-image-'+order.id);},
  workerOrderImageError(event){const id=String(event.currentTarget.dataset.id);this.setData({workerOrders:this.data.workerOrders.map(row=>String(row.id)===id?{...row,imageFailed:true}:row)});this.filterWorkerOrders();},
  openWorkerOrder(event){
    if(this.data.workerTab!=='orders')return;
    const {id,process}=event.currentTarget.dataset;
    const order=this.data.workerOrders.find(row=>String(row.id)===String(id));
    if(process!=null&&!order?.processes?.some(row=>String(row.id)===String(process)))return;
    this.showWorkerOrder(order,'#worker-order-card-'+order?.id,process);
  },
  openActiveOrder(){
    const task=this.data.activeTask,order=task?.orderInfo;if(!task||!order)return;
    if(String(task.orderId)!==String(order.id)){this.setData({error:'工单资料归属未能确认，请刷新后重试。'});return;}
    this.showWorkerOrder(worker.presentOrders([order])[0],'#worker-active-order');
  },
  showWorkerOrder(order,selector,processId){
    if(!order||order.id==null||getApp().globalData.entry?.appRole!=='employee'||this.data.busy||this.unloaded||this.openingDetail||this.data.detailMounted||this.data.workerPanel||this.data.imageViewer)return;
    wx.hideKeyboard?.();
    getApp().globalData.viewOrder={...order};this.openingDetail=true;
    const show=origin=>{this.openingDetail=false;if(!this.unloaded)this.setData({detailMounted:true,detailVisible:true,detailOrderId:String(order.id),detailProcessId:processId==null?'':String(processId),detailOrigin:origin||null});};
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();if(query)query.select(selector).boundingClientRect().exec(rects=>show(rects?.[0]));else show(null);
  },
  closeDetail(){this.setData({detailVisible:false});},
  reopenDetail(){if(this.data.detailMounted)this.setData({detailVisible:true});},
  async detailClosed(){
    if(this.data.detailVisible)return;
    const id=Number(this.data.detailOrderId);
    this.setData({detailMounted:false,detailOrderId:''});
    if(!this.data.workerOrders.some(row=>row.id===id))return;
    const revision=this.orderReadRevision;
    try{
      const {order}=await api.loadOrderDetail(id);
      if(this.unloaded||revision!==this.orderReadRevision||order?.id!==id)return;
      const loaded=this.data.workerOrders.findIndex(row=>row.id===id),visible=this.data.visibleWorkerOrders.findIndex(row=>row.id===id);
      if(loaded<0)return;
      const current=this.data.workerOrders[loaded],next=worker.presentOrders([order])[0];
      if(current.imageFailed&&current.imageUrl===next.imageUrl)next.imageFailed=true;
      this.setData({['workerOrders['+loaded+']']:next,...(visible<0?{}:{['visibleWorkerOrders['+visible+']']:next})});
      if(['status','code','product','productCode','productName','productSpecification','startAt'].some(key=>next[key]!==current[key]))this.filterWorkerOrders();
    }catch{}
  },
  updateWorkerRecords(){const today=dates.dayKey(new Date().toISOString()),view=worker.recordView(this.data.records,{mode:this.data.recordDateMode,today,start:this.data.recordDateStart,end:this.data.recordDateEnd});if(this.data.version===null)view.recordTotalText='—';this.setData({recordToday:today,...view});},
  openWorkerRecords(){if(this.data.workerTab==='mine'){this.setData({workerRecordContextId:'',workerRecordContextHeight:0});this.updateWorkerRecords();this.showWorkerPanel('records','#worker-records-entry');}},
  toggleWorkerReportContext(event){
    if(this.unloaded||this.data.workerPanel?.kind!=='records'||!this.data.panelOpen)return;
    const id=String(event.currentTarget.dataset.id),index=Number(event.currentTarget.dataset.index),row=this.data.visibleRecords[index];if(!row||String(row.id)!==id)return;
    const revision=this.recordContextRevision=(this.recordContextRevision||0)+1,panelRevision=this.panelRevision;
    if(this.data.workerRecordContextId===id)return this.setData({workerRecordContextId:'',workerRecordContextHeight:0});
    this.setData({workerRecordContextId:id,workerRecordContextHeight:0});
    const expand=rects=>{if(!this.unloaded&&revision===this.recordContextRevision&&panelRevision===this.panelRevision&&this.data.workerRecordContextId===id&&this.data.visibleRecords.some(item=>String(item.id)===id))this.setData({workerRecordContextHeight:Math.ceil(rects?.[0]?.height||70)+5});};
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();if(query)query.select('#worker-report-context-'+index).boundingClientRect().exec(expand);else expand();
  },
  closeWorkerRecordFilter(){this.recordFilterRevision=(this.recordFilterRevision||0)+1;this.setData({recordFilterOpen:false,recordFilterHeight:0,recordDateError:''});},
  toggleWorkerRecordFilter(){
    if(this.unloaded||this.data.workerPanel?.kind!=='records')return;
    if(this.data.recordFilterOpen)return this.closeWorkerRecordFilter();
    const revision=this.recordFilterRevision=(this.recordFilterRevision||0)+1;
    this.setData({recordFilterOpen:true,recordDateCustom:this.data.recordDateMode==='custom',recordDateDraft:{start:this.data.recordDateStart||this.data.recordToday,end:this.data.recordDateEnd||this.data.recordToday},recordDateError:''},()=>this.measureWorkerRecordFilter(revision));
  },
  measureWorkerRecordFilter(revision=this.recordFilterRevision){
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();
    const expand=rects=>{if(!this.unloaded&&revision===this.recordFilterRevision&&this.data.recordFilterOpen)this.setData({recordFilterHeight:Math.ceil(rects?.[0]?.height||210)});};
    if(query)query.select('#worker-record-filter-content').boundingClientRect().exec(expand);else expand();
  },
  chooseWorkerRecordDate(event){
    const mode=event.currentTarget.dataset.mode;if(this.data.workerPanel?.kind!=='records'||!this.data.recordDateOptions.some(row=>row.key===mode))return;
    if(mode==='custom'){this.setData({recordDateCustom:true,recordDateError:''},()=>this.measureWorkerRecordFilter());return;}
    this.setData({recordDateMode:mode});this.updateWorkerRecords();this.closeWorkerRecordFilter();
  },
  onWorkerRecordDate(event){const field=event.currentTarget.dataset.field;if(this.data.workerPanel?.kind==='records'&&this.data.recordFilterOpen&&this.data.recordDateCustom&&['start','end'].includes(field))this.setData({recordDateDraft:{...this.data.recordDateDraft,[field]:event.detail.value},recordDateError:''},()=>this.measureWorkerRecordFilter());},
  applyWorkerRecordDates(){
    if(this.data.workerPanel?.kind!=='records'||!this.data.recordFilterOpen||!this.data.recordDateCustom)return;const {start,end}=this.data.recordDateDraft;
    if(!dates.validDay(start)||!dates.validDay(end)||start>end||end>this.data.recordToday){this.setData({recordDateError:'请选择有效日期，结束日期不能早于开始日期或晚于今天。'},()=>this.measureWorkerRecordFilter());return;}
    this.setData({recordDateMode:'custom',recordDateStart:start,recordDateEnd:end});this.updateWorkerRecords();this.closeWorkerRecordFilter();
  },
  previewWorkerImage(event){const task=this.data.activeTask;if(task?.imageUrl&&!task.imageFailed)this.openProductPreview(task.imageUrl,event?.currentTarget?.dataset?.anchor||'#worker-product-image');},
  workerImageError(event){const task=this.data.activeTask;if(!task||String(event.currentTarget.dataset.id)!==String(task.id))return;this.setData({activeTask:{...task,imageFailed:true}});},
  openWorkerQueue(){if(this.data.queued.length)this.showWorkerPanel('queue','#worker-queue-entry');},
  openWorkerPaused(){if(this.data.paused.length)this.showWorkerPanel('paused','#worker-paused-entry');},
  clearWorkerPanelMotion(){this.panelRevision=(this.panelRevision||0)+1;this.recordFilterRevision=(this.recordFilterRevision||0)+1;this.selfContextRevision=(this.selfContextRevision||0)+1;clearTimeout(this.panelEnterTimer);clearTimeout(this.panelCloseTimer);},
  showWorkerPanel(kind,selector){
    if(this.unloaded||this.data.imageViewer||this.data.detailMounted||!['queue','paused','quantity','records','self','orderTools'].includes(kind))return;
    this.clearWorkerPanelMotion();const revision=this.panelRevision,info=wx.getWindowInfo?.()||{},width=info.windowWidth||390,height=info.windowHeight||740;
    const quantityHeight=this.data.current?.isSelfService&&this.data.current?.isQualityInspection?486:406;
    const toolHeight=116+this.data.workerOrderToolOptions.length*58+(this.data.workerOrderTool==='scope'?64:0);
    const panelHeight=Math.min(kind==='orderTools'?toolHeight:kind==='records'?560:kind==='self'?600:kind==='quantity'?quantityHeight:400,height-32),rect={left:12,top:(height-panelHeight)/2,width:width-24,height:panelHeight};
    const show=origin=>{
      if(this.unloaded||revision!==this.panelRevision)return;
      this.panelSource=origin||{left:width/2-24,top:height-100,width:48,height:44};
      const shape=morph(this.panelSource,rect,16);
      this.setData({workerPanel:{kind,...shape,anchorId:selector?.slice(1)||''},panelOpen:false,quantityOpen:kind==='quantity',recordFilterOpen:false,recordFilterHeight:0,recordDateError:''},()=>{
        this.panelEnterTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.panelRevision)this.setData({panelOpen:true});},16);
      });
    };
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();if(query&&selector)query.select(selector).boundingClientRect().exec(rects=>show(rects?.[0]));else show(null);
  },
  closeWorkerPanel(afterClose){
    if(this.data.busy||!this.data.workerPanel)return;
    if(this.data.selfDefectEditor)return this.closeSelfDefect();
    if(this.data.workerPanel.kind==='self'){
      this.selfContextRevision=(this.selfContextRevision||0)+1;
      this.setData({selfContextLoading:false});
    }
    wx.hideKeyboard?.();
    this.clearWorkerPanelMotion();const revision=this.panelRevision;this.setData({panelOpen:false,quantityOpen:false});
    this.panelCloseTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.panelRevision){this.setData({workerPanel:null});if(typeof afterClose==='function')afterClose();}},this.data.reduceMotion?100:260);
  },
  workerStopBubble(){},
  onQuantityKeyboard(event){
    if(this.data.workerPanel?.kind!=='quantity'||!this.data.panelOpen||this.data.selfDefectEditor)return;
    const keyboard=Math.max(0,Number(event.detail.height)||0),info=wx.getWindowInfo?.()||{},width=info.windowWidth||390,height=info.windowHeight||740;
    const panelHeight=Math.min(this.data.current?.isSelfService&&this.data.current?.isQualityInspection?486:406,Math.max(240,height-keyboard-24));
    const rect={left:12,top:Math.max(8,(height-keyboard-panelHeight)/2),width:width-24,height:panelHeight};
    this.setData({workerPanel:{...this.data.workerPanel,...morph(this.panelSource,rect,16)}});
  },
  async startWork(){const task=this.data.current?.canStart?this.data.current:this.data.next;if(!task?.canStart||this.data.busy||this.data.loading)return;await this.run('start',{assignmentId:task.id});},
  async toggleWorkTimer(){const task=this.data.current;if(!task||this.data.busy||this.data.loading)return;if(task.canStart)return this.startWork();if(task.canResumeTimer)await this.run('resumeTimer',{assignmentId:task.id});else if(task.canPauseTimer)await this.run('pauseTimer',{assignmentId:task.id});},
  async endWork(){
    const task=this.data.current;if(!task?.canFinish||this.data.busy||this.data.loading)return;
    if(await this.run('end',{assignmentId:task.id}))this.openQuantity();
  },
  async exitClosedSelfTask(){
    const task=this.data.activeTask;
    if(!task?.canExitClosedSelfTask||this.data.busy||this.data.loading||this.exitPrompt)return;
    this.exitPrompt=true;
    try{
      const confirmed=await new Promise(resolve=>wx.showModal({title:'退出当前任务',content:'黑湖工单或工序已关闭。退出后保留原计时记录，不会再提交报工。',confirmText:'退出任务',success:result=>resolve(result.confirm),fail:()=>resolve(false)}));
      if(!confirmed||this.unloaded||this.data.activeTask?.id!==task.id||!this.data.activeTask.canExitClosedSelfTask)return;
      if(await this.run('exitClosedSelfTask',{assignmentId:task.id})){
        this.resetSelfDefects();
        this.setData({quantityDraftId:'',good:''});
        this.closeWorkerPanel();
        wx.showToast({title:'已退出，可以开始下一单',icon:'none'});
      }
    }finally{this.exitPrompt=false;}
  },
  async skipClosedAssignment(){
    const task=this.data.activeTask;
    if(!task?.canSkipClosedAssignment||this.data.busy||this.data.loading)return;
    if(await this.run('skipClosedAssignment',{assignmentId:task.id})){
      wx.showToast({title:'已跳过这单',icon:'none'});
      void this.refresh();
    }
  },
  refreshQuantityTask(){
    if(this.data.busy||this.data.loading||this.data.activeOrderRefreshing)return;
    return this.closeWorkerPanel(()=>this.refreshCurrentView());
  },
  openQuantity(){
    const task=this.data.current;
    if(!task?.canConfirmQuantity)return;
    const newDraft=this.data.quantityDraftId!==task.id;
    if(newDraft){
      this.resetSelfDefects();
      this.setData({quantityDraftId:task.id,good:this.data.embroideryMode?'':worker.confirmationQuantity(task)});
    }
    this.setData({quantityError:''});this.showWorkerPanel('quantity','#worker-finish-entry');
    if(newDraft&&this.data.embroideryMode)return this.loadMachineQuantity(task);
  },
  dismissWorkerPanel(){
    const {workerPanel,current,embroideryMode,selfDefectEditor}=this.data;
    if(embroideryMode&&workerPanel?.kind==='quantity'&&!selfDefectEditor&&current?.canConfirmQuantity&&current.canReturnToWork){
      return this.returnToWork();
    }
    return this.closeWorkerPanel();
  },
  async cancelQuantity(){
    const task=this.data.current;if(!task||this.data.busy||this.data.loading||this.data.selfDefectEditor)return;
    if(!task.isSelfService)return this.returnToWork();
    if(!task.canCancelSelfReport)return;
    if(await this.run('cancelSelfReport',{assignmentId:task.id})){this.resetSelfDefects();this.setData({quantityDraftId:'',good:''});this.closeWorkerPanel();wx.showToast({title:'已撤销此次报工',icon:'success'});}
  },
  async returnToWork(){
    const task=this.data.current;if(!task||this.data.busy||this.data.loading)return;
    if(!task.canReturnToWork){if(task.canConfirmQuantity)this.setData({quantityError:task.returnToWorkBlockedReason||'当前任务暂不能返回计时，请刷新后重试。'});return;}
    if(await this.run('cancelEnd',{assignmentId:task.id})){
      if(this.data.embroideryMode){
        this.resetSelfDefects();
        this.setData({quantityDraftId:'',good:''});
      }
      this.closeWorkerPanel();
    }
  },
  onGood(event){if(!this.data.busy&&!this.data.selfDefectEditor){this.embroideryQuantityTouched=true;this.setData({good:event.detail.value,quantityError:''});}},
  async confirmQuantity(){
    const task=this.data.current;if(!task?.canConfirmQuantity||this.data.busy||this.data.selfDefectEditor)return;
    if(!/^\d+$/.test(this.data.good)||!Number.isSafeInteger(Number(this.data.good)))return this.setData({quantityError:'请填写有效的本次数量，不能留空。'});
    const quality=(task.isSelfService||this.data.embroideryMode)&&task.isQualityInspection,bad=quality?Number(this.data.selfDefectQuantity):0;
    if(quality&&(!/^\d+$/.test(this.data.selfDefectQuantity)||!Number.isSafeInteger(bad)||bad<0))return this.setData({quantityError:'请确认本次不良数量。'});
    if(quality&&this.data.selfDefectItems.reduce((sum,row)=>sum+row.quantity,0)!==bad)return this.setData({quantityError:'请核对不良品项数量。'});
    if(await this.run('finish',{assignmentId:task.id,goodQuantity:Number(this.data.good),defectiveQuantity:bad,...(quality?{defectCodes:this.data.selfDefectCodes,defectItems:this.data.selfDefectItems}:{})})){
      this.setData({quantityDraftId:''});this.resetSelfDefects();this.closeWorkerPanel();
      const result=this.lastExecutionResult;
      const title=result?.pendingGroupApproval?'已保存，待组长审批':result?.queued?'已保存，正在同步'
        :result?.accepted&&result.status!=='SUCCEEDED'?'已保存，请后台核对':'报工已保存';
      wx.showToast({title,icon:result?.accepted?'none':'success'});
      void this.refresh({quiet:true,afterReport:true});
    }
  },
  async run(action,input){
    this.setData({busy:true,quantityError:'',error:''});
    const machineStart=this.data.embroideryMode&&action==='selfStart';
    const operationId=machineStart?this.embroideryStartKey(input):'worker-'+action+'-'+Date.now()+'-'+(this.operationSequence=(this.operationSequence||0)+1)+'-'+input.assignmentId;
    try{
      this.lastExecutionResult=await api.executeExecutionAction(action,input,{expectedVersion:this.data.version,expectedTimingRevision:(this.data.current||this.data.next)?.timingRevision,operationId,embroidery:this.data.embroideryMode});
      if(machineStart)this.selectedEmbroideryTaskId=this.lastExecutionResult.assignment?.id;
      if(action==='finish'){
        const {assignment,version}=this.lastExecutionResult;
        if(assignment.status==='COMPLETED'){
          const ready=[...this.data.queued,...this.data.paused].find(task=>task.canStartAfterReport);
          const next=ready&&Number.isSafeInteger(version)?{...ready,canStart:true,isEmployeeCurrent:true}:this.data.next;
          this.setData({current:null,next,activeTask:next,version:version??this.data.version});
        }else{
          const current={...this.data.current,...worker.present({...this.data.current,status:assignment.status,
            canConfirmQuantity:false,canReturnToWork:false,canCancelSelfReport:false})};
          this.setData({current,activeTask:current});
        }
        return true;
      }
      if(action==='skipClosedAssignment')return true;
      const refreshed=await this.refresh();
      if(!refreshed&&this.data.embroideryMode&&action==='cancelEnd')return this.applyEmbroideryResumeReceipt(input.assignmentId,this.lastExecutionResult?.assignment);
      return refreshed;
    }
    catch(error){
      await this.refresh();
      const message=error.message||'操作失败，请刷新。';
      if(action==='selfStart')this.setData(machineStart?{selfStartError:message}:{selfError:message});
      else this.setData({error:message,quantityError:this.data.quantityOpen?message:''});
      return false;
    }
    finally{this.setData({busy:false});}
  },
  applyEmbroideryResumeReceipt(id,assignment){
    const task=this.data.current;
    if(task?.id!==id||task.status!=='AWAITING_QUANTITY'||assignment?.id!==id||assignment.status!=='IN_PROGRESS'
      ||assignment.endedAt!==null||!Number.isSafeInteger(assignment.timingRevision)||assignment.timingRevision<=task.timingRevision)return false;
    const current={...task,status:'IN_PROGRESS',statusText:'进行中',timerStateText:assignment.paused?'已暂停':'正在计时',
      endedAt:null,timingRevision:assignment.timingRevision,timerPaused:assignment.paused===true,
      canPauseTimer:!assignment.paused,canResumeTimer:assignment.paused===true,canFinish:true,
      canConfirmQuantity:false,canReturnToWork:false,canCancelSelfReport:false,returnToWorkBlockedReason:''};
    this.clockBaseAt=Date.now();
    this.clockBaseSeconds=task.elapsedSeconds;
    this.setData({current,activeTask:current,error:''});
    this.updateWorkerClock();
    return true;
  }
},'worker'),'worker'));
