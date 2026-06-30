import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getSqlStoreConfig } from '../../sql-store.js';

const DEFAULT_QUEUE_PATH = 'server/data/routine-dispatch-queue.sqlite';
const CLAIM_TIMEOUT_MS = Number.parseInt(process.env.ROUTINE_DISPATCH_CLAIM_TIMEOUT_MS || `${30 * 60 * 1000}`, 10);

let db = null;

const nowIso = () => new Date().toISOString();

const resolveQueuePath = () => {
  const explicit = String(process.env.ROUTINE_DISPATCH_QUEUE_DB_PATH || '').trim();
  if (explicit) return explicit;
  const sqlConfig = getSqlStoreConfig();
  return sqlConfig.enabled && sqlConfig.driver === 'sqlite' && sqlConfig.sqlitePath
    ? sqlConfig.sqlitePath
    : DEFAULT_QUEUE_PATH;
};

const getDb = () => {
  if (db) return db;
  const resolvedPath = path.resolve(process.cwd(), resolveQueuePath());
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS routine_dispatch_jobs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      routine_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT '',
      manual INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      locked_by TEXT,
      locked_at TEXT,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      last_error TEXT,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_routine_dispatch_jobs_status_queued
      ON routine_dispatch_jobs(status, queued_at);
    CREATE INDEX IF NOT EXISTS idx_routine_dispatch_jobs_routine_status
      ON routine_dispatch_jobs(routine_id, status);
  `);
  return db;
};

const parseJson = (value, fallback = null) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const rowToJob = (row) =>
  row
    ? {
        id: row.id,
        routineId: row.routine_id,
        routineName: row.routine_name,
        status: row.status,
        trigger: row.trigger,
        manual: Boolean(row.manual),
        payload: parseJson(row.payload_json, {}),
        idempotencyKey: row.idempotency_key || null,
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || 1),
        lockedBy: row.locked_by || null,
        lockedAt: row.locked_at || null,
        queuedAt: row.queued_at,
        startedAt: row.started_at || null,
        finishedAt: row.finished_at || null,
        lastError: row.last_error || null,
        result: parseJson(row.result_json, null),
      }
    : null;

export const enqueueRoutineDispatchJob = ({
  routineId,
  routineName = '',
  options = {},
  idempotencyKey = null,
  maxAttempts = 1,
} = {}) => {
  const normalizedRoutineId = String(routineId || '').trim();
  if (!normalizedRoutineId) {
    return { ok: false, skipped: true, reason: 'missing_routine_id' };
  }

  const database = getDb();
  const timestamp = nowIso();
  const normalizedIdempotencyKey = idempotencyKey ? String(idempotencyKey).trim() : null;

  if (normalizedIdempotencyKey) {
    const existing = database
      .prepare('SELECT * FROM routine_dispatch_jobs WHERE idempotency_key = ?')
      .get(normalizedIdempotencyKey);
    if (existing) {
      return { ok: true, existing: true, job: rowToJob(existing) };
    }
  }

  const id = `routine-job-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  database
    .prepare(
      `INSERT INTO routine_dispatch_jobs (
        id, routine_id, routine_name, status, trigger, manual, payload_json,
        idempotency_key, max_attempts, queued_at
      ) VALUES (
        @id, @routineId, @routineName, 'queued', @trigger, @manual, @payloadJson,
        @idempotencyKey, @maxAttempts, @queuedAt
      )`,
    )
    .run({
      id,
      routineId: normalizedRoutineId,
      routineName: String(routineName || '').trim(),
      trigger: String(options?.trigger || '').trim(),
      manual: options?.manual ? 1 : 0,
      payloadJson: JSON.stringify(options || {}),
      idempotencyKey: normalizedIdempotencyKey || null,
      maxAttempts: Math.max(1, Number.parseInt(String(maxAttempts || 1), 10) || 1),
      queuedAt: timestamp,
    });

  const job = database.prepare('SELECT * FROM routine_dispatch_jobs WHERE id = ?').get(id);
  return { ok: true, queued: true, job: rowToJob(job) };
};

