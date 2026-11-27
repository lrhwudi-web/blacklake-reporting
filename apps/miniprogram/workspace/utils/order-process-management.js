const api=require('./api');
const pending=['QUEUED','RUNNING','RETRY','UNKNOWN'];
const jobText={
  QUEUED:'已保存，等待同步黑湖。',RUNNING:'正在同步工序，可返回处理其他工序。',RETRY:'正在排队重试。',
  UNKNOWN:'黑湖结果核对中，可继续处理其他工序。',FAILED:'本次修改未完成，请重新读取工序。',
  SUCCEEDED:'黑湖工序已更新，改动已记入 SKU 履历。',CANCELLED:'本次修改已取消。'
};
const data={routePanel:false,routeBusy:false,routeLoading:false,routeError:'',routeNote:'',routeJob:null,routeLocked:false,
  routeSku:'',routePlan:null,routeRows:[],routeBlocked:'',routeOrderChanged:false,routeDragging:false,routeDraft:null,
  routeCatalogQuery:'',routeCatalogRows:[],routeCatalogMore:false,routeCatalogLoading:false};
const methods={
  openProcessManagement(){
    if(!this.data.canDispatch||this.data.routePanel||this.data.sourceMode==='ui-fixture')return;
    this.routeVersion=null;
    this.setData({routePanel:true,routeDraft:null,routeJob:null,routeRows:[],routeSku:'',routeBlocked:'',routeLocked:false,routeNote:'',routeError:'',routeOrderChanged:false});
    this.loadProcessManagement();
  },
  closeProcessManagement(){
    if(this.data.routeBusy)return;
    if(this.data.routeDraft){
      this.routeCatalogRevision=(this.routeCatalogRevision||0)+1;
      clearTimeout(this.routeSearchTimer);
      wx.hideKeyboard?.();
      this.setData({routeDraft:null,routeError:''});
      return;
    }
    this.resetProcessManagement();
  },
  resetProcessManagement(){
    this.routeRevision=(this.routeRevision||0)+1;
    this.routeCatalogRevision=(this.routeCatalogRevision||0)+1;
    clearTimeout(this.routeSearchTimer);clearTimeout(this.routeJobTimer);
    this.routeDrag=null;
    this.setData({routePanel:false,routeBusy:false,routeLoading:false,routeDraft:null,routeDragging:false});
  },
  async loadProcessManagement(){
    if(!this.data.routePanel||this.data.routeLoading)return;
    const revision=this.routeRevision=(this.routeRevision||0)+1;
    this.setData({routeLoading:true,routeError:''});
    try{
      const value=await api.loadProcessManagement(this.orderId);
      if(this.unloaded||revision!==this.routeRevision)return;
      if(String(value.orderId)!==String(this.orderId)||!Array.isArray(value.rows))throw Error('工序资料归属未能确认，请重新打开。');
      this.routeVersion=value.version;
      this.routeOriginal=value.rows.map(row=>row.id);
      this.setData({routeRows:value.rows,routeSku:value.sku,routePlan:value.planQuantity,routeBlocked:value.blockedReason,routeOrderChanged:false});
      if(value.job){this.presentProcessEditJob(value.job);this.scheduleProcessEditCheck();}
      else this.setData({routeJob:null,routeLocked:false});
    }catch(error){if(!this.unloaded&&revision===this.routeRevision)this.setData({routeError:error.message||'工序读取失败。'});}
    finally{if(!this.unloaded&&revision===this.routeRevision)this.setData({routeLoading:false});}
  },
  openProcessEdit(event){
    if(!this.routeVersion||this.data.routeLocked||this.data.routeBusy||this.data.routeLoading||this.data.routeOrderChanged)return;
    const id=event.currentTarget.dataset.id,row=this.data.routeRows.find(item=>item.id===id);
    if(id&&(!row||row.blockedReason))return;
    this.setData({routeDraft:{id:row?.id??null,name:row?.name||'',planQuantity:row?String(row.planQuantity):'',definition:null},
      routeCatalogQuery:'',routeCatalogRows:[],routeCatalogMore:false,routeError:''});
    this.loadProcessEditCatalog('');
  },
  onProcessCatalogSearch(event){
    const query=event.detail.value;
    this.routeCatalogRevision=(this.routeCatalogRevision||0)+1;
    this.setData({routeCatalogQuery:query,routeCatalogRows:[],routeCatalogLoading:true});
    clearTimeout(this.routeSearchTimer);
    this.routeSearchTimer=setTimeout(()=>this.loadProcessEditCatalog(query),250);
  },
  async loadProcessEditCatalog(query){
    if(!this.data.routeDraft)return;
    const revision=this.routeCatalogRevision=(this.routeCatalogRevision||0)+1;
    this.setData({routeCatalogLoading:true,routeError:''});
    try{
      const result=await api.searchProcessCatalog(query.trim());
      if(this.data.routeDraft&&revision===this.routeCatalogRevision&&!this.unloaded)
        this.setData({routeCatalogRows:result.rows,routeCatalogMore:result.hasMore});
    }catch(error){if(revision===this.routeCatalogRevision&&!this.unloaded)this.setData({routeError:error.message||'黑湖工序目录读取失败。'});}
    finally{if(revision===this.routeCatalogRevision&&!this.unloaded)this.setData({routeCatalogLoading:false});}
  },
  selectProcessDefinition(event){
    const row=this.data.routeCatalogRows.find(item=>item.id===event.currentTarget.dataset.id);
    if(row&&this.data.routeDraft&&!this.data.routeBusy)this.setData({'routeDraft.definition':row,routeError:''});
  },
  onProcessEditQuantity(event){if(!this.data.routeBusy&&this.data.routeDraft?.id)this.setData({'routeDraft.planQuantity':event.detail.value,routeError:''});},
  saveProcessEdit(){
    const draft=this.data.routeDraft;
    if(!draft)return;
    if(!draft.id){
      if(!draft.definition)return this.setData({routeError:'请从黑湖目录选择工序。'});
      return this.submitProcessEdit({action:'add',definitionId:draft.definition.id});
    }
    if(!/^\d+$/.test(draft.planQuantity)||!Number.isSafeInteger(Number(draft.planQuantity))||Number(draft.planQuantity)<1)
      return this.setData({routeError:'请输入有效的计划数量。'});
    const current=this.data.routeRows.find(row=>row.id===draft.id);
    const definitionId=draft.definition?.id===current?.definitionId?null:draft.definition?.id;
    return this.submitProcessEdit({action:'edit',id:draft.id,planQuantity:Number(draft.planQuantity),...(definitionId?{definitionId}:{})});
  },
  confirmDeleteProcess(event){
    const row=this.data.routeRows.find(item=>item.id===event.currentTarget.dataset.id);
    if(!row||row.blockedReason||this.data.routeLocked||this.data.routeBusy||this.data.routeOrderChanged)return;
    wx.showModal({title:'删除工序',content:'将从这张工单删除「'+row.name+'」。',confirmText:'删除',success:result=>{
      if(result.confirm&&this.data.routePanel&&!this.unloaded)this.submitProcessEdit({action:'delete',id:row.id});
    }});
  },
  beginProcessReorder(event){
    if(!this.routeVersion||this.data.routeLocked||this.data.routeBusy||this.data.routeRows.length<2)return;
    const id=event.currentTarget.dataset.id,touch=event.touches?.[0];
    if(!touch)return;
    const drag={id,y:touch.clientY,original:this.data.routeRows.slice(),bounds:null};
    this.routeDrag=drag;this.setData({routeDragging:true});
    this.createSelectorQuery().selectAll('.route-edit-row').boundingClientRect(rects=>{
      if(this.routeDrag===drag)drag.bounds=rects;
    }).exec();
  },
  moveProcessReorder(event){
    const drag=this.routeDrag,touch=event.touches?.[0];
    if(!touch||!drag?.bounds)return;
    const original=drag.original.findIndex(row=>row.id===drag.id);
    const destination=drag.bounds.reduce((n,box,index)=>n+(index!==original&&touch.clientY>=box.top+box.height/2?1:0),0);
    if(!drag.moved&&Math.abs(touch.clientY-drag.y)<8)return;
    drag.moved=true;
    const rows=drag.original.slice();rows.splice(destination,0,rows.splice(original,1)[0]);
    if(rows.every((row,index)=>row.id===this.data.routeRows[index].id))return;
    this.setData({routeRows:rows,routeOrderChanged:rows.some((row,index)=>row.id!==this.routeOriginal[index])});
  },
  endProcessReorder(){this.routeDrag=null;this.setData({routeDragging:false});},
  cancelProcessReorder(){
    if(this.routeDrag){
      const rows=this.routeDrag.original;
      this.setData({routeRows:rows,routeOrderChanged:rows.some((row,index)=>row.id!==this.routeOriginal[index])});
    }
    this.endProcessReorder();
  },
  saveProcessReorder(){if(this.data.routeOrderChanged)return this.submitProcessEdit({action:'reorder',ids:this.data.routeRows.map(item=>item.id)});},
  async submitProcessEdit(change){
    if(!this.data.routePanel||this.data.routeLocked||this.data.routeBusy||!this.routeVersion)return;
    const input={...change,version:this.routeVersion},signature=JSON.stringify(input);
    const key=this.routeSubmit?.signature===signature?this.routeSubmit.key:'route-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    this.routeSubmit={signature,key};
    this.setData({routeBusy:true,routeError:''});
    try{
      const job=await api.saveProcessManagement(this.orderId,input,key);
      if(this.unloaded||!this.data.routePanel)return;
      wx.hideKeyboard?.();
      this.setData({routeDraft:null});
      this.presentProcessEditJob(job);
      this.scheduleProcessEditCheck();
    }catch(error){if(!this.unloaded&&this.data.routePanel)this.setData({routeError:error.message||'工序提交未能确认，请重试。'});}
    finally{if(!this.unloaded)this.setData({routeBusy:false});}
  },
  presentProcessEditJob(job){this.setData({routeJob:job,routeLocked:pending.includes(job.state),routeNote:job.message||jobText[job.state]||''});},
  scheduleProcessEditCheck(remaining=16){
    clearTimeout(this.routeJobTimer);
    const state=this.data.routeJob?.state;
    if(remaining>0&&pending.includes(state)&&state!=='UNKNOWN')
      this.routeJobTimer=setTimeout(()=>this.checkProcessEditJob(remaining-1),1600);
  },
  async checkProcessEditJob(remaining=16){
    const job=this.data.routeJob,revision=this.routeRevision;
    if(!this.data.routePanel||!job||this.routeJobReading)return;
    this.routeJobReading=true;
    try{
      const next=await api.loadProcessManagementJob(this.orderId,job.id);
      if(this.unloaded||revision!==this.routeRevision||!this.data.routePanel)return;
      this.presentProcessEditJob(next);
      if(next.state==='SUCCEEDED'){
        this.routeVersion=null;
        await this.loadProcessManagement();
        this.loadProcesses();
      }else if(pending.includes(next.state))this.scheduleProcessEditCheck(typeof remaining==='number'?remaining:16);
      else {this.routeVersion=null;this.setData({routeOrderChanged:false});}
    }catch(error){if(!this.unloaded&&revision===this.routeRevision)this.setData({routeError:error.message||'暂时无法读取修改结果。'});}
    finally{this.routeJobReading=false;}
  }
};
module.exports={data,methods};
