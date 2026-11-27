import { AppError } from "./errors.mjs";
import { createHash } from "node:crypto";

const DAY = 86400000;
const SHANGHAI = 8 * 3600000;
const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const OUTPUT_BUDGET_MS = 15000;
const TASK_BUDGET_MS = 10000;
const MAX_GROUPS = 60;
const MAX_FINDINGS = 40;
const MAX_PROGRESS = 60;
const MAX_PROJECTS = 100;
const FINDING_PRIORITY = { needs_review_over_24h: 0, possible_duplicate_output: 1, quantity_over_plan: 2, duplicate_output_id: 3, quantity_pending: 4 };
const LINKS = { outputs: "/admin?view=report", tasks: "/admin?view=report", local: "/admin?view=audit" };
const text = (value, length = 120) => (typeof value === "string" || typeof value === "number" ? String(value) : "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, length);
const quantity = (value) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const numericId = (value) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const unique = (values) => [...new Set(values)];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dayString = (stamp) => new Date(stamp + SHANGHAI).toISOString().slice(0, 10);
const localString = (stamp) => new Date(stamp + SHANGHAI).toISOString().slice(0, 19).replace("T", " ");
const localIso = (stamp) => new Date(stamp + SHANGHAI).toISOString().slice(0, 23) + "+08:00";

function time(value, assumeUtc = false) {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();
  const calendar = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(input);
  const midnight = calendar ? Date.parse(`${calendar[1]}T00:00:00Z`) : NaN;
  if (!calendar || !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== calendar[1]
    || Number(calendar[2]) > 23 || Number(calendar[3]) > 59 || Number(calendar[4]) > 59) return null;
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(input);
  const parsed = local ? Date.parse(`${local[1]}T${local[2]}${local[3] || ""}${assumeUtc ? "Z" : "+08:00"}`)
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input) ? Date.parse(input) : NaN;
  if (!Number.isFinite(parsed)) return null;
  if (local && (assumeUtc ? new Date(parsed).toISOString().slice(0, 10) : dayString(parsed)) !== local[1]) return null;
  return parsed;
}

export function resolveWeek(startDate, now = Date.now()) {
  const stamp = Number(typeof now === "function" ? now() : now);
  if (!Number.isFinite(stamp)) throw new AppError(400, "INVALID_WEEK", "周报查询时间无效。");
  const today = Date.parse(`${dayString(stamp)}T00:00:00+08:00`);
  const weekday = new Date(today + SHANGHAI).getUTCDay();
  const thisMonday = today - ((weekday + 6) % 7) * DAY;
  const selected = startDate === undefined || startDate === null || startDate === "" ? dayString(thisMonday - 7 * DAY) : String(startDate);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(selected) ? Date.parse(`${selected}T00:00:00+08:00`) : NaN;
  if (!Number.isFinite(start) || dayString(start) !== selected || new Date(start + SHANGHAI).getUTCDay() !== 1 || start > thisMonday) {
    throw new AppError(400, "INVALID_WEEK", "请选择不晚于本周的周一，日期格式为YYYY-MM-DD。");
  }
  const end = start + 7 * DAY;
  return { startDate: selected, endDate: dayString(end), start: localIso(start), end: localIso(end),
    timezone: "Asia/Shanghai", basis: "createdAt", label: `${selected} 至 ${dayString(end - DAY)}（按报工创建时间）`, isPartial: end > stamp };
}

function abort(signal) {
  if (signal?.aborted) throw Object.assign(new Error("查询已停止。"), { name: "AbortError" });
}

