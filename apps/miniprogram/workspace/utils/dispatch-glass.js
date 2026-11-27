const data={selectedPanelMounted:false,selectedPanelHeight:220,selectedPanelOrigin:'30px 100%',peopleMenu:null,peopleMenuOpen:false};
const methods={
  setupDispatchGlass(){this.dispatchGlassDisposed=false;this.setData({reduceMotion:getApp().globalData.reduceMotion===true});this.dispatchGlassResize=()=>{const info=wx.getWindowInfo?.()||{};const size=info.windowWidth+'x'+info.windowHeight;if(this.dispatchGlassSize&&size!==this.dispatchGlassSize)this.resetDispatchGlass();this.dispatchGlassSize=size;};this.dispatchGlassResize();wx.onWindowResize?.(this.dispatchGlassResize);},
  disposeDispatchGlass(){this.dispatchGlassDisposed=true;this.selectedPanelRevision=(this.selectedPanelRevision||0)+1;this.peopleMenuRevision=(this.peopleMenuRevision||0)+1;clearTimeout(this.selectedEnterTimer);clearTimeout(this.selectedCloseTimer);clearTimeout(this.peopleMenuTimer);clearTimeout(this.peopleMenuCloseTimer);wx.offWindowResize?.(this.dispatchGlassResize);},
  resetDispatchGlass(){this.selectedPanelRevision=(this.selectedPanelRevision||0)+1;this.peopleMenuRevision=(this.peopleMenuRevision||0)+1;clearTimeout(this.selectedEnterTimer);clearTimeout(this.selectedCloseTimer);clearTimeout(this.peopleMenuTimer);clearTimeout(this.peopleMenuCloseTimer);this.setData({selectedPanelMounted:false,selectedPanelOpen:false,peopleMenu:null,peopleMenuOpen:false});},
  syncSelectedPanel(){if(!this.data.selectedPanelMounted)return;const info=wx.getWindowInfo?.()||wx.getSystemInfoSync?.()||{};const max=Math.floor((info.windowHeight||740)*.6);this.setData({selectedPanelHeight:Math.min(220+Math.max(0,this.data.selectedEmployeeIds.length-1)*48,max)});},
  openSelectedPeople(){
    if(this.data.stage!=='people'||this.data.submitting)return;
    this.closePeopleMenu();const revision=this.selectedPanelRevision=(this.selectedPanelRevision||0)+1;clearTimeout(this.selectedCloseTimer);clearTimeout(this.selectedEnterTimer);
    const reversing=this.data.selectedPanelMounted;this.setData({selectedPanelMounted:true,selectedPanelOpen:reversing});this.syncSelectedPanel();
    const q=wx.createSelectorQuery?.();q?.select('.people-selection-count').boundingClientRect().exec(rects=>{if(revision!==this.selectedPanelRevision||this.dispatchGlassDisposed)return;const rect=rects?.[0];if(rect)this.setData({selectedPanelOrigin:Math.max(20,rect.left+rect.width/2-12)+'px 100%'});});
    if(!reversing)this.selectedEnterTimer=setTimeout(()=>{if(revision===this.selectedPanelRevision&&!this.dispatchGlassDisposed)this.setData({selectedPanelOpen:true});},16);
  },
  closeSelectedPeople(){clearTimeout(this.selectedEnterTimer);clearTimeout(this.selectedCloseTimer);this.selectedPanelRevision=(this.selectedPanelRevision||0)+1;const revision=this.selectedPanelRevision;this.setData({selectedPanelOpen:false});this.selectedCloseTimer=setTimeout(()=>{if(revision===this.selectedPanelRevision&&!this.dispatchGlassDisposed)this.setData({selectedPanelMounted:false});},this.data.reduceMotion?100:180);},
  openPeopleMenu(){
    if(this.data.submitting)return;if(this.data.peopleMenuOpen)return this.closePeopleMenu();
    const revision=this.peopleMenuRevision=(this.peopleMenuRevision||0)+1;clearTimeout(this.peopleMenuCloseTimer);clearTimeout(this.peopleMenuTimer);
    const q=wx.createSelectorQuery?.();if(!q)return;
    q.select('.people-menu').boundingClientRect().exec(rects=>{
      if(revision!==this.peopleMenuRevision||this.dispatchGlassDisposed)return;const rect=rects?.[0],info=wx.getWindowInfo?.()||{};
      if(!rect||!['left','top','width','height'].every(key=>Number.isFinite(rect[key]))||rect.width<=0||rect.height<=0)return;
      const width=188,height=110,w=info.windowWidth||390,h=info.windowHeight||740;
      const x=Math.max(12,Math.min(w-width-12,rect.left+rect.width-width)),y=rect.top+rect.height+height+12<h?rect.top+rect.height+8:Math.max(12,rect.top-height-8);
      this.setData({peopleMenu:{x,y,width,originX:rect.left+rect.width/2-x,originY:rect.top+rect.height/2-y,arrowX:Math.max(15,Math.min(width-20,rect.left+rect.width/2-x)),below:y>rect.top},peopleMenuOpen:false});
      this.peopleMenuTimer=setTimeout(()=>{if(revision===this.peopleMenuRevision&&!this.dispatchGlassDisposed)this.setData({peopleMenuOpen:true});},16);
    });
  },
  closePeopleMenu(){this.peopleMenuRevision=(this.peopleMenuRevision||0)+1;const revision=this.peopleMenuRevision;clearTimeout(this.peopleMenuTimer);clearTimeout(this.peopleMenuCloseTimer);if(!this.data.peopleMenu)return;this.setData({peopleMenuOpen:false});this.peopleMenuCloseTimer=setTimeout(()=>{if(revision===this.peopleMenuRevision&&!this.dispatchGlassDisposed)this.setData({peopleMenu:null});},this.data.reduceMotion?100:150);},
  choosePeopleMenu(event){const key=event.currentTarget.dataset.key;if(!this.data.peopleMenuOpen||!['orders','history'].includes(key))return;this.resetDispatchGlass();if(key==='orders')this.returnToOrders();else this.openHistory();},
  stopGlassBubble(){}
};
module.exports={data,methods};
