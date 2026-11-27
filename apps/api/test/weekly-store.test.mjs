import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WeeklyStore } from "../src/weekly-store.mjs";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => db.close());
  return { db, store: new WeeklyStore(db) };
}
const finding = (extra = {}) => ({ key: "over-plan:7:8", kind: "quantity_over_plan", title: "工序超计划", category: "data",
  taskId: 8, projectCode: "WO-7", facts: ["累计110件，计划100件"], possibleCauses: [], nextChecks: ["核对计划"],
  evidence: [{ source: "blacklake_tasks", taskId: 8, plannedAmount: 100, reportedGoodAmount: 110, asOf: "2026-10-22T00:00:00Z" }], ...extra });
const snapshot = (findings = []) => ({ period: { startDate: "2026-10-19" }, generatedAt: "2026-10-22T00:00:00Z", findings,
  coverage: { current: { complete: false } }, metrics: { recordCount: 3 }, limitations: ["范围不完整"] });
const narrative = { summary: ["当前取数范围内有事项需要核查。"], limitations: ["待人工核实"], generatedAt: "2026-10-22T00:00:00Z", model: "test-model" };

test("周报固定快照与事项状态不随原对象、后续反馈或读取对象变化", t => {
  const { store } = fixture(t);
  const [item] = store.upsertFindings([finding()]);
  const input = snapshot([{ ...item, carriedForward: true, observationNote: "历史跟进，本次未重新获取来源证据。" }]);
  input.risks = input.findings;
  const report = store.createDraft({ snapshot: input, actor: "admin-a" });
  input.metrics.recordCount = 99;
  report.snapshot.metrics.recordCount = 88;
  store.feedbackFinding(item.key, { revision: 1, status: "CONFIRMED_NORMAL", reason: "NORMAL_OVERPRODUCTION", note: "确认补做" }, "admin-b");
  const saved = store.getReport(report.id);
  assert.equal(saved.snapshot.metrics.recordCount, 3);
  assert.equal(saved.snapshot.findings[0].status, "NEW");
  assert.equal(saved.snapshot.findings[0].revision, 1);
  assert.equal(saved.snapshot.findings[0].carriedForward, true);
  assert.equal(saved.snapshot.findings[0].observationNote, "历史跟进，本次未重新获取来源证据。");
  assert.equal(saved.snapshot.risks[0].events, undefined);
  assert.equal(saved.snapshot.risks[0].carriedForward, true);
  assert.equal(saved.revision, 1);
  assert.equal(saved.createdBy, "admin-a");
  assert.equal(saved.reviewedAt, null);
});

test("编辑与审阅CAS拒绝旧版本，审阅后文字与快照不可再编辑", t => {
  const { store, db } = fixture(t);
  const report = store.createDraft({ snapshot: snapshot(), actor: "admin-a" });
  const edited = store.updateDraft(report.id, { revision: 1, coordination: "需要安排复核", managementNote: "周会核实" }, "admin-a");
  assert.equal(edited.revision, 2);
  assert.throws(() => store.reviewReport(report.id, { revision: 1 }, "admin-b"), { status: 409, code: "WEEKLY_CONFLICT" });
  const reviewed = store.reviewReport(report.id, { revision: 2 }, "admin-b");
  assert.equal(reviewed.status, "REVIEWED");
  assert.equal(reviewed.revision, 3);
  assert.equal(reviewed.reviewedBy, "admin-b");
  assert.ok(reviewed.reviewedAt);
  assert.throws(() => store.updateDraft(report.id, { revision: 3, coordination: "覆盖" }, "admin-a"), { status: 409 });
  assert.throws(() => store.reviewReport(report.id, { revision: 3 }, "admin-a"), { status: 409 });
  assert.throws(() => store.setNarrative(report.id, { revision: 3, narrative }, "admin-a"), { status: 409 });
  assert.deepEqual(db.prepare("SELECT action FROM weekly_report_events ORDER BY revision").all().map(row => row.action), ["CREATED", "EDITED", "REVIEWED"]);
  assert.equal(store.getReport(report.id).coordination, "需要安排复核");
  const listed = store.listReports({ status: "REVIEWED" })[0];
  assert.equal(listed.id, report.id);
  assert.equal(listed.period.startDate, "2026-10-19");
  assert.deepEqual(Object.keys(listed).sort(), ["createdAt", "id", "period", "reviewedAt", "revision", "startDate", "status", "updatedAt"]);
});

