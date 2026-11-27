const api=require('./api');

const data={embroideryMode:false,embroideryTasks:[],selfEmbroideryParts:['前幅','后幅'],selfEmbroideryPart:'',selfStartError:''};
const methods={
  resetEmbroiderySelection(){
    this.embroideryStartReceipt=null;
    this.setData({selfEmbroideryPart:'',selfStartError:''});
  },
  chooseSelfEmbroideryPart(event){
    const part=event.currentTarget.dataset.part;
    if(this.data.busy||!this.data.selfEmbroideryParts.includes(part))return;
    this.setData({selfEmbroideryPart:part,selfStartError:''});
  },
  embroideryStartKey(input){
    const scope=[input.orderId,input.processId,input.embroideryPart].join(':');
    if(this.embroideryStartReceipt?.scope!==scope){
      this.embroideryStartReceipt={scope,key:'machine-start-'+Date.now()+'-'+Math.random().toString(36).slice(2)};
    }
    return this.embroideryStartReceipt.key;
  },
  selectEmbroideryTask(event){
    const id=String(event.currentTarget.dataset.id);
    if(!this.data.embroideryMode||this.data.busy||this.data.workerPanel||this.data.activeTask?.id===id||!this.data.embroideryTasks.some(row=>row.id===id))return;
    this.selectedEmbroideryTaskId=id;
    return this.refresh({quiet:true});
  },
  async loadMachineQuantity(task){
    this.embroideryQuantityTouched=false;
    try{
      const result=await api.loadEmbroideryFinishDefaults(task.id);
      if(this.unloaded||this.data.current?.id!==task.id||this.data.current.timingRevision!==task.timingRevision||this.data.quantityDraftId!==task.id)return;
      this.setData({
        'current.reportPlanText':Number.isSafeInteger(result.targetQuantity)?String(result.targetQuantity):task.reportPlanText,
        'current.reportRemainingText':Number.isSafeInteger(result.remainingQuantity)?String(result.remainingQuantity):task.reportRemainingText,
        ...(!this.embroideryQuantityTouched&&Number.isSafeInteger(result.defaultQuantity)?{good:String(result.defaultQuantity)}:{})
      });
    }catch{}
  }
};

module.exports={data,methods};
