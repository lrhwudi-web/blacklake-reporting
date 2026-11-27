import { effectiveWorkSecondsBetween } from "./work-time.mjs";

export const DEFAULT_ANOMALY_RULES = Object.freeze({
  deadlineGraceSeconds: 30 * 60,
  durationBaselineMinSamples: 5,
  durationMultiplier: 3,
  durationMinimumExcessSeconds: 60 * 60
});

const ACTIVE_STATUSES = new Set(["IN_PROGRESS", "REPORTING"]);
const FINISHED_STATUSES = new Set(["COMPLETED", "NEEDS_REVIEW"]);

export function evaluateProductionAnomalies(assignments, { now = new Date(), rules = {} } = {}) {
  const resolvedRules = { ...DEFAULT_ANOMALY_RULES, ...rules };
  const rows = assignments.map((assignment) => ({ ...assignment, productionAnomalies: [] }));
  const processGroups = groupBy(rows, processKey);
  const durationBaselines = buildDurationBaselines(rows, resolvedRules);

  for (const group of processGroups.values()) {
    applyProcessStalledRule(group, now, resolvedRules);
  }

  for (const assignment of rows) {
    applyOperatorOpenRule(assignment, now, resolvedRules);
    applyDurationRule(assignment, durationBaselines, resolvedRules);
    assignment.productionAnomalies.sort(compareAnomalies);
    assignment.hasProductionAnomaly = assignment.productionAnomalies.length > 0;
    assignment.productionStatus = assignment.hasProductionAnomaly ? "EXCEPTION" : assignment.status;
    assignment.effectiveDurationSeconds = currentEffectiveSeconds(assignment, now);
  }

  return rows;
}