test("AI文字属于草稿版本，人工编辑清除旧AI摘要且审计保留生成原文", t => {
  const { store, db } = fixture(t);
  const report = store.createDraft({ snapshot: snapshot(), actor: "admin-a" });
  const analyzed = store.setNarrative(report.id, { revision: 1, narrative }, "admin-a");
  assert.equal(analyzed.revision, 2);
  assert.equal(analyzed.narrative.summary[0], narrative.summary[0]);
  assert.throws(() => store.setNarrative(report.id, { revision: 1, narrative }, "admin-a"), { status: 409 });
  const edited = store.updateDraft(report.id, { revision: 2, managementNote: "人工更新" }, "admin-a");
  assert.equal(edited.narrative, null);
  const event = db.prepare("SELECT detail_json FROM weekly_report_events WHERE action='AI_DRAFTED'").get();
  assert.equal(JSON.parse(event.detail_json).narrative.model, "test-model");
});

test("相同证据重取不重开已确认正常；时间、等待小时和证据顺序不制造版本变化", t => {
  const { store } = fixture(t);
  const original = finding({ evidence: [...finding().evidence, { source: "local", assignmentId: "a", status: "NEEDS_REVIEW", endedAt: "2026-10-20T00:00:00Z" }] });
  store.upsertFindings([original]);
  const confirmed = store.feedbackFinding(original.key, { revision: 1, status: "CONFIRMED_NORMAL", reason: "PLAN_OUTDATED", note: "已核实" }, "admin-a");
  const refreshed = finding({ facts: ["已等待49小时"], evidence: original.evidence.toReversed().map(item => ({ ...item, asOf: "2026-10-23T00:00:00Z", ageHours: 49 })) });
  const [again] = store.upsertFindings([refreshed], { observedAt: "2026-10-23T00:00:00Z" });
  assert.equal(again.status, "CONFIRMED_NORMAL");
  assert.equal(again.revision, confirmed.revision);
  assert.equal(again.evidenceVersion, confirmed.evidenceVersion);
  assert.equal(again.events.length, 2);
  assert.equal(again.note, "已核实");
});

test("实质数量变化重新核查并保留原人工结论，旧版本反馈不能覆盖新证据", t => {
  const { store } = fixture(t);
  store.upsertFindings([finding()]);
  store.feedbackFinding(finding().key, { revision: 1, status: "RESOLVED", reason: "SYSTEM_ISSUE", note: "处理原记录" }, "admin-a");
  const changed = finding({ evidence: [{ ...finding().evidence[0], reportedGoodAmount: 150 }] });
  const [item] = store.upsertFindings([changed]);
  assert.equal(item.status, "INVESTIGATING");
  assert.equal(item.revision, 3);
  assert.equal(item.evidenceChanged, true);
  assert.equal(item.events[1].detail.note, "处理原记录");
  assert.equal(item.events[2].action, "EVIDENCE_CHANGED");
  assert.equal(item.events[2].detail.previousStatus, "RESOLVED");
  assert.throws(() => store.feedbackFinding(item.key, { revision: 2, status: "NEW" }, "admin-b"), { status: 409, code: "FINDING_CONFLICT" });
  const resolved = store.feedbackFinding(item.key, { revision: 3, status: "RESOLVED", reason: "OTHER", note: "复核新数量" }, "admin-b");
  assert.equal(resolved.evidenceChanged, false);
  assert.equal(resolved.events.length, 4);
});

test("存储重新初始化保留审阅和反馈，SQL按工单与taskId过滤避免全局截断", t => {
  const { store, db } = fixture(t);
  store.upsertFindings([finding(), finding({ key: "another", taskId: 9, projectCode: "WO-8" })]);
  const draft = store.createDraft({ snapshot: snapshot(), actor: "a" });
  store.reviewReport(draft.id, { revision: 1 }, "a");
  const reopened = new WeeklyStore(db);
  assert.equal(reopened.getReport(draft.id).status, "REVIEWED");
  const exact = reopened.listFindings({ taskId: 8, projectCode: "WO-7", limit: 1 });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].key, finding().key);
  assert.equal(reopened.listFindings({ taskId: 8, projectCode: "WO-8" }).length, 0);
});

