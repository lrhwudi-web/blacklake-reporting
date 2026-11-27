import { AppError, assert } from "./errors.mjs";
import { agentOwner } from "./homepage-agent.mjs";
import { WeeklyStore } from "./weekly-store.mjs";
import { collectWeeklyData, resolveWeek, buildLocalFinding, buildTaskFinding } from "./weekly-data.mjs";
import { createInsightRunner, validateInsight } from "./insight-runtime.mjs";

const ROOT = "/v1/admin/weekly-reports";
const CASES = "/v1/admin/production-findings";
const closed = (finding) => ["CONFIRMED_NORMAL", "RESOLVED"].includes(finding.status);
const text = (value, length = 150) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, length);

function inputShape(input, allowed) {
  assert(input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every((key) => allowed.includes(key)),
    400, "INSIGHT_INVALID_INPUT", "请求参数不正确。");
  return input;
}

function sameOrigin(req) {
  assert(req.headers["sec-fetch-site"] !== "cross-site", 403, "INSIGHT_ORIGIN_REJECTED", "请从管理后台操作。");
  if (!req.headers.origin) return;
  let origin;
  try { origin = new URL(req.headers.origin); } catch { /* reject below */ }
  assert(origin && origin.host === req.headers.host, 403, "INSIGHT_ORIGIN_REJECTED", "请从管理后台操作。");
}

