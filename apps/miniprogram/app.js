App({
  globalData: {
    // 真机调试：手机和电脑需连接同一 Wi-Fi。电脑 IP 变化后需要同步更新这里。
    apiBaseUrl: "https://bh.kairaygolf.com",
    sessionToken: "",
    operator: null,
    entry: null,
    reviewMode: false
    ,dataMode: 'live'
  },

  onLaunch() {
    this.globalData.sessionToken = wx.getStorageSync("sessionToken") || "";
    this.globalData.operator = wx.getStorageSync("operator") || null;
    this.globalData.entry = wx.getStorageSync("entry") || null;
    this.globalData.reviewMode = Boolean(wx.getStorageSync("reviewMode"));
  },

  setSession({ token, operator, entry = null, reviewMode = false }) {
    this.globalData.sessionToken = token;
    this.globalData.operator = operator;
    this.globalData.entry = entry;
    this.globalData.reviewMode = Boolean(reviewMode);
    wx.setStorageSync("sessionToken", token);
    wx.setStorageSync("operator", operator);
    wx.setStorageSync("entry", entry);
    wx.setStorageSync("reviewMode", Boolean(reviewMode));
  },

  clearSession() {
    this.globalData.sessionToken = "";
    this.globalData.operator = null;
    this.globalData.entry = null;
    this.globalData.reviewMode = false;
    wx.removeStorageSync("sessionToken");
    wx.removeStorageSync("operator");
    wx.removeStorageSync("entry");
    wx.removeStorageSync("reviewMode");
  },

  homeUrl(entry = this.globalData.entry) {
    if(!this.globalData.reviewMode&&entry?.appRole==='floor8_leader')return '/workspace/pages/orders/orders';
    if(!this.globalData.reviewMode&&entry?.appRole==='employee'&&this.globalData.operator?.defaultReportingMode==='embroidery')return '/workspace/pages/worker/worker?mode=embroidery';
    if(!this.globalData.reviewMode&&entry?.appRole==='employee'&&!String(entry.workUnitId||'').startsWith('3F-')&&this.globalData.operator?.defaultReportingMode==='standard')return '/workspace/pages/worker/worker';
    return entry && entry.entryView !== "employee-reporting"
      ? "/pages/dispatch/dispatch"
      : "/pages/report/report";
  }
});
