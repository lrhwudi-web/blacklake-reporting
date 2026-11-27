const layerBack=require('../../utils/layer-back');
const api=require('../../utils/api');
const management=require('../../utils/task-report-management');
const model=require('../../utils/detail-model');
const segments=require('../../utils/glass-segments');
const motion=require('../../utils/glass-navigation');
const {morph}=require('../../utils/liquid-geometry');
const display=n=>n===null||n===undefined?'—':String(n);
const pieceText=n=>{if(n===null||n===undefined)return '—';const parts=String(n).split('.');return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',')+(parts.length>1?'.'+parts[1]:'');};
const duration=n=>n===null||n===undefined?'—':(n>=3600?Math.floor(n/3600)+'小时':'')+(Math.floor(n%3600/60)?Math.floor(n%3600/60)+'分':n<3600?'0分':'');
function approvalText(row){
 if(row.groupReview==='PENDING')return '待组长审批';
 if(row.groupReview==='APPROVED'&&row.syncState!=='SUCCEEDED'){
  return ({UNKNOWN:'已审批 · 后台核对中',FAILED:'已审批 · 黑湖同步异常'})[row.syncState]||'已审批 · 正在同步黑湖';
 }
 return ({UNKNOWN:'后台核对中',FAILED:'审批未完成',QUEUED:'审批同步中',RUNNING:'审批同步中',RETRY:'审批同步中'})[row.approvalSync]
  ||(row.approvalStatus===10?'已审批':row.approvalStatus===0?'未审批':'审批状态未同步');
}
const recordDetails=row=>({...row,approvalText:approvalText(row),approvalBusy:approvalInProgress.includes(row.approvalSync),goodText:pieceText(row.goodQuantity),badText:pieceText(row.defectiveQuantity),recordProductText:[row.productCode,row.productName,row.productSpecification].filter(Boolean).join(' · ')||'产品信息未提供',recordSpanText:row.startedAt&&row.endedAt?model.time(row.startedAt).slice(0,19)+' ～ '+model.time(row.endedAt).slice(0,19):'起止时间未提供'});
const day=d=>new Date(d.getTime()+8*3600000).toISOString().slice(0,10);
const dayOffset=(dayKey,offset)=>day(new Date(Date.parse(dayKey+'T00:00:00+08:00')+offset*86400000));
const dateOptions=[{mode:'today',label:'今天'},{mode:'yesterday',label:'昨天'},{mode:'week',label:'近7天'},{mode:'custom',label:'自选日期'}];
const summarySortOptions=[{key:'latest',label:'最新报工'},{key:'oldest',label:'最早报工'},{key:'quantity',label:'报工数量最多'}];
const approvalInProgress=['QUEUED','RUNNING','RETRY','UNKNOWN'];
const canApprovePending=row=>row.approvalStatus===0&&row.canApprove&&!approvalInProgress.includes(row.approvalSync);
Component(layerBack.component({
 properties:{active:Boolean,reduceMotion:Boolean},
 data:{...JSON.parse(JSON.stringify(management.data)),...segments.data,reportTab:'summary',approvalView:'pending',summaryRows:[],summaryHasMore:false,summaryLoadingMore:false,approvalRequests:{},loading:false,error:'',loaded:false,canManageReports:false,
  summarySort:'latest',summarySortOptions,summarySortDraft:'latest',batchRows:[],batchSelected:{},batchAll:false,batchCount:0,batchBusy:false,
  from:'',to:'',today:'',dateMode:'today',dateLabel:'今天',group:'',groupLabel:'全部小组',process:'',query:'',searchOpen:false,sort:'time',expanded:false,
  people:[],processes:[],defects:[],bars:[],groups:[],processOptions:[],summary:{people:'—',bad:'—',affectedOrders:'—',rate:'—',duration:'—',count:0},syncNote:'',qualityNote:'',updatedText:'',
  picker:null,dateOptions,dateDraft:{from:'',to:'',mode:'today'},pickerError:'',employeeOptions:[],employeeRows:[],employeeQuery:'',employeeSelection:null,employeeDraft:[],employeeAll:false,employeeLabel:'全部员工',employeeListHeight:240,
  reportRecordsOpen:false,reportRecordsTitle:'',reportRecords:[],recordFilter:{},recordPage:0,recordTotal:0,recordHasMore:false,recordLoading:false,recordError:'',recordDuration:'—',recordHeight:600,
  reportOrderMounted:false,reportOrderVisible:false,reportOrderId:'',reportOrderOrigin:null,summaryEditorMotion:null,summaryEditorClosing:false},
 observers:{active(value){if(!this.attachedReady)return;if(value&&!this.data.loaded)this.loadReportData();if(!value){clearTimeout(this.searchTimer);clearTimeout(this.recordsTimer);clearTimeout(this.summaryTimer);this.stopResize();}},
  'reportPanel, actionBusy'(panel,busy){if(!this.attachedReady||this.unloaded)return;if(!panel&&!busy&&!this.summaryEditorPending&&this.data.summaryEditorMotion)this.setData({summaryEditorMotion:null,summaryEditorClosing:false});this.notify();}},
 lifetimes:{attached(){this.attachedReady=true;this.unloaded=false;const today=day(new Date());this.setData({today,from:today,to:today,reduceMotion:this.properties.reduceMotion});this.setupGlassSegments();if(this.properties.active)this.loadReportData();},detached(){this.unloaded=true;clearTimeout(this.searchTimer);clearTimeout(this.recordsTimer);clearTimeout(this.summaryTimer);clearTimeout(this.summaryEditorTimer);this.stopResize();this.resetReportPeople();this.resetReportDateTime();this.clearReportEditorMotion();this.clearReportMenuMotion();this.disposeGlassSegments();}},
 pageLifetimes:{show(){this.hidden=false;if(this.properties.active&&this.data.loaded){this.loadReportData({quiet:true});if(this.data.reportRecordsOpen)this.loadReportRecords();}},hide(){this.hidden=true;clearTimeout(this.recordsTimer);}},
 methods:{...management.methods,...segments.methods,
  setReportData(values){const changed={};for(const key of Object.keys(values))if(JSON.stringify(this.data[key])!==JSON.stringify(values[key]))changed[key]=values[key];if(Object.keys(changed).length)this.setData(changed);},
  filters(extra={}){return {from:this.data.from,to:this.data.to,query:this.data.query,group:this.data.group,process:this.data.process,personIds:this.data.employeeSelection?.join(',')||'',...(this.data.reportTab==='summary'?{approval:this.data.approvalView,sort:this.data.summarySort}:{}),...extra};},
  notify(){this.triggerEvent('statechange',{modal:!!(this.data.reportRecordsOpen||this.data.picker||this.data.reportOrderMounted||this.data.reportPanel),busy:!!(this.data.actionBusy||this.data.batchBusy)});},
  async loadReportData({quiet=false,force=false}={}){
   if(this.unloaded)return;
   const filters=this.filters(),key=JSON.stringify(filters);
   if(this.reading){
    if(force||key!==this.readingKey)this.reloadPending=true;
    return;
   }
   this.reading=true;this.readingKey=key;
   this.setReportData({loading:!quiet||this.reportFilterKey!==key,error:''});
   try{const response=await api.loadWorkspaceReports(filters);if(this.unloaded)return;if(key!==JSON.stringify(this.filters())){this.reloadPending=true;return;}const changed=!response.version||this.raw?.version!==response.version||this.reportFilterKey!==key;this.raw=response;this.reportFilterKey=key;if(changed)this.present();if(this.data.reportTab==='summary'&&!this.summaryPolling&&(response.records||[]).some(row=>['QUEUED','RUNNING','RETRY'].includes(row.approvalSync)))this.scheduleSummaryRefresh();this.setReportData({loaded:true,loading:false});}
   catch(error){
    if(this.unloaded)return;
    if(key!==JSON.stringify(this.filters())){this.reloadPending=true;return;}
    this.setReportData({loading:false,error:error.message||'报表读取失败，保留已有记录。'});
   }finally{this.reading=false;this.readingKey=null;if(this.reloadPending&&!this.unloaded){this.reloadPending=false;this.loadReportData({quiet:true});}}
  },
  present(){const r=this.raw;if(!r)return;const s=r.summary,people=r.people.map(p=>({...p,pieceText:pieceText(p.pieceQuantity),duration:duration(p.seconds)+(p.unknownDurationCount?'＋待核对':''),meta:p.processes[0]+(p.processes.length>1?'等'+p.processes.length+'道工序':'')+' · '+p.count+'笔报工'}));
   people.sort((a,b)=>this.data.sort==='time'?b.seconds-a.seconds:this.data.sort==='pieces'?(b.pieceQuantity??-1)-(a.pieceQuantity??-1):this.data.sort==='count'?b.count-a.count:this.data.sort==='name'?a.name.localeCompare(b.name,'zh'):0);
   const processes=r.processes.slice().sort((a,b)=>this.data.sort==='name'?a.name.localeCompare(b.name,'zh'):b.seconds-a.seconds),max=Math.max(1,...r.bins.map(b=>b.seconds)),defectMax=Math.max(1,...r.defects.map(d=>d.quantity)),timeMax=Math.max(1,...processes.map(p=>p.seconds));
   this.setReportData({summaryRows:(r.records||[]).map(recordDetails),summaryHasMore:r.hasMore===true,people:this.data.expanded||this.data.query?people:people.slice(0,4),peopleCount:people.length,groups:r.groups,processOptions:r.processOptions,employeeOptions:r.employeeOptions||[],
    processes:processes.map(p=>({...p,duration:duration(p.seconds)+(p.unknownDurationCount?'＋待核对':''),width:p.seconds/timeMax*100})),defects:r.defects.slice().sort((a,b)=>this.data.sort==='name'?0:b.quantity-a.quantity).map(d=>({...d,width:d.quantity/defectMax*100})),bars:r.bins.map(b=>({...b,height:b.seconds/max*90,value:b.seconds?(b.seconds/3600).toFixed(1):''})),
    canManageReports:r.canManage,canEditProcessReports:r.canManage,canManageExecution:r.canManage,summary:{...s,pieceText:pieceText(s.pieceQuantity),approvedText:pieceText(s.approvedCount),pendingText:pieceText(s.pendingApprovalCount),unknownApprovalCount:s.pendingApprovalCount==null||s.approvedCount==null?0:s.count-s.pendingApprovalCount-s.approvedCount,quantityText:pieceText(s.quantity),badText:pieceText(s.bad),bad:display(s.bad),quantity:display(s.quantity),rate:s.defectRate===null?'—':(s.defectRate*100).toFixed(2)+'%',duration:duration(s.seconds)+(s.unknownDurationCount?'＋待核对':''),average:duration(s.people?s.seconds/s.people:null)},
    syncNote:r.sync.complete?'按已同步报工统计':'历史尚未补齐 · 按已同步报工统计',qualityNote:s.missingDefectCount?s.missingDefectCount+'笔不良尚未同步品项':'',updatedText:r.sync.updatedAt?'更新于 '+model.time(r.sync.updatedAt).slice(5,16):'尚无完整同步时间'});
  },
  setReportTab(event){const tab=event.currentTarget.dataset.tab;if(!['summary','people','time','quality'].includes(tab)||this.data.reportRecordsOpen||this.data.picker||this.data.reportPanel||this.summaryEditorPending)return;this.setData({reportTab:tab,expanded:false,sort:'time'});this.present();if(tab==='summary'&&this.reportFilterKey!==JSON.stringify(this.filters()))this.setData({summaryRows:[],summaryHasMore:false});this.loadReportData({quiet:true});},
  setApprovalView(event){const key=event.currentTarget.dataset.key;if(!['pending','approved','unknown'].includes(key)||key===this.data.approvalView)return;this.setData({approvalView:key,summaryRows:[],summaryHasMore:false,loading:true});this.loadReportData();},
  async loadMoreSummary(){
   const base=this.raw,filters=this.filters();
   if(this.data.summaryLoadingMore||!this.data.summaryHasMore||this.data.reportTab!=='summary'||this.reportFilterKey!==JSON.stringify(filters))return;
   this.setData({summaryLoadingMore:true});
   try{const r=await api.loadWorkspaceReports({...filters,page:(base?.page||1)+1});if(this.unloaded||this.raw!==base||JSON.stringify(filters)!==JSON.stringify(this.filters()))return;
    this.raw={...base,page:r.page,hasMore:r.hasMore,records:[...base.records,...r.records.filter(row=>!base.records.some(old=>old.id===row.id))]};this.present();
    if(this.data.picker?.kind==='batch'){
     this.batchCandidates=this.availableBatchRows();
     this.showBatchSelection(this.data.batchSelected);
    }}
   catch(e){if(!this.unloaded)this.setData({error:e.message||'报工列表读取失败'});}finally{if(!this.unloaded)this.setData({summaryLoadingMore:false});}
  },
  scheduleSummaryRefresh(remaining=12){
   clearTimeout(this.summaryTimer);if(remaining<1)return;
   this.summaryTimer=setTimeout(async()=>{if(this.unloaded||this.hidden||!this.properties.active||this.data.reportTab!=='summary')return;
    if(this.data.actionBusy||this.data.reportPanel||this.data.picker?.kind==='batch')return this.scheduleSummaryRefresh(remaining-1);
    this.summaryPolling=true;try{await this.loadReportData({quiet:true});}finally{this.summaryPolling=false;}
    if(this.data.summaryRows.some(row=>['QUEUED','RUNNING','RETRY','UNKNOWN'].includes(row.approvalSync)))this.scheduleSummaryRefresh(remaining-1);
   },1800);
  },
  async requestApproval(row){
   this.approvalKeys||={};
   const prior=this.approvalKeys[row.id];
   const sameVersion=prior?.status===row.approvalStatus&&prior?.revision===row.approvalRevision;
   const key=sameVersion?prior.key:'approval-'+Date.now()+'-'+Math.random().toString(36).slice(2);
   this.approvalKeys[row.id]={key,status:row.approvalStatus,revision:row.approvalRevision};
   const result=await api.approveProcessReport(row,key);
   if(!result.accepted||['FAILED','UNKNOWN'].includes(result.status))throw Error('这笔审批尚未确认，请刷新查看状态。');
  },
  async toggleApproval(event){
   const id=String(event.currentTarget.dataset.id),row=this.data.summaryRows.find(r=>r.id===id);
   if(!row?.canApprove||approvalInProgress.includes(row.approvalSync)||this.data.approvalRequests[id]||this.data.batchBusy||this.reportFilterKey!==JSON.stringify(this.filters()))return;
   this.setData({approvalRequests:{...this.data.approvalRequests,[id]:true}});
   try{await this.requestApproval(row);
    await this.loadReportData({quiet:true,force:true});this.scheduleSummaryRefresh();
   }catch(e){if(!this.unloaded)wx.showToast({title:e.message||'审批提交未能确认，可刷新后查看',icon:'none'});}
   finally{if(!this.unloaded){const requests={...this.data.approvalRequests};delete requests[id];this.setData({approvalRequests:requests});}}
  },
  openBatchApproval(){
   if(!this.data.canManageReports||this.data.approvalView!=='pending'||this.reportFilterKey!==JSON.stringify(this.filters()))return;
   this.batchAttempted=false;
   this.batchAccepted=new Set();
   this.batchCandidates=this.availableBatchRows();
   this.setData({picker:{kind:'batch',title:'批量审批'},pickerError:''});
   this.showBatchSelection({});this.notify();
  },
  availableBatchRows(){return this.data.summaryRows.filter(row=>canApprovePending(row)&&!this.data.approvalRequests[row.id]&&!this.batchAccepted.has(row.id));},
  showBatchSelection(selected){
   const rows=this.batchCandidates;
   const batchSelected=Object.fromEntries(rows.filter(row=>selected[row.id]).map(row=>[row.id,true]));
   const batchCount=Object.keys(batchSelected).length;
   this.setData({batchSelected,batchCount,batchAll:rows.length>0&&batchCount===rows.length,
    batchRows:rows.map(row=>({id:row.id,label:row.personName+' · '+row.orderCode,stamp:(row.endedAt||row.createdAt)?model.time(row.endedAt||row.createdAt).slice(5,16):'',checked:!!batchSelected[row.id]}))});
  },
  toggleBatchRow(event){
   if(this.data.batchBusy)return;
   const id=event.currentTarget.dataset.id;
   this.showBatchSelection({...this.data.batchSelected,[id]:!this.data.batchSelected[id]});
   this.setData({pickerError:''});
  },
  toggleBatchAll(){
   if(this.data.batchBusy)return;
   this.showBatchSelection(this.data.batchAll?{}:Object.fromEntries(this.data.batchRows.map(row=>[row.id,true])));
   this.setData({pickerError:''});
  },
  async submitBatchApproval(){
   if(this.data.batchBusy||!this.data.canManageReports||this.data.picker?.kind!=='batch')return;
   const rows=this.batchCandidates.filter(row=>this.data.batchSelected[row.id]);
   if(!rows.length){this.setData({pickerError:'请至少选择一笔可审批的报工。'});return;}
   this.batchAttempted=true;
   this.setData({batchBusy:true,pickerError:''});this.notify();
   const unresolved={};
   for(const row of rows){
    if(this.unloaded)return;
    try{await this.requestApproval(row);this.batchAccepted.add(row.id);}catch{unresolved[row.id]=true;}
   }
   if(this.unloaded)return;
   const accepted=rows.length-Object.keys(unresolved).length;
   this.setData({batchBusy:false});
   if(accepted===rows.length)this.closePicker();
   else {
    this.batchCandidates=this.batchCandidates.filter(row=>!this.batchAccepted.has(row.id));
    this.showBatchSelection(unresolved);
    this.setData({pickerError:accepted+'笔已受理，'+(rows.length-accepted)+'笔尚未确认。关闭后可查看最新状态。'});
   }
   this.notify();
   if(accepted)wx.showToast({title:'已受理 '+accepted+' 笔审批',icon:'none'});
   this.scheduleSummaryRefresh();
  },
  openSummarySort(){this.setData({picker:{kind:'summary-sort',title:'报工排序'},summarySortDraft:this.data.summarySort});this.notify();},
  chooseSummarySort(event){this.setData({summarySortDraft:event.currentTarget.dataset.key});},
  applySummarySort(){
   const key=this.data.summarySortDraft;
   this.closePicker();
   if(key===this.data.summarySort)return;
   this.setData({summarySort:key,summaryRows:[],summaryHasMore:false,loading:true});
   this.loadReportData();
  },
  async editSummaryReport(event){
   const id=String(event.currentTarget.dataset.id),index=this.data.summaryRows.findIndex(row=>String(row.id)===id),row=this.data.summaryRows[index];
   if(!row?.canEdit||this.summaryEditorPending||this.data.reportPanel||this.data.actionBusy)return;
   this.summaryEditorPending=true;
   try{
    const query=this.createSelectorQuery?.();
    const origin=query&&!this.data.reduceMotion?await new Promise(resolve=>query.select('#rd-summary-record-'+index).boundingClientRect(resolve).exec()):null;
    if(this.unloaded||!this.properties.active)return;
    const {windowWidth:width=390,windowHeight:height=740}=wx.getWindowInfo?.()||{},inset=width<=350?12:16,sheetHeight=this.reportEditorBaseHeight();
    const geometry=morph(origin,{left:inset,top:height-12-sheetHeight,width:width-2*inset,height:sheetHeight},16);
    this.summaryEditorOrigin=origin;
    this.orderId=row.orderId;
    this.setData({processDetailMounted:true,processDetail:{id:row.processId},processReports:[row],canEditProcessReports:this.data.canManageReports,processReportsError:'',
     summaryEditorMotion:geometry?{height:origin.height,style:'--rd-editor-origin:'+geometry.closedTransform+';--rd-editor-radius:'+geometry.closedRadius+';'}:null});
    await this.openProcessReportEditor({currentTarget:{dataset:{id,action:'editReport'}}});
   }finally{
    this.summaryEditorPending=false;
    if(!this.unloaded&&!this.data.reportPanel&&this.data.summaryEditorMotion)this.setData({summaryEditorMotion:null});
   }
  },
  closeReportPanel(){
   if(this.data.actionBusy||this.data.summaryEditorClosing)return;
   if(!this.data.reportPanel||!this.data.summaryEditorMotion||this.data.reduceMotion)return management.methods.closeReportPanel.call(this);
   const {windowWidth:width=390,windowHeight:height=740}=wx.getWindowInfo?.()||{},inset=width<=350?12:16,sheetHeight=this.data.reportEditorHeight;
   const geometry=morph(this.summaryEditorOrigin,{left:inset,top:height-12-sheetHeight,width:width-2*inset,height:sheetHeight},16);
   const style=geometry?'--rd-editor-origin:'+geometry.closedTransform+';--rd-editor-radius:'+geometry.closedRadius+';':this.data.summaryEditorMotion.style;
   this.setData({summaryEditorClosing:true,summaryEditorMotion:{...this.data.summaryEditorMotion,style}});
   this.summaryEditorTimer=setTimeout(()=>{if(!this.unloaded)management.methods.closeReportPanel.call(this);},220);
  },
  toggleSearch(){this.setData({searchOpen:!this.data.searchOpen});},
  onSearch(event){this.setData({query:event.detail.value});clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>this.loadReportData(),300);},
  clearSearch(){this.setData({query:'',searchOpen:false});this.loadReportData();},
  toggleAllPeople(){this.setData({expanded:!this.data.expanded});this.present();},
  openDate(){
   const today=day(new Date()),yesterday=dayOffset(today,-1);
   this.setData({today,yesterday,picker:{kind:'date',title:'选择日期'},dateDraft:{from:this.data.from,to:this.data.to,mode:this.data.dateMode},pickerError:''});this.notify();
  },
  datePreset(event){
   const mode=event.currentTarget.dataset.mode;
   if(!dateOptions.some(option=>option.mode===mode))return;
   this.setData({dateDraft:{...this.data.dateDraft,mode},pickerError:''});
  },
  changeDate(event){this.setData({dateDraft:{...this.data.dateDraft,[event.currentTarget.dataset.part]:event.detail.value,mode:'custom'},pickerError:''});},
  applyDate(){
   const {mode}=this.data.dateDraft,today=this.data.today;
   const {from,to}=mode==='custom'?this.data.dateDraft:{from:dayOffset(today,mode==='yesterday'?-1:mode==='week'?-6:0),to:mode==='yesterday'?this.data.yesterday:today};
   if(!from||!to||from>to||to>this.data.today||(Date.parse(to)-Date.parse(from))/86400000>365){this.setData({pickerError:'请选择有效的起止日期，最长366天。'});return;}
   this.setData({from,to,dateMode:mode,dateLabel:mode==='custom'?from.slice(5)+' 至 '+to.slice(5):dateOptions.find(option=>option.mode===mode).label,picker:null,expanded:false});this.notify();this.loadReportData();
  },
  openEmployees(){
   const options=new Map(this.data.employeeOptions.map(row=>[row.id,row]));
   for(const row of this.selectedEmployees||[])if(!options.has(row.id))options.set(row.id,row);
   this.employeePickerOptions=[...options.values()];
   this.setData({picker:{kind:'employee',title:'选择员工'},employeeQuery:'',pickerError:''});
   this.showEmployeeDraft(this.data.employeeSelection??[...options.keys()],'');this.notify();
  },
  showEmployeeDraft(ids,query){
   const selected=new Set(ids),term=query.trim().normalize('NFKC').toLowerCase(),options=this.employeePickerOptions;
   const rows=options.map(row=>({...row,groupText:(row.groups||[]).join('、'),checked:selected.has(row.id)}));
   const visible=rows.filter(row=>(row.name+' '+row.groupText).normalize('NFKC').toLowerCase().includes(term));
   const screen=wx.getWindowInfo?.()?.windowHeight||740;
   this.setData({employeeDraft:ids,employeeQuery:query,employeeRows:visible,employeeAll:options.length>0&&options.every(row=>selected.has(row.id)),employeeListHeight:Math.min(Math.max(44,visible.length*42),Math.max(44,Math.floor(screen*.79)-160)),pickerError:''});
  },
  searchEmployees(event){this.showEmployeeDraft(this.data.employeeDraft,event.detail.value);},
  toggleEmployee(event){
   const id=event.currentTarget.dataset.id,ids=this.data.employeeDraft;
   this.showEmployeeDraft(ids.includes(id)?ids.filter(value=>value!==id):ids.concat(id),this.data.employeeQuery);
  },
  toggleAllEmployees(){this.showEmployeeDraft(this.data.employeeAll?[]:this.employeePickerOptions.map(row=>row.id),this.data.employeeQuery);},
  applyEmployees(){
   const ids=this.data.employeeDraft;
   if(!ids.length){this.setData({pickerError:'请至少选择一位员工。'});return;}
   this.selectedEmployees=this.data.employeeAll?[]:this.employeePickerOptions.filter(row=>ids.includes(row.id));
   this.setData({employeeSelection:this.data.employeeAll?null:ids,employeeLabel:this.data.employeeAll?'全部员工':ids.length===1?this.selectedEmployees[0].name:'已选 '+ids.length+' 人',picker:null,expanded:false});this.notify();this.loadReportData();
  },
  openFilters(){this.setData({picker:{kind:'filter',title:'筛选报表'}});this.notify();},
  chooseGroup(event){const group=event.currentTarget.dataset.id||'',selected=this.data.groups.find(g=>g.id===group);this.setData({group,groupLabel:selected?.name||'全部小组',picker:null,expanded:false});this.notify();this.loadReportData();},
  chooseProcess(event){this.setData({process:event.currentTarget.dataset.name||'',picker:null});this.notify();this.loadReportData();},
  resetFilters(){this.selectedEmployees=[];this.setData({group:'',groupLabel:'全部小组',process:'',query:'',employeeSelection:null,employeeLabel:'全部员工',picker:null});this.notify();this.loadReportData();},
  closePicker(){
   if(this.data.batchBusy)return;
   const refresh=this.data.picker?.kind==='batch'&&this.batchAttempted;
   this.setData({picker:null});this.notify();
   if(refresh)this.loadReportData({quiet:true,force:true});
  },
  openSort(){const values=this.data.reportTab==='people'?['按报工用时','按计件数量','按姓名','按报工笔数']:['按用时/数量','按名称'];wx.showActionSheet({itemList:values,success:r=>{this.setData({sort:this.data.reportTab==='people'?['time','pieces','name','count'][r.tapIndex]:['time','name'][r.tapIndex]});this.present();}});},
  openRecords(event){const {kind,id,name}=event.currentTarget.dataset,filter=kind==='person'?{personId:id}:kind==='defect'?{defectCode:id}:{process:name};this.recordRevision=(this.recordRevision||0)+1;this.setData({reportRecordsOpen:true,reportRecordsTitle:name,recordFilter:filter,reportRecords:[],recordPage:0,recordTotal:0,recordError:'',processReportsError:'',recordHasMore:false,recordHeight:Math.min(600,(wx.getWindowInfo?.().windowHeight||740)-36)});this.notify();this.loadReportRecords();},
  async loadReportRecords({more=false}={}){if(!this.data.reportRecordsOpen)return;if(this.recordReading){this.recordsPending=true;return;}this.recordReading=true;this.setReportData({recordLoading:true,recordError:''});const revision=this.recordRevision,page=more?this.data.recordPage+1:1;
   try{const r=await api.loadWorkspaceReports(this.filters({...this.data.recordFilter,page}));if(this.unloaded||revision!==this.recordRevision||!this.data.reportRecordsOpen)return;const rows=r.records.map(row=>({...recordDetails(row),...model.presentReportRecord({...row,productionWorkerName:row.personName,sync:{state:row.syncState,label:({QUEUED:'同步中',RUNNING:'同步中',RETRY:'等待同步',UNKNOWN:'待核对',FAILED:'同步异常',GROUP_APPROVAL_PENDING:'待组长审批'})[row.syncState]||''}}),canManage:r.canManage}));this.setReportData({reportRecords:more?this.data.reportRecords.concat(rows):rows,recordPage:page,recordTotal:r.total,recordHasMore:r.hasMore,recordLoading:false,canEditProcessReports:r.canManage,canManageReports:r.canManage,recordDuration:duration(r.selectionSummary.seconds)+(r.selectionSummary.unknownDurationCount?'＋待核对':'')});if(rows.some(row=>['QUEUED','RUNNING','RETRY'].includes(row.syncState)))this.scheduleRecordRefresh();}
   catch(error){if(!this.unloaded&&revision===this.recordRevision)this.setData({recordLoading:false,recordError:error.message||'报工读取失败，已保留原记录。'});}finally{this.recordReading=false;if(this.recordsPending&&!this.unloaded&&this.data.reportRecordsOpen){this.recordsPending=false;this.loadReportRecords();}}
  },
  loadMoreRecords(){if(this.data.recordHasMore)this.loadReportRecords({more:true});},
  scheduleRecordRefresh(){clearTimeout(this.recordsTimer);this.recordsTimer=setTimeout(()=>{if(this.unloaded||this.hidden||!this.properties.active||!this.data.reportRecordsOpen)return;if(this.data.actionBusy||this.data.reportPanel||this.data.reportMenu)return this.scheduleRecordRefresh();this.loadReportData({quiet:true});this.loadReportRecords();},1500);},
  closeRecords(){if(this.data.actionBusy||this.data.reportPanel||this.data.reportOrderMounted)return;this.recordRevision=(this.recordRevision||0)+1;clearTimeout(this.recordsTimer);this.resetReportMenu();this.stopResize();this.setData({reportRecordsOpen:false,processDetailMounted:false});this.notify();},
  reportMenu(event){const row=this.data.reportRecords.find(r=>r.id===String(event.currentTarget.dataset.id));if(!row||!this.data.canManageReports)return;this.orderId=row.orderId;this.setData({processDetailMounted:true,processDetail:{id:row.processId},processReports:this.data.reportRecords,canEditProcessReports:this.data.canManageReports});this.showReportActions(event);},
  async loadProcessReports(){await this.loadReportData({quiet:true,force:true});return this.loadReportRecords();},
  async openReportOrder(event){const row=this.data.reportRecords.find(r=>r.id===String(event.currentTarget.dataset.id));if(!row||this.data.reportPanel||this.data.actionBusy)return;try{const response=await api.loadOrderDetail(row.orderId);if(this.unloaded)return;const order=response.order;if(!order||String(order.id)!==String(row.orderId))throw Error('工单资料未能确认，请重试。');getApp().globalData.viewOrder=order;this.setData({reportOrderMounted:true,reportOrderVisible:true,reportOrderId:String(row.orderId),reportOrderOrigin:null});this.notify();}catch(error){this.setData({recordError:error.message||'工单资料读取失败'});}},
  closeReportOrder(){this.setData({reportOrderVisible:false});},reportOrderClosed(){this.setData({reportOrderMounted:false});this.notify();},
  stopBubble(){},
  resizeStart(event){const p=event.touches?.[0];if(!p||this.data.reportPanel)return;this.stopResize();this.drag={y:p.clientY,height:this.data.recordHeight,last:p.clientY,time:Date.now(),velocity:0};},
  resizeMove(event){const p=event.touches?.[0],d=this.drag;if(!p||!d)return;const at=Date.now(),max=(wx.getWindowInfo?.().windowHeight||740)-36;d.velocity=(d.last-p.clientY)/Math.max(1,at-d.time)*1000;d.last=p.clientY;d.time=at;this.setData({recordHeight:Math.max(310,Math.min(max,d.height+d.y-p.clientY))});},
  resizeEnd(){if(!this.drag)return;const d=this.drag;this.drag=null;const max=(wx.getWindowInfo?.().windowHeight||740)-36,target=Math.max(330,Math.min(max,this.data.recordHeight+(Date.now()-d.time<80?d.velocity*.06:0)));if(this.data.reduceMotion){this.setData({recordHeight:target});return;}const spring=motion.spring(this.data.recordHeight);spring.target=target;spring.velocity=Math.max(-1600,Math.min(1600,d.velocity));let at=Date.now();const tick=()=>{if(this.unloaded||this.drag)return;const next=Date.now();motion.step(spring,Math.min(.04,(next-at)/1000));at=next;this.setData({recordHeight:Math.max(320,Math.min(max,spring.value))});if(Math.abs(spring.value-target)>.2||Math.abs(spring.velocity)>1)this.resizeTimer=setTimeout(tick,16);};tick();},
  stopResize(){clearTimeout(this.resizeTimer);this.drag=null;}
 }
},'reports-dashboard'));
