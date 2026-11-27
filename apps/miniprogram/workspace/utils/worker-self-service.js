const api=require('./api');
const detail=require('./detail-model');
const {refreshCurrentOrder}=require('./order-refresh');
const data={selfServiceEnabled:false,canSelfStart:false,selfOrder:null,selfProcesses:[],selfSelected:null,selfUnits:[],selfUnitChoices:[],selfUnitIndex:0,selfUnitId:'',selfContextLoading:false,selfError:'',selfScanning:false,selfProcessScrollTarget:'',selfDefectOptions:[]};
const methods={
  syncSelfService(response,rows){
    const enabled=response.selfServiceEnabled===true,blocked=rows.some(row=>['READY','IN_PROGRESS','PAUSED','AWAITING_QUANTITY','REPORTING','NEEDS_REVIEW'].includes(row.status));
    if(enabled!==this.data.selfServiceEnabled){const workerTabs=[{key:'tasks',label:'任务',icon:'home'},{key:'orders',label:'工单',icon:'orders'},...(enabled&&!this.data.embroideryMode?[{key:'reports',label:'报表',icon:'report'}]:[]),{key:'mine',label:'我的',icon:'users'}];this.setData({workerTabs});this.clearGlassNav();this.setupWorkerNavigation();}
    this.setData({selfServiceEnabled:enabled,canSelfStart:enabled&&!blocked,selfDefectOptions:this.selfDefectOptions(response.selfServiceDefectReasons||[])});
    if(!enabled&&this.data.workerPanel?.kind==='self')this.closeWorkerPanel();
    if(enabled&&!blocked&&!this.data.workerOrdersLoaded&&!this.data.workerOrdersLoading)this.loadWorkerOrders();
  },
  openSelfOrders(){this.setWorkerTab({currentTarget:{dataset:{tab:'orders'}}});},
  selfAllowed(){return !this.unloaded&&this.data.selfServiceEnabled&&this.data.canSelfStart&&!this.data.busy&&!this.data.error;},
  openSelfOrder(event){
    if(!this.selfAllowed())return;
    const order=this.data.workerOrders.find(row=>String(row.id)===String(event.currentTarget.dataset.id)&&['NOT_STARTED','IN_PROGRESS'].includes(row.status));if(!order)return;
    wx.hideKeyboard?.();this.setData({selfOrder:order,selfProcesses:[],selfSelected:null,selfUnits:[],selfUnitId:'',selfError:'',selfProcessScrollTarget:'',selfContextLoading:false});
    if(this.data.embroideryMode)this.resetEmbroiderySelection();
    this.showWorkerPanel('self',event.currentTarget.dataset.anchor||'#worker-order-report-'+order.id);return this.loadSelfProcesses();
  },
  retrySelfProcesses(){return this.loadSelfProcesses({refresh:true});},
  async loadSelfProcesses({refresh=false}={}){
    if(this.unloaded||!this.data.selfServiceEnabled||this.data.busy||!this.data.selfOrder||this.data.selfContextLoading)return;
    if(refresh?this.data.workerPanel?.kind!=='self':!this.selfAllowed())return;
    const id=this.data.selfOrder.id,revision=this.selfContextRevision=(this.selfContextRevision||0)+1;
    const active=()=>!this.unloaded&&revision===this.selfContextRevision&&String(this.data.selfOrder?.id)===String(id)
      &&(!refresh||this.data.workerPanel?.kind==='self'&&this.data.panelOpen!==false);
    this.setData({selfContextLoading:true,selfError:'',selfSelected:null});
    if(this.data.embroideryMode)this.resetEmbroiderySelection();
    try{
      if(refresh){
        await refreshCurrentOrder(api,id,{active,maxAttempts:6});
        if(!active())return;
        if(this.data.error)await this.refresh?.({quiet:true});
        if(!active())return;
      }
      const response=await api.loadSelfServiceContext(id,this.data.embroideryMode);
      if(!active())return;
      if(String(response.orderId)!==String(id)||String(response.order?.id)!==String(id)||!Array.isArray(response.processes)||!Array.isArray(response.units)||response.processes.some(row=>!Number.isSafeInteger(row.id)||row.id<=0))throw new Error('工单工序归属未能确认，请重新读取。');
      const processes=detail.presentProcesses(response.processes).map(row=>({...row,recommended:String(row.id)===String(response.recommendedProcessId)}));
      const selected=processes.find(row=>row.recommended&&row.selectable)||processes.find(row=>row.selectable)||null;
      const units=response.units.filter(row=>typeof row.id==='string'&&row.id.trim());
      this.setData({selfProcesses:processes,selfSelected:selected,selfUnits:units,selfUnitChoices:[{id:'选择工位'},...units],selfUnitIndex:0,selfUnitId:units.length===1?units[0].id:'',selfContextLoading:false,selfProcessScrollTarget:selected?'self-process-'+selected.id:''});
    }catch(error){if(active())this.setData({selfError:error.message||'工序读取失败，请重试。'});}
    finally{if(!this.unloaded&&revision===this.selfContextRevision)this.setData({selfContextLoading:false});}
  },
  chooseSelfProcess(event){
    const row=this.data.selfProcesses.find(item=>String(item.id)===String(event.currentTarget.dataset.id));
    if(!this.selfAllowed()||!row?.selectable||this.data.selfSelected?.id===row.id)return;
    if(this.data.embroideryMode)this.resetEmbroiderySelection();
    this.setData({selfSelected:row});
  },
  chooseSelfUnit(event){const index=Number(event.detail.value);if(Number.isInteger(index)&&index>=0&&index<this.data.selfUnitChoices.length)this.setData({selfUnitIndex:index,selfUnitId:index?this.data.selfUnits[index-1].id:''});},
  async startSelfWork(){
    const {embroideryMode,selfSelected,selfEmbroideryPart,selfUnitId}=this.data;
    if(!this.selfAllowed()||this.data.selfContextLoading||!selfSelected?.selectable)return;
    if(embroideryMode?!selfEmbroideryPart:!selfUnitId)return;
    this.setData({selfError:'',selfStartError:''});
    const input={orderId:this.data.selfOrder.id,processId:selfSelected.id,...(embroideryMode?{embroideryPart:selfEmbroideryPart}:{unitId:selfUnitId})};
    if(await this.run('selfStart',input))this.closeWorkerPanel(()=>this.setWorkerTab({currentTarget:{dataset:{tab:'tasks'}}}));
    else if(!embroideryMode)this.setData({selfError:this.data.selfError||this.data.error||'开工状态未能确认，请刷新任务。'});
  },
  scanSelfWork(){
    if(!this.selfAllowed()||this.data.selfScanning||!this.data.workerOrdersLoaded)return;
    if(typeof wx.scanCode!=='function'){this.setData({selfError:'当前设备不支持扫码，请搜索工单。'});return;}
    const revision=this.selfScanRevision=(this.selfScanRevision||0)+1;this.setData({selfScanning:true,selfError:''});
    wx.scanCode({scanType:['qrCode','barCode'],success:result=>{
      if(this.unloaded||revision!==this.selfScanRevision||this.data.workerTab!=='orders')return;
      let raw=String(result.result||'').trim();try{raw=decodeURIComponent(raw);}catch{}
      const match=raw.match(/(?:^|[?&])projectId=([^&#]+)/),key=match?match[1]:raw;
      const order=this.data.workerOrders.find(row=>['NOT_STARTED','IN_PROGRESS'].includes(row.status)&&(String(row.id)===key||row.code===key));
      if(order)this.openSelfOrder({currentTarget:{dataset:{id:order.id,anchor:'#worker-order-scan'}}});else this.setData({selfError:'未找到对应的可开工工单，请搜索确认。'});
    },fail:error=>{if(!this.unloaded&&revision===this.selfScanRevision&&!String(error.errMsg||'').includes('cancel'))this.setData({selfError:'扫码未成功，请重试或搜索工单。'});},complete:()=>{if(!this.unloaded&&revision===this.selfScanRevision)this.setData({selfScanning:false});}});
  },
};
module.exports={data,methods};
