// Local-only UI regression fixture. No credentials, production data or writes.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const workOrders = Array.from({ length: 143 }, (_, i) => ({
  projectCode: `QA-${String(i + 1).padStart(3, "0")}`,
  productName: `测试产品 ${i + 1} · 长名称红色PU双耳磁铁款半圆形球杆套`,
  processes: Array.from({ length: 28 }, (_, j) => ({
    taskId: i * 100 + j + 1, sequence: j + 1, processName: `工序 ${j + 1}`,
    plannedAmount: 200, reportedAmount: i < 10 ? 190 : i < 20 ? 200 : i < 30 ? 0 : j % 3 === 0 ? 100 : 0,
    processStatus: i >= 10 && i < 20 ? 20 : 10
  }))
}));
const assignments = workOrders.map((order, i) => ({
  id: `qa-record-${i}`, projectCode: order.projectCode, productName: order.productName,
  taskId: i * 100 + 1, processName: "工序 1", quantity: 100, goodQuantity: 100,
  operatorName: "测试工人", status: i >= 20 && i < 30 ? "IN_PROGRESS" : "COMPLETED", effectiveDurationSeconds: 35,
  startedAt: "2026-09-08 08:00:00", endedAt: "2026-09-08 08:00:35"
}));
const files = new Map([["/", "index.html"], ["/admin/", "index.html"], ["/admin/app.js", "app.js"], ["/admin/styles.css", "styles.css"]]);
const syncScenario = process.env.QA_SYNC_SCENARIO || "fresh";
const snapshotOrders = workOrders.map((order, i) => ({ ...order,
  processes: syncScenario === "unavailable" || syncScenario === "mixed" && i === 1 ? [] : order.processes,
  processSync: { status: syncScenario === "mixed" ? (i === 0 ? "stale" : i === 1 ? "empty" : "fresh") : syncScenario, updatedAt: syncScenario === "unavailable" ? null : "2026-09-08T01:00:00.000Z" }
}));
createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  if (path === "/api/me" || path === "/v1/admin/assignments" || path === "/v1/admin/operators" || path === "/v1/admin/audit") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(path === "/api/me" ? { user: { name: "本地测试（非生产）" } } : path.endsWith("operators") ? { operators: [] } : path.endsWith("audit") ? { events: [], total: 0, limit: 50, offset: 0, facets: { errorCodes: [], actors: [] } } : { assignments, workOrders: snapshotOrders, syncWarning: syncScenario === "fresh" ? "" : "本地测试：模拟工序同步降级" }));
    return;
  }
  const file = files.get(path);
  if (!file) { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
  res.end(await readFile(new URL(`../${file}`, import.meta.url)));
}).listen(4197, "127.0.0.1", () => console.log("Local UI fixture: http://127.0.0.1:4197/admin/"));
