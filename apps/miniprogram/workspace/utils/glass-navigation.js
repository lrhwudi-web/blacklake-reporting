// Geometry and oscillator math adapted from Liquidum (MIT), Mohammed AL-Samarraie.
// See ../third-party/LIQUIDUM-LICENSE.txt. This port does not include its GLSL renderer.
const labels=['工单','任务','下班','报表','看板'];
const icons=['home','history','clockout','report','board'];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function geometry(width,count=5){
  const barWidth=Math.max(200,Number.isFinite(width)?width-42:348),pillWidth=(barWidth-8+33)/count,first=4+pillWidth/2,spacing=(barWidth-8-pillWidth)/(count-1);
  return {barWidth,pillWidth,centers:Array.from({length:count},(_,i)=>first+i*spacing)};
}
function spring(value,response=.405,damping=.85,tolerance=.001){return {value,target:value,velocity:0,response,damping,tolerance};}
const physical=(value,stiffness,damping)=>spring(value,2*Math.PI/Math.sqrt(stiffness),damping/(2*Math.sqrt(stiffness)),.00001);
function step(s,dt){
  if(dt<=0)return;const w=2*Math.PI/s.response,z=s.damping,x0=s.value-s.target,v0=s.velocity;
  if(z===1){const e=Math.exp(-w*dt),b=v0+w*x0;s.value=s.target+(x0+b*dt)*e;s.velocity=(b-w*(x0+b*dt))*e;}
  else{const wd=w*Math.sqrt(1-z*z),e=Math.exp(-z*w*dt),c=Math.cos(wd*dt),n=Math.sin(wd*dt),b=(v0+z*w*x0)/wd;s.value=s.target+e*(x0*c+b*n);s.velocity=e*(-z*w*(x0*c+b*n)+wd*(b*c-x0*n));}
  if(Math.abs(s.value-s.target)<s.tolerance&&Math.abs(s.velocity)<s.tolerance*10){s.value=s.target;s.velocity=0;}
}
const items=(g,custom)=> (custom||labels.map((label,index)=>({label,icon:icons[index]}))).map((row,index)=>({...row,index,left:g.centers[index]-g.pillWidth/2}));
const initial=geometry(390);
const data={navItems:items(initial),navActiveIndex:0,navPillWidth:initial.pillWidth,navLensLeft:4,navLift:0,navHover:0,navPressed:false,navBarShift:0,navBarScaleX:1,navBarScaleY:1,navGlowX:0};
const methods={
  setupGlassNav(config={}){
    this.glassNavItems=Array.isArray(config.items)&&config.items.length>=2?config.items:null;
    this.navUnloaded=false;this.measureGlassNav();this.navResize=()=>{const info=wx.getWindowInfo?.()||wx.getSystemInfoSync?.()||{};if(info.windowWidth!==this.navWindowWidth)this.measureGlassNav();};wx.onWindowResize?.(this.navResize);
  },
  measureGlassNav(){
    this.stopGlassNav();this.navTouch=null;const info=wx.getWindowInfo?.()||wx.getSystemInfoSync?.()||{},g=this.navGeometry=geometry(info.windowWidth,this.glassNavItems?.length||5);this.navWindowWidth=info.windowWidth;
    const active=clamp(Number.isInteger(this.data.navActiveIndex)?this.data.navActiveIndex:0,0,g.centers.length-1);
    this.navPosition=spring(g.centers[active]);this.navLiftSpring=spring(0,.25,1,.0001);this.navScaleSpring=physical(1,541.54208,29.088821);this.navStretchSpring=spring(0,.314,1,.000001);this.navHangUntil=0;
    this.setData({...data,navActiveIndex:active,navHover:active,navLensLeft:g.centers[active]-g.pillWidth/2,navItems:items(g,this.glassNavItems),navPillWidth:g.pillWidth,reduceMotion:getApp().globalData.reduceMotion===true});
  },
  stopGlassNav(){if(this.navTimer!=null)clearTimeout(this.navTimer);this.navTimer=null;},
  clearGlassNav(){this.navUnloaded=true;this.stopGlassNav();this.navTouch=null;if(this.navResize)wx.offWindowResize?.(this.navResize);},
  glassPlatter(){
    if(this.data.reduceMotion)return {x:1,y:1,shift:0};
    const stretch=this.navStretchSpring.value,scale=this.navScaleSpring.value;
    return {x:scale*(1+Math.abs(stretch)),y:scale/(1+Math.abs(stretch)),shift:1.075*stretch*this.navGeometry.barWidth};
  },
  glassLocalX(screenX,offset=0){const g=this.navGeometry,p=this.glassPlatter();return g.barWidth/2+(screenX-21-offset-g.barWidth/2-p.shift)/p.x;},
  presentGlassNav(){
    const g=this.navGeometry;if(!g||!this.navPosition)return;const lift=this.data.reduceMotion?0:clamp(this.navLiftSpring.value,0,1);
    const p=this.glassPlatter();
    this.setData({navLensLeft:Number((this.navPosition.value-g.pillWidth/2).toFixed(3)),navLift:Number(lift.toFixed(4)),navBarShift:Number(p.shift.toFixed(4)),navBarScaleX:Number(p.x.toFixed(6)),navBarScaleY:Number(p.y.toFixed(6)),navGlowX:this.navTouch?this.glassLocalX(this.navTouch.x):this.data.navGlowX});
  },
  tickGlassNav(){
    this.navTimer=null;if(this.navUnloaded||!this.navPosition)return;const now=Date.now(),dt=Math.min(.064,Math.max(0,(now-(this.navClock??now))/1000));this.navClock=now;
    if(!this.navTouch)this.navLiftSpring.target=!this.data.reduceMotion&&now<this.navHangUntil?1:0;
    step(this.navScaleSpring,dt);step(this.navStretchSpring,dt);step(this.navLiftSpring,dt);
    if(this.navTouch?.dragging){const g=this.navGeometry;this.navPosition.value=this.navPosition.target=clamp(this.glassLocalX(this.navTouch.x,this.navTouch.offset),g.centers[0],g.centers[g.centers.length-1]);}
    else{step(this.navPosition,dt);const bounded=clamp(this.navPosition.value,this.navGeometry.centers[0],this.navGeometry.centers[this.navGeometry.centers.length-1]);if(bounded!==this.navPosition.value){this.navPosition.value=bounded;this.navPosition.velocity=0;}}
    this.presentGlassNav();
    const movingPosition=!this.navTouch?.dragging&&(this.navPosition.value!==this.navPosition.target||this.navPosition.velocity!==0);
    const moving=s=>s.value!==s.target||s.velocity!==0;
    if(movingPosition||[this.navLiftSpring,this.navScaleSpring,this.navStretchSpring].some(moving)||now<this.navHangUntil)this.navTimer=setTimeout(()=>this.tickGlassNav(),16);
  },
  animateGlassNav(){if(this.navTimer!=null)return;this.navClock=Date.now();this.navTimer=setTimeout(()=>this.tickGlassNav(),16);},
  nearestGlassTab(x){const c=this.navGeometry.centers;let best=0;for(let i=1;i<c.length;i++)if(Math.abs(c[i]-x)<Math.abs(c[best]-x))best=i;return best;},
  onGlassNavStart(event){
    const point=event.touches?.[0];if(event.touches?.length!==1)return this.cancelGlassNav();if(this.glassNavBlocked?.()||this.data.clockoutPanel||this.data.listPanel||this.data.detailMounted||this.data.operationPanel||this.data.imageViewer||this.data.workspaceTaskModal||this.data.workspaceTaskBusy||!point)return;if(!this.navGeometry)this.measureGlassNav();
    this.stopGlassNav();const g=this.navGeometry,x=this.glassLocalX(point.clientX),p=this.glassPlatter();
    const offset=Math.abs(x-this.navPosition.value)<g.pillWidth/2?(x-this.navPosition.value)*p.x:0;
    this.navTouch={identifier:point.identifier,startX:point.clientX,startY:point.clientY,x:point.clientX,y:point.clientY,offset,dragging:false,startedAt:Date.now(),history:[{x:this.navPosition.value,time:Date.now()}]};this.navHangUntil=0;
    this.navPosition.target=this.data.reduceMotion?g.centers[this.data.navActiveIndex||0]:clamp(this.glassLocalX(point.clientX,offset),g.centers[0],g.centers[g.centers.length-1]);this.navLiftSpring.target=this.data.reduceMotion?0:1;
    this.navStretchSpring.response=.314;this.navStretchSpring.damping=1;
    Object.assign(this.navScaleSpring,physical(this.navScaleSpring.value,541.54208,29.088821),{velocity:this.navScaleSpring.velocity,target:this.data.reduceMotion?1:1.0355});
    this.setData({navPressed:true,navHover:this.nearestGlassTab(x)});this.presentGlassNav();this.animateGlassNav();
  },
  onGlassNavMove(event){
    const touch=this.navTouch;if(!touch)return;if(event.touches?.length!==1)return this.cancelGlassNav();const point=event.touches.find(row=>row.identifier===touch.identifier);if(!point)return;
    touch.x=point.clientX;touch.y=point.clientY;if(Math.abs(point.clientY-touch.startY)>45)return this.cancelGlassNav();
    if(this.data.reduceMotion)return;
    if(Math.abs(point.clientX-touch.startX)>4)touch.dragging=true;
    this.navStretchSpring.target=2.77e-5*(point.clientX-touch.startX);
    const g=this.navGeometry,x=clamp(this.glassLocalX(point.clientX,touch.offset),g.centers[0],g.centers[g.centers.length-1]);this.navPosition.target=x;
    if(touch.dragging){this.navPosition.value=x;const time=Date.now();touch.history.push({x,time});touch.history=touch.history.filter(row=>row.time>=time-90);const first=touch.history[0];this.navPosition.velocity=time>first.time?clamp((x-first.x)*1000/(time-first.time),-1800,1800):0;}
    this.setData({navHover:this.nearestGlassTab(x)});this.presentGlassNav();this.animateGlassNav();
  },
  onGlassNavEnd(event){
    const touch=this.navTouch;if(!touch)return;const point=event.changedTouches?.find(row=>row.identifier===touch.identifier);if(!point)return;
    const index=this.nearestGlassTab(this.glassLocalX(point.clientX,touch.offset)),valid=Math.abs(point.clientY-touch.startY)<=45;if(Date.now()-touch.history[touch.history.length-1].time>90)this.navPosition.velocity=0;
    const quick=valid&&Date.now()-touch.startedAt<220;if(valid)this.activateGlassTab(index);this.cancelGlassNav(quick);
  },
  cancelGlassNav(quick=false){
    if(this.navTouch)this.navTapUntil=Date.now()+280;this.navTouch=null;if(!this.navGeometry)return;const active=this.data.navActiveIndex||0;this.navPosition.target=this.navGeometry.centers[active];this.navLiftSpring.target=0;this.setData({navPressed:false,navHover:active});
    this.navHangUntil=quick===true&&!this.data.reduceMotion?Date.now()+220:0;this.navLiftSpring.target=this.navHangUntil?1:0;
    const release=physical(this.navScaleSpring.value,304.61742,20.943951);release.velocity=this.navScaleSpring.velocity;release.target=1;this.navScaleSpring=release;
    this.navStretchSpring.response=release.response;this.navStretchSpring.damping=release.damping;this.navStretchSpring.target=0;
    if(this.data.reduceMotion){this.navPosition.value=this.navPosition.target;this.navPosition.velocity=0;this.navLiftSpring.value=0;this.navScaleSpring.value=1;this.navScaleSpring.velocity=0;this.navStretchSpring.value=this.navStretchSpring.velocity=0;this.stopGlassNav();this.presentGlassNav();}else this.animateGlassNav();
  },
  onGlassNavTap(event){const instant=event.detail?.keyboard===true;if(!this.navGeometry||!instant&&Date.now()<(this.navTapUntil||0))return;const index=Number(event.currentTarget.dataset.index);if(!Number.isInteger(index)||index<0||index>=this.navGeometry.centers.length)return;this.activateGlassTab(index,{instant});},
  activateGlassTab(index,options={}){
    if(this.glassNavBlocked?.()||this.data.clockoutPanel||this.data.listPanel||this.data.detailMounted||this.data.operationPanel||this.data.imageViewer||this.data.reportPanel||this.data.actionBusy||this.data.workspaceTaskModal||this.data.workspaceTaskBusy||this.navNavigating)return;
    if(index===(this.data.navActiveIndex||0))return;
    if(typeof this.switchGlassNavTab==='function'){
      if(this.switchGlassNavTab(index,options)===false)return;
      this.setData({navActiveIndex:index,navHover:index});this.navPosition.target=this.navGeometry.centers[index];
      if(this.data.reduceMotion||options.instant){this.navPosition.value=this.navPosition.target;this.navPosition.velocity=0;}
      this.presentGlassNav();if(!options.instant)this.animateGlassNav();return;
    }
    if(index===0||index===1||index===3&&typeof this.switchWorkspaceTab==='function'){
      if(typeof this.switchWorkspaceTab==='function'){
        if(this.switchWorkspaceTab(index,options)===false)return;
        this.setData({navActiveIndex:index,navHover:index});this.navPosition.target=this.navGeometry.centers[index];
        if(this.data.reduceMotion||options.instant){this.navPosition.value=this.navPosition.target;this.navPosition.velocity=0;}
        this.presentGlassNav();this.animateGlassNav();return;
      }
      this.navNavigating=true;
      wx.redirectTo({url:index===1?'/workspace/pages/tasks/tasks':'/workspace/pages/orders/orders',fail:()=>{this.navNavigating=false;wx.showToast({title:'页面打开失败，请重试',icon:'none'});}});
    }else if(index===2&&typeof this.openClockout==='function')this.openClockout(options);
    else this.pendingReference();
  },
};
module.exports={geometry,spring,step,data,methods};
