import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const sqlitePath = String(process.env.SQLITE_DB_PATH || process.env.SQL_STORE_SQLITE_PATH || "").trim();

let db = null;
let initialized = false;

const resolveSqlitePath = () => {
  if (!sqlitePath) return "";
  return path.resolve(process.cwd(), sqlitePath);
};

const getDb = () => {
  if (!sqlitePath) return null;
  if (db) return db;

  const resolvedPath = resolveSqlitePath();
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
};

const ensureInitialized = () => {
  const database = getDb();
  if (!database) return null;
  if (initialized) return database;

  database.exec(`
    CREATE TABLE IF NOT EXISTS assignment_recovery_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'attendance_stop',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      locked_by TEXT NOT NULL DEFAULT '',
      locked_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS assignment_recovery_jobs_status_idx
      ON assignment_recovery_jobs (status, created_at);
    CREATE INDEX IF NOT EXISTS assignment_recovery_jobs_user_id_idx
      ON assignment_recovery_jobs (user_id, status);
  `);
  initialized = true;
  return database;
};

const normalizeJobRow = (row = {}) => ({
  id: String(row.id || "").trim(),
  user_id: String(row.user_id || "").trim(),
  reason: String(row.reason || "attendance_stop").trim() || "attendance_stop",
  status: String(row.status || "pending").trim() || "pending",
  attempts: Number.isFinite(Number(row.attempts)) ? Number(row.attempts) : 0,
  payload: (() => {
    try {
      const parsed = JSON.parse(String(row.payload_json || "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })(),
  locked_by: String(row.locked_by || "").trim(),
  locked_at: String(row.locked_at || "").trim(),
  created_at: String(row.created_at || "").trim(),
  updated_at: String(row.updated_at || "").trim(),
  finished_at: String(row.finished_at || "").trim(),
  error_message: String(row.error_message || "").trim(),
});

export const isAssignmentRecoveryJobStoreEnabled = () => Boolean(sqlitePath);

export const enqueueAssignmentRecoveryJob = ({ user, userId, reason = "attendance_stop", payload = {} } = {}) => {
  const safeUserId = String(userId || user?.id || "").trim();
  const safeReason = String(reason || "attendance_stop").trim() || "attendance_stop";
  const database = ensureInitialized();
  if (!database || !safeUserId) return null;

  const now = new Date().toISOString();
  const id = `assignment-recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const body = {
    ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}),
    user: user && typeof user === "object" && !Array.isArray(user) ? user : undefined,
  };

  database
    .prepare(
      `INSERT INTO assignment_recovery_jobs (
         id, user_id, reason, status, attempts, payload_json, created_at, updated_at
       ) VALUES (
         @id, @user_id, @reason, 'pending', 0, @payload_json, @created_at, @updated_at
       )`,
    )
    .run({
      id,
      user_id: safeUserId,
      reason: safeReason,
      payload_json: JSON.stringify(body),
      created_at: now,
      updated_at: now,
    });

  return { id, user_id: safeUserId, reason: safeReason, status: "pending", attempts: 0, payload: body, created_at: now, updated_at: now };
};

export const claimNextAssignmentRecoveryJob = ({ workerId = "", maxAttempts = 5, staleAfterMs = 10 * 60 * 1000 } = {}) => {
  const database = ensureInitialized();
  if (!database) return null;

  const now = new Date();
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - staleAfterMs).toISOString();
  const safeWorkerId = String(workerId || `assignment-worker-${process.pid}`).trim();

  const row = database
    .prepare(
      `SELECT *
       FROM assignment_recovery_jobs
       WHERE attempts < @maxAttempts
         AND (
           status = 'pending'
           OR status = 'failed'
           OR (status = 'running' AND locked_at <= @staleIso)
         )
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get({ maxAttempts, staleIso });

  if (!row?.id) return null;

  const result = database
    .prepare(
      `UPDATE assignment_recovery_jobs
       SET status = 'running',
           attempts = attempts + 1,
           locked_by = @workerId,
           locked_at = @nowIso,
           updated_at = @nowIso,
           error_message = ''
       WHERE id = @id
         AND attempts < @maxAttempts
         AND (
           status = 'pending'
           OR status = 'failed'
           OR (status = 'running' AND locked_at <= @staleIso)
         )`,
    )
    .run({ id: row.id, workerId: safeWorkerId, nowIso, maxAttempts, staleIso });

  if (!result.changes) return null;

  const claimed = database.prepare("SELECT * FROM assignment_recovery_jobs WHERE id = ?").get(row.id);
  return claimed ? normalizeJobRow(claimed) : null;
};

export const completeAssignmentRecoveryJob = (jobId) => {
  const safeJobId = String(jobId || "").trim();
  const database = ensureInitialized();
  if (!database || !safeJobId) return 0;
  const now = new Date().toISOString();
  return database
    .prepare(
      `UPDATE assignment_recovery_jobs
       SET status = 'done',
           updated_at = ?,
           finished_at = ?,
           locked_by = '',
           locked_at = '',
           error_message = ''
       WHERE id = ?`,
    )
    .run(now, now, safeJobId).changes || 0;
};

export const failAssignmentRecoveryJob = (jobId, errorMessage = "") => {
  const safeJobId = String(jobId || "").trim();
  const database = ensureInitialized();
  if (!database || !safeJobId) return 0;
  const now = new Date().toISOString();
  return database
    .prepare(
      `UPDATE assignment_recovery_jobs
       SET status = 'failed',
           updated_at = ?,
           locked_by = '',
           locked_at = '',
           error_message = ?
       WHERE id = ?`,
    )
    .run(now, String(errorMessage || "").slice(0, 1000), safeJobId).changes || 0;
};
