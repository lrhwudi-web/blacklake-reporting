import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";
import { createApp } from "../src/app.mjs";
import { createProductionTools } from "../src/agent-tools.mjs";
import { WeeklyStore } from "../src/weekly-store.mjs";
import { modelReportEvidence } from "../src/production-insights.mjs";

const key = "weekly-test-admin-key-at-least-32-characters";
const headers = { "x-admin-key": key, "content-type": "application/json" };
const now = () => Date.parse("2026-10-22T11:00:00Z");
const sampleFinding = (key = "quantity:101") => ({ key, kind: "QUANTITY_DEVIATION", title: "工序累计超计划，需核查",
  category: "data", projectCode: "TEST-WO-01", taskId: 101, facts: ["计划100件，当前累计200件"],
  possibleCauses: ["可能是协作重复计量"], nextChecks: ["核对黑湖原始记录"],
  evidence: [{ id: "task:101", source: "blacklake_task", projectCode: "TEST-WO-01", taskId: 101, plannedAmount: 100, reportedGoodAmount: 200 }] });
function snapshot() {
  return { period: { startDate: "2026-10-12", endDate: "2026-10-19", start: "2026-10-12T00:00:00+08:00", end: "2026-10-19T00:00:00+08:00", label: "2026-10-12 至 2026-10-18", basis: "createdAt" },
    previousPeriod: { startDate: "2026-10-05", endDate: "2026-10-12" }, generatedAt: new Date(now()).toISOString(), mode: "mock",
    coverage: { current: { complete: true, warnings: [], pages: 2, uniqueCount: 101 }, previous: { complete: true, warnings: [] },
      local: { complete: true }, tasks: { complete: true }, warnings: [] },
    metrics: { current: { recordCount: 101, workOrderCount: 2, groups: [] }, previous: { recordCount: 90 }, comparison: { recordCountDelta: 11 } },
    progress: [{ projectCode: "TEST-WO-01", taskId: 101, processName: "测试工序", plannedAmount: 100, reportedGoodAmount: 200 }],
    findings: [sampleFinding()], sources: [], limitations: ["未接入真实客户交期，不判断延期。"] };
}
async function fixture(t, { collect, runner, enabled = true } = {}) {
  const config = loadConfig({ BLACKLAKE_MODE: "mock", SESSION_SECRET: "weekly-session-secret-at-least-32-characters",
    ADMIN_API_KEY: key, ADMIN_PROXY_SECRET: "weekly-proxy-secret-at-least-32-characters" });
  config.agent = { enabled, apiKey: "fixture-only", model: "fixture", timeoutMs: 1000, maxSteps: 2 };
  const store = new Store(":memory:", config);
  let queries = 0, models = 0, writes = 0;
  const blacklake = { config: { mode: "mock" }, listProjectTasks: async () => [],
    submitOutput: async () => { writes++; throw new Error("unexpected upstream write"); } };
  const server = createServer(createApp({ config, store, blacklake, now,
    weeklyCollector: async (input) => { queries++; return collect ? collect(input) : snapshot(); },
    insightRunner: async (input) => { models++; return runner ? runner(input) : input.kind === "weekly" ? { summary: ["本期存在数量核查线索，需主管确认。"] }
      : { possibleCauses: ["可能存在协作重复计量，需核实。"], nextChecks: ["请核对原始两笔记录。"] }; } }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close(); });
  const root = `http://127.0.0.1:${server.address().port}/v1/admin`;
  async function request(path, body, method = body === undefined ? "GET" : "POST", extraHeaders = {}) {
    const response = await fetch(root + path, { method, headers: { ...headers, ...extraHeaders }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { request, store, blacklake, counts: () => ({ queries, models, writes }) };
}

test("weekly generation requires admin and same-origin before query; anonymous proxy cannot forge reviewer", async (t) => {
  const api = await fixture(t);
  assert.equal((await api.request("/weekly-reports", {}, "POST", { "x-admin-key": "bad" })).status, 401);
  assert.equal((await api.request("/weekly-reports", {}, "POST", { origin: "https://evil.example" })).status, 403);
  assert.equal((await api.request("/weekly-reports", {}, "POST", { "x-admin-key": "", "x-admin-proxy-secret": "weekly-proxy-secret-at-least-32-characters" })).status, 401);
  assert.equal((await api.request("/weekly-reports", { actor: "boss" })).status, 400);
  assert.deepEqual(api.counts(), { queries: 0, models: 0, writes: 0 });
});

test("draft -> save -> AI narrative -> manual review; reviewed evidence cannot be edited or sent automatically", async (t) => {
  const api = await fixture(t);
  const created = await api.request("/weekly-reports", {});
  assert.equal(created.status, 201);
  let report = created.body.report;
  assert.equal(report.status, "DRAFT");
  assert.equal(report.snapshot.risks.length, 1);
  report = (await api.request(`/weekly-reports/${report.id}`, { revision: report.revision, coordination: "暂无", managementNote: "数量待核，暂不判断实际超产。" }, "PATCH")).body.report;
  const analyzed = await api.request(`/weekly-reports/${report.id}/analyze`, { revision: report.revision });
  assert.equal(analyzed.status, 200);
  report = analyzed.body.report;
  assert.ok(report.narrative.summary[0].includes("核查"));
  const reviewed = await api.request(`/weekly-reports/${report.id}/review`, { revision: report.revision });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.report.status, "REVIEWED");
  assert.ok(reviewed.body.report.reviewedAt);
  assert.equal((await api.request(`/weekly-reports/${report.id}`, { revision: reviewed.body.report.revision, coordination: "new" }, "PATCH")).status, 409);
  assert.equal(api.counts().writes, 0);
  const filtered = await api.request("/weekly-reports?status=REVIEWED");
  assert.equal(filtered.body.reports.length, 1);
});

test("feedback is persistent, prevents stale review, and suppresses unchanged confirmed-normal risk", async (t) => {
  const api = await fixture(t);
  const first = (await api.request("/weekly-reports", {})).body.report;
  const entry = first.snapshot.findings[0];
  const feedback = await api.request(`/production-findings/${encodeURIComponent(entry.key)}/feedback`, { revision: entry.revision,
    status: "CONFIRMED_NORMAL", reason: "NORMAL_OVERPRODUCTION", note: "已核对，追加加工。" });
  assert.equal(feedback.status, 200);
  const stale = await api.request(`/weekly-reports/${first.id}/review`, { revision: first.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "WEEKLY_EVIDENCE_CHANGED");
  const second = (await api.request("/weekly-reports", {})).body.report;
  assert.equal(second.snapshot.risks.length, 0);
  assert.equal(second.snapshot.handling.CONFIRMED_NORMAL, 1);
  assert.equal(api.counts().writes, 0);
});

test("AI failure/invalid shape preserves draft and server owns facts; output cannot promote hypotheses to facts", async (t) => {
  const api = await fixture(t, { runner: async () => ({ facts: ["已确认重复报工"], possibleCauses: ["whatever"], nextChecks: ["test"] }) });
  const report = (await api.request("/weekly-reports", {})).body.report;
  const response = await api.request(`/production-findings/${encodeURIComponent(report.snapshot.findings[0].key)}/analyze`, {});
  assert.equal(response.status, 502);
  const after = (await api.request(`/weekly-reports/${report.id}`)).body.report;
  assert.equal(after.revision, report.revision);
  assert.equal(after.narrative, null);
  assert.deepEqual(after.snapshot.findings[0].facts, report.snapshot.findings[0].facts);
});

test("AI disabled still permits a covered or explicitly partial draft and review", async (t) => {
  const api = await fixture(t, { enabled: false, collect: async () => { const data = snapshot(); data.coverage.current.complete = false;
    data.coverage.current.warnings = ["第二页读取失败"]; return data; } });
  const report = (await api.request("/weekly-reports", {})).body.report;
  assert.equal(report.snapshot.coverage.current.complete, false);
  assert.equal((await api.request(`/weekly-reports/${report.id}/analyze`, { revision: report.revision })).status, 503);
  assert.equal((await api.request(`/weekly-reports/${report.id}/review`, { revision: report.revision })).status, 200);
  assert.equal(api.counts().models, 0);
});

test("raw provider errors are sanitized", async (t) => {
  const api = await fixture(t, { runner: async () => { throw new Error("secret-provider-body fixture-token-123"); } });
  const report = (await api.request("/weekly-reports", {})).body.report;
  const response = await api.request(`/weekly-reports/${report.id}/analyze`, { revision: report.revision });
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(response.body), /fixture-token|secret-provider/);
});

test("hung AI times out without changing report; concurrent edits win over late model output", async (t) => {
  const hung = await fixture(t, { runner: () => new Promise(() => {}) });
  const first = (await hung.request("/weekly-reports", {})).body.report;
  const timed = await hung.request(`/weekly-reports/${first.id}/analyze`, { revision: first.revision });
  assert.equal(timed.status, 504);
  assert.equal((await hung.request(`/weekly-reports/${first.id}`)).body.report.revision, first.revision);

  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const api = await fixture(t, { runner: () => { started(); return new Promise((resolve) => { release = resolve; }); } });
  const report = (await api.request("/weekly-reports", {})).body.report;
  const analyzing = api.request(`/weekly-reports/${report.id}/analyze`, { revision: report.revision });
  await ready;
  const saved = await api.request(`/weekly-reports/${report.id}`, { revision: report.revision, managementNote: "主管刚核实的判断", coordination: "暂无" }, "PATCH");
  assert.equal(saved.status, 200);
  release({ summary: ["迟到的解释"] });
  assert.equal((await analyzing).status, 409);
  assert.equal((await api.request(`/weekly-reports/${report.id}`)).body.report.managementNote, "主管刚核实的判断");
});

test("read-only Agent tool reads saved report and current feedback, excludes prior AI prose and write tools", async (t) => {
  const api = await fixture(t);
  const report = (await api.request("/weekly-reports", {})).body.report;
  const records = new WeeklyStore(api.store.db);
  const tools = createProductionTools({ blacklake: api.blacklake, store: api.store, weeklyStore: records, now });
  const data = await tools.readWeeklyReport.execute({ reportId: report.id });
  assert.equal(data.data.reportId, report.id);
  assert.equal(data.data.narrativeIncluded, false);
  const missing = await tools.readWeeklyReport.execute({ reportId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(missing.data.report, null);
  assert.deepEqual(Object.keys(missing.data.reports[0]).sort(), ["createdAt", "id", "status"]);
  assert.match(data.sources[0].url, /view=weekly&reportId=/);
  assert.ok(data.warnings.some((item) => item.includes("模拟")));
  assert.ok(Object.keys(tools).every((name) => !/save|review|write|submit/i.test(name) || name === "listNeedsReview"));
  assert.equal(api.counts().writes, 0);
});

test("model context strips operator/audit identities and authentication metadata", () => {
  const data = snapshot();
  const input = { snapshot: data, createdBy: "private-actor", reviewedBy: "private-actor", token: "secret", coordination: "暂无" };
  const evidence = modelReportEvidence(input);
  assert.doesNotMatch(JSON.stringify(evidence), /private-actor|secret/);
  assert.equal(evidence.period.basis, "createdAt");
});
