const { request } = require("../../utils/api");
const app = getApp();

Page({
  data: {
    stage: "loading",
    bindingToken: "",
    allOperators: [],
    operators: [],
    search: "",
    selectedOperator: null,
    selectedOperatorInitial: "",
    confirmationCode: "",
    reviewAvailable: false,
    reviewCode: "",
    submitting: false,
    errorMessage: ""
  },

  onLoad() {
    if (app.globalData.sessionToken) return wx.reLaunch({ url: app.homeUrl() });
    this.startWechatLogin();
  },

  async startWechatLogin() {
    if (this.data.submitting) return;
    this.setData({ stage: "loading", submitting: true, errorMessage: "" });
    try {
      const code = await this.wechatLoginCode();
      const result = await request("/v1/auth/wechat", {
        method: "POST",
        data: { code }
      });
      if (result.status === "BOUND") {
        app.setSession(result);
        return wx.reLaunch({ url: app.homeUrl(result.entry) });
      }
      const choices = await request("/v1/auth/operators", {
        method: "POST",
        data: { bindingToken: result.bindingToken },
        showLoading: true
      });
      this.setData({
        stage: "choose",
        bindingToken: result.bindingToken,
        reviewAvailable: Boolean(result.reviewAvailable),
        allOperators: choices.operators,
        operators: choices.operators,
        submitting: false
      });
    } catch (error) {
      this.setData({
        stage: "error",
        errorMessage: error.message,
        submitting: false
      });
    }
  },

  wechatLoginCode() {
    return new Promise((resolve, reject) => {
      wx.login({
        timeout: 10000,
        success: (result) => result.code
          ? resolve(result.code)
          : reject(new Error("微信身份识别失败，请重试。")),
        fail: () => reject(new Error("微信身份识别失败，请检查网络后重试。"))
      });
    });
  },

  onSearchInput(event) {
    const search = String(event.detail.value || "").trim().toLocaleLowerCase("zh-CN");
    const operators = this.data.allOperators.filter((operator) =>
      `${operator.name} ${operator.description || ""}`.toLocaleLowerCase("zh-CN").includes(search)
    );
    this.setData({ search: event.detail.value, operators });
  },

  chooseOperator(event) {
    const blacklakeOperatorId = Number(event.currentTarget.dataset.operatorId);
    const selectedOperator = this.data.allOperators.find((operator) =>
      operator.blacklakeOperatorId === blacklakeOperatorId
    );
    if (!selectedOperator) return;
    this.setData({
      stage: "confirm",
      selectedOperator,
      selectedOperatorInitial: selectedOperator.name.slice(0, 1),
      confirmationCode: ""
    });
  },

  onConfirmationCodeInput(event) {
    this.setData({
      confirmationCode: String(event.detail.value || "").replace(/\D/g, "").slice(0, 6)
    });
  },

  backToChoose() {
    this.setData({
      stage: "choose",
      selectedOperator: null,
      selectedOperatorInitial: "",
      confirmationCode: ""
    });
  },

  openReview() {
    this.setData({ stage: "review", reviewCode: "" });
  },

  onReviewCodeInput(event) {
    this.setData({ reviewCode: String(event.detail.value || "").trim().slice(0, 64) });
  },

  async loginReview() {
    if (this.data.submitting) return;
    if (this.data.reviewCode.length < 8) {
      return wx.showToast({ title: "请输入审核码", icon: "none" });
    }
    this.setData({ submitting: true });
    try {
      const session = await request("/v1/auth/review", {
        method: "POST",
        data: {
          bindingToken: this.data.bindingToken,
          accessCode: this.data.reviewCode
        },
        showLoading: true
      });
      app.setSession(session);
      wx.reLaunch({ url: app.homeUrl(session.entry) });
    } catch (error) {
      wx.showModal({
        title: "审核登录未成功",
        content: error.message,
        showCancel: false,
        confirmText: "知道了"
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async bindWechat() {
    if (this.data.submitting || !this.data.selectedOperator) return;
    if (!/^\d{6}$/.test(this.data.confirmationCode)) {
      return wx.showToast({ title: "请输入6位确认码", icon: "none" });
    }
    this.setData({ submitting: true });
    try {
      const session = await request("/v1/auth/bind", {
        method: "POST",
        data: {
          bindingToken: this.data.bindingToken,
          blacklakeOperatorId: this.data.selectedOperator.blacklakeOperatorId,
          confirmationCode: this.data.confirmationCode
        },
        showLoading: true
      });
      app.setSession(session);
      wx.reLaunch({ url: app.homeUrl(session.entry) });
    } catch (error) {
      wx.showModal({
        title: "确认没有成功",
        content: error.message,
        showCancel: false,
        confirmText: "知道了"
      });
    } finally {
      this.setData({ submitting: false });
    }
  }
});
