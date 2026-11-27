import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [
  inputArg = "data/analysis/process-flow-analysis-2026-ytd-through-2026-08-24.json",
  outputArg = "data/analysis/process-inference-rules.json"
] = process.argv.slice(2);

const input = resolve(inputArg);
const output = resolve(outputArg);
const analysis = JSON.parse(await readFile(input, "utf8"));

const automaticStaff = analysis.staffProfiles
  .filter((profile) => profile.decisionTier === "可自动判断")
  .map((profile) => ({
    staff: profile.staff,
    processCode: profile.dominantProcess,
    reportCount: profile.reportCount,
    workOrderCount: profile.workOrderCount,
    confidence: profile.dominantShare,
    observedFrom: profile.observedFrom,
    observedTo: profile.observedTo,
    enabled: true
  }));

const automaticTransitions = analysis.transitions
  .filter((transition) => transition.decisionTier === "可自动判断")
  .map((transition) => ({
    fromProcessCode: transition.fromProcess,
    toProcessCode: transition.toProcess,
    observations: transition.observations,
    workOrderCount: transition.workOrderCount,
    confidence: transition.confidence,
    enabled: false
  }));

const rules = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceAnalysis: input,
  sourcePeriod: analysis.summary.period,
  policy: {
    staffAutomatic: "历史报工不少于 20 条、涉及不少于 3 个工单、主工序占比不少于 80%",
    liveWorkOrderGuard: "只在当前黑湖工单的未完成工序中精确命中一次时推荐",
    action: "仅进入开工确认页，不自动开工、不自动报工"
  },
  staffRules: Object.fromEntries(automaticStaff.map((rule) => [rule.staff, rule])),
  transitionRules: automaticTransitions
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output,
  automaticStaffRules: automaticStaff.length,
  referenceTransitionRules: automaticTransitions.length
}, null, 2)}\n`);
