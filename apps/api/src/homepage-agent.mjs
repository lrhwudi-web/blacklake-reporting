import { createHmac } from "node:crypto";
import { AppError, assert } from "./errors.mjs";
import { safeEqualText } from "./crypto.mjs";
import { AgentStore } from "./agent-store.mjs";
import { createProductionTools } from "./agent-tools.mjs";
import { createAgentRunner } from "./agent-runtime.mjs";

// Authentication is checked by app.mjs before this handler. The proxy must forward
// the authenticated session cookie; a shared proxy secret alone is not an owner.
export function agentOwner(req, config) {
  const key = String(req.headers["x-admin-key"] || "");
  let identity;
  if (key && safeEqualText(key, config.adminApiKey)) identity = `maintenance:${key}`;
  else {
    const cookie = String(req.headers.cookie || "");
    assert(cookie.length > 0 && cookie.length <= 8192, 401, "AGENT_SESSION_REQUIRED", "请重新登录后使用对话。");
    identity = `session:${cookie.split(";").map((part) => part.trim()).filter(Boolean).sort().join(";")}`;
  }
  return createHmac("sha256", config.sessionSecret).update(`homepage-agent:${identity}`).digest("hex");
}

function sameOrigin(req) {
  assert(req.headers["sec-fetch-site"] !== "cross-site", 403, "AGENT_ORIGIN_REJECTED", "请从管理后台发起对话。");
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { /* checked below */ }
    assert(origin && origin.host === req.headers.host, 403, "AGENT_ORIGIN_REJECTED", "请从管理后台发起对话。");
  }
}

function safeSource(value) {
  if (!value || !/^\/admin(?:\?|\/|$)/.test(value.url || "") || /[\u0000-\u001f\u007f\\]/.test(value.url)) return null;
  return {
    title: String(value.title || "查询来源").slice(0, 120), url: value.url.slice(0, 500),
    scope: String(value.scope || "").slice(0, 600), queriedAt: String(value.queriedAt || "").slice(0, 40),
    completeness: String(value.completeness || "").slice(0, 160),
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 10).map((warning) => String(warning).slice(0, 500)) : []
  };
}

