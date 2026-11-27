const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function layout(origin,width=390,height=740){
  const w=Number.isFinite(width)?Math.max(240,width):390,h=Number.isFinite(height)?Math.max(320,height):740;
  const panelWidth=Math.min(520,w-24),panelHeight=Math.min(760,h-48),panelX=(w-panelWidth)/2,panelY=(h-panelHeight)/2;
  const valid=origin&&['left','top','width','height'].every(key=>Number.isFinite(origin[key]))&&origin.width>0&&origin.height>0;
  const sx=valid?origin.width/panelWidth:.96,sy=valid?origin.height/panelHeight:.96;
  return {panelWidth,panelHeight,panelX,panelY,stageWidth:panelWidth-24,stageHeight:panelHeight-132,
    closedTransform:valid?`translate3d(${origin.left-panelX}px,${origin.top-panelY}px,0) scale(${sx},${sy})`:'translate3d(0,8px,0) scale(.96)',closedRadius:valid?`${12/sx}px / ${12/sy}px`:'28px'};
}
function limit(state,x,y,scale=state.scale){
  const fit=Math.min(state.stageWidth/(state.naturalWidth||1),state.stageHeight/(state.naturalHeight||1));
  const dx=Math.max(0,((state.naturalWidth||1)*fit*scale-state.stageWidth)/2),dy=Math.max(0,((state.naturalHeight||1)*fit*scale-state.stageHeight)/2);
  return {x:dx?clamp(x,-dx,dx):0,y:dy?clamp(y,-dy,dy):0};
}
const data={imageViewer:null};
const methods={
  openProductPreview(url,selector){
    if(typeof url!=='string'||!url||this.unloaded)return;
    const revision=this.photoRevision=(this.photoRevision||0)+1;clearTimeout(this.photoMountTimer);clearTimeout(this.photoCloseTimer);
    const show=origin=>{
      if(revision!==this.photoRevision||this.unloaded)return;
      const info=wx.getWindowInfo?.()||wx.getSystemInfoSync?.()||{};
      const reduced=this.data.reduceMotion===true||getApp().globalData.reduceMotion===true;
      const reversing=!!this.data.imageViewer;
      this.photoGesture=null;this.photoLastTap=null;
      this.setData({imageViewer:{url,anchorId:selector?.startsWith('#')?selector.slice(1):'',open:reversing,reduceMotion:reduced,scale:1,percent:100,x:0,y:0,naturalWidth:1,naturalHeight:1,failed:false,...layout(origin,info.windowWidth,info.windowHeight)}},()=>{
        if(!reversing)this.photoMountTimer=setTimeout(()=>{if(revision===this.photoRevision&&this.data.imageViewer)this.patchPhoto({open:true});},16);
      });
    };
    const q=typeof this.createSelectorQuery==='function'?this.createSelectorQuery():wx.createSelectorQuery?.();
    if(q&&selector){q.in?.(this);q.select(selector).boundingClientRect().exec(rects=>show(rects?.[0]));}else show(null);
  },
  patchPhoto(values){if(this.data.imageViewer)this.setData({imageViewer:{...this.data.imageViewer,...values}});},
  closeProductPreview(){
    const state=this.data.imageViewer;if(!state)return;
    this.photoRevision=(this.photoRevision||0)+1;const revision=this.photoRevision;clearTimeout(this.photoMountTimer);clearTimeout(this.photoCloseTimer);this.photoGesture=null;
    this.patchPhoto({open:false});this.photoCloseTimer=setTimeout(()=>{if(revision===this.photoRevision&&!this.data.imageViewer?.open)this.setData({imageViewer:null});},state.reduceMotion?100:180);
  },
  resetProductPreview(){this.disposeProductPreview();if(this.data.imageViewer)this.setData({imageViewer:null});},
  disposeProductPreview(){this.photoRevision=(this.photoRevision||0)+1;clearTimeout(this.photoMountTimer);clearTimeout(this.photoCloseTimer);this.photoGesture=null;this.photoLastTap=null;},
  photoLoaded(event){if(event.currentTarget?.dataset?.url&&event.currentTarget.dataset.url!==this.data.imageViewer?.url)return;const width=Number(event.detail.width),height=Number(event.detail.height);if(width>0&&height>0&&(width!==this.data.imageViewer?.naturalWidth||height!==this.data.imageViewer?.naturalHeight))this.patchPhoto({naturalWidth:width,naturalHeight:height});},
  photoError(event){if(event?.currentTarget?.dataset?.url&&event.currentTarget.dataset.url!==this.data.imageViewer?.url)return;this.patchPhoto({failed:true});},
  photoZoom(value){
    const state=this.data.imageViewer;if(!state||!state.open||state.failed)return;
    const scale=clamp(value,1,4),bounded=limit(state,state.x*scale/state.scale,state.y*scale/state.scale,scale);
    this.patchPhoto({scale,percent:Math.round(scale*100),...bounded});
  },
  photoZoomIn(){this.photoZoom((this.data.imageViewer?.scale||1)+.5);},
  photoZoomOut(){this.photoZoom((this.data.imageViewer?.scale||1)-.5);},
  photoReset(){this.patchPhoto({scale:1,percent:100,x:0,y:0});},
  photoTap(){const state=this.data.imageViewer;if(!state?.open||state.failed||this.photoMoved)return;const now=Date.now();if(this.photoLastTap&&now-this.photoLastTap<280){this.photoZoom(state.scale>1?1:2.5);this.photoLastTap=null;}else this.photoLastTap=now;},
  onPhotoTouchStart(event){
    const state=this.data.imageViewer;if(!state?.open||state.failed)return;
    const points=event.touches||[];this.photoMoved=false;
    this.photoGesture=points.length===2?{pinch:true,distance:Math.max(1,Math.hypot(points[1].clientX-points[0].clientX,points[1].clientY-points[0].clientY)),scale:state.scale}:points.length===1?{pinch:false,identifier:points[0].identifier,px:points[0].clientX,py:points[0].clientY,x:state.x,y:state.y}:null;
  },
  onPhotoTouchMove(event){
    const gesture=this.photoGesture,state=this.data.imageViewer,points=event.touches||[];if(!gesture||!state?.open)return;
    if(gesture.pinch&&points.length===2){this.photoMoved=true;const distance=Math.hypot(points[1].clientX-points[0].clientX,points[1].clientY-points[0].clientY);const scale=clamp(gesture.scale*distance/gesture.distance,1,4);this.patchPhoto({scale,percent:Math.round(scale*100),...limit(state,state.x,state.y,scale)});}
    else if(!gesture.pinch&&points.length===1&&points[0].identifier===gesture.identifier){const dx=points[0].clientX-gesture.px,dy=points[0].clientY-gesture.py;if(Math.abs(dx)+Math.abs(dy)>4)this.photoMoved=true;if(state.scale>1)this.patchPhoto(limit(state,gesture.x+dx,gesture.y+dy));}
    else this.onPhotoTouchStart(event);
  },
  onPhotoTouchEnd(event){this.photoGesture=null;if(event.touches?.length)this.onPhotoTouchStart(event);},
  photoStopBubble(){}
};
module.exports={layout,limit,data,methods};
