const {morph}=require('./liquid-geometry');
const data={selfDefectItems:[],selfDefectQuantity:'0',selfDefectCodes:[],selfDefectEditor:null,selfDefectEditorOpen:false,selfDefectClosing:false,selfDefectDraft:'',selfDefectError:''};
const integer=value=>/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value));
const methods={
  disposeSelfDefects(){clearTimeout(this.defectEnterTimer);clearTimeout(this.defectCloseTimer);this.defectRevision=(this.defectRevision||0)+1;},
  resetSelfDefects(){this.disposeSelfDefects();this.setData({...data,selfDefectOptions:this.data.selfDefectOptions.map(row=>({...row,selected:false,quantity:0}))});},
  selfDefectOptions(reasons=this.data.selfDefectOptions,items=this.data.selfDefectItems){return reasons.map(row=>{const quantity=items.find(item=>item.code===row.code)?.quantity||0;return {...row,quantity,selected:quantity>0};});},
  openSelfDefect(event){
    const task=this.data.current,code=event.currentTarget.dataset.code,reason=this.data.selfDefectOptions.find(row=>row.code===code);
    if(this.unloaded||this.data.busy||this.data.loading||this.data.workerPanel?.kind!=='quantity'||!this.data.panelOpen||this.data.selfDefectEditor||!task?.canConfirmQuantity||!(task.isSelfService||this.data.embroideryMode)||!task.isQualityInspection||!reason)return;
    wx.hideKeyboard?.();this.disposeSelfDefects();const revision=this.defectRevision,id=task.id;
    const show=origin=>{if(this.unloaded||revision!==this.defectRevision||this.data.current?.id!==id||this.data.workerPanel?.kind!=='quantity')return;
      const info=wx.getWindowInfo?.()||{},width=info.windowWidth||390,height=info.windowHeight||740,panelHeight=Math.min(260,height-32),rect={left:24,top:(height-panelHeight)/2,width:width-48,height:panelHeight};
      this.defectSource=origin||{left:width/2-24,top:height/2,width:48,height:44};
      this.setData({selfDefectEditor:{code,name:reason.name,assignmentId:id,...morph(this.defectSource,rect,12)},selfDefectEditorOpen:false,selfDefectClosing:false,selfDefectDraft:reason.quantity?String(reason.quantity):'',selfDefectError:''},()=>{this.defectEnterTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.defectRevision)this.setData({selfDefectEditorOpen:true});},16);});
    };
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();if(query)query.select('#self-defect-'+code).boundingClientRect().exec(rects=>show(rects?.[0]));else show(null);
  },
  closeSelfDefect(){
    if(!this.data.selfDefectEditor||this.data.selfDefectClosing)return;
    wx.hideKeyboard?.();this.disposeSelfDefects();const revision=this.defectRevision;this.setData({selfDefectEditorOpen:false,selfDefectClosing:true});
    this.defectCloseTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.defectRevision)this.setData({selfDefectEditor:null,selfDefectClosing:false,selfDefectError:''});},this.data.reduceMotion?100:260);
  },
  onSelfDefectInput(event){if(this.data.selfDefectEditor&&!this.data.selfDefectClosing)this.setData({selfDefectDraft:event.detail.value,selfDefectError:''});},
  onSelfDefectKeyboard(event){
    const editor=this.data.selfDefectEditor;if(!editor||!this.data.selfDefectEditorOpen||this.data.selfDefectClosing)return;
    const info=wx.getWindowInfo?.()||{},width=info.windowWidth||390,height=info.windowHeight||740,keyboard=Math.max(0,Number(event.detail.height)||0),panelHeight=Math.min(260,Math.max(180,height-keyboard-24)),rect={left:24,top:Math.max(8,(height-keyboard-panelHeight)/2),width:width-48,height:panelHeight};
    this.setData({selfDefectEditor:{...editor,...morph(this.defectSource,rect,12)}});
  },
  saveSelfDefect(){
    const editor=this.data.selfDefectEditor,task=this.data.current;if(!editor||!this.data.selfDefectEditorOpen||this.data.selfDefectClosing||this.data.busy||!task?.canConfirmQuantity||!(task.isSelfService||this.data.embroideryMode)||!task.isQualityInspection||task.id!==editor.assignmentId)return;
    if(!this.data.selfDefectOptions.some(row=>row.code===editor.code))return this.setData({selfDefectError:'不良品项已变化，请重新读取任务。'});
    if(!integer(this.data.selfDefectDraft))return this.setData({selfDefectError:'请填写有效的不良数量，填 0 可移除。'});
    if(!integer(this.data.good))return this.setData({selfDefectError:'请先填写有效的本次数量。'});
    const quantity=Number(this.data.selfDefectDraft),items=this.data.selfDefectItems.map(row=>({...row})),existing=items.find(row=>row.code===editor.code),previous=existing?.quantity||0;
    if(existing)existing.quantity=quantity;else if(quantity)items.push({code:editor.code,quantity});
    const selected=items.filter(row=>row.quantity>0),total=selected.reduce((sum,row)=>sum+row.quantity,0),good=Number(this.data.good)-(quantity-previous);
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(good)||good<0)return this.setData({selfDefectError:'不良数超过可扣减数量，请调整本次数量。'});
    this.setData({selfDefectItems:selected,selfDefectQuantity:String(total),selfDefectCodes:selected.map(row=>row.code),selfDefectOptions:this.selfDefectOptions(this.data.selfDefectOptions,selected),good:String(good),quantityError:''});this.closeSelfDefect();
  }
};
module.exports={data,methods};
