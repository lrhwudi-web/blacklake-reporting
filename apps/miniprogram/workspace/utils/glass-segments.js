// Shared segmented-control gestures; reuses the MIT-attributed Liquidum spring port.
const {spring,step}=require('./glass-navigation');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const choices={
  tabs:['progress','materials','history','outsource'],
  processes:['all','paused','running'],
  priority:['NORMAL','URGENT']
};
function spec(owner,key){
  const d=owner.data;
  if(key==='orders')return {values:d.statuses.map(r=>r.key),value:d.activeStatus,handler:'selectStatus',field:'status',disabled:()=>false};
  if(key==='tabs')return {values:choices.tabs,value:d.tab,handler:'setTab',field:'tab',disabled:()=>false};
  if(key==='processes')return {values:choices.processes,value:d.processFilter,handler:'setFilter',field:'filter',disabled:i=>i>0&&!d.executionLoaded};
  if(key==='priority')return {values:choices.priority,value:d.dispatchPriority,handler:'setDispatchPriority',field:'priority',disabled:()=>!!d.submitting};
  if(key==='assignmentPriority')return {values:choices.priority,value:d.assignmentDraft?.priority,handler:'setAssignmentPriority',field:'priority',disabled:()=>!!d.actionBusy||d.assignmentPanel?.action!=='editAssignment'};
  if(key==='taskTabs')return {values:['assignments','reports'],value:d.taskTab,handler:'setTaskTab',field:'tab',disabled:()=>!!d.actionBusy};
  if(key==='reportTabs')return {values:['summary','people','time','quality'],value:d.reportTab,handler:'setReportTab',field:'tab',disabled:()=>!!d.reportRecordsOpen||!!d.picker};
  if(key==='taskStatus')return {values:['all','paused','running'],value:d.taskStatus,handler:'setTaskStatus',field:'status',disabled:()=>!!d.actionBusy};
  if(key==='workerTabs')return {values:['tasks','orders','mine'],value:d.workerTab,handler:'setWorkerTab',field:'tab',disabled:()=>!!d.busy||!!d.workerPanel||!!d.imageViewer||!!d.detailMounted};
  if(key==='workerOrders')return {values:d.workerOrderStatuses.map(row=>row.key),value:d.workerOrderStatus,handler:'selectWorkerOrderStatus',field:'status',disabled:()=>!!d.detailMounted};
}
function layout(rect,count){
  if(!rect||![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||rect.width<=10||rect.height<=10)return null;
  const width=(rect.width-10)/count;
  return {left:rect.left+5,top:rect.top,height:rect.height-10,width,centers:Array.from({length:count},(_,i)=>(i+.5)*width)};
}
function scaleSpring(value=1,release=false){const k=release?304.61742:541.54208,c=release?20.943951:29.088821;return spring(value,2*Math.PI/Math.sqrt(k),c/(2*Math.sqrt(k)),.00001);}
const data={segmentTracks:{}};
const methods={
  setupGlassSegments(){this.segmentDisposed=false;this.resetGlassSegments();if(!this.segmentResize){this.segmentResize=()=>this.resetGlassSegments();wx.onWindowResize?.(this.segmentResize);}},
  resetGlassSegments(){
    this.segmentRevision=(this.segmentRevision||0)+1;this.segmentGesture=null;
    for(const state of Object.values(this.segmentStates||{}))if(state.timer!=null)clearTimeout(state.timer);
    this.segmentStates={};if(!this.segmentDisposed)this.setData({segmentTracks:{}});
  },
  disposeGlassSegments(){this.resetGlassSegments();this.segmentDisposed=true;if(this.segmentResize)wx.offWindowResize?.(this.segmentResize);this.segmentResize=null;},
  segmentReduced(){return this.data.reduceMotion===true||this.properties?.reduceMotion===true||getApp().globalData.reduceMotion===true;},
  segmentNearest(state,x){
    const s=spec(this,state.key);let best=-1;
    for(let i=0;i<s.values.length;i++)if(!s.disabled(i)&&(best<0||Math.abs(state.geometry.centers[i]-x)<Math.abs(state.geometry.centers[best]-x)))best=i;
    return best;
  },
  presentGlassSegment(state){
    if(this.segmentDisposed)return;
    const g=state.geometry,lift=this.segmentReduced()?0:clamp(state.lift.value,0,1),press=this.segmentReduced()?1:state.press.value;
    const scales=g.centers.map(center=>Number((1+.16*lift*clamp(1-Math.abs(center-state.position.value)/g.width,0,1)).toFixed(5)));
    const value={x:Number((state.position.value-g.width/2).toFixed(4)),scaleX:Number(((1+16*lift/g.width)*press).toFixed(6)),scaleY:Number(((1+16*lift/g.height)*press).toFixed(6)),pressed:!!this.segmentGesture&&this.segmentGesture.key===state.key,hover:this.segmentNearest(state,state.position.value),scales};
    this.setData({segmentTracks:{...this.data.segmentTracks,[state.key]:value}});
  },
  animateGlassSegment(state){
    if(state.timer!=null||this.segmentDisposed)return;
    state.clock=Date.now();
    const tick=()=>{
      state.timer=null;if(this.segmentDisposed||this.segmentStates?.[state.key]!==state)return;
      const now=Date.now(),dt=Math.min(.064,Math.max(0,(now-state.clock)/1000));state.clock=now;
      const touch=this.segmentGesture?.key===state.key?this.segmentGesture:null;
      if(!touch)state.lift.target=now<state.hangUntil?1:0;
      if(!touch?.dragging)step(state.position,dt);step(state.lift,dt);step(state.press,dt);
      state.position.value=clamp(state.position.value,state.geometry.centers[0],state.geometry.centers[state.geometry.centers.length-1]);
      this.presentGlassSegment(state);
      const moving=s=>s.value!==s.target||s.velocity!==0;
      if((!touch?.dragging&&moving(state.position))||moving(state.lift)||moving(state.press)||now<state.hangUntil)state.timer=setTimeout(tick,16);
    };
    state.timer=setTimeout(tick,16);
  },
  onGlassSegmentStart(event){
    const key=event.currentTarget.dataset.segment,s=spec(this,key),p=event.touches?.[0];
    if(!s||event.touches?.length!==1||!p||this.segmentDisposed||s.values.every((_,i)=>s.disabled(i)))return;
    if(this.segmentGesture)this.onGlassSegmentCancel();
    this.segmentStates||={};this.segmentTapUntil||={};
    const touch=this.segmentGesture={key,identifier:p.identifier,startX:p.clientX,startY:p.clientY,x:p.clientX,y:p.clientY,startTime:Date.now(),dragging:false,history:[]};
    const revision=this.segmentRevision||0;
    const query=this.createSelectorQuery?.()||wx.createSelectorQuery?.();
    if(!query){this.segmentGesture=null;return;}
    query.select('#segment-'+key).boundingClientRect().exec(rects=>{
      if(this.segmentDisposed||revision!==(this.segmentRevision||0)||this.segmentGesture!==touch)return;
      const g=layout(rects?.[0],s.values.length);if(!g){this.segmentGesture=null;return;}
      let state=this.segmentStates[key];
      if(state?.geometry.width!==g.width){if(state?.timer!=null)clearTimeout(state.timer);state=null;}
      const selected=Math.max(0,s.values.indexOf(spec(this,key).value));
      state||={key,position:spring(g.centers[selected]),lift:spring(0,.25,1,.0001),press:scaleSpring(),hangUntil:0,timer:null};
      state.geometry=g;this.segmentStates[key]=state;touch.state=state;
      const x=touch.startX-g.left;
      touch.offset=Math.abs(x-state.position.value)<=g.width/2?x-state.position.value:0;
      state.position.target=clamp(x-touch.offset,g.centers[0],g.centers[g.centers.length-1]);state.hangUntil=0;
      state.lift.target=this.segmentReduced()?0:1;
      const press=scaleSpring(state.press.value);press.velocity=state.press.velocity;press.target=this.segmentReduced()?1:1.0355;state.press=press;
      this.presentGlassSegment(state);this.animateGlassSegment(state);
      if(touch.ended)this.finishGlassSegment(touch,true);
      else if(touch.dragging)this.moveGlassSegment(touch);
    });
  },
  moveGlassSegment(touch){
    const state=touch.state;if(!state)return;const g=state.geometry;
    const x=clamp(touch.x-g.left-touch.offset,g.centers[0],g.centers[g.centers.length-1]);
    state.position.target=x;
    if(touch.dragging){state.position.value=x;const now=Date.now();touch.history.push({x,time:now});touch.history=touch.history.filter(p=>p.time>=now-90);const first=touch.history[0];state.position.velocity=now>first.time?clamp((x-first.x)*1000/(now-first.time),-1800,1800):0;}
    this.presentGlassSegment(state);this.animateGlassSegment(state);
  },
  onGlassSegmentMove(event){
    const touch=this.segmentGesture;if(!touch)return;if(event.touches?.length!==1)return this.onGlassSegmentCancel();
    const p=event.touches.find(p=>p.identifier===touch.identifier);if(!p)return;
    touch.x=p.clientX;touch.y=p.clientY;
    if(Math.abs(p.clientY-touch.startY)>32)return this.onGlassSegmentCancel();
    if(Math.abs(p.clientX-touch.startX)>4)touch.dragging=true;
    this.moveGlassSegment(touch);
  },
  onGlassSegmentEnd(event){
    const touch=this.segmentGesture;if(!touch)return;
    const p=event.changedTouches?.find(p=>p.identifier===touch.identifier);if(!p)return;
    touch.x=p.clientX;touch.y=p.clientY;touch.ended=true;
    if(Math.abs(p.clientY-touch.startY)>32)return this.onGlassSegmentCancel();
    this.segmentTapUntil[touch.key]=Date.now()+350;
    if(touch.state)this.finishGlassSegment(touch,true);
  },
  finishGlassSegment(touch,commit){
    const state=touch.state;if(!state){this.segmentGesture=null;return;}
    if(commit&&touch.dragging)this.moveGlassSegment(touch);
    const s=spec(this,touch.key),index=commit?this.segmentNearest(state,touch.x-state.geometry.left-touch.offset):-1;
    this.segmentGesture=null;
    if(commit&&index>=0&&!s.disabled(index))this[s.handler]?.({currentTarget:{dataset:{[s.field]:s.values[index]}}});
    const selected=Math.max(0,s.values.indexOf(spec(this,touch.key).value));
    state.position.target=state.geometry.centers[selected];
    if(!touch.history.length||Date.now()-touch.history[touch.history.length-1].time>90)state.position.velocity=0;
    state.hangUntil=commit&&!this.segmentReduced()&&Date.now()-touch.startTime<220?Date.now()+220:0;
    state.lift.target=state.hangUntil?1:0;
    const press=scaleSpring(state.press.value,true);press.velocity=state.press.velocity;press.target=1;state.press=press;
    if(this.segmentReduced()){state.position.value=state.position.target;state.position.velocity=0;state.lift.value=state.lift.target=0;state.press.value=state.press.target=1;state.press.velocity=0;}
    this.segmentTapUntil[touch.key]=Date.now()+350;
    this.presentGlassSegment(state);this.animateGlassSegment(state);
  },
  onGlassSegmentCancel(){const touch=this.segmentGesture;if(!touch)return;this.segmentTapUntil||={};this.segmentTapUntil[touch.key]=Date.now()+350;this.finishGlassSegment(touch,false);},
  onGlassSegmentTap(event){
    const {segment:key,index}=event.currentTarget.dataset,s=spec(this,key),i=Number(index);
    const keyboard=event.detail?.keyboard===true;
    if(!s||this.segmentGesture?.key===key||!keyboard&&Date.now()<(this.segmentTapUntil?.[key]||0)||!Number.isInteger(i)||i<0||i>=s.values.length||s.disabled(i))return;
    this[s.handler]?.({currentTarget:{dataset:{[s.field]:s.values[i]}}});
    const state=this.segmentStates?.[key];if(state){state.position.target=state.geometry.centers[Math.max(0,s.values.indexOf(spec(this,key).value))];if(this.segmentReduced()||keyboard){state.position.value=state.position.target;state.position.velocity=0;}if(keyboard){if(state.timer!=null)clearTimeout(state.timer);state.timer=null;state.hangUntil=0;state.lift.value=state.lift.target=state.lift.velocity=0;state.press.value=state.press.target=1;state.press.velocity=0;}this.presentGlassSegment(state);if(!keyboard)this.animateGlassSegment(state);}
  }
};
module.exports={data,methods,layout};
