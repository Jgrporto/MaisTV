import "dotenv/config";
import { Pool } from "pg";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const parseBooleanEnv = (value, defaultValue = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

const connectionString =
  String(process.env.SQL_STORE_DATABASE_URL || process.env.DATABASE_URL || "").trim();
const sqlitePath = String(
  process.env.SQLITE_DB_PATH || process.env.SQL_STORE_SQLITE_PATH || "",
).trim();
const sqlDriver = String(process.env.SQL_STORE_DRIVER || "").trim().toLowerCase();
const useSqlite = sqlDriver === "sqlite" || Boolean(sqlitePath);

const hasExplicitSqlStoreEnabled = String(process.env.SQL_STORE_ENABLED ?? "").trim() !== "";
const SQL_STORE_ENABLED = hasExplicitSqlStoreEnabled
  ? parseBooleanEnv(process.env.SQL_STORE_ENABLED)
  : Boolean(connectionString || sqlitePath);

const SQL_STORE_DUAL_WRITE_JSON =
  parseBooleanEnv(process.env.SQL_STORE_DUAL_WRITE_JSON);
const SQL_STORE_REQUIRE = parseBooleanEnv(process.env.SQL_STORE_REQUIRE);
const SQL_STORE_CACHE_TTL_MS = Number.parseInt(process.env.SQL_STORE_CACHE_TTL_MS || "1200", 10);
const SQL_STORE_CACHE_DISABLED_KEYS = new Set(
  String(process.env.SQL_STORE_CACHE_DISABLED_KEYS || "whatsapp_store")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

const SQL_STORE_MAX_POOL = Number.parseInt(process.env.SQL_STORE_MAX_POOL || "10", 10);
const SQL_STORE_SSL = parseBooleanEnv(process.env.SQL_STORE_SSL);

const sanitizeIdentifier = (value, fallback) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (!/^[a-z_][a-z0-9_]*$/.test(normalized)) return fallback;
  return normalized;
};

const sqlSchema = sanitizeIdentifier(process.env.SQL_STORE_SCHEMA, "public");
const sqlTable = sanitizeIdentifier(process.env.SQL_STORE_TABLE, "tvassist_json_store");
const tableRef = `"${sqlSchema}"."${sqlTable}"`;
const sqliteTable = sanitizeIdentifier(process.env.SQL_STORE_TABLE, "tvassist_json_store");

const FILE_BASENAME_TO_KEY = Object.freeze({
  "store.json": "main_store",
  "whatsapp-store.json": "whatsapp_store",
  "whatsapp-coexistencia.json": "whatsapp_coexistence",
  "painel-customers.json": "painel_customers",
  "painel-sync.json": "painel_sync",
  "message-delivery-log.json": "message_delivery_log",
  "quick-replies.json": "quick_replies",
  "whatsapp-local-templates.json": "whatsapp_local_templates",
  "routines.json": "routines",
  "routine-logs.json": "routine_logs",
  "ui-preferences.json": "ui_preferences",
  "painel-agent-jobs.json": "painel_agent_jobs",
  "painel-newbr.json": "painel_newbr_storage",
});

let pool = null;
let sqliteDb = null;
let initPromise = null;
const sqlStoreCache = new Map();

const clonePayload = (payload) => {
  if (payload == null || typeof payload !== "object") return payload;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(payload);
    } catch {
      // fallback below
    }
  }
  return JSON.parse(JSON.stringify(payload));
};

const normalizeCacheTtl = () =>
  Number.isFinite(SQL_STORE_CACHE_TTL_MS) && SQL_STORE_CACHE_TTL_MS > 0
    ? SQL_STORE_CACHE_TTL_MS
    : 0;

