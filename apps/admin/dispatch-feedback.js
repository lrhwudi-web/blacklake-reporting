// Read-only prediction feedback. The server owns suggestions, confirmations and differences.
(() => {
  let root = null, api = null, demo = false, requestId = 0;
  const state = { query: "", outcome: "ALL", offset: 0, records: [], total: 0, summary: {}, loading: false, loaded: false, error: "" };
  const labels = { ADOPTED: "直接采纳", ADJUSTED: "人工调整", NO_SUGGESTION: "无初始建议" };
  const fields = { PROCESS: "工序", EMPLOYEES: "人员", STATIONS: "工位" };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const time = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知";
  const selection = (value) => `<strong>${escape(value?.processName || "未预选工序")}</strong><ul>${(value?.employees || []).map((person) =>
    `<li>${escape(person.name)} <span>${escape(person.unitId || "工位未确定")}</span></li>`).join("") || "<li>未预选人员</li>"}</ul>`;
  function render() {
    if (!root) return;
    root.innerHTML = `<header class="prediction-page-heading"><div><p>优化与核查</p><h1>派工预测反馈</h1><span>对照历史建议与组长最终确认，保留人工调整。</span></div><button class="primary-small" data-prediction-action="refresh" ${state.loading || demo ? "disabled" : ""}>刷新记录</button></header>
      <div class="prediction-metrics"><span>直接采纳 <b>${state.summary.ADOPTED || 0}</b></span><span>人工调整 <b>${state.summary.ADJUSTED || 0}</b></span><span>无初始建议 <b>${state.summary.NO_SUGGESTION || 0}</b></span></div>
      <p class="prediction-boundary">采纳或调整是操作反馈，不代表预测正确率；只有已确认的派工进入此处，浏览和取消不计为错误。</p>
      <form class="prediction-filters"><label>记录类型<select name="outcome">${["ALL", ...Object.keys(labels)].map((key) => `<option value="${key}" ${state.outcome === key ? "selected" : ""}>${labels[key] || "全部记录"}</option>`).join("")}</select></label><label>搜索<input name="query" value="${escape(state.query)}" maxlength="100" placeholder="工单、人员或组长"></label><button class="secondary-button" type="submit" ${state.loading || demo ? "disabled" : ""}>查询</button></form>
      ${state.error ? `<p class="prediction-error" role="alert">${escape(state.error)}。已有记录可能未更新。</p>` : ""}
      ${demo ? '<p class="table-empty">演示模式不读取正式预测记录。</p>' : state.loading && !state.records.length ? '<p class="table-empty">正在读取预测记录…</p>' : !state.records.length && state.loaded && !state.error ? '<p class="table-empty">当前条件下暂无已确认的预测反馈。</p>' : ""}
      <div class="prediction-records">${state.records.map((record) => `<article class="prediction-record"><div class="prediction-record-heading"><div><h2>${escape(record.projectCode)}</h2><span>${escape(time(record.createdAt))} · ${escape(record.dispatcherName)}</span></div><strong class="prediction-outcome ${record.outcome === "ADJUSTED" ? "adjusted" : ""}">${escape(labels[record.outcome] || record.outcome)}</strong></div><div class="prediction-comparison"><section><h3>${record.prediction.mode === "PERSON_FIRST" ? "工序建议（人员由组长选择）" : "初始预测"}</h3>${selection(record.prediction)}</section><section><h3>最终确认</h3>${selection(record.finalSelection)}</section></div>
        <p class="prediction-change">调整项目：${escape(record.changedFields.map((field) => fields[field] || field).join("、") || "无")}${record.reason ? ` · 说明：${escape(record.reason)}` : ""}</p>
        <details><summary>查看依据与后续建议</summary><p>历史分析时段：${escape(time(record.prediction.source?.sourcePeriod?.from))} 至 ${escape(time(record.prediction.source?.sourcePeriod?.to))}；源分析 ${escape(record.prediction.source?.sourceRecordCount || 0)} 条记录。规则版本 ${escape(record.prediction.source?.version || "未知")}。</p><ul>${(record.prediction.employees || []).map((person) => `<li>${escape(person.name)}：${person.evidence ? `历史 ${escape(person.evidence.reportCount)} 条、${escape(person.evidence.workOrderCount)} 张工单，主工序占比 ${escape(Math.round(person.evidence.dominantShare * 100))}%。` : "无可用历史依据，人员由组长选择。"}</li>`).join("")}</ul>${record.finalSelection.appliedPrediction ? `<h3>更换工序后的建议</h3>${selection(record.finalSelection.appliedPrediction.suggestion)}` : ""}<p>批次 ${escape(record.batchId)} · 预测 ${escape(record.predictionId)}</p></details></article>`).join("")}</div>
      <footer class="prediction-pagination"><span>符合条件 ${state.total} 条</span><button class="secondary-button" data-prediction-action="previous" ${state.offset === 0 || state.loading ? "disabled" : ""}>上一页</button><span>第 ${Math.floor(state.offset / 30) + 1} 页</span><button class="secondary-button" data-prediction-action="next" ${state.offset + 30 >= state.total || state.loading ? "disabled" : ""}>下一页</button></footer>`;
  }
  async function load() {
    if (!root || demo) return;
    const currentRoot = root, revision = ++requestId;
    state.loading = true; state.error = ""; render();
    try {
      const params = new URLSearchParams({ outcome: state.outcome, q: state.query, limit: "30", offset: String(state.offset) });
      const result = await api(`/v1/admin/dispatch-predictions?${params}`);
      if (revision !== requestId || root !== currentRoot || !root?.isConnected) return;
      if (!Array.isArray(result.records)) throw new Error("记录格式未能确认");
      Object.assign(state, { records: result.records, total: result.total, summary: result.summary, loaded: true });
    } catch (error) { if (revision === requestId && root === currentRoot) state.error = error.message || "读取失败"; }
    finally { if (revision === requestId && root === currentRoot) { state.loading = false; render(); } }
  }
  window.BlacklakeDispatchFeedback = { mount(element, options = {}) {
    if (root === element) return;
    requestId++; root = element;
    if (!root) return;
    api = options.api;
    if (demo !== Boolean(options.demo)) Object.assign(state, { records: [], total: 0, summary: {}, loaded: false, error: "" });
    demo = Boolean(options.demo); root.dataset.mounted = "true";
    root.addEventListener("submit", (event) => { event.preventDefault(); const form = event.target;
      state.query = form.elements.query.value.trim(); state.outcome = form.elements.outcome.value; state.offset = 0; void load(); });
    root.addEventListener("click", (event) => { const action = event.target.closest("[data-prediction-action]")?.dataset.predictionAction;
      if (!action || state.loading) return;
      if (action === "previous") state.offset = Math.max(0, state.offset - 30);
      if (action === "next") state.offset += 30;
      void load(); });
    render(); void load();
  } };
})();