function nextOrAbort(iterator, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => iterator.next()).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createHomepageAgent({ config, store, blacklake, adminSync, runner, weeklyStore }) {
  const settings = config.agent || { enabled: false };
  const conversations = store.db ? new AgentStore(store.db) : null;
  const run = runner || (settings.apiKey ? createAgentRunner({ config: settings,
    tools: createProductionTools({ blacklake, store, adminSync, weeklyStore }) }) : null);
  const activeOwners = new Set();
  const recentRequests = new Map();
  const configured = Boolean(settings.apiKey && settings.model && run);
  const status = () => ({ enabled: Boolean(settings.enabled), configured, model: settings.model || "",
    reason: !settings.enabled ? "生产助手暂未开放。" : !configured ? "生产助手尚未连接模型，请联系管理员。" : "" });

  return async function handle(req, res, url, { jsonBody, send }) {
    if (req.method === "GET" && url.pathname === "/v1/admin/agent/status") return send(res, 200, status());
    const owner = agentOwner(req, config);
    assert(conversations, 503, "AGENT_STORAGE_UNAVAILABLE", "对话存储暂时不可用。");
    if (req.method === "GET" && url.pathname === "/v1/admin/agent/conversations") {
      return send(res, 200, { conversations: conversations.list(owner) });
    }
    const detail = url.pathname.match(/^\/v1\/admin\/agent\/conversations\/([a-f0-9-]{36})$/i);
    if (req.method === "GET" && detail) {
      const conversation = conversations.get(owner, detail[1]);
      assert(conversation, 404, "AGENT_CONVERSATION_NOT_FOUND", "未找到这段对话。");
      return send(res, 200, conversation);
    }
    if (req.method !== "POST" || url.pathname !== "/v1/admin/agent/chat") throw new AppError(404, "NOT_FOUND", "接口不存在。");
    sameOrigin(req);
    assert(settings.enabled && configured, 503, "AGENT_NOT_CONFIGURED", status().reason);
    assert(!activeOwners.has(owner) && activeOwners.size < 8, 429, "AGENT_BUSY", "已有对话正在处理，请稍后重试。");
    const input = await jsonBody(req);
    assert(input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every((key) => ["message", "conversationId"].includes(key)),
      400, "AGENT_INVALID_INPUT", "请提交问题与会话编号。");
    assert(typeof input.message === "string" && input.message.trim().length > 0 && input.message.length <= 4000,
      400, "AGENT_INVALID_MESSAGE", "问题请控制在 1–4000 字以内。");
    assert(input.conversationId == null || (typeof input.conversationId === "string" && /^[a-f0-9-]{36}$/i.test(input.conversationId)),
      400, "AGENT_INVALID_CONVERSATION", "会话编号不正确。");
    // Check again after asynchronously reading the request body.
    assert(!activeOwners.has(owner) && activeOwners.size < 8, 429, "AGENT_BUSY", "已有对话正在处理，请稍后重试。");
    const now = Date.now();
    for (const [key, entry] of recentRequests) if (entry.until <= now) recentRequests.delete(key);
    const rate = recentRequests.get(owner) || { count: 0, until: now + 60000 };
    assert(rate.count < 12 && recentRequests.size < 2000, 429, "AGENT_RATE_LIMIT", "提问过于频繁，请稍后再试。");
    recentRequests.set(owner, { ...rate, count: rate.count + 1 });
    const turn = conversations.beginTurn(owner, input.conversationId, input.message.trim());
    activeOwners.add(owner);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutMs);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnected);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.flushHeaders();
    const emit = (event) => {
      if (res.destroyed || res.writableEnded) return;
      // Bound buffering even if a client stops consuming the streaming response.
      if (res.writableLength > 256 * 1024) { controller.abort(); return; }
      res.write(`${JSON.stringify(event)}\n`);
    };
    const heartbeat = setInterval(() => emit({ type: "ping" }), 10000);
    let content = "";
    let outcome = "complete";
    let usage = {};
    let finished = false;
    const sources = [];
    const toolCalls = [];
    const startedAt = Date.now();
    let iterator;
    emit({ type: "start", conversationId: turn.conversationId, messageId: turn.assistantId });
    try {
      iterator = run({ messages: turn.history, signal: controller.signal })[Symbol.asyncIterator]();
      while (true) {
        const next = await nextOrAbort(iterator, controller.signal);
        if (next.done) break;
        const event = next.value;
        controller.signal.throwIfAborted();
        if (event.type === "delta") {
          const text = String(event.text || "");
          if (content.length + text.length > 16000) { outcome = "interrupted"; controller.abort(); break; }
          content += text;
          emit({ type: "delta", text });
        } else if (event.type === "source") {
          const source = safeSource(event.source);
          if (source && sources.length < 24 && !sources.some((item) => JSON.stringify(item) === JSON.stringify(source))) {
            sources.push(source); emit({ type: "source", source });
          }
        } else if (event.type === "tool") {
          const entry = { type: "tool", toolName: String(event.toolName).slice(0, 80),
            toolCallId: String(event.toolCallId || "").slice(0, 120), status: event.status === "running" ? "running" : "complete",
            failed: Boolean(event.failed), durationMs: event.durationMs };
          if (toolCalls.length < 48) toolCalls.push(entry);
          emit(entry);
        } else if (event.type === "usage") {
          usage = event.usage || {};
          finished = true;
          if (event.finishReason !== "stop") outcome = "interrupted";
        }
      }
      if (!finished || !content.trim()) outcome = "interrupted";
    } catch (error) {
      outcome = controller.signal.aborted ? "interrupted" : "error";
      emit({ type: "error", code: timedOut ? "AGENT_TIMEOUT" : outcome === "interrupted" ? "AGENT_INTERRUPTED" : "AGENT_MODEL_FAILED",
        message: timedOut ? "查询超时，已保留当前内容。请缩小范围后重试。" : outcome === "interrupted" ? "本次回答已停止。" : "模型服务暂时不可用，请稍后重试。" });
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); res.off("close", disconnected);
      activeOwners.delete(owner);
      // Do not wait for a stuck provider's iterator to acknowledge cancellation.
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
      const safeUsage = Object.fromEntries(["inputTokens", "outputTokens", "totalTokens"].filter((key) => Number.isFinite(usage[key])).map((key) => [key, usage[key]]));
      try {
        conversations.finishTurn(owner, turn.conversationId, turn.assistantId, { content, status: outcome, sources, usage: safeUsage, toolCalls });
      } catch {
        outcome = "error";
        // No exception bodies: database/provider errors can contain private input.
        console.error(JSON.stringify({ event: "agent_history_save_failed" }));
        emit({ type: "error", code: "AGENT_SAVE_FAILED", message: "本次回答未能保存，请稍后重试。" });
      }
      emit({ type: "done", status: outcome, usage: safeUsage, durationMs: Date.now() - startedAt });
      res.end();
    }
  };
}
