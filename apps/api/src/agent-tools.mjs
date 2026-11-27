import { tool } from "ai";
import { z } from "zod";
import { AdminSync } from "./admin-sync.mjs";
import { FLOOR3_MACHINE_IDS, FLOOR8_UNIT_IDS, unitState } from "./dispatch.mjs";

const LINKS = Object.freeze({ orders: "/admin?view=report", production: "/admin?view=production", audit: "/admin?view=audit" });
const MAX_PROCESSES = 60;
const MAX_LOCAL_RECORDS = 300;
const MAX_UNIT_ASSIGNMENTS = 8;
const MAX_SCENE_ASSIGNMENTS = 40;
const TEXT_LIMIT = 120;
const CLOSED = /^(已完成|完成|已完工|完工|已结束|已关闭)$/;
const OPEN = /^(未开始|待开始|待开工|进行中|生产中|已开始|已开工)$/;
const safeText = (value, limit = TEXT_LIMIT) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const finiteQuantity = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const unique = (values) => [...new Set(values)];
const iso = (value) => { if (value === null || value === undefined || value === "") return null; const stamp = new Date(value); return Number.isFinite(stamp.getTime()) ? stamp.toISOString() : null; };

// Legacy task normalization used zero for missing fields. Only explicit presence
// metadata may establish an observed zero; old snapshots stay conservative.
function taskQuantity(task, key) {
  const value = finiteQuantity(task[key]);
  if (task.quantityPresence?.[key] === false) return null;
  if (value === 0 && task.quantityPresence?.[key] !== true) return null;
  return value;
}

function processRow(task) {
  const plannedAmount = taskQuantity(task, "plannedAmount");
  const reportedGoodAmount = taskQuantity(task, "reportedGoodAmount");
  const reportedDefectAmount = taskQuantity(task, "reportedDefectAmount");
  const sequence = taskQuantity(task, "sequence");
  const display = safeText(task.processStatusDisplay);
  const status = finiteQuantity(task.processStatus);
  const closed = status === 20 || CLOSED.test(display) ? true : OPEN.test(display) || status === 10 ? false : null;
  return {
    taskId: positiveId(task.taskId), sequence, processName: safeText(task.processName), processCode: safeText(task.processCode),
    plannedAmount, reportedGoodAmount, reportedDefectAmount,
    remainingToPlan: plannedAmount !== null && reportedGoodAmount !== null ? Math.max(0, plannedAmount - reportedGoodAmount) : null,
    quantityCompletionPercent: plannedAmount > 0 && reportedGoodAmount !== null ? Math.round(reportedGoodAmount / plannedAmount * 1000) / 10 : null,
    processStatus: status, processStatusDisplay: display, closed,
    dueDate: safeText(task.dueDate, 20), unit: safeText(task.unit, 20)
  };
}

function assignmentRow(item) {
  // Identity, phone, session credentials and free-form operator remarks are not
  // needed to answer production questions and never enter model context.
  return {
    assignmentId: safeText(item.id, 80), projectId: positiveId(item.projectId), projectCode: safeText(item.projectCode),
    taskId: positiveId(item.taskId), productName: safeText(item.productName), processName: safeText(item.processName),
    stationName: safeText(item.stationName), machineId: safeText(item.machineId, 30), status: safeText(item.status, 30),
    targetQuantity: finiteQuantity(item.targetQuantity), startedAt: safeText(item.startedAt, 40),
    quantityPending: item.status === "QUANTITY_PENDING",
    endedAt: safeText(item.endedAt, 40)
  };
}

