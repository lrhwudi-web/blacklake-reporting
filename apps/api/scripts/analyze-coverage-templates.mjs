import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [
  inputArg = "data/exports/blacklake-outputs-2026-ytd-through-2026-08-24.json",
  outputArg = "data/analysis/frequent-reporting-flow-coverage.json"
] = process.argv.slice(2);

const input = resolve(inputArg);
const output = resolve(outputArg);
const records = JSON.parse(await readFile(input, "utf8"));
const orders = buildOrders(records);

const processStats = aggregateProcesses(records, orders);
const transitionStats = aggregateTransitions(orders);
const exactPaths = aggregatePaths(orders, (order) => order.path);

const process90 = takeThroughCoverage(processStats, records.length, 0.9, "reportCount");
const transitionTotal = transitionStats.reduce((sum, row) => sum + row.observations, 0);
const transition90 = takeThroughCoverage(transitionStats, transitionTotal, 0.9, "observations");
const exactPath90 = takeThroughCoverage(exactPaths, orders.length, 0.9, "workOrderCount");

const experiments = [8, 10, 12, 15, 20, 25, 30, 40, 50, process90.items.length].map((topN) => {
  const selected = new Set(processStats.slice(0, topN).map((row) => row.processCode));
  const signatures = aggregatePaths(orders, (order) => order.steps.map((step) => step.processCode).filter((code) => selected.has(code)).join(" → "));
  const nonEmptyOrders = signatures.reduce((sum, row) => sum + row.workOrderCount, 0);
  const signature90 = takeThroughCoverage(signatures, orders.length, 0.9, "workOrderCount");
  const allStepsCovered = orders.filter((order) => order.steps.every((step) => selected.has(step.processCode))).length;
  const anyStepCovered = orders.filter((order) => order.steps.some((step) => selected.has(step.processCode))).length;
  return {
    topProcessCount: topN,
    selectedReportCoverage: processStats.slice(0, topN).reduce((sum, row) => sum + row.reportCount, 0) / records.length,
    workOrdersWithAnySelectedProcess: anyStepCovered,
    workOrderAnyCoverage: anyStepCovered / orders.length,
    workOrdersFullyInsideSelectedProcesses: allStepsCovered,
    workOrderFullCoverage: allStepsCovered / orders.length,
    nonEmptyFilteredSignatures: signatures.length,
    nonEmptyOrders,
    filteredSignaturesNeededFor90PercentOrders: signature90.items.length,
    topFilteredSignatures: signatures.slice(0, 25)
  };
});

const coreCodes = new Set(process90.items.map((row) => row.processCode));
const coreTransitions = transitionStats.filter((row) => coreCodes.has(row.fromProcess) && coreCodes.has(row.toProcess));
const coreFlow = buildCoreFlow(coreTransitions, processStats, coreCodes);
const modularFlow = buildModularFlow(process90.items, records.length, coreTransitions);
const fullOrder90 = findProcessCountForFullOrderCoverage(processStats, orders, 0.9);
const startStats = aggregateEndpoints(orders, "start");
const endStats = aggregateEndpoints(orders, "end");

