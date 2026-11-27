// Independent conversation state keeps background ledger refreshes away from the composer.
(() => {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const displayValue = (value) => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  // Reuse the official Tabler sprite shipped with the workspace.
  const icon = (name, extra = "") => `<svg class="agent-icon ${extra}" aria-hidden="true"><use href="#ledger-${name}"/></svg>`;
  const suggestions = [
    ["工单进展到哪了？", "汇总当前工单进度，并说明数据范围。", "汇总进度与当前工序", "file-text"],
    ["哪些报工需要关注？", "有哪些报工记录待核对？请列出相关工单和原因。", "查看待核对记录及原因", "info-circle"],
    ["看一下 8 楼生产现场", "查看 8 楼当前现场状态，并说明数据更新时间。", "了解工位与当前状态", "refresh"],
    ["帮我查一张工单", "查询工单 ", "输入编号，继续追问", "search"]
  ];
  const toolLabels = {
    searchWorkOrders: "查询工单", getWorkOrder: "读取工单详情", getWorkOrderDetail: "读取工单详情",
    getWorkOrderProgress: "读取工单进度", getProductionSnapshot: "查看生产现场", listNeedsReview: "查询待核对记录", explainProductionRules: "核对业务规则",
    getProductionOverview: "查看生产现场", getProductionStatus: "查看生产现场", getReviewRecords: "查询待核对记录",
    queryReports: "查询报工记录", summarizeProduction: "汇总生产数据", getBusinessRules: "核对业务规则"
  };
  const statusLabels = { interrupted: "回答已中断，已保留现有内容", error: "这次回答未完成", pending: "上次回答尚未完成" };
  function safeSourceUrl(value, origin) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, origin);
      return url.origin === origin && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
        ? `${url.pathname}${url.search}${url.hash}` : "";
    } catch { return ""; }
  }
  // Parse a small presentation subset; model text never supplies HTML or external links.
  function formatAnswer(value, origin) {
    const inline = (text) => {
      const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
      let html = "", offset = 0, match;
      while ((match = pattern.exec(text))) {
        html += escape(text.slice(offset, match.index));
        if (match[1] != null) html += `<code>${escape(match[1])}</code>`;
        else if (match[2] != null) html += `<strong>${escape(match[2])}</strong>`;
        else {
          const href = safeSourceUrl(match[4], origin);
          html += href ? `<a href="${escape(href)}" target="_blank" rel="noopener">${escape(match[3])}</a>` : escape(match[0]);
        }
        offset = pattern.lastIndex;
      }
      return html + escape(text.slice(offset));
    };
    const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
    const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    const tableAt = (index) => index + 1 < lines.length && lines[index].includes("|") && cells(lines[index + 1]).length > 1 && cells(lines[index + 1]).every((cell) => /^:?-{3,}:?$/.test(cell)) && cells(lines[index]).length === cells(lines[index + 1]).length;
    const listItem = (line) => /^\s*(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);
    const blocks = [];
    for (let index = 0; index < lines.length;) {
      if (!lines[index].trim()) { index++; continue; }
      if (tableAt(index)) {
        const header = cells(lines[index]); index += 2;
        const rows = [];
        while (index < lines.length && lines[index].trim() && lines[index].includes("|") && cells(lines[index]).length === header.length) rows.push(cells(lines[index++]));
        blocks.push(`<div class="agent-table-scroll" tabindex="0" aria-label="回答中的数据表，可横向滚动"><table><thead><tr>${header.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      const heading = /^#{1,6}\s+(.+)$/.exec(lines[index]);
      if (heading) { blocks.push(`<h3>${inline(heading[1])}</h3>`); index++; continue; }
      const firstItem = listItem(lines[index]);
      if (firstItem) {
        const ordered = !firstItem[1], tag = ordered ? "ol" : "ul", items = [];
        while (index < lines.length) {
          const item = listItem(lines[index]);
          if (!item || (!item[1]) !== ordered) break;
          items.push(`<li>${inline(item[2])}</li>`); index++;
        }
        blocks.push(`<${tag}>${items.join("")}</${tag}>`); continue;
      }
      const paragraph = [inline(lines[index++])];
      while (index < lines.length && lines[index].trim() && !tableAt(index) && !/^#{1,6}\s+/.test(lines[index]) && !listItem(lines[index])) paragraph.push(inline(lines[index++]));
      blocks.push(`<p>${paragraph.join("<br>")}</p>`);
    }
    return blocks.join("");
  }
  function timeLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "时间未提供" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  }
  async function consumeNdjson(response, onEvent, signal) {
    if (!response.body?.getReader) throw new Error("暂时无法读取回答，请稍后重试。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", finished = false;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    const line = (value) => {
      if (!value.trim() || finished) return;
      let event;
      try { event = JSON.parse(value); } catch { throw new Error("回答连接异常，已保留收到的内容。"); }
      if (!event || typeof event.type !== "string") throw new Error("回答连接异常，请重试。");
      onEvent(event);
      if (event.type === "done") finished = true;
    };
    try {
      while (!finished && !signal?.aborted) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > 2_000_000) throw new Error("回答内容过长，请缩小查询范围。");
        let boundary;
        while ((boundary = buffer.indexOf("\n")) !== -1) {
          line(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 1);
        }
        if (done) { line(buffer); break; }
      }
      if (signal?.aborted) throw new DOMException("已停止回答", "AbortError");
      if (!finished) throw new Error("连接已中断，已保留收到的内容。请重新提问。");
    } finally {
      signal?.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  function create({ fetchImpl = (...args) => fetch(...args), onUnauthorized = () => {} } = {}) {
    const state = { initialized: false, loading: false, available: null, conversations: [], conversationId: null, messages: [], draft: "", error: "", running: false, tools: [], controller: null, generation: 0, demo: false, historyOpen: false };
    let root = null;
    const get = (selector) => root?.querySelector(selector);
    const allowed = () => state.available?.enabled === true && state.available?.configured === true && !state.demo;
    async function request(path, options = {}) {
      const response = await fetchImpl(path, { ...options, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...options.headers } });
      if (!response.ok) {
        if (response.status === 401) onUnauthorized();
        let body = {};
        try { body = await response.json(); } catch { /* The gateway can return an HTML error. */ }
        const message = body.error?.message || (typeof body.error === "string" ? body.error : body.message);
        throw new Error(message || (response.status === 401 ? "登录已失效，请重新登录。" : "暂时无法连接助手，请稍后重试。"));
      }
      return response;
    }
    function sourcesHtml(sources) {
      if (!Array.isArray(sources) || !sources.length) return "";
      return `<section class="agent-sources" aria-label="回答的数据来源"><h3>${icon("file-text")}数据来源 <span>${sources.length} 项依据</span></h3>${sources.map((source) => {
        const href = safeSourceUrl(source.url, window.location.origin);
        const completeness = { complete: "查询范围完整", partial: "仅取得部分数据", snapshot: "当前快照", bounded: "限定范围", stale: "数据可能滞后", unknown: "完整性待确认" }[source.completeness] || displayValue(source.completeness) || "完整性未提供";
        const warnings = Array.isArray(source.warnings) ? source.warnings : source.warnings ? [source.warnings] : [];
        return `<div class="agent-source"><strong>${href ? `<a href="${escape(href)}" target="_blank" rel="noopener">${escape(source.title || "查看原始记录")} <span aria-hidden="true">↗</span></a>` : escape(source.title || "生产数据")}</strong><p>${escape(displayValue(source.scope) || "范围未提供")}</p><div><span>${escape(completeness)}</span><time>查询于 ${escape(timeLabel(source.queriedAt))}</time></div>${warnings.map((warning) => `<p class="agent-source-warning">${escape(displayValue(warning))}</p>`).join("")}</div>`;
      }).join("")}</section>`;
    }
    function render() {
      if (!root) return;
      root.dataset.empty = String(state.messages.length === 0);
      get(".agent-history").hidden = !state.historyOpen;
      get('[data-agent-action="history"]').setAttribute("aria-expanded", String(state.historyOpen));
      get(".agent-onboarding").hidden = state.messages.length > 0;
      const scroller = get(".agent-scroll");
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
      const oldScroll = scroller.scrollTop;
      get(".agent-availability").textContent = state.demo ? "演示模式" : state.available ? allowed() ? "已就绪" : "暂不可用" : "正在连接";
      get(".agent-availability").dataset.ready = String(allowed());
      const unavailable = state.demo ? "演示页面不查询正式生产数据。登录后可使用工作助手。" : state.available && !allowed() ? state.available.reason || "工作助手尚未配置完成，请联系管理员。" : "";
      const notice = get(".agent-notice");
      notice.hidden = !unavailable;
      notice.textContent = unavailable;
      const error = get(".agent-error");
      error.hidden = !state.error;
      error.textContent = state.error;
      get(".agent-thread-title").textContent = state.conversations.find((item) => item.id === state.conversationId)?.title || "新对话";
      get(".agent-conversations").innerHTML = state.conversations.length ? state.conversations.map((conversation) => `<button type="button" data-agent-action="conversation" data-id="${escape(conversation.id)}" class="${state.conversationId === conversation.id ? "active" : ""}" aria-current="${state.conversationId === conversation.id ? "true" : "false"}" ${state.running || state.loading ? "disabled" : ""}><span>${escape(conversation.title || "未命名对话")}</span><time>${escape(timeLabel(conversation.updatedAt))}</time></button>`).join("") : `<p class="agent-history-empty">${state.loading ? "正在读取最近对话…" : "对话会保存在这里"}</p>`;
      get(".agent-empty").hidden = state.messages.length > 0;
      get(".agent-messages").innerHTML = state.messages.map((message) => {
        const content = message.content || (message.status === "pending" && state.running ? "正在查找相关数据…" : "");
        return `<article class="agent-message ${message.role === "user" ? "agent-user-message" : "agent-assistant-message"}"><div class="agent-message-author">${message.role === "user" ? "你" : `${icon("file-text")}工作助手`}</div><div class="agent-message-content">${message.role === "assistant" ? formatAnswer(content, window.location.origin) : escape(content)}</div>${message.role === "assistant" ? sourcesHtml(message.sources) : ""}${statusLabels[message.status] && !(message.status === "pending" && state.running) ? `<p class="agent-message-note">${statusLabels[message.status]}</p>` : ""}</article>`;
      }).join("");
      get(".agent-tools").innerHTML = state.tools.map((tool) => `<span class="agent-tool ${tool.failed ? "failed" : tool.status === "running" ? "running" : "complete"}"><i aria-hidden="true">${tool.failed ? "!" : tool.status === "running" ? "·" : "✓"}</i>${escape(toolLabels[tool.toolName] || "查询生产数据")}${tool.failed ? "未取得结果" : tool.status === "running" ? "中…" : "完成"}</span>`).join("");
      const liveStatus = state.loading ? "正在恢复对话" : state.running ? state.tools.some((tool) => tool.status === "running") ? "正在查询生产数据" : "正在生成回答" : state.messages.length ? "可以继续追问" : "输入问题开始查询";
      if (get(".agent-live-status").textContent !== liveStatus) get(".agent-live-status").textContent = liveStatus;
      const input = get("#agent-message-input");
      input.disabled = !allowed() || state.loading;
      if (input.value !== state.draft) input.value = state.draft;
      get(".agent-send").disabled = !allowed() || state.loading || state.running || !state.draft.trim();
      get(".agent-send").hidden = state.running;
      get(".agent-stop").hidden = !state.running;
      get(".agent-stop").disabled = !state.running;
      root.querySelectorAll('[data-agent-action="new"]').forEach((button) => { button.disabled = state.running || state.loading; });
      get('[data-agent-action="retry"]').hidden = !state.error || state.running;
      root.querySelectorAll('[data-agent-action="suggestion"]').forEach((button) => { button.disabled = !allowed() || state.loading || state.running; });
      scroller.scrollTop = nearBottom ? scroller.scrollHeight : oldScroll;
    }
    async function refreshConversations() {
      const data = await (await request("/v1/admin/agent/conversations")).json();
      state.conversations = Array.isArray(data.conversations) ? data.conversations.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) : [];
    }
    async function loadConversation(id) {
      if (state.running) return;
      const generation = ++state.generation;
      state.loading = true; state.error = ""; render();
      try {
        const data = await (await request(`/v1/admin/agent/conversations/${encodeURIComponent(id)}`)).json();
        if (generation !== state.generation) return;
        state.conversationId = data.id;
        state.messages = (Array.isArray(data.messages) ? data.messages : []).filter((message) => ["user", "assistant"].includes(message.role));
        state.tools = []; state.draft = "";
      } catch (error) {
        if (generation === state.generation) state.error = error.message;
      } finally { if (generation === state.generation) { state.loading = false; render(); } }
    }
    async function initialize() {
      if (state.loading || state.demo) return;
      state.loading = true; state.error = ""; render();
      try {
        state.available = await (await request("/v1/admin/agent/status")).json();
        await refreshConversations();
        state.initialized = true;
        state.loading = false;
        if (!state.conversationId && !state.messages.length && state.conversations[0]) await loadConversation(state.conversations[0].id);
      } catch (error) { state.error = error.message; }
      finally { state.loading = false; render(); }
    }
    async function submit() {
      const message = state.draft.trim();
      if (!message || state.running || state.loading || !allowed()) return;
      state.error = ""; state.tools = []; state.running = true; state.draft = "";
      if (!state.conversationId) state.messages = [];
      const assistant = { id: "pending", role: "assistant", content: "", status: "pending", sources: [] };
      state.messages.push({ id: `local-${Date.now()}`, role: "user", content: message }, assistant);
      const controller = new AbortController(); state.controller = controller;
      render(); get(".agent-scroll").scrollTop = get(".agent-scroll").scrollHeight;
      try {
        const response = await request("/v1/admin/agent/chat", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify({ ...(state.conversationId ? { conversationId: state.conversationId } : {}), message }) });
        await consumeNdjson(response, (event) => {
          if (controller.signal.aborted) return;
          if (event.type === "start") { state.conversationId = event.conversationId; assistant.id = event.messageId; }
          else if (event.type === "delta" && typeof event.text === "string") assistant.content += event.text;
          else if (event.type === "source" && event.source && typeof event.source === "object") {
            if (!assistant.sources.some((source) => JSON.stringify(source) === JSON.stringify(event.source))) assistant.sources.push(event.source);
          } else if (event.type === "tool") {
            const tool = state.tools.findLast((item) => (event.toolCallId ? item.toolCallId === event.toolCallId : item.toolName === event.toolName) && item.status === "running");
            if (tool && event.status === "complete") { tool.status = "complete"; tool.failed = event.failed === true; }
            else state.tools.push({ toolName: event.toolName, toolCallId: event.toolCallId, status: event.status, failed: event.failed === true });
          } else if (event.type === "done") assistant.status = ["interrupted", "error"].includes(event.status) ? event.status : "complete";
          else if (event.type === "error") throw new Error(event.message || "暂时无法完成回答，请稍后重试。");
          render();
        }, controller.signal);
      } catch (error) {
        assistant.status = controller.signal.aborted || error.name === "AbortError" ? "interrupted" : "error";
        if (assistant.status === "error") state.error = error.message;
      } finally {
        state.running = false; state.controller = null;
        state.tools = state.tools.filter((tool) => tool.status === "complete");
        render();
        try { await refreshConversations(); render(); } catch { /* Keep the answer if history cannot refresh. */ }
      }
    }
    function newConversation() {
      if (state.running || state.loading) return;
      state.generation++; state.conversationId = null; state.messages = []; state.tools = []; state.error = ""; state.draft = ""; state.historyOpen = false;
      render(); get("#agent-message-input").focus();
    }
    function mount(container, { demo = false } = {}) {
      root = container; state.demo = demo;
      root.dataset.mounted = "true";
      root.innerHTML = `
        <header class="agent-header">
          <div class="agent-header-title"><h1>工作助手</h1><span class="agent-header-divider" aria-hidden="true">/</span><span class="agent-thread-title">新对话</span></div>
          <div class="agent-header-actions"><span class="agent-availability"></span><button type="button" class="agent-secondary agent-history-toggle" data-agent-action="history" aria-expanded="false" aria-controls="agent-history-panel">${icon("refresh")}<span>历史对话</span></button><button type="button" class="agent-secondary agent-new" data-agent-action="new">${icon("file-text")}<span>新对话</span></button></div>
        </header>
        <aside class="agent-history" id="agent-history-panel" aria-label="最近对话" hidden><div class="agent-history-heading"><h2>最近对话</h2><button type="button" data-agent-action="close-history">收起</button></div><div class="agent-conversations"></div></aside>
        <section class="agent-conversation" aria-label="当前对话">
          <div class="agent-notice" role="status" hidden></div>
          <div class="agent-scroll" tabindex="0" aria-label="对话内容">
            <div class="agent-empty"><div class="agent-eyebrow">安心报工 <span>工作助手</span></div><h2>生产的事，问一问。</h2><p><span>查工单、看现场、核对报工，</span><span>让每个答案有据可循。</span></p></div>
            <div class="agent-messages"></div><div class="agent-tools" aria-label="查询步骤"></div>
          </div>
          <div class="agent-composer-area"><div class="agent-error" role="alert" hidden></div><button type="button" class="agent-retry" data-agent-action="retry" hidden>重新连接助手</button>
            <form class="agent-composer"><label class="sr-only" for="agent-message-input">向工作助手提问</label><textarea id="agent-message-input" rows="2" maxlength="4000" placeholder="想了解什么？输入问题或工单编号…" aria-describedby="agent-composer-hint"></textarea><div class="agent-composer-bottom"><span class="agent-mode">${icon("search")}生产查询</span><div class="agent-composer-actions"><span id="agent-composer-hint">Enter 发送</span><button type="button" class="agent-stop" data-agent-action="stop" hidden>停止生成</button><button type="submit" class="agent-send" aria-label="发送问题">${icon("chevron-right", "agent-send-arrow")}</button></div></div></form>
            <p class="agent-footer">回答基于当前可查询数据，请结合来源核对。</p><p class="agent-live-status sr-only" role="status" aria-live="polite"></p>
          </div>
          <div class="agent-onboarding"><div class="agent-suggestions-heading">从这些问题开始</div><div class="agent-suggestions">${suggestions.map(([title, , hint, symbol], index) => `<button type="button" data-agent-action="suggestion" data-index="${index}">${icon(symbol)}<span><strong>${title}</strong><small>${hint}</small></span>${icon("chevron-right", "agent-suggestion-arrow")}</button>`).join("")}</div><p class="agent-onboarding-note">仅查询与分析 · 回答附数据来源</p></div>
        </section>`;
      root.addEventListener("input", (event) => {
        if (event.target.id !== "agent-message-input") return;
        state.draft = event.target.value;
        get(".agent-send").disabled = !allowed() || state.loading || state.running || !state.draft.trim();
      });
      root.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && state.historyOpen) { state.historyOpen = false; render(); get('[data-agent-action="history"]').focus(); }
        if (event.target.id === "agent-message-input" && event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); }
      });
      root.addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
      root.addEventListener("click", (event) => {
        const button = event.target.closest("[data-agent-action]");
        if (!button) {
          if (state.historyOpen && !event.target.closest(".agent-history")) { state.historyOpen = false; render(); }
          return;
        }
        if (button.disabled) return;
        const action = button.dataset.agentAction;
        if (action === "history") { state.historyOpen = !state.historyOpen; render(); if (state.historyOpen) get('[data-agent-action="close-history"]').focus(); }
        else if (action === "close-history") { state.historyOpen = false; render(); get('[data-agent-action="history"]').focus(); }
        else if (action === "new") newConversation();
        else if (action === "stop") { state.controller?.abort(); get("#agent-message-input").focus(); }
        else if (action === "retry") void initialize();
        else if (action === "conversation") { state.historyOpen = false; void loadConversation(button.dataset.id); get('[data-agent-action="history"]').focus(); }
        else if (action === "suggestion") { state.historyOpen = false; state.draft = suggestions[Number(button.dataset.index)]?.[1] || ""; render(); get("#agent-message-input").focus(); }
      });
      render();
      if (!state.initialized && !state.demo) void initialize();
    }
    return { mount, submit, loadConversation, newConversation };
  }
  window.BlacklakeAgent = { create, consumeNdjson, safeSourceUrl, formatAnswer };
})();