function withBudget(work, { signal, timeoutMs }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("查询已停止。"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, Object.assign(new Error("查询已停止。"), { name: "AbortError" }));
    const timer = setTimeout(() => finish(reject, Object.assign(new Error("查询超时。"), { code: "AGENT_TOOL_TIMEOUT" })), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Existing shared cache refreshes own their upstream lifetime; ending this
    // wait does not claim to cancel an upstream request already in flight.
    Promise.resolve().then(work).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

/** Read-only tools. The authenticated route must authorize the caller first. */
export function createProductionTools({ blacklake, store, adminSync, weeklyStore, now = Date.now, timeoutMs = 12_000 }) {
  const sync = adminSync || new AdminSync(blacklake, { now });
  const budget = Math.min(30_000, Math.max(1, Number(timeoutMs) || 12_000));
  const mode = ["live", "mock"].includes(blacklake?.config?.mode) ? blacklake.config.mode : "unknown";
  const modeWarnings = mode === "live" ? [] : [mode === "mock" ? "当前为模拟数据，不能作为正式生产事实。" : "当前数据模式未确认，不能作为正式生产事实。"];

  function result({ title, url = LINKS.orders, source, scope, completeness, warnings = [], freshness = null, data, status = "ok" }) {
    const queriedAt = iso(now());
    const combined = unique([...modeWarnings, ...warnings]);
    const cacheNote = freshness ? `；快照状态 ${freshness.status}，更新时间 ${freshness.updatedAt || "未知"}，年龄 ${freshness.ageSeconds ?? "未知"} 秒` : "";
    return {
      status, source, mode, queriedAt, scope, completeness, warnings: combined, freshness, dataTrust: "untrusted_business_data",
      sourceLinks: [{ title, url }],
      sources: [{ title, url, scope: scope + cacheNote, queriedAt, completeness, warnings: combined }], data
    };
  }

  function define(description, schema, execute) {
    return tool({ description, inputSchema: schema, execute: async (input, options = {}) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return result({ title: "生产查询", source: "application", scope: "未执行查询", completeness: "不可用", status: "invalid_input", warnings: ["查询参数无效，请使用工具定义的工单、SKU 或楼层参数。"], data: null });
      try { return await withBudget(() => execute(parsed.data), { signal: options.abortSignal, timeoutMs: budget }); }
      catch (error) {
        if (error?.name === "AbortError") throw error;
        return result({ title: "生产查询", source: "application", scope: "本次查询未完成", completeness: "不可用", status: "unavailable",
          warnings: [error?.code === "AGENT_TOOL_TIMEOUT" ? "本次查询超过等待时间，结果未知；未将失败当作零条记录。" : "暂时无法取得业务数据，结果未知；请稍后重试或打开管理页面核对。"], data: null });
      }
    } });
  }

  const searchSchema = z.object({ query: z.string().trim().min(1).max(100), kind: z.enum(["sku", "workOrder"]), limit: z.number().int().min(1).max(20).default(10) }).strict();
  const progressSchema = z.object({ projectId: z.number().int().positive().safe() }).strict();
  const floorSchema = z.object({ floor: z.enum(["all", "3", "8"]).default("all") }).strict();
  const reviewSchema = z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict();
  const ruleSchema = z.object({ topic: z.enum(["all", "quantity", "quantityPending", "needsReview", "time", "scope"]).default("all") }).strict();

  return {
    ...(weeklyStore ? { readWeeklyReport: define("读取已保存的老板生产周报与最新核查进展。只读固定快照，不生成/审阅周报。省略reportId时返回最近一份及候选列表；指定编号可展开。数字只能用返回的程序统计；比较上周必须取得同口径完整数据。", z.object({ reportId: z.string().uuid().optional() }).strict(), async ({ reportId }) => {
      const candidates = weeklyStore.listReports({ limit: 10 });
      const report = reportId ? weeklyStore.getReport(reportId) : candidates[0] ? weeklyStore.getReport(candidates[0].id) : null;
      if (!report) return result({ title: "生产周报", url: "/admin?view=weekly", source: "local_weekly_report", scope: "已保存周报",
        completeness: "未找到周报", warnings: ["请先在生产周报页面选择周范围生成草稿；最近记录不能代替完整周数据。"], data: { reports: candidates.map(({ id, status, createdAt }) => ({ id, status, createdAt })), report: null } });
      const snapshot = report.snapshot;
      const currentFindings = snapshot.findings.slice(0, 30).map((entry) => {
        const current = weeklyStore.getFinding(entry.key) || entry;
        return { key: current.key, title: current.title, kind: current.kind, projectCode: current.projectCode, status: current.status,
          facts: current.facts, possibleCauses: current.possibleCauses, nextChecks: current.nextChecks, evidence: current.evidence,
          reason: current.reason, note: safeText(current.note, 600), updatedAt: current.updatedAt,
          changedSinceReport: entry.revision !== current.revision, observedAt: current.observedAt,
          carriedForward: Boolean(entry.carriedForward), observationNote: entry.observationNote };
      });
      return result({ title: "生产周报与依据", url: `/admin?view=weekly&reportId=${report.id}`, source: "local_weekly_report",
        scope: `${snapshot.period.label || snapshot.period.startDate}；按报工创建时间；生成于 ${snapshot.generatedAt}；${report.status === "REVIEWED" ? "已人工审阅" : "待审阅草稿"}`,
        completeness: snapshot.coverage.current.complete ? "本次周范围分页读取完成，非上游一致性快照" : "周数据覆盖不足",
        warnings: [...snapshot.limitations, ...(snapshot.coverage.warnings || []),
          ...(snapshot.mode !== "live" ? ["该周报来自模拟或未知模式，不能作为正式生产事实。"] : []),
          "工序状态为生成时状态，不是历史周末状态；无真实交期依据时不能判断延期。",
          ...(currentFindings.some((item) => item.changedSinceReport) ? ["部分核查状态在周报生成后已变化，当前返回了最新进展。"] : []),
          ...(snapshot.findings.length > 30 || snapshot.progress.length > 25 ? ["当前工具最多展开30项核查与25条工序；其余请打开周报。"] : [])],
        data: { reports: candidates.map(({ id, status, createdAt }) => ({ id, status, createdAt })), reportId: report.id,
          status: report.status, generatedAt: snapshot.generatedAt, reviewedAt: report.reviewedAt, period: snapshot.period,
          coverage: snapshot.coverage, metrics: snapshot.metrics, progress: snapshot.progress.slice(0, 25), findings: currentFindings,
          coordination: safeText(report.coordination, 2000), managementNote: safeText(report.managementNote, 2000),
          // AI prose is deliberately excluded: tool facts must not recursively
          // promote a previous model interpretation into production evidence.
          narrativeIncluded: false } });
    }) } : {}),
    searchWorkOrders: define("按完整 SKU 或完整工单编号查找工单，返回 projectId 供后续进度查询。SKU 目录范围有限，未命中不等于工单不存在。", searchSchema, async ({ query, kind, limit }) => {
      const rows = kind === "sku" ? await blacklake.searchWorkOrdersBySku(query)
        : await blacklake.listProjectTasks({ projectCodes: [query] }, { deadline: Date.now() + budget });
      if (!Array.isArray(rows)) throw new Error("Invalid work-order response");
      const expected = query.normalize("NFKC").trim().toLocaleUpperCase("en-US");
      const projects = new Map();
      for (const row of rows) {
        if (!positiveId(row.projectId)) continue;
        if (kind === "workOrder" && String(row.projectCode || "") !== query) continue;
        if (kind === "sku" && String(row.productCode || "").normalize("NFKC").trim().toLocaleUpperCase("en-US") !== expected) continue;
        projects.set(Number(row.projectId), { projectId: Number(row.projectId), projectCode: safeText(row.projectCode), productCode: safeText(row.productCode), productName: safeText(row.productName) });
      }
      const values = [...projects.values()];
      const year = new Date(now()).getUTCFullYear();
      const cache = blacklake.workOrderCatalog;
      const updatedAt = kind === "sku" && Number.isFinite(cache?.expiresAt) ? iso(cache.expiresAt - 600_000) : null;
      const ageSeconds = updatedAt ? Math.max(0, Math.floor((Number(now()) - Date.parse(updatedAt)) / 1000)) : null;
      const freshness = kind === "sku" ? { status: mode === "mock" ? "mock" : updatedAt ? (cache.expiresAt > Number(now()) ? "cached" : "stale") : "unknown", updatedAt, ageSeconds, cacheWindowSeconds: 600 }
        : { status: "queried_or_cached", updatedAt: null, ageSeconds: null, cacheWindowSeconds: 30 };
      const scope = kind === "sku" ? `SKU 精确匹配；目录仅覆盖工单编号包含 ${year} 或 ${year - 1} 的工单` : `完整工单编号 ${safeText(query)} 的工序反查；含已关闭工序`;
      const warnings = kind === "sku" ? ["特殊编号或历史工单可能不在 SKU 目录；没有匹配不能认定工单不存在。"] : ["相同工单编号可能对应多个 projectId，请确认目标工单；没有工序不能认定工单不存在。"];
      if (freshness.status === "stale") warnings.push("目录缓存已到刷新时间，当前仍使用上一份目录；结果可能滞后。");
      if (freshness.status === "unknown") warnings.push("目录快照时间不可取得，不能声称数据刚刚更新。");
      if (values.length > limit) warnings.push(`匹配 ${values.length} 张，仅返回前 ${limit} 张。`);
      return result({ title: "工单查询", source: "blacklake", scope, completeness: values.length > limit ? "返回列表已截断；查询范围有限" : "已完成本次限定范围查询；不代表全部工单", warnings, freshness,
        data: { matchCount: values.length, returnedCount: Math.min(values.length, limit), workOrders: values.slice(0, limit) } });
    }),

    getWorkOrderProgress: define("按已确认的 projectId 查询完整工序路线和各工序累计良品。程序计算单工序完成比例，不跨工序加总；数量达标不等于工序关闭或客户交付。", progressSchema, async ({ projectId }) => {
      const snapshots = await sync.processes([{ projectId }]);
      const snapshot = snapshots?.[0];
      if (!snapshot || !Array.isArray(snapshot.tasks)) throw new Error("Invalid process snapshot");
      const snapshotStatus = ["fresh", "stale", "empty", "unavailable"].includes(snapshot.sync?.status) ? snapshot.sync.status : "unavailable";
      const updatedAt = iso(snapshot.sync?.updatedAt);
      const freshness = { status: snapshotStatus, updatedAt, ageSeconds: updatedAt ? Math.max(0, Math.floor((Number(now()) - Date.parse(updatedAt)) / 1000)) : null, cacheWindowSeconds: 60, upstreamCacheWindowSeconds: 30 };
      const warnings = ["各工序累计良品不能相加为成品产量；达到计划数量不等于工序关闭或客户交付。", "快照最多复用 60 秒，底层工序查询另可复用 30 秒；查询时间不等于黑湖更新时间。"];
      if (snapshotStatus === "stale") warnings.push("本次黑湖同步失败，展示上次完整快照，不能作为当前实时进度。");
      if (["empty", "unavailable"].includes(snapshotStatus)) return result({ title: "工单工序进度", source: "blacklake", scope: `工单 projectId=${projectId}；完整分页工序查询`, completeness: snapshotStatus === "empty" ? "空结果；工艺完整性未知" : "不可用", warnings: [...warnings, snapshotStatus === "empty" ? "未返回工序，不能认定未开工、已完成或工单不存在。" : "工序同步不可用，不能计算进度或将未知当作零。"], freshness, status: snapshotStatus === "unavailable" ? "unavailable" : "ok", data: { projectId, processes: [], summary: null } });
      const tasks = new Map();
      const conflicting = new Set();
      let excluded = 0;
      for (const task of snapshot.tasks) {
        if (Number(task.projectId) !== projectId || !positiveId(task.taskId)) { excluded++; continue; }
        const normalized = processRow(task);
        const previous = tasks.get(normalized.taskId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) conflicting.add(normalized.taskId);
        else tasks.set(normalized.taskId, normalized);
      }
      for (const id of conflicting) tasks.delete(id);
      const processes = [...tasks.values()].sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity) || a.taskId - b.taskId);
      const routeKnown = processes.length > 0 && !excluded && !conflicting.size;
      if (excluded || conflicting.size) warnings.push("返回工序存在关联缺失或同一任务数据冲突，已排除相关记录；路线完整性未知。");
      if (processes.some((row) => row.plannedAmount === null || row.reportedGoodAmount === null)) warnings.push("部分数量未知或旧快照无法区分缺失与零，已保留为 null，不按零计算。");
      if (processes.length > MAX_PROCESSES) warnings.push(`工序共 ${processes.length} 道，仅展示前 ${MAX_PROCESSES} 道；汇总按全部已取得工序计算。`);
      const sequenceKnown = routeKnown && processes.every((row) => row.sequence > 0);
      const lastSequence = sequenceKnown ? Math.max(...processes.map((row) => row.sequence)) : null;
      const lastRows = lastSequence === null ? [] : processes.filter((row) => row.sequence === lastSequence);
      const last = lastRows.length === 1 ? lastRows[0] : null;
      if (!last) warnings.push("末道工序不唯一或顺序不明确，不推断整单数量进度。");
      const allClosed = !routeKnown || processes.some((row) => row.closed === null) ? null : processes.every((row) => row.closed);
      return result({ title: "工单工序进度", source: "blacklake", scope: `工单 projectId=${projectId}；全部工序，含已关闭工序；数量是工序累计值`, completeness: !routeKnown ? "部分数据；路线完整性未知" : snapshotStatus === "stale" ? "上次完整分页快照；当前可能滞后" : processes.length > MAX_PROCESSES ? "完整分页快照；展示列表已截断" : "完整分页工序快照", warnings, freshness,
        data: { projectId, processes: processes.slice(0, MAX_PROCESSES), summary: { processCount: processes.length, closedProcessCount: processes.filter((row) => row.closed === true).length,
          allProcessesClosed: allClosed, delivered: null, totalFinishedGoods: null,
          lastProcessQuantityProgress: last ? { taskId: last.taskId, plannedAmount: last.plannedAmount, reportedGoodAmount: last.reportedGoodAmount, quantityCompletionPercent: last.quantityCompletionPercent } : null } } });
    }),

    getProductionSnapshot: define("读取本系统已配置的 3 楼机器、8 楼工位活动任务和位置状态，不代表设备在线、人员到岗或库存。仅读取本地记录。", floorSchema, async ({ floor }) => {
      const ids = [...(floor !== "8" ? FLOOR3_MACHINE_IDS : []), ...(floor !== "3" ? FLOOR8_UNIT_IDS : [])];
      let remaining = MAX_SCENE_ASSIGNMENTS;
      const units = ids.map((id) => {
        const aliases = id.startsWith("3F-") ? [id, `MACHINE-${id.slice(-2)}`, id.slice(-2)] : [id];
        const found = new Map();
        for (const alias of aliases) for (const assignment of store.activeAssignmentsByUnit(alias)) {
          if (["READY", "IN_PROGRESS", "REPORTING", "NEEDS_REVIEW"].includes(assignment.status)) found.set(assignment.id, assignment);
        }
        const assignments = [...found.values()];
        const selected = assignments.slice(0, Math.min(MAX_UNIT_ASSIGNMENTS, remaining));
        remaining -= selected.length;
        return { id, state: unitState(assignments), assignmentCount: assignments.length, assignments: selected.map(assignmentRow), truncated: assignments.length > selected.length };
      });
      const warnings = ["位置无活动任务只表示本系统未记录占用，不等于设备在线、员工到岗或可立即生产。", "完工待核量记录已经释放占用，不在当前活动任务中；本查询不能用于判断是否仍有待核量记录。", "4 楼尚未接入库存；本查询不包含实际库存或未配置的位置。"];
      if (units.some((unit) => unit.truncated)) warnings.push(`每个位置最多展示 ${MAX_UNIT_ASSIGNMENTS} 笔、全部位置合计最多 ${MAX_SCENE_ASSIGNMENTS} 笔活动任务；位置任务数包含全部已查到记录。`);
      return result({ title: "现场生产位置", url: LINKS.production, source: "local_assignments", scope: `本系统已配置${floor === "all" ? " 3 楼和 8 楼" : ` ${floor} 楼`}位置；当前本地活动任务`, completeness: "已配置位置范围完整；非全厂或设备遥测", warnings,
        freshness: { status: "current_local", updatedAt: iso(now()), ageSeconds: 0, cacheWindowSeconds: 0 },
        data: { unitCount: units.length, stateCounts: Object.fromEntries(["available", "scheduled", "running", "attention"].map((state) => [state, units.filter((unit) => unit.state === state).length])), units, warehouse: { connected: false } } });
    }),

    listNeedsReview: define("只读查找本地最近 300 笔任务中的 NEEDS_REVIEW。该状态是黑湖写入结果不确定，不能自动重试、取消或判定未写入。", reviewSchema, async ({ limit }) => {
      const scanned = store.listAssignments(MAX_LOCAL_RECORDS + 1);
      if (!Array.isArray(scanned)) throw new Error("Invalid assignment response");
      const rows = scanned.slice(0, MAX_LOCAL_RECORDS);
      const reviews = rows.filter((row) => row.status === "NEEDS_REVIEW");
      const warnings = ["NEEDS_REVIEW 表示黑湖写入结果不确定，不是明确失败；应核对黑湖原始报工，不能自动重试或取消。", "仅扫描按发布时间排序的最近 300 笔本地任务；较早的待核对任务可能不在范围。"];
      if (scanned.length > MAX_LOCAL_RECORDS) warnings.push("本地任务多于 300 笔，本次查询未覆盖全部历史。");
      if (reviews.length > limit) warnings.push(`范围内有 ${reviews.length} 笔待核对，仅返回前 ${limit} 笔。`);
      return result({ title: "待核对报工", url: LINKS.audit, source: "local_assignments", scope: "本地按发布时间排序最近 300 笔任务；非黑湖完整报工历史", completeness: scanned.length > MAX_LOCAL_RECORDS || reviews.length > limit ? "限定范围；返回可能截断" : "已扫描当前取得的本地任务；非黑湖全量", warnings,
        freshness: { status: "current_local", updatedAt: iso(now()), ageSeconds: 0, cacheWindowSeconds: 0 },
        data: { scannedCount: rows.length, needsReviewInScope: reviews.length, returnedCount: Math.min(reviews.length, limit), assignments: reviews.slice(0, limit).map(assignmentRow), automaticRetryAllowed: false } });
    }),

    explainProductionRules: define("解释本系统已确定的报工数量、待核对、工时和数据范围规则，不读取客户记录，也不执行任何操作。", ruleSchema, async ({ topic }) => {
      const rules = {
        quantity: ["每道工序按其累计良品与计划数比较；不同工序不能相加为成品产量。", "达到计划数量不等于工序关闭或交付；工序关闭以黑湖状态为准。", "8 楼派单结束只登记各人的参与时间，数量待核对，暂不向黑湖提交产量；同批多人不得各自计入整批数量。", "参考批次数不等于个人完成量；黑湖累计数与本地已同步记录不得重复叠加。", "未知数量不能当作零；工艺顺序缺失或末道并行时不推断整单进度。"],
        needsReview: ["NEEDS_REVIEW 表示提交结果不确定，可能已经写入黑湖；禁止当作失败自动重试。", "核对黑湖原始记录后由授权人员处理；Agent 首版仅读取和解释。"],
        quantityPending: ["QUANTITY_PENDING 表示数量尚未核清，已登记本地完工时间，但没有向黑湖提交产量。", "已释放人员和工位占用，员工可以继续接单；原任务仍保留在待核量记录中。", "参考批次数不能当作个人完成量或已产量；后续核量提交尚未实现。"],
        time: ["生产历时由服务器起止时间计算并扣除每日 12:00–13:30 午休，但仍可能包含跨日等待或临时停工。", "生产历时不是净作业工时，不能直接用于人员效率排名。"],
        scope: ["后台聚合范围为本地最近 300 笔及黑湖近两天最多 2000 笔，不是全厂完整历史。", "SKU 目录限定工单编号包含今年或去年的记录；特殊编号可能查不到。", "3 楼、8 楼位置来自本地任务；4 楼是仓库示意，未连接真实库存。", "当前 Agent 不派工、不修改权限、不提交报工、不处理核对结果。"]
      };
      return result({ title: "生产口径说明", source: "application_rules", scope: "当前代码中确定的业务规则；不是实时生产数据", completeness: "所选规则说明", data: { rules: topic === "all" ? rules : { [topic]: rules[topic] } } });
    })
  };
}
