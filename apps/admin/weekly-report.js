// Fixed weekly summaries and record investigations share evidence and feedback, not chat state.
(() => {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const list = (value) => Array.isArray(value) ? value : [];
  const words = (value) => typeof value === "string" ? value : value?.text || value?.message || value?.description || value?.title || "";
  const brief = (value, limit = 180) => { const text = words(value); return text.length > limit ? `${text.slice(0, limit)}…` : text; };
  const number = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN") : "未知";
  const sourceNumber = (item, key) => Object.prototype.hasOwnProperty.call(item, key) ? number(item[key]) : undefined;
  const stamp = (value) => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "时间未提供"; };
  const statuses = { NEW: "待核实", INVESTIGATING: "核实中", CONFIRMED_NORMAL: "已确认正常", RESOLVED: "已处理" };
  const reasons = { NORMAL_OVERPRODUCTION: "正常超产", DUPLICATE_RECORD: "重复记录", PLAN_OUTDATED: "计划未更新", SYSTEM_ISSUE: "系统问题", OTHER: "其他" };
  const feedbackDraft = (finding) => ({ status: finding.status || "NEW", reason: finding.reason || "OTHER", note: finding.note || "" });
  function replaceHtml(container, html) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    const focus = active && container.contains?.(active) && (active.dataset.weeklyField || active.dataset.findingField)
      ? { weeklyField: active.dataset.weeklyField, findingField: active.dataset.findingField, key: active.dataset.key, start: active.selectionStart, end: active.selectionEnd } : null;
    const scrollTop = container.scrollTop;
    container.innerHTML = html;
    if (focus) {
      const control = Array.from(container.querySelectorAll("[data-weekly-field], [data-finding-field]")).find((node) => node.dataset.weeklyField === focus.weeklyField && node.dataset.findingField === focus.findingField && node.dataset.key === focus.key);
      control?.focus({ preventScroll: true });
      if (typeof focus.start === "number") control?.setSelectionRange?.(focus.start, focus.end);
    }
    container.scrollTop = scrollTop;
  }
  function safeUrl(value) {
    try { const url = new URL(value, window.location.origin); return url.origin === window.location.origin && (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) ? `${url.pathname}${url.search}${url.hash}` : ""; } catch { return ""; }
  }
  const bullets = (values, fallback, limit = 5) => list(values).length ? `<ul>${list(values).slice(0, limit).map((value) => `<li>${escape(words(value))}</li>`).join("")}</ul>` : `<p class="pi-muted">${escape(fallback)}</p>`;
  function evidenceHtml(evidence) {
    if (!list(evidence).length) return '<p class="pi-muted">尚无可展示的来源，请先核实数据范围。</p>';
    return `<div class="pi-evidence">${list(evidence).map((item) => {
      const href = item.url ? safeUrl(item.url) : "";
      const title = item.title || item.source || item.type || "原始数据";
      const fields = [["范围", item.scope], ["工单", item.projectCode], ["工序ID", item.taskId], ["记录ID", item.recordId || item.assignmentId], ["报工创建时间", item.createdAt], ["报工总数", sourceNumber(item, "totalQuantity")], ["良品数量", sourceNumber(item, "goodQuantity")], ["不良数量", sourceNumber(item, "defectQuantity")], ["报工人员线索", item.productionStaff], ["人员识别依据", item.personIdentityBasis], ["数据更新时间", item.updatedAt || item.asOf], ["查询时间", item.queriedAt || item.generatedAt], ["完整性", item.completeness || (item.complete === true ? "已完整取得标注范围" : item.complete === false ? "部分数据，范围不完整" : undefined)], ["状态", item.status], ["计划数量", sourceNumber(item, "plannedAmount")], ["累计良品", sourceNumber(item, "reportedGoodAmount")], ["时间范围", item.start && item.end ? `${item.start} — ${item.end}` : null]];
      if (item.evidenceType === "group_summary") fields.push(["组内总条数", number(item.recordCount)], ["展示样本条数", number(item.sampleCount)], ["样本是否截断", item.sampleTruncated === true ? "是，仅展示部分样本" : item.sampleTruncated === false ? "否，已展示全部样本" : "未知"]);
      if (item.evidenceType === "pagination_summary") fields.push(["分页重复条数", number(item.duplicateCount)], ["同 ID 内容冲突", number(item.conflictingIdCount)], ["是否出现重复页", item.repeatedPage === true ? "是，分页完整性受影响" : item.repeatedPage === false ? "否" : "未知"]);
      return `<article><strong>${escape(title)}</strong>${href ? `<a class="pi-source-link" href="${escape(href)}" target="_blank" rel="noopener">打开台账（需按此 ID 核对） ↗</a>` : ""}<dl>${fields.filter(([, value]) => value !== undefined && value !== null && value !== "").map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(typeof value === "object" ? JSON.stringify(value) : value)}</dd></div>`).join("")}</dl>${bullets(item.warnings, "", 6)}</article>`;
    }).join("")}</div>`;
  }
  function findingHtml(finding, ui = {}, aiAvailable = false) {
    const analysis = ui.analysis;
    const draft = ui.draft || feedbackDraft(finding);
    const selected = (value, current) => value === current ? " selected" : "";
    return `<article class="pi-finding" data-finding-key="${escape(finding.key)}"><header><div><span class="pi-eyebrow">${escape(finding.projectCode || "数据范围")} ${finding.taskId ? `· 工序 ${escape(finding.taskId)}` : ""}</span><h3>${escape(finding.title || "需核实事项")}</h3></div><span class="pi-badge">${escape(statuses[finding.status] || "待核实")}</span></header>
      ${finding.observationNote ? `<p class="pi-notice">${escape(finding.observationNote)} 最近观测：${escape(stamp(finding.observedAt))}</p>` : ""}
      ${finding.evidenceChanged ? '<p class="pi-notice">来源证据已变化，请重新核实。下方保留的人工说明属于此前反馈，不能代替对新证据的确认。</p>' : ""}
      <div class="pi-finding-facts"><h4>已知事实</h4>${bullets(finding.facts, "事实不足，暂不判断原因。")}</div>
      <details class="pi-details" open><summary>查看依据与来源</summary>${evidenceHtml(finding.evidence)}</details>
      <div class="pi-analysis"><div class="pi-section-bar"><h4>原因与下一步</h4><button type="button" data-insight-action="analyze-finding" data-key="${escape(finding.key)}" ${ui.busy || !aiAvailable ? "disabled" : ""}>${ui.busy === "analyze" ? "分析中…" : "AI 帮我分析"}</button></div>${!aiAvailable ? '<p class="pi-muted">AI 尚未配置，事实、来源和人工核实仍可使用。</p>' : ""}
      ${analysis ? `<p class="pi-muted">${analysis.mode === "AI_DRAFT" ? "AI 辅助分析" : "辅助分析"} · ${escape(stamp(analysis.generatedAt))} · 原因需人工核实</p>${analysis.warning ? `<p class="pi-notice">${escape(analysis.warning)}</p>` : ""}${analysis.revision && analysis.revision !== finding.revision ? '<p class="pi-notice">案例已更新，此分析基于较早版本，请重新核对依据。</p>' : ""}<h4>证据支持的事实</h4>${bullets(analysis.facts, "未补充事实。")}` : ""}
      <h4>可能原因 · 尚未证实</h4>${bullets(analysis?.possibleCauses || finding.possibleCauses, "资料不足，不能确认原因。")}<h4>建议核实</h4>${bullets(analysis?.nextChecks || finding.nextChecks, "请先核对源记录、计划和业务状态。")}${analysis?.evidence ? `<details class="pi-details"><summary>分析引用的依据</summary>${evidenceHtml(analysis.evidence)}</details>` : ""}</div>
      <details class="pi-details pi-feedback" ${ui.feedbackOpen ? "open" : ""}><summary>记录人工核实结果</summary><p class="pi-muted">仅记录核实反馈，不修改黑湖报工或工序状态。</p><div class="pi-feedback-fields"><label>处理状态<select data-finding-field="status" data-key="${escape(finding.key)}" ${ui.busy ? "disabled" : ""}>${Object.entries(statuses).map(([key, value]) => `<option value="${key}"${selected(key, draft.status)}>${value}</option>`).join("")}</select></label><label>原因分类<select data-finding-field="reason" data-key="${escape(finding.key)}" ${ui.busy ? "disabled" : ""}>${Object.entries(reasons).map(([key, value]) => `<option value="${key}"${selected(key, draft.reason)}>${value}</option>`).join("")}</select></label></div><label>核实说明<textarea data-finding-field="note" data-key="${escape(finding.key)}" rows="3" maxlength="1000" placeholder="填写核实依据；不要用推测代替确认结果" ${ui.busy ? "disabled" : ""}>${escape(draft.note)}</textarea></label><button type="button" data-insight-action="feedback" data-key="${escape(finding.key)}" ${ui.busy ? "disabled" : ""}>${ui.busy === "feedback" ? "保存中…" : "保存核实结果"}</button></details>
      ${list(finding.events).length ? `<details class="pi-details"><summary>核查记录 · ${number(finding.eventsTotal || list(finding.events).length)} 次</summary>${finding.eventsTruncated ? '<p class="pi-muted">仅展示最近 50 条，完整记录已保存。</p>' : ""}<ol class="pi-history">${list(finding.events).map((event) => `<li><strong>${escape(({ DETECTED: "发现事项", EVIDENCE_CHANGED: "来源证据变化", FEEDBACK: "人工核实反馈" })[event.action] || "案例更新")}</strong><span>${escape(stamp(event.createdAt))} · 版本 ${escape(event.revision)}</span>${event.detail?.status ? `<p>${escape(statuses[event.detail.status] || "待核实")}${event.detail.reason ? ` · ${escape(reasons[event.detail.reason] || "其他")}` : ""}</p>` : ""}${event.detail?.note ? `<p>${escape(event.detail.note)}</p>` : ""}</li>`).join("")}</ol></details>` : ""}
      ${ui.error ? `<p class="pi-error" role="alert">${escape(ui.error)}</p>${ui.conflict ? `<button type="button" data-insight-action="reload-finding" data-key="${escape(finding.key)}" ${ui.busy ? "disabled" : ""}>读取最新案例并保留输入</button>` : ""}` : ""}${ui.notice ? `<p class="pi-notice" role="status">${escape(ui.notice)}</p>` : ""}</article>`;
  }
  function summaryHtml(report) {
    const snapshot = report.snapshot || {}, period = snapshot.period || {}, current = snapshot.metrics?.current || {}, coverage = snapshot.coverage || {};
    const findings = list(snapshot.risks || list(snapshot.findings).filter((item) => !["CONFIRMED_NORMAL", "RESOLVED"].includes(item.status))).slice(0, 3), progress = list(snapshot.progress).slice(0, 5);
    const next = findings.flatMap((item) => list(item.nextChecks)).slice(0, 3);
    const limitations = [...list(snapshot.limitations), ...list(coverage.warnings), ...list(report.narrative?.limitations)];
    return `<article class="pi-summary" aria-label="一页生产周报摘要"><header><div><p class="pi-eyebrow">生产周报 · 管理摘要</p><h2>${escape(period.label || `${period.startDate || ""} — ${period.endDate || ""}`)}</h2></div><span class="pi-badge ${report.status === "REVIEWED" ? "reviewed" : ""}">${report.status === "REVIEWED" ? "已审阅" : "草稿 · 待审阅"}</span></header>
      <p class="pi-summary-meta">上海时区 · ${period.isPartial ? "本周期尚未结束" : "完整自然周"} · 数据快照 ${escape(stamp(snapshot.generatedAt || report.createdAt))}${report.reviewedAt ? ` · 审阅 ${escape(stamp(report.reviewedAt))}` : ""}</p>
      ${snapshot.mode !== "live" ? '<p class="pi-notice">模拟或未确认数据模式 · 不能作为正式生产事实</p>' : ""}
      ${[coverage.current, coverage.previous, coverage.local, coverage.tasks].some((item) => item?.complete === false) ? '<p class="pi-notice">部分数据尚未完整取得，数字仅代表已取得范围；人工审阅不会改变数据完整性。</p>' : ""}
      <section><h3>本周摘要</h3><p>${escape(brief(report.managementNote || list(snapshot.summary).join(" ") || "请核对数据与风险，补充管理判断后再审阅。", 380))}</p>${list(report.narrative?.summary).length ? `<p class="pi-ai-copy">AI 辅助整理：${escape(list(report.narrative.summary).slice(0, 2).map((item) => brief(item, 120)).join("；"))}</p>` : ""}<div class="pi-metrics"><div><strong>${number(current.recordCount)}</strong><span>期间报工记录</span></div><div><strong>${number(current.projectCount)}</strong><span>已识别工单</span></div><div><strong>${number(current.approvedRecordCount)}</strong><span>已审批记录</span></div><div><strong>${number(coverage.local?.quantityPendingCount)}</strong><span>本地待核量任务</span></div></div><p class="pi-muted">报工按创建时间统计；记录数不是成品产量。审批状态未知 ${number(current.unknownApprovalCount)} 条。本地待核量为其标注范围内的当前状态。${current.complete === false ? "本周报工数据不完整。" : ""}</p></section>
      <section><h3>生产进展 <small>当前工序快照 · 最多 5 项</small></h3>${progress.length ? `<div class="pi-table-wrap"><table><thead><tr><th>工单 / 工序</th><th>计划</th><th>累计良品</th><th>工序状态</th></tr></thead><tbody>${progress.map((item) => `<tr><td>${escape(item.projectCode || "工单未知")}<small>${escape(item.processName || item.processCode || "工序未知")}</small></td><td>${number(item.plannedAmount)} ${escape(item.unit || "")}</td><td>${number(item.reportedGoodAmount)} ${escape(item.unit || "")}</td><td>${escape(item.processStatusDisplay || (item.closed === true ? "已关闭" : item.closed === false ? "未关闭" : "未知"))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="pi-muted">没有可确认的工序进展，未知不按零处理。</p>'}<p class="pi-muted">累计良品不是本周增量；达到计划数量不等于工序关闭。</p></section>
      <section><h3>需关注的风险 <small>最多 3 项 · 先核实再判断</small></h3>${findings.length ? `<ol class="pi-risk-summary">${findings.map((item) => `<li><strong>${item.carriedForward ? "历史待复查 · " : ""}${escape(brief(item.title, 90))}</strong><span>${escape(brief(list(item.facts)[0] || "请展开下方证据核实。", 110))}</span></li>`).join("")}</ol>` : '<p class="pi-muted">当前范围未形成明确风险项；不代表全厂没有风险。</p>'}${snapshot.handling ? `<p class="pi-muted">核实进展：待核实 ${number(snapshot.handling.NEW)} · 核实中 ${number(snapshot.handling.INVESTIGATING)} · 已确认正常 ${number(snapshot.handling.CONFIRMED_NORMAL)} · 已处理 ${number(snapshot.handling.RESOLVED)}（生成时）</p>` : ""}</section>
      <div class="pi-summary-bottom"><section><h3>需要协调</h3><p>${escape(brief(report.coordination || "待人工填写；无事项请明确填写“暂无”。", 220))}</p></section><section><h3>下周关注</h3>${next.length ? `<ul>${next.map((item) => `<li>${escape(brief(item, 100))}</li>`).join("")}</ul>` : '<p>继续核实待核量和资料缺口，依据新数据更新判断。</p>'}</section></div>
      <footer>${escape(brief(limitations[0] || "仅覆盖本报告所列来源与范围，不用于推断全厂成品产量、人员效率或交付承诺。", 220))}<span>详细依据、范围与人工反馈见在线周报 · 本页不自动发送</span></footer></article>`;
  }
  function dataDetailsHtml(snapshot = {}) {
    const metrics = snapshot.metrics || {}, comparison = metrics.comparison || {}, coverage = snapshot.coverage || {};
    const groupRows = (groups) => list(groups).map((item) => `<tr><td>${escape(item.productName || item.productCode || "产品未知")}<small>${escape(item.productCode || "")}</small></td><td>${escape(item.processName || item.processCode || "工序未知")}</td><td>${escape(item.unit || "未知")}</td><td>${number(item.recordCount)}</td><td>${number(item.totalQuantity)}</td><td>${number(item.goodQuantity)}</td><td>${number(item.defectQuantity)}</td><td>${number(item.unknownQuantityRecords)}</td></tr>`).join("");
    const periodTable = (metric = {}, label) => `<h3>${label}</h3><p class="pi-muted">${metric.complete === true ? "此范围已完整取得" : "此范围不完整或完整性未知"} · 已审批 ${number(metric.approvedRecordCount)} / 未审批 ${number(metric.unapprovedRecordCount)} / 审批未知 ${number(metric.unknownApprovalCount)} 条 · 工单未识别 ${number(metric.recordsWithoutProject)} 条${metric.groupsTruncated ? " · 分组已截断" : ""}</p>${list(metric.groups).length ? `<div class="pi-table-wrap"><table><thead><tr><th>产品</th><th>工序</th><th>单位</th><th>记录</th><th>总数</th><th>良品</th><th>不良</th><th>数量未知记录</th></tr></thead><tbody>${groupRows(metric.groups)}</tbody></table></div>` : '<p class="pi-muted">未取得可展示的数量分组。</p>'}`;
    return `<details class="pi-details pi-data"><summary>数量明细、前周对比与完整工序进展</summary><p class="pi-muted">按产品、工序与单位分别统计；不同分组不相加为成品产量。未知数量不按零处理。</p>${periodTable(metrics.current, "本周录入报工")}${periodTable(metrics.previous, "前周可比范围录入报工")}<h3>同口径前周对比</h3><p class="pi-muted">${escape(comparison.note || "未提供对比范围说明。")}${comparison.groupsTruncated ? " · 对比分组已截断" : ""}</p>${list(comparison.groups).length ? `<div class="pi-table-wrap"><table><thead><tr><th>产品 / 工序</th><th>单位</th><th>本周良品</th><th>前周良品</th><th>变化量</th><th>变化比例</th><th>说明</th></tr></thead><tbody>${list(comparison.groups).map((item) => `<tr><td>${escape(item.productName || item.productCode || "产品未知")}<small>${escape(item.processName || item.processCode || "工序未知")}</small></td><td>${escape(item.unit || "未知")}</td><td>${number(item.currentGoodQuantity)}</td><td>${number(item.previousGoodQuantity)}</td><td>${item.comparable ? number(item.change) : "不可比"}</td><td>${item.comparable && item.percentChange !== null && item.percentChange !== undefined ? `${number(item.percentChange)}%` : "不可比"}</td><td>${escape(item.note || (item.comparable ? "同口径" : "数据不足"))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="pi-muted">没有可用的对比结果。</p>'}<h3>完整工序进展 <small>当前累计快照</small></h3><p class="pi-muted">${escape(coverage.tasks?.scope || "仅涵盖取得的关联工序")} · 取得 ${number(coverage.tasks?.taskCount)} 个工序${coverage.tasks?.progressTruncated ? " · 展示已截断" : ""} · ${escape(stamp(coverage.tasks?.asOf || snapshot.generatedAt))}</p>${list(snapshot.progress).length ? `<div class="pi-table-wrap"><table><thead><tr><th>工单 / 工序</th><th>计划</th><th>累计良品</th><th>数量进度</th><th>状态</th><th>数据时间</th></tr></thead><tbody>${list(snapshot.progress).map((item) => `<tr><td>${escape(item.projectCode || "未知")}<small>${escape(item.processName || item.processCode || "未知")} · ID ${escape(item.taskId)}</small></td><td>${number(item.plannedAmount)} ${escape(item.unit || "")}</td><td>${number(item.reportedGoodAmount)} ${escape(item.unit || "")}</td><td>${item.quantityCompletionPercent === null || item.quantityCompletionPercent === undefined ? "未知" : `${number(item.quantityCompletionPercent)}%`}</td><td>${escape(item.processStatusDisplay || (item.closed === true ? "已关闭" : item.closed === false ? "未关闭" : "未知"))}</td><td>${escape(stamp(item.asOf))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="pi-muted">未取得工序进展。</p>'}</details>`;
  }
  function create({ fetchImpl = (...args) => fetch(...args), onUnauthorized = () => {} } = {}) {
    const state = { initialized: false, loading: false, busy: "", error: "", notice: "", reports: [], report: null, aiAvailable: false, startDate: "", selected: "", generation: 0, demo: false, drafts: new Map(), findings: new Map(), findingUi: new Map() };
    let root = null, inspectorRoot = null;
    const inspector = { key: "", context: null, keys: [], loading: false, loaded: false, error: "", warnings: [], scope: "", generation: 0, controller: null, demo: false };
    async function api(path, options = {}) {
      const response = await fetchImpl(`/v1/admin${path}`, { ...options, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", ...options.headers } });
      let body = {}; try { body = await response.json(); } catch { /* gateway errors may be HTML */ }
      if (!response.ok) {
        if (response.status === 401) onUnauthorized();
        const error = new Error(body.error?.message || (typeof body.error === "string" ? body.error : "") || "暂时无法完成，请重试。");
        error.status = response.status; error.code = body.error?.code; throw error;
      }
      return body;
    }
    const post = (path, data = {}, method = "POST") => api(path, { method, body: JSON.stringify(data) });
    const findingUi = (key) => { if (!state.findingUi.has(key)) state.findingUi.set(key, {}); return state.findingUi.get(key); };
    function remember(findings) { for (const finding of list(findings)) if (finding?.key) { const previous = state.findings.get(finding.key); if (!previous || Number(finding.revision || 0) >= Number(previous.revision || 0)) state.findings.set(finding.key, finding); } }
    function draftFor(report = state.report) {
      if (!report) return null;
      if (!state.drafts.has(report.id)) state.drafts.set(report.id, { revision: report.revision, managementNote: report.managementNote || "", coordination: report.coordination || "", dirty: false });
      return state.drafts.get(report.id);
    }
    function render() {
      if (!root) return;
      const report = state.report, draft = draftFor(), readOnly = report?.status === "REVIEWED", busy = state.loading || Boolean(state.busy);
      const view = report ? { ...report, managementNote: draft.managementNote, coordination: draft.coordination } : null;
      const riskKeys = list(report?.snapshot?.findings).map((finding) => finding.key);
      replaceHtml(root, `<header class="pi-page-header"><div><p class="pi-eyebrow">经营分析</p><h1>生产周报</h1><p>一页看进展、风险与需要协调的事</p></div><button type="button" data-insight-action="refresh-list" ${busy ? "disabled" : ""}>刷新列表</button></header>
        ${state.demo ? '<p class="pi-notice">演示数据 · 虚构工单，不读取或保存生产数据</p>' : ""}<div class="pi-toolbar"><label>选择周报<select data-weekly-field="selected" ${busy ? "disabled" : ""}><option value="">选择一份周报</option>${state.reports.map((item) => `<option value="${escape(item.id)}"${item.id === report?.id ? " selected" : ""}>${escape(item.snapshot?.period?.label || item.period?.label || item.startDate || item.createdAt || item.id)} · ${item.status === "REVIEWED" ? "已审阅" : "草稿"}</option>`).join("")}</select></label><label>周一日期（可留空）<input type="date" data-weekly-field="startDate" value="${escape(state.startDate)}" ${busy ? "disabled" : ""}></label><button class="pi-primary" type="button" data-insight-action="generate" ${busy || state.demo ? "disabled" : ""}>${state.busy === "generate" ? "正在读取数据…" : "生成周报草稿"}</button><span class="pi-muted">默认上一完整自然周 · 上海时区</span></div>
        ${state.error ? `<div class="pi-error" role="alert">${escape(state.error)}</div>` : ""}${state.notice ? `<p class="pi-notice" role="status">${escape(state.notice)}</p>` : ""}
        ${state.loading ? '<p class="pi-loading" role="status">正在读取周报…</p>' : ""}
        ${report ? `<div class="pi-report-actions"><span>${draft.dirty ? "有未保存的人工内容" : readOnly ? "此版本已审阅；有更新请生成新的草稿" : "数字由程序统计 · 人工审阅后再使用"}</span><button type="button" data-insight-action="analyze-report" ${busy || readOnly || draft.dirty || !state.aiAvailable || state.demo ? "disabled" : ""}>${state.busy === "analyze" ? "整理中…" : "AI 整理摘要（可选）"}</button><button type="button" data-insight-action="print" ${busy || draft.dirty ? "disabled" : ""}>打印一页摘要</button><button type="button" data-insight-action="copy-question">复制追问</button></div>
          ${!state.aiAvailable ? '<p class="pi-muted">AI 尚未配置，仍可生成数字草稿、填写备注并审阅。</p>' : ""}${summaryHtml(view)}
          <section class="pi-editor"><div class="pi-section-bar"><h2>人工审阅</h2><span class="pi-badge">${readOnly ? "已审阅" : "待审阅"}</span></div><p class="pi-muted">核对来源后填写判断和协调事项。无事项请填“暂无”；审阅只记录此版本，不发送或更改生产数据。</p><div class="pi-editor-grid"><label>管理备注<textarea data-weekly-field="managementNote" rows="4" maxlength="1200" placeholder="对本周进展的判断、已核实事项或需要说明的限制" ${busy || readOnly || state.demo ? "disabled" : ""}>${escape(draft.managementNote)}</textarea></label><label>需要协调<textarea data-weekly-field="coordination" rows="4" maxlength="1000" placeholder="需要谁协调什么；没有则填写“暂无”" ${busy || readOnly || state.demo ? "disabled" : ""}>${escape(draft.coordination)}</textarea></label></div><div class="pi-editor-actions"><button type="button" data-insight-action="save" ${busy || readOnly || !draft.dirty || state.demo ? "disabled" : ""}>保存人工内容</button><button class="pi-primary" type="button" data-insight-action="review" ${busy || readOnly || draft.dirty || !draft.managementNote.trim() || !draft.coordination.trim() || state.demo ? "disabled" : ""}>标记已审阅</button>${state.error ? '<button type="button" data-insight-action="reload-report">重新读取服务端版本</button>' : ""}</div></section>
          ${dataDetailsHtml(report.snapshot)}<section class="pi-risk-details"><h2>核查事项与反馈</h2><p class="pi-muted">与记录详情共用同一案例及人工反馈；一页摘要保留生成时的证据版本。${report.snapshot?.coverage?.findingsTruncated ? "核查事项已截断，请留意数据范围。" : ""}</p>${riskKeys.length ? riskKeys.map((key) => findingHtml({ ...list(report.snapshot.findings).find((item) => item.key === key), ...state.findings.get(key) }, findingUi(key), state.aiAvailable && !state.demo)).join("") : '<p class="pi-empty">本报告范围内没有明确核查事项。</p>'}</section>
          <details class="pi-details pi-scope"><summary>完整数据范围、限制与来源</summary><p>本周 ${escape(report.snapshot?.period?.start || "未知")} 至 ${escape(report.snapshot?.period?.end || "未知")}（右端不包含）</p>${bullets(report.snapshot?.coverage?.warnings, "未提供额外覆盖提示。", 20)}${bullets(report.snapshot?.limitations, "", 20)}${evidenceHtml(report.snapshot?.sources)}</details>` : !state.loading ? '<section class="pi-empty"><h2>还没有可展示的周报</h2><p>选择一份已保存周报，或生成上一完整周的草稿。生成不会发送给任何人。</p></section>' : ""}`);
    }
    function renderInspector() {
      if (!inspectorRoot) return;
      replaceHtml(inspectorRoot, `<div class="pi-section-bar"><h3>异常与数据核实</h3><button type="button" data-insight-action="inspect" ${inspector.loading || inspector.demo ? "disabled" : ""}>${inspector.loading ? "正在查找依据…" : inspector.loaded ? "重新读取案例" : "AI 帮我分析"}</button></div><p class="pi-muted">按这笔记录的工单与工序读取现有案例，再选择分析；不自动认定异常。</p>${inspector.scope ? `<p class="pi-muted">范围：${escape(inspector.scope)}</p>` : ""}${inspector.warnings.length ? `<div class="pi-notice">${bullets(inspector.warnings, "", 20)}</div>` : ""}${inspector.error ? `<p class="pi-error" role="alert">${escape(inspector.error)}</p>` : ""}${inspector.demo ? '<p class="pi-muted">演示模式不读取生产案例。</p>' : ""}${inspector.keys.map((key) => state.findings.get(key)).filter(Boolean).map((finding) => findingHtml(finding, findingUi(finding.key), state.aiAvailable)).join("")}${inspector.loaded && !inspector.keys.length ? '<p class="pi-muted">当前未找到关联案例，不代表已经确认正常。请核对来源或在周报中查看数据覆盖。</p>' : ""}`);
    }
    function renderAll() { render(); renderInspector(); }
    function acceptReport(report, { replaceDraft = true } = {}) {
      if (!report?.id) throw new Error("周报内容未能确认，请重新读取。");
      state.report = report; state.selected = report.id; remember(report.snapshot?.findings);
      if (replaceDraft) state.drafts.delete(report.id);
      const index = state.reports.findIndex((item) => item.id === report.id);
      if (index < 0) state.reports.unshift(report); else state.reports[index] = report;
    }
    async function refreshList() {
      if (state.demo || state.loading || state.busy) return;
      state.loading = true; state.error = ""; render();
      try { const data = await api("/weekly-reports"); state.reports = list(data.reports); state.aiAvailable = data.aiAvailable === true; state.initialized = true; }
      catch (error) { state.error = error.message; }
      finally { state.loading = false; renderAll(); }
    }
    async function loadReport(id, { discardDraft = false } = {}) {
      if (!id || state.demo || state.busy) return;
      const generation = ++state.generation;
      state.loading = true; state.error = ""; render();
      try {
        const data = await api(`/weekly-reports/${encodeURIComponent(id)}`);
        if (generation !== state.generation) return;
        acceptReport(data.report, { replaceDraft: discardDraft || !state.drafts.get(id)?.dirty });
        state.aiAvailable = data.aiAvailable === true;
        const result = await api(`/production-findings?reportId=${encodeURIComponent(id)}`);
        if (generation !== state.generation) return;
        remember(result.findings);
      } catch (error) { if (generation === state.generation) state.error = error.message; }
      finally { if (generation === state.generation) { state.loading = false; renderAll(); } }
    }
    async function reportAction(action) {
      if (state.demo || state.busy || state.loading) return;
      const report = state.report, draft = draftFor();
      if (action !== "generate" && (!report || report.status !== "DRAFT")) return;
      if (action === "generate" && state.startDate && (!/^\d{4}-\d{2}-\d{2}$/.test(state.startDate) || new Date(`${state.startDate}T00:00:00Z`).getUTCDay() !== 1)) { state.error = "请选择周一作为开始日期。"; render(); return; }
      if (["review", "analyze"].includes(action) && draft.dirty) { state.error = "请先保存人工内容。"; render(); return; }
      if (action === "review" && (!draft.managementNote.trim() || !draft.coordination.trim())) { state.error = "请填写管理备注和协调事项；没有则明确填写“暂无”。"; render(); return; }
      if (action === "analyze" && !state.aiAvailable) return;
      state.busy = action; state.error = ""; state.notice = ""; render();
      try {
        const path = action === "generate" ? "/weekly-reports" : `/weekly-reports/${encodeURIComponent(report.id)}${action === "save" ? "" : `/${action}`}`;
        const data = action === "generate" ? (state.startDate ? { startDate: state.startDate } : {}) : action === "save" ? { revision: draft.revision, managementNote: draft.managementNote, coordination: draft.coordination } : { revision: report.revision };
        const result = await post(path, data, action === "save" ? "PATCH" : "POST");
        acceptReport(result.report);
        state.notice = action === "review" ? "此版本已标记为已审阅，未发送。" : action === "save" ? "人工内容已保存。" : action === "analyze" ? "AI 摘要已整理，请核对后再审阅。" : "数字草稿已生成，请核对并补充人工内容。";
      } catch (error) { state.error = error.code === "WEEKLY_EVIDENCE_CHANGED" ? "核查证据已更新，本报告保留生成时的版本。请生成新的周报草稿后再审阅；当前人工输入仍保留。" : error.status === 409 ? "服务端版本已更新。你的输入仍保留，请重新读取并核对后再提交。" : error.message; }
      finally { state.busy = ""; renderAll(); }
    }
    async function findingAction(action, key) {
      const finding = state.findings.get(key), ui = findingUi(key);
      if (!finding || ui.busy || state.demo || inspector.demo && !root) return;
      if (action === "reload-finding") {
        ui.busy = "reload"; ui.error = ""; renderAll();
        try {
          const result = await api(`/production-findings/${encodeURIComponent(key)}`);
          remember([result.finding]); ui.draftRevision = result.finding.revision; ui.conflict = false;
          ui.notice = "已读取最新案例，人工输入仍保留。请对照新证据核对后再保存。";
        } catch (error) { ui.error = error.message; }
        finally { ui.busy = ""; renderAll(); }
        return;
      }
      if (action === "analyze-finding" && !state.aiAvailable) return;
      const draft = ui.draft || feedbackDraft(finding);
      if (action === "feedback" && !draft.note.trim()) { ui.error = "请填写核实说明和依据。"; ui.feedbackOpen = true; renderAll(); return; }
      ui.busy = action === "feedback" ? "feedback" : "analyze"; ui.error = ""; ui.notice = ""; renderAll();
      try {
        const result = await post(`/production-findings/${encodeURIComponent(key)}/${action === "feedback" ? "feedback" : "analyze"}`, action === "feedback" ? { revision: ui.draftRevision ?? finding.revision, ...draft } : {});
        if (action === "feedback") { remember([result.finding]); ui.draft = null; ui.draftRevision = null; ui.notice = "核实结果已保存；原始报工未修改。"; }
        else ui.analysis = result.analysis;
      } catch (error) { ui.conflict = error.status === 409; ui.error = ui.conflict ? "此案例已被更新。输入已保留，请重新读取案例后核对。" : error.message; }
      finally { ui.busy = ""; renderAll(); }
    }
    async function inspect() {
      if (!inspector.context || inspector.loading || inspector.demo) return;
      const generation = ++inspector.generation, context = inspector.context;
      const controller = new AbortController(); inspector.controller?.abort(); inspector.controller = controller;
      inspector.loading = true; inspector.error = ""; renderInspector();
      try {
        const result = await api("/production-findings/inspect", { method: "POST", body: JSON.stringify(context), signal: controller.signal });
        if (generation !== inspector.generation) return;
        remember(result.findings); inspector.keys = list(result.findings).map((item) => item.key); inspector.loaded = true;
        state.aiAvailable = result.aiAvailable === true; inspector.warnings = list(result.warnings); inspector.scope = result.scope || "";
      } catch (error) { if (generation === inspector.generation && error.name !== "AbortError") inspector.error = error.message; }
      finally { if (generation === inspector.generation) { inspector.loading = false; renderInspector(); } }
    }
    function bind(container) {
      if (container.dataset.insightsBound) return;
      container.dataset.insightsBound = "true";
      const updateField = (event) => {
        const field = event.target.dataset?.weeklyField, findingField = event.target.dataset?.findingField;
        if (field === "startDate") state.startDate = event.target.value;
        else if (["managementNote", "coordination"].includes(field) && state.report?.status === "DRAFT") {
          const draft = draftFor(); draft[field] = event.target.value; draft.dirty = true;
          // Editing must not rebuild the active textarea or move its caret.
          root.querySelector('[data-insight-action="save"]').disabled = false;
          root.querySelector('[data-insight-action="review"]').disabled = true;
          root.querySelector('[data-insight-action="analyze-report"]').disabled = true;
          root.querySelector('[data-insight-action="print"]').disabled = true;
          root.querySelector(".pi-report-actions > span").textContent = "有未保存的人工内容";
        }
        if (findingField) {
          const key = event.target.dataset.key, finding = state.findings.get(key), ui = findingUi(key);
          if (!finding) return;
          ui.draft ||= feedbackDraft(finding);
          ui.draftRevision ??= finding.revision; ui.draft[findingField] = event.target.value; ui.feedbackOpen = true;
        }
      };
      container.addEventListener("input", updateField);
      container.addEventListener("change", (event) => {
        if (event.target.dataset?.weeklyField === "selected") void loadReport(event.target.value);
        else updateField(event);
      });
      container.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-insight-action]"); if (!button || button.disabled) return;
        const action = button.dataset.insightAction;
        if (action === "generate" || action === "save" || action === "review") await reportAction(action);
        else if (action === "analyze-report") await reportAction("analyze");
        else if (action === "refresh-list") await refreshList();
        else if (action === "reload-report") { if (window.confirm?.("重新读取会放弃本份周报尚未保存的人工输入，是否继续？")) await loadReport(state.report.id, { discardDraft: true }); }
        else if (["analyze-finding", "feedback", "reload-finding"].includes(action)) await findingAction(action, button.dataset.key);
        else if (action === "inspect") await inspect();
        else if (action === "print") window.print?.();
        else if (action === "copy-question") {
          const text = `请根据周报 ${state.report?.id || ""} 的证据，分析最需要核实的事项，并说明数据范围。`;
          try { await window.navigator.clipboard.writeText(text); state.notice = "追问已复制，可到首页粘贴后发送。"; } catch { state.notice = `请复制到首页提问：${text}`; } render();
        }
      });
    }
    async function mount(container, { demo = false, reportId = "" } = {}) {
      root = container; if (!root) return;
      state.demo = demo; root.dataset.mounted = "true"; bind(root);
      if (demo && !state.report) { const report = demoReport(); state.reports = [report]; acceptReport(report); state.initialized = true; }
      render();
      if (!demo && !state.initialized) { await refreshList(); if (reportId || !state.report && state.reports[0]) await loadReport(reportId || state.reports[0].id); }
      else if (!demo && reportId && reportId !== state.report?.id) await loadReport(reportId);
    }
    function mountInspector(container, context, { demo = false } = {}) {
      inspectorRoot = container;
      if (!container) { inspector.controller?.abort(); inspector.generation++; inspector.loading = false; return; }
      const key = JSON.stringify(context);
      if (inspector.key !== key) { inspector.controller?.abort(); Object.assign(inspector, { key, context, keys: [], loading: false, loaded: false, error: "", warnings: [], scope: "", generation: inspector.generation + 1 }); }
      inspector.demo = demo; bind(container); renderInspector();
    }
    return { mount, mountInspector, refreshList, loadReport, reportAction, findingAction, inspect };
  }
  function demoReport() {
    const evidence = [{ source: "演示工序快照", projectCode: "DEMO-WEEK-01", taskId: 91001, plannedAmount: 100, reportedGoodAmount: 118, asOf: "2026-10-22T03:00:00Z", scope: "虚构样例，不是生产数据", completeness: "snapshot" }];
    const finding = { key: "demo:overproduction", kind: "OVERPRODUCTION", title: "缝制工序累计报工超过计划，需核实原因", category: "data", projectCode: "DEMO-WEEK-01", taskId: 91001, facts: ["演示工序计划 100 件，累计良品 118 件。"], possibleCauses: ["可能是正常超产或计划未更新，尚未核实。"], nextChecks: ["核对计划版本与相关报工记录。"], evidence, status: "NEW", revision: 1 };
    return { id: "demo-weekly", status: "DRAFT", revision: 1, createdAt: "2026-10-22T03:00:00Z", managementNote: "本周生产持续推进。先核实超计划记录，再确认需要协调的事项。", coordination: "请相关负责人核对计划版本；此处为演示说明。", narrative: null, snapshot: { period: { label: "2026.10.12 — 10.18", startDate: "2026-10-12", endDate: "2026-10-18", start: "2026-10-12T00:00:00+08:00", end: "2026-10-19T00:00:00+08:00", isPartial: false }, generatedAt: "2026-10-22T03:00:00Z", mode: "demo", metrics: { current: { complete: true, recordCount: 42, approvedRecordCount: 38, unknownApprovalCount: 2 } }, coverage: { local: { quantityPendingCount: 3 }, warnings: ["全部内容为虚构样例，不代表实际产量或异常。"] }, progress: [{ projectCode: "DEMO-WEEK-01", processName: "缝制", plannedAmount: 100, reportedGoodAmount: 118, unit: "件", closed: false, processStatusDisplay: "进行中" }, { projectCode: "DEMO-WEEK-02", processName: "检验", plannedAmount: 80, reportedGoodAmount: 60, unit: "件", closed: false, processStatusDisplay: "进行中" }], findings: [finding], sources: evidence, limitations: ["仅用于界面演示，无真实模型调用，无生产数据写入。"] } };
  }
  window.BlacklakeInsights = { create, evidenceHtml, findingHtml, summaryHtml, dataDetailsHtml, demoReport };
})();
