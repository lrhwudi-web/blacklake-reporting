const layerBack=require('../../utils/layer-back');
// New card-to-detail material transition. No floating ball, drag or position storage.
const body = require('./body-controller');
const geometry = require('../../utils/liquid-geometry');
const { data: bodyData, onLoad, onUnload, ...bodyMethods } = body;
Component(layerBack.component({
  properties: { visible: Boolean, origin: Object, orderId: String, processId: String, reduceMotion: Boolean },
  data: { ...JSON.parse(JSON.stringify(bodyData)), liquidActive: false, liquidOpen: false,
    panelX: 12, panelY: 12, panelWidth: 366, panelHeight: 716,
    closedTransform: '', openTransform: 'translate3d(0,0,0) scale(1,1)', closedRadius: '16px' },
  observers: {
    visible(value) { if (this.layerAttached) value ? this.reveal() : this.conceal(); }
  },
  lifetimes: {
    attached() {
      this.layerAttached = true;
      this.resizeHandler = () => this.fit();
      if (typeof wx.onWindowResize === 'function') wx.onWindowResize(this.resizeHandler);
      if (this.properties.visible) this.reveal();
    },
    detached() {
      this.layerAttached = false; clearTimeout(this.mountTimer); clearTimeout(this.closeTimer);
      onUnload.call(this);
      if (typeof wx.offWindowResize === 'function') wx.offWindowResize(this.resizeHandler);
    }
  },
  pageLifetimes:{show(){if(this.data.ready&&this.layerAttached)this.loadExecution();this.resumeProcessReportPolling();},hide(){this.pauseProcessReportPolling();}},
  methods: {
    ...bodyMethods,
    fit() {
      this.onResize();
      const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.setData(geometry.layout(this.properties.origin, info.windowWidth, info.windowHeight));
    },
    reveal() {
      clearTimeout(this.closeTimer);
      if (this.data.liquidActive) { this.setData({ liquidOpen: true }); return; }
      this.fit(); this.unloaded = false;
      this.setData({ liquidActive: true, liquidOpen: false }, () => {
        if (!this.layerAttached || !this.properties.visible) return;
        this.mountTimer = setTimeout(() => {
          if (this.layerAttached && this.properties.visible) this.setData({ liquidOpen: true });
        }, 16);
      });
      this._loadPromise = onLoad.call(this, { projectId: this.properties.orderId, processId:this.properties.processId });
    },
    conceal() {
      this.initialProcessId='';
      this.filterRevision=(this.filterRevision||0)+1;
      this.resetGlassSegments?.();
      this.resetProductPreview?.();
      this.resetProcessDetail();this.closeProcessSwipe();
      this.resetProcessManagement();
      this.resetReportDateTime();
      this.resetReportPeople();
      clearTimeout(this.mountTimer); clearTimeout(this.closeTimer);
      this.setData({ liquidOpen: false });
      this.closeTimer = setTimeout(() => {
        if (!this.layerAttached || this.properties.visible) return;
        this.setData({ liquidActive: false }); this.triggerEvent('closed');
      }, this.properties.reduceMotion ? 100 : geometry.DURATION);
    },
    returnToOrders() { this.triggerEvent('requestclose'); },
    maskTap() { this.triggerEvent(this.data.liquidOpen ? 'requestclose' : 'requestopen'); },
    stopBubble() {}
  }
},'liquid-detail'));
