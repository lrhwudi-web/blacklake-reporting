const {request}=require('../../utils/api');
const geometry=require('./model');

Component({
  properties:{visible:Boolean,ownerKey:String,scope:String,flowCode:String,workOrder:Object,processes:Array,reduceMotion:Boolean},
  data:{position:{x:12,y:400},box:{minX:8,maxX:300,minY:212,maxY:400},layoutReady:false,expanded:false,modalActive:false,
    pressed:false,dragging:false,savedNotice:'',loading:false,error:'',detail:{},imageFailed:false,
    panelX:12,panelY:12,panelWidth:344,panelHeight:500,closedTransform:'',openTransform:''},
  observers:{
    'visible,ownerKey,scope,flowCode'(visible) {
      if(!this.orbAttached)return;
      this.resetInteraction();
      if(visible){this.measure();this.loadDetails();}
    }
  },
  lifetimes:{
    attached(){
      this.orbAttached=true;
      this.resizeHandler=()=>{if(this.properties.visible)this.measure(true);};
      if(typeof wx.onWindowResize==='function')wx.onWindowResize(this.resizeHandler);
      if(this.properties.visible){this.measure();this.loadDetails();}
    },
    detached(){
      this.orbAttached=false;this.resetInteraction();
      if(typeof wx.offWindowResize==='function')wx.offWindowResize(this.resizeHandler);
    }
  },
  pageLifetimes:{hide(){this.resetInteraction();},show(){if(this.properties.visible){this.measure();this.loadDetails();}}},
  methods:{
    resetInteraction(){
      this.detailRevision=(this.detailRevision||0)+1;
      this.gestureSuppressed=false;
      clearTimeout(this.closeTimer);clearTimeout(this.noticeTimer);clearTimeout(this.suppressTimer);
      if(this.orbAttached){this.setData({expanded:false,modalActive:false,dragging:false,pressed:false,loading:false,savedNotice:''});this.triggerEvent('modalchange',{open:false});}
    },
    measure(keepPosition=false){
      const info=typeof wx.getWindowInfo==='function'?wx.getWindowInfo():wx.getSystemInfoSync();
      const apply=rects=>{
        if(!this.orbAttached||!this.properties.visible)return;
        const box=geometry.bounds(info.windowWidth||375,info.windowHeight||667,rects?.[0]?.bottom,rects?.[1]?.top);
        const key=geometry.storageKey(this.properties.scope,this.properties.ownerKey);
        let saved;try{saved=key?wx.getStorageSync(key):null;}catch{}
        if(keepPosition&&this.lastBox)saved=geometry.remember(this.data.position,this.lastBox);
        if(keepPosition&&this.data.dragging)this.setData({dragging:false,pressed:false});
        this.lastBox=box;
        this.place(geometry.restore(saved,box),box);
      };
      if(typeof wx.createSelectorQuery==='function')wx.createSelectorQuery().select('.people-search-wrap').boundingClientRect().select('.people-selection-dock').boundingClientRect().exec(apply);
      else apply();
    },
    place(position,box=this.data.box){
      const p=geometry.point(position,box),panel=geometry.panel(p,box);
      this.setData({position:p,box,layoutReady:true,panelX:panel.x,panelY:panel.y,panelWidth:panel.width,panelHeight:panel.height,
        closedTransform:panel.closedTransform,openTransform:panel.openTransform});
    },
    async loadDetails(){
      const order=this.properties.workOrder,flowCode=this.properties.flowCode;
      if(!this.orbAttached||!this.properties.visible||!order?.projectId||!flowCode)return;
      const revision=this.detailRevision=(this.detailRevision||0)+1;
      const identity=this.properties.ownerKey,scope=this.properties.scope;
      const fallback={...order};
      this.setData({loading:true,error:'',imageFailed:false,detail:geometry.model({processOverview:this.properties.processes||[]},fallback)});
      try {
        const result=await request('/v1/dispatch/work-order/detail',{method:'POST',data:{flowCode}});
        if(!this.orbAttached||!this.properties.visible||revision!==this.detailRevision||identity!==this.properties.ownerKey||scope!==this.properties.scope)return;
        if(result.workOrder?.projectId!==order.projectId||result.workOrder.projectCode!==order.projectCode)throw Error('工单资料不一致，请重新扫描核对');
        this.setData({detail:geometry.model(result,fallback),error:result.metadataStatus==='unavailable'?'工单资料暂未读取完整，可稍后重试':''});
      }catch(error){
        if(this.orbAttached&&this.properties.visible&&revision===this.detailRevision)this.setData({error:error.status===404?'工单详情暂未就绪，可继续选人或稍后重试':error.message||'工单资料读取失败，请重试'});
      }finally{
        if(this.orbAttached&&revision===this.detailRevision)this.setData({loading:false});
      }
    },
    onOrbPress(){if(!this.data.expanded){this.gestureSuppressed=false;this.setData({pressed:true});}},
    onOrbRelease(){if(this.orbAttached)this.setData({pressed:false});},
    onOrbDragStart(){
      if(!this.properties.visible||this.data.modalActive)return;
      this.gestureSuppressed=true;this.setData({dragging:true,pressed:false,savedNotice:''});
      if(typeof wx.vibrateShort==='function')wx.vibrateShort({type:'light'});
    },
    onOrbDragEnd(position){
      if(!this.orbAttached||!this.properties.visible||!this.data.dragging)return;
      this.place(position);this.setData({dragging:false,pressed:false});
      const key=geometry.storageKey(this.properties.scope,this.properties.ownerKey);
      try{if(key){wx.setStorageSync(key,geometry.remember(this.data.position,this.data.box));this.setData({savedNotice:'已记住位置'});}else this.setData({savedNotice:'位置暂未保存'});}
      catch{this.setData({savedNotice:'位置暂未保存'});}
      this.suppressTimer=setTimeout(()=>{this.gestureSuppressed=false;},300);
      this.noticeTimer=setTimeout(()=>{if(this.orbAttached)this.setData({savedNotice:''});},1400);
    },
    onOrbGestureCancel(){this.gestureSuppressed=true;if(this.orbAttached){this.place(this.data.position);this.setData({dragging:false,pressed:false});}},
    toggle(){
      if(!this.properties.visible||this.data.dragging||this.gestureSuppressed)return;
      clearTimeout(this.closeTimer);
      if(this.data.expanded)return this.close();
      this.setData({expanded:true,modalActive:true,pressed:false,savedNotice:''});this.triggerEvent('modalchange',{open:true});
    },
    close(){
      this.setData({expanded:false,pressed:false});
      clearTimeout(this.closeTimer);
      this.closeTimer=setTimeout(()=>{if(this.orbAttached&&!this.data.expanded){this.setData({modalActive:false});this.triggerEvent('modalchange',{open:false});}},this.properties.reduceMotion?140:300);
    },
    onShellEnd(event){if(event?.detail?.propertyName&&event.detail.propertyName!=='transform')return;if(!this.data.expanded){this.setData({modalActive:false});this.triggerEvent('modalchange',{open:false});}},
    absorb(){},
    imageError(event){if(event.currentTarget.dataset.imageUrl===this.data.detail.imageUrl)this.setData({imageFailed:true});},
    previewImage(){
      const detail=this.data.detail;
      if(this.data.imageFailed||!detail.imageUrl)return;
      wx.previewImage({current:detail.imageUrl,urls:detail.productImageUrls,fail:()=>wx.showToast({title:'图片暂时无法预览',icon:'none'})});
    }
  }
});