test("SQLite文件关闭重开保留固定周报、人工反馈与审计历史", t => {
  const directory = mkdtempSync(join(tmpdir(), "blacklake-weekly-store-"));
  const file = join(directory, "weekly.sqlite");
  let db = new DatabaseSync(file);
  t.after(() => { db?.close(); rmSync(file, { force: true }); rmdirSync(directory); });
  const store = new WeeklyStore(db);
  const [item] = store.upsertFindings([finding()]);
  const report = store.createDraft({ snapshot: snapshot([item]), actor: "admin-a" });
  store.setNarrative(report.id, { revision: 1, narrative }, "admin-a");
  store.reviewReport(report.id, { revision: 2 }, "admin-b");
  store.feedbackFinding(item.key, { revision: 1, status: "RESOLVED", reason: "OTHER", note: "已核对原记录" }, "admin-b");
  db.close();
  db = null;
  db = new DatabaseSync(file);
  const reopened = new WeeklyStore(db);
  const saved = reopened.getReport(report.id);
  assert.equal(saved.status, "REVIEWED");
  assert.equal(saved.revision, 3);
  assert.equal(saved.reviewedBy, "admin-b");
  assert.equal(saved.narrative.summary[0], narrative.summary[0]);
  assert.equal(saved.snapshot.findings[0].status, "NEW");
  const latest = reopened.getFinding(item.key);
  assert.equal(latest.status, "RESOLVED");
  assert.equal(latest.note, "已核对原记录");
  assert.deepEqual(latest.events.map(event => event.action), ["DETECTED", "FEEDBACK"]);
  assert.deepEqual(db.prepare("SELECT action FROM weekly_report_events ORDER BY revision").all().map(row => row.action), ["CREATED", "AI_DRAFTED", "REVIEWED"]);
});

test("案例返回最近50条核查历史并说明截断，数据库完整保留审计", t => {
  const { store, db } = fixture(t);
  const [original] = store.upsertFindings([finding()]);
  for (let revision = 1; revision <= 55; revision++) {
    store.feedbackFinding(original.key, { revision, status: "INVESTIGATING", note: `第${revision}次复核` }, "admin-a");
  }
  const latest = store.getFinding(original.key);
  assert.equal(latest.events.length, 50);
  assert.equal(latest.eventsTotal, 56);
  assert.equal(latest.eventsTruncated, true);
  assert.equal(latest.events[0].revision, 7);
  assert.equal(latest.events.at(-1).revision, 56);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM production_finding_events WHERE finding_key=?").get(original.key).total, 56);
  assert.equal(db.prepare("SELECT action FROM production_finding_events WHERE finding_key=? AND revision=1").get(original.key).action, "DETECTED");
  const report = store.createDraft({ snapshot: snapshot([latest]), actor: "admin-a" });
  assert.equal(report.snapshot.findings[0].events, undefined);
  assert.equal(report.snapshot.findings[0].eventsTotal, undefined);
  assert.equal(report.snapshot.findings[0].eventsTruncated, undefined);
  assert.equal(report.snapshot.findings[0].updatedBy, undefined);
  assert.equal(report.snapshot.findings[0].revision, 56);
});

test("没有当前异常时仍读取周内已处理记录，上海周界按同一时刻比较且末端排除", t => {
  const { store, db } = fixture(t);
  const times = { before: "2026-10-18T15:59:59.999Z", start: "2026-10-18T16:00:00.000Z",
    inside: "2026-10-25T15:59:59.999Z", end: "2026-10-25T16:00:00.000Z" };
  for (const [key, at] of Object.entries(times)) {
    store.upsertFindings([finding({ key })]);
    store.feedbackFinding(key, { revision: 1, status: key === "start" ? "CONFIRMED_NORMAL" : "RESOLVED", reason: "OTHER", note: "当周核查结论" }, "admin-a");
    db.prepare("UPDATE production_finding_events SET created_at=? WHERE finding_key=? AND action='FEEDBACK'").run(at, key);
  }
  assert.equal(store.listFindings({ status: "NEW" }).length, 0);
  const result = store.reportFollowUps({ start: "2026-10-19T00:00:00+08:00", end: "2026-10-26T00:00:00+08:00" });
  assert.deepEqual(result.findings.map(item => item.key).sort(), ["inside", "start"]);
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
});

