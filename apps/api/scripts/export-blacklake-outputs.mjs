import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BlacklakeClient } from "../src/blacklake-client.mjs";
import { loadBlacklakeConfig } from "../src/config.mjs";

const options = parseArgs(process.argv.slice(2));
const config = loadBlacklakeConfig(process.env);
if (config.mode !== "live") fail("请先在 .env 中设置 BLACKLAKE_MODE=live 并填写 OpenAPI 凭据。");

const filters = compact({
  id: integerOption(options.id, "--id"),
  projectCode: options["project-code"],
  projectProcessId: integerOption(options["task-id"], "--task-id"),
  processCode: options["process-code"],
  approveStatus: integerOption(options["approve-status"], "--approve-status"),
  createdAtGte: options.from,
  createdAtLte: options.to,
  updatedAtGte: options["updated-from"],
  updatedAtLte: options["updated-to"],
  starttimeofReportGte: options["started-from"],
  starttimeofReportLte: options["started-to"],
  endtimeofReportGte: options["ended-from"],
  endtimeofReportLte: options["ended-to"]
});

for (const [key, value] of Object.entries(filters)) {
  if (/At|timeofReport/.test(key)) assertTimestamp(value, `--${toKebab(key)}`);
}
if (filters.approveStatus !== undefined && ![0, 10].includes(filters.approveStatus)) {
  fail("--approve-status 只能是 0（未审批）或 10（已审批）。");
}

const pageSize = integerOption(options["page-size"] || "100", "--page-size");
const maxRecords = options["max-records"] ? integerOption(options["max-records"], "--max-records") : Infinity;
const format = String(options.format || "json").toLowerCase();
if (!['json', 'csv'].includes(format)) fail("--format 只能是 json 或 csv。");

const defaultName = `blacklake-outputs-${fileTimestamp()}.${format}`;
const outputPath = resolve(options.output || `data/exports/${defaultName}`);
const client = new BlacklakeClient(config);
const records = await client.queryOutputs(filters, { pageSize, maxRecords });
const body = format === "csv" ? toCsv(records) : `${JSON.stringify(records, null, 2)}\n`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, body, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, recordCount: records.length, filters }, null, 2)}\n`);

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) fail(`无法识别参数：${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (!value || value.startsWith("--")) fail(`参数 --${rawKey} 缺少值。`);
    result[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }
  return result;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ""));
}

function integerOption(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(`${name} 必须是非负整数。`);
  return number;
}

function assertTimestamp(value, name) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value))) {
    fail(`${name} 必须使用 YYYY-MM-DD HH:mm:ss 格式。`);
  }
}

function toCsv(records) {
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const lines = [columns.map(csvCell).join(",")];
  for (const record of records) {
    lines.push(columns.map((column) => csvCell(serialize(record[column]))).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function serialize(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : value;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toKebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function fileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
