const api=require('./api'),{morph}=require('./liquid-geometry');
const {compareCreated}=require('./order-time');
const scopes=[{key:'all',label:'所有工单'},{key:'mine',label:'我派出的工单'}];
const sorts=[{key:'default',label:'创建时间从新到旧'},{key:'created-asc',label:'创建时间从旧到新'},{key:'code',label:'工单编号'},{key:'start-desc',label:'计划开始从新到旧'},{key:'start-asc',label:'计划开始从旧到新'}];
const statuses=[{key:'ALL',label:'全部'},{key:'NOT_STARTED',label:'未开始'},{key:'IN_PROGRESS',label:'执行中'},{key:'FINISHED',label:'已结束'}];
const priorities=[{key:'ALL',label:'全部'},{key:'EXTREME',label:'特急'},{key:'URGENT',label:'紧急'},{key:'EXPEDITED',label:'加急'},{key:'PAUSED',label:'暂停'},{key:'NONE',label:'无'}];
const data={listPanel:null,listOpen:false,listClosing:false,listScope:'all',listScopeLabel:'所有工单',listSort:'default',listPriority:'ALL',listScopeIds:[],listScopeLoaded:false,listScopeLoading:false,listError:'',listOptions:[],listStatuses:statuses,listPriorities:priorities,listDraft:{status:'ALL',priority:'ALL'}};
const owner=()=>String(getApp().globalData.entry?.leaderId||getApp().globalData.entry?.blacklakeOperatorId||'');
const methods={
  syncOrderListOwner(){
    const key=owner();if(this.listOwner===key)return false;
    this.disposeOrderListTools();this.listOwner=key;this.setData({...data});this.applyFilters?.();return true;
  },
  disposeOrderListTools(){clearTimeout(this.listEnterTimer);clearTimeout(this.listCloseTimer);this.listRevision=(this.listRevision||0)+1;this.listReadRevision=(this.listReadRevision||0)+1;},
  openOrderListTool(event){
    if(getApp().globalData.entry?.appRole!=='floor8_leader'||this.unloaded||this.data.listPanel||this.data.clockoutPanel||this.data.operationPanel||this.data.detailMounted||this.data.imageViewer||this.data.workspaceTab===1)return;
    const kind=event.currentTarget.dataset.kind;if(!['scope','sort','filter'].includes(kind))return;
    this.syncOrderListOwner();this.disposeOrderListTools();const revision=this.listRevision,info=wx.getWindowInfo?.()||{},width=info.windowWidth||390,height=info.windowHeight||740,panelHeight=Math.min(kind==='scope'?260:kind==='sort'?348:420,height-32),rect={left:12,top:(height-panelHeight)/2,width:width-24,height:panelHeight};
    const options=kind==='scope'?scopes:sorts,selected=kind==='scope'?this.data.listScope:this.data.listSort;
    this.cancelGlassNav?.();wx.hideKeyboard?.();
    const show=origin=>{if(this.unloaded||revision!==this.listRevision)return;const shape=morph(origin||{left:width-60,top:18,width:44,height:44},rect,16);this.setData({listPanel:{kind,title:{scope:'工单范围',sort:'工单排序',filter:'筛选工单'}[kind],...shape},listOpen:false,listClosing:false,listError:'',listOptions:options.map(row=>({...row,selected:row.key===selected})),listDraft:{status:this.data.activeStatus,priority:this.data.listPriority}},()=>{this.listEnterTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.listRevision)this.setData({listOpen:true});},16);});};
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();if(query)query.select('#order-list-'+kind).boundingClientRect().exec(rects=>show(rects?.[0]));else show(null);
  },
  closeOrderListTool(afterClose){
    if(!this.data.listPanel||this.data.listClosing)return;
    clearTimeout(this.listEnterTimer);const revision=this.listRevision,key=owner();this.listReadRevision=(this.listReadRevision||0)+1;
    this.setData({listOpen:false,listClosing:true,listScopeLoading:false});this.listCloseTimer=setTimeout(()=>{if(this.unloaded||revision!==this.listRevision||key!==owner())return;this.setData({listPanel:null,listClosing:false});if(typeof afterClose==='function')afterClose();},this.data.reduceMotion?100:260);
  },
  async loadOwnedOrderIds(){
    const key=owner(),revision=this.listReadRevision=(this.listReadRevision||0)+1;
    if(!key){this.setData({listError:'当前组长身份未确认，请重新登录。'});return false;}
    this.setData({listScopeLoading:true,listError:''});
    try{const response=await api.loadLeaderTasks();if(this.unloaded||revision!==this.listReadRevision||key!==owner())return false;
      if(!Array.isArray(response.assignments)||response.assignments.some(row=>String(row.leaderId)!==key))throw Error('派工记录归属未能确认，请重新读取。');
      this.setData({listScopeIds:[...new Set(response.assignments.map(row=>String(row.orderId)))],listScopeLoaded:true,listScopeLoading:false});return true;
    }catch(error){if(!this.unloaded&&revision===this.listReadRevision&&key===owner())this.setData({listScopeLoading:false,listError:error.message||'本人派工记录读取失败。'});return false;}
  },
  async chooseOrderListOption(event){
    const panel=this.data.listPanel,key=event.currentTarget.dataset.key;if(!panel||this.data.listClosing||this.data.listScopeLoading||!this.data.listOpen)return;
    const option=(panel.kind==='scope'?scopes:sorts).find(row=>row.key===key);if(!option)return;
    if(panel.kind==='scope'&&key==='mine'&&!await this.loadOwnedOrderIds())return;
    const patch=panel.kind==='scope'?{listScope:key,listScopeLabel:option.label}:{listSort:key};
    this.setData({listOptions:this.data.listOptions.map(row=>({...row,selected:row.key===key}))});this.closeOrderListTool(()=>{this.setData(patch);this.applyFilters();if(this.data.sourceMode==='live'&&panel.kind==='sort')this.loadLive();});
  },
  chooseOrderListFilter(event){const {field,key}=event.currentTarget.dataset;if(this.data.listPanel?.kind!=='filter'||this.data.listClosing||!['status','priority'].includes(field)||!(field==='status'?statuses:priorities).some(row=>row.key===key))return;this.setData({listDraft:{...this.data.listDraft,[field]:key}});},
  resetOrderListFilter(){if(this.data.listPanel?.kind==='filter')this.setData({listDraft:{status:'ALL',priority:'ALL'}});},
  applyOrderListFilter(){if(this.data.listPanel?.kind!=='filter'||this.data.listClosing)return;const draft={...this.data.listDraft};this.closeOrderListTool(()=>{this.setData({activeStatus:draft.status,listPriority:draft.priority});this.applyFilters();if(this.data.sourceMode==='live')this.loadLive();});},
  filterOrderList(rows){
    let result=rows.filter(row=>(this.data.listScope!=='mine'||this.data.listScopeIds.includes(String(row.id)))&&(this.data.listPriority==='ALL'||(row.priority||'NONE')===this.data.listPriority));
    if(this.data.listSort==='code')result.sort((a,b)=>String(a.code||'').localeCompare(String(b.code||''),'zh-CN',{numeric:true}));
    if(this.data.listSort==='default'||this.data.listSort==='created-asc')result.sort((a,b)=>compareCreated(a,b,this.data.listSort==='created-asc'?'asc':'desc'));
    if(['start-desc','start-asc'].includes(this.data.listSort))result.sort((a,b)=>{const first=Date.parse(String(a.startAt||'').replace(' ','T')),second=Date.parse(String(b.startAt||'').replace(' ','T'));return !Number.isFinite(first)?(Number.isFinite(second)?1:0):!Number.isFinite(second)?-1:this.data.listSort==='start-asc'?first-second:second-first;});
    return result;
  },
  refreshOrderListCounts(rows){
    if(this.data.listScope!=='mine'&&this.data.listPriority==='ALL'&&!this.listCountsActivated)return;
    this.listCountsActivated=true;const scoped=this.filterOrderList(rows);
    this.setData({statuses:statuses.map(row=>({...row,label:row.label+' '+(row.key==='ALL'?scoped.length:scoped.filter(order=>order.status===row.key).length)}))});
  }
};
module.exports={data,methods};
