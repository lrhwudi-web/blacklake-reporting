import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [input = "data/exports/blacklake-outputs-2026-08-01-to-2026-08-24.json", outputArg = "data/analysis/process-flow-analysis-2026-08-01-to-2026-08-24.json"] = process.argv.slice(2);
const output = resolve(outputArg);
const records = JSON.parse(await readFile(resolve(input), "utf8"));

const workOrders = buildWorkOrders(records);
const transitions = buildTransitions(workOrders);
const staffProfiles = buildStaffProfiles(records);
const productProfiles = buildProductProfiles(workOrders);
const pathProfiles = buildPathProfiles(workOrders);
const customFields = buildCustomFieldProfile(records);

const result = {
  generatedAt: new Date().toISOString(),
  source: resolve(input),
  methodology: {
    workOrderKey: "projectId（缺失时使用 projectCode）",
    stepKey: "taskId（缺失时使用 processId/processCode）",
    stepOrder: "按每个任务最早的 starttimeofReport 排序；缺失时使用 createdAt",
    repeatedReports: "同一工单、同一 taskId 的多人或多次报工合并为一个生产步骤",
    confidence: "候选规则命中次数 / 同一条件下全部可观察次数",
    limitations: [
      "时间窗口两端可能包含未完整覆盖的工单，因此完整路径仅作参考，工序转移统计更稳健",
      "报工结果数据不能还原网页点击、扫码、输入、提交等交互步骤；需额外获取操作日志",
      "processCode 只有编码没有工序名称，落地前需由主管补充编码到工序名称映射"
    ]
  },
  summary: {
    recordCount: records.length,
    period: dateRange(records.map((row) => row.createdAt)),
    workOrderCount: workOrders.length,
    multiStepWorkOrderCount: workOrders.filter((order) => order.steps.length >= 2).length,
    productCount: new Set(records.map((row) => row.productCode).filter(Boolean)).size,
    processCount: new Set(records.map((row) => row.processCode).filter(Boolean)).size,
    staffCount: new Set(records.map((row) => row.productionStaff).filter(Boolean)).size,
    uniqueObservedPathCount: pathProfiles.length,
    transitionRuleCount: transitions.length,
    highConfidenceStaffCount: staffProfiles.filter((row) => row.decisionTier === "可自动判断").length,
    mediumConfidenceStaffCount: staffProfiles.filter((row) => row.decisionTier === "建议确认").length,
    manualStaffCount: staffProfiles.filter((row) => row.decisionTier === "必须人工选择").length
  },
  decisionPolicy: {
    thresholds: {
      automatic: "人员历史报工 >= 20 条、涉及 >= 3 个工单、主工序占比 >= 80%",
      suggest: "人员历史报工 >= 10 条、涉及 >= 2 个工单、主工序占比 >= 60%",
      transitionAutomatic: "同一前置工序至少 5 个工单可观察，下一工序置信度 >= 80%",
      productPathAutomatic: "同一产品至少 3 个工单，主路径占比 >= 70%"
    },
    priority: [
      "1. 黑湖若直接返回当前任务/工序，始终以黑湖为准",
      "2. 已识别人员且其主工序达到自动阈值：使用人员主工序",
      "3. 已知当前工单最后完成工序：使用高置信度的下一工序转移",
      "4. 已知产品且历史主路径稳定：按产品主路径定位下一工序",
      "5. 多信号冲突或置信度不足：让员工选择并记录，作为后续训练样本"
    ]
  },
  topPaths: pathProfiles.slice(0, 50),
  transitions,
  staffProfiles,
  productProfiles,
  customFields,
  workOrderSamples: workOrders.toSorted((a, b) => b.steps.length - a.steps.length).slice(0, 100)
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, summary: result.summary, topTransitions: transitions.slice(0, 10), topStaff: staffProfiles.slice(0, 10) }, null, 2)}\n`);

function buildWorkOrders(rows) {
  const orders = new Map();
  for (const row of rows) {
    const orderKey = String(row.projectId || row.projectCode || "");
    if (!orderKey) continue;
    const order = orders.get(orderKey) || {
      orderKey,
      projectId: row.projectId ?? null,
      projectCode: row.projectCode || "",
      productCode: row.productCode || "",
      productName: row.productName || "",
      records: 0,
      stepMap: new Map()
    };
    order.records += 1;
    const stepKey = String(row.taskId || row.projectProcessId || row.processId || row.processCode || "");
    if (!stepKey) continue;
    const step = order.stepMap.get(stepKey) || {
      stepKey,
      taskId: row.taskId ?? null,
      processId: row.processId ?? null,
      processCode: row.processCode || "",
      firstAt: null,
      lastAt: null,
      createdAt: null,
      reports: 0,
      staff: new Set()
    };
    const start = timestamp(row.starttimeofReport) || timestamp(row.createdAt);
    const end = timestamp(row.endtimeofReport) || timestamp(row.createdAt);
    const created = timestamp(row.createdAt);
    step.firstAt = minDate(step.firstAt, start);
    step.lastAt = maxDate(step.lastAt, end);
    step.createdAt = minDate(step.createdAt, created);
    step.reports += 1;
    if (row.productionStaff) step.staff.add(String(row.productionStaff));
    order.stepMap.set(stepKey, step);
    orders.set(orderKey, order);
  }

  return [...orders.values()].map((order) => {
    const steps = [...order.stepMap.values()]
      .toSorted((a, b) => (a.firstAt || a.createdAt || Infinity) - (b.firstAt || b.createdAt || Infinity) || String(a.processCode).localeCompare(String(b.processCode)))
      .map((step, index) => ({
        position: index + 1,
        taskId: step.taskId,
        processId: step.processId,
        processCode: step.processCode,
        firstAt: iso(step.firstAt),
        lastAt: iso(step.lastAt),
        reports: step.reports,
        staff: [...step.staff].toSorted()
      }));
    return {
      orderKey: order.orderKey,
      projectId: order.projectId,
      projectCode: order.projectCode,
      productCode: order.productCode,
      productName: order.productName,
      recordCount: order.records,
      stepCount: steps.length,
      path: steps.map((step) => step.processCode).join(" → "),
      steps
    };
  });
}

function buildTransitions(orders) {
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
  return [...map.values()]
    .map((item) => {
      const confidence = item.observations / outgoing.get(item.fromProcess);
      return {
        fromProcess: item.fromProcess,
        toProcess: item.toProcess,
        observations: item.observations,
        workOrderCount: item.workOrders.size,
        productCount: item.products.size,
        confidence,
        decisionTier: item.workOrders.size >= 5 && confidence >= 0.8 ? "可自动判断" : item.workOrders.size >= 3 && confidence >= 0.6 ? "建议确认" : "仅供参考"
      };
    })
    .toSorted((a, b) => b.workOrderCount - a.workOrderCount || b.confidence - a.confidence || b.observations - a.observations);
}

function buildStaffProfiles(rows) {
  const map = new Map();
  for (const row of rows) {
    const staff = String(row.productionStaff || "");
    const process = String(row.processCode || "");
    if (!staff || !process) continue;
    const item = map.get(staff) || { staff, reports: 0, workOrders: new Set(), processes: new Map(), products: new Set(), firstAt: null, lastAt: null };
    item.reports += 1;
    item.workOrders.add(String(row.projectId || row.projectCode || ""));
    item.products.add(String(row.productCode || ""));
    item.processes.set(process, (item.processes.get(process) || 0) + 1);
    item.firstAt = minDate(item.firstAt, timestamp(row.createdAt));
    item.lastAt = maxDate(item.lastAt, timestamp(row.createdAt));
    map.set(staff, item);
  }
  return [...map.values()]
    .map((item) => {
      const ranked = [...item.processes.entries()].map(([processCode, reports]) => ({ processCode, reports, share: reports / item.reports })).toSorted((a, b) => b.reports - a.reports);
      const dominant = ranked[0] || { processCode: "", reports: 0, share: 0 };
      const decisionTier = item.reports >= 20 && item.workOrders.size >= 3 && dominant.share >= 0.8
        ? "可自动判断"
        : item.reports >= 10 && item.workOrders.size >= 2 && dominant.share >= 0.6
          ? "建议确认"
          : "必须人工选择";
      return {
        staff: item.staff,
        reportCount: item.reports,
        workOrderCount: item.workOrders.size,
        productCount: [...item.products].filter(Boolean).length,
        uniqueProcessCount: ranked.length,
        dominantProcess: dominant.processCode,
        dominantReports: dominant.reports,
        dominantShare: dominant.share,
        secondProcess: ranked[1]?.processCode || "",
        secondShare: ranked[1]?.share || 0,
        decisionTier,
        observedFrom: iso(item.firstAt),
        observedTo: iso(item.lastAt),
        topProcesses: ranked.slice(0, 10)
      };
    })
    .toSorted((a, b) => tierRank(a.decisionTier) - tierRank(b.decisionTier) || b.dominantShare - a.dominantShare || b.reportCount - a.reportCount);
}

function buildProductProfiles(orders) {
  const map = new Map();
  for (const order of orders) {
    const key = String(order.productCode || order.productName || "");
    if (!key) continue;
    const item = map.get(key) || { productCode: order.productCode, productName: order.productName, workOrders: 0, paths: new Map() };
    item.workOrders += 1;
    if (order.path) item.paths.set(order.path, (item.paths.get(order.path) || 0) + 1);
    map.set(key, item);
  }
  return [...map.values()]
    .map((item) => {
      const paths = [...item.paths.entries()].map(([path, count]) => ({ path, count, share: count / item.workOrders })).toSorted((a, b) => b.count - a.count);
      const dominant = paths[0] || { path: "", count: 0, share: 0 };
      return {
        productCode: item.productCode,
        productName: item.productName,
        workOrderCount: item.workOrders,
        pathVariantCount: paths.length,
        dominantPath: dominant.path,
        dominantPathCount: dominant.count,
        dominantPathShare: dominant.share,
        decisionTier: item.workOrders >= 3 && dominant.share >= 0.7 ? "可自动判断" : item.workOrders >= 2 && dominant.share >= 0.5 ? "建议确认" : "样本不足",
        topPaths: paths.slice(0, 5)
      };
    })
    .toSorted((a, b) => tierRank(a.decisionTier) - tierRank(b.decisionTier) || b.workOrderCount - a.workOrderCount || b.dominantPathShare - a.dominantPathShare);
}

function buildPathProfiles(orders) {
  const map = new Map();
  for (const order of orders) {
    if (!order.path) continue;
    const item = map.get(order.path) || { path: order.path, workOrders: 0, products: new Set(), minSteps: order.stepCount, maxSteps: order.stepCount };
    item.workOrders += 1;
    if (order.productCode) item.products.add(order.productCode);
    item.minSteps = Math.min(item.minSteps, order.stepCount);
    item.maxSteps = Math.max(item.maxSteps, order.stepCount);
    map.set(order.path, item);
  }
  return [...map.values()].map((item) => ({
    path: item.path,
    workOrderCount: item.workOrders,
    productCount: item.products.size,
    minSteps: item.minSteps,
    maxSteps: item.maxSteps
  })).toSorted((a, b) => b.workOrderCount - a.workOrderCount || b.productCount - a.productCount);
}

function buildCustomFieldProfile(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const field of row.customFieldValues || []) {
      const name = String(field?.name || "");
      if (!name) continue;
      const item = map.get(name) || { name, total: 0, populated: 0, values: new Map() };
      item.total += 1;
      if (field.value !== null && field.value !== undefined && String(field.value) !== "") {
        item.populated += 1;
        const value = String(field.value);
        item.values.set(value, (item.values.get(value) || 0) + 1);
      }
      map.set(name, item);
    }
  }
  return [...map.values()].map((item) => ({
    name: item.name,
    total: item.total,
    populated: item.populated,
    populatedShare: item.total ? item.populated / item.total : 0,
    distinctValues: item.values.size,
    topValues: [...item.values.entries()].map(([value, count]) => ({ value, count })).toSorted((a, b) => b.count - a.count).slice(0, 20)
  })).toSorted((a, b) => b.populated - a.populated);
}

function timestamp(value) {
  if (!value) return null;
  const time = new Date(String(value).replace(" ", "T") + "+08:00").getTime();
  return Number.isFinite(time) ? time : null;
}

function minDate(current, value) {
  if (value === null) return current;
  return current === null ? value : Math.min(current, value);
}

function maxDate(current, value) {
  if (value === null) return current;
  return current === null ? value : Math.max(current, value);
}

function iso(value) {
  return value === null ? null : new Date(value).toISOString();
}

function dateRange(values) {
  const times = values.map(timestamp).filter((value) => value !== null).toSorted((a, b) => a - b);
  return times.length ? { from: iso(times[0]), to: iso(times.at(-1)) } : null;
}

function tierRank(value) {
  return ({ "可自动判断": 0, "建议确认": 1, "仅供参考": 2, "必须人工选择": 3, "样本不足": 4 })[value] ?? 9;
}
