import { readFile } from "node:fs/promises";

const [input = "data/exports/blacklake-outputs-2026-08-mtd.json"] = process.argv.slice(2);
const records = JSON.parse(await readFile(input, "utf8"));

const numericFields = [
  "workreportQuantity", "numberofgoodProducts", "numberofDefectives",
  "wageunitPrice", "estimatedSalary", "planRestTime", "overtimeTime",
  "unplanShutdownTime", "effectiveTime"
];

const profile = {
  recordCount: records.length,
  dateRange: range(records.map((row) => row.createdAt).filter(Boolean)),
  distinct: Object.fromEntries([
    "projectCode", "productCode", "productName", "processCode",
    "productionStaff", "approvalStatus", "pricingMethod", "stockUnit"
  ].map((field) => [field, distinct(records, field)])),
  totals: Object.fromEntries(numericFields.map((field) => [field, sum(records, field)])),
  missing: Object.fromEntries([
    "projectCode", "productCode", "productName", "processCode", "productionStaff",
    "starttimeofReport", "endtimeofReport", "approvedAt"
  ].map((field) => [field, records.filter((row) => row[field] === null || row[field] === "").length])),
  approval: group(records, "approvalStatus", "workreportQuantity"),
  pricing: group(records, "pricingMethod", "workreportQuantity"),
  topStaff: group(records, "productionStaff", "workreportQuantity").slice(0, 12),
  topProducts: group(records, "productName", "workreportQuantity").slice(0, 12),
  topProcesses: group(records, "processCode", "workreportQuantity").slice(0, 12),
  daily: group(records, (row) => String(row.createdAt || "").slice(0, 10), "workreportQuantity", false),
  topDefectStaff: group(records, "productionStaff", "workreportQuantity").toSorted((a, b) => b.defective - a.defective).slice(0, 10),
  topShutdownStaff: group(records, "productionStaff", "workreportQuantity").toSorted((a, b) => b.shutdownHours - a.shutdownHours).slice(0, 10),
  longestRecords: records.toSorted((a, b) => number(b.effectiveTime) - number(a.effectiveTime)).slice(0, 10).map((row) => ({
    id: row.id, staff: row.productionStaff, projectCode: row.projectCode,
    createdAt: row.createdAt, effectiveHours: number(row.effectiveTime) / 3600,
    shutdownHours: number(row.unplanShutdownTime) / 3600
  })),
  customFieldSamples: records.slice(0, 5).map((row) => row.customFieldValues)
};

process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + number(row[field]), 0);
}

function distinct(rows, field) {
  return [...new Set(rows.map((row) => row[field]).filter((value) => value !== null && value !== ""))].length;
}

function range(values) {
  if (!values.length) return null;
  return { min: values.toSorted()[0], max: values.toSorted().at(-1) };
}

function group(rows, key, quantityField, sort = true) {
  const result = new Map();
  for (const row of rows) {
    const value = typeof key === "function" ? key(row) : row[key];
    const label = value === null || value === "" ? "（空）" : String(value);
    const item = result.get(label) || { label, records: 0, quantity: 0, good: 0, defective: 0, salary: 0, effectiveHours: 0, shutdownHours: 0 };
    item.records += 1;
    item.quantity += number(row[quantityField]);
    item.good += number(row.numberofgoodProducts);
    item.defective += number(row.numberofDefectives);
    item.salary += number(row.estimatedSalary);
    item.effectiveHours += number(row.effectiveTime) / 3600;
    item.shutdownHours += number(row.unplanShutdownTime) / 3600;
    result.set(label, item);
  }
  const values = [...result.values()];
  return sort ? values.toSorted((a, b) => b.quantity - a.quantity) : values.toSorted((a, b) => a.label.localeCompare(b.label));
}
