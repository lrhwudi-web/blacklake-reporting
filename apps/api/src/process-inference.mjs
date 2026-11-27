import { readFile } from "node:fs/promises";

const EMPTY_RULES = Object.freeze({ schemaVersion: 1, staffRules: {}, transitionRules: [] });

export async function loadProcessInferenceRules(path) {
  if (!path) return EMPTY_RULES;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      ...parsed,
      staffRules: parsed?.staffRules && typeof parsed.staffRules === "object" ? parsed.staffRules : {},
      transitionRules: Array.isArray(parsed?.transitionRules) ? parsed.transitionRules : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return EMPTY_RULES;
    throw error;
  }
}

export function recommendEmployeeProcess({ operatorName, processes, rules = EMPTY_RULES }) {
  const staffName = normalizedName(operatorName);
  if (!staffName || !Array.isArray(processes) || !processes.length) return null;

  const rule = Object.values(rules.staffRules || {}).find((candidate) =>
    candidate?.enabled !== false && normalizedName(candidate.staff) === staffName
  );
  if (!rule?.processCode) return null;

  const expectedCode = comparableProcessCode(rule.processCode);
  const matches = processes.filter((process) => comparableProcessCode(process.processCode) === expectedCode);
  if (matches.length !== 1) return null;

  return {
    process: matches[0],
    evidence: {
      source: "STAFF_HISTORY",
      reportCount: Number(rule.reportCount) || 0,
      workOrderCount: Number(rule.workOrderCount) || 0,
      confidence: clampConfidence(rule.confidence),
      period: rules.sourcePeriod || null
    }
  };
}

function normalizedName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function comparableProcessCode(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase().replace(/[\s_-]+/g, "");
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}
