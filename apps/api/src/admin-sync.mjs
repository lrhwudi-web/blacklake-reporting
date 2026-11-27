// Read-side snapshots only. Never used to authorize or submit a production report.
const FRESH_MS = 60_000;
const RETRY_MS = 30_000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const keyOf = (project) => positiveId(project.projectId) ? `id:${Number(project.projectId)}` : `code:${project.projectCode || ""}`;
const matches = (task, project) => positiveId(project.projectId)
  ? Number(task.projectId) === Number(project.projectId) : task.projectCode === project.projectCode;
const safeCode = (value) => /^[A-Za-z0-9_.:-]{1,80}$/.test(String(value || "")) ? String(value) : undefined;

export class AdminSync {
  constructor(blacklake, { now = Date.now, log = (event) => console.warn(JSON.stringify(event)), batchSize = 25 } = {}) {
    this.blacklake = blacklake;
    this.now = now;
    this.log = log;
    this.batchSize = Math.max(1, batchSize);
    this.routes = new Map();
    this.output = {};
    this.processPending = null;
    this.outputPending = null;
  }

  snapshot(entry = {}) {
    const available = entry.updatedAt !== undefined && this.now() - entry.updatedAt <= MAX_STALE_MS;
    const records = available ? entry.records : [];
    return { records, sync: {
      status: !available ? "unavailable" : entry.errorCode ? "stale" : records.length ? "fresh" : "empty",
      updatedAt: available ? new Date(entry.updatedAt).toISOString() : null,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {})
    } };
  }

  success(entry, records) {
    Object.assign(entry, { records, updatedAt: this.now(), nextAttempt: this.now() + FRESH_MS, errorCode: undefined });
  }

  failure(entries, error, scope, projectCount = undefined) {
    const code = safeCode(error?.code) || "BLACKLAKE_UNAVAILABLE";
    for (const entry of entries) Object.assign(entry, { nextAttempt: this.now() + RETRY_MS, errorCode: code });
    // Upstream messages/payloads may contain credentials or employee details; never log them.
    this.log({ event: "blacklake_admin_sync_failure", scope, code, projectCount,
      upstreamStatus: Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : undefined,
      upstreamCode: safeCode(error?.upstreamCode) });
  }

  async outputs() {
    if(this.blacklake.readSnapshotOutputs)return this.blacklake.readSnapshotOutputs();
    if (this.outputPending) await this.outputPending;
    if (!(this.output.nextAttempt > this.now())) {
      this.outputPending = (async () => {
        try {
          const since = new Date(this.now() - 2 * 86400000 + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
          const records = await this.blacklake.queryOutputs({ createdAtGte: since }, { maxRecords: 2000 });
          this.success(this.output, records);
        } catch (error) { this.failure([this.output], error, "outputs"); }
      })();
      try { await this.outputPending; } finally { this.outputPending = null; }
    }
    return this.snapshot(this.output);
  }

  async processes(projects) {
    if(this.blacklake.readSnapshotProcesses)return this.blacklake.readSnapshotProcesses(projects);
    // Different callers may request overlapping sets. Finish the shared refresh, then
    // re-evaluate each project's TTL instead of starting a duplicate upstream query.
    while (this.processPending) await this.processPending;
    const unique = [...new Map(projects.map((project) => [keyOf(project), project])).values()];
    const due = unique.filter((project) => !(this.routes.get(keyOf(project))?.nextAttempt > this.now()));
    if (due.length) {
      this.processPending = this.refreshProcesses(due);
      try { await this.processPending; } finally { this.processPending = null; }
    }
    const result = projects.map((project) => {
      const snapshot = this.snapshot(this.routes.get(keyOf(project)));
      return { project, tasks: snapshot.records, sync: snapshot.sync };
    });
    for (const [key, entry] of this.routes) {
      if (this.now() - (entry.updatedAt ?? entry.nextAttempt ?? 0) > MAX_STALE_MS && !unique.some((p) => keyOf(p) === key)) this.routes.delete(key);
    }
    return result;
  }

  async refreshProcesses(projects) {
    const batches = [];
    for (let i = 0; i < projects.length; i += this.batchSize) batches.push(projects.slice(i, i + this.batchSize));
    let next = 0;
    const deadline = Date.now() + 30_000;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const entries = batch.map((project) => {
          const key = keyOf(project);
          if (!this.routes.has(key)) this.routes.set(key, {});
          return this.routes.get(key);
        });
        try {
          if (Date.now() > deadline) throw Object.assign(new Error(), { code: "BLACKLAKE_SYNC_DEFERRED" });
          const ids = batch.filter((p) => positiveId(p.projectId)).map((p) => Number(p.projectId));
          const codes = batch.filter((p) => !positiveId(p.projectId)).map((p) => p.projectCode).filter(Boolean);
          const tasks = await this.blacklake.listProjectTasks({ ...(ids.length ? { projectIds: ids } : {}), ...(codes.length ? { projectCodes: codes } : {}) }, { deadline });
          batch.forEach((project, index) => {
            const records = tasks.filter((task) => matches(task, project));
            // A disappearing route must not erase the last known full route silently.
            if (!records.length && entries[index].records?.length) {
              this.failure([entries[index]], { code: "BLACKLAKE_EMPTY_TASK_RESULT" }, "processes", 1);
            } else this.success(entries[index], records);
          });
        } catch (error) { this.failure(entries, error, "processes", batch.length); }
      }
    };
    // Bound concurrency to avoid flooding the upstream API; a failed batch cannot
    // discard already successful batches or their per-project snapshots.
    await Promise.all([worker(), worker()]);
  }
}
