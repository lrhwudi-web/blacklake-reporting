const data={workerOrderScope:'all',workerOrderScopeLabel:'所有工单',workerOrderSort:'default',workerTaskOrderIds:[],workerOrderToolTitle:'',workerOrderToolOptions:[]};
const tools={
  scope:{title:'工单范围',field:'workerOrderScope',options:[{key:'all',label:'所有工单'},{key:'mine',label:'我的任务工单'}]},
  sort:{title:'工单排序',field:'workerOrderSort',options:[{key:'default',label:'创建时间从新到旧'},{key:'created-asc',label:'创建时间从旧到新'},{key:'start-desc',label:'计划开始从新到旧'},{key:'start-asc',label:'计划开始从旧到新'},{key:'code',label:'工单编号'}]},
  filter:{title:'筛选工单',field:'workerOrderStatus'}
};
const methods={
  openWorkerOrderTools(event){
    const kind=event.currentTarget.dataset.tool,tool=tools[kind];
    if(!tool||this.unloaded||getApp().globalData.entry?.appRole!=='employee'||this.data.workerTab!=='orders'||this.data.busy||this.data.workerPanel||this.data.imageViewer||this.data.detailMounted||this.openingDetail)return;
    wx.hideKeyboard?.();
    this.setData({workerOrderTool:kind,workerOrderToolTitle:tool.title,workerOrderToolOptions:(tool.options||this.data.workerOrderStatuses).map(row=>({...row,selected:row.key===this.data[tool.field]}))});
    this.showWorkerPanel('orderTools','#worker-order-'+kind);
  },
  chooseWorkerOrderTool(event){
    if(this.data.workerPanel?.kind!=='orderTools'||this.data.busy||!this.data.panelOpen)return;
    const key=event.currentTarget.dataset.key,tool=tools[this.data.workerOrderTool];
    const option=this.data.workerOrderToolOptions.find(row=>row.key===key);if(!tool||!option)return;
    const patch={[tool.field]:key,...(this.data.workerOrderTool==='scope'?{workerOrderScopeLabel:option.label}:{})};
    this.setData({workerOrderToolOptions:this.data.workerOrderToolOptions.map(row=>({...row,selected:row.key===key}))});
    this.closeWorkerPanel(()=>{this.setData(patch);this.filterWorkerOrders();if(getApp().globalData.dataMode==='live')this.loadWorkerOrders();});
  },
  refreshWorkerOrderList(){if(this.data.workerPanel?.kind==='orderTools'&&this.data.workerOrderTool==='scope'&&!this.data.busy&&!this.data.workerOrdersLoading)this.closeWorkerPanel(()=>this.loadWorkerOrders());}
};
module.exports={data,methods};
