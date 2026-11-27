const navigation=require('./glass-navigation');
const methods={
  ...navigation.methods,
  setupWorkerNavigation(){this.setupGlassNav({items:this.data.workerTabs});this.syncWorkerNavigation(true);},
  syncWorkerNavigation(instant=false){
    if(!this.navGeometry||this.unloaded)return;
    instant=instant||!this.data.selfServiceEnabled;
    const index=this.data.workerTabs.findIndex(row=>row.key===this.data.workerTab);if(index<0)return;
    this.setData({navActiveIndex:index,navHover:index});this.navPosition.target=this.navGeometry.centers[index];
    if(instant||this.data.reduceMotion){
      this.stopGlassNav();this.navTouch=null;this.navHangUntil=0;this.navPosition.value=this.navPosition.target;this.navPosition.velocity=0;
      for(const [state,value]of [[this.navLiftSpring,0],[this.navScaleSpring,1],[this.navStretchSpring,0]])Object.assign(state,{value,target:value,velocity:0});
      this.setData({navPressed:false});
    }
    this.presentGlassNav();if(!instant&&!this.data.reduceMotion)this.animateGlassNav();
  },
  glassNavBlocked(){return !this.data.selfServiceEnabled||this.unloaded||this.data.busy||!!this.data.workerPanel||!!this.data.imageViewer||this.data.detailMounted||this.openingDetail||this.data.workerReportModal;},
  switchGlassNavTab(index,options={}){const tab=this.data.workerTabs[index];if(!tab||this.glassNavBlocked())return false;this.setWorkerTab({currentTarget:{dataset:{tab:tab.key}},detail:{keyboard:options.instant===true}});return this.data.workerTab===tab.key;}
};
module.exports={data:navigation.data,methods};
