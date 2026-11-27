// One return coordinator per native page. Components keep their existing exit
// animations and draft state; the page-container is only a native back sentinel.
let serial=0;
const delay=360;
const call=(o,name)=>typeof o?.[name]==='function'?()=>o[name]():null;
const child=(o,id)=>o.selectComponent?.('#'+id);
const busy=o=>!!(o?.data?.busy||o?.data?.actionBusy||o?.data?.submitting||o?.data?.inlineSorting||o?.data?.routeBusy);
function item(o,key,close,closing=false){return {owner:o,key:(o._layerBackId||'owner')+':'+key,close,blocked:busy(o)||closing};}
function own(o,field,method,open){const d=o.data;if(!d[field])return null;return item(o,field,call(o,method),open!==undefined&&d[open]===false);}
function nested(o,field,id,method,visible){if(!o.data[field])return null;const c=child(o,id),layer=c&&resolve(c);return layer||item(o,field,call(o,method),visible&&o.data[visible]===false);}
function resolve(o){
 if(!o?.data)return null;const d=o.data,kind=o._layerBackKind;
 if(kind==='reports-dashboard'&&d.reportOrderMounted)return nested(o,'reportOrderMounted','report-order-detail','closeReportOrder','reportOrderVisible');
 let layer=own(o,'imageViewer','closeProductPreview');if(layer){layer.blocked ||=d.imageViewer.open===false;return layer;}
 for(const [field,method,open]of [['selfDefectEditor','closeSelfDefect','selfDefectEditorOpen'],['reportTimeWheel','closeReportDateTime','reportTimeOpen'],['reportPeopleMounted','closeReportPeople','reportPeopleOpen']]){layer=own(o,field,method,open);if(layer)return layer;}
 if(d.reportPanel){if(d.reportDefectsOpen&&d.reportPanel.isEditor)return item(o,'reportDefectsOpen',call(o,'toggleReportDefects'));return item(o,'reportPanel',call(o,'closeReportPanel'));}
 for(const [field,method,open]of [['reportMenu','closeReportMenu','reportMenuOpen'],['assignmentSelection','closeAssignmentPanel'],['assignmentMenu','closeAssignmentMenu','assignmentMenuOpen'],['assignmentPanel','closeAssignmentPanel','assignmentPanelOpen'],['productPanel','closeTaskProduct','productPanelOpen'],['taskChooser','closeTaskChooser','taskChooserOpen'],['peopleMenu','closePeopleMenu','peopleMenuOpen'],['selectedPanelMounted','closeSelectedPeople','selectedPanelOpen']]){layer=own(o,field,method,open);if(layer)return layer;}
 if(kind==='reports-dashboard')return own(o,'picker','closePicker')||own(o,'reportRecordsOpen','closeRecords');
 if(kind==='liquid-detail'||kind==='details'){layer=own(o,'routePanel','closeProcessManagement')||own(o,'processDetailMounted','closeProcessDetail','processDetailOpen');if(layer)return layer;if(kind==='liquid-detail')return busy(o)?item(o,'busy',null):null;}
 if(kind==='leader-tasks'||kind==='tasks'){layer=own(o,'taskDrill','closeTaskGroup')||own(o,'reportScope','clearReportScope');if(layer)return layer;if(kind==='leader-tasks')return busy(o)?item(o,'busy',null):null;}
 if(d.detailMounted)return nested(o,'detailMounted','workspace-detail','closeDetail','detailVisible');
 if(d.workerPanel){
  if(d.recordFilterOpen)return item(o,'recordFilterOpen',()=>o.setData({recordFilterOpen:false,recordFilterHeight:0}));
  return item(o,'workerPanel',call(o,kind==='worker'&&d.workerPanel.kind==='quantity'?'dismissWorkerPanel':'closeWorkerPanel'),d.panelOpen===false);
 }
 if(d.clockoutPanel)return item(o,'clockoutPanel',call(o,d.clockoutView==='schedule'?'backClockout':'closeClockout'));
 for(const [field,method]of [['operationPanel','closeOrderOperations'],['listPanel','closeOrderListTool']]){layer=own(o,field,method);if(layer)return layer;}
 if(kind==='orders'&&d.workspaceTab===1){layer=resolve(child(o,'leader-tasks-panel'));if(layer)return layer;}
 if(kind==='orders'&&d.workspaceTab===3||kind==='worker'&&d.workerTab==='reports'){layer=resolve(child(o,'reports-panel'));if(layer)return layer;}
 if(kind==='dispatch'){
  if(d.reviewOpen)return item(o,'reviewOpen',call(o,'closeReview'));
  if(d.stage==='process'&&!d.processFirst)return item(o,'dispatch-process',call(o,'backToPeople'));
  if(d.processFirst&&d.stage==='people')return item(o,'dispatch-people',call(o,'editChosenProcess'));
 }
 const trail=o._layerBackTrail;if(trail?.length)return item(o,'workspace-history',()=>{const previous=trail.pop();o._layerBackReturning=true;try{o.setData(previous);if(kind==='worker')o.syncWorkerNavigation?.();else{o.setData({navActiveIndex:previous.workspaceTab,navHover:previous.workspaceTab});o.measureGlassNav?.();}}finally{o._layerBackReturning=false;}});
 if(busy(o))return item(o,'busy',null);
 if(o._layerBackPage&&typeof getCurrentPages==='function'&&getCurrentPages().length>1)return {...item(o,'page-route',()=>wx.navigateBack({delta:1})),route:true};
 return null;
}
function schedule(page,ms=0){if(!page?._layerBackActive||typeof page.syncLayerBack!=='function'||page._layerBackSyncTimer)return;page._layerBackSyncTimer=setTimeout(()=>{page._layerBackSyncTimer=null;page.syncLayerBack();},ms);}
function install(o,kind,page){
 o._layerBackId=++serial;o._layerBackKind=kind;o._layerBackActive=true;o._layerBackRoot=page||o;o._layerBackRawSet=o.setData;
 o.setData=function(values,callback){const d=this.data,root=this._layerBackRoot;
  if(this._layerBackPage&&this._layerBackReady&&!this._layerBackReturning){const field=kind==='orders'?'workspaceTab':kind==='worker'?'workerTab':null;
   if(field&&Object.prototype.hasOwnProperty.call(values,field)&&d[field]!==values[field]){if(values.workspaceInstant===true)this._layerBackTrail=[];else{const trail=this._layerBackTrail;trail.push({[field]:d[field]});if(trail.length>20)trail.shift();}}}
  this._layerBackRawSet.call(this,values,()=>{callback?.();schedule(root);});schedule(root);
 };
 schedule(o._layerBackRoot);
}
function detach(o){o._layerBackActive=false;clearTimeout(o._layerBackSyncTimer);clearTimeout(o._layerBackUnlock);o._layerBackGesture=null;o._layerBackRoute=null;o._layerBackLeaving=false;if(o._layerBackRawSet)o.setData=o._layerBackRawSet;}
const methods={
 syncLayerBack(){
  if(!this._layerBackActive||this._layerBackHidden)return;const top=resolve(this),guard=!!top&&!top.route&&this._layerBackNative,patch={};
  if(this.data.backGestureEnabled!==!!top)patch.backGestureEnabled=!!top;
  if(this.data.backLayerKey!==(top?.key||''))patch.backLayerKey=top?.key||'';
  if(!this._layerBackLeaving&&Date.now()>=(this._layerBackLockUntil||0)&&this.data.backGuardVisible!==guard){if(!guard&&this.data.backGuardVisible)this._layerBackLeaving=true;patch.backGuardVisible=guard;}
  if(Object.keys(patch).length)this._layerBackRawSet.call(this,patch);
 },
 backOneLayer(source='gesture'){
  if(!this._layerBackActive||this._layerBackHidden||Date.now()<(this._layerBackLockUntil||0))return false;
  const top=resolve(this);if(!top)return false;this._layerBackLockUntil=Date.now()+delay;this._layerBackGesture=null;this._layerBackRawSet.call(this,{backHint:null});
  clearTimeout(this._layerBackUnlock);this._layerBackUnlock=setTimeout(()=>{this._layerBackUnlock=null;schedule(this);},delay+1);
  if(source!=='native'&&this.data.backGuardVisible){this._layerBackLeaving=true;this._layerBackRawSet.call(this,{backGuardVisible:false});}
  if(top.blocked||!top.close){wx.showToast?.({title:busy(top.owner)?'正在处理，请稍候':'请稍候',icon:'none'});return true;}
  wx.hideKeyboard?.();if(top.route&&this._layerBackLeaving)this._layerBackRoute=top.close;else top.close();schedule(this);return true;
 },
 onLayerBackBeforeLeave(){
  if(!this._layerBackActive||this._layerBackHidden||this._layerBackLeaving||!this.data.backGuardVisible)return;
  this._layerBackLeaving=true;this._layerBackRawSet.call(this,{backGuardVisible:false});this.backOneLayer('native');
 },
 onLayerBackAfterLeave(){if(!this._layerBackActive||this._layerBackHidden||!this._layerBackLeaving)return;this._layerBackLeaving=false;const route=this._layerBackRoute;this._layerBackRoute=null;if(route)return route();schedule(this,Math.max(0,(this._layerBackLockUntil||0)-Date.now()+1));},
 onLayerBackTouchStart(event){
  this._layerBackGesture=null;if(!this._layerBackActive||this._layerBackHidden)return;const p=event.touches?.[0],top=resolve(this);if(!p||event.touches.length!==1||!top||event.mark?.backIgnore||event.mark?.backignore||event.mark?.['back-ignore']||event.target?.dataset?.backIgnore)return;
  const w=(wx.getWindowInfo?.()||wx.getSystemInfoSync?.()||{}).windowWidth||390,side=p.clientX<=24?'left':p.clientX>=w-24?'right':null;if(!side)return;
  this._layerBackGesture={id:p.identifier,x:p.clientX,y:p.clientY,side,key:top.key,at:Date.now(),distance:0};
 },
 onLayerBackTouchMove(event){
  const g=this._layerBackGesture,p=event.touches?.[0];if(!g)return;if(event.touches.length!==1||p.identifier!==g.id)return this.onLayerBackTouchCancel();
  const dx=p.clientX-g.x,dy=p.clientY-g.y,distance=g.side==='left'?dx:-dx;if(Math.abs(dy)>36||Math.abs(dy)>14&&Math.abs(dy)>Math.abs(dx))return this.onLayerBackTouchCancel();
  g.distance=distance;g.dy=dy;if(distance<10)return;const reduced=this.data.reduceMotion===true,progress=Math.min(1,distance/72),height=wx.getWindowInfo?.().windowHeight||740;
  this._layerBackRawSet.call(this,{backHint:{side:g.side,y:Math.max(70,Math.min(height-90,g.y))-18,opacity:progress,transform:reduced?'none':'translateX('+(g.side==='left'?1:-1)*Math.min(16,distance*.13)+'px) scale('+(.86+progress*.14)+')'}});
 },
 onLayerBackTouchEnd(event){
  if(!this._layerBackActive||this._layerBackHidden)return;
  const g=this._layerBackGesture,p=event.changedTouches?.find(p=>p.identifier===g?.id);this._layerBackGesture=null;this._layerBackRawSet.call(this,{backHint:null});if(!g||!p||Date.now()-g.at>900)return;
  const distance=g.side==='left'?p.clientX-g.x:g.x-p.clientX,dy=Math.abs(p.clientY-g.y),top=resolve(this);if(top?.key===g.key&&distance>=64&&distance>dy*2.2&&dy<=36)this.backOneLayer();
 },
 onLayerBackTouchCancel(){if(!this._layerBackActive)return;this._layerBackGesture=null;this._layerBackRawSet.call(this,{backHint:null});}
};
function page(definition,kind){
 const load=definition.onLoad,show=definition.onShow,hide=definition.onHide,unload=definition.onUnload;
 return {...definition,...methods,data:{...definition.data,backGestureEnabled:false,backGuardVisible:false,backLayerKey:'',backHint:null},
  async onLoad(...args){this._layerBackPage=true;this._layerBackTrail=[];this._layerBackNative=wx.canIUse?.('page-container')===true;install(this,kind);try{return await load?.apply(this,args);}finally{this._layerBackReady=true;schedule(this);}},
  onShow(...args){this._layerBackHidden=false;const result=show?.apply(this,args);schedule(this);return result;},
  onHide(...args){this._layerBackHidden=true;this._layerBackGesture=null;return hide?.apply(this,args);},
  onUnload(...args){detach(this);return unload?.apply(this,args);}
 };
}
function component(definition,kind){const attached=definition.lifetimes?.attached,detached=definition.lifetimes?.detached;
 return {...definition,lifetimes:{...definition.lifetimes,attached(){const root=typeof getCurrentPages==='function'?getCurrentPages().slice(-1)[0]:null;install(this,kind,root);return attached?.call(this);},detached(){const root=this._layerBackRoot;detach(this);const result=detached?.call(this);schedule(root);return result;}}};
}
module.exports={page,component,resolve};
