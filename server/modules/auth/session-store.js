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

const normalizeSessionRow = (row = {}) => ({
  id: String(row.id || "").trim(),
  user_id: String(row.user_id || "").trim(),
  token_hash: String(row.token_hash || "").trim(),
  remember: Boolean(row.remember),
  created_at: String(row.created_at || "").trim(),
  last_seen_at: String(row.last_seen_at || row.created_at || "").trim(),
  expires_at: String(row.expires_at || "").trim(),
  ip: String(row.ip || "").trim(),
  user_agent: String(row.user_agent || "").trim(),
});

const normalizeSessionInput = (session = {}) => normalizeSessionRow({
  id: session.id,
  user_id: session.user_id || session.userId,
  token_hash: session.token_hash || session.tokenHash,
  remember: session.remember ? 1 : 0,
  created_at: session.created_at || session.createdAt,
  last_seen_at: session.last_seen_at || session.lastSeenAt || session.created_at || session.createdAt,
  expires_at: session.expires_at || session.expiresAt,
  ip: session.ip,
  user_agent: session.user_agent || session.userAgent,
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
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      remember INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
      ON auth_sessions (user_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
      ON auth_sessions (expires_at);
  `);
  initialized = true;
  return database;
};

export const isSqlAuthSessionStoreEnabled = () => Boolean(sqlitePath);

export const pruneExpiredSqlAuthSessions = (referenceIso = new Date().toISOString()) => {
  const database = ensureInitialized();
  if (!database) return 0;
  return database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(referenceIso).changes || 0;
};

export const listSqlAuthSessions = () => {
  const database = ensureInitialized();
  if (!database) return [];
  pruneExpiredSqlAuthSessions();
  return database
    .prepare(
      `SELECT id, user_id, token_hash, remember, created_at, last_seen_at, expires_at, ip, user_agent
       FROM auth_sessions
       ORDER BY created_at ASC`,
    )
    .all()
    .map(normalizeSessionRow)
    .filter((session) => session.id && session.user_id && session.token_hash && session.expires_at);
};

export const getSqlAuthSessionByTokenHash = (tokenHash) => {
  const safeTokenHash = String(tokenHash || "").trim();
  const database = ensureInitialized();
  if (!database || !safeTokenHash) return null;
  pruneExpiredSqlAuthSessions();
  const row = database
    .prepare(
      `SELECT id, user_id, token_hash, remember, created_at, last_seen_at, expires_at, ip, user_agent
       FROM auth_sessions
       WHERE token_hash = ?`,
    )
    .get(safeTokenHash);
  return row ? normalizeSessionRow(row) : null;
};

export const upsertSqlAuthSession = (session) => {
  const record = normalizeSessionInput(session);
  const database = ensureInitialized();
  if (!database || !record.id || !record.user_id || !record.token_hash || !record.expires_at) return false;

  database
    .prepare(
      `INSERT INTO auth_sessions (
         id, user_id, token_hash, remember, created_at, last_seen_at, expires_at, ip, user_agent
       ) VALUES (
         @id, @user_id, @token_hash, @remember, @created_at, @last_seen_at, @expires_at, @ip, @user_agent
       )
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         token_hash = excluded.token_hash,
         remember = excluded.remember,
         created_at = excluded.created_at,
         last_seen_at = excluded.last_seen_at,
         expires_at = excluded.expires_at,
         ip = excluded.ip,
         user_agent = excluded.user_agent`,
    )
    .run({
      ...record,
      remember: record.remember ? 1 : 0,
    });
  return true;
};

export const deleteSqlAuthSessionByTokenHash = (tokenHash) => {
  const safeTokenHash = String(tokenHash || "").trim();
  const database = ensureInitialized();
  if (!database || !safeTokenHash) return 0;
  return database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(safeTokenHash).changes || 0;
};

export const deleteSqlAuthSessionsByUserId = (userId) => {
  const safeUserId = String(userId || "").trim();
  const database = ensureInitialized();
  if (!database || !safeUserId) return 0;
  return database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(safeUserId).changes || 0;
};

export const updateSqlAuthSessionLastSeen = (sessionId, lastSeenAt = new Date().toISOString()) => {
  const safeSessionId = String(sessionId || "").trim();
  const safeLastSeenAt = String(lastSeenAt || "").trim();
  const database = ensureInitialized();
  if (!database || !safeSessionId || !safeLastSeenAt) return 0;
  return database
    .prepare(
      `UPDATE auth_sessions
       SET last_seen_at = ?
       WHERE id = ?
         AND (
           last_seen_at IS NULL
           OR last_seen_at = ''
           OR strftime('%s', ?) - strftime('%s', last_seen_at) >= 300
         )`,
    )
    .run(safeLastSeenAt, safeSessionId, safeLastSeenAt).changes || 0;
};
