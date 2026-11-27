import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const nameKey = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
const codeKey = (value) => String(value || "").normalize("NFKC").trim().toUpperCase().replace(/[\s_-]+/g, "");
export const DISPATCH_PREDICTION_POLICY = "history-dominant-v1";

export function compileDispatchPredictionRules(analysis = {}) {
  const profiles = (Array.isArray(analysis.staffProfiles) ? analysis.staffProfiles : []).map((profile) => ({
    staff: String(profile.staff || "").trim(), processCode: String(profile.dominantProcess || ""),
    reportCount: Number(profile.reportCount) || 0, workOrderCount: Number(profile.workOrderCount) || 0,
    dominantShare: Number(profile.dominantShare) || 0, enabled: profile.enabled !== false,
    blacklakeOperatorId: Number(profile.blacklakeOperatorId) || null
  }));
  const sourcePeriod = analysis.summary?.period || null;
  const payload = { policy: DISPATCH_PREDICTION_POLICY, profiles, sourcePeriod,
    sourceRecordCount: Number(analysis.summary?.recordCount) || 0, generatedAt: analysis.generatedAt || null };
  return { ...payload, version: createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24) };
}

export async function loadDispatchPredictionRules(path) {
  if (!path) return compileDispatchPredictionRules();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed.policy === DISPATCH_PREDICTION_POLICY && Array.isArray(parsed.profiles)) {
      if (!parsed.profiles.every((profile) => profile && typeof profile.staff === "string")) return compileDispatchPredictionRules();
      const { version, ...payload } = parsed;
      return { ...payload, version: createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24) };
    }
    return compileDispatchPredictionRules(parsed);
  }
  catch (error) {
    if (error.code !== "ENOENT") console.warn(JSON.stringify({ event: "dispatch_prediction_rules_unavailable", code: error.code || "INVALID_RULES" }));
    return compileDispatchPredictionRules();
  }
}

export function predictDispatch({ rules = compileDispatchPredictionRules(), employees = [], processes = [], taskId }) {
  const names = new Map();
  for (const employee of employees) names.set(nameKey(employee.name), (names.get(nameKey(employee.name)) || 0) + 1);
  const profileNames = new Map();
  for (const profile of rules.profiles) profileNames.set(nameKey(profile.staff), (profileNames.get(nameKey(profile.staff)) || 0) + 1);
  const candidates = [];
  for (const profile of rules.profiles) {
    if (!rules.sourcePeriod?.from || !rules.sourcePeriod?.to || !Number.isFinite(Date.parse(rules.sourcePeriod.to))) continue;
    const tier = profile.reportCount >= 20 && profile.workOrderCount >= 3 && profile.dominantShare >= .8 ? "STRONG"
      : profile.reportCount >= 10 && profile.workOrderCount >= 2 && profile.dominantShare >= .6 ? "SUGGESTED" : null;
    if (!tier || !profile.enabled || !profile.processCode || profile.dominantShare > 1) continue;
    const matches = profile.blacklakeOperatorId
      ? employees.filter((employee) => employee.blacklakeOperatorId === profile.blacklakeOperatorId)
      : names.get(nameKey(profile.staff)) === 1 && profileNames.get(nameKey(profile.staff)) === 1
        ? employees.filter((employee) => nameKey(employee.name) === nameKey(profile.staff)) : [];
    if (matches.length !== 1 || !matches[0].available || (!profile.blacklakeOperatorId && matches[0].identityAmbiguous)) continue;
    const tasks = processes.filter((process) => codeKey(process.processCode) === codeKey(profile.processCode));
    if (tasks.length !== 1) continue;
    const employee = matches[0];
    candidates.push({ blacklakeOperatorId: employee.blacklakeOperatorId, name: employee.name,
      taskId: tasks[0].taskId, processName: tasks[0].processName, processCode: tasks[0].processCode,
      unitId: employee.boundUnitIds?.length === 1 ? employee.boundUnitIds[0] : "", tier,
      evidence: { reportCount: profile.reportCount, workOrderCount: profile.workOrderCount,
        dominantShare: profile.dominantShare, identityMatch: profile.blacklakeOperatorId ? "ID" : "UNIQUE_NAME" } });
  }
  const supported = processes.map((process) => ({ ...process,
    support: candidates.filter((candidate) => candidate.taskId === process.taskId) })).filter((row) => row.support.length);
  const max = Math.max(0, ...supported.map((row) => row.support.length));
  const leading = supported.filter((row) => row.support.length === max);
  const selected = taskId ? processes.find((row) => row.taskId === Number(taskId)) : leading.length === 1 ? leading[0] : null;
  const selectedCandidates = candidates.filter((row) => row.taskId === selected?.taskId);
  const selectedEmployees = selectedCandidates.filter((row) => row.unitId);
  return {
    taskId: selected?.taskId || null, processName: selected?.processName || "", processCode: selected?.processCode || "",
    contextTaskId: taskId ? Number(taskId) : null,
    employees: selectedEmployees,
    candidates: selectedCandidates,
    source: { policy: rules.policy, version: rules.version, sourcePeriod: rules.sourcePeriod,
      sourceRecordCount: rules.sourceRecordCount, generatedAt: rules.generatedAt, profileCount: rules.profiles.length },
    notice: selectedEmployees.length ? "已按历史预选，可直接调整"
      : selected ? "暂无可自动带工位的人员，请手动选择" : "历史依据不足或工序并列，请选择工序和人员",
    exclusionNote: "仅匹配当前工单未完成工序；同名、忙碌、无唯一工位的人员不自动勾选。历史参与不表示技能或当前任务已具备开工条件。"
  };
}