function bounded(work, deadline, signal) {
  abort(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error("查询超过时间预算。"), { code: "WEEKLY_TIMEOUT" }));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(value); };
    const onAbort = () => finish(reject, Object.assign(new Error("查询已停止。"), { name: "AbortError" }));
    const timer = setTimeout(() => finish(reject, Object.assign(new Error("查询超过时间预算。"), { code: "WEEKLY_TIMEOUT" })), remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(work).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function approval(row) {
  // Read-side export field; approveStatus is only verified as a request filter.
  const value = row.approvalStatus;
  if ([10, "10", "已审批"].includes(value)) return "approved";
  if ([0, "0", "未审批"].includes(value)) return "unapproved";
  return "unknown";
}

function normalizeOutput(row) {
  const total = quantity(row.workreportQuantity);
  const good = quantity(row.numberofgoodProducts);
  const defects = quantity(row.numberofDefectives);
  return { id: id(row.id), projectId: numericId(row.projectId), projectCode: text(row.projectCode), taskId: numericId(row.taskId ?? row.projectProcessId),
    productCode: text(row.productCode), productName: text(row.productName), processCode: text(row.processCode), processName: text(row.processName), unit: text(row.stockUnit ?? row.unitName ?? row.unit, 30),
    productionStaff: text(row.productionStaff, 80).normalize("NFKC").trim().replace(/\s+/g, " "),
    createdAt: time(row.createdAt), updatedAt: time(row.updatedAt), totalQuantity: total, goodQuantity: good, defectQuantity: defects, approval: approval(row) };
}

function outputEvidence(row) {
  return { source: "blacklake_outputs", url: LINKS.outputs, recordId: row.id, projectCode: row.projectCode, taskId: row.taskId,
    createdAt: row.createdAt === null ? null : new Date(row.createdAt).toISOString(), totalQuantity: row.totalQuantity, goodQuantity: row.goodQuantity, defectQuantity: row.defectQuantity, approval: row.approval,
    ...(row.productionStaff ? { productionStaff: row.productionStaff, personIdentityBasis: "仅原始productionStaff姓名，未验证唯一人员ID" } : {}) };
}

function finding(key, kind, title, facts, nextChecks, evidence, extra = {}) {
  return { key, kind, title, category: "data", facts, possibleCauses: [], nextChecks, evidence, projectCode: "", taskId: null, ...extra };
}

export function buildLocalFinding(assignment, nowMs = Date.now()) {
  const assignmentId = text(assignment.id, 80);
  const projectCode = text(assignment.projectCode ?? assignment.project_code);
  const taskId = numericId(assignment.taskId ?? assignment.task_id);
  const endedAt = assignment.endedAt ?? assignment.ended_at;
  const evidence = [{ source: "local_assignments", url: LINKS.local, assignmentId, projectCode, taskId, status: assignment.status, endedAt: text(endedAt, 40) }];
  if (assignment.status === "QUANTITY_PENDING") return finding(`quantity-pending:${assignmentId}`, "quantity_pending", "完工数量尚待核对",
    ["这笔任务已登记完工但未提交黑湖产量，人员和工位已释放，可继续接单。"],
    ["请组长核清批次实际数量；当前首版尚无最终核量提交入口，不按参考数量补产量。"], evidence, { projectCode, taskId });
  const since = time(endedAt) ?? time(assignment.updatedAt ?? assignment.updated_at, true);
  if (assignment.status !== "NEEDS_REVIEW" || since === null || Number(nowMs) - since <= DAY) return null;
  return finding(`review:${assignmentId}`, "needs_review_over_24h", "报工写入结果待核对已超过24小时",
    [`任务${assignmentId}已等待${Math.floor((Number(nowMs) - since) / 3600000)}小时；上游是否写入仍未知。`],
    ["由授权人员核对黑湖原始报工；确认结果前禁止自动重试。"], evidence, { projectCode, taskId });
}

export function buildTaskFinding(task, nowMs = Date.now()) {
  const planned = taskAmount(task, "plannedAmount"), good = taskAmount(task, "reportedGoodAmount");
  if (!(planned > 0 && good > planned) || !numericId(task.taskId) || !numericId(task.projectId)) return null;
  const projectCode = text(task.projectCode), taskId = Number(task.taskId), unit = text(task.unit, 30);
  return finding(`over-plan:${task.projectId}:${taskId}`, "quantity_over_plan", "工序当前累计良品超过计划数",
    [`截至生成时，${text(task.processName)}累计良品${good}${unit}，计划${planned}${unit}。`, "超计划是核查信号，不能直接认定重复报工；达到计划也不等于工序关闭。"],
    ["核对该工序计划调整、补做记录及原始报工，确认数量口径。"],
    [{ source: "blacklake_tasks", url: LINKS.tasks, projectCode, taskId, plannedAmount: planned, reportedGoodAmount: good, asOf: new Date(Number(nowMs)).toISOString() }],
    { projectCode, taskId, possibleCauses: ["可能是计划调整、补做或报工重复，现有数据不能判定原因。"] });
}

async function readPeriod(blacklake, period, observedEnd, signal) {
  const from = Date.parse(period.start);
  const coverage = { complete: false, warnings: [], pages: 0, rawCount: 0, uniqueCount: 0, inRangeCount: 0,
    duplicateCount: 0, conflictingIdCount: 0, missingIdCount: 0, invalidTimeCount: 0, outsideRangeCount: 0,
    terminal: null, declaredTotal: null, range: { start: period.start, end: localIso(observedEnd), timezone: "Asia/Shanghai", basis: "createdAt", endExclusive: true } };
  const records = new Map();
  const conflicts = new Set();
  const duplicateRows = [];
  const duplicateMembers = new Map();
  let repeatedPageDigest = null;
  const pageFingerprints = new Set();
  const deadline = Date.now() + OUTPUT_BUDGET_MS;
  try {
    if (typeof blacklake.queryOutputPage !== "function") throw Object.assign(new Error(), { code: "STRICT_PAGE_UNAVAILABLE" });
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await bounded(() => blacklake.queryOutputPage({ createdAtGte: localString(from), createdAtLte: localString(observedEnd) }, { pageNum, pageSize: PAGE_SIZE }), deadline, signal);
      if (!page || !Array.isArray(page.records) || page.records.length > PAGE_SIZE || page.records.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw Object.assign(new Error(), { code: "BLACKLAKE_OUTPUT_PAGE_FORMAT" });
      if(page.source==='local_sqlite'){
        coverage.source='local_sqlite';coverage.sourceUpdatedAt=coverage.sourceUpdatedAt&&page.sync?.updatedAt?[coverage.sourceUpdatedAt,page.sync.updatedAt].sort()[0]:page.sync?.updatedAt||null;
        if(page.sync?.stale||!page.sync?.updatedAt)coverage.warnings.push('使用后台共享快照，最后同步时间为'+(coverage.sourceUpdatedAt||'未确认')+'；尚未确认最新状态。');
      }
      coverage.pages++;
      coverage.rawCount += page.records.length;
      if (page.total !== null && page.total !== undefined) {
        if (!Number.isSafeInteger(page.total) || page.total < page.records.length) throw Object.assign(new Error(), { code: "BLACKLAKE_OUTPUT_PAGE_FORMAT" });
        if (coverage.declaredTotal !== null && coverage.declaredTotal !== page.total) coverage.warnings.push("分页期间上游总记录数发生变化，无法视为稳定快照。");
        coverage.declaredTotal = page.total;
      }
      const normalized = page.records.map(normalizeOutput);
      const fingerprint = JSON.stringify(normalized);
      if (page.records.length && pageFingerprints.has(fingerprint)) {
        repeatedPageDigest = digest(normalized.map((row) => digest(row)).sort());
        coverage.warnings.push("上游重复返回同一页，已停止；本次范围未读全。"); coverage.terminal = "repeated-page"; break;
      }
      pageFingerprints.add(fingerprint);
      for (const row of normalized) {
        if (!row.id) { coverage.missingIdCount++; continue; }
        if (row.createdAt === null) { coverage.invalidTimeCount++; continue; }
        if (row.createdAt < from || row.createdAt >= observedEnd) {
          coverage.outsideRangeCount++;
          if (row.createdAt !== observedEnd) coverage.warnings.push("上游返回创建时间范围外记录，已排除；筛选完整性需要核对。");
          continue;
        }
        if (records.has(row.id)) {
          coverage.duplicateCount++;
          const members = duplicateMembers.get(row.id) || [digest(records.get(row.id))];
          members.push(digest(row)); duplicateMembers.set(row.id, members);
          if (JSON.stringify(records.get(row.id)) !== JSON.stringify(row)) conflicts.add(row.id);
          if (duplicateRows.length < 5) duplicateRows.push(row);
        } else records.set(row.id, row);
      }
      if (page.records.length < PAGE_SIZE) { coverage.terminal = "short-page"; break; }
      if (pageNum === MAX_PAGES) { coverage.terminal = "page-limit"; coverage.warnings.push(`达到${MAX_PAGES}页查询上限，结果不完整。`); }
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    coverage.terminal = error?.code === "WEEKLY_TIMEOUT" ? "timeout" : "failed";
    coverage.warnings.push(error?.code === "WEEKLY_TIMEOUT" ? "报工取数超过时间预算，已取得记录仅作部分参考。" : "报工分页读取失败或响应结构异常，不能当作零条记录或完整周报。");
  }
  coverage.conflictingIdCount = conflicts.size;
  coverage.uniqueCount = records.size;
  for (const conflict of conflicts) records.delete(conflict);
  coverage.inRangeCount = records.size;
  if (coverage.duplicateCount) coverage.warnings.push(`发现${coverage.duplicateCount}条重复ID；同ID只保留一份，冲突ID已排除。`);
  if (coverage.missingIdCount) coverage.warnings.push(`${coverage.missingIdCount}条报工缺少稳定ID，已排除。`);
  if (coverage.invalidTimeCount) coverage.warnings.push(`${coverage.invalidTimeCount}条报工缺少有效创建时间，无法归周，已排除。`);
  if (coverage.declaredTotal !== null && coverage.terminal === "short-page" && coverage.declaredTotal !== coverage.rawCount) coverage.warnings.push("分页累计条数与上游声明总数不一致，查询完整性未确认。");
  coverage.warnings = unique(coverage.warnings);
  coverage.complete = coverage.terminal === "short-page" && coverage.warnings.length === 0;
  const duplicateMembersDigest = digest({ repeatedPageDigest,
    members: [...duplicateMembers].map(([recordId, members]) => [recordId, members.sort()]).sort(([a], [b]) => a.localeCompare(b)) });
  return { records: [...records.values()], coverage, duplicateRows, duplicateMembersDigest };
}

function groupMetrics(records, complete) {
  const groups = new Map();
  let unknownApprovalCount = 0, approvedRecordCount = 0, unapprovedRecordCount = 0;
  for (const row of records) {
    if (row.approval === "approved") approvedRecordCount++; else if (row.approval === "unapproved") unapprovedRecordCount++; else unknownApprovalCount++;
    const key = JSON.stringify([row.productCode || row.productName || `project:${(row.projectId ?? row.projectCode) || row.id}`, row.processCode || row.processName || `task:${row.taskId ?? row.id}`, row.unit || `unknown-unit:${row.id}`]);
    if (!groups.has(key)) groups.set(key, { key, productCode: row.productCode, productName: row.productName, processCode: row.processCode, processName: row.processName,
      unit: row.unit || "未知单位", recordCount: 0, totalQuantity: 0, goodQuantity: 0, defectQuantity: 0, unknownQuantityRecords: 0, approvalCounts: { approved: 0, unapproved: 0, unknown: 0 } });
    const group = groups.get(key);
    group.recordCount++; group.approvalCounts[row.approval]++;
    if ([row.totalQuantity, row.goodQuantity, row.defectQuantity].some((value) => value === null)) group.unknownQuantityRecords++;
    for (const field of ["totalQuantity", "goodQuantity", "defectQuantity"]) group[field] = group[field] === null || row[field] === null ? null : group[field] + row[field];
  }
  const allGroups = [...groups.values()].sort((a, b) => b.recordCount - a.recordCount || a.key.localeCompare(b.key));
  return { complete, basis: "createdAt", approvalScope: "全部返回的审核状态，已审批/未审批/未知分别计数", recordCount: records.length,
    projectCount: new Set(records.map((row) => row.projectId ? `id:${row.projectId}` : row.projectCode ? `code:${row.projectCode}` : null).filter(Boolean)).size,
    recordsWithoutProject: records.filter((row) => !row.projectId && !row.projectCode).length,
    approvedRecordCount, unapprovedRecordCount, unknownApprovalCount, groupCount: allGroups.length,
    groups: allGroups.slice(0, MAX_GROUPS), groupsTruncated: allGroups.length > MAX_GROUPS,
    quantityMeaning: "各产品、工序、单位的报工记录数量；不提供跨工序成品总量" };
}

function compare(current, previous, period, duration) {
  const eligible = current.complete && previous.complete;
  const before = new Map(previous.groups.map((group) => [group.key, group]));
  const groups = current.groups.map((group) => {
    const old = before.get(group.key);
    const a = group.goodQuantity;
    const b = old?.goodQuantity ?? null;
    const comparable = eligible && group.unit !== "未知单位" && a !== null && b !== null;
    return { key: group.key, productCode: group.productCode, productName: group.productName, processCode: group.processCode, processName: group.processName, unit: group.unit,
      currentGoodQuantity: a, previousGoodQuantity: b,
      change: comparable ? a - b : null,
      percentChange: comparable && b > 0 ? Math.round((a - b) / b * 1000) / 10 : null, comparable,
      note: !eligible ? "任一周取数不完整，暂停环比结论" : group.unit === "未知单位" ? "单位未知，不能合并或作同单位环比" : !old ? "前周无同口径分组记录，未当作零" : b === 0 ? "前周基数为零，不计算百分比" : "相同产品、工序、单位与审核范围；非成品产量增幅" };
  });
  return { available: eligible, basis: period.isPartial ? "本周截至生成时与前周相同时长" : "相邻两个完整自然周", durationSeconds: Math.floor(duration / 1000),
    groups, groupsTruncated: current.groupsTruncated || previous.groupsTruncated,
    note: "按当前查询得到的创建时间归周；补录、审批或历史修改会影响重算结果，不是历史冻结快照。" };
}

function readLocal(store, generatedStamp, signal) {
  const coverage = { complete: false, warnings: [], scannedCount: 0, quantityPendingCount: 0, needsReviewCount: 0, needsReviewOver24hCount: 0,
    scope: "生成时全部未核量及上游结果未知任务，含历史任务；不是本周产量", findingsTotal: 0 };
  const findings = [], pendingFindings = [];
  const projectIds = new Set();
  const deadline = Date.now() + 3000;
  try {
    const rows = store.db.prepare(`SELECT id, project_id, project_code, task_id, status, started_at, ended_at, updated_at
      FROM assignments WHERE status IN ('QUANTITY_PENDING', 'NEEDS_REVIEW')`).iterate();
    for (const row of rows) {
      abort(signal);
      if (Date.now() >= deadline) throw Object.assign(new Error(), { code: "WEEKLY_TIMEOUT" });
      coverage.scannedCount++;
      if (numericId(row.project_id)) projectIds.add(Number(row.project_id));
      const item = buildLocalFinding(row, generatedStamp);
      if (row.status === "QUANTITY_PENDING") {
        coverage.quantityPendingCount++;
        coverage.findingsTotal++;
        if (pendingFindings.length < MAX_FINDINGS) pendingFindings.push(item);
      } else {
        coverage.needsReviewCount++;
        if (item) {
          coverage.needsReviewOver24hCount++; coverage.findingsTotal++;
          if (findings.length < MAX_FINDINGS) findings.push(item);
        }
      }
    }
    coverage.complete = true;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    coverage.warnings.push("本地未处理任务读取失败或超过时间预算，已扫描数量只是下限，不能认定没有其他待处理任务。");
  }
  // Keep each kind's bounded sample until the final cross-source selection.
  return { coverage, findings: [...findings, ...pendingFindings], projectIds };
}

function taskAmount(task, name) {
  const value = quantity(task[name]);
  if (task.quantityPresence?.[name] === false || (value === 0 && task.quantityPresence?.[name] !== true)) return null;
  return value;
}

async function readTasks(blacklake, projectIds, generatedAt, signal) {
  const selected = [...projectIds].sort((a, b) => a - b).slice(0, MAX_PROJECTS);
  const coverage = { complete: false, warnings: [], scope: "两周已取得报工及本地未处理任务关联工单的当前工序，不代表全厂订单", totalProjects: projectIds.size,
    queriedProjects: selected.length, taskCount: 0, progressReturned: 0, progressTruncated: false, freshness: "queried_or_cached", asOf: generatedAt, findingsTotal: 0 };
  const progress = [], findings = [];
  if (selected.length < projectIds.size) coverage.warnings.push(`关联工单超过${MAX_PROJECTS}张，当前工序只查询前${MAX_PROJECTS}张。`);
  if (!selected.length) { coverage.complete = true; return { coverage, progress, findings }; }
  try {
    const deadline = Date.now() + TASK_BUDGET_MS;
    const rows = await bounded(() => blacklake.listProjectTasks({ projectIds: selected }, { deadline }), deadline, signal);
    if (!Array.isArray(rows)) throw new Error("Invalid task response");
    const tasks = new Map();
    const conflicting = new Set();
    const foundProjects = new Set();
    for (const row of rows) {
      abort(signal);
      if (!row || !numericId(row.taskId) || !selected.includes(Number(row.projectId))) { coverage.warnings.push("返回工序缺少有效关联或不属于所查工单，已排除。 "); continue; }
      const key = `${row.projectId}:${row.taskId}`;
      const planned = taskAmount(row, "plannedAmount"), good = taskAmount(row, "reportedGoodAmount");
      const status = row.processStatus === null || row.processStatus === undefined ? null : Number(row.processStatus);
      const closed = status === 20 || /^(已完成|完成|已完工|完工|已结束|已关闭)$/.test(String(row.processStatusDisplay || "")) ? true
        : status === 10 || /^(未开始|待开始|待开工|进行中|生产中|执行中|已开始|已开工)$/.test(String(row.processStatusDisplay || "")) ? false : null;
      const item = { projectId: Number(row.projectId), projectCode: text(row.projectCode), taskId: Number(row.taskId), processName: text(row.processName),
        processCode: text(row.processCode), unit: text(row.unit, 30), sequence: quantity(row.sequence), plannedAmount: planned, reportedGoodAmount: good,
        quantityCompletionPercent: planned > 0 && good !== null ? Math.round(good / planned * 1000) / 10 : null,
        closed, processStatus: Number.isFinite(status) ? status : null, processStatusDisplay: text(row.processStatusDisplay),
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(row.dueDate || "")) ? row.dueDate : null,
        dueDateMeaning: "工序计划结束日期；不是客户交期", asOf: generatedAt, timeMeaning: "生成时查询的当前工序快照，不是本周或前周末历史状态" };
      foundProjects.add(item.projectId);
      if (tasks.has(key) && JSON.stringify(tasks.get(key)) !== JSON.stringify(item)) conflicting.add(key); else tasks.set(key, item);
    }
    for (const key of conflicting) tasks.delete(key);
    if (conflicting.size) coverage.warnings.push(`${conflicting.size}个工序返回冲突数据，已排除。`);
    if (selected.some((project) => !foundProjects.has(project))) coverage.warnings.push("部分工单未返回工序，无法确认路线完整性或认定已完成。");
    coverage.taskCount = tasks.size;
    for (const item of tasks.values()) {
      if (progress.length < MAX_PROGRESS) progress.push(item);
      const anomaly = buildTaskFinding(item, Date.parse(generatedAt));
      if (anomaly) {
        coverage.findingsTotal++;
        if (findings.length < MAX_FINDINGS) findings.push(anomaly);
      }
    }
    coverage.progressReturned = progress.length; coverage.progressTruncated = tasks.size > progress.length;
    coverage.warnings = unique(coverage.warnings);
    coverage.complete = coverage.warnings.length === 0;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    coverage.warnings.push("当前工序查询失败或超时，不能推断工序已完成、延期或数量为零。");
  }
  return { coverage, progress, findings };
}

export async function collectWeeklyData({ blacklake, store, startDate, now = Date.now, signal }) {
  const generatedStamp = Number(typeof now === "function" ? now() : now);
  const period = resolveWeek(startDate, generatedStamp);
  const previousPeriod = resolveWeek(dayString(Date.parse(period.start) - 7 * DAY), generatedStamp);
  const generatedAt = new Date(generatedStamp).toISOString();
  const duration = Math.max(0, Math.min(Date.parse(period.end), generatedStamp) - Date.parse(period.start));
  const [current, previous] = await Promise.all([
    readPeriod(blacklake, period, Date.parse(period.start) + duration, signal),
    readPeriod(blacklake, previousPeriod, Date.parse(previousPeriod.start) + duration, signal)
  ]);
  abort(signal);
  const local = readLocal(store, generatedStamp, signal);
  const projectIds = new Set([...current.records, ...previous.records].map((row) => row.projectId).filter(Boolean));
  for (const project of local.projectIds) projectIds.add(project);
  const taskResult = await readTasks(blacklake, projectIds, generatedAt, signal);
  taskResult.coverage.unlinkedOutputCount = [...current.records, ...previous.records].filter((row) => !row.projectId).length;
  if (taskResult.coverage.unlinkedOutputCount) {
    taskResult.coverage.complete = false;
    taskResult.coverage.warnings.push(`${taskResult.coverage.unlinkedOutputCount}条报工缺少项目ID，未据工单名称猜测工序关联。`);
  }
  const metricsCurrent = groupMetrics(current.records, current.coverage.complete);
  const metricsPrevious = groupMetrics(previous.records, previous.coverage.complete);
  const paginationFindings = [], duplicateFindings = [];
  let findingsTotal = local.coverage.findingsTotal + taskResult.coverage.findingsTotal;
  for (const [name, result] of [["current", current], ["previous", previous]]) {
    if (result.coverage.duplicateCount || result.coverage.terminal === "repeated-page") {
      findingsTotal++;
      paginationFindings.push(finding(`duplicate-id:${name === "current" ? period.startDate : previousPeriod.startDate}`, "duplicate_output_id", "报工分页出现重复记录或冲突",
        [`${name === "current" ? "本周" : "前周"}重复ID记录${result.coverage.duplicateCount}条，冲突ID${result.coverage.conflictingIdCount}个；查询完整性已降级。`],
        ["核对分页排序及对应原始ID，不能将分页重复认定为重复生产。"], [...result.duplicateRows.map(outputEvidence),
          { source: "blacklake_outputs", url: LINKS.outputs, evidenceType: "pagination_summary", duplicateCount: result.coverage.duplicateCount,
            conflictingIdCount: result.coverage.conflictingIdCount, repeatedPage: result.coverage.terminal === "repeated-page", membersDigest: result.duplicateMembersDigest }],
        { possibleCauses: ["可能为分页重叠或查询期间数据更新，尚不能认定生产记录重复。"] }));
    }
  }
  const possibleDuplicates = new Map();
  for (const row of current.records) {
    if (!row.taskId || !row.projectId || !row.productionStaff || !row.unit || row.totalQuantity === null || row.goodQuantity === null || row.defectQuantity === null) continue;
    const key = JSON.stringify([row.projectId, row.taskId, row.productionStaff, row.unit, row.totalQuantity, row.goodQuantity, row.defectQuantity]);
    const similar = possibleDuplicates.get(key) || [];
    similar.push(row); possibleDuplicates.set(key, similar);
  }
  for (const group of possibleDuplicates.values()) {
    const ordered = group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && ordered[end].createdAt - ordered[start].createdAt <= 5 * 60000) end++;
      const rows = ordered.slice(start, end);
      start = end;
      if (rows.length < 2) continue;
      findingsTotal++;
      if (duplicateFindings.length < MAX_FINDINGS) duplicateFindings.push(finding(`similar:${period.startDate}:${rows[0].id}`, "possible_duplicate_output", "疑似同人员相近报工",
        [`发现${rows.length}个不同ID，工单、工序、数量及productionStaff姓名相同，创建时间相隔不超过5分钟。`, "姓名相同不等于同一人；这里只是弱线索，未验证唯一人员ID。"],
        ["核对这些ID对应的人员身份、班次与原始报工，确认是否为合法并行记录。"], [...rows.slice(0, 5).map(outputEvidence),
          { source: "blacklake_outputs", url: LINKS.outputs, evidenceType: "group_summary", recordCount: rows.length,
            sampleCount: Math.min(rows.length, 5), sampleTruncated: rows.length > 5, membersDigest: digest(rows.map(outputEvidence).map((row) => digest(row)).sort()) }],
        { projectCode: rows[0].projectCode, taskId: rows[0].taskId, possibleCauses: ["可能为同名人员或合法连续报工，也可能是重复登记；当前证据不足以定因。"] }));
    }
  }
  // Counts cover every discovered finding; the display cap must not let a
  // large pending-quantity backlog hide higher-priority upstream-write clues.
  const findings = [...local.findings, ...taskResult.findings, ...paginationFindings, ...duplicateFindings]
    .sort((a, b) => (FINDING_PRIORITY[a.kind] ?? 99) - (FINDING_PRIORITY[b.kind] ?? 99))
    .slice(0, MAX_FINDINGS);
  const mode = ["live", "mock"].includes(blacklake?.config?.mode) ? blacklake.config.mode : "unknown";
  const warnings = unique([...current.coverage.warnings, ...previous.coverage.warnings, ...local.coverage.warnings, ...taskResult.coverage.warnings,
    ...(mode === "live" ? [] : ["当前为模拟或未确认的数据模式，不能作为正式生产事实。"])]);
  const sources = [
    { key: "current", title: "本周录入报工", url: LINKS.outputs, source: "blacklake_outputs", scope: current.coverage.range, queriedAt: generatedAt, complete: current.coverage.complete },
    { key: "previous", title: period.isPartial ? "前周同期录入报工" : "前周录入报工", url: LINKS.outputs, source: "blacklake_outputs", scope: previous.coverage.range, queriedAt: generatedAt, complete: previous.coverage.complete },
    { key: "local", title: "本地未处理任务", url: LINKS.local, source: "local_assignments", scope: local.coverage.scope, queriedAt: generatedAt, complete: local.coverage.complete },
    { key: "tasks", title: "关联工单当前工序", url: LINKS.tasks, source: "blacklake_tasks", scope: taskResult.coverage.scope, queriedAt: generatedAt, complete: taskResult.coverage.complete }
  ];
  return { period, previousPeriod, generatedAt, mode, dataTrust: "untrusted_business_data",
    coverage: { current: current.coverage, previous: previous.coverage, local: local.coverage, tasks: taskResult.coverage, warnings,
      findingsTotal, findingsReturned: findings.length, findingsTruncated: findingsTotal > findings.length },
    metrics: { current: metricsCurrent, previous: metricsPrevious, comparison: compare(metricsCurrent, metricsPrevious, period, duration) },
    progress: taskResult.progress, findings, sources,
    limitations: ["按报工创建时间归周，不代表实际生产完成时间；补录与历史修改可能改变重新生成的结果。", "分页读尽不等于上游提供同一时点快照；当前未取得稳定排序或快照游标保证。",
      "全部审核状态分别标记；未知审核值不当作已审批，缺失数量不当作零。", "产品、工序与单位分组数量不能跨工序相加为成品产量。",
      "工序为生成时查询，可复用客户端30秒缓存；不能推断前周末状态或历史推进，工序计划日期不能冒充客户交期。",
      "本地待核量记录不计入黑湖产量；NEEDS_REVIEW表示上游结果未知，禁止自动重试。",
      "疑似重复只使用读侧已知productionStaff姓名和5分钟窗口作弱线索；姓名不等于唯一人员身份，真实接口人员ID映射仍待验证。",
      "核查展示优先级为结果未知超过24小时、疑似相近报工、工序超计划、分页重复、待核量；各类先有限取样，再统一排序截断。",
      `最多展示${MAX_GROUPS}个数量分组、${MAX_PROGRESS}条工序和${MAX_FINDINGS}项异常；总数和截断在各coverage或metrics字段明确标注。`] };
}
