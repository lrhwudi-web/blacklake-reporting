import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isQualityInspection } from "./quality.mjs";
import { BOUND_EMBROIDERY_ASSIGNMENT, EMBROIDERY_MACHINE_IDS, isEmbroideryProcessName, normalizeEmbroideryPart } from "./embroidery.mjs";
import { FLOOR8_UNIT_IDS } from "./dispatch.mjs";
import { normalizeEntryProfile } from "./entry-profile.mjs";
import { DispatchPredictions } from "./dispatch-prediction-store.mjs";
import { LocalMembers, isLocalMemberKey } from "./local-members.mjs";
import { assert } from "./errors.mjs";
import { effectiveWorkSecondsBetween } from "./work-time.mjs";
import { initializeReportProduction,reportSubmissionIdentity } from './report-production.mjs';
import {
  fingerprintPhone,
  fingerprintText,
  hashConfirmationCode,
  hashToken,
  newSessionToken
} from "./crypto.mjs";

function embroideryMachineAliases(value) {
  const raw=String(value||""),id=raw.replace(/^(?:3F|MACHINE)-/i,"");
  return EMBROIDERY_MACHINE_IDS.includes(id)?[id,`3F-${id}`,`MACHINE-${id}`]:[raw,raw,raw];
}

export class Store {
  constructor(path, { sessionSecret, sessionDays }) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.sessionSecret = sessionSecret;
    this.sessionDays = sessionDays;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    initializeReportProduction(this.db);
    this.predictions = new DispatchPredictions(this.db);
    this.members = new LocalMembers(this);
  }

  orderStatusPending(projectId) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_order_operations'").get()) return false;
    return !!this.db.prepare(`SELECT 1 FROM workspace_order_operations WHERE order_id=? AND status IN ('PENDING','UNKNOWN')
      AND COALESCE((json_extract(before_json,'$.status') IN ('NOT_STARTED','IN_PROGRESS','FINISHED')
      AND json_extract(before_json,'$.status')=json_extract(target_json,'$.status'))
      OR (json_extract(before_json,'$.status') IN ('NOT_STARTED','IN_PROGRESS')
      AND json_extract(target_json,'$.status') IN ('NOT_STARTED','IN_PROGRESS')),0)=0`).get(projectId);
  }

  orderRemoved(projectId) {
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blacklake_sync_snapshots'").get())return false;
    return !!this.db.prepare("SELECT 1 FROM blacklake_sync_snapshots WHERE kind='order-presence' AND target=? AND json_extract(data_json,'$.present')=0").get(String(projectId));
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operators (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        phone_hash TEXT NOT NULL,
        phone_last4 TEXT NOT NULL,
        blacklake_operator_id INTEGER NOT NULL,
        group_names_json TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name_key, phone_hash)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        operator_id INTEGER NOT NULL REFERENCES operators(id),
        scope TEXT NOT NULL DEFAULT 'worker',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS wechat_bindings (
        subject_hash TEXT PRIMARY KEY,
        operator_id INTEGER NOT NULL UNIQUE REFERENCES operators(id),
        bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS wechat_binding_challenges (
        token_hash TEXT PRIMARY KEY,
        subject_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS operator_binding_codes (
        id TEXT PRIMARY KEY,
        operator_id INTEGER NOT NULL REFERENCES operators(id),
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS binding_challenges_expiry_idx ON wechat_binding_challenges(expires_at);
      CREATE INDEX IF NOT EXISTS binding_codes_operator_idx ON operator_binding_codes(operator_id, expires_at);

      CREATE TABLE IF NOT EXISTS operator_reporting_permissions (
        blacklake_operator_id INTEGER PRIMARY KEY,
        can_switch INTEGER NOT NULL CHECK(can_switch IN (0, 1)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS operator_entry_profiles (
        blacklake_operator_id INTEGER PRIMARY KEY,
        app_role TEXT NOT NULL DEFAULT 'employee',
        floor_number INTEGER,
        work_unit_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS operator_quality_profiles (
        blacklake_operator_id INTEGER PRIMARY KEY,
        quality_role TEXT NOT NULL CHECK(quality_role IN ('standard','quality')),
        revision INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS operator_quality_events (
        id TEXT PRIMARY KEY, blacklake_operator_id INTEGER NOT NULL, revision INTEGER NOT NULL,
        actor TEXT NOT NULL, previous_json TEXT NOT NULL, next_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS operator_report_management_profiles (
        blacklake_operator_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS operator_worker_types (
        blacklake_operator_id INTEGER PRIMARY KEY,
        worker_type TEXT NOT NULL CHECK(worker_type IN ('auto','floor8','embroidery')),
        revision INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS operator_self_service_permissions (
        blacklake_operator_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        revision INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS operator_self_service_events (
        id TEXT PRIMARY KEY, blacklake_operator_id INTEGER NOT NULL, revision INTEGER NOT NULL,
        actor TEXT NOT NULL, previous_json TEXT NOT NULL, next_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS operator_worker_type_events (
        id TEXT PRIMARY KEY, blacklake_operator_id INTEGER NOT NULL, revision INTEGER NOT NULL,
        actor TEXT NOT NULL, previous_json TEXT NOT NULL, next_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS dispatch_unit_recommendations (
        unit_id TEXT PRIMARY KEY,
        blacklake_operator_id INTEGER NOT NULL,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS dispatch_unit_recommendation_members (
        unit_id TEXT NOT NULL,
        blacklake_operator_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (unit_id, blacklake_operator_id)
      );

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        operator_id INTEGER NOT NULL REFERENCES operators(id),
        task_id INTEGER NOT NULL,
        project_id INTEGER,
        project_code TEXT NOT NULL,
        product_name TEXT NOT NULL,
        process_name TEXT NOT NULL,
        amount INTEGER NOT NULL,
        good_amount INTEGER NOT NULL,
        defect_amount INTEGER NOT NULL,
        defect_code TEXT,
        status TEXT NOT NULL,
        blacklake_output_id TEXT,
        error_code TEXT,
        error_message TEXT,
        output_time TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS reports_operator_created_idx ON reports(operator_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS report_group_reviews (
        report_id TEXT PRIMARY KEY REFERENCES reports(id),
        group_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        approved_by INTEGER,
        approved_at TEXT,
        approval_operation TEXT
      );
      CREATE INDEX IF NOT EXISTS reports_audit_updated_idx ON reports(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        operator_id INTEGER NOT NULL REFERENCES operators(id),
        task_id INTEGER NOT NULL,
        project_id INTEGER,
        project_code TEXT NOT NULL,
        product_name TEXT NOT NULL,
        process_name TEXT NOT NULL,
        station_name TEXT NOT NULL DEFAULT '',
        machine_id TEXT NOT NULL DEFAULT '',
        embroidery_part TEXT NOT NULL DEFAULT '',
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        baseline_reported_amount INTEGER NOT NULL DEFAULT 0 CHECK(baseline_reported_amount >= 0),
        min_duration_seconds INTEGER NOT NULL CHECK(min_duration_seconds >= 0),
        max_duration_seconds INTEGER NOT NULL CHECK(max_duration_seconds > min_duration_seconds),
        status TEXT NOT NULL DEFAULT 'READY',
        flow_code_hash TEXT,
        flow_code_hint TEXT NOT NULL DEFAULT '',
        attempt_number INTEGER NOT NULL DEFAULT 1,
        published_by TEXT NOT NULL DEFAULT '',
        published_by_operator_id INTEGER,
        published_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        duration_seconds INTEGER,
        duration_assessment TEXT,
        defect_code TEXT,
        report_id TEXT REFERENCES reports(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS assignments_operator_queue_idx
        ON assignments(operator_id, status, published_at);
      CREATE TABLE IF NOT EXISTS assignment_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id TEXT NOT NULL REFERENCES assignments(id),
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS assignment_actions_created_idx ON assignment_actions(created_at DESC);
      CREATE TABLE IF NOT EXISTS assignment_pauses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id TEXT NOT NULL REFERENCES assignments(id),
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS assignment_pauses_task_idx ON assignment_pauses(assignment_id);
      CREATE UNIQUE INDEX IF NOT EXISTS assignment_pauses_open_idx ON assignment_pauses(assignment_id) WHERE ended_at IS NULL;
      CREATE TABLE IF NOT EXISTS assignment_timer_operations (
        operation_id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES assignments(id),
        operator_id INTEGER NOT NULL REFERENCES operators(id),
        action TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS embroidery_schedule (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        revision INTEGER NOT NULL DEFAULT 0,
        schedule_json TEXT NOT NULL DEFAULT '[]',
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO embroidery_schedule(id, revision, schedule_json)
        VALUES (1, 0, '[]');

    `);
    this.db.exec(`
      INSERT OR IGNORE INTO dispatch_unit_recommendation_members
        (unit_id, blacklake_operator_id, position, updated_by, updated_at)
      SELECT unit_id, blacklake_operator_id, 0, updated_by, updated_at
      FROM dispatch_unit_recommendations
    `);
    const assignmentColumns = this.db.prepare("PRAGMA table_info(assignments)").all();
    if (!assignmentColumns.some(column=>column.name==='queue_position')) this.db.exec('ALTER TABLE assignments ADD COLUMN queue_position INTEGER');
    if (!assignmentColumns.some(column=>column.name==='quality_inspection')) {
      this.db.exec('ALTER TABLE assignments ADD COLUMN quality_inspection INTEGER CHECK(quality_inspection IN (0,1))');
    }
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all();
    const operatorColumns = this.db.prepare("PRAGMA table_info(operators)").all();
    if (!operatorColumns.some((column) => column.name === "group_names_json")) {
      this.db.exec("ALTER TABLE operators ADD COLUMN group_names_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!sessionColumns.some((column) => column.name === "scope")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'worker'");
    }
    if (!assignmentColumns.some((column) => column.name === "attempt_number")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1");
    }
    if (!assignmentColumns.some((column) => column.name === "flow_code_hash")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN flow_code_hash TEXT");
    }
    if (!assignmentColumns.some((column) => column.name === "flow_code_hint")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN flow_code_hint TEXT NOT NULL DEFAULT ''");
    }
    if (!assignmentColumns.some((column) => column.name === "baseline_reported_amount")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN baseline_reported_amount INTEGER NOT NULL DEFAULT 0");
    }
    if (!assignmentColumns.some((column) => column.name === "target_quantity")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN target_quantity INTEGER");
      this.db.exec("UPDATE assignments SET target_quantity = quantity");
    }
    if (!assignmentColumns.some((column) => column.name === "local_report_baseline")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN local_report_baseline INTEGER");
    }
    if (!assignmentColumns.some((column) => column.name === "cancellation_reason")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN cancellation_reason TEXT");
    }
    if (!assignmentColumns.some((column) => column.name === "good_quantity")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN good_quantity INTEGER");
      this.db.exec("ALTER TABLE assignments ADD COLUMN defect_quantity INTEGER NOT NULL DEFAULT 0");
    }
    if (!assignmentColumns.some((column) => column.name === "defect_code")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN defect_code TEXT");
    }
    if (!assignmentColumns.some((column) => column.name === "machine_id")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''");
    }
    if (!assignmentColumns.some((column) => column.name === "embroidery_part")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN embroidery_part TEXT NOT NULL DEFAULT ''");
    }
    if (!assignmentColumns.some((column) => column.name === "assignment_mode")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'SELF_SCAN'");
    }
    if (!assignmentColumns.some((column) => column.name === "published_by_operator_id")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN published_by_operator_id INTEGER");
    }
    if (!assignmentColumns.some((column) => column.name === "quantity_policy")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN quantity_policy TEXT NOT NULL DEFAULT ''");
    }
    if (!assignmentColumns.some((column) => column.name === "dispatch_batch_id")) {
      this.db.exec("ALTER TABLE assignments ADD COLUMN dispatch_batch_id TEXT NOT NULL DEFAULT ''");
    }
    // Missing publisher IDs are not inferred from names: names are not ownership evidence.
    // 普通工序仍由事务保证每人只有一笔活动任务；绣花工序允许同一人员管理多个不同任务。
    this.db.exec("DROP INDEX IF EXISTS assignments_one_active_idx");
    this.db.exec("DROP INDEX IF EXISTS assignments_one_active_flow_idx");
    this.db.exec("DROP INDEX IF EXISTS assignments_one_active_task_idx");
    // READY rows are queued work. Only work that has actually started occupies a machine.
    this.db.exec("DROP INDEX IF EXISTS assignments_one_active_machine_idx");
    this.db.exec(`
      CREATE UNIQUE INDEX assignments_one_active_machine_idx
        ON assignments(machine_id)
        WHERE machine_id <> '' AND status IN ('IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS assignments_dispatch_preference_idx
        ON assignments(published_by_operator_id, operator_id, process_name, published_at DESC);
      CREATE INDEX IF NOT EXISTS reports_process_preference_idx
        ON reports(operator_id, status, process_name, created_at DESC);
    `);
  }

  upsertOperator({ name, nameKey, phone, blacklakeOperatorId }) {
    const phoneHash = fingerprintPhone(phone, this.sessionSecret);
    this.db.prepare(`
      INSERT INTO operators(name, name_key, phone_hash, phone_last4, blacklake_operator_id, active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(name_key, phone_hash) DO UPDATE SET
        name = excluded.name,
        phone_last4 = excluded.phone_last4,
        blacklake_operator_id = excluded.blacklake_operator_id,
        active = 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(name, nameKey, phoneHash, phone.slice(-4), blacklakeOperatorId);
    return this.findOperator(nameKey, phone);
  }

  findOperator(nameKey, phone) {
    const row = this.db.prepare(`
      SELECT id, name, phone_last4 AS phoneLast4, blacklake_operator_id AS blacklakeOperatorId,
        group_names_json AS groupNamesJson
      FROM operators WHERE name_key = ? AND phone_hash = ? AND active = 1
    `).get(nameKey, fingerprintPhone(phone, this.sessionSecret));
    return row ? (this.members?.decorate(operatorRecord(row)) || operatorRecord(row)) : undefined;
  }

  upsertBlacklakeOperator({ name, blacklakeOperatorId, groupNames = [], identitySource }) {
    if(isLocalMemberKey(blacklakeOperatorId)){
      assert(identitySource==='LOCAL'&&this.members.byKey(blacklakeOperatorId),409,'LOCAL_MEMBER_IDENTITY_REQUIRED','系统成员必须从独立成员档案读取，不能覆盖为黑湖人员。');
      return this.findOperatorByBlacklakeId(blacklakeOperatorId);
    }
    const existing = this.findOperatorByBlacklakeId(blacklakeOperatorId);
    const nameKey = String(name || "").trim().toLocaleLowerCase("zh-CN");
    const groupNamesJson = JSON.stringify(normalizeGroupNames(groupNames));
    if (existing) {
      this.db.prepare(`
        UPDATE operators SET name = ?, name_key = ?, group_names_json = ?, active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, nameKey, groupNamesJson, existing.id);
      return this.findOperatorByBlacklakeId(blacklakeOperatorId);
    }
    this.db.prepare(`
      INSERT INTO operators(name, name_key, phone_hash, phone_last4, blacklake_operator_id, group_names_json, active)
      VALUES (?, ?, ?, '', ?, ?, 1)
    `).run(
      name,
      nameKey,
      fingerprintText(`blacklake-operator:${blacklakeOperatorId}`, this.sessionSecret),
      blacklakeOperatorId,
      groupNamesJson
    );
    return this.findOperatorByBlacklakeId(blacklakeOperatorId);
  }

  findOperatorByBlacklakeId(blacklakeOperatorId) {
    const row = this.db.prepare(`
      SELECT id, name, phone_last4 AS phoneLast4, blacklake_operator_id AS blacklakeOperatorId,
        group_names_json AS groupNamesJson
      FROM operators WHERE blacklake_operator_id = ? AND active = 1
      ORDER BY id ASC LIMIT 1
    `).get(blacklakeOperatorId);
    return row ? (this.members?.decorate(operatorRecord(row)) || operatorRecord(row)) : undefined;
  }

  operatorByWechatSubject(subject) {
    const row = this.db.prepare(`
      SELECT o.id, o.name, o.phone_last4 AS phoneLast4,
        o.blacklake_operator_id AS blacklakeOperatorId,
        o.group_names_json AS groupNamesJson
      FROM wechat_bindings b JOIN operators o ON o.id = b.operator_id
      WHERE b.subject_hash = ? AND o.active = 1
    `).get(fingerprintText(`wechat-subject:${subject}`, this.sessionSecret));
    return row ? (this.members?.decorate(operatorRecord(row)) || operatorRecord(row)) : undefined;
  }

  createWechatBindingChallenge(subject, ttlMinutes = 15) {
    const token = newSessionToken();
    const subjectHash = fingerprintText(`wechat-subject:${subject}`, this.sessionSecret);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.db.prepare(`
      UPDATE wechat_binding_challenges SET used_at = CURRENT_TIMESTAMP
      WHERE subject_hash = ? AND used_at IS NULL
    `).run(subjectHash);
    this.db.prepare(`
      INSERT INTO wechat_binding_challenges(token_hash, subject_hash, expires_at)
      VALUES (?, ?, ?)
    `).run(hashToken(token), subjectHash, expiresAt);
    return { token, expiresAt };
  }

  bindingChallenge(token) {
    return this.db.prepare(`
      SELECT subject_hash AS subjectHash, expires_at AS expiresAt, attempts
      FROM wechat_binding_challenges
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND attempts < 5
    `).get(hashToken(token), new Date().toISOString());
  }

  recordBindingChallengeFailure(token) {
    const tokenHash = hashToken(token);
    this.db.prepare(`
      UPDATE wechat_binding_challenges
      SET attempts = attempts + 1
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    `).run(tokenHash, new Date().toISOString());
    return this.bindingChallenge(token);
  }

  consumeBindingChallenge(token) {
    return this.db.prepare(`
      UPDATE wechat_binding_challenges
      SET used_at = CURRENT_TIMESTAMP
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    `).run(hashToken(token), new Date().toISOString()).changes === 1;
  }

  createOperatorBindingCode({ blacklakeOperatorId, code, ttlMinutes = 10 }) {
    const operator = this.findOperatorByBlacklakeId(blacklakeOperatorId);
    if (!operator) return undefined;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE operator_binding_codes SET used_at = CURRENT_TIMESTAMP
        WHERE operator_id = ? AND used_at IS NULL
      `).run(operator.id);
      this.db.prepare(`
        INSERT INTO operator_binding_codes(id, operator_id, code_hash, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(
        newSessionToken(),
        operator.id,
        hashConfirmationCode(operator.id, code, this.sessionSecret),
        expiresAt
      );
      this.db.exec("COMMIT");
      return { operator, expiresAt };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  completeWechatBinding({ challengeToken, blacklakeOperatorId, code }) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const challenge = this.db.prepare(`
        SELECT token_hash AS tokenHash, subject_hash AS subjectHash, attempts
        FROM wechat_binding_challenges
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      `).get(hashToken(challengeToken), now);
      if (!challenge || challenge.attempts >= 5) {
        this.db.exec("ROLLBACK");
        return { status: "CHALLENGE_INVALID" };
      }
      const operator = this.findOperatorByBlacklakeId(blacklakeOperatorId);
      if (!operator) {
        this.db.exec("ROLLBACK");
        return { status: "OPERATOR_NOT_APPROVED" };
      }
      const bindingCode = this.db.prepare(`
        SELECT id FROM operator_binding_codes
        WHERE operator_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).get(
        operator.id,
        hashConfirmationCode(operator.id, code, this.sessionSecret),
        now
      );
      if (!bindingCode) {
        this.db.prepare(`
          UPDATE wechat_binding_challenges SET attempts = attempts + 1 WHERE token_hash = ?
        `).run(challenge.tokenHash);
        this.db.exec("COMMIT");
        return { status: challenge.attempts >= 4 ? "TOO_MANY_ATTEMPTS" : "CODE_INVALID" };
      }

      const subjectBinding = this.db.prepare(`
        SELECT b.operator_id AS operatorId, o.blacklake_operator_id AS blacklakeOperatorId
        FROM wechat_bindings b JOIN operators o ON o.id = b.operator_id
        WHERE b.subject_hash = ?
      `).get(challenge.subjectHash);
      if (subjectBinding && subjectBinding.blacklakeOperatorId !== blacklakeOperatorId) {
        this.db.exec("ROLLBACK");
        return { status: "WECHAT_ALREADY_BOUND" };
      }
      const operatorBinding = this.db.prepare(`
        SELECT b.subject_hash AS subjectHash
        FROM wechat_bindings b JOIN operators o ON o.id = b.operator_id
        WHERE o.blacklake_operator_id = ? LIMIT 1
      `).get(blacklakeOperatorId);
      if (operatorBinding && operatorBinding.subjectHash !== challenge.subjectHash) {
        this.db.exec("ROLLBACK");
        return { status: "OPERATOR_ALREADY_BOUND" };
      }

      this.db.prepare(`
        INSERT INTO wechat_bindings(subject_hash, operator_id)
        VALUES (?, ?)
        ON CONFLICT(subject_hash) DO UPDATE SET operator_id = excluded.operator_id,
          updated_at = CURRENT_TIMESTAMP
      `).run(challenge.subjectHash, operator.id);
      this.db.prepare("UPDATE operator_binding_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(bindingCode.id);
      this.db.prepare("UPDATE wechat_binding_challenges SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?")
        .run(challenge.tokenHash);
      this.db.exec("COMMIT");
      return { status: "BOUND", operator: this.findOperatorByBlacklakeId(blacklakeOperatorId) };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  wechatBindingStatuses() {
    return this.db.prepare(`
      SELECT o.blacklake_operator_id AS blacklakeOperatorId,
        MAX(b.bound_at) AS boundAt
      FROM operators o LEFT JOIN wechat_bindings b ON b.operator_id = o.id
      WHERE o.active = 1
      GROUP BY o.blacklake_operator_id
    `).all();
  }

  reportingModeSwitchPermission(blacklakeOperatorId) {
    const row = this.db.prepare(`
      SELECT can_switch AS canSwitch
      FROM operator_reporting_permissions
      WHERE blacklake_operator_id = ?
    `).get(Number(blacklakeOperatorId));
    return row ? Boolean(row.canSwitch) : undefined;
  }

  setReportingModeSwitchPermission(blacklakeOperatorId, canSwitch) {
    const operatorId = Number(blacklakeOperatorId);
    if (!Number.isSafeInteger(operatorId) || operatorId <= 0 || typeof canSwitch !== "boolean") return undefined;
    this.db.prepare(`
      INSERT INTO operator_reporting_permissions(blacklake_operator_id, can_switch, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(blacklake_operator_id) DO UPDATE SET
        can_switch = excluded.can_switch,
        updated_at = CURRENT_TIMESTAMP
    `).run(operatorId, canSwitch ? 1 : 0);
    return { blacklakeOperatorId: operatorId, canSwitch };
  }

  entryProfile(blacklakeOperatorId) {
    const row = this.db.prepare(`
      SELECT app_role AS appRole, floor_number AS floor, work_unit_id AS workUnitId
      FROM operator_entry_profiles WHERE blacklake_operator_id = ?
    `).get(Number(blacklakeOperatorId));
    return row ? normalizeEntryProfile(row) : normalizeEntryProfile();
  }

  workerTypeProfile(blacklakeOperatorId) {
    return this.db.prepare('SELECT worker_type AS workerType,revision FROM operator_worker_types WHERE blacklake_operator_id=?').get(Number(blacklakeOperatorId))||{workerType:'auto',revision:0};
  }

  qualityProfile(blacklakeOperatorId) {
    const row=this.db.prepare('SELECT quality_role,revision FROM operator_quality_profiles WHERE blacklake_operator_id=?').get(Number(blacklakeOperatorId));
    const manager=this.db.prepare('SELECT enabled FROM operator_report_management_profiles WHERE blacklake_operator_id=?').get(Number(blacklakeOperatorId));
    return {qualityRole:row?.quality_role==='quality'&&manager?.enabled?'quality_leader':row?.quality_role||'standard',qualityRevision:row?.revision||0};
  }

  isQualityOperator(operatorId) {
    const row=this.db.prepare('SELECT blacklake_operator_id FROM operators WHERE id=?').get(operatorId);
    return Boolean(row&&['quality','quality_leader'].includes(this.qualityProfile(row.blacklake_operator_id).qualityRole));
  }

  setQualityProfile(blacklakeOperatorId,qualityRole,expectedRevision,actor) {
    const id=Number(blacklakeOperatorId);
    assert(['standard','quality','quality_leader'].includes(qualityRole),422,'INVALID_QUALITY_ROLE','请选择普通人员、质检人员或质检组长。');
    assert(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,422,'INVALID_QUALITY_REVISION','请先刷新人员再设置报工身份。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      assert(this.entryProfile(id).appRole==='employee',409,'QUALITY_EMPLOYEE_ONLY','报工身份仅适用于员工。');
      const current=this.qualityProfile(id);
      assert(current.qualityRevision===expectedRevision,409,'QUALITY_PROFILE_CHANGED','报工身份已变化，请刷新后核对。');
      if(current.qualityRole!==qualityRole){
        const inspection=role=>['quality','quality_leader'].includes(role);
        if(inspection(current.qualityRole)!==inspection(qualityRole))assert(!this.hasActiveAssignmentForBlacklakeOperator(id),409,'OPERATOR_HAS_ACTIVE_ASSIGNMENT','此人有待开始、生产中或结果待核对任务，请先处理再修改报工身份。');
        const revision=current.qualityRevision+1;
        this.db.prepare('INSERT INTO operator_quality_profiles(blacklake_operator_id,quality_role,revision) VALUES (?,?,?) ON CONFLICT(blacklake_operator_id) DO UPDATE SET quality_role=excluded.quality_role,revision=excluded.revision,updated_at=CURRENT_TIMESTAMP').run(id,inspection(qualityRole)?'quality':'standard',revision);
        this.db.prepare('INSERT INTO operator_report_management_profiles VALUES(?,?) ON CONFLICT(blacklake_operator_id) DO UPDATE SET enabled=excluded.enabled').run(id,qualityRole==='quality_leader'?1:0);
        this.db.prepare('INSERT INTO operator_quality_events(id,blacklake_operator_id,revision,actor,previous_json,next_json) VALUES (?,?,?,?,?,?)').run(randomUUID(),id,revision,actor,JSON.stringify(current),JSON.stringify({qualityRole,qualityRevision:revision}));
      }
      this.db.exec('COMMIT');return this.qualityProfile(id);
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  // New tasks keep their quantity form even after later staff changes. Legacy
  // already-submitted records retain the old classifier; unreported legacy work
  // follows the explicit staff profile without rewriting historical rows.
  assignmentRecord(row) {
    const historical=Boolean(row.report_id)||['COMPLETED','CANCELLED','REPORTING','NEEDS_REVIEW'].includes(row.status);
    const inspection=row.quality_inspection==null?(historical?isQualityInspection(row.process_name):this.isQualityOperator(row.operator_id)):Boolean(row.quality_inspection);
    const identity=row.report_id&&this.members?.snapshot(row.report_id);
    const pauses=this.assignmentPauses(row.id);
    const timingRevision=this.db.prepare('SELECT COUNT(*) AS n FROM assignment_timer_operations WHERE assignment_id=?').get(row.id).n;
    return {...assignmentRecord({...row,quality_inspection:inspection?1:0}), pauses, timingRevision,
      paused: !row.ended_at && pauses.some(p=>!p.endedAt), ...(identity?{submissionIdentity:identity}:{})};
  }

  assignmentPauses(id) {
    return this.db.prepare('SELECT started_at AS startedAt,ended_at AS endedAt FROM assignment_pauses WHERE assignment_id=? ORDER BY id').all(id);
  }

  changeAssignmentTimer({assignmentId,operatorId,action,expectedRevision,operationId,at}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const assignment=this.assignmentById(assignmentId);
      assert(assignment?.operatorId===operatorId,404,'ASSIGNMENT_NOT_FOUND','没有找到这笔任务。');
      const previous=this.db.prepare('SELECT * FROM assignment_timer_operations WHERE operation_id=?').get(operationId);
      if(previous) {
        assert(previous.assignment_id===assignmentId&&previous.operator_id===operatorId&&previous.action===action&&previous.expected_revision===expectedRevision,
          409,'TIMER_OPERATION_CONFLICT','操作标识已使用，请刷新任务。');
      } else {
        const undo=action==='cancel-end',withdraw=action==='withdraw',end=action==='end';
        if(undo||withdraw||end)assert(assignment.machineId||assignment.assignmentMode===BOUND_EMBROIDERY_ASSIGNMENT,403,'EMBROIDERY_TIMER_REQUIRED','此操作只用于绣花任务。');
        if(withdraw)assert(['SELF_SCAN',BOUND_EMBROIDERY_ASSIGNMENT].includes(assignment.assignmentMode),403,'WORKSPACE_SELF_EXIT_NOT_ALLOWED','只能撤销本人的自主报工。');
        assert(assignment.status==='IN_PROGRESS'&&Boolean(assignment.endedAt)===(undo||withdraw)&&!assignment.reportId,409,'TIMER_NOT_RUNNING','任务状态已变化，不能调整计时。');
        assert(assignment.timingRevision===expectedRevision,409,'TIMER_VERSION_CHANGED','计时状态已变化，请刷新后重试。');
        assert(end||undo||withdraw||(action==='pause'&&!assignment.paused)||(action==='resume'&&assignment.paused),409,'TIMER_STATE_CHANGED','计时状态已变化，请刷新后重试。');
        const latest=assignment.pauses.at(-1);
        assert(at>=(assignment.endedAt||latest?.endedAt||latest?.startedAt||assignment.startedAt),409,'TIMER_TIME_CHANGED','系统时间异常，请稍后刷新重试。');
        if(action==='pause') this.db.prepare('INSERT INTO assignment_pauses(assignment_id,started_at) VALUES(?,?)').run(assignmentId,at);
        if(action==='resume'||undo||withdraw){
          const closed=this.db.prepare('UPDATE assignment_pauses SET ended_at=? WHERE assignment_id=? AND ended_at IS NULL').run(withdraw?assignment.endedAt:at,assignmentId);
          if(undo&&!closed.changes)this.db.prepare('INSERT INTO assignment_pauses(assignment_id,started_at,ended_at) VALUES(?,?,?)').run(assignmentId,assignment.endedAt,at);
        }
        if(end)this.db.prepare('UPDATE assignments SET ended_at=?,duration_seconds=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(at,effectiveWorkSecondsBetween(assignment.startedAt,at,assignment.pauses),assignmentId);
        if(undo)this.db.prepare('UPDATE assignments SET ended_at=NULL,duration_seconds=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(assignmentId);
        if(withdraw)this.db.prepare("UPDATE assignments SET status='CANCELLED',cancellation_reason='员工撤销未提交的机台报工',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(assignmentId);
        this.db.prepare('INSERT INTO assignment_timer_operations VALUES(?,?,?,?,?,?)').run(operationId,assignmentId,operatorId,action,expectedRevision,at);
        const audit={pause:['PAUSE_TIMER','员工暂停有效工时累计'],resume:['RESUME_TIMER','员工继续有效工时累计'],end:['EMPLOYEE_END','员工结束机台计时待确认数量'],'cancel-end':['EMPLOYEE_CANCEL_END','机台任务返回计时'],withdraw:['SELF_REPORT_REVOKED','员工撤销未提交的机台报工']}[action];
        this.db.prepare('INSERT INTO assignment_actions(assignment_id,action,reason,actor) VALUES(?,?,?,?)').run(assignmentId,...audit,'operator:'+operatorId);
      }
      const result=this.assignmentById(assignmentId);
      this.db.exec('COMMIT'); return result;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }

  selfServicePermission(blacklakeOperatorId) {
    const row=this.db.prepare('SELECT enabled,revision FROM operator_self_service_permissions WHERE blacklake_operator_id=?').get(Number(blacklakeOperatorId));
    return row?{enabled:Boolean(row.enabled),revision:row.revision}:{enabled:false,revision:0};
  }

  setSelfServicePermission(blacklakeOperatorId, enabled, expectedRevision, actor) {
    const id=Number(blacklakeOperatorId);
    assert(typeof enabled==='boolean',422,'INVALID_SELF_SERVICE_PERMISSION','请选择是否允许自主报工。');
    assert(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,422,'INVALID_SELF_SERVICE_REVISION','请先刷新人员再设置自主报工。');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      assert(this.entryProfile(id).appRole==='employee',409,'SELF_SERVICE_EMPLOYEE_ONLY','自主报工仅适用于员工身份。');
      const current=this.selfServicePermission(id);
      assert(current.revision===expectedRevision,409,'SELF_SERVICE_PERMISSION_CHANGED','自主报工权限已被修改，请刷新后核对。');
      if(current.enabled!==enabled){
        const revision=current.revision+1;
        this.db.prepare(`INSERT INTO operator_self_service_permissions(blacklake_operator_id,enabled,revision) VALUES (?,?,?)
          ON CONFLICT(blacklake_operator_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated_at=CURRENT_TIMESTAMP`).run(id,enabled?1:0,revision);
        this.db.prepare('INSERT INTO operator_self_service_events(id,blacklake_operator_id,revision,actor,previous_json,next_json) VALUES (?,?,?,?,?,?)')
          .run(randomUUID(),id,revision,actor,JSON.stringify(current),JSON.stringify({enabled,revision}));
      }
      this.db.exec('COMMIT');return this.selfServicePermission(id);
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  setWorkerType(blacklakeOperatorId, workerType, expectedRevision, actor) {
    assert(['auto','floor8','embroidery'].includes(workerType),422,'INVALID_WORKER_TYPE','请选择按部门、8楼员工或绣花员工。');
    assert(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,422,'INVALID_WORKER_TYPE_REVISION','请先刷新人员资料再设置归属。');
    const id=Number(blacklakeOperatorId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const entry=this.entryProfile(id),current=this.workerTypeProfile(id);
      assert(entry.appRole==='employee',409,'WORKER_TYPE_EMPLOYEE_ONLY','只有员工可以设置报工归属，组长或主管请先调整小程序身份。');
      assert(current.revision===expectedRevision,409,'WORKER_TYPE_CHANGED','人员归属已被其他管理员修改，请刷新后核对。');
      const clearMachine=workerType==='floor8'&&String(entry.workUnitId||'').startsWith('3F-');
      if(current.workerType!==workerType||clearMachine) {
        assert(!this.hasActiveAssignmentForBlacklakeOperator(id),409,'OPERATOR_HAS_ACTIVE_ASSIGNMENT','此人还有待开始、进行中或结果待核对的任务，请先处理，再切换8楼／绣花归属。');
        const revision=current.revision+1;
        this.db.prepare(`INSERT INTO operator_worker_types(blacklake_operator_id,worker_type,revision) VALUES (?,?,?)
          ON CONFLICT(blacklake_operator_id) DO UPDATE SET worker_type=excluded.worker_type,revision=excluded.revision,updated_at=CURRENT_TIMESTAMP`).run(id,workerType,revision);
        if(clearMachine)this.db.prepare("UPDATE operator_entry_profiles SET work_unit_id='',updated_at=CURRENT_TIMESTAMP WHERE blacklake_operator_id=?").run(id);
        this.db.prepare('INSERT INTO operator_worker_type_events(id,blacklake_operator_id,revision,actor,previous_json,next_json) VALUES (?,?,?,?,?,?)')
          .run(randomUUID(),id,revision,actor,JSON.stringify({...current,workUnitId:entry.workUnitId}),JSON.stringify({workerType,revision,workUnitId:clearMachine?'':entry.workUnitId}));
      }
      this.db.exec('COMMIT');return this.workerTypeProfile(id);
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  setEntryProfile(blacklakeOperatorId, input) {
    const operatorId = Number(blacklakeOperatorId);
    if (!Number.isSafeInteger(operatorId) || operatorId <= 0) return undefined;
    const profile = normalizeEntryProfile(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.entryProfile(operatorId);
      assert(!(profile.appRole==='employee'&&String(profile.workUnitId||'').startsWith('3F-')&&this.workerTypeProfile(operatorId).workerType==='floor8'),409,'WORKER_TYPE_MACHINE_CONFLICT','8楼员工不能绑定3楼机台，请先将报工归属切换为绣花员工或自动。');
      if (current.appRole !== profile.appRole || current.workUnitId !== profile.workUnitId) {
        assert(!this.hasActiveAssignmentForBlacklakeOperator(operatorId), 409, "OPERATOR_HAS_ACTIVE_ASSIGNMENT", "此人仍有待开始、进行中或待核对任务，请先在待处理任务中处置，再修改身份或机台归属。");
      }
      this.db.prepare(`
        INSERT INTO operator_entry_profiles(blacklake_operator_id, app_role, floor_number, work_unit_id, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(blacklake_operator_id) DO UPDATE SET
          app_role = excluded.app_role,
          floor_number = excluded.floor_number,
          work_unit_id = excluded.work_unit_id,
          updated_at = CURRENT_TIMESTAMP
      `).run(operatorId, profile.appRole, profile.floor, profile.workUnitId);
      if (profile.appRole !== "employee") {
        this.db.prepare("DELETE FROM dispatch_unit_recommendations WHERE blacklake_operator_id = ?")
          .run(operatorId);
        this.db.prepare("DELETE FROM dispatch_unit_recommendation_members WHERE blacklake_operator_id = ?")
          .run(operatorId);
      }
      this.db.exec("COMMIT");
      return profile;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  dispatchUnitRecommendations() {
    return this.db.prepare(`
      SELECT unit_id AS unitId, blacklake_operator_id AS blacklakeOperatorId,
        updated_by AS updatedBy, updated_at AS updatedAt
      FROM dispatch_unit_recommendation_members
      ORDER BY unit_id ASC, position ASC, blacklake_operator_id ASC
    `).all();
  }

  dispatchUnitRecommendation(unitId) {
    return this.db.prepare(`
      SELECT unit_id AS unitId, blacklake_operator_id AS blacklakeOperatorId,
        updated_by AS updatedBy, updated_at AS updatedAt
      FROM dispatch_unit_recommendation_members
      WHERE unit_id = ?
      ORDER BY position ASC, blacklake_operator_id ASC
    `).get(String(unitId || ""));
  }

  setDispatchUnitRecommendations(unitId, blacklakeOperatorIds, updatedBy = "", { expectedOperatorIds, audit = false } = {}) {
    const normalizedUnitId = String(unitId || "").trim();
    if (!normalizedUnitId) return [];
    const ids = [...new Set((blacklakeOperatorIds || []).map(Number))];
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid recommendation operator IDs");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.dispatchUnitRecommendations().filter((row) => row.unitId === normalizedUnitId).map((row) => row.blacklakeOperatorId);
      const key = (values) => JSON.stringify([...new Set(values)].sort((a, b) => a - b));
      if (expectedOperatorIds && key(previous) !== key(expectedOperatorIds)) { this.db.exec("ROLLBACK"); return undefined; }
      this.db.prepare("DELETE FROM dispatch_unit_recommendation_members WHERE unit_id = ?").run(normalizedUnitId);
      const insert = this.db.prepare(`INSERT INTO dispatch_unit_recommendation_members
        (unit_id, blacklake_operator_id, position, updated_by) VALUES (?, ?, ?, ?)`);
      ids.forEach((id, position) => insert.run(normalizedUnitId, id, position, String(updatedBy || "")));
      this.db.prepare("DELETE FROM dispatch_unit_recommendations WHERE unit_id = ?").run(normalizedUnitId);
      if (ids.length) this.db.prepare(`INSERT INTO dispatch_unit_recommendations
        (unit_id, blacklake_operator_id, updated_by) VALUES (?, ?, ?)`)
        .run(normalizedUnitId, ids[0], String(updatedBy || ""));
      if (audit && key(previous) !== key(ids)) this.db.prepare(`INSERT INTO dispatch_station_binding_events
        (id, unit_id, previous_json, next_json, actor) VALUES (?, ?, ?, ?, ?)`).run(
          randomUUID(), normalizedUnitId, JSON.stringify(previous), JSON.stringify(ids), String(updatedBy));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.dispatchUnitRecommendations().filter((item) => item.unitId === normalizedUnitId);
  }

  setDispatchUnitRecommendation(unitId, blacklakeOperatorId, updatedBy = "") {
    return this.setDispatchUnitRecommendations(unitId, blacklakeOperatorId ? [blacklakeOperatorId] : [], updatedBy)[0]
      || { unitId: String(unitId || "").trim(), blacklakeOperatorId: null, updatedBy: String(updatedBy || ""), updatedAt: null };
  }

  dispatchProcessPreferences({ dispatcherBlacklakeOperatorId, targetBlacklakeOperatorIds = [] }) {
    const operatorIds = [...new Set(targetBlacklakeOperatorIds.map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!operatorIds.length) return { supervisorFrequent: [], systemRecommended: [] };
    const placeholders = operatorIds.map(() => "?").join(", ");
    const supervisorFrequent = this.db.prepare(`
      SELECT a.process_name AS processName, COUNT(*) AS useCount,
        MAX(a.published_at) AS lastUsedAt
      FROM assignments a JOIN operators o ON o.id = a.operator_id
      WHERE a.assignment_mode = 'DISPATCHED'
        AND a.status <> 'CANCELLED'
        AND a.published_by_operator_id = ?
        AND o.blacklake_operator_id IN (${placeholders})
      GROUP BY a.process_name
      ORDER BY useCount DESC, lastUsedAt DESC, processName ASC
    `).all(Number(dispatcherBlacklakeOperatorId), ...operatorIds);
    const systemRecommended = this.db.prepare(`
      SELECT r.process_name AS processName, COUNT(*) AS useCount,
        MAX(COALESCE(r.output_time, r.updated_at)) AS lastUsedAt
      FROM reports r JOIN operators o ON o.id = r.operator_id
      WHERE r.status = 'SUCCEEDED'
        AND o.blacklake_operator_id IN (${placeholders})
      GROUP BY r.process_name
      ORDER BY useCount DESC, lastUsedAt DESC, processName ASC
    `).all(...operatorIds);
    return { supervisorFrequent, systemRecommended };
  }

  operatorForWorkUnit(workUnitId) {
    const row = this.db.prepare(`
      SELECT o.id, o.name, o.phone_last4 AS phoneLast4,
        o.blacklake_operator_id AS blacklakeOperatorId,
        o.group_names_json AS groupNamesJson
      FROM operator_entry_profiles p JOIN operators o
        ON o.blacklake_operator_id = p.blacklake_operator_id
      WHERE p.app_role = 'employee' AND p.work_unit_id = ? AND o.active = 1
      ORDER BY o.id ASC LIMIT 1
    `).get(String(workUnitId || ""));
    return row ? (this.members?.decorate(operatorRecord(row)) || operatorRecord(row)) : undefined;
  }

  hasActiveAssignmentForBlacklakeOperator(blacklakeOperatorId, {occupancyOnly=false} = {}) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM assignments a JOIN operators o ON o.id = a.operator_id
      WHERE o.blacklake_operator_id = ?
        AND a.status IN ('READY', 'IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
        ${occupancyOnly ? "AND NOT (a.status IN ('REPORTING','NEEDS_REVIEW') AND a.quantity_policy='PENDING_REVIEW' AND a.ended_at IS NOT NULL)" : ''}
      LIMIT 1
    `).get(blacklakeOperatorId));
  }

  unbindWechatOperator(blacklakeOperatorId) {
    const operators = this.db.prepare(`
      SELECT id FROM operators WHERE blacklake_operator_id = ?
    `).all(blacklakeOperatorId);
    if (!operators.length) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let changedCount = 0;
      for (const operator of operators) {
        changedCount += this.db.prepare("DELETE FROM wechat_bindings WHERE operator_id = ?").run(operator.id).changes;
        this.db.prepare("DELETE FROM sessions WHERE operator_id = ?").run(operator.id);
        this.db.prepare(`
          UPDATE operator_binding_codes SET used_at = CURRENT_TIMESTAMP
          WHERE operator_id = ? AND used_at IS NULL
        `).run(operator.id);
      }
      this.db.exec("COMMIT");
      return changedCount > 0;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  createSession(operatorId, { scope = "worker", ttlHours = null } = {}) {
    const token = newSessionToken();
    const lifetimeMs = ttlHours === null ? this.sessionDays * 86400000 : ttlHours * 3600000;
    const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
    this.db.prepare("INSERT INTO sessions(token_hash, operator_id, scope, expires_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), operatorId, scope, expiresAt);
    return { token, expiresAt };
  }

  session(token) {
    const row = this.db.prepare(`
      SELECT s.token_hash AS tokenHash, s.expires_at AS expiresAt,
             s.scope,
             o.id, o.name, o.phone_last4 AS phoneLast4,
             o.blacklake_operator_id AS blacklakeOperatorId,
             o.group_names_json AS groupNamesJson
      FROM sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND o.active = 1
    `).get(hashToken(token), new Date().toISOString());
    if (row) this.db.prepare("UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(row.tokenHash);
    return row ? (this.members?.decorate(operatorRecord(row)) || operatorRecord(row)) : undefined;
  }

  deleteSession(token) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  reportByKey(key) {
    const row=this.db.prepare("SELECT * FROM reports WHERE idempotency_key = ?").get(key),identity=row&&this.members?.snapshot(row.id);
    return identity?{...row,submissionIdentity:identity}:row;
  }

  reportById(id) {
    const row=this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id),identity=row&&this.members?.snapshot(row.id);
    return identity?{...row,submissionIdentity:identity}:row;
  }

  claimFlowAssignment(assignment, { allowParallel = false, boundEmbroidery = false } = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.prepare(`
        SELECT task_id AS taskId, project_id AS projectId, process_name AS processName, status,
          machine_id AS machineId, assignment_mode AS assignmentMode
        FROM assignments
        WHERE operator_id = ? AND status IN ('READY', 'IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
        AND NOT (status IN ('REPORTING','NEEDS_REVIEW') AND quantity_policy='PENDING_REVIEW' AND ended_at IS NOT NULL)
      `).all(assignment.operatorId);
      const embroidery = isEmbroideryProcessName(assignment.processName);
      const owner=boundEmbroidery?this.db.prepare('SELECT blacklake_operator_id AS id FROM operators WHERE id=? AND active=1').get(assignment.operatorId):null;
      const location=owner?this.entryProfile(owner.id).workUnitId:'';
      const stationName = boundEmbroidery ? (/^3F-(?:0[1-9]|1[0-2])$/.test(location) ? location : '') : assignment.stationName || '';
      const machineId = embroidery && !boundEmbroidery ? String(assignment.machineId || "") : "";
      const embroideryPart = embroidery ? normalizeEmbroideryPart(assignment.embroideryPart) : "";
      if (boundEmbroidery && (!owner || !embroidery) || embroidery && ((!boundEmbroidery&&!EMBROIDERY_MACHINE_IDS.includes(machineId)) || !embroideryPart)) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      if (active.length && (
          !allowParallel || boundEmbroidery ||
        !embroidery ||
        active.some((item) => item.assignmentMode === BOUND_EMBROIDERY_ASSIGNMENT || !isEmbroideryProcessName(item.processName)) ||
        active.some((item) => item.machineId === machineId)
      )) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      if (machineId && this.activeAssignmentByMachine(machineId)) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      // Legacy columns remain for existing databases. Sentinel values disable duration judgment.
      this.db.prepare(`
        INSERT INTO assignments(
          id, operator_id, task_id, project_id, project_code, product_name, process_name,
          station_name, machine_id, embroidery_part, quantity, target_quantity, baseline_reported_amount, local_report_baseline, min_duration_seconds, max_duration_seconds,
          status, assignment_mode, flow_code_hash, flow_code_hint, published_by, published_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 2147483647, 'IN_PROGRESS', ?, ?, ?, ?, ?, ?)
      `).run(
        assignment.id, assignment.operatorId, assignment.taskId, assignment.projectId,
        assignment.projectCode, assignment.productName, assignment.processName,
        stationName, machineId, embroideryPart,
        assignment.quantity, assignment.quantity, assignment.baselineReportedAmount || 0,
        this.succeededAmountForTaskSince({ taskId: assignment.taskId, projectId: assignment.projectId, since: "", includeDefects: this.isQualityOperator(assignment.operatorId) }),
        boundEmbroidery?BOUND_EMBROIDERY_ASSIGNMENT:'SELF_SCAN',assignment.flowCodeHash, assignment.flowCodeHint || "",
        "扫码领取", assignment.startedAt, assignment.startedAt
      );
      this.db.prepare('UPDATE assignments SET quality_inspection=? WHERE id=?').run(this.isQualityOperator(assignment.operatorId)?1:0,assignment.id);
      this.db.exec("COMMIT");
      return this.assignmentById(assignment.id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      if (String(error.code || "").includes("SQLITE") && String(error.message || "").includes("constraint")) return undefined;
      throw error;
    }
  }

  dispatchAssignments(assignments, { predictionFeedback, allowQueue = false } = {}) {
    if (!Array.isArray(assignments) || !assignments.length) return undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const occupiedMachineStatement = this.db.prepare(`
        SELECT id FROM assignments
        WHERE status IN ('IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
          AND machine_id IN (?, ?, ?)
        LIMIT 1
      `);
      const operatorBusyStatement = this.db.prepare(`
        SELECT id FROM assignments
        WHERE operator_id = ? AND status IN ('READY', 'IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
        AND NOT (status IN ('REPORTING','NEEDS_REVIEW') AND quantity_policy='PENDING_REVIEW' AND ended_at IS NOT NULL)
        LIMIT 1
      `);
      const operatorWorkingStatement = this.db.prepare(`
        SELECT id FROM assignments
        WHERE operator_id = ? AND status IN ('IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
        AND NOT (status IN ('REPORTING','NEEDS_REVIEW') AND quantity_policy='PENDING_REVIEW' AND ended_at IS NOT NULL)
        LIMIT 1
      `);
      const queueBlockedStatement=this.db.prepare(`SELECT id FROM assignments WHERE operator_id=?
        AND status IN ('READY','IN_PROGRESS','REPORTING','NEEDS_REVIEW')
        AND NOT (status IN ('REPORTING','NEEDS_REVIEW') AND quantity_policy='PENDING_REVIEW' AND ended_at IS NOT NULL)
        AND (machine_id<>'' OR status IN ('REPORTING','NEEDS_REVIEW')) LIMIT 1`);
      const duplicateStatement=this.db.prepare(`SELECT id FROM assignments WHERE operator_id=? AND task_id=?
        AND COALESCE(project_id,0)=COALESCE(?,0) AND status IN ('READY','IN_PROGRESS','PAUSED','REPORTING','NEEDS_REVIEW') LIMIT 1`);
      const selectedOperators = new Set();
      const selectedMachines = new Set();
      for (const assignment of assignments) {
        assert(!this.orderRemoved(assignment.projectId),409,'WORK_ORDER_DELETED','黑湖已删除这张工单，不能派工。');
        assert(!this.orderStatusPending(assignment.projectId),409,'WORKSPACE_ORDER_RESULT_UNKNOWN','这张工单的执行状态正在核对，确认后可派工。');
        if (assignment.expectedBoundUnitId) {
          const bound = this.db.prepare(`SELECT DISTINCT m.unit_id FROM dispatch_unit_recommendation_members m
            JOIN operators o ON o.blacklake_operator_id = m.blacklake_operator_id WHERE o.id = ?`).all(assignment.operatorId);
          if (bound.length !== 1 || bound[0].unit_id !== assignment.expectedBoundUnitId) {
            this.db.exec("ROLLBACK");
            return undefined;
          }
        }
        const machineId = String(assignment.machineId || "");
        const queueable=allowQueue&&!machineId&&FLOOR8_UNIT_IDS.includes(assignment.stationName);
        if(queueable)assert(!duplicateStatement.get(assignment.operatorId,assignment.taskId,assignment.projectId),409,'DUPLICATE_QUEUED_TASK','这名员工已有同一工单工序的未完成任务，请核对队列，勿重复派工。');
        const operatorBusy = machineId
          ? operatorWorkingStatement.get(assignment.operatorId)
          : queueable?queueBlockedStatement.get(assignment.operatorId):operatorBusyStatement.get(assignment.operatorId);
        const aliases=embroideryMachineAliases(machineId);
        const occupiedMachine = machineId ? occupiedMachineStatement.get(...aliases) : undefined;
        if (selectedOperators.has(assignment.operatorId) || operatorBusy || occupiedMachine || (machineId && selectedMachines.has(aliases[0]))) {
          this.db.exec("ROLLBACK");
          return undefined;
        }
        selectedOperators.add(assignment.operatorId);
        if (machineId) selectedMachines.add(aliases[0]);
      }
      const insert = this.db.prepare(`
        INSERT INTO assignments(
          id, operator_id, task_id, project_id, project_code, product_name, process_name,
          station_name, machine_id, embroidery_part, quantity, target_quantity,
          baseline_reported_amount, local_report_baseline, min_duration_seconds, max_duration_seconds,
          status, assignment_mode, flow_code_hash, flow_code_hint, published_by, published_by_operator_id, published_at,
          quantity_policy, dispatch_batch_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 2147483647,
          'READY', 'DISPATCHED', ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const assignment of assignments) {
        insert.run(
          assignment.id, assignment.operatorId, assignment.taskId, assignment.projectId,
          assignment.projectCode, assignment.productName, assignment.processName,
          assignment.stationName || "", assignment.machineId || "", assignment.embroideryPart || "",
          assignment.quantity, assignment.quantity, assignment.baselineReportedAmount || 0,
          this.succeededAmountForTaskSince({
            taskId: assignment.taskId,
            projectId: assignment.projectId,
            since: "",
            includeDefects: this.isQualityOperator(assignment.operatorId)
          }),
          assignment.flowCodeHash, assignment.flowCodeHint || "",
          assignment.publishedBy || "小程序派单", assignment.publishedByOperatorId || null, assignment.publishedAt,
          assignment.quantityPolicy || "", assignment.dispatchBatchId || ""
        );
        this.db.prepare('UPDATE assignments SET quality_inspection=? WHERE id=?').run(this.isQualityOperator(assignment.operatorId)?1:0,assignment.id);
      }
      if (predictionFeedback) this.predictions.confirm(predictionFeedback);
      this.db.exec("COMMIT");
      return assignments.map((assignment) => this.assignmentById(assignment.id));
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      if (String(error.code || "").includes("SQLITE") && String(error.message || "").includes("constraint")) return undefined;
      throw error;
    }
  }

  dispatchAssignment(assignment,options) {
    return this.dispatchAssignments([assignment],options)?.[0];
  }

  dispatchedBatchAssignments(batchId) {
    return this.db.prepare("SELECT id FROM assignments WHERE dispatch_batch_id = ? ORDER BY rowid ASC").all(batchId)
      .map((row) => this.assignmentById(row.id));
  }

  startDispatchedAssignment(id, operatorId, startedAt, freshDefaults) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.prepare(`
        SELECT id FROM assignments
        WHERE operator_id = ? AND id <> ? AND status IN ('IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
        AND NOT (status IN ('REPORTING','NEEDS_REVIEW') AND quantity_policy='PENDING_REVIEW' AND ended_at IS NOT NULL)
        LIMIT 1
      `).get(operatorId, id);
      if (active) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const requested=this.db.prepare('SELECT * FROM assignments WHERE id=? AND operator_id=?').get(id,operatorId);
      if(requested?.machine_id){
        const occupied=this.db.prepare(`SELECT id FROM assignments WHERE id<>? AND machine_id IN (?, ?, ?)
          AND status IN ('IN_PROGRESS','REPORTING','NEEDS_REVIEW')
          AND NOT (status IN ('REPORTING','NEEDS_REVIEW') AND quantity_policy='PENDING_REVIEW' AND ended_at IS NOT NULL) LIMIT 1`).get(id,...embroideryMachineAliases(requested.machine_id));
        assert(!occupied,409,'EMBROIDERY_MACHINE_IN_USE','当前机台还有进行中的任务，请先处理原任务。');
      }
      if(requested?.assignment_mode==='DISPATCHED'&&!requested.machine_id&&FLOOR8_UNIT_IDS.includes(requested.station_name)){
        const head=this.db.prepare(`SELECT id FROM assignments WHERE operator_id=? AND status IN ('READY','PAUSED') AND assignment_mode='DISPATCHED' AND machine_id=''
          ORDER BY CASE WHEN queue_position IS NULL THEN 1 ELSE 0 END,queue_position ASC,published_at ASC,created_at ASC,rowid ASC LIMIT 1`).get(operatorId);
        assert(!head||head.id===id,409,'QUEUE_ORDER_REQUIRED','请先完成排在前面的任务；如派错，请组长撤销前面的待开始任务。');
      }
      if(freshDefaults){
        assert(Number.isSafeInteger(freshDefaults.quantity)&&freshDefaults.quantity>0,422,'BLACKLAKE_PLAN_AMOUNT_INVALID','暂未取得有效的默认数量，请核对上一工序良品数或工单计划数。');
        const localNow=this.succeededAmountForTaskSince({taskId:requested.task_id,projectId:requested.project_id,since:'',includeDefects:this.assignmentRecord(requested).isQualityInspection});
        const knownCumulative=Number(requested.baseline_reported_amount||0)+Math.max(0,localNow-Number(requested.local_report_baseline||0));
        this.db.prepare("UPDATE assignments SET quantity=?,target_quantity=?,baseline_reported_amount=?,local_report_baseline=? WHERE id=? AND operator_id=? AND status='READY'").run(
          freshDefaults.quantity,freshDefaults.quantity,Math.max(knownCumulative,freshDefaults.baselineReportedAmount||0),localNow,id,operatorId);
      }
      const changed = this.db.prepare(`
        UPDATE assignments SET status = 'IN_PROGRESS', started_at = COALESCE(started_at,?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND operator_id = ? AND status = 'READY' AND assignment_mode = 'DISPATCHED'
      `).run(startedAt, id, operatorId);
      if (changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      // The legacy client and the mounted workspace share the same assignment.
      // Populate its first segment too: an empty dispatch-time snapshot must
      // never overwrite a successful legacy start during the next queue write.
      if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_task_state'").get()){
        const saved=this.db.prepare('SELECT state_json FROM workspace_task_state WHERE assignment_id=?').get(id);
        if(saved){const state=JSON.parse(saved.state_json),iso=text=>new Date(text.replace(' ','T')+'+08:00').toISOString();
          if(!state.segments?.length)state.segments=[{start:iso(requested.started_at||startedAt),end:null}];
          else if(state.segments.at(-1).end)state.segments.push({start:iso(startedAt),end:null});
          this.db.prepare('UPDATE workspace_task_state SET state_json=? WHERE assignment_id=?').run(JSON.stringify(state),id);
          this.db.prepare("UPDATE assignment_pauses SET ended_at=? WHERE assignment_id=? AND ended_at IS NULL AND source='workspace_queue'").run(startedAt,id);
        }
      }
      this.db.prepare('INSERT INTO assignment_actions(assignment_id,action,reason,actor) VALUES(?,?,?,?)').run(id,'EMPLOYEE_START',JSON.stringify({source:'legacy-assignment-start',before:{status:requested.status,startedAt:requested.started_at},after:{status:'IN_PROGRESS',startedAt:requested.started_at||startedAt}}),'operator:'+operatorId);
      this.db.exec("COMMIT");
      return this.assignmentById(id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  assignmentById(id) {
    const row = this.db.prepare(`
      SELECT a.*, o.name AS operator_name, o.phone_last4 AS operator_phone_last4
      FROM assignments a JOIN operators o ON o.id = a.operator_id
      WHERE a.id = ?
    `).get(id);
    return row ? this.assignmentRecord(row) : undefined;
  }

  dispatchQueueState(blacklakeOperatorId) {
    const rows=this.db.prepare(`SELECT a.status,a.machine_id FROM assignments a JOIN operators o ON o.id=a.operator_id
      WHERE o.blacklake_operator_id=? AND a.status IN ('READY','IN_PROGRESS','REPORTING','NEEDS_REVIEW')
      AND NOT (a.status IN ('REPORTING','NEEDS_REVIEW') AND a.quantity_policy='PENDING_REVIEW' AND a.ended_at IS NOT NULL)`).all(blacklakeOperatorId);
    const queuedCount=rows.filter(row=>row.status==='READY'&&!row.machine_id).length;
    const available=rows.length===0,working=rows.some(row=>row.status==='IN_PROGRESS');
    const canQueue=rows.every(row=>!row.machine_id&&['READY','IN_PROGRESS'].includes(row.status));
    return {available,canQueue,queuedCount,dispatchStateLabel:available?'空闲':!canQueue?'待处理':working?(queuedCount?'生产中 · 待做'+queuedCount+'单':'生产中 · 可排单'):'待做'+queuedCount+'单'};
  }

  currentAssignment(operatorId) {
    return this.activeAssignments(operatorId)[0];
  }

  activeAssignments(operatorId) {
    // QUANTITY_PENDING has ended locally: keep it in history, not worker occupancy.
    return this.db.prepare(`
      SELECT * FROM assignments
      WHERE operator_id = ? AND status IN ('READY', 'IN_PROGRESS', 'PAUSED', 'REPORTING', 'NEEDS_REVIEW')
        AND NOT (status IN ('REPORTING','NEEDS_REVIEW') AND quantity_policy='PENDING_REVIEW' AND ended_at IS NOT NULL)
      ORDER BY CASE status WHEN 'NEEDS_REVIEW' THEN 0 WHEN 'REPORTING' THEN 1 WHEN 'IN_PROGRESS' THEN 2 ELSE 3 END,
        CASE WHEN queue_position IS NULL THEN 1 ELSE 0 END,queue_position ASC,published_at ASC, created_at ASC,rowid ASC
    `).all(operatorId).map(row=>this.assignmentRecord(row));
  }

  activeAssignmentByMachine(machineId) {
    const row = this.db.prepare(`
      SELECT a.*, o.name AS operator_name, o.phone_last4 AS operator_phone_last4
      FROM assignments a JOIN operators o ON o.id = a.operator_id
      WHERE a.machine_id IN (?, ?, ?) AND a.status IN ('READY', 'IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
        AND NOT (a.status IN ('REPORTING','NEEDS_REVIEW') AND a.quantity_policy='PENDING_REVIEW' AND a.ended_at IS NOT NULL)
      ORDER BY a.started_at DESC LIMIT 1
    `).get(...embroideryMachineAliases(machineId));
    return row ? this.assignmentRecord(row) : undefined;
  }

  activeAssignmentByUnit(unitId) {
    return this.activeAssignmentsByUnit(unitId)[0];
  }

  activeAssignmentsByUnit(unitId) {
    return this.db.prepare(`
      SELECT a.*, o.name AS operator_name, o.phone_last4 AS operator_phone_last4
      FROM assignments a JOIN operators o ON o.id = a.operator_id
      WHERE (a.machine_id IN (?, ?, ?) OR a.station_name = ?)
        AND a.status IN ('READY', 'IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW')
        AND NOT (a.status IN ('REPORTING','NEEDS_REVIEW') AND a.quantity_policy='PENDING_REVIEW' AND a.ended_at IS NOT NULL)
      ORDER BY CASE a.status WHEN 'NEEDS_REVIEW' THEN 0 WHEN 'REPORTING' THEN 1 WHEN 'IN_PROGRESS' THEN 2 ELSE 3 END,
        a.created_at DESC
    `).all(...embroideryMachineAliases(unitId),String(unitId || "")).map(row=>this.assignmentRecord(row));
  }

  dispatchHistory({ unitIds, from, to, limit = 100, includeActive = false, publishedByOperatorId }) {
    if (!unitIds.length || !Number.isSafeInteger(publishedByOperatorId) || publishedByOperatorId <= 0) return { assignments: [], total: 0 };
    // Legacy includeActive also includes unresolved quantity records across dates;
    // QUANTITY_PENDING remains traceable without occupying a worker or workstation.
    const where = `a.assignment_mode = 'DISPATCHED' AND a.published_by_operator_id = ? AND ((a.published_at >= ? AND a.published_at < ?)
      ${includeActive ? "OR a.status IN ('READY', 'IN_PROGRESS', 'REPORTING', 'NEEDS_REVIEW', 'QUANTITY_PENDING')" : ""})
      AND COALESCE(NULLIF(a.machine_id, ''), a.station_name) IN (${unitIds.map(() => "?").join(",")})`;
    const parameters = [publishedByOperatorId, from, to, ...unitIds];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS total FROM assignments a WHERE ${where}`).get(...parameters).total);
    const assignments = this.db.prepare(`
      SELECT a.*, o.name AS operator_name, r.blacklake_output_id
      FROM assignments a JOIN operators o ON o.id = a.operator_id
      LEFT JOIN reports r ON r.id = a.report_id
      WHERE ${where} ORDER BY a.published_at DESC, a.id DESC LIMIT ?
    `).all(...parameters, limit).map(row=>this.assignmentRecord(row));
    return { assignments, total };
  }

  cancelDispatchedAssignment({ id, unitIds, reason, endedAt, actor, publishedByOperatorId }) {
    if (!unitIds.length || !Number.isSafeInteger(publishedByOperatorId) || publishedByOperatorId <= 0) return undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(`
        UPDATE assignments SET status = 'CANCELLED', cancellation_reason = ?,
          ended_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'READY' AND assignment_mode = 'DISPATCHED'
          AND published_by_operator_id = ?
          AND COALESCE(NULLIF(machine_id, ''), station_name) IN (${unitIds.map(() => "?").join(",")})
      `).run(reason, endedAt, id, publishedByOperatorId, ...unitIds);
      if (changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare(`INSERT INTO assignment_actions(assignment_id, action, reason, actor)
        VALUES (?, 'CANCEL', ?, ?)`).run(id, reason, actor);
      this.db.exec("COMMIT");
      return this.assignmentById(id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  embroiderySchedule() {
    const row = this.db.prepare(`
      SELECT revision, schedule_json AS scheduleJson, updated_by AS updatedBy, updated_at AS updatedAt
      FROM embroidery_schedule WHERE id = 1
    `).get();
    let machines = [];
    try { machines = JSON.parse(row?.scheduleJson || "[]"); } catch {}
    return {
      revision: Number(row?.revision || 0),
      machines: Array.isArray(machines) ? machines : [],
      updatedBy: row?.updatedBy || "",
      updatedAt: row?.updatedAt || null
    };
  }

  saveEmbroiderySchedule({ expectedRevision, machines, updatedBy }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT revision FROM embroidery_schedule WHERE id = 1").get();
      if (Number(current?.revision || 0) !== Number(expectedRevision)) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const changed = this.db.prepare(`
        UPDATE embroidery_schedule
        SET revision = revision + 1, schedule_json = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1 AND revision = ?
      `).run(JSON.stringify(machines), String(updatedBy || "admin"), Number(expectedRevision));
      if (changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.exec("COMMIT");
      return this.embroiderySchedule();
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  succeededAmountForTaskSince({ taskId, projectId, since, includeDefects = false }) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(${includeDefects ? "amount" : "good_amount"}), 0) AS amount
      FROM reports
      WHERE task_id = ? AND project_id IS ? AND status = 'SUCCEEDED' AND output_time >= ?
    `).get(taskId, projectId ?? null, since);
    return Number(row?.amount || 0);
  }

  favoriteProcessNames(operatorId, limit = 30) {
    return this.db.prepare(`
      SELECT process_name AS processName, COUNT(*) AS useCount,
        MAX(COALESCE(ended_at, updated_at)) AS lastUsedAt
      FROM assignments
      WHERE operator_id = ? AND status = 'COMPLETED'
      GROUP BY process_name
      ORDER BY useCount DESC, lastUsedAt DESC
      LIMIT ?
    `).all(operatorId, limit).map((row) => row.processName);
  }

  finishAssignmentPendingQuantity({ assignmentId, operatorId, endedAt, durationSeconds, actor }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current=this.assignmentById(assignmentId);
      durationSeconds=effectiveWorkSecondsBetween(current?.startedAt,endedAt,current?.pauses);
      assert(Number.isFinite(durationSeconds),500,'INVALID_ASSIGNMENT_TIME','任务时间记录异常，请联系管理员。');
      const changed = this.db.prepare(`
        UPDATE assignments SET status = 'QUANTITY_PENDING', ended_at = COALESCE(ended_at, ?),
          duration_seconds = ?, quantity_policy = 'PENDING_REVIEW', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND operator_id = ? AND status = 'IN_PROGRESS' AND report_id IS NULL
          AND assignment_mode = 'DISPATCHED' AND machine_id = '' AND station_name <> ''
      `).run(endedAt, durationSeconds, assignmentId, operatorId);
      if (changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare(`INSERT INTO assignment_actions(assignment_id, action, reason, actor)
        VALUES (?, 'FINISH_PENDING_QUANTITY', '完工仅登记参与时间，数量待核对，未提交黑湖产量', ?)`)
        .run(assignmentId, actor);
      this.db.exec("COMMIT");
      return this.assignmentById(assignmentId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  prepareAssignmentCompletion({ assignmentId, operatorId, endedAt, durationSeconds, assessment, report, onPrepared }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current=this.assignmentById(assignmentId);
      const inspection=current?.isQualityInspection;
      durationSeconds=effectiveWorkSecondsBetween(current?.startedAt,endedAt,current?.pauses);
      assert(Number.isFinite(durationSeconds),500,'INVALID_ASSIGNMENT_TIME','任务时间记录异常，请联系管理员。');
      this.insertPendingReport(report);
      this.db.prepare('UPDATE assignments SET quality_inspection=COALESCE(quality_inspection,?) WHERE id=?').run(inspection?1:0,assignmentId);
      const changed = this.db.prepare(`
        UPDATE assignments SET status = 'REPORTING', quantity = ?, good_quantity = ?, defect_quantity = ?, defect_code = ?, ended_at = ?, duration_seconds = ?,
          duration_assessment = ?, report_id = ?, quantity_policy = 'SERVER_DEFAULT', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND operator_id = ? AND status = 'IN_PROGRESS'
      `).run(report.amount, report.goodAmount, report.defectAmount, report.defectCode, endedAt, durationSeconds, assessment, report.id, assignmentId, operatorId);
      if (changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      onPrepared?.();
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  completeAssignment(id) {
    this.db.prepare(`
      UPDATE assignments SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('REPORTING', 'NEEDS_REVIEW')
    `).run(id);
    return this.assignmentById(id);
  }

  restoreAssignmentAfterFailure(id) {
    this.db.prepare(`
      UPDATE assignments SET status = 'IN_PROGRESS',
        duration_assessment = NULL, report_id = NULL, attempt_number = attempt_number + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('REPORTING', 'NEEDS_REVIEW')
    `).run(id);
    return this.assignmentById(id);
  }

  cancelAssignmentAfterRejectedReport({ assignmentId, idempotencyKey, errorCode, errorMessage, reason }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const report = this.db.prepare(`
        UPDATE reports SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE idempotency_key = ? AND status = 'PENDING'
      `).run(errorCode, errorMessage, idempotencyKey);
      const assignment = this.db.prepare(`
        UPDATE assignments SET status = 'CANCELLED', cancellation_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'REPORTING'
          AND report_id = (SELECT id FROM reports WHERE idempotency_key = ?)
      `).run(reason, assignmentId, idempotencyKey);
      if (report.changes !== 1 || assignment.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare(`INSERT INTO assignment_actions(assignment_id, action, reason, actor)
        VALUES (?, 'CANCEL', ?, 'SYSTEM')`).run(assignmentId, reason);
      this.db.exec("COMMIT");
      return this.assignmentById(assignmentId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  reviewAssignment(id) {
    this.db.prepare(`
      UPDATE assignments SET status = 'NEEDS_REVIEW', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'REPORTING'
    `).run(id);
    return this.assignmentById(id);
  }

  canWorkerCancelAssignment(id, operatorId) {
    const evidence = this.db.prepare(`
      SELECT 1
      FROM assignments a
      JOIN reports r ON r.operator_id = a.operator_id
        AND r.task_id = a.task_id
        AND r.project_id IS a.project_id
        AND r.output_time >= a.started_at
      WHERE a.id = ? AND a.operator_id = ? AND a.status = 'IN_PROGRESS'
        AND r.status = 'FAILED'
        AND (
          r.error_code = 'WORK_ORDER_NOT_FOUND'
          OR r.error_message LIKE '%工单%不存在%'
          OR r.error_message LIKE '%工单%删除%'
        )
      ORDER BY r.created_at DESC
      LIMIT 1
    `).get(id, operatorId);
    return Boolean(evidence);
  }

  cancelAssignment(id, reason, endedAt, actor = "AUTHENTICATED_ADMIN") {
    if (!["AUTHENTICATED_ADMIN", "AUTHENTICATED_OPERATOR"].includes(actor)) {
      throw new TypeError("Invalid cancellation actor");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(`
        UPDATE assignments SET status = 'CANCELLED', cancellation_reason = ?,
          ended_at = COALESCE(ended_at, ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'IN_PROGRESS'
      `).run(reason, endedAt, id);
      if (changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare(`INSERT INTO assignment_actions(assignment_id, action, reason, actor)
        VALUES (?, 'CANCEL', ?, ?)`).run(id, reason, actor);
      this.db.exec("COMMIT");
      return this.assignmentById(id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  // Single-writer service startup only: an interrupted request may already exist in Blacklake.
  // Never resend automatically; preserve its quantity and original completion time for review.
  recoverInterruptedReports() {
    const hasQueue=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_jobs'").get();
    const queuedReport=hasQueue?" AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.mode='write' AND j.kind='report-create' AND j.report_id=reports.id)":'';
    const queuedAssignment=hasQueue?" AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.mode='write' AND j.kind='report-create' AND j.report_id=assignments.report_id)":'';
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        UPDATE assignments SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'REPORTING' AND report_id IN (SELECT id FROM reports WHERE status = 'SUCCEEDED');
        UPDATE reports SET status = 'UNKNOWN', error_code = 'SERVER_RESTART',
          error_message = '提交期间服务重启，请核对黑湖是否已有记录', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'PENDING' AND id IN (SELECT report_id FROM assignments WHERE status = 'REPORTING')${queuedReport};
        UPDATE assignments SET status = 'NEEDS_REVIEW', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'REPORTING'${queuedAssignment};
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  resolveUnknownAsConfirmed(id, blacklakeOutputId = "") {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const assignment = this.db.prepare(`
        SELECT report_id AS reportId FROM assignments
        WHERE id = ? AND status = 'NEEDS_REVIEW'
      `).get(id);
      if (!assignment?.reportId) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const report = this.db.prepare(`
        UPDATE reports SET status = 'SUCCEEDED', blacklake_output_id = ?,
          error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'UNKNOWN'
      `).run(String(blacklakeOutputId || ""), assignment.reportId);
      const changed = this.db.prepare(`
        UPDATE assignments SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'NEEDS_REVIEW'
      `).run(id);
      if (report.changes !== 1 || changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.exec("COMMIT");
      return this.assignmentById(id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  resolveUnknownAsNotCreated(id) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const assignment = this.db.prepare(`
        SELECT report_id AS reportId FROM assignments
        WHERE id = ? AND status = 'NEEDS_REVIEW'
      `).get(id);
      if (!assignment?.reportId) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const report = this.db.prepare(`
        UPDATE reports SET status = 'FAILED', error_code = 'AUDIT_NOT_CREATED',
          error_message = '审计已确认黑湖未产生报工记录', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'UNKNOWN'
      `).run(assignment.reportId);
      const changed = this.db.prepare(`
        UPDATE assignments SET status = CASE WHEN quantity_policy = 'PENDING_REVIEW' THEN 'QUANTITY_PENDING' ELSE 'IN_PROGRESS' END,
          duration_assessment = NULL, report_id = NULL,
          attempt_number = attempt_number + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'NEEDS_REVIEW'
      `).run(id);
      if (report.changes !== 1 || changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.exec("COMMIT");
      return this.assignmentById(id);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  recentAssignments(operatorId, limit = 10) {
    return this.db.prepare(`
      SELECT id, report_id AS linkedReportId, project_code AS projectCode, product_name AS productName,
        process_name AS processName, quantity, status, started_at AS startedAt,
        ended_at AS endedAt, duration_seconds AS durationSeconds,
        duration_assessment AS durationAssessment
      FROM assignments WHERE operator_id = ? AND status IN ('COMPLETED', 'NEEDS_REVIEW', 'QUANTITY_PENDING', 'CANCELLED')
      ORDER BY COALESCE(ended_at, updated_at) DESC LIMIT ?
    `).all(operatorId, limit).map(({linkedReportId,...row})=>{const identity=linkedReportId?reportSubmissionIdentity(this,linkedReportId):null;return {...row,...(identity?{submissionIdentity:identity}:{})};});
  }

  listAssignments(limit = 100) {
    return this.db.prepare(`
      SELECT a.*, o.name AS operator_name, o.phone_last4 AS operator_phone_last4,
        r.blacklake_output_id
      FROM assignments a JOIN operators o ON o.id = a.operator_id
      LEFT JOIN reports r ON r.id = a.report_id
      ORDER BY a.published_at DESC LIMIT ?
    `).all(limit).map(row=>this.assignmentRecord(row));
  }

  listAuditEvents({ query = "", eventType = "ALL", errorCode = "ALL", actor = "ALL", from = "", to = "", limit = 50, offset = 0 } = {}) {
    const auditEvents = `
      WITH audit_events AS (
        SELECT
          'report:' || r.id AS event_id,
          CASE r.status
            WHEN 'SUCCEEDED' THEN 'REPORT_SUCCEEDED'
            WHEN 'FAILED' THEN 'REPORT_FAILED'
            WHEN 'UNKNOWN' THEN 'REPORT_UNKNOWN'
            ELSE 'REPORT_PENDING'
          END AS event_type,
          r.updated_at AS event_time,
          o.name AS operator_name,
          o.blacklake_operator_id AS blacklake_operator_id,
          r.project_code AS project_code,
          r.product_name AS product_name,
          r.process_name AS process_name,
          r.task_id AS task_id,
          COALESCE(a.machine_id, '') AS machine_id,
          COALESCE(a.embroidery_part, '') AS embroidery_part,
          COALESCE(a.id, '') AS assignment_id,
          COALESCE(a.status, '') AS assignment_status,
          r.status AS report_status,
          COALESCE(r.error_code, '') AS error_code,
          COALESCE(r.error_message, '') AS reason,
          'AUTHENTICATED_OPERATOR' AS actor,
          r.amount AS amount,
          r.good_amount AS good_amount,
          r.defect_amount AS defect_amount,
          COALESCE(r.blacklake_output_id, '') AS blacklake_output_id,
          r.id AS source_id
        FROM reports r
        JOIN operators o ON o.id = r.operator_id
        LEFT JOIN assignments a ON a.report_id = r.id

        UNION ALL

        SELECT
          'action:' || aa.id AS event_id,
          CASE aa.action WHEN 'CANCEL' THEN 'ASSIGNMENT_CANCELLED' ELSE 'ASSIGNMENT_ACTION' END AS event_type,
          aa.created_at AS event_time,
          o.name AS operator_name,
          o.blacklake_operator_id AS blacklake_operator_id,
          a.project_code AS project_code,
          a.product_name AS product_name,
          a.process_name AS process_name,
          a.task_id AS task_id,
          COALESCE(a.machine_id, '') AS machine_id,
          COALESCE(a.embroidery_part, '') AS embroidery_part,
          a.id AS assignment_id,
          a.status AS assignment_status,
          COALESCE(r.status, '') AS report_status,
          COALESCE(r.error_code, '') AS error_code,
          aa.reason AS reason,
          aa.actor AS actor,
          COALESCE(r.amount, 0) AS amount,
          COALESCE(r.good_amount, 0) AS good_amount,
          COALESCE(r.defect_amount, 0) AS defect_amount,
          COALESCE(r.blacklake_output_id, '') AS blacklake_output_id,
          CAST(aa.id AS TEXT) AS source_id
        FROM assignment_actions aa
        JOIN assignments a ON a.id = aa.assignment_id
        JOIN operators o ON o.id = a.operator_id
        LEFT JOIN reports r ON r.id = a.report_id
      )
    `;
    const clauses = [];
    const parameters = [];
    const keyword = String(query || "").trim();
    if (keyword) {
      const pattern = `%${keyword}%`;
      clauses.push(`(
        operator_name LIKE ? OR CAST(blacklake_operator_id AS TEXT) LIKE ? OR
        project_code LIKE ? OR product_name LIKE ? OR process_name LIKE ? OR
        CAST(task_id AS TEXT) LIKE ? OR machine_id LIKE ? OR assignment_id LIKE ? OR
        error_code LIKE ? OR reason LIKE ?
      )`);
      parameters.push(...Array(10).fill(pattern));
    }
    if (eventType !== "ALL") {
      clauses.push("event_type = ?");
      parameters.push(eventType);
    }
    if (errorCode !== "ALL") {
      clauses.push("error_code = ?");
      parameters.push(errorCode);
    }
    if (actor !== "ALL") {
      clauses.push("actor = ?");
      parameters.push(actor);
    }
    if (from) {
      clauses.push("event_time >= datetime(?)");
      parameters.push(from);
    }
    if (to) {
      clauses.push("event_time < datetime(?)");
      parameters.push(to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(this.db.prepare(`${auditEvents} SELECT COUNT(*) AS total FROM audit_events ${where}`).get(...parameters)?.total || 0);
    const events = this.db.prepare(`
      ${auditEvents}
      SELECT
        event_id AS eventId, event_type AS eventType, event_time AS eventTime,
        operator_name AS operatorName, blacklake_operator_id AS blacklakeOperatorId,
        project_code AS projectCode, product_name AS productName, process_name AS processName,
        task_id AS taskId, machine_id AS machineId, embroidery_part AS embroideryPart,
        assignment_id AS assignmentId, assignment_status AS assignmentStatus,
        report_status AS reportStatus, error_code AS errorCode, reason, actor,
        amount, good_amount AS goodAmount, defect_amount AS defectAmount,
        blacklake_output_id AS blacklakeOutputId
      FROM audit_events ${where}
      ORDER BY event_time DESC, event_id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset);
    return { events, total };
  }

  auditFacets() {
    return {
      errorCodes: this.db.prepare(`
        SELECT DISTINCT error_code AS value FROM reports
        WHERE error_code IS NOT NULL AND error_code <> '' ORDER BY error_code
      `).all().map((row) => row.value),
      actors: this.db.prepare(`
        SELECT actor AS value FROM (
          SELECT DISTINCT actor FROM assignment_actions
          UNION SELECT 'AUTHENTICATED_OPERATOR' WHERE EXISTS (SELECT 1 FROM reports)
        ) ORDER BY actor
      `).all().map((row) => row.value)
    };
  }

  unsettledByHash(requestHash) {
    return this.db.prepare(`
      SELECT * FROM reports
      WHERE request_hash = ? AND status IN ('PENDING', 'UNKNOWN')
        AND created_at >= datetime('now', '-10 minutes')
      ORDER BY created_at DESC LIMIT 1
    `).get(requestHash);
  }

  insertPendingReport(report) {
    this.db.prepare(`
      INSERT INTO reports(
        id, idempotency_key, request_hash, operator_id, task_id, project_id, project_code,
        product_name, process_name, amount, good_amount, defect_amount, defect_code,
        status, output_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(
      report.id, report.idempotencyKey, report.requestHash, report.operatorId, report.taskId,
      report.projectId, report.projectCode, report.productName, report.processName,
      report.amount, report.goodAmount, report.defectAmount, report.defectCode, report.outputTime
    );
    if(report.defectItems!==undefined)this.db.prepare('INSERT INTO report_defect_allocations(report_id,items_json) VALUES(?,?)').run(report.id,JSON.stringify(report.defectItems));
    return this.reportByKey(report.idempotencyKey);
  }

  rememberReportSubmitter(reportId, operator) {
    if (!isLocalMemberKey(operator.blacklakeOperatorId)) return;
    const member = this.members.byKey(operator.blacklakeOperatorId);
    assert(member && member.id === operator.id, 409, 'LOCAL_MEMBER_DISABLED', '报工人员状态已变化。');
    this.db.prepare(`INSERT OR IGNORE INTO report_submission_identities
      (report_id,actual_operator_id,actual_name,submit_as_id,submit_as_name,member_revision)
      VALUES (?,?,?,?,?,?)`).run(reportId, operator.id, operator.name, member.submitAsId, member.submitAsName, member.revision);
  }

  markReportSucceeded(key, blacklakeOutputId) {
    this.db.prepare(`
      UPDATE reports SET status = 'SUCCEEDED', blacklake_output_id = ?,
        error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE idempotency_key = ?
    `).run(String(blacklakeOutputId || ""), key);
    return this.reportByKey(key);
  }

  markReportFailed(key, code, message) {
    this.db.prepare(`
      UPDATE reports SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE idempotency_key = ?
    `).run(code, message, key);
    return this.reportByKey(key);
  }

  markReportUnknown(key, code, message) {
    this.db.prepare(`
      UPDATE reports SET status = 'UNKNOWN', error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE idempotency_key = ?
    `).run(code, message, key);
    return this.reportByKey(key);
  }

  recentReports(operatorId, limit = 5) {
    return this.db.prepare(`
      SELECT id, project_code AS projectCode, product_name AS productName,
        process_name AS processName, amount, good_amount AS goodAmount,
        defect_amount AS defectAmount, status, output_time AS outputTime
      FROM reports WHERE operator_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(operatorId, limit);
  }

  close() {
    this.db.close();
  }
}

function assignmentRecord(row) {
  return {
    id: row.id,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    operatorPhoneLast4: row.operator_phone_last4,
    taskId: row.task_id,
    projectId: row.project_id,
    projectCode: row.project_code,
    productName: row.product_name,
    processName: row.process_name,
    stationName: row.station_name,
    machineId: row.machine_id || "",
    embroideryPart: row.embroidery_part || "",
    quantity: row.quantity,
    targetQuantity: row.target_quantity ?? row.quantity,
    localReportBaseline: row.local_report_baseline,
    cancellationReason: row.cancellation_reason,
    goodQuantity: row.good_quantity ?? row.quantity,
    defectQuantity: row.defect_quantity || 0,
    defectCode: row.defect_code || "",
    isQualityInspection: Boolean(row.quality_inspection),
    baselineReportedAmount: row.baseline_reported_amount,
    status: row.status,
    assignmentMode: row.assignment_mode || "SELF_SCAN",
    quantityPolicy: row.status === "QUANTITY_PENDING" ? "PENDING_REVIEW" : "SERVER_DEFAULT",
    dispatchBatchId: row.dispatch_batch_id || "",
    attemptNumber: row.attempt_number,
    publishedBy: row.published_by,
    publishedByOperatorId: row.published_by_operator_id ?? null,
    publishedAt: row.published_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    durationAssessment: row.duration_assessment,
    reportId: row.report_id,
    blacklakeOutputId: row.blacklake_output_id,
    flowCodeHint: row.flow_code_hint
  };
}

function operatorRecord(row) {
  let groupNames = [];
  try { groupNames = normalizeGroupNames(JSON.parse(row.groupNamesJson || "[]")); } catch {}
  const { groupNamesJson: _groupNamesJson, ...operator } = row;
  return { ...operator, groupNames };
}

function normalizeGroupNames(groupNames) {
  return (Array.isArray(groupNames) ? groupNames : [])
    .map((name) => String(name || "").normalize("NFKC").trim())
    .filter((name, index, names) => name && names.indexOf(name) === index);
}
