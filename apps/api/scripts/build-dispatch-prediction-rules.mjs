import { readFile, writeFile } from "node:fs/promises";
import { compileDispatchPredictionRules } from "../src/dispatch-prediction.mjs";
const input = process.argv[2] || "data/analysis/process-flow-analysis-2026-ytd-through-2026-08-24.json";
const output = process.argv[3] || "data/analysis/dispatch-prediction-rules.json";
const compiled = compileDispatchPredictionRules(JSON.parse(await readFile(input, "utf8")));
await writeFile(output, JSON.stringify(compiled, null, 2) + "\n");
console.log(JSON.stringify({ profiles: compiled.profiles.length, sourceRecordCount: compiled.sourceRecordCount,
  period: compiled.sourcePeriod, version: compiled.version }));
