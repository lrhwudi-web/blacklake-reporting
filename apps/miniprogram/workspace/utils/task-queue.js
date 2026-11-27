const api=require('./api');
const same=(a,b)=>String(a)===String(b);
const eventFor=(id,mode)=>({currentTarget:{dataset:{id,mode}}});
const rowHeight=112;
module.exports={
  data:{queueStep:'queue',queueRows:[],queueDraftIds:[],queueOriginalIds:[],queuePaused:[],queueInsertChoices:[],queueCurrent:null,queueOrders:[],queueProcesses:[],queueQuery:'',queueTarget:null,queueImpact:[],queueError:'',queueDirty:false,queueLoading:false,queueCatalogLoading:false,queueOrdersMore:false,queueProcessLoading:false,inlineSorting:false,inlineListHeight:0},
  methods:{
    clearQueueGesture(){clearTimeout(this.queueHoldTimer);this.queueHold=null;this.queueDrag=null;},
    openTaskQueue(event){
      if(this.unloaded||this.properties?.active===false||this.data.actionBusy||this.data.productPanel||this.data.reportPanel||this.data.assignmentPanel||getApp().globalData.entry?.appRole!=='floor8_leader'||!this.data.canManageExecution)return;
      const task=this.data.executionAssignments.find(row=>same(row.id,event.currentTarget.dataset.id));if(!task?.canManageQueue)return;
      const tasks=this.data.executionAssignments.filter(row=>same(row.workerId,task.workerId));
      const ready=tasks.filter(row=>['IN_PROGRESS','READY','PAUSED'].includes(row.status)).sort((a,b)=>(a.queuePosition??1e9)-(b.queuePosition??1e9));
      this.queueOperation=null;this.queueBaseRows=ready;this.queueOrderSource=(this.data.assignmentOptions.orders||[]).filter(row=>['NOT_STARTED','IN_PROGRESS'].includes(row.status));
      this.resetAssignmentMenu();this.resetReportMenu();this.clearAssignmentPanelMotion();this.resetGlassSegments();this.clearQueueGesture();const revision=this.assignmentPanelRevision;
      const ids=ready.map(row=>String(row.id));
      this.setData({assignmentPanel:{action:'queue',id:task.id,workerId:String(task.workerId),workerName:task.workerName,unitId:task.unitId,version:this.data.executionVersion,blockedReason:task.queueBlockedReason||''},assignmentPanelOpen:false,
        queueStep:event.currentTarget.dataset.mode==='insert'?'orders':'queue',queueOriginalIds:ids,queueDraftIds:[...ids],queuePaused:[],queueInsertChoices:tasks.filter(row=>['READY','PAUSED'].includes(row.status)),queueCurrent:tasks.find(row=>row.status==='IN_PROGRESS')||null,queueQuery:'',queueTarget:null,queueImpact:[],queueError:'',queueDirty:false,queueLoading:false});
      this.updateQueueRows();if(this.data.queueStep==='orders')this.filterQueueOrders();
      this.assignmentPanelFrame=setTimeout(()=>{if(!this.unloaded&&revision===this.assignmentPanelRevision)this.setData({assignmentPanelOpen:true});},16);
    },
    updateQueueRows(){
      const ids=this.data.queueDraftIds,drag=this.queueDrag;
      this.setData({queueRows:(this.queueBaseRows||[]).map(row=>{const slot=ids.indexOf(String(row.id)),held=drag&&same(drag.id,row.id);return {...row,queueNumber:slot+1,isEmployeeCurrent:slot===0,queueY:held?drag.index*rowHeight+drag.delta:slot*rowHeight,queueHeld:!!held};}),queueDirty:ids.join('|')!==this.data.queueOriginalIds.join('|')});
    },
    closeQueuePanel(){
      if(this.data.actionBusy||this.data.queueLoading)return;this.clearQueueGesture();this.clearAssignmentPanelMotion();const revision=this.assignmentPanelRevision;
      this.setData({assignmentPanelOpen:false});this.assignmentPanelTimer=setTimeout(()=>{if(!this.unloaded&&revision===this.assignmentPanelRevision)this.setData({assignmentPanel:null,queueTarget:null,queueDirty:false,queueRows:[]});},this.data.reduceMotion?100:180);
    },
    backQueueStep(){
      if(this.data.actionBusy||this.data.queueLoading)return;
      this.queueProcessRevision=(this.queueProcessRevision||0)+1;
      this.setData({queueStep:this.data.queueStep==='process'?'orders':'queue',queueTarget:null,queueImpact:[],queueError:'',queueProcessLoading:false});
    },
    startQueueInsert(){if(!this.data.actionBusy)this.setData({queueStep:'orders',queueQuery:'',queueError:'',queueTarget:null});this.filterQueueOrders();},
    onQueueQuery(event){
      this.queueProcessRevision=(this.queueProcessRevision||0)+1;
      this.setData({queueQuery:event.detail.value,queueError:'',queueProcessLoading:false});this.filterQueueOrders(true);
    },
    filterQueueOrders(debounce=false){
      if(typeof api.searchQueueOrders==='function'){
        clearTimeout(this.queueCatalogTimer);this.queueCatalogRevision=(this.queueCatalogRevision||0)+1;this.queueCatalogPage=0;
        this.setData({queueOrders:[],queueOrdersMore:false,queueCatalogLoading:true,queueProcessLoading:false,queueError:''});
        if(debounce)this.queueCatalogTimer=setTimeout(()=>this.fetchQueueOrders(),250);else this.fetchQueueOrders();
        return;
      }
      const terms=this.data.queueQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
      this.setData({queueOrders:(this.queueOrderSource||[]).filter(order=>terms.every(term=>(String(order.code||'')+' '+String(order.product||'')).toLowerCase().includes(term)))});
    },
    async fetchQueueOrders(more=false){
      if(this.unloaded||this.data.assignmentPanel?.action!=='queue'||this.data.queueStep!=='orders')return;
      const revision=this.queueCatalogRevision,panelRevision=this.assignmentPanelRevision,page=more?this.queueCatalogPage+1:1;
      const current=()=>!this.unloaded&&revision===this.queueCatalogRevision&&panelRevision===this.assignmentPanelRevision&&this.data.queueStep==='orders';
      this.setData({queueCatalogLoading:true,queueError:''});
      try{
        const result=await api.searchQueueOrders(page,this.data.queueQuery.trim());if(!current())return;
        this.queueCatalogPage=page;this.setData({queueOrders:more?[...this.data.queueOrders,...result.orders]:result.orders,queueOrdersMore:result.hasMore===true});
      }catch(error){if(current())this.setData({queueError:error.message||'工单目录读取失败，请重试。'});}
      finally{if(current())this.setData({queueCatalogLoading:false});}
    },
    loadMoreQueueOrders(){if(!this.data.queueCatalogLoading&&this.data.queueOrdersMore)void this.fetchQueueOrders(true);},
    reloadQueueOrders(){this.filterQueueOrders();},
    retryQueueStep(){
      const target=this.data.queueTarget;
      if(this.data.queueStep==='orders')return this.reloadQueueOrders();
      if(target?.kind==='new'){
        this.queueOperation=null;this.setData({queueStep:'process',queueTarget:null});
        return this.chooseQueueProcess(eventFor(target.processId));
      }
      return this.reloadTaskQueue();
    },
    chooseQueueOrder(event){
      if(this.data.actionBusy||this.data.queueLoading)return;const order=this.data.queueOrders.find(row=>same(row.id,event.currentTarget.dataset.id));if(!order)return;
      if(typeof api.searchQueueOrders==='function')return this.loadQueueOrderProcesses(order);
      this.showQueueProcesses(order,order.processes);
    },
    async loadQueueOrderProcesses(order){
      const revision=this.queueProcessRevision=(this.queueProcessRevision||0)+1,panelRevision=this.assignmentPanelRevision;
      const current=()=>!this.unloaded&&revision===this.queueProcessRevision&&panelRevision===this.assignmentPanelRevision&&this.data.queueStep==='orders';
      this.setData({queueProcessLoading:true,queueError:''});
      try{
        for(let attempt=0;current();attempt++){
          try{const result=await api.loadOrderProcesses(order.id);if(current())this.showQueueProcesses(order,result.processes);break;}
          catch(error){
            if(error.code!=='BLACKLAKE_DATA_SYNCING'||attempt>=4)throw error;
            if(current())await new Promise(resolve=>setTimeout(resolve,2500));
          }
        }
      }catch(error){if(current())this.setData({queueError:error.code==='BLACKLAKE_DATA_SYNCING'?'工序仍在后台加载，稍后点这张工单重试。':error.message||'工序读取失败，请重试。'});}
      finally{if(current())this.setData({queueProcessLoading:false});}
    },
    showQueueProcesses(order,source){
      this.queueSelectedOrder=order;const tasks=this.data.executionAssignments,panel=this.data.assignmentPanel;
      const processes=source.filter(row=>row.selectable===true&&row.closed===false&&!tasks.some(task=>same(task.workerId,panel.workerId)&&same(task.orderId,order.id)&&same(task.processId,row.id)&&['READY','IN_PROGRESS','PAUSED','AWAITING_QUANTITY'].includes(task.status)));
      this.setData({queueStep:'process',queueProcesses:processes,queueProcessLoading:false,queueError:''});
    },
    async chooseQueueProcess(event){
      const panel=this.data.assignmentPanel,order=this.queueSelectedOrder,process=this.data.queueProcesses.find(row=>same(row.id,event.currentTarget.dataset.id));
      if(!panel||panel.action!=='queue'||!order||!process||this.data.queueLoading||this.data.actionBusy)return;
      const revision=this.assignmentPanelRevision;this.setData({queueLoading:true,queueError:''});
      try{
        const input={orderId:order.id,processId:process.id,workerIds:[panel.workerId],priority:'URGENT'};
        const preview=await api.previewAssignment(input);if(this.unloaded||revision!==this.assignmentPanelRevision)return;
        if(preview.blocked?.length){const row=preview.blocked[0];throw Error([row.workerName,row.orderCode,row.processName,row.reason].filter(Boolean).join(' · '));}
        if(!Number.isSafeInteger(preview.version)||!Array.isArray(preview.affected))throw new Error('插单影响未能确认，请重新核对。');
        if(!(this.data.assignmentOptions.units||[]).some(row=>same(row.id,panel.unitId)))throw new Error('原工位已失效，请先编辑派工。');
        this.setData({assignmentPanel:{...panel,version:preview.version,dispatchVersion:preview.dispatchVersion??null},queueStep:'confirm',queueTarget:{kind:'new',orderId:order.id,orderCode:order.code,processId:process.id,processName:process.name},queueImpact:preview.affected});
      }catch(error){if(!this.unloaded&&revision===this.assignmentPanelRevision)this.setData({queueError:error.message||'未能核对插单。'});}
      finally{if(!this.unloaded&&revision===this.assignmentPanelRevision)this.setData({queueLoading:false});}
    },
    chooseQueuedInsert(event){
      if(this.data.actionBusy||this.data.queueLoading)return;const panel=this.data.assignmentPanel,task=this.data.executionAssignments.find(row=>same(row.id,event.currentTarget.dataset.id));
      if(!panel||!task?.canManageQueue||!same(task.workerId,panel.workerId)||!['READY','PAUSED'].includes(task.status))return;
      this.setData({queueStep:'confirm',queueTarget:{kind:'existing',id:task.id,orderCode:task.orderCode,processName:task.processName,status:task.status},queueImpact:this.data.queueCurrent?[this.data.queueCurrent]:[],queueError:''});
    },
    async applyTaskQueue(event){
      const panel=this.data.assignmentPanel,target=this.data.queueTarget,kind=event.currentTarget.dataset.kind;
      if(this.unloaded||!panel||panel.action!=='queue'||!this.data.assignmentPanelOpen||!this.data.canManageExecution||this.data.actionBusy||this.data.queueLoading||getApp().globalData.entry?.appRole!=='floor8_leader')return;
      let action,input;
      if(kind==='sort'){
        if(!this.data.queueDirty||panel.blockedReason||this.data.queueStep!=='queue')return;
        action='reorderQueue';input={workerId:panel.workerId,assignmentIds:[...this.data.queueDraftIds]};
      }else if(kind==='insert'&&this.data.queueStep==='confirm'&&target){
        action=target.kind==='new'?'dispatch':'insertAssignment';input=target.kind==='new'?{orderId:target.orderId,processId:target.processId,workerIds:[panel.workerId],priority:'URGENT',placements:[{workerId:panel.workerId,unitId:panel.unitId}]}:{assignmentId:target.id};
      }else return;
      this.clearQueueGesture();this.setData({actionBusy:true,queueError:''});
      const fingerprint=JSON.stringify({action,input,version:panel.version});
      if(this.queueOperation?.fingerprint!==fingerprint)this.queueOperation={fingerprint,id:'queue-'+action+'-'+Date.now()+'-'+panel.id};
      try{
        await api.executeExecutionAction(action,input,{expectedVersion:panel.version,dispatchVersion:action==='dispatch'?panel.dispatchVersion:null,operationId:this.queueOperation.id});
        if(this.unloaded)return;this.resetAssignmentUI();await this.loadExecution();if(!this.unloaded)wx.showToast({title:kind==='sort'?'当前工单与顺序已更新':'插单已置顶',icon:'none'});
      }catch(error){if(!this.unloaded)this.setData({queueError:error.message||'未能保存，请重新核对。'});}
      finally{if(!this.unloaded)this.setData({actionBusy:false});}
    },
    async reloadTaskQueue(){
      if(this.data.actionBusy||this.data.queueLoading)return;const id=this.data.assignmentPanel?.id;if(!id)return;
      this.resetAssignmentUI();await this.loadExecution();if(!this.unloaded)this.openTaskQueue(eventFor(id,'queue'));
    },
    moveQueueItem(event){
      if(this.data.actionBusy||this.data.queueLoading||this.data.assignmentPanel?.blockedReason)return;
      const ids=[...this.data.queueDraftIds],index=ids.indexOf(String(event.currentTarget.dataset.id)),to=index+Number(event.currentTarget.dataset.delta);
      if(index<0||to<0||to>=ids.length)return;ids.splice(to,0,ids.splice(index,1)[0]);this.setData({queueDraftIds:ids});this.updateQueueRows();
    },
    onQueueDragStart(event){
      if(this.data.actionBusy||this.data.queueLoading||this.data.queueStep!=='queue'||this.data.assignmentPanel?.blockedReason)return;
      const point=event.touches?.[0],id=String(event.currentTarget.dataset.id),index=this.data.queueDraftIds.indexOf(id);if(!point||index<0)return;
      this.clearQueueGesture();this.queueHold={identifier:point.identifier,id,index,y:point.clientY,ids:[...this.data.queueDraftIds]};
      // The record's long press already enters arrange mode; its explicit handle follows immediately.
      this.queueDrag={...this.queueHold,delta:0};wx.vibrateShort?.({type:'light'});this.updateQueueRows();
    },
    onQueueDragMove(event){
      const point=event.touches?.find(row=>row.identifier===(this.queueDrag||this.queueHold)?.identifier);if(!point)return;
      if(!this.queueDrag){if(Math.abs(point.clientY-this.queueHold.y)>10)this.clearQueueGesture();return;}
      const drag=this.queueDrag,count=this.data.queueDraftIds.length;drag.delta=Math.max(-drag.index*rowHeight,Math.min((count-1-drag.index)*rowHeight,point.clientY-drag.y));
      const to=Math.max(0,Math.min(count-1,Math.round(drag.index+drag.delta/rowHeight))),ids=this.data.queueDraftIds.filter(id=>!same(id,drag.id));ids.splice(to,0,drag.id);this.setData({queueDraftIds:ids});this.updateQueueRows();
    },
    onQueueDragEnd(){this.clearQueueGesture();this.updateQueueRows();},
    onQueueDragCancel(){const ids=(this.queueDrag||this.queueHold)?.ids;this.clearQueueGesture();if(ids)this.setData({queueDraftIds:ids});this.updateQueueRows();},
    decorateTaskCards(rows){
      const person=this.data.taskDrill?.mode==='person',available=person&&this.data.taskStatus==='all'&&!this.data.keyword.trim();
      return rows.map(row=>({...row,inlineHandle:person&&['IN_PROGRESS','READY','PAUSED'].includes(row.status),inlineDraggable:available&&row.canManageQueue===true&&!row.queueBlockedReason,inlinePreviewCurrent:row.isEmployeeCurrent===true}));
    },
    disposeInlineSort(){this.inlineSortRevision=(this.inlineSortRevision||0)+1;this.inlineSort=null;this.inlineHold=null;},
    onInlineSortStart(event){
      if(this.unloaded||this.data.actionBusy||this.data.executionLoading||!this.data.canManageExecution||this.data.assignmentPanel||this.data.productPanel||this.data.taskChooser||getApp().globalData.entry?.appRole!=='floor8_leader')return;
      const point=event.touches?.[0],row=this.data.displayTasks.find(item=>same(item.id,event.currentTarget.dataset.id));if(!point||!row?.inlineDraggable)return;
      this.disposeInlineSort();const revision=this.inlineSortRevision,rows=this.data.displayTasks.map(item=>({...item}));this.inlineHold={identifier:point.identifier,id:String(row.id),startY:point.clientY,y:point.clientY};
      let query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();if(!query){this.disposeInlineSort();return;}if(query.in&&this.properties)query=query.in(this);
      rows.forEach((_,index)=>query.select('#assignment-card-'+index).boundingClientRect());
      query.exec(rects=>{
        if(this.unloaded||revision!==this.inlineSortRevision||!this.inlineHold||this.data.actionBusy||this.data.assignmentPanel||this.data.productPanel||this.data.taskTab!=='assignments'||this.data.taskDrill?.key!=='person:'+String(row.workerId)||!Array.isArray(rects)||rects.length!==rows.length||rects.some(rect=>!rect||!Number.isFinite(rect.top)||!Number.isFinite(rect.height)||rect.height<=0))return;
        const ids=rows.filter(item=>['IN_PROGRESS','READY','PAUSED'].includes(item.status)).map(item=>String(item.id));if(!ids.includes(String(row.id)))return;
        const top=rects[0].top,gap=rects.length>1?Math.max(0,rects[1].top-rects[0].top-rects[0].height):10;
        const heights=Object.fromEntries(rows.map((item,index)=>[String(item.id),rects[index].height])),centers=ids.map(id=>{const index=rows.findIndex(item=>same(item.id,id));return rects[index].top-top+rects[index].height/2;});
        this.inlineSort={...this.inlineHold,rows,ids,originalIds:[...ids],workerId:String(row.workerId),version:this.data.executionVersion,heights,gap,centers,top,startTop:rects[rows.findIndex(item=>same(item.id,row.id))].top-top,revision};
        this.setData({inlineSorting:true,inlineListHeight:rects.at(-1).top-top+rects.at(-1).height,actionBusy:true});wx.vibrateShort?.({type:'light'});this.updateInlinePose();
      });
    },
    updateInlinePose(released=false){
      const drag=this.inlineSort;if(!drag)return;const history=drag.rows.filter(row=>!drag.ids.includes(String(row.id))),ordered=[...drag.ids,...history.map(row=>String(row.id))];let offset=0;const offsets={};
      for(const id of ordered){offsets[id]=offset;offset+=drag.heights[id]+drag.gap;}
      const currentY=Math.max(0,Math.min(offset-drag.gap-drag.heights[drag.id],drag.startTop+drag.y-drag.startY));
      this.setData({displayTasks:drag.rows.map(row=>({...row,inlineY:!released&&same(row.id,drag.id)?currentY:offsets[String(row.id)],inlineHeight:drag.heights[String(row.id)],inlineHeld:!released&&same(row.id,drag.id),inlinePreviewCurrent:same(row.id,drag.ids[0])}))});
    },
    onInlineSortMove(event){
      if(this.inlineCommitting)return;
      const hold=this.inlineSort||this.inlineHold,point=event.touches?.find(row=>row.identifier===hold?.identifier);if(!point)return;hold.y=point.clientY;const drag=this.inlineSort;if(!drag)return;
      const center=drag.startTop+drag.y-drag.startY+drag.heights[drag.id]/2;let slot=0,distance=Infinity;drag.centers.forEach((value,index)=>{if(Math.abs(value-center)<distance){distance=Math.abs(value-center);slot=index;}});
      const ids=drag.originalIds.filter(id=>!same(id,drag.id));ids.splice(slot,0,drag.id);drag.ids=ids;this.updateInlinePose();
    },
    async onInlineSortEnd(){
      if(this.inlineCommitting)return;
      const drag=this.inlineSort;if(!drag){this.disposeInlineSort();return;}
      if(drag.ids.join('|')===drag.originalIds.join('|')||getApp().globalData.entry?.appRole!=='floor8_leader'){this.onInlineSortCancel();return;}
      this.updateInlinePose(true);this.inlineCommitting=true;this.inlineHold=null;this.setData({executionError:''});
      try{
        await api.executeExecutionAction('reorderQueue',{workerId:drag.workerId,assignmentIds:[...drag.ids]},{expectedVersion:drag.version,operationId:'inline-order-'+Date.now()+'-'+drag.id});
        if(!this.unloaded)await this.loadExecution();
      }catch(error){if(!this.unloaded){await this.loadExecution();if(!this.unloaded)this.setData({executionError:error.message||'顺序未能确认，请重新核对。'});}}
      finally{this.inlineCommitting=false;this.disposeInlineSort();if(!this.unloaded){this.setData({inlineSorting:false,actionBusy:false});this.updateView();}}
    },
    onInlineSortCancel(){
      if(this.inlineCommitting)return;const sorting=this.data.inlineSorting;this.disposeInlineSort();if(!this.unloaded&&sorting){this.setData({inlineSorting:false,actionBusy:false});this.updateView();}
    },
    stopQueueTap(){}
  }
};