export function predictProcessForEmployees({ rules, employees, processes, selectedEmployeeIds }) {
  const selected = employees.filter((person) => selectedEmployeeIds.includes(person.blacklakeOperatorId));
  const historicalCandidates=employees.map(person=>({...person,available:person.available||(selectedEmployeeIds.includes(person.blacklakeOperatorId)&&person.canQueue===true)}));
  const suggestions = processes.map((process) => ({ ...process,
    support: predictDispatch({ rules, employees:historicalCandidates, processes, taskId: process.taskId }).candidates
      .filter((person) => selectedEmployeeIds.includes(person.blacklakeOperatorId)) }));
  const evidence = selected.map((person) => ({ person, matches: suggestions.flatMap((process) =>
    process.support.filter((row) => row.blacklakeOperatorId === person.blacklakeOperatorId)) }));
  const unanimous = selected.length === selectedEmployeeIds.length && selected.length > 0
    && evidence.every((row) => row.matches.length === 1)
    && new Set(evidence.map((row) => row.matches[0].taskId)).size === 1;
  const process = unanimous ? processes.find((row) => row.taskId === evidence[0].matches[0].taskId) : null;
  const base = predictDispatch({ rules, employees: [], processes });
  return { ...base, mode: "PERSON_FIRST", taskId: process?.taskId || null,
    processName: process?.processName || "", processCode: process?.processCode || "",
    employees: evidence.map(({ person, matches }) => ({ blacklakeOperatorId: person.blacklakeOperatorId,
      name: person.name, unitId: person.boundUnitIds?.length === 1 ? person.boundUnitIds[0] : "",
      selectedBy: "LEADER", evidence: matches.length === 1 ? matches[0].evidence : null })),
    candidates: evidence.flatMap((row) => row.matches),
    processSuggestions: suggestions.filter((row) => row.support.length).sort((a,b) => b.support.length-a.support.length)
      .map((row) => ({ taskId: row.taskId, processName: row.processName, supportingPeople: row.support.length })),
    notice: process ? "已按所选人员历史预选工序，可修改" : "所选人员历史不足或常做工序不同，请手动选择工序",
    exclusionNote: "人员由组长选择，系统只建议工序；多人历史不一致时不自动定工序。历史参与不表示技能或已具备开工条件。" };
}

export function predictionDifference(prediction, finalSelection) {
  const predictedIds = prediction.employees.map((employee) => employee.blacklakeOperatorId).sort((a, b) => a - b);
  const finalIds = finalSelection.employees.map((employee) => employee.blacklakeOperatorId).sort((a, b) => a - b);
  const changedFields = [];
  if (prediction.taskId !== finalSelection.taskId) changedFields.push("PROCESS");
  if (JSON.stringify(predictedIds) !== JSON.stringify(finalIds)) changedFields.push("EMPLOYEES");
  if (finalSelection.employees.some((employee) => {
    const previous = prediction.employees.find((row) => row.blacklakeOperatorId === employee.blacklakeOperatorId);
    return previous && previous.unitId !== employee.unitId;
  })) changedFields.push("STATIONS");
  return { outcome: !prediction.taskId || !prediction.employees.length ? "NO_SUGGESTION" : changedFields.length ? "ADJUSTED" : "ADOPTED", changedFields };
}
