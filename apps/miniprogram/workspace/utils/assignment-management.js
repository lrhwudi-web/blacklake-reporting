const api=require('./api');
const menuModel=require('./report-menu');
const peopleModel=require('./report-model');
const same=(a,b)=>String(a)===String(b);
module.exports={
  data:{assignmentMenu:null,assignmentMenuOpen:false,assignmentPanel:null,assignmentPanelOpen:false,assignmentDraft:null,assignmentError:'',assignmentSelection:'',assignmentQuery:'',assignmentGroups:[],assignmentChoices:[],assignmentExpanded:[],assignmentCollapsed:[],assignmentOptions:{orders:[],units:[]}},
  methods:{
    clearAssignmentMenuMotion(){clearTimeout(this.assignmentMenuFrame);clearTimeout(this.assignmentMenuTimer);this.assignmentMenuRevision=(this.assignmentMenuRevision||0)+1;},
    clearAssignmentPanelMotion(){clearTimeout(this.assignmentPanelFrame);clearTimeout(this.assignmentPanelTimer);this.assignmentPanelRevision=(this.assignmentPanelRevision||0)+1;},
    resetAssignmentMenu(){this.clearAssignmentMenuMotion();this.setData({assignmentMenu:null,assignmentMenuOpen:false});},
    resetAssignmentUI(){this.clearQueueGesture?.();this.resetAssignmentMenu();this.clearAssignmentPanelMotion();this.setData({assignmentPanel:null,assignmentPanelOpen:false,assignmentDraft:null,assignmentSelection:'',assignmentError:''});},
    closeAssignmentMenu(){
      if(!this.data.assignmentMenu)return;this.clearAssignmentMenuMotion();const revision=this.assignmentMenuRevision;
      this.setData({assignmentMenuOpen:false});this.assignmentMenuTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.assignmentMenuRevision)this.setData({assignmentMenu:null});},this.data.reduceMotion?100:150);
    },
    showAssignmentActions(event){
      if(!this.data.canManageExecution||this.data.actionBusy||this.data.reportPanel||this.data.assignmentPanel)return;
      const task=this.data.executionAssignments.find(row=>same(row.id,event.currentTarget.dataset.id));if(!task)return;
      if(same(this.data.assignmentMenu?.assignmentId,task.id)&&this.data.assignmentMenuOpen){this.closeAssignmentMenu();return;}
      const options=[{action:'insert',label:'插单',icon:'insert',allowed:task.canManageQueue},{action:'queue',label:'调整顺序',icon:'sort',allowed:task.canManageQueue},{action:'editAssignment',label:'编辑派工',icon:'edit',allowed:task.canEditAssignment},{action:'cancelAssignment',label:'撤销派工',icon:'delete',allowed:task.canCancelAssignment}].filter(row=>row.allowed);
      if(task.leaderTimerAction)options.unshift({action:task.leaderTimerAction,label:task.leaderTimerAction==='leaderPauseTimer'?'暂停':'启动',icon:task.leaderTimerAction==='leaderPauseTimer'?'pause':'start',disabled:task.leaderTimerDisabled});
      const anchorId=event.currentTarget.dataset.anchor;if(!options.length||!/^assignment-more-\d+$/.test(anchorId||''))return;
      this.resetReportMenu();this.resetAssignmentMenu();const revision=this.assignmentMenuRevision;
      let query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();if(!query)return;if(query.in&&this.properties)query=query.in(this);
      query.select('#'+anchorId).boundingClientRect().select('#'+anchorId.replace('assignment-more-','assignment-card-')).boundingClientRect().exec(results=>{
        if(this.unloaded||revision!==this.assignmentMenuRevision||!this.data.canManageExecution||this.data.assignmentPanel)return;
        if(!results?.[1])return;
        const viewport=wx.getWindowInfo?.()||wx.getSystemInfoSync?.(),geometry=menuModel.layout(results[0],viewport,options.length,results[1]);if(!geometry)return;
        this.setData({assignmentMenu:{...geometry,assignmentId:task.id,anchorId,options},assignmentMenuOpen:false},()=>{this.assignmentMenuFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.assignmentMenuRevision)this.setData({assignmentMenuOpen:true});},16);});
      });
    },
    chooseAssignmentAction(event){
      const menu=this.data.assignmentMenu,action=event.currentTarget.dataset.action;
      if(!menu||!this.data.assignmentMenuOpen||!menu.options.some(row=>row.action===action&&!row.disabled))return;
      if(['leaderStartTimer','leaderPauseTimer'].includes(action)){void this.changeLeaderTimer(menu.assignmentId,action);return;}
      if(['insert','queue'].includes(action)){this.openTaskQueue({currentTarget:{dataset:{id:menu.assignmentId,mode:action}}});return;}
      this.openAssignmentAction({currentTarget:{dataset:{id:menu.assignmentId,action}}});
    },
    async changeLeaderTimer(id,action){
      const task=this.data.executionAssignments.find(row=>same(row.id,id));
      if(!this.data.canManageExecution||this.data.actionBusy||task?.leaderTimerAction!==action||task.leaderTimerDisabled)return;
      const intent=this.leaderTimerIntent;
      const pending=intent?.id===id&&intent.action===action&&intent.version===this.data.executionVersion?intent:{id,action,version:this.data.executionVersion,key:'leader-timer-'+Date.now()+'-'+Math.random().toString(36).slice(2)};
      this.leaderTimerIntent=pending;
      this.resetAssignmentMenu();this.setData({actionBusy:true,executionError:''});
      let failure='';
      try{
        await api.executeExecutionAction(action,{assignmentId:id},{expectedVersion:pending.version,operationId:pending.key});
        this.leaderTimerIntent=null;
        if(!this.unloaded)wx.showToast({title:action==='leaderPauseTimer'?'已暂停组员计时':'已启动组员计时',icon:'none'});
      }catch(error){failure=error.message||'计时状态暂未确认，请刷新查看。';}
      finally{
        if(!this.unloaded){
          await this.loadExecution();
          if(!this.unloaded)this.setData({actionBusy:false,...(failure?{executionError:failure}:{})});
        }
      }
    },
    openAssignmentAction(event){
      if(!this.data.canManageExecution||this.data.actionBusy||this.data.reportPanel||this.data.assignmentPanel)return;
      const action=event.currentTarget.dataset.action,task=this.data.executionAssignments.find(row=>same(row.id,event.currentTarget.dataset.id));
      if(!task||!['editAssignment','cancelAssignment'].includes(action)||!task[action==='editAssignment'?'canEditAssignment':'canCancelAssignment'])return;
      this.resetAssignmentMenu();this.resetReportMenu();this.clearAssignmentPanelMotion();this.resetGlassSegments();
      const revision=this.assignmentPanelRevision,processes=this.data.assignmentOptions?.orders?.find(row=>same(row.id,task.orderId))?.processes||[];
      this.setData({assignmentPanel:{id:task.id,action,version:this.data.executionVersion,title:action==='editAssignment'?'编辑派工':'撤销派工',workerId:String(task.workerId),processId:task.processId,workerName:task.workerName,processName:task.processName,orderCode:task.orderCode,hasHistory:!!task.segments?.length||task.reports.length>0,wasRunning:task.status==='IN_PROGRESS',reportCount:task.reportCount},assignmentPanelOpen:false,assignmentSelection:'',assignmentError:'',
        assignmentDraft:{workerId:String(task.workerId),workerName:task.workerName,processId:task.processId,processName:task.processName,unitId:task.unitId,priority:task.priority,processes}});
      this.assignmentPanelFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.assignmentPanelRevision)this.setData({assignmentPanelOpen:true});},16);
    },
    closeAssignmentPanel(){
      if(this.data.actionBusy)return;
      if(this.data.assignmentPanel?.action==='queue'){this.closeQueuePanel();return;}
      if(this.data.assignmentSelection){this.setData({assignmentSelection:'',assignmentQuery:''});return;}
      this.clearAssignmentPanelMotion();const revision=this.assignmentPanelRevision;this.setData({assignmentPanelOpen:false});
      this.assignmentPanelTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.assignmentPanelRevision)this.setData({assignmentPanel:null,assignmentDraft:null,assignmentSelection:'',assignmentError:''});},this.data.reduceMotion?100:180);
    },
    openAssignmentSelection(event){
      const selection=event.currentTarget.dataset.selection;
      if(this.data.actionBusy||this.data.assignmentPanel?.action!=='editAssignment'||!['people','process','unit'].includes(selection))return;
      const worker=this.data.reportOptions.employees.find(row=>same(row.id,this.data.assignmentDraft.workerId));
      this.setData({assignmentSelection:selection,assignmentQuery:'',assignmentExpanded:worker?.departments||['未分部门'],assignmentCollapsed:[]});this.updateAssignmentChoices();
    },
    updateAssignmentChoices(){
      const d=this.data,query=d.assignmentQuery.trim().toLowerCase();
      if(d.assignmentSelection==='people'){
        const result=peopleModel.peopleGroups(d.reportOptions.employees,query,d.assignmentExpanded,d.assignmentDraft.workerId,d.assignmentCollapsed,d.reportOptions.peopleGroupConfig);
        this.setData({assignmentGroups:result.groups,assignmentChoices:[]});
      }else{
        const choices=d.assignmentSelection==='process'?d.assignmentDraft.processes.map(row=>({id:row.id,name:row.name,selected:same(row.id,d.assignmentDraft.processId),disabled:row.closed!==false||row.selectable!==true})):this.data.assignmentOptions.units.map(row=>({id:row.id,name:row.id,selected:same(row.id,d.assignmentDraft.unitId),disabled:false}));
        this.setData({assignmentChoices:choices.filter(row=>String(row.name).toLowerCase().includes(query))});
      }
    },
    onAssignmentSearch(event){this.setData({assignmentQuery:event.detail.value});this.updateAssignmentChoices();},
    toggleAssignmentDepartment(event){
      const key=event.currentTarget.dataset.key,group=this.data.assignmentGroups.find(row=>row.key===key);if(!group||this.data.actionBusy)return;
      const field=this.data.assignmentQuery.trim()?'assignmentCollapsed':'assignmentExpanded',values=this.data[field];
      this.setData({[field]:values.includes(key)?values.filter(value=>value!==key):[...values,key]});this.updateAssignmentChoices();
    },
    selectAssignmentChoice(event){
      if(this.data.actionBusy||!this.data.assignmentPanelOpen)return;const id=event.currentTarget.dataset.id,draft={...this.data.assignmentDraft};
      if(this.data.assignmentSelection==='people'){
        const person=this.data.reportOptions.employees.find(row=>same(row.id,id));if(!person)return;draft.workerId=String(person.id);draft.workerName=person.name;
      }else{
        const choice=this.data.assignmentChoices.find(row=>same(row.id,id));if(!choice||choice.disabled)return;
        if(this.data.assignmentSelection==='process'){draft.processId=choice.id;draft.processName=choice.name;}else if(this.data.assignmentSelection==='unit')draft.unitId=choice.id;else return;
      }
      this.setData({assignmentDraft:draft,assignmentSelection:'',assignmentError:''});
    },
    setAssignmentPriority(event){const priority=event.currentTarget.dataset.priority;if(!this.data.actionBusy&&this.data.assignmentPanel?.action==='editAssignment'&&['NORMAL','URGENT'].includes(priority))this.setData({assignmentDraft:{...this.data.assignmentDraft,priority}});},
    async refreshAssignmentDraft(){
      if(this.data.actionBusy||!this.data.assignmentPanel)return;await this.loadExecution();if(this.unloaded)return;
      const panel=this.data.assignmentPanel,task=this.data.executionAssignments.find(row=>same(row.id,panel.id));
      if(!this.data.canManageExecution||!task?.[panel.action==='editAssignment'?'canEditAssignment':'canCancelAssignment']){this.setData({assignmentError:'该派工已变化，请关闭面板后重新选择。'});return;}
      this.setData({assignmentPanel:{...panel,version:this.data.executionVersion},assignmentError:''});
    },
    async confirmAssignmentChange(){
      const panel=this.data.assignmentPanel;if(!panel||!this.data.assignmentPanelOpen||this.data.assignmentSelection||this.data.actionBusy||!this.data.canManageExecution)return;
      const draft=this.data.assignmentDraft,input=panel.action==='editAssignment'?{assignmentId:panel.id,workerId:draft.workerId,processId:draft.processId,unitId:draft.unitId,priority:draft.priority}:{assignmentId:panel.id};
      this.setData({actionBusy:true,assignmentError:''});
      this.assignmentOperationSerial=(this.assignmentOperationSerial||0)+1;
      try{
        await api.executeExecutionAction(panel.action,input,{expectedVersion:panel.version,operationId:'assignment-change-'+Date.now()+'-'+this.assignmentOperationSerial});
        if(this.unloaded)return;this.setData({actionBusy:false});this.closeAssignmentPanel();await this.loadExecution();
        if(!this.unloaded)wx.showToast({title:panel.action==='editAssignment'?'派工已更新':'派工已撤销',icon:'none'});
      }catch(error){if(!this.unloaded)this.setData({assignmentError:error.message||'操作未完成，请核对后重试。'});}
      finally{if(!this.unloaded)this.setData({actionBusy:false});}
    },
    stopAssignmentBubble(){}
  }
};
