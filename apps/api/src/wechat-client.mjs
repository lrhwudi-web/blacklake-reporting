import { AppError } from "./errors.mjs";
import { stableHash } from "./crypto.mjs";

export class WechatClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async exchangeCode(codeInput) {
    const code = String(codeInput || "").trim();
    if (!code || code.length > 256 || /[\u0000-\u001f\u007f]/.test(code)) {
      throw new AppError(400, "INVALID_WECHAT_CODE", "微信登录信息无效，请重新打开小程序。");
    }

    if (this.config.mock) return `mock-openid-${stableHash({ code }).slice(0, 32)}`;
    if (!this.config.appId || !this.config.appSecret) {
      throw new AppError(503, "WECHAT_NOT_CONFIGURED", "微信自动登录尚未配置，请联系管理员。");
    }

    const url = new URL(this.config.code2SessionUrl);
    url.searchParams.set("appid", this.config.appId);
    url.searchParams.set("secret", this.config.appSecret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");

    let response;
    try {
      response = await this.fetch(url, { signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch (error) {
      if (error?.name === "TimeoutError") {
        throw new AppError(504, "WECHAT_TIMEOUT", "微信登录响应较慢，请重试。");
      }
      throw new AppError(503, "WECHAT_UNAVAILABLE", "暂时无法连接微信登录，请稍后重试。");
    }
    let body;
    try { body = await response.json(); }
    catch { throw new AppError(502, "WECHAT_INVALID_RESPONSE", "微信登录返回异常，请联系管理员。"); }
    if (!response.ok || body.errcode) {
      throw new AppError(401, "WECHAT_LOGIN_FAILED", "微信身份识别失败，请重新打开小程序。");
    }
    const openId = String(body.openid || "").trim();
    if (!openId) throw new AppError(502, "WECHAT_OPENID_MISSING", "微信没有返回身份标识，请联系管理员。");
    return openId;
  }
}