const readFromMemoryCache = (storeKey) => {
  const ttl = normalizeCacheTtl();
  if (SQL_STORE_CACHE_DISABLED_KEYS.has(String(storeKey || ""))) return null;
  if (ttl <= 0) return null;
  const cached = sqlStoreCache.get(storeKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > ttl) {
    sqlStoreCache.delete(storeKey);
    return null;
  }
  return {
    found: Boolean(cached.found),
    payload: clonePayload(cached.payload ?? null),
  };
};

const writeToMemoryCache = (storeKey, found, payload) => {
  const ttl = normalizeCacheTtl();
  if (SQL_STORE_CACHE_DISABLED_KEYS.has(String(storeKey || ""))) {
    sqlStoreCache.delete(storeKey);
    return;
  }
  if (ttl <= 0) return;
  sqlStoreCache.set(storeKey, {
    found: Boolean(found),
    payload: clonePayload(payload ?? null),
    cachedAt: Date.now(),
  });
};

const createPool = () => {
  if (!SQL_STORE_ENABLED || useSqlite) return null;
  if (pool) return pool;
  pool = new Pool({
    connectionString,
    max: Number.isFinite(SQL_STORE_MAX_POOL) && SQL_STORE_MAX_POOL > 0 ? SQL_STORE_MAX_POOL : 10,
    ssl: SQL_STORE_SSL ? { rejectUnauthorized: false } : false,
  });
  pool.on("error", (error) => {
    console.error("[sql-store] pool error:", error?.message || error);
  });
  return pool;
};