const result = {
  generatedAt: new Date().toISOString(),
  source: input,
  period: dateRange(records.map((row) => row.createdAt)),
  summary: {
    recordCount: records.length,
    workOrderCount: orders.length,
    processCodeCount: processStats.length,
    transitionCount: transitionStats.length,
    exactPathCount: exactPaths.length,
    processCodesFor90PercentReports: process90.items.length,
    actualReportCoverage: process90.coverage,
    transitionsFor90PercentObservations: transition90.items.length,
    exactPathsFor90PercentWorkOrders: exactPath90.items.length,
    processCodesFor90PercentCompleteWorkOrders: fullOrder90.processCount,
    completeWorkOrderCoverage: fullOrder90.coverage
  },
  coverageDefinition: {
    primary: "高频工序编码集合覆盖的报工记录数 / 全部报工记录数",
    workOrderAny: "至少包含一道高频工序的工单数 / 全部工单数",
    workOrderFull: "每道工序都在高频集合内的工单数 / 全部工单数",
    caveat: "完整路径高度碎片化，不能用少量精确路径达到 90%；落地应采用一套模块化流程和人工兜底"
  },
  process90: process90.items,
  transition90: transition90.items,
  exactPath90Summary: {
    pathsNeeded: exactPath90.items.length,
    coverage: exactPath90.coverage,
    topPaths: exactPaths.slice(0, 50)
  },
  experiments,
  modularFlow,
  fullOrder90,
  coreFlow,
  startStats: startStats.slice(0, 30),
  endStats: endStats.slice(0, 30),
  allProcessStats: processStats,
  topTransitions: transitionStats.slice(0, 300)
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output,
  summary: result.summary,
  experiments: experiments.map(({ topProcessCount, selectedReportCoverage, workOrderAnyCoverage, workOrderFullCoverage }) => ({ topProcessCount, selectedReportCoverage, workOrderAnyCoverage, workOrderFullCoverage })),
  modularFlow: modularFlow.stages.map(({ stageId, label, processCount, reportCount, reportShare, topProcesses }) => ({ stageId, label, processCount, reportCount, reportShare, topProcesses: topProcesses.slice(0, 5) })),
  primaryTransitions: modularFlow.primaryTransitions
}, null, 2)}\n`);

function buildOrders(rows) {
  const map = new Map();
  for (const row of rows) {
    const orderKey = String(row.projectId || row.projectCode || "");
    const processCode = String(row.processCode || "").trim();
    if (!orderKey || !processCode) continue;
    const stepKey = String(row.taskId || row.projectProcessId || row.processId || processCode);
    const order = map.get(orderKey) || { orderKey, projectCode: row.projectCode || "", productCode: row.productCode || "", productName: row.productName || "", stepMap: new Map() };
    const time = timestamp(row.starttimeofReport) ?? timestamp(row.createdAt) ?? Number.MAX_SAFE_INTEGER;
    const step = order.stepMap.get(stepKey) || { stepKey, processCode, firstAt: time, reports: 0 };
    step.firstAt = Math.min(step.firstAt, time);
    step.reports += 1;
    order.stepMap.set(stepKey, step);
    map.set(orderKey, order);
  }
  return [...map.values()].map((order) => {
    const steps = [...order.stepMap.values()].toSorted((a, b) => a.firstAt - b.firstAt || a.processCode.localeCompare(b.processCode));
    return { ...order, stepMap: undefined, steps, path: steps.map((step) => step.processCode).join(" → ") };
  });
}

function aggregateProcesses(rows, orders) {
  const map = new Map();
  for (const row of rows) {
    const code = String(row.processCode || "").trim();
    if (!code) continue;
    const item = map.get(code) || { processCode: code, reportCount: 0, reportWorkOrders: new Set(), staff: new Set(), products: new Set() };
    item.reportCount += 1;
    if (row.projectId || row.projectCode) item.reportWorkOrders.add(String(row.projectId || row.projectCode));
    if (row.productionStaff) item.staff.add(String(row.productionStaff));
    if (row.productCode || row.productName) item.products.add(String(row.productCode || row.productName));
    map.set(code, item);
  }
  const orderPositions = new Map();
  for (const order of orders) {
    order.steps.forEach((step, index) => {
      const entry = orderPositions.get(step.processCode) || { positions: [], starts: 0, ends: 0 };
      entry.positions.push(order.steps.length <= 1 ? 0.5 : index / (order.steps.length - 1));
      if (index === 0) entry.starts += 1;
      if (index === order.steps.length - 1) entry.ends += 1;
      orderPositions.set(step.processCode, entry);
    });
  }
  return [...map.values()].map((item) => {
    const positions = orderPositions.get(item.processCode) || { positions: [], starts: 0, ends: 0 };
    return {
      processCode: item.processCode,
      reportCount: item.reportCount,
      workOrderCount: item.reportWorkOrders.size,
      staffCount: item.staff.size,
      productCount: item.products.size,
      averageNormalizedPosition: average(positions.positions),
      startCount: positions.starts,
      endCount: positions.ends
    };
  }).toSorted((a, b) => b.reportCount - a.reportCount || b.workOrderCount - a.workOrderCount);
}

function aggregateTransitions(orders) {
  const map = new Map();
  const outgoing = new Map();
  for (const order of orders) {
    for (let index = 0; index < order.steps.length - 1; index += 1) {
      const from = order.steps[index].processCode;
      const to = order.steps[index + 1].processCode;
      if (!from || !to || from === to) continue;
      const key = `${from}\u0000${to}`;
      const item = map.get(key) || { fromProcess: from, toProcess: to, observations: 0, workOrders: new Set(), products: new Set() };
      item.observations += 1;
      item.workOrders.add(order.orderKey);
      if (order.productCode) item.products.add(order.productCode);
      map.set(key, item);
      outgoing.set(from, (outgoing.get(from) || 0) + 1);
    }
  }
  return [...map.values()].map((item) => ({
    fromProcess: item.fromProcess,
    toProcess: item.toProcess,
    observations: item.observations,
    workOrderCount: item.workOrders.size,
    productCount: item.products.size,
    confidence: item.observations / outgoing.get(item.fromProcess)
  })).toSorted((a, b) => b.observations - a.observations || b.confidence - a.confidence);
}

function aggregatePaths(orders, selector) {
  const map = new Map();
  for (const order of orders) {
    const path = selector(order);
    if (!path) continue;
    const item = map.get(path) || { path, workOrderCount: 0, products: new Set() };
    item.workOrderCount += 1;
    if (order.productCode) item.products.add(order.productCode);
    map.set(path, item);
  }
  return [...map.values()].map((item) => ({ path: item.path, workOrderCount: item.workOrderCount, productCount: item.products.size }))
    .toSorted((a, b) => b.workOrderCount - a.workOrderCount || b.productCount - a.productCount);
}

function aggregateEndpoints(orders, type) {
  const map = new Map();
  for (const order of orders) {
    const code = type === "start" ? order.steps[0]?.processCode : order.steps.at(-1)?.processCode;
    if (code) map.set(code, (map.get(code) || 0) + 1);
  }
  return [...map.entries()].map(([processCode, workOrderCount]) => ({ processCode, workOrderCount, share: workOrderCount / orders.length }))
    .toSorted((a, b) => b.workOrderCount - a.workOrderCount);
}

function buildCoreFlow(transitions, processes, coreCodes) {
  const positionByCode = new Map(processes.map((row) => [row.processCode, row.averageNormalizedPosition]));
  const incoming = new Map();
  const outgoing = new Map();
  for (const transition of transitions) {
    const nextList = outgoing.get(transition.fromProcess) || [];
    nextList.push(transition);
    outgoing.set(transition.fromProcess, nextList);
    const prevList = incoming.get(transition.toProcess) || [];
    prevList.push(transition);
    incoming.set(transition.toProcess, prevList);
  }
  return [...coreCodes].map((processCode) => {
    const next = (outgoing.get(processCode) || []).toSorted((a, b) => b.observations - a.observations).slice(0, 5);
    const previous = (incoming.get(processCode) || []).toSorted((a, b) => b.observations - a.observations).slice(0, 5);
    return {
      processCode,
      averageNormalizedPosition: positionByCode.get(processCode),
      previous,
      next
    };
  }).toSorted((a, b) => a.averageNormalizedPosition - b.averageNormalizedPosition);
}

function buildModularFlow(processes, totalRecords, transitions) {
  const definitions = [
    { stageId: "S1", label: "前段启动", min: 0, max: 0.2 },
    { stageId: "S2", label: "前段准备", min: 0.2, max: 0.4 },
    { stageId: "S3", label: "中段一", min: 0.4, max: 0.55 },
    { stageId: "S4", label: "中段二", min: 0.55, max: 0.7 },
    { stageId: "S5", label: "后段加工", min: 0.7, max: 0.85 },
    { stageId: "S6", label: "收尾报工", min: 0.85, max: 1.01 }
  ];
  const stages = definitions.map((definition) => {
    const assigned = processes.filter((row) => row.averageNormalizedPosition >= definition.min && row.averageNormalizedPosition < definition.max);
    const reportCount = assigned.reduce((sum, row) => sum + row.reportCount, 0);
    return {
      ...definition,
      processCount: assigned.length,
      reportCount,
      reportShare: reportCount / totalRecords,
      topProcesses: assigned
    };
  });
  const primaryTransitions = transitions
    .filter((row) => row.workOrderCount >= 100 && row.confidence >= 0.6)
    .toSorted((a, b) => b.workOrderCount - a.workOrderCount || b.confidence - a.confidence);
  return {
    definition: "将覆盖 90% 报工记录的 97 个工序编码，按其在工单历史路径中的平均相对位置分为 6 个阶段；阶段内为可选工序，未收录编码走人工兜底",
    targetCoverage: 0.9,
    achievedCoverage: processes.reduce((sum, row) => sum + row.reportCount, 0) / totalRecords,
    fallbackShare: 1 - processes.reduce((sum, row) => sum + row.reportCount, 0) / totalRecords,
    stages,
    primaryTransitions
  };
}

function findProcessCountForFullOrderCoverage(processes, orders, target) {
  for (let count = 1; count <= processes.length; count += 1) {
    const selected = new Set(processes.slice(0, count).map((row) => row.processCode));
    const workOrdersCovered = orders.filter((order) => order.steps.every((step) => selected.has(step.processCode))).length;
    const coverage = workOrdersCovered / orders.length;
    if (coverage >= target) {
      return {
        processCount: count,
        workOrdersCovered,
        workOrderCount: orders.length,
        coverage,
        reportCoverage: processes.slice(0, count).reduce((sum, row) => sum + row.reportCount, 0) / processes.reduce((sum, row) => sum + row.reportCount, 0)
      };
    }
  }
  return { processCount: processes.length, workOrdersCovered: orders.length, workOrderCount: orders.length, coverage: 1, reportCoverage: 1 };
}

function takeThroughCoverage(rows, total, target, field) {
  const items = [];
  let covered = 0;
  for (const row of rows) {
    items.push({ ...row, cumulativeCoverage: (covered += row[field]) / total });
    if (covered / total >= target) break;
  }
  return { items, coverage: covered / total };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function timestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value).includes("T") ? String(value) : `${String(value).replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateRange(values) {
  const times = values.map(timestamp).filter(Number.isFinite).toSorted((a, b) => a - b);
  return times.length ? { from: new Date(times[0]).toISOString(), to: new Date(times.at(-1)).toISOString() } : null;
}
