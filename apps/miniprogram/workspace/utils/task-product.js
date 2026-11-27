const detail=require('./detail-model');
const text=value=>typeof value==='string'||typeof value==='number'?String(value).trim():'';
function productInfo(task){
  const order=task.orderInfo||{};
  if(order.id!=null&&String(order.id)!==String(task.orderId))throw new Error('产品资料归属未能确认，请刷新后重试。');
  const raw=text(order.product||task.product),parts=raw.split('|').map(value=>value.trim()).filter(Boolean);
  const code=text(order.productCode||task.productCode)||(parts.length>1?parts[0]:'');
  const name=text(order.productName||task.productName)||(parts.length>1?parts.slice(1).join(' | '):raw);
  const images=[];
  for(const url of [...(Array.isArray(order.imageUrls)?order.imageUrls:[]),order.imageUrl,task.imageUrl]){
    if(typeof url!=='string'||!url||images.some(row=>row.url===url))continue;
    const allowed=/^\/assets\/[\w.-]+\.(png|jpe?g|webp)$/i.test(url)||/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s]*)?$/i.test(url);
    if(allowed)images.push({url,index:images.length,failed:false});
  }
  const statuses={NOT_STARTED:'未开始',IN_PROGRESS:'执行中',FINISHED:'已结束'};
  const fields=[
    ['产品编号',code],['产品规格',text(order.productSpecification||task.productSpecification)],['产品信息',raw],
    ['工单编号',text(order.code||task.orderCode)],['工单状态',text(order.statusText)||statuses[order.status]],
    ['计划数量',detail.amount(order.planQuantity)],['实际数量',detail.amount(order.completedQuantity)],['计量单位',text(order.unit)],
    ['计划开始',text(order.startAt)],['计划结束',text(order.endAt)],['上游更新时间',text(order.upstreamUpdatedAt)],
    ['派工人员',text(task.workerName)],['派工工序',text(task.processName)],['派工状态',text(task.statusText)],['派工时间',text(task.assignedText)]
  ].map(([label,value])=>({label,value:value||'—'}));
  return {assignmentId:String(task.id),title:name||'产品资料',code:code||'—',orderCode:text(order.code||task.orderCode)||'—',images,fields};
}
module.exports={productInfo,
  data:{productPanel:null,productPanelOpen:false},
  methods:{
    clearTaskProductMotion(){clearTimeout(this.productOpenFrame);clearTimeout(this.productCloseTimer);this.productPanelRevision=(this.productPanelRevision||0)+1;},
    resetTaskProduct(){this.clearTaskProductMotion();this.setData({productPanel:null,productPanelOpen:false});},
    openTaskProduct(event){
      if(this.unloaded||getApp().globalData.entry?.appRole!=='floor8_leader'||this.data.actionBusy||this.data.reportPanel||this.data.assignmentPanel||this.data.imageViewer)return;
      const task=(this.taskRecordRows?.()||this.data.executionAssignments).find(row=>String(row.id)===String(event.currentTarget.dataset.id));if(!task)return;
      try{
        const record=event.currentTarget.dataset.record===true||event.currentTarget.dataset.record==='true';
        const taskRecord=record?{workerName:task.workerName,processName:task.processName,status:task.status,statusText:task.statusText,assignedShort:task.assignedShort,elapsedShortText:task.elapsedShortText,timerPaused:task.timerPaused,pauseReason:task.pauseReason,resumeBlockedReason:task.resumeBlockedReason,canResume:task.canResume,reportCount:task.reportCount}:null;
        const panel={...productInfo(task),taskRecord,fetchedText:this.data.updatedLabel?detail.time(this.data.updatedLabel):''};this.resetAssignmentMenu();this.resetReportMenu();this.resetGlassSegments();this.clearTaskProductMotion();const revision=this.productPanelRevision;
        this.setData({productPanel:panel,productPanelOpen:false},()=>{this.productOpenFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.productPanelRevision)this.setData({productPanelOpen:true});},16);});
      }catch(error){wx.showToast({title:error.message,icon:'none'});}
    },
    closeTaskProduct(afterClose){
      if(this.data.imageViewer){this.closeProductPreview();return;}
      if(!this.data.productPanel)return;this.clearTaskProductMotion();const revision=this.productPanelRevision;this.setData({productPanelOpen:false});
      this.productCloseTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.productPanelRevision){this.setData({productPanel:null});if(typeof afterClose==='function')return afterClose();}},this.data.reduceMotion?100:200);
    },
    showTaskProductReports(){
      const panel=this.data.productPanel;
      if(!this.data.productPanelOpen||!panel?.taskRecord||this.data.actionBusy||getApp().globalData.entry?.appRole!=='floor8_leader')return;
      this.closeTaskProduct(()=>this.showTaskReports({currentTarget:{dataset:{id:panel.assignmentId}}}));
    },
    resumeTaskProduct(){
      const panel=this.data.productPanel,task=(this.taskRecordRows?.()||this.data.executionAssignments).find(row=>String(row.id)===panel?.assignmentId);
      if(!this.data.productPanelOpen||!panel?.taskRecord||!task?.canResume||!this.data.canManageExecution||this.data.actionBusy||getApp().globalData.entry?.appRole!=='floor8_leader')return;
      this.closeTaskProduct(()=>this.resumeAssignment({currentTarget:{dataset:{id:panel.assignmentId}}}));
    },
    taskProductImageError(event){
      const panel=this.data.productPanel,url=event.currentTarget.dataset.url;if(!panel||!panel.images.some(row=>row.url===url))return;
      this.setData({productPanel:{...panel,images:panel.images.map(row=>row.url===url?{...row,failed:true}:row)}});
    },
    previewTaskProductImage(event){
      if(!this.data.productPanelOpen)return;const picture=this.data.productPanel?.images.find(row=>row.index===Number(event.currentTarget.dataset.index));
      if(picture&&!picture.failed)this.openProductPreview(picture.url,'#task-product-image-'+picture.index);
    },
    stopTaskProductBubble(){}
  }
};
