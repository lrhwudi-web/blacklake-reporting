import { createHash, randomUUID } from "node:crypto";
import { assert } from "./errors.mjs";

const REPORT_STATUSES = new Set(["DRAFT", "REVIEWED"]);
const FINDING_STATUSES = new Set(["NEW", "INVESTIGATING", "CONFIRMED_NORMAL", "RESOLVED"]);
const REASONS = new Set(["NORMAL_OVERPRODUCTION", "DUPLICATE_RECORD", "PLAN_OUTDATED", "SYSTEM_ISSUE", "OTHER"]);
const CLOSED = new Set(["CONFIRMED_NORMAL", "RESOLVED"]);
const dynamicEvidenceFields = new Set(["asOf", "generatedAt", "queriedAt", "observedAt", "ageHours", "waitingHours"]);
const now = () => new Date().toISOString();
function text(value, limit, label, empty = true) {
  assert(typeof value === "string" && value.length <= limit && (empty || value.trim().length > 0)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value), 400, "INSIGHT_INVALID_INPUT", `${label}格式或长度不正确。`);
  return value;
}
function actorValue(actor) { return text(actor, 256, "操作身份", false); }
function revisionValue(revision) { assert(Number.isSafeInteger(revision) && revision > 0, 400, "INSIGHT_INVALID_REVISION", "版本号不正确。"); }
function json(value, limit = 4_000_000) {
  let result;
  try { result = JSON.stringify(value); } catch { /* reject below */ }
  assert(typeof result === "string" && result.length <= limit, 400, "INSIGHT_INVALID_INPUT", "保存内容无效或过长。");
  return result;
}
function object(value, label) { assert(value && typeof value === "object" && !Array.isArray(value), 400, "INSIGHT_INVALID_INPUT", `${label}格式不正确。`); }
function timestamp(value) { assert(typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)), 400, "INSIGHT_INVALID_INPUT", "证据时间不正确。"); return new Date(value).toISOString(); }
function limitValue(limit, maximum = 200) { assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum, 400, "INSIGHT_INVALID_LIMIT", `每次最多读取${maximum}条记录。`); return limit; }
function narrativeValue(value) {
  if (value === null) return null;
  object(value, "AI解读");
  assert(Object.keys(value).every(key => ["summary", "limitations", "generatedAt", "model"].includes(key)), 400, "INSIGHT_INVALID_INPUT", "AI解读字段不正确。");
  for (const [key, max] of [["summary", 3], ["limitations", 12]]) {
    assert(Array.isArray(value[key]) && value[key].length <= max && (key !== "summary" || value[key].length > 0), 400, "INSIGHT_INVALID_INPUT", "AI解读条数不正确。");
    value[key].forEach(line => text(line, key === "summary" ? 350 : 1000, "AI解读", false));
  }
  return { summary: [...value.summary], limitations: [...value.limitations], generatedAt: timestamp(value.generatedAt), model: text(value.model, 120, "模型名称", false) };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter(key => !dynamicEvidenceFields.has(key)).sort().map(key => [key, canonical(value[key])]));
}
function evidenceVersion(finding) {
  // Display prose can contain elapsed hours; only structured business evidence
  // changes a case version. Refresh timestamps and ordering are not new facts.
  return createHash("sha256").update(json(canonical({ kind: finding.kind, category: finding.category,
    projectCode: finding.projectCode, taskId: finding.taskId, assignmentId: finding.assignmentId,
    evidence: finding.evidence }))).digest("hex");
}