const createSqliteDb = () => {
  if (!SQL_STORE_ENABLED || !useSqlite) return null;
  if (!sqlitePath) {
    throw new Error("SQLITE_DB_PATH or SQL_STORE_SQLITE_PATH is required for sqlite store");
  }
  if (sqliteDb) return sqliteDb;
  const resolvedPath = path.resolve(process.cwd(), sqlitePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  sqliteDb = new Database(resolvedPath);
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.pragma("foreign_keys = ON");
  sqliteDb.pragma("busy_timeout = 5000");
  return sqliteDb;
};

const ensureInitialized = async () => {
  if (!SQL_STORE_ENABLED) return false;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (useSqlite) {
      const db = createSqliteDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS ${sqliteTable} (
          store_key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS ${sqliteTable}_updated_at_idx
          ON ${sqliteTable} (updated_at DESC);
      `);
      return true;
    }

    const client = await createPool().connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${sqlSchema}"`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${tableRef} (
          store_key TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${sqlTable}_updated_at_idx
        ON ${tableRef} (updated_at DESC)
      `);
      return true;
    } finally {
      client.release();
    }
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
};

export const isSqlStoreEnabled = () => SQL_STORE_ENABLED;

export const isSqlStoreDualWriteEnabled = () => SQL_STORE_DUAL_WRITE_JSON;
export const isSqlStoreStrictMode = () => SQL_STORE_REQUIRE;
export const getSqlStoreConfig = () => ({
  enabled: SQL_STORE_ENABLED,
  strict: SQL_STORE_REQUIRE,
  dualWriteJson: SQL_STORE_DUAL_WRITE_JSON,
  driver: useSqlite ? "sqlite" : "postgres",
  sqlitePath: useSqlite ? sqlitePath : "",
  schema: sqlSchema,
  table: sqlTable,
  cacheTtlMs: normalizeCacheTtl(),
  cacheDisabledKeys: Array.from(SQL_STORE_CACHE_DISABLED_KEYS),
});
export const clearSqlStoreCache = (storeKey = null) => {
  if (!storeKey) {
    sqlStoreCache.clear();
    return;
  }
  sqlStoreCache.delete(String(storeKey));
};

export const resolveStoreKeyByPath = (filePath) => {
  const basename = path.basename(String(filePath || "").trim()).toLowerCase();
  if (!basename) return null;
  return FILE_BASENAME_TO_KEY[basename] || null;
};

export const upsertSqlStoreValue = async (storeKey, payload) => {
  if (!SQL_STORE_ENABLED) return false;
  if (!storeKey) return false;
  await ensureInitialized();
  if (useSqlite) {
    createSqliteDb()
      .prepare(
        `
          INSERT INTO ${sqliteTable} (store_key, payload, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(store_key)
          DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')
        `,
      )
      .run(String(storeKey), JSON.stringify(payload ?? {}));
    writeToMemoryCache(storeKey, true, payload ?? {});
    return true;
  }
  await createPool().query(
    `
      INSERT INTO ${tableRef} (store_key, payload, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (store_key)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
    `,
    [storeKey, JSON.stringify(payload ?? {})],
  );
  writeToMemoryCache(storeKey, true, payload ?? {});
  return true;
};

export const readSqlStoreValue = async (storeKey) => {
  if (!SQL_STORE_ENABLED) return { found: false, payload: null };
  if (!storeKey) return { found: false, payload: null };

  const cached = readFromMemoryCache(storeKey);
  if (cached) {
    return cached;
  }

  await ensureInitialized();
  if (useSqlite) {
    const row = createSqliteDb()
      .prepare(`SELECT payload FROM ${sqliteTable} WHERE store_key = ? LIMIT 1`)
      .get(String(storeKey));
    if (!row) {
      writeToMemoryCache(storeKey, false, null);
      return { found: false, payload: null };
    }
    const payload = JSON.parse(row.payload);
    writeToMemoryCache(storeKey, true, payload);
    return { found: true, payload };
  }
  const { rows } = await createPool().query(
    `SELECT payload FROM ${tableRef} WHERE store_key = $1 LIMIT 1`,
    [storeKey],
  );
  if (!rows.length) {
    writeToMemoryCache(storeKey, false, null);
    return { found: false, payload: null };
  }
  const payload = rows[0]?.payload ?? null;
  writeToMemoryCache(storeKey, true, payload);
  return { found: true, payload };
};

export const listMappedStoreKeys = () => Object.values(FILE_BASENAME_TO_KEY);

export const readJsonBackedStore = async (filePath, fallback, readFromJsonFile) => {
  const storeKey = resolveStoreKeyByPath(filePath);
  if (!storeKey) {
    return readFromJsonFile();
  }
  if (!SQL_STORE_ENABLED) {
    if (SQL_STORE_REQUIRE) {
      throw new Error(`[sql-store] required store '${storeKey}' but SQL is disabled`);
    }
    return readFromJsonFile();
  }
  try {
    const result = await readSqlStoreValue(storeKey);
    if (result.found && result.payload && typeof result.payload === "object") {
      return result.payload;
    }
    const seeded = await readFromJsonFile();
    if (seeded && typeof seeded === "object") {
      await upsertSqlStoreValue(storeKey, seeded);
    }
    return seeded;
  } catch (error) {
    console.error(`[sql-store] read fallback for ${storeKey}:`, error?.message || error);
    if (SQL_STORE_REQUIRE) {
      throw error;
    }
    return readFromJsonFile();
  }
};

export const writeJsonBackedStore = async (filePath, payload, writeToJsonFile) => {
  const storeKey = resolveStoreKeyByPath(filePath);
  if (!storeKey) {
    await writeToJsonFile();
    return;
  }
  if (!SQL_STORE_ENABLED) {
    if (SQL_STORE_REQUIRE) {
      throw new Error(`[sql-store] required store '${storeKey}' but SQL is disabled`);
    }
    await writeToJsonFile();
    return;
  }

  let wroteSql = false;
  try {
    await upsertSqlStoreValue(storeKey, payload);
    wroteSql = true;
  } catch (error) {
    console.error(`[sql-store] write fallback for ${storeKey}:`, error?.message || error);
  }

  if (SQL_STORE_DUAL_WRITE_JSON || !wroteSql) {
    if (SQL_STORE_REQUIRE && !wroteSql) {
      throw new Error(`[sql-store] strict mode blocked JSON fallback for '${storeKey}'`);
    }
    await writeToJsonFile();
  }
};
