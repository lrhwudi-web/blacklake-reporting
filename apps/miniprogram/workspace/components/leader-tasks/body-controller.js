// Generated from pages/tasks/tasks.js.
const api=require('../../utils/api');
const model=require('../../utils/task-model');
const overview=require('../../utils/task-overview');
const management=require('../../utils/task-report-management');
const assignments=require('../../utils/assignment-management');
const product=require('../../utils/task-product');
const queue=require('../../utils/task-queue');
const photo=require('../../utils/glass-image-viewer');
const glassNav=require('../../utils/glass-navigation');
const segments=require('../../utils/glass-segments');
module.exports = {
  ...management.methods,...assignments.methods,...product.methods,...queue.methods,...photo.methods,...glassNav.methods,...segments.methods,
  data:{...management.data,...assignments.data,...product.data,...queue.data,...photo.data,...glassNav.data,...segments.data,navActiveIndex:1,reduceMotion:false,
    taskTab:'assignments',taskStatus:'all',keyword:'',searchOpen:false,loaded:false,
    visibleTasks:[],visibleReports:[],taskCounts:{all:0,paused:0,running:0},reportCount:0,deletedCount:0,
    showDeleted:false,reportScope:'',scopeLabel:'',sourceLabel:'',updatedLabel:'',
    groupMode:'person',taskDrill:null,overviewGroups:[],displayTasks:[],displayReports:[],drillCount:0,
    reportDateMode:'today',reportDateStart:'',reportDateEnd:'',todayKey:'',overviewFilterLabel:'全部派工',overviewGroupLabel:'按人员',
    assignmentHistory:false,historyDateMode:'all',historyDateStart:'',historyDateEnd:'',historyAssignments:[],historyPage:0,historyHasMore:false,historyLoading:false,historyError:'',
    taskChooser:null,taskChooserOpen:false,taskDateDraft:{start:'',end:''},taskDateError:''},
  async onLoad(){
    this.setupGlassNav();this.setupGlassSegments();
    if(getApp().globalData.entry?.appRole!=='floor8_leader'){
      this.setData({executionError:'当前身份不能查看组长任务记录。'});return;
    }
    this._loadPromise=this.loadExecution();await this._loadPromise;
  },
  onShow(){if(this.data.loaded&&!this.data.reportPanel&&!this.data.assignmentPanel&&!this.data.productPanel&&!this.data.taskChooser&&!this.data.actionBusy)this.loadExecution();},
  onResize(){this.onInlineSortCancel();this.resetReportMenu();this.resetAssignmentMenu();},
  onUnload(){
    this.clearReportEditorMotion();
    this.unloaded=true;this.executionRevision=(this.executionRevision||0)+1;
    this.disposeInlineSort();
    this.clearGlassNav();this.disposeGlassSegments();this.clearReportMenuMotion();this.clearReportPeopleMotion();this.clearReportTimeMotion();
    this.resetAssignmentUI();
    this.clearTaskProductMotion();this.disposeProductPreview();
    this.clearTaskChooserMotion();
  },
  async loadExecution(){
    if(getApp().globalData.entry?.appRole!=='floor8_leader')return;
    const revision=this.executionRevision=(this.executionRevision||0)+1;
    this.resetReportMenu();this.resetAssignmentMenu();this.setData({executionLoading:true,executionError:'',canManageExecution:false});
    try{
      const response=await api.loadLeaderTasks({activeOnly:this.data.taskTab==='assignments'});
      if(this.unloaded||revision!==this.executionRevision)return;
      if(!Array.isArray(response.assignments)||!Number.isSafeInteger(response.version)||!response.assignments.every(row=>row&&row.id!=null&&Array.isArray(row.reports)))throw new Error('任务记录未能确认，请重试。');
      this.setData({executionAssignments:model.present(response.assignments),executionVersion:response.version,
        reportOptions:response.reportOptions||{employees:[],defectReasons:[]},assignmentOptions:response.assignmentOptions||{orders:[],units:[]},executionLoaded:true,executionLoading:false,loaded:true,
        canManageExecution:response.canManage===true&&getApp().globalData.entry?.appRole==='floor8_leader',
        sourceLabel:response.source==='workspace-live'?'本系统派工记录':'当前组长 · 已加载记录',
        updatedLabel:response.fetchedAt||'',todayKey:overview.dayKey(response.fetchedAt)});
      this.updateView();
    }catch(error){
      if(this.unloaded||revision!==this.executionRevision)return;
      this.setData({executionLoading:false,canManageExecution:false,executionError:error.message||'任务读取失败，请重试。'});
    }
  },
  refreshTasks(){if(!this.data.actionBusy&&!this.data.reportPanel&&!this.data.assignmentPanel&&!this.data.productPanel&&!this.data.taskChooser)this.loadExecution();},
  updateView(){
    const d=this.data,base=model.view(this.taskRecordRows(),{keyword:d.keyword,status:d.taskStatus,reportScope:d.reportScope,deleted:d.showDeleted});
    const projected=overview.project(base,{tab:d.taskTab,groupMode:d.groupMode,status:d.taskStatus,dateMode:d.reportDateMode,today:d.todayKey,start:d.reportDateStart,end:d.reportDateEnd,deleted:d.showDeleted,drill:d.taskDrill,history:d.assignmentHistory,historyDateMode:d.historyDateMode,historyStart:d.historyDateStart,historyEnd:d.historyDateEnd});
    this.setData({...base,...projected,displayTasks:d.inlineSorting?d.displayTasks:this.decorateTaskCards(projected.displayTasks)});
  },
  taskRecordRows(){
    const d=this.data;
    return d.assignmentHistory&&typeof api.loadAssignmentHistory==='function'&&(d.taskTab==='assignments'||d.reportScope)?d.historyAssignments:d.executionAssignments;
  },
  async loadAssignmentHistory(more=false){
    if(typeof api.loadAssignmentHistory!=='function'||!this.data.assignmentHistory||more&&(this.data.historyLoading||!this.data.historyHasMore))return;
    const d=this.data,mode=d.historyDateMode,today=d.todayKey,day=mode==='yesterday'?overview.offsetDay(today,-1):today;
    const start=mode==='all'?'':mode==='custom'?d.historyDateStart:mode==='week'?overview.offsetDay(today,-6):day;
    const end=mode==='all'?'':mode==='custom'?d.historyDateEnd:day;
    const revision=this.historyRevision=(this.historyRevision||0)+1,page=more?d.historyPage+1:1;
    if(!more)this.setData({historyAssignments:[],historyHasMore:false,historyPage:0});
    this.setData({historyLoading:true,historyError:''});this.updateView();
    try{
      const response=await api.loadAssignmentHistory(page,start,end);
      if(this.unloaded||revision!==this.historyRevision||!this.data.assignmentHistory)return;
      const result=model.present(response.assignments),previous=more?this.data.historyAssignments:[];
      const known=new Set(previous.map(row=>row.id));
      this.setData({historyAssignments:[...previous,...result.filter(row=>!known.has(row.id))],historyPage:page,historyHasMore:response.hasMore===true});this.updateView();
    }catch(error){if(!this.unloaded&&revision===this.historyRevision)this.setData({historyError:error.message||'历史派工读取失败，请重试。'});}
    finally{if(!this.unloaded&&revision===this.historyRevision)this.setData({historyLoading:false});}
  },
  loadMoreAssignmentHistory(){void this.loadAssignmentHistory(true);},
  retryAssignmentHistory(){void this.loadAssignmentHistory(this.data.historyPage>0);},
  setTaskTab(event){
    const tab=event.currentTarget.dataset.tab;if(!['assignments','reports'].includes(tab)||this.data.actionBusy)return;
    if(this.data.assignmentPanel||this.data.productPanel||this.data.reportPanel||this.data.taskChooser)return;this.resetReportMenu();this.resetAssignmentMenu();this.resetTaskChooser();
    this.setData({taskTab:tab,taskDrill:null,reportScope:''});this.updateView();
    if(tab==='reports'&&typeof api.loadAssignmentHistory==='function')void this.loadExecution();
  },
  setTaskStatus(event){
    const status=event.currentTarget.dataset.status;if(!Object.keys(overview.stateLabels).includes(status)||this.data.actionBusy)return;
    if(this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser)return;this.resetAssignmentMenu();this.setData({taskStatus:status});this.updateView();
  },
  toggleTaskSearch(){if(this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser)return;this.resetAssignmentMenu();this.resetReportMenu();const searchOpen=!this.data.searchOpen;this.setData({searchOpen,keyword:searchOpen?this.data.keyword:''});this.updateView();},
  onTaskSearch(event){if(this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser)return;this.resetAssignmentMenu();this.resetReportMenu();this.setData({keyword:event.detail.value});this.updateView();},
  setDeleted(event){this.resetReportMenu();this.setData({showDeleted:event.currentTarget.dataset.deleted==='true'||event.currentTarget.dataset.deleted===true});this.updateView();},
  showTaskReports(event){
    if(this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser||this.data.actionBusy)return;this.resetAssignmentMenu();
    const task=this.taskRecordRows().find(row=>String(row.id)===String(event.currentTarget.dataset.id));if(!task)return;
    this.resetGlassSegments();this.setData({taskTab:'reports',reportScope:String(task.id),showDeleted:false,taskDrill:{mode:'assignment',key:String(task.id),label:task.workerName+' · '+task.processName,tab:'reports',allDates:true}});this.updateView();
  },
  clearReportScope(){this.setData({reportScope:'',taskDrill:null});this.updateView();},
  openTaskHistory(){
    if(this.data.taskTab!=='assignments'||this.data.actionBusy||this.data.executionLoading||this.data.reportPanel||this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser)return;
    this.resetAssignmentMenu();this.resetReportMenu();
    if(this.data.assignmentHistory){this.historyRevision=(this.historyRevision||0)+1;this.setData({assignmentHistory:false,taskStatus:this.beforeHistoryStatus||'all',historyLoading:false});this.updateView();return;}
    this.beforeHistoryStatus=this.data.taskStatus;this.setData({assignmentHistory:true,taskStatus:'all'});this.updateView();this.openTaskChooser({currentTarget:{dataset:{kind:'history-date'}}});void this.loadAssignmentHistory();
  },
  openTaskGroup(event){
    if(this.data.actionBusy||this.data.taskChooser||this.data.productPanel||this.data.reportPanel||this.data.assignmentPanel)return;
    const group=this.data.overviewGroups.find(row=>row.key===event.currentTarget.dataset.key);if(!group)return;
    this.resetAssignmentMenu();this.resetReportMenu();this.setData({taskDrill:{mode:this.data.groupMode,key:group.key,label:group.label,tab:this.data.taskTab}});this.updateView();
  },
  closeTaskGroup(){
    if(this.data.actionBusy||this.data.reportPanel||this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser)return;
    this.resetAssignmentMenu();this.resetReportMenu();this.setData({taskDrill:null,reportScope:''});this.updateView();
  },
  clearTaskChooserMotion(){clearTimeout(this.taskChooserFrame);clearTimeout(this.taskChooserTimer);this.taskChooserRevision=(this.taskChooserRevision||0)+1;},
  resetTaskChooser(){this.clearTaskChooserMotion();this.setData({taskChooser:null,taskChooserOpen:false,taskDateError:''});},
  openTaskChooser(event){
    if(this.data.actionBusy||this.data.reportPanel||this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser)return;
    let kind=event.currentTarget.dataset.kind;if(kind==='filter')kind=this.data.taskTab==='assignments'?(this.data.assignmentHistory?'history-date':'status'):'date';if(!['status','date','history-date','group'].includes(kind))return;
    this.resetReportMenu();this.resetAssignmentMenu();this.resetGlassSegments();this.clearTaskChooserMotion();const revision=this.taskChooserRevision;
    const history=kind==='history-date',selectedDateMode=history?this.data.historyDateMode:this.data.taskDrill?.allDates?'all':this.data.reportDateMode;
    const options=kind==='status'?Object.entries(overview.stateLabels).filter(([key])=>!['completed','cancelled'].includes(key)).map(([key,label])=>({key,label,selected:key===this.data.taskStatus})):kind==='group'?[{key:'person',label:'按人员'},{key:'order',label:'按工单'},{key:'process',label:'按工序'}].map(row=>({...row,selected:row.key===this.data.groupMode})):[{key:'today',label:overview.dateLabel('today',this.data.todayKey)},{key:'yesterday',label:overview.dateLabel('yesterday',this.data.todayKey)},{key:'week',label:'最近7天'},{key:'all',label:'全部日期'}].map(row=>({...row,selected:row.key===selectedDateMode}));
    this.setData({taskChooser:{kind,title:kind==='status'?'派工筛选':kind==='group'?'分组方式':history?'历史完成时间':'报工筛选',options},taskChooserOpen:false,taskDateDraft:{start:(history?this.data.historyDateStart:this.data.reportDateStart)||this.data.todayKey,end:(history?this.data.historyDateEnd:this.data.reportDateEnd)||this.data.todayKey},taskDateError:''});
    this.taskChooserFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.taskChooserRevision)this.setData({taskChooserOpen:true});},16);
  },
  closeTaskChooser(){if(this.data.actionBusy)return;this.clearTaskChooserMotion();const revision=this.taskChooserRevision;this.setData({taskChooserOpen:false});this.taskChooserTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.taskChooserRevision)this.setData({taskChooser:null});},this.data.reduceMotion?100:180);},
  chooseTaskOption(event){
    const chooser=this.data.taskChooser,key=event.currentTarget.dataset.key;if(!chooser||!chooser.options.some(row=>row.key===key)||this.data.actionBusy)return;
    if(chooser.kind==='status')this.setData({taskStatus:key});
    else if(chooser.kind==='group')this.setData({groupMode:key,taskDrill:null,reportScope:''});
    else if(chooser.kind==='history-date')this.setData({historyDateMode:key});
    else this.setData({reportDateMode:key,taskDrill:this.data.taskDrill?.mode==='assignment'?{...this.data.taskDrill,allDates:false}:this.data.taskDrill});
    this.closeTaskChooser();this.updateView();if(chooser.kind==='history-date')void this.loadAssignmentHistory();
  },
  onTaskDateChange(event){const field=event.currentTarget.dataset.field;if(['start','end'].includes(field))this.setData({taskDateDraft:{...this.data.taskDateDraft,[field]:event.detail.value},taskDateError:''});},
  applyTaskDates(){const {start,end}=this.data.taskDateDraft;if(!overview.validDay(start)||!overview.validDay(end)||start>end){this.setData({taskDateError:'请选择有效的起止日期，结束不能早于开始。'});return;}const history=this.data.taskChooser?.kind==='history-date';if(history)this.setData({historyDateMode:'custom',historyDateStart:start,historyDateEnd:end});else this.setData({reportDateMode:'custom',reportDateStart:start,reportDateEnd:end,taskDrill:this.data.taskDrill?.mode==='assignment'?{...this.data.taskDrill,allDates:false}:this.data.taskDrill});this.closeTaskChooser();this.updateView();if(history)void this.loadAssignmentHistory();},
  chooseTaskDeleted(event){this.setDeleted(event);this.closeTaskChooser();},
  refreshFromTaskChooser(){this.resetTaskChooser();this.refreshTasks();},
  stopTaskChooserBubble(){},
  async resumeAssignment(event){
    if(!this.data.canManageExecution||this.data.actionBusy||this.data.reportPanel||this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser)return;
    const task=this.data.executionAssignments.find(row=>String(row.id)===String(event.currentTarget.dataset.id));if(!task?.canResume)return;
    this.setData({actionBusy:true,executionError:''});
    try{
      await api.executeExecutionAction('resume',{assignmentId:task.id},{expectedVersion:this.data.executionVersion,operationId:'tasks-resume-'+Date.now()+'-'+task.id});
      await this.loadExecution();if(!this.unloaded)wx.showToast({title:'已由组长继续启动',icon:'none'});
    }catch(error){await this.loadExecution();if(!this.unloaded)this.setData({executionError:error.message||'未能继续启动，请重试。'});}
    finally{if(!this.unloaded)this.setData({actionBusy:false});}
  },
  pendingReference(){wx.showToast({title:'暂未开放',icon:'none'});}
};
