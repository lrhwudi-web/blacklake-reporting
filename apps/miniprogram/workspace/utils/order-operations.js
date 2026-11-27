// The order-level priority is separate from dispatch insertion priority and employee timers.
const api=require('./api');
const liquid=require('./liquid-geometry');
const priorities=[{key:'EXTREME',label:'特急'},{key:'URGENT',label:'紧急'},{key:'EXPEDITED',label:'加急'},{key:'PAUSED',label:'暂停'},{key:'NONE',label:'无'}];
const statuses=[{key:'NOT_STARTED',label:'未开始'},{key:'IN_PROGRESS',label:'执行中'},{key:'FINISHED',label:'已结束'}];
function presentation(order){
  const priority=priorities.find(row=>row.key===order.priority),status=statuses.find(row=>row.key===order.status);
  return {...order,statusText:status?.label||order.statusText,priorityText:priority?.key!=='NONE'?priority?.label||'':'',priorityTone:priority?.key||''};
}
const data={operationPanel:null,operationOpen:false,operationClosing:false,operationMotion:null,operationSourceHidden:false,operationLoading:false,operationSaving:false,operationError:'',operationStatus:'',operationPriorities:priorities,operationStatuses:statuses,snapshotEdited:false};
const methods={
  setupOrderOperationMotion(){this.orderOperationResize=()=>{if(this.data.operationPanel&&!this.data.operationClosing)this.measureOrderOperationMotion();};wx.onWindowResize?.(this.orderOperationResize);},
  disposeOrderOperationMotion(){if(this.orderOperationResize)wx.offWindowResize?.(this.orderOperationResize);this.orderOperationResize=null;this.resetOrderOperations();},
  clearOrderOperationMotion(){clearTimeout(this.orderOperationFrame);clearTimeout(this.orderOperationTimer);this.orderOperationFrame=null;this.orderOperationTimer=null;this.orderOperationMotionRevision=(this.orderOperationMotionRevision||0)+1;},
  stopOrderOperationPolling(){clearTimeout(this.orderOperationPollTimer);this.orderOperationPollTimer=null;},
  resetOrderOperations(){this.clearOrderOperationMotion();this.stopOrderOperationPolling();this.orderOperationRevision=(this.orderOperationRevision||0)+1;this.orderOperationId=null;this.orderOperationReceiptId=null;this.orderOperationSavedOrders=null;this.setData({operationPanel:null,operationOpen:false,operationClosing:false,operationMotion:null,operationSourceHidden:false,operationLoading:false,operationSaving:false,operationError:'',operationStatus:''});},
  measureOrderOperationMotion(ready){
    const panel=this.data.operationPanel;if(!panel)return;
    const revision=this.orderOperationMotionRevision,finish=rects=>{
      if(this.unloaded||revision!==this.orderOperationMotionRevision||this.data.operationClosing||!this.data.operationPanel)return;
      const motion=this.data.reduceMotion?null:liquid.morph(rects?.[0],rects?.[1]);
      this.setData({operationMotion:motion,operationSourceHidden:!!motion},()=>ready?.());
    };
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();
    if(!query||this.data.reduceMotion)return finish();
    query.select('#order-operation-'+panel.id).boundingClientRect();
    query.select('.order-operation-sheet').boundingClientRect().exec(finish);
  },
  async openOrderOperations(event){
    if(getApp().globalData.entry?.canOperateOrders!==true||this.data.operationPanel||this.data.listPanel||this.data.workerPanel||this.data.detailMounted||this.data.imageViewer)return;
    const order=this.data.visibleWorkerOrders?.find(row=>String(row.id)===String(event.currentTarget.dataset.id));if(!order)return;
    this.cancelGlassNav?.();this.clearOrderOperationMotion();this.orderOperationId=null;
    this.setData({operationPanel:{id:order.id,code:order.code,priority:order.priority||null,status:order.status,syncPriority:false,canManage:false,version:null},operationOpen:false,operationClosing:false,operationMotion:null,operationSourceHidden:false,operationError:''},()=>{
      this.measureOrderOperationMotion(()=>{const revision=this.orderOperationMotionRevision;this.orderOperationFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.orderOperationMotionRevision&&this.data.operationPanel&&!this.data.operationClosing)this.setData({operationOpen:true});},16);});
    });
    return this.reloadOrderOperations();
  },
  scheduleOrderOperationPoll(revision,remaining,cooldown=false){
    this.stopOrderOperationPolling();
    if(!remaining||this.orderOperationPageHidden)return;
    this.orderOperationPollTimer=setTimeout(()=>{
      if(revision===this.orderOperationRevision&&!this.orderOperationPageHidden)return this.reloadOrderOperations({poll:true,remaining:remaining-1});
    },cooldown?8000:2500);
  },
  async refreshOrderOperations(){
    const panel=this.data.operationPanel;if(!panel||this.data.operationLoading||this.data.operationSaving||this.data.operationClosing)return;
    this.stopOrderOperationPolling();
    const revision=this.orderOperationRevision;
    this.setData({operationLoading:true,operationError:'',operationStatus:'正在安排这张工单的核对…'});
    try{
      await api.refreshOrderDetail(panel.id);
      if(!this.unloaded&&revision===this.orderOperationRevision)return this.reloadOrderOperations();
    }catch(error){if(!this.unloaded&&revision===this.orderOperationRevision)this.setData({operationLoading:false,operationStatus:'',operationError:error.message||'工单刷新失败，请重试。'});}
  },
  async reloadOrderOperations({poll=false,remaining=20}={}){
    const panel=this.data.operationPanel;if(!panel||this.data.operationSaving||this.data.operationClosing)return;
    this.stopOrderOperationPolling();
    const revision=this.orderOperationRevision=(this.orderOperationRevision||0)+1;
    if(!poll)this.setData({operationLoading:true,operationError:'',operationPanel:{...panel,canManage:false}});
    try{
      const response=await api.loadOrderOperations(panel.id,this.orderOperationReceiptId);
      if(this.unloaded||revision!==this.orderOperationRevision||!this.data.operationPanel)return;
      if(String(response.order?.id)!==String(panel.id)||!Number.isSafeInteger(response.version))throw new Error('工单操作资料未能确认，请重新读取。');
      const {order,receipt,pending,sync}=response;
      if(receipt?.status==='SUCCEEDED'&&this.orderOperationReceiptId){
        this.orderOperationSavedOrders=[order];
        this.setData({operationLoading:false,operationStatus:''});return this.closeOrderOperations();
      }
      if(receipt&&['FAILED','SUPERSEDED'].includes(receipt.status)){
        this.orderOperationReceiptId=null;this.orderOperationId=null;
      }
      const checking=!!(pending?.checking||sync?.pending&&!response.canManage);
      const cooldown=sync?.phase==='cooldown';
      const operationStatus=checking?(cooldown||!remaining?'本次修改仍由后台处理。可刷新这张工单，或关闭面板继续查看。':'后台正在更新本次修改，可关闭此窗口继续操作。'):'';
      const operationError=receipt&&['FAILED','SUPERSEDED'].includes(receipt.status)?receipt.message:!checking&&pending?'上次修改仍待核对。可刷新这张工单查看最新状态。':!checking&&!response.canManage?'工单资料未能确认，请刷新。':'';
      const canManage=response.canManage===true&&priorities.some(row=>row.key===order.priority)&&statuses.some(row=>row.key===order.status);
      this.setData({operationPanel:{id:order.id,code:order.code,priority:order.priority,status:order.status,syncPriority:false,canSyncPriority:response.canSyncPriority===true,canManage,version:response.version,checking},operationLoading:false,operationStatus,operationError});
      if(!checking&&canManage)this.applyOrderOperationUpdates([order]);
      if(checking)this.scheduleOrderOperationPoll(revision,remaining,cooldown);
    }catch(error){if(!this.unloaded&&revision===this.orderOperationRevision){
      this.setData({operationLoading:false,operationStatus:'',operationError:error.message||'工单操作读取失败，请重试。'});
      if(poll&&this.data.operationPanel?.checking)this.scheduleOrderOperationPoll(revision,remaining);
    }}
  },
  chooseOrderPriority(event){const key=event.currentTarget.dataset.key,panel=this.data.operationPanel;if(!panel?.canManage||this.data.operationSaving||this.data.operationClosing||!priorities.some(row=>row.key===key))return;this.orderOperationId=null;this.setData({operationPanel:{...panel,priority:key},operationError:''});},
  chooseOrderStatus(event){const key=event.currentTarget.dataset.key,panel=this.data.operationPanel;if(!panel?.canManage||this.data.operationSaving||this.data.operationClosing||!statuses.some(row=>row.key===key))return;this.orderOperationId=null;this.setData({operationPanel:{...panel,status:key},operationError:''});},
  toggleOrderPrioritySync(){const panel=this.data.operationPanel;if(!panel?.canManage||this.data.operationSaving||this.data.operationClosing)return;this.orderOperationId=null;this.setData({operationPanel:{...panel,syncPriority:!panel.syncPriority}});},
  closeOrderOperations(){
    if(!this.data.operationPanel||this.data.operationSaving||this.data.operationClosing)return;
    this.clearOrderOperationMotion();this.stopOrderOperationPolling();this.orderOperationRevision=(this.orderOperationRevision||0)+1;
    this.setData({operationOpen:false,operationClosing:true});
    this.orderOperationTimer=setTimeout(()=>{
      if(this.unloaded)return;const saved=this.orderOperationSavedOrders;this.resetOrderOperations();
      if(saved){this.applyOrderOperationUpdates(saved);wx.showToast({title:'工单已更改',icon:'none'});}
    },this.data.reduceMotion||!this.data.operationMotion?100:liquid.DURATION);
  },
  applyOrderOperationUpdates(orders){
    if(!Array.isArray(orders)||!orders.length)return;
    const patches=new Map(orders.map(presentation).map(row=>[String(row.id),{status:row.status,statusText:row.statusText,priority:row.priority,priorityText:row.priorityText,priorityTone:row.priorityTone,operationsUpdatedAt:row.operationsUpdatedAt}]));
    const update=rows=>rows.map(row=>patches.has(String(row.id))?{...row,...patches.get(String(row.id))}:row);
    this.setData({snapshotOrders:update(this.data.snapshotOrders),loadedOrders:update(this.data.loadedOrders),snapshotEdited:true});
    const all=this.data.sourceMode==='live'?this.data.loadedOrders:this.data.snapshotOrders;
    this.setData({statuses:[{key:'ALL',label:'全部'},...statuses.map(row=>({...row,label:row.label+' '+all.filter(order=>order.status===row.key).length}))]});
    this.applyFilters();
  },
  async refreshOrderOperationStates(){
    if(typeof api.loadOrderOperationStates!=='function'||this.data.sourceMode==='live')return;
    try{const response=await api.loadOrderOperationStates();if(!this.unloaded&&response?.source==='formal')this.applyOrderOperationUpdates(response.orders);}catch{}
  },
  async saveOrderOperations(){
    const panel=this.data.operationPanel;if(!panel?.canManage||this.data.operationLoading||this.data.operationSaving||this.data.operationClosing||getApp().globalData.entry?.canOperateOrders!==true)return;
    const revision=this.orderOperationRevision,input={orderId:panel.id,priority:panel.priority,status:panel.status,syncPriority:panel.syncPriority};
    this.orderOperationId||='order-ops-'+Date.now()+'-'+revision;
    this.setData({operationSaving:true,operationError:''});let committed=false;
    try{
      const result=await api.executeExecutionAction('updateOrder',input,{expectedVersion:panel.version,operationId:this.orderOperationId});
      if(this.unloaded||revision!==this.orderOperationRevision)return;
      if(result?.queued||result?.status==='UNKNOWN'){
        this.orderOperationReceiptId=result.operationId||this.orderOperationId;
        this.setData({operationSaving:false,operationStatus:'已提交，后台正在更新黑湖。',operationPanel:{...panel,canManage:false,checking:true}});
        return this.scheduleOrderOperationPoll(revision,20);
      }
      committed=true;
      const response=result?.order?{order:result.order,version:panel.version}:await api.loadOrderOperations(panel.id);
      if(String(response.order?.id)!==String(panel.id)||response.order.priority!==input.priority||response.order.status!==input.status||!Number.isSafeInteger(response.version))throw new Error('读取结果与保存不一致。');
      if(this.unloaded||revision!==this.orderOperationRevision)return;
      this.orderOperationSavedOrders=[response.order];this.setData({operationSaving:false});this.closeOrderOperations();
    }catch(error){if(!this.unloaded&&revision===this.orderOperationRevision)this.setData({operationSaving:false,operationError:committed?'更改已保存，读取确认失败，请重新读取核对。':error.message||'更改失败，请重试。',operationPanel:{...panel,canManage:!committed}});}
  }
};
module.exports={data,methods,priorities,statuses,presentation};
