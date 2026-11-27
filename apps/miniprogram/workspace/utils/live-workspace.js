const api=require('./api');
const worker=require('./worker-model');
const {request}=require('../../utils/api');
const {workTimeBreakdown}=require('./work-time');
const orderListRefresh=require('./order-list-refresh');
function idle(page){return !page.unloaded&&!page.hidden&&!page.data.busy&&!page.data.actionBusy&&!page.data.reportPanel&&!page.data.reportMenu&&!page.data.assignmentPanel&&!page.data.assignmentMenu&&!page.data.workerPanel&&!page.data.productPanel&&!page.data.imageViewer&&!page.data.operationPanel&&!page.data.clockoutPanel&&!page.data.taskChooser&&!page.data.inlineSorting&&!page.data.listPanel&&!page.data.detailMounted;}
function stop(page){if(page.livePoll)clearInterval(page.livePoll);page.livePoll=null;}
function watch(page,kind){stop(page);page.livePoll=setInterval(()=>{
  if(!idle(page))return;
  if(kind==='worker'&&page.data.workerTab==='tasks'&&!page.data.loading)page.refresh();
  if(kind==='worker'&&page.data.workerTab==='orders'&&!page.data.workerOrderSearchOpen)page.refreshWorkerOrderCards?.();
  if(kind==='dispatch')page.refreshPeople?.();
  if(kind==='tasks'&&!page.data.executionLoading)page.loadExecution();
  if(kind==='orders'&&page.data.workspaceTab===1){const child=page.selectComponent?.('#leader-tasks-panel');if(child&&idle(child)&&!child.data.executionLoading)child.loadExecution();}
  if(kind==='orders'&&page.data.workspaceTab===0&&!page.data.searchOpen)page.refreshOrderCards?.();
},10000);}
function wrap(page,kind){
  const load=page.onLoad,show=page.onShow,hide=page.onHide,unload=page.onUnload;
  page.onLoad=async function(...args){
    const app=getApp();if(!app.globalData.sessionToken)return wx.reLaunch({url:'/pages/login/login'});
    try{const me=await request('/v1/me');if(this.unloaded)return;app.globalData.entry=me.entry;app.globalData.operator=me.operator;app.globalData.reviewMode=!!me.reviewMode;app.globalData.dataMode='live';
      const home=app.homeUrl();if(!home.startsWith('/workspace/'))return wx.reLaunch({url:home});
      const modes=me.operator?.reportingModes||[],canUseEmbroidery=modes.includes('embroidery');
      this.setData({canUseEmbroidery,canUseStandard:modes.includes('standard'),canUseFloor8:me.operator?.effectiveWorkerType==='floor8',
        ...(kind==='worker'?{embroideryMode:canUseEmbroidery&&(args[0]?.mode==='embroidery'||me.operator?.defaultReportingMode==='embroidery')}:{} )});
      await load?.apply(this,args);if(!this.unloaded){watch(this,kind);if(args[0]?.recordTab==='reports')this.openFormalReports();}
    }catch(error){if(!this.unloaded)this.setData({error:error.message,loadError:error.message,executionError:error.message});}
  };
  page.onShow=function(...args){this.hidden=false;watch(this,kind);return show?.apply(this,args);};
  page.onHide=function(...args){this.hidden=true;stop(this);return hide?.apply(this,args);};
  page.onUnload=function(...args){stop(this);clearTimeout(this.liveSearchTimer);this.unloaded=true;return unload?.apply(this,args);};
  page.openFormalReports=function(){
    if(!idle(this))return;if(kind==='worker')this.setWorkerTab({currentTarget:{dataset:{tab:'reports'}}});else this.activateGlassTab(3);
  };
  const activate=page.activateGlassTab;
  if(activate&&kind==='orders')page.activateGlassTab=function(index,options){if(index===4){if(idle(this)&&!this.data.workspaceTaskModal&&!this.data.workspaceTaskBusy)wx.navigateTo({url:'/pages/dispatch/dispatch?workspaceView=board'});return;}return activate.call(this,index,options);};
  if(kind==='orders'){
    page.scanOrder=function(){
      if(!idle(this)||this.data.scanning)return;
      this.setData({scanning:true});wx.scanCode({onlyFromCamera:true,scanType:['qrCode','barCode'],success:async result=>{
        try{const response=await api.resolveScannedOrder(result.result);if(this.unloaded)return;const order=response.order;if(!order?.id)throw Error('工单资料未能确认。');
          this.setData({activeStatus:'ALL',keyword:'',loadedOrders:[order,...this.data.loadedOrders.filter(row=>String(row.id)!==String(order.id))],scanning:false});this.applyFilters();this.openOrder({currentTarget:{dataset:{id:order.id}}});
        }catch(error){if(!this.unloaded){this.setData({scanning:false});wx.showToast({title:error.message||'扫码查询失败，请重试',icon:'none'});}}
      },fail:error=>{if(!this.unloaded){this.setData({scanning:false});if(!/cancel/i.test(error.errMsg||''))wx.showToast({title:'扫码未完成，请重试',icon:'none'});}}});
    };
    const search=page.onSearch,loadLive=page.loadLive;
    page.onSearch=function(event){search.call(this,event);clearTimeout(this.liveSearchTimer);this.liveSearchTimer=setTimeout(()=>{if(this.unloaded)return;this.setData({queryCode:this.data.keyword.trim()});this.loadLive();},250);};
    page.loadLive=async function(...args){const query=this.data.queryCode;await loadLive.apply(this,args);if(!this.unloaded&&!this.data.loading&&query!==this.data.queryCode)this.loadLive();};
  }
  if(kind==='worker'){
    page.scanSelfWork=function(){
      if(!this.selfAllowed()||this.data.selfScanning)return;
      this.setData({selfScanning:true,selfError:''});wx.scanCode({onlyFromCamera:true,scanType:['qrCode','barCode'],success:async result=>{
        try{const response=await api.resolveScannedOrder(result.result,this.data.embroideryMode);if(this.unloaded||this.data.workerTab!=='orders')return;const order=worker.presentOrders([response.order])[0];
          if(!['NOT_STARTED','IN_PROGRESS'].includes(order.status))throw Error('工单已结束或不可开工，请核对。');
          this.setData({workerOrders:[order,...this.data.workerOrders.filter(row=>String(row.id)!==String(order.id))],workerOrdersLoaded:true,selfScanning:false});this.filterWorkerOrders();await this.openSelfOrder({currentTarget:{dataset:{id:order.id,anchor:'#worker-order-scan'}}});
        }catch(error){if(!this.unloaded)this.setData({selfError:error.message||'扫码查询失败，请重试。'});}finally{if(!this.unloaded)this.setData({selfScanning:false});}
      },fail:error=>{if(!this.unloaded)this.setData({selfScanning:false,...(!/cancel/i.test(error.errMsg||'')?{selfError:'扫码未完成，请重试。'}:{})});}});
    };
    page.switchWorkerReportingMode=function(){
      if(!idle(this))return;
      if(!this.data.embroideryMode&&this.data.canUseEmbroidery)return wx.reLaunch({url:'/workspace/pages/worker/worker?mode=embroidery'});
      if(this.data.embroideryMode&&this.data.canUseStandard)return wx.reLaunch({url:this.data.canUseFloor8?'/workspace/pages/worker/worker':'/pages/report/report?legacyMode=standard'});
    };
    page.logoutWorkspace=function(){if(!idle(this))return;wx.showModal({title:'退出登录',content:'确认退出当前账号？',success:result=>{if(result.confirm){getApp().clearSession();wx.reLaunch({url:'/pages/login/login'});}}});};
    const updateClock=page.updateWorkerClock;
    page.updateWorkerClock=function(){
      const task=this.data.current||this.data.next;if(!task?.timing?.startedAt)return updateClock.call(this);
      clearTimeout(this.clockTimer);if(this.unloaded||this.hidden)return;
      const running=task.status==='IN_PROGRESS',server=Date.parse(task.timing.asOf),at=Number.isFinite(server)?server+Math.max(0,Date.now()-this.clockBaseAt):Date.now();
      const value=workTimeBreakdown(task.timing.startedAt,task.timing.endedAt||at,task.timing.pauses);
      const label=task.status==='AWAITING_QUANTITY'?'已停止':task.status==='READY'?'待开始':task.status==='PAUSED'?(task.canStart?'待开始':'组长已暂停'):task.timerPaused?(task.timerPauseSource==='overnight'?'系统已暂停':task.timerPauseSource==='clockout'||task.timerPauseSource==='leader'?'组长已暂停':'已暂停'):value.lunchActive?'午休已暂停':'正在计时';
      this.setData({clockText:worker.clockText(value.effectiveSeconds),...(this.data.current?{'current.timerStateText':label}:{})});
      if(running)this.clockTimer=setTimeout(()=>this.updateWorkerClock(),1000);
    };
    page.loadWorkerOrders=async function({more=false}={}){
      if(this.unloaded||more&&(this.data.workerOrdersLoading||!this.data.workerOrdersHasMore))return;
      const revision=this.orderReadRevision=(this.orderReadRevision||0)+1,pageNum=more?(this.data.workerOrdersPage||1)+1:1,query=this.data.workerOrderKeyword.trim();this.setData({workerOrdersLoading:true,workerOrdersError:''});
      if(!more)this.workerWatchOffset=0;
      try{const response=await api.loadEmployeeOrders(pageNum,query,{sort:this.data.workerOrderSort,status:this.data.workerOrderStatus});if(this.unloaded||revision!==this.orderReadRevision)return;if(!Array.isArray(response.orders)||response.pageNum!==pageNum)throw Error('工单资料未能确认。');
        const loaded=more?this.data.workerOrders.concat(worker.presentOrders(response.orders)):worker.presentOrders(response.orders);
        this.setData({workerOrders:[...new Map(loaded.map(row=>[row.id,row])).values()],workerOrdersTotal:response.total,workerOrdersPage:pageNum,workerOrdersHasMore:response.hasMore===true,workerOrdersLoaded:true,workerOrdersLoading:false});this.filterWorkerOrders();
      }catch(error){if(!this.unloaded&&revision===this.orderReadRevision)this.setData({workerOrdersLoading:false,workerOrdersError:error.message||'工单读取失败，请重试。'});}
    };
    page.onWorkerOrderScroll=function(event){this.workerOrderScrollTop=event.detail.scrollTop;};
    page.refreshWorkerOrderCards=async function(){
      if(!this.data.workerOrdersLoaded||this.data.workerOrdersLoading||this.workerOrdersPolling||Date.now()-(this.workerOrdersCheckedAt||0)<30000)return;
      const key=()=>[this.data.workerOrderKeyword.trim(),this.data.workerOrderSort,this.data.workerOrderStatus].join('\n');
      const started=key(),revision=this.orderReadRevision,offset=this.workerWatchOffset||0;
      const {workerOrderSort:sort,workerOrderStatus:status,workerOrderKeyword:query,workerOrders}=this.data;
      const watch=orderListRefresh.watchedIds(workerOrders,offset);
      this.workerOrdersPolling=true;
      this.workerOrdersCheckedAt=Date.now();
      try{
        const response=await api.loadEmployeeOrders(1,query.trim(),{sort,status,watch});
        if(!idle(this)||this.data.workerTab!=='orders'||this.data.workerOrderSearchOpen||this.orderReadRevision!==revision||key()!==started||response.pageNum!==1||!Array.isArray(response.orders))return;
        const loaded=this.data.workerOrders,next=orderListRefresh.mergeOrderCards(loaded,watch,response,{
          atTop:(this.workerOrderScrollTop||0)<=8,
          present:(order,previous)=>{const result=worker.presentOrders([order])[0];return {...result,imageFailed:!!previous?.imageFailed&&previous.imageUrl===result.imageUrl};}
        });
        this.workerWatchOffset=offset+watch.length>=workerOrders.length?0:offset+watch.length;
        const total=response.total,hasMore=this.data.workerOrdersPage*response.pageSize<total;
        if(next.length!==loaded.length||next.some((row,index)=>row!==loaded[index])||total!==this.data.workerOrdersTotal||hasMore!==this.data.workerOrdersHasMore){
          this.setData({workerOrders:next,workerOrdersTotal:total,workerOrdersHasMore:hasMore});
          this.filterWorkerOrders();
        }
      }catch{}finally{this.workerOrdersPolling=false;}
    };
    page.loadMoreWorkerOrders=function(){return this.loadWorkerOrders({more:true});};
    const search=page.onWorkerOrderSearch,toggle=page.toggleWorkerOrderSearch;
    page.onWorkerOrderSearch=function(event){search.call(this,event);clearTimeout(this.liveSearchTimer);this.liveSearchTimer=setTimeout(()=>this.loadWorkerOrders(),250);};
    page.toggleWorkerOrderSearch=function(){toggle.call(this);if(!this.data.workerOrderSearchOpen){clearTimeout(this.liveSearchTimer);this.loadWorkerOrders();}};
  }
  return page;
}
module.exports={wrap};