test("历史未结跨期跟进且优先返回，截断保留真实总数并拒绝非法范围", t => {
  const { store, db } = fixture(t);
  store.upsertFindings(Array.from({ length: 42 }, (_, index) => finding({ key: `old-open-${index}` })));
  store.feedbackFinding("old-open-0", { revision: 1, status: "INVESTIGATING", note: "继续核查" }, "admin-a");
  db.prepare("UPDATE production_findings SET created_at=?,updated_at=?,observed_at=?").run("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
  store.upsertFindings([finding({ key: "recently-closed" })]);
  store.feedbackFinding("recently-closed", { revision: 1, status: "RESOLVED", reason: "OTHER" }, "admin-a");
  db.prepare("UPDATE production_finding_events SET created_at=? WHERE finding_key=? AND action='FEEDBACK'").run("2026-10-20T00:00:00Z", "recently-closed");
  const range = { start: "2026-10-19T00:00:00+08:00", end: "2026-10-26T00:00:00+08:00" };
  const result = store.reportFollowUps(range);
  assert.equal(result.findings.length, 40);
  assert.equal(result.total, 43);
  assert.equal(result.truncated, true);
  assert.ok(result.findings.every(item => ["NEW", "INVESTIGATING"].includes(item.status)));
  assert.equal(store.reportFollowUps({ ...range, limit: 1 }).total, 43);
  assert.throws(() => store.reportFollowUps({ ...range, limit: 41 }), { status: 400 });
  assert.throws(() => store.reportFollowUps({ start: range.end, end: range.start }), { status: 400 });
});

test("审计插入失败时整笔修改回滚，未修改事项原状态或周报版本", t => {
  const { store, db } = fixture(t);
  const report = store.createDraft({ snapshot: snapshot(), actor: "a" });
  store.upsertFindings([finding()]);
  db.exec("CREATE TRIGGER reject_weekly_event BEFORE INSERT ON weekly_report_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  assert.throws(() => store.reviewReport(report.id, { revision: 1 }, "a"), /audit unavailable/);
  assert.equal(store.getReport(report.id).status, "DRAFT");
  assert.equal(store.getReport(report.id).revision, 1);
  db.exec("CREATE TRIGGER reject_finding_event BEFORE INSERT ON production_finding_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  assert.throws(() => store.feedbackFinding(finding().key, { revision: 1, status: "INVESTIGATING" }, "a"), /audit unavailable/);
  assert.equal(store.getFinding(finding().key).status, "NEW");
  assert.equal(store.getFinding(finding().key).revision, 1);
});

test("拒绝非法状态原因版本与过长文本，核查记录不接受客户端伪造结论", t => {
  const { store } = fixture(t);
  const [item] = store.upsertFindings([finding({ status: "RESOLVED", revision: 999, note: "伪造" })]);
  assert.equal(item.status, "NEW");
  assert.equal(item.revision, 1);
  assert.equal(item.note, "");
  for (const feedback of [
    { revision: 1, status: "COMPLETED" }, { revision: 1, status: "RESOLVED", reason: "bogus" },
    { revision: 1, status: "CONFIRMED_NORMAL" }, { revision: 0, status: "NEW" },
    { revision: 1, status: "NEW", note: "a".repeat(2001) }
  ]) assert.throws(() => store.feedbackFinding(item.key, feedback, "a"), { status: 400 });
  assert.throws(() => store.createDraft({ snapshot: snapshot(), actor: "", coordination: "" }), { status: 400 });
  assert.throws(() => store.createDraft({ snapshot: snapshot(), actor: "a", coordination: "x".repeat(2001) }), { status: 400 });
  assert.throws(() => store.listFindings({ status: "bogus" }), { status: 400 });
  assert.throws(() => store.listReports({ limit: 0 }), { status: 400 });
  assert.equal(store.getFinding(item.key).events.length, 1);
});
