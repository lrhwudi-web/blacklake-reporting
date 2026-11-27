// One mounted workspace owns the two frequently used views and the shared navigation.
const data={workspaceTab:0,tasksMounted:false,reportsMounted:false,workspaceReportModal:false,workspaceInstant:false,workspaceTaskModal:false,workspaceTaskSheet:false,workspaceTaskBusy:false};
const methods={
  setupWorkspace(options={}){
    const allowed=getApp().globalData.entry?.appRole==='floor8_leader',index=allowed&&options.tab==='tasks'?1:0;
    this.setData({workspaceTab:index,navActiveIndex:index,tasksMounted:allowed});
  },
  switchWorkspaceTab(index,options={}){
    if(![0,1,3].includes(index)||this.data.clockoutPanel||this.data.listPanel||this.data.detailMounted||this.data.operationPanel||this.data.imageViewer||this.data.workspaceTaskModal||this.data.workspaceTaskBusy||this.data.workspaceReportModal)return false;
    if(index===1&&!this.data.canDispatch)return false;
    const changedReportPage=(this.data.workspaceTab===3)!==(index===3);
    this.setData({workspaceTab:index,reportsMounted:this.data.reportsMounted||index===3,workspaceInstant:options.instant===true});
    if(changedReportPage&&typeof wx!=='undefined')wx.setNavigationBarTitle?.({title:index===3?'报表':'工单'});
    return true;
  },
  onTaskWorkspaceState(event){
    const modal=event.detail.modal===true,sheet=event.detail.sheet===true,busy=event.detail.busy===true;
    if(modal!==this.data.workspaceTaskModal||sheet!==this.data.workspaceTaskSheet||busy!==this.data.workspaceTaskBusy)this.setData({workspaceTaskModal:modal,workspaceTaskSheet:sheet,workspaceTaskBusy:busy});
  },
  onReportWorkspaceState(event){const modal=event.detail.modal===true||event.detail.busy===true;if(modal!==this.data.workspaceReportModal)this.setData({workspaceReportModal:modal});}
};
module.exports={data,methods};