export class WeeklyStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS weekly_reports (
        id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('DRAFT','REVIEWED')),
        revision INTEGER NOT NULL CHECK(revision > 0), snapshot_json TEXT NOT NULL,
        coordination TEXT NOT NULL DEFAULT '', management_note TEXT NOT NULL DEFAULT '', narrative_json TEXT,
        created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
        reviewed_at TEXT, reviewed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS weekly_reports_status_updated ON weekly_reports(status,updated_at DESC);
      CREATE TABLE IF NOT EXISTS weekly_report_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL REFERENCES weekly_reports(id),
        revision INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, detail_json TEXT NOT NULL,
        UNIQUE(report_id,revision)
      );
      CREATE TABLE IF NOT EXISTS production_findings (
        key TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('NEW','INVESTIGATING','CONFIRMED_NORMAL','RESOLVED')),
        revision INTEGER NOT NULL CHECK(revision > 0), evidence_version TEXT NOT NULL, finding_json TEXT NOT NULL,
        task_id INTEGER, project_code TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, observed_at TEXT NOT NULL, updated_by TEXT NOT NULL,
        evidence_changed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS production_findings_task ON production_findings(task_id,project_code,updated_at DESC);
      CREATE TABLE IF NOT EXISTS production_finding_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, finding_key TEXT NOT NULL REFERENCES production_findings(key),
        revision INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, detail_json TEXT NOT NULL,
        UNIQUE(finding_key,revision)
      );
    `);
  }

  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  createDraft({ snapshot, actor, coordination = "", narrative = null }) {
    actorValue(actor); object(snapshot, "周报快照"); text(coordination, 2000, "协调事项");
    assert(Array.isArray(snapshot.findings), 400, "INSIGHT_INVALID_INPUT", "周报缺少核查事项范围。");
    const freezeFinding = item => {
      object(item, "核查事项");
      const frozen = { ...item };
      for (const field of ["events", "eventsTotal", "eventsTruncated", "updatedBy"]) delete frozen[field];
      return frozen;
    };
    const findings = snapshot.findings.map(freezeFinding);
    const draft = JSON.parse(json({ ...snapshot, findings,
      ...(Array.isArray(snapshot.risks) ? { risks: snapshot.risks.map(freezeFinding) } : {}) }));
    const narrativeJson = narrative === null ? null : json(narrativeValue(narrative));
    return this.transaction(() => {
      for (const item of draft.findings) {
        const current = this.db.prepare("SELECT revision FROM production_findings WHERE key=?").get(item.key);
        assert(!current || current.revision === item.revision, 409, "WEEKLY_EVIDENCE_CHANGED", "异常核查进展已变化，请重新生成草稿。");
      }
      const id = randomUUID(), at = now();
      this.db.prepare(`INSERT INTO weekly_reports(id,status,revision,snapshot_json,coordination,narrative_json,created_at,created_by,updated_at,updated_by)
        VALUES (?,'DRAFT',1,?,?,?,?,?,?,?)`).run(id, json(draft), coordination, narrativeJson, at, actor, at, actor);
      this.reportEvent(id, 1, "CREATED", actor, { coordination });
      return this.getReport(id);
    });
  }

  getReport(id) {
    if (typeof id !== "string") return null;
    const row = this.db.prepare("SELECT * FROM weekly_reports WHERE id=?").get(id);
    return row ? { id: row.id, status: row.status, revision: row.revision, snapshot: JSON.parse(row.snapshot_json), coordination: row.coordination,
      managementNote: row.management_note, narrative: row.narrative_json ? JSON.parse(row.narrative_json) : null,
      createdAt: row.created_at, createdBy: row.created_by, updatedAt: row.updated_at, updatedBy: row.updated_by,
      reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by } : null;
  }

  listReports({ status, limit = 20 } = {}) {
    limitValue(limit); assert(status === undefined || REPORT_STATUSES.has(status), 400, "INSIGHT_INVALID_STATUS", "周报状态不正确。");
    return this.db.prepare(`SELECT id,status,revision,created_at,updated_at,reviewed_at,
      CASE WHEN json_type(snapshot_json,'$.period')='object' THEN json_extract(snapshot_json,'$.period') ELSE NULL END AS period_json
      FROM weekly_reports ${status ? "WHERE status=?" : ""} ORDER BY updated_at DESC,rowid DESC LIMIT ?`)
      .all(...(status ? [status] : []), limit).map(row => {
        const period = row.period_json ? JSON.parse(row.period_json) : null;
        return { id: row.id, status: row.status, revision: row.revision, period, startDate: period?.startDate ?? null,
          createdAt: row.created_at, updatedAt: row.updated_at, reviewedAt: row.reviewed_at };
      });
  }

  mutateReport(id, revision, actor, action, work) {
    actorValue(actor); revisionValue(revision);
    return this.transaction(() => {
      const current = this.getReport(id);
      assert(current, 404, "WEEKLY_NOT_FOUND", "未找到这份周报。");
      assert(current.status === "DRAFT" && current.revision === revision, 409, "WEEKLY_CONFLICT", "周报已变化或已审阅，请刷新后重试。");
      const detail = work(current, now());
      this.reportEvent(id, revision + 1, action, actor, detail);
      return this.getReport(id);
    });
  }

  updateDraft(id, { revision, coordination, managementNote }, actor) {
    if (coordination !== undefined) text(coordination, 2000, "协调事项");
    if (managementNote !== undefined) text(managementNote, 2000, "主管备注");
    assert(coordination !== undefined || managementNote !== undefined, 400, "INSIGHT_INVALID_INPUT", "请提交修改内容。");
    return this.mutateReport(id, revision, actor, "EDITED", (current, at) => {
      const detail = { coordination: coordination ?? current.coordination, managementNote: managementNote ?? current.managementNote };
      this.db.prepare(`UPDATE weekly_reports SET coordination=?,management_note=?,revision=revision+1,updated_at=?,updated_by=?,narrative_json=NULL WHERE id=? AND revision=? AND status='DRAFT'`)
        .run(detail.coordination, detail.managementNote, at, actor, id, revision);
      return detail;
    });
  }

  setNarrative(id, { revision, narrative }, actor) {
    const safe = narrativeValue(narrative); assert(safe, 400, "INSIGHT_INVALID_INPUT", "AI解读不能为空。");
    return this.mutateReport(id, revision, actor, "AI_DRAFTED", (_, at) => {
      this.db.prepare(`UPDATE weekly_reports SET narrative_json=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=? AND revision=? AND status='DRAFT'`)
        .run(json(safe), at, actor, id, revision);
      return { narrative: safe };
    });
  }

  reviewReport(id, { revision }, actor) {
    return this.mutateReport(id, revision, actor, "REVIEWED", (_, at) => {
      this.db.prepare(`UPDATE weekly_reports SET status='REVIEWED',revision=revision+1,reviewed_at=?,reviewed_by=?,updated_at=?,updated_by=? WHERE id=? AND revision=? AND status='DRAFT'`)
        .run(at, actor, at, actor, id, revision);
      return {};
    });
  }

  reportEvent(id, revision, action, actor, detail) {
    this.db.prepare("INSERT INTO weekly_report_events(report_id,revision,action,actor,created_at,detail_json) VALUES (?,?,?,?,?,?)")
      .run(id, revision, action, actor, now(), json(detail));
  }

  upsertFindings(findings, { observedAt = now() } = {}) {
    const observed = timestamp(observedAt);
    assert(Array.isArray(findings) && findings.length <= 1000, 400, "INSIGHT_INVALID_INPUT", "核查事项范围过大。");
    return this.transaction(() => {
      const seen = new Set();
      return findings.map(input => {
        object(input, "核查事项"); const key = text(input.key, 300, "事项编号", false);
        assert(!seen.has(key), 400, "INSIGHT_INVALID_INPUT", "核查事项编号重复。"); seen.add(key);
        text(input.kind, 100, "事项类型", false); text(input.title, 300, "事项标题", false);
        const projectCode = text(input.projectCode ?? "", 200, "工单号");
        assert(input.taskId == null || (Number.isSafeInteger(input.taskId) && input.taskId > 0), 400, "INSIGHT_INVALID_INPUT", "任务编号不正确。");
        for (const field of ["facts", "possibleCauses", "nextChecks"]) {
          assert(Array.isArray(input[field]) && input[field].length <= 30, 400, "INSIGHT_INVALID_INPUT", "事项说明格式不正确。");
          input[field].forEach(value => text(value, 2000, "事项说明"));
        }
        assert(Array.isArray(input.evidence) && input.evidence.length <= 100, 400, "INSIGHT_INVALID_INPUT", "证据格式不正确。");
        const clean = JSON.parse(json(input, 200000));
        for (const field of ["status", "revision", "reason", "note", "events", "eventsTotal", "eventsTruncated", "evidenceVersion", "evidenceChanged", "createdAt", "updatedAt", "updatedBy", "observedAt", "carriedForward", "observationNote"]) delete clean[field];
        const version = evidenceVersion(clean), current = this.getFinding(key), at = now();
        if (!current) {
          this.db.prepare(`INSERT INTO production_findings(key,status,revision,evidence_version,finding_json,task_id,project_code,created_at,updated_at,observed_at,updated_by)
            VALUES (?,'NEW',1,?,?,?,?,?,?,?,'SYSTEM')`).run(key, version, json(clean), input.taskId ?? null, projectCode, at, at, observed);
          this.findingEvent(key, 1, "DETECTED", "SYSTEM", { evidenceVersion: version, evidence: clean.evidence, status: "NEW" });
        } else if (current.evidenceVersion !== version) {
          const status = CLOSED.has(current.status) ? "INVESTIGATING" : current.status;
          this.db.prepare(`UPDATE production_findings SET finding_json=?,evidence_version=?,status=?,revision=revision+1,task_id=?,project_code=?,updated_at=?,observed_at=?,updated_by='SYSTEM',evidence_changed=1 WHERE key=?`)
            .run(json(clean), version, status, input.taskId ?? null, projectCode, at, observed, key);
          this.findingEvent(key, current.revision + 1, "EVIDENCE_CHANGED", "SYSTEM", { previousStatus: current.status, status, previousEvidenceVersion: current.evidenceVersion, evidenceVersion: version, evidence: clean.evidence });
        } else {
          this.db.prepare("UPDATE production_findings SET finding_json=?,observed_at=? WHERE key=?").run(json(clean), observed, key);
        }
        return this.getFinding(key);
      });
    });
  }

  getFinding(key) {
    if (typeof key !== "string") return null;
    const row = this.db.prepare("SELECT * FROM production_findings WHERE key=?").get(key);
    if (!row) return null;
    const eventsTotal = this.db.prepare("SELECT COUNT(*) AS total FROM production_finding_events WHERE finding_key=?").get(key).total;
    const events = this.db.prepare("SELECT revision,action,actor,created_at AS createdAt,detail_json FROM production_finding_events WHERE finding_key=? ORDER BY revision DESC LIMIT 50").all(key).reverse()
      .map(({ detail_json, ...event }) => ({ ...event, detail: JSON.parse(detail_json) }));
    return { ...JSON.parse(row.finding_json), key: row.key, status: row.status, revision: row.revision, evidenceVersion: row.evidence_version,
      reason: row.reason, note: row.note, evidenceChanged: Boolean(row.evidence_changed), createdAt: row.created_at,
      updatedAt: row.updated_at, observedAt: row.observed_at, updatedBy: row.updated_by, events, eventsTotal, eventsTruncated: eventsTotal > events.length };
  }

  listFindings({ status, limit = 200, taskId, projectCode } = {}) {
    limitValue(limit, 1000); assert(status === undefined || FINDING_STATUSES.has(status), 400, "INSIGHT_INVALID_STATUS", "核查状态不正确。");
    const where = [], args = [];
    if (status !== undefined) { where.push("status=?"); args.push(status); }
    if (taskId !== undefined) { assert(Number.isSafeInteger(taskId) && taskId > 0, 400, "INSIGHT_INVALID_INPUT", "任务编号不正确。"); where.push("task_id=?"); args.push(taskId); }
    if (projectCode !== undefined) { where.push("project_code=?"); args.push(text(projectCode, 200, "工单号")); }
    return this.db.prepare(`SELECT key FROM production_findings ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC,rowid DESC LIMIT ?`)
      .all(...args, limit).map(row => this.getFinding(row.key));
  }

  reportFollowUps({ start, end, limit = 40 }) {
    const startAt = timestamp(start), endAt = timestamp(end);
    assert(Date.parse(endAt) > Date.parse(startAt), 400, "INSIGHT_INVALID_INPUT", "跟进时间范围不正确。");
    limitValue(limit, 40);
    const eligible = `f.status IN ('NEW','INVESTIGATING') OR EXISTS (
      SELECT 1 FROM production_finding_events e WHERE e.finding_key=f.key AND e.action='FEEDBACK'
      AND julianday(e.created_at)>=julianday(?) AND julianday(e.created_at)<julianday(?))`;
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM production_findings f WHERE ${eligible}`).get(startAt, endAt).total;
    const rows = this.db.prepare(`SELECT f.key FROM production_findings f WHERE ${eligible}
      ORDER BY CASE WHEN f.status IN ('NEW','INVESTIGATING') THEN 0 ELSE 1 END,f.updated_at DESC,f.rowid DESC LIMIT ?`)
      .all(startAt, endAt, limit);
    return { findings: rows.map(row => this.getFinding(row.key)), total, truncated: total > rows.length };
  }

  feedbackFinding(key, { revision, status, reason = "", note = "" }, actor) {
    actorValue(actor); revisionValue(revision);
    assert(FINDING_STATUSES.has(status), 400, "INSIGHT_INVALID_STATUS", "核查状态不正确。");
    assert((reason === "" && !CLOSED.has(status)) || REASONS.has(reason), 400, "INSIGHT_INVALID_REASON", "请选择有效的核查原因。");
    text(note, 2000, "核查备注");
    return this.transaction(() => {
      const current = this.getFinding(key);
      assert(current, 404, "FINDING_NOT_FOUND", "未找到这条核查事项。");
      assert(current.revision === revision, 409, "FINDING_CONFLICT", "核查信息已变化，请刷新后重试。");
      this.db.prepare(`UPDATE production_findings SET status=?,reason=?,note=?,revision=revision+1,updated_at=?,updated_by=?,evidence_changed=0 WHERE key=? AND revision=?`)
        .run(status, reason, note, now(), actor, key, revision);
      this.findingEvent(key, revision + 1, "FEEDBACK", actor, { previousStatus: current.status, status, reason, note, evidenceVersion: current.evidenceVersion });
      return this.getFinding(key);
    });
  }

  findingEvent(key, revision, action, actor, detail) {
    this.db.prepare("INSERT INTO production_finding_events(finding_key,revision,action,actor,created_at,detail_json) VALUES (?,?,?,?,?,?)")
      .run(key, revision, action, actor, now(), json(detail));
  }
}
