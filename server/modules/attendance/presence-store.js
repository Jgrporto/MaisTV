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

const normalizePresenceRow = (row = {}) => ({
  user_id: String(row.user_id || "").trim(),
  user_name: String(row.user_name || "").trim(),
  role: String(row.role || "").trim(),
  status: String(row.status || "attending").trim() || "attending",
  paused_until: String(row.paused_until || "").trim(),
  pause_reason: String(row.pause_reason || "").trim(),
  pause_reason_label: String(row.pause_reason_label || "").trim(),
  last_seen_at: String(row.last_seen_at || row.updated_at || "").trim(),
  updated_at: String(row.updated_at || row.last_seen_at || "").trim(),
});

const normalizePresenceInput = (presence = {}) => normalizePresenceRow({
  user_id: presence.user_id || presence.userId,
  user_name: presence.user_name || presence.userName,
  role: presence.role,
  status: presence.status,
  paused_until: presence.paused_until || presence.pausedUntil,
  pause_reason: presence.pause_reason || presence.pauseReason,
  pause_reason_label: presence.pause_reason_label || presence.pauseReasonLabel,
  last_seen_at: presence.last_seen_at || presence.lastSeenAt,
  updated_at: presence.updated_at || presence.updatedAt,
});

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
    CREATE TABLE IF NOT EXISTS attendance_presence (
      user_id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'attending',
      paused_until TEXT NOT NULL DEFAULT '',
      pause_reason TEXT NOT NULL DEFAULT '',
      pause_reason_label TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attendance_presence_status_idx
      ON attendance_presence (status);
    CREATE INDEX IF NOT EXISTS attendance_presence_paused_until_idx
      ON attendance_presence (paused_until);
  `);
  initialized = true;
  return database;
};

export const isSqlAttendancePresenceStoreEnabled = () => Boolean(sqlitePath);

export const listSqlAttendancePresence = () => {
  const database = ensureInitialized();
  if (!database) return [];
  return database
    .prepare(
      `SELECT user_id, user_name, role, status, paused_until, pause_reason, pause_reason_label, last_seen_at, updated_at
       FROM attendance_presence
       ORDER BY updated_at DESC`,
    )
    .all()
    .map(normalizePresenceRow)
    .filter((presence) => presence.user_id && presence.last_seen_at);
};

export const getSqlAttendancePresenceByUserId = (userId) => {
  const safeUserId = String(userId || "").trim();
  const database = ensureInitialized();
  if (!database || !safeUserId) return null;
  const row = database
    .prepare(
      `SELECT user_id, user_name, role, status, paused_until, pause_reason, pause_reason_label, last_seen_at, updated_at
       FROM attendance_presence
       WHERE user_id = ?`,
    )
    .get(safeUserId);
  return row ? normalizePresenceRow(row) : null;
};

export const upsertSqlAttendancePresence = (presence) => {
  const record = normalizePresenceInput(presence);
  const database = ensureInitialized();
  if (!database || !record.user_id || !record.last_seen_at) return false;

  database
    .prepare(
      `INSERT INTO attendance_presence (
         user_id, user_name, role, status, paused_until, pause_reason, pause_reason_label, last_seen_at, updated_at
       ) VALUES (
         @user_id, @user_name, @role, @status, @paused_until, @pause_reason, @pause_reason_label, @last_seen_at, @updated_at
       )
       ON CONFLICT(user_id) DO UPDATE SET
         user_name = excluded.user_name,
         role = excluded.role,
         status = excluded.status,
         paused_until = excluded.paused_until,
         pause_reason = excluded.pause_reason,
         pause_reason_label = excluded.pause_reason_label,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
    )
    .run(record);
  return true;
};

export const deleteSqlAttendancePresenceByUserId = (userId) => {
  const safeUserId = String(userId || "").trim();
  const database = ensureInitialized();
  if (!database || !safeUserId) return 0;
  return database.prepare("DELETE FROM attendance_presence WHERE user_id = ?").run(safeUserId).changes || 0;
};