export function summarizeProductionAnomalies(assignments) {
  const summary = { total: 0, critical: 0, warning: 0, byCode: {} };
  const seen = new Set();
  for (const assignment of assignments) {
    for (const anomaly of assignment.productionAnomalies || []) {
      const key = `${anomaly.code}:${anomaly.scopeKey || assignment.id || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      summary.total += 1;
      if (anomaly.severity === "CRITICAL") summary.critical += 1;
      else summary.warning += 1;
      summary.byCode[anomaly.code] = (summary.byCode[anomaly.code] || 0) + 1;
    }
  }
  return summary;
}

function applyProcessStalledRule(group, now, rules) {
  const active = group.filter((assignment) => ACTIVE_STATUSES.has(assignment.status) && assignment.expectedProgressAt);
  for (const assignment of active) {
    const elapsedSeconds = secondsPast(assignment.expectedProgressAt, now);
    if (elapsedSeconds < rules.deadlineGraceSeconds) continue;
    assignment.productionAnomalies.push(anomaly({
      code: "PROCESS_STALLED",
      title: "工序超过计划进度节点",
      message: `该工序的计划进度节点已逾期 ${formatDuration(elapsedSeconds)}`,
      scope: "PROCESS",
      elapsedSeconds,
      thresholdSeconds: rules.deadlineGraceSeconds,
      referenceAt: assignment.expectedProgressAt,
      scopeKey: processKey(assignment)
    }));
  }
}

function applyOperatorOpenRule(assignment, now, rules) {
  if (!ACTIVE_STATUSES.has(assignment.status) || !assignment.expectedEndAt) return;
  const elapsedSeconds = secondsPast(assignment.expectedEndAt, now);
  if (elapsedSeconds < rules.deadlineGraceSeconds) return;
  assignment.productionAnomalies.push(anomaly({
    code: "OPERATOR_NOT_FINISHED",
    title: "人员超过预计结束时间",
    message: `${assignment.operatorName || "该人员"}超过预计结束时间 ${formatDuration(elapsedSeconds)} 仍未结束`,
    scope: "OPERATOR",
    elapsedSeconds,
    thresholdSeconds: rules.deadlineGraceSeconds,
    referenceAt: assignment.expectedEndAt,
    scopeKey: assignment.id
  }));
}

function applyDurationRule(assignment, baselines, rules) {
  if (!FINISHED_STATUSES.has(assignment.status)) return;
  const durationSeconds = Number(assignment.netActiveDurationSeconds);
  const quantity = Number(assignment.quantity);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(quantity) || quantity <= 0) return;

  const baseline = baselines.get(durationKey(assignment));
  const explicitExpectedSeconds = Number(assignment.expectedDurationSeconds);
  const expectedSeconds = Number.isFinite(explicitExpectedSeconds) && explicitExpectedSeconds > 0
    ? explicitExpectedSeconds
    : baseline ? baseline.unitSeconds * quantity : null;
  const sampleCount = Number.isFinite(explicitExpectedSeconds) && explicitExpectedSeconds > 0
    ? 0
    : baseline?.sampleCount || 0;
  const relativeExceeded = expectedSeconds
    && (sampleCount === 0 || sampleCount >= rules.durationBaselineMinSamples)
    && durationSeconds > expectedSeconds * rules.durationMultiplier
    && durationSeconds - expectedSeconds >= rules.durationMinimumExcessSeconds;
  if (!relativeExceeded) return;

  const comparison = sampleCount
    ? `，约为同产品同工序常见水平的 ${round(durationSeconds / expectedSeconds, 1)} 倍`
    : `，约为明确作业基准的 ${round(durationSeconds / expectedSeconds, 1)} 倍`;
  assignment.productionAnomalies.push(anomaly({
    code: "DURATION_TOO_LONG",
    title: "净作业用时明显偏长",
    message: `本次净作业用时 ${formatDuration(durationSeconds)}${comparison}`,
    scope: "RECORD",
    elapsedSeconds: durationSeconds,
    thresholdSeconds: Math.round(expectedSeconds * rules.durationMultiplier),
    baselineSeconds: Math.round(expectedSeconds),
    baselineSampleCount: sampleCount,
    referenceAt: assignment.endedAt,
    scopeKey: assignment.id
  }));
}

function buildDurationBaselines(assignments, rules) {
  const groups = groupBy(
    assignments.filter((assignment) => assignment.status === "COMPLETED" && Number(assignment.netActiveDurationSeconds) > 0 && Number(assignment.quantity) > 0),
    durationKey
  );
  const baselines = new Map();
  for (const [key, group] of groups) {
    const unitSeconds = group.map((assignment) => Number(assignment.netActiveDurationSeconds) / Number(assignment.quantity)).sort((a, b) => a - b);
    if (unitSeconds.length < rules.durationBaselineMinSamples) continue;
    baselines.set(key, { unitSeconds: median(unitSeconds), sampleCount: unitSeconds.length });
  }
  return baselines;
}

function anomaly(input) {
  return {
    ...input,
    severity: input.elapsedSeconds >= input.thresholdSeconds * 2 ? "CRITICAL" : "WARNING"
  };
}

function currentEffectiveSeconds(assignment, now) {
  if (ACTIVE_STATUSES.has(assignment.status) && assignment.startedAt) return safeEffectiveSeconds(assignment.startedAt, assignment.endedAt || now, assignment.pauses);
  const seconds = Number(assignment.durationSeconds);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function processKey(assignment) {
  return `${assignment.projectId ?? assignment.projectCode ?? ""}:${assignment.taskId ?? assignment.processName ?? ""}`;
}

function durationKey(assignment) {
  return `${assignment.productName || ""}:${assignment.processName || ""}`.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function safeEffectiveSeconds(start, end, pauses) {
  const seconds = effectiveWorkSecondsBetween(start, end, pauses);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
}

function timestampMs(value) {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const text = String(value || "").trim().replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}+08:00`);
}

function secondsPast(referenceAt, now) {
  const seconds = Math.floor((timestampMs(now) - timestampMs(referenceAt)) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

function median(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ""}` : `${rest} 分钟`;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compareAnomalies(a, b) {
  if (a.severity !== b.severity) return a.severity === "CRITICAL" ? -1 : 1;
  return b.elapsedSeconds - a.elapsedSeconds;
}