// Public responses use only our errors: upstream/provider exception bodies may
// contain credentials or private records and must never reach logs or clients.
async function bounded(work, signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); }),
      new Promise((_, reject) => {
        const fail = () => reject(new AppError(504, "INSIGHT_TIMEOUT", "本次处理已停止，已保存的草稿不受影响，请稍后重试。"));
        controller.signal.addEventListener("abort", fail, { once: true });
        if (controller.signal.aborted) fail();
        timer = setTimeout(() => controller.abort(), timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

export function createProductionInsights({ config, store, blacklake, runner, collect = collectWeeklyData, now = Date.now }) {
  const records = store.db ? new WeeklyStore(store.db) : null;
  const settings = config.agent || {};
  const aiAvailable = Boolean(settings.enabled && settings.apiKey && settings.model);
  const run = runner || (aiAvailable ? createInsightRunner({ config: settings }) : null);
  const active = new Set();
  const rates = new Map();

  function report(id) {
    const found = records.getReport(id);
    assert(found, 404, "WEEKLY_NOT_FOUND", "未找到这份周报。");
    return found;
  }
  function finding(key) {
    const found = records.getFinding(key);
    assert(found, 404, "FINDING_NOT_FOUND", "未找到这条核查事项。");
    return found;
  }
  function fresh(reportValue) {
    assert(reportValue.snapshot.findings.every((item) => records.getFinding(item.key)?.revision === item.revision),
      409, "WEEKLY_EVIDENCE_CHANGED", "异常核查进展已变化，请重新生成草稿后再审阅。");
  }
  async function expensive(owner, req, res, work) {
    const instant = now();
    for (const [key, entry] of rates) if (entry.until <= instant) rates.delete(key);
    assert(!active.has(owner) && active.size < 4, 429, "INSIGHT_BUSY", "已有生成或分析正在进行，请稍后重试。");
    const rate = rates.get(owner) || { count: 0, until: instant + 60_000 };
    assert(rate.count < 8 && rates.size < 2000, 429, "INSIGHT_RATE_LIMIT", "操作较频繁，请稍后重试。");
    rates.set(owner, { ...rate, count: rate.count + 1 });
    active.add(owner);
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnect);
    try { return await work(controller.signal); }
    finally { active.delete(owner); res.off("close", disconnect); }
  }
  async function explain(kind, evidence, signal) {
    assert(aiAvailable && run, 503, "INSIGHT_AI_UNAVAILABLE", "AI 尚未连接模型。可以继续查看事实、编辑和审阅草稿。");
    try {
      const output = await bounded((abortSignal) => run({ kind, evidence, signal: abortSignal }), signal,
        Math.min(settings.timeoutMs || 45_000, 60_000));
      return validateInsight(kind, output);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "INSIGHT_AI_FAILED", "AI 分析暂时不可用，事实与草稿已保留，请稍后再试。");
    }
  }

  return { records, async handle(req, res, url, { jsonBody, send }) {
    assert(records, 503, "INSIGHT_STORAGE_UNAVAILABLE", "周报存储暂时不可用。");
    // Existing admin authorization has already run. Do not accept a client name
    // as an audit actor; proxy calls must carry the authenticated session cookie.
    const actor = agentOwner(req, config);
    if (req.method !== "GET") sameOrigin(req);

    if (url.pathname === ROOT && req.method === "GET") {
      const status = url.searchParams.get("status") || undefined;
      assert(!status || ["DRAFT", "REVIEWED"].includes(status), 400, "INVALID_STATUS", "周报状态不正确。");
      return send(res, 200, { reports: records.listReports({ status, limit: 30 }), aiAvailable });
    }
    if (url.pathname === ROOT && req.method === "POST") {
      const input = inputShape(await jsonBody(req), ["startDate"]);
      const period = resolveWeek(input.startDate, now());
      const result = await expensive(actor, req, res, async (signal) => {
        let snapshot;
        try { snapshot = await bounded((abortSignal) => collect({ blacklake, store, startDate: period.startDate, now, signal: abortSignal }), signal, 90_000); }
        catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(502, "WEEKLY_QUERY_FAILED", "周数据暂时读取失败，未把失败当作零产量，请重试。");
        }
        signal.throwIfAborted();
        const observed = records.upsertFindings(snapshot.findings, { observedAt: snapshot.generatedAt });
        const history = records.reportFollowUps({ start: snapshot.period.start, end: snapshot.period.end, limit: 40 });
        const keys = new Set(observed.map((item) => item.key));
        const findings = [...observed, ...history.findings.filter((item) => !keys.has(item.key)).map((item) => ({ ...item,
          carriedForward: true, observationNote: "历史核查事项；本轮未重新取得对应业务证据，事实仍以最近观测时间为准。" }))];
        snapshot.coverage.followUps = { total: history.total, returned: history.findings.length, truncated: history.truncated,
          scope: "历史未结事项及所选周内留下人工反馈的事项；处理状态截至本次生成，不重建历史周末状态。" };
        if (history.truncated) snapshot.coverage.warnings.push("历史核查事项最多补充40项，完整数量见followUps范围，不代表全部事项均已展开。");
        snapshot.findings = findings;
        snapshot.risks = findings.filter((item) => !closed(item)).slice(0, 3);
        snapshot.handling = Object.fromEntries(["NEW", "INVESTIGATING", "CONFIRMED_NORMAL", "RESOLVED"]
          .map((status) => [status, findings.filter((item) => item.status === status).length]));
        const current = snapshot.metrics.current;
        snapshot.summary = [
          `${snapshot.coverage.current.complete ? "本期按创建时间取得" : "本期取数尚不完整，目前仅取得"}${current.recordCount}笔报工记录；记录数不等于成品产量。`,
          `本次展示的核查事项中，${snapshot.handling.NEW}项待核实、${snapshot.handling.INVESTIGATING}项核实中；这些是数据线索，尚不能判定生产异常。`,
          `已确认正常${snapshot.handling.CONFIRMED_NORMAL}项、已处理${snapshot.handling.RESOLVED}项；需要协调的事项由主管核对后填写。`
        ];
        snapshot.reviewPolicy = "当前为管理员人工审阅流程，尚无独立老板/主管权限；审阅后保存固定版本，不自动发送。";
        return records.createDraft({ snapshot, actor, coordination: "", narrative: null });
      });
      return send(res, 201, { report: result });
    }

    const reportMatch = url.pathname.match(/^\/v1\/admin\/weekly-reports\/([a-f0-9-]{36})(?:\/(review|analyze))?$/i);
    if (reportMatch) {
      const current = report(reportMatch[1]);
      if (!reportMatch[2] && req.method === "GET") return send(res, 200, { report: current, aiAvailable });
      if (!reportMatch[2] && req.method === "PATCH") {
        const input = inputShape(await jsonBody(req), ["revision", "coordination", "managementNote"]);
        return send(res, 200, { report: records.updateDraft(current.id, input, actor) });
      }
      if (reportMatch[2] === "review" && req.method === "POST") {
        const input = inputShape(await jsonBody(req), ["revision"]);
        fresh(current);
        return send(res, 200, { report: records.reviewReport(current.id, input, actor) });
      }
      if (reportMatch[2] === "analyze" && req.method === "POST") {
        const input = inputShape(await jsonBody(req), ["revision"]);
        assert(current.status === "DRAFT" && current.revision === input.revision, 409, "WEEKLY_CONFLICT", "草稿已变化，请刷新后重试。");
        fresh(current);
        const updated = await expensive(actor, req, res, async (signal) => {
          // The frozen report evidence is the only model context. No identities,
          // cookies, arbitrary DB access or write tools enter the provider call.
          const evidence = modelReportEvidence(current);
          const narrative = await explain("weekly", evidence, signal);
          signal.throwIfAborted();
          fresh(current);
          return records.setNarrative(current.id, { revision: input.revision, narrative: { ...narrative,
            limitations: ["AI 解读需人工核实；数字与状态以本页程序统计和证据为准。"],
            generatedAt: new Date(now()).toISOString(), model: settings.model } }, actor);
        });
        return send(res, 200, { report: updated });
      }
    }

    if (url.pathname === CASES && req.method === "GET") {
      const reportId = url.searchParams.get("reportId");
      const rows = reportId ? report(reportId).snapshot.findings.map((item) => records.getFinding(item.key)).filter(Boolean)
        : records.listFindings({ limit: 200 });
      return send(res, 200, { findings: rows, scope: reportId ? "本报告所引用事项的最新核查状态" : "最近 200 条已发现事项", aiAvailable });
    }
    if (url.pathname === `${CASES}/inspect` && req.method === "POST") {
      const input = inputShape(await jsonBody(req), ["assignmentId", "taskId", "projectCode"]);
      assert((typeof input.assignmentId === "string" && /^[\w-]{1,100}$/.test(input.assignmentId)) ||
        (Number.isSafeInteger(input.taskId) && input.taskId > 0 && typeof input.projectCode === "string" && input.projectCode.length <= 100),
      400, "INVALID_INSPECTION", "请选择具体任务或工序。");
      const rows = await expensive(actor, req, res, async (signal) => {
        const assignment = input.assignmentId ? store.assignmentById(input.assignmentId) : null;
        assert(!input.assignmentId || assignment, 404, "ASSIGNMENT_NOT_FOUND", "任务不存在。");
        const taskId = assignment?.taskId || input.taskId;
        const projectCode = assignment?.projectCode || input.projectCode;
        const candidates = [];
        if (assignment) { const item = buildLocalFinding(assignment, now()); if (item) candidates.push(item); }
        let sourceUnavailable = false;
        try {
          const tasks = await bounded(() => blacklake.listProjectTasks(assignment?.projectId ? { projectIds: [assignment.projectId] } : { projectCodes: [projectCode] }, { deadline: Date.now() + 12_000 }), signal, 15_000);
          const task = tasks.find((item) => item.taskId === taskId && item.projectCode === projectCode);
          if (task) { const item = buildTaskFinding(task, now()); if (item) candidates.push(item); }
        } catch { sourceUnavailable = true; }
        signal.throwIfAborted();
        records.upsertFindings(candidates, { observedAt: new Date(now()).toISOString() });
        const all = records.listFindings({ taskId, projectCode, limit: 200 });
        return { findings: all.filter((item) => (item.taskId === taskId && item.projectCode === projectCode) ||
          (assignment && (item.assignmentId === assignment.id || item.evidence?.some((e) => e.assignmentId === assignment.id)))),
          warnings: [...(sourceUnavailable ? ["本次上游查询未完成，以下仅展示本地或历史已发现事项。"] : []),
            ...(all.length === 200 ? ["本工序已发现事项返回达到200条上限，可能仍有更早事项未展示。"] : [])],
          scope: "当前工序及已发现的相关事项；疑似重复由按周取数发现，不代表完整历史排查。" };
      });
      return send(res, 200, { ...rows, aiAvailable });
    }
    const findingMatch = url.pathname.match(/^\/v1\/admin\/production-findings\/([^/]+)(?:\/(feedback|analyze))?$/);
    if (findingMatch) {
      let key;
      try { key = decodeURIComponent(findingMatch[1]); } catch { throw new AppError(400, "INVALID_FINDING", "核查事项编号不正确。"); }
      const current = finding(key);
      if (!findingMatch[2] && req.method === "GET") return send(res, 200, { finding: current, aiAvailable });
      if (findingMatch[2] === "feedback" && req.method === "POST") {
        const input = inputShape(await jsonBody(req), ["revision", "status", "reason", "note"]);
        return send(res, 200, { finding: records.feedbackFinding(key, input, actor) });
      }
      if (findingMatch[2] === "analyze" && req.method === "POST") {
        inputShape(await jsonBody(req), []);
        const analysis = await expensive(actor, req, res, async (signal) => {
          const result = await explain("finding", modelFindingEvidence(current), signal);
          assert(finding(key).revision === current.revision, 409, "FINDING_CONFLICT", "核查信息已变化，请刷新后重新分析。");
          return { ...result, facts: current.facts, evidence: current.evidence, generatedAt: new Date(now()).toISOString(),
            mode: "AI_DRAFT", evidenceVersion: current.evidenceVersion, revision: current.revision,
            warning: "可能原因尚未确认；反馈仅更新本地核查台账，不修改黑湖记录或员工任务。" };
        });
        return send(res, 200, { analysis });
      }
    }
    throw new AppError(404, "NOT_FOUND", "接口不存在。");
  } };
}

export function modelFindingEvidence(item) {
  return { key: text(item.key), title: text(item.title), kind: text(item.kind), category: text(item.category),
    facts: item.facts, possibleCauses: item.possibleCauses, nextChecks: item.nextChecks, evidence: item.evidence,
    status: item.status, reason: item.reason, note: text(item.note, 600), evidenceVersion: item.evidenceVersion,
    observedAt: item.observedAt, carriedForward: Boolean(item.carriedForward), observationNote: item.observationNote };
}

export function modelReportEvidence(item) {
  const snapshot = item.snapshot;
  return { period: snapshot.period, previousPeriod: snapshot.previousPeriod, generatedAt: snapshot.generatedAt,
    mode: snapshot.mode, coverage: snapshot.coverage, metrics: snapshot.metrics,
    progress: snapshot.progress.slice(0, 20), findings: snapshot.findings.slice(0, 20).map(modelFindingEvidence),
    handling: snapshot.handling, limitations: [...snapshot.limitations, "AI 上下文仅含前 20 个进展与核查事项，完整数据在周报展开查看。"],
    coordination: text(item.coordination, 2000), managementNote: text(item.managementNote, 2000) };
}