export const hasActiveRoutineDispatchJob = (routineId) => {
  const normalizedRoutineId = String(routineId || '').trim();
  if (!normalizedRoutineId) return false;
  const row = getDb()
    .prepare(
      `SELECT id FROM routine_dispatch_jobs
       WHERE routine_id = ?
         AND status IN ('queued', 'running')
       LIMIT 1`,
    )
    .get(normalizedRoutineId);
  return Boolean(row);
};

export const listActiveRoutineDispatchJobs = () =>
  getDb()
    .prepare(
      `SELECT * FROM routine_dispatch_jobs
       WHERE status IN ('queued', 'running')
       ORDER BY queued_at ASC`,
    )
    .all()
    .map(rowToJob);

export const cancelRoutineDispatchJob = ({ id = '', routineId = '' } = {}) => {
  const normalizedId = String(id || '').trim();
  const normalizedRoutineId = String(routineId || '').trim();
  if (!normalizedId && !normalizedRoutineId) return { ok: false, cancelled: 0 };
  const timestamp = nowIso();
  const statement = normalizedId
    ? getDb().prepare(
        `UPDATE routine_dispatch_jobs
         SET status = 'cancelled', finished_at = ?, locked_by = NULL, locked_at = NULL
         WHERE id = ? AND status = 'queued'`,
      )
    : getDb().prepare(
        `UPDATE routine_dispatch_jobs
         SET status = 'cancelled', finished_at = ?, locked_by = NULL, locked_at = NULL
         WHERE routine_id = ? AND status = 'queued'`,
      );
  const result = statement.run(timestamp, normalizedId || normalizedRoutineId);
  return { ok: true, cancelled: result.changes || 0 };
};

export const claimNextRoutineDispatchJob = ({ workerId, claimTimeoutMs = CLAIM_TIMEOUT_MS } = {}) => {
  const database = getDb();
  const timestamp = nowIso();
  const staleBefore = new Date(Date.now() - Math.max(60_000, claimTimeoutMs)).toISOString();
  const worker = String(workerId || `routine-worker-${process.pid}`).trim();

  const transaction = database.transaction(() => {
    const row = database
      .prepare(
        `SELECT * FROM routine_dispatch_jobs
         WHERE status = 'queued'
            OR (status = 'running' AND locked_at IS NOT NULL AND locked_at < ?)
         ORDER BY queued_at ASC
         LIMIT 1`,
      )
      .get(staleBefore);

    if (!row) return null;

    database
      .prepare(
        `UPDATE routine_dispatch_jobs
         SET status = 'running',
             attempts = attempts + 1,
             locked_by = ?,
             locked_at = ?,
             started_at = COALESCE(started_at, ?),
             last_error = NULL
         WHERE id = ?`,
      )
      .run(worker, timestamp, timestamp, row.id);

    return database.prepare('SELECT * FROM routine_dispatch_jobs WHERE id = ?').get(row.id);
  });

  return rowToJob(transaction());
};

export const completeRoutineDispatchJob = ({ id, result = null } = {}) => {
  const timestamp = nowIso();
  getDb()
    .prepare(
      `UPDATE routine_dispatch_jobs
       SET status = 'success',
           finished_at = ?,
           locked_by = NULL,
           locked_at = NULL,
           result_json = ?
       WHERE id = ?`,
    )
    .run(timestamp, JSON.stringify(result || {}), String(id || '').trim());
};

export const failRoutineDispatchJob = ({ id, error, result = null } = {}) => {
  const timestamp = nowIso();
  getDb()
    .prepare(
      `UPDATE routine_dispatch_jobs
       SET status = 'error',
           finished_at = ?,
           locked_by = NULL,
           locked_at = NULL,
           last_error = ?,
           result_json = ?
       WHERE id = ?`,
    )
    .run(
      timestamp,
      String(error?.message || error || 'Erro desconhecido.'),
      JSON.stringify(result || null),
      String(id || '').trim(),
    );
};
