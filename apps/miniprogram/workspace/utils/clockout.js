const api=require('./api'),liquid=require('./liquid-geometry');
const weekdays=[{key:1,label:'一'},{key:2,label:'二'},{key:3,label:'三'},{key:4,label:'四'},{key:5,label:'五'},{key:6,label:'六'},{key:7,label:'日'}];
const data={clockoutPanel:null,clockoutOpen:false,clockoutClosing:false,clockoutMotion:null,clockoutBusy:false,clockoutLoading:false,clockoutError:'',clockoutView:'overview',clockoutDraft:null,clockoutDays:weekdays,clockoutResult:null};
function valid(value){return value&&Array.isArray(value.groups)&&Number.isSafeInteger(value.taskCount)&&value.taskCount>=0&&Number.isSafeInteger(value.employeeCount)&&value.schedule&&Number.isInteger(value.schedule.revision)&&Array.isArray(value.schedule.days)&&value.version!=null;}
function summary(schedule){if(!schedule.enabled)return '未开启';return (schedule.days.length===7?'每天':schedule.days.length===5&&[1,2,3,4,5].every(day=>schedule.days.includes(day))?'工作日':'每周'+weekdays.filter(day=>schedule.days.includes(day.key)).map(day=>day.label).join('、'))+' '+schedule.time;}
const methods={
  clearClockoutTimers(){clearTimeout(this.clockoutFrame);clearTimeout(this.clockoutTimer);clearInterval(this.clockoutPoll);this.clockoutFrame=this.clockoutTimer=this.clockoutPoll=null;},
  disposeClockout(){this.clearClockoutTimers();this.clockoutRevision=(this.clockoutRevision||0)+1;},
  async openClockout(options={}){
    if(getApp().globalData.entry?.appRole!=='floor8_leader'||this.data.clockoutPanel||this.data.listPanel||this.data.detailMounted||this.data.operationPanel||this.data.workspaceTaskModal||this.data.workspaceTaskBusy)return;
    this.cancelGlassNav?.();this.clearClockoutTimers();this.clockoutInstant=options.instant===true;this.clockoutRevision=(this.clockoutRevision||0)+1;this.clockoutKey=null;
    this.setData({...data,clockoutPanel:{groups:[],taskCount:0,employeeCount:0,schedule:null},clockoutLoading:true},()=>this.measureClockout());
    await this.reloadClockout();
    if(this.data.clockoutPanel&&!this.unloaded)this.clockoutPoll=setInterval(()=>{if(this.data.clockoutView==='overview'&&!this.data.clockoutBusy)this.reloadClockout(true);},10000);
  },
  measureClockout(){
    const revision=this.clockoutRevision,done=rects=>{
      if(this.unloaded||revision!==this.clockoutRevision||this.data.clockoutClosing||!this.data.clockoutPanel)return;
      const motion=this.clockoutInstant||this.data.reduceMotion?null:liquid.morph(rects?.[0],rects?.[1],22);
      this.setData({clockoutMotion:motion},()=>{this.clockoutFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.clockoutRevision&&!this.data.clockoutClosing)this.setData({clockoutOpen:true});},16);});
    };
    const query=wx.createSelectorQuery?.();if(!query||this.data.reduceMotion||this.clockoutInstant)return done();
    query.select('#nav-clockout').boundingClientRect();query.select('.clockout-sheet').boundingClientRect().exec(done);
  },
  async reloadClockout(silent=false){
    if(!this.data.clockoutPanel||this.data.listPanel||this.data.clockoutBusy||this.data.clockoutClosing||this.data.clockoutLoading&&silent)return;
    const revision=this.clockoutRevision,loadRevision=this.clockoutLoadRevision=(this.clockoutLoadRevision||0)+1;if(!silent)this.setData({clockoutLoading:true,clockoutError:''});
    try{const result=await api.loadClockout();if(!valid(result))throw Error('下班范围读取失败，请重新读取。');if(this.unloaded||revision!==this.clockoutRevision||loadRevision!==this.clockoutLoadRevision||this.data.clockoutClosing)return;
      this.setData({clockoutPanel:{...result,scheduleSummary:summary(result.schedule)},clockoutLoading:false,clockoutResult:result.taskCount>0?null:this.data.clockoutResult,...(!silent?{clockoutError:''}:{})});
    }catch(error){if(!this.unloaded&&revision===this.clockoutRevision&&loadRevision===this.clockoutLoadRevision)this.setData({clockoutLoading:false,clockoutError:error.message||'读取失败，请重试。'});}
  },
  closeClockout(){
    if(!this.data.clockoutPanel||this.data.listPanel||this.data.clockoutBusy||this.data.clockoutClosing)return;
    this.clearClockoutTimers();this.clockoutRevision=(this.clockoutRevision||0)+1;this.setData({clockoutOpen:false,clockoutClosing:true});
    this.clockoutTimer=setTimeout(()=>{if(this.unloaded)return;this.setData({...data});this.refreshClockoutTasks();},this.data.reduceMotion||this.clockoutInstant||!this.data.clockoutMotion?100:liquid.DURATION);
  },
  refreshClockoutTasks(){const panel=this.selectComponent?.('#leader-tasks-panel');panel?.loadExecution?.();},
  async confirmClockout(){
    const panel=this.data.clockoutPanel;if(!panel||this.data.clockoutBusy||this.data.clockoutLoading||this.data.clockoutClosing||!panel.groups.length||!panel.taskCount||this.data.clockoutError)return;
    this.clockoutKey||='clockout-'+Date.now()+'-'+Math.random().toString(36).slice(2);const revision=this.clockoutRevision;
    this.clockoutLoadRevision=(this.clockoutLoadRevision||0)+1;this.setData({clockoutBusy:true,clockoutError:''});
    try{const result=await api.pauseClockout({expectedVersion:panel.version},this.clockoutKey);if(!Number.isSafeInteger(result?.pausedCount)||result.pausedCount<0)throw Error('暂停回执未能确认，请重新读取。');
      if(this.unloaded||revision!==this.clockoutRevision)return;this.clockoutKey=null;this.setData({clockoutBusy:false,clockoutResult:result});await this.reloadClockout();this.refreshClockoutTasks();
    }catch(error){if(!this.unloaded&&revision===this.clockoutRevision)this.setData({clockoutBusy:false,clockoutError:(error.message||'下班结果未能确认。')+' 请重新读取核对。'});}
  },
  editClockoutSchedule(){if(!this.data.clockoutPanel?.schedule||this.data.clockoutLoading||this.data.clockoutBusy||this.data.clockoutClosing)return;const draft=JSON.parse(JSON.stringify(this.data.clockoutPanel.schedule));this.clockoutScheduleKey=null;this.setData({clockoutView:'schedule',clockoutDraft:draft,clockoutDays:weekdays.map(day=>({...day,selected:draft.days.includes(day.key)})),clockoutError:''});},
  backClockout(){if(!this.data.clockoutBusy){this.setData({clockoutView:'overview',clockoutDraft:null,clockoutError:''});this.reloadClockout();}},
  toggleClockoutSchedule(){if(this.data.clockoutBusy)return;const draft=this.data.clockoutDraft;if(draft)this.setData({clockoutDraft:{...draft,enabled:!draft.enabled}});this.clockoutScheduleKey=null;},
  changeClockoutTime(event){if(this.data.clockoutBusy||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(event.detail.value))return;this.setData({clockoutDraft:{...this.data.clockoutDraft,time:event.detail.value}});this.clockoutScheduleKey=null;},
  toggleClockoutDay(event){if(this.data.clockoutBusy)return;const day=Number(event.currentTarget.dataset.day),draft=this.data.clockoutDraft;if(!draft||!weekdays.some(row=>row.key===day))return;const days=draft.days.includes(day)?draft.days.filter(value=>value!==day):[...draft.days,day].sort((a,b)=>a-b);this.setData({clockoutDraft:{...draft,days},clockoutDays:weekdays.map(row=>({...row,selected:days.includes(row.key)})),clockoutError:''});this.clockoutScheduleKey=null;},
  async saveClockoutTime(){
    const draft=this.data.clockoutDraft;if(!draft||this.data.clockoutBusy||this.data.clockoutClosing)return;if(!draft.days.length){this.setData({clockoutError:'请至少选择一天。'});return;}
    this.clockoutScheduleKey||='clockout-time-'+Date.now()+'-'+Math.random().toString(36).slice(2);const revision=this.clockoutRevision;
    this.setData({clockoutBusy:true,clockoutError:''});
    try{await api.saveClockoutSchedule({expectedRevision:draft.revision,enabled:draft.enabled,time:draft.time,days:draft.days},this.clockoutScheduleKey);
      const result=await api.loadClockout();if(!valid(result)||result.schedule.revision!==draft.revision+1||result.schedule.enabled!==draft.enabled||result.schedule.time!==draft.time||JSON.stringify(result.schedule.days)!==JSON.stringify(draft.days))throw Error('保存结果未能核对，请重新读取。');
      if(this.unloaded||revision!==this.clockoutRevision)return;this.clockoutScheduleKey=null;this.setData({clockoutBusy:false,clockoutView:'overview',clockoutDraft:null,clockoutPanel:{...result,scheduleSummary:summary(result.schedule)}});wx.showToast({title:draft.enabled?'定时下班已开启':'定时下班已关闭',icon:'none'});
    }catch(error){if(!this.unloaded&&revision===this.clockoutRevision)this.setData({clockoutBusy:false,clockoutError:error.message||'保存结果未能确认，请重新读取。'});}
  }
};
module.exports={data,methods,summary};
