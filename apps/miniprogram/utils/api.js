const app = getApp();

function request(path, { method = "GET", data, idempotencyKey, showLoading = false, timeout = 15000 } = {}) {
  if (showLoading) wx.showLoading({ title: "请稍候", mask: true });
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${app.globalData.apiBaseUrl}${path}`,
      method,
      data,
      timeout,
      header: {
        "Content-Type": "application/json",
        ...(app.globalData.sessionToken ? { Authorization: `Bearer ${app.globalData.sessionToken}` } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response.data);
        const error = response.data?.error || {};
        if (response.statusCode === 401) {
          app.clearSession();
          wx.reLaunch({ url: "/pages/login/login" });
        }
        reject(Object.assign(new Error(error.message || "操作失败，请稍后再试。"), { code: error.code, status: response.statusCode }));
      },
      fail(error) {
        const timedOut = /time\s*out|timed\s+out/i.test(String(error?.errMsg || ""));
        const read = ["GET", "HEAD"].includes(method.toUpperCase());
        const message = (timedOut ? "请求后台超时" : "连接后台失败") + (read ? "，请稍后重试。" : "，请先刷新确认结果。");
        reject(Object.assign(new Error(message), { code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", cause: error }));
      },
      complete() {
        if (showLoading) wx.hideLoading();
      }
    });
  });
}

module.exports = { request };
