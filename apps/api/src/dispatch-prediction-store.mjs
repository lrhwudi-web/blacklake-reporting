import { randomUUID } from "node:crypto";
import { assert } from "./errors.mjs";
import { predictionDifference } from "./dispatch-prediction.mjs";

export class DispatchPredictions {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS dispatch_predictions (
      id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, dispatcher_name TEXT NOT NULL,
      project_id INTEGER NOT NULL, project_code TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatch_prediction_feedback (
      prediction_id TEXT PRIMARY KEY REFERENCES dispatch_predictions(id), batch_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('ADOPTED','ADJUSTED','NO_SUGGESTION')),
      changed_fields_json TEXT NOT NULL, final_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dispatch_prediction_feedback_time_idx ON dispatch_prediction_feedback(created_at DESC);
    CREATE TABLE IF NOT EXISTS dispatch_station_binding_events (
      id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, previous_json TEXT NOT NULL, next_json TEXT NOT NULL,
      actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
  }

  create({ ownerId, dispatcherName, projectId, projectCode, snapshot }) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`INSERT INTO dispatch_predictions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, ownerId, dispatcherName, projectId, projectCode, JSON.stringify(snapshot), createdAt, expiresAt);
    return { id, createdAt, expiresAt, ...snapshot };
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM dispatch_predictions WHERE id = ?").get(id);
    return row ? { id: row.id, ownerId: row.owner_id, projectId: row.project_id, projectCode: row.project_code,
      dispatcherName: row.dispatcher_name, createdAt: row.created_at, expiresAt: row.expires_at,
      snapshot: JSON.parse(row.snapshot_json) } : null;
  }

  feedback(id) {
    const row = this.db.prepare("SELECT * FROM dispatch_prediction_feedback WHERE prediction_id = ?").get(id);
    return row ? { batchId: row.batch_id, requestHash: row.request_hash } : null;
  }

  confirm({ predictionId, ownerId, batchId, requestHash, finalSelection, reason }) {
    const prediction = this.get(predictionId);
    assert(prediction?.ownerId === ownerId, 403, "PREDICTION_NOT_OWNED", "这条预测不属于当前组长，请重新获取建议。");
    assert(prediction.projectId === finalSelection.projectId, 409, "PREDICTION_WORK_ORDER_CHANGED", "工单与预测不一致。");
    assert(!this.feedback(predictionId), 409, "PREDICTION_ALREADY_USED", "这条建议已确认，请先查看分配记录。");
    assert(Date.parse(prediction.expiresAt) > Date.now(), 409, "PREDICTION_EXPIRED", "建议已过期，请重新获取建议或重新核对。");
    const difference = predictionDifference(prediction.snapshot, finalSelection);
    this.db.prepare(`INSERT INTO dispatch_prediction_feedback VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      predictionId, batchId, requestHash, difference.outcome, JSON.stringify(difference.changedFields),
      JSON.stringify(finalSelection), reason || "", new Date().toISOString());
  }

  listFeedback({ outcome = "ALL", query = "", limit = 30, offset = 0 } = {}) {
    const clauses = [];
    const args = [];
    if (outcome !== "ALL") { clauses.push("f.outcome = ?"); args.push(outcome); }
    if (query) {
      clauses.push("(p.project_code LIKE ? OR p.dispatcher_name LIKE ? OR p.snapshot_json LIKE ? OR f.final_json LIKE ?)");
      args.push(...Array(4).fill(`%${query}%`));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const from = `FROM dispatch_prediction_feedback f JOIN dispatch_predictions p ON p.id = f.prediction_id ${where}`;
    const total = this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
    const summary = { ADOPTED: 0, ADJUSTED: 0, NO_SUGGESTION: 0 };
    for (const row of this.db.prepare(`SELECT f.outcome, COUNT(*) AS n ${from} GROUP BY f.outcome`).all(...args)) summary[row.outcome] = row.n;
    const records = this.db.prepare(`SELECT p.*, f.*, f.created_at AS confirmed_at ${from} ORDER BY f.created_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
      .map((row) => ({ predictionId: row.prediction_id, projectCode: row.project_code, dispatcherName: row.dispatcher_name,
        createdAt: row.confirmed_at, batchId: row.batch_id, outcome: row.outcome, reason: row.reason,
        prediction: JSON.parse(row.snapshot_json), finalSelection: JSON.parse(row.final_json), changedFields: JSON.parse(row.changed_fields_json) }));
    return { records, total, summary, limit, offset };
  }
}
