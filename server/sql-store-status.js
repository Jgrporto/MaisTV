import "dotenv/config";
import { Pool } from "pg";
import Database from "better-sqlite3";
import { getSqlStoreConfig, listMappedStoreKeys } from "./sql-store.js";

const sanitizeIdentifier = (value, fallback) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (!/^[a-z_][a-z0-9_]*$/.test(normalized)) return fallback;
  return normalized;
};

const renderBytes = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0 B";
  if (numeric < 1024) return `${numeric} B`;
  if (numeric < 1024 * 1024) return `${(numeric / 1024).toFixed(1)} KB`;
  return `${(numeric / (1024 * 1024)).toFixed(2)} MB`;
};

const config = getSqlStoreConfig();

if (!config.enabled) {
  console.error("[sql-status] SQL store desabilitado (SQL_STORE_ENABLED=false).");
  process.exit(1);
}

const printRows = ({ rows, mappedKeys, extraRows }) => {
  console.log("[sql-status] configuracao:");
  console.log(
    JSON.stringify(
      {
        enabled: config.enabled,
        strict: config.strict,
        dualWriteJson: config.dualWriteJson,
        driver: config.driver,
        sqlitePath: config.sqlitePath,
        schema: config.schema,
        table: config.table,
        mappedKeys: mappedKeys.length,
        rows: rows.length,
      },
      null,
      2,
    ),
  );

  const byKey = new Map(rows.map((row) => [String(row.store_key), row]));
  console.log("\n[sql-status] stores mapeados:");
  for (const key of mappedKeys) {
    const row = byKey.get(key);
    if (!row) {
      console.log(`- ${key}: MISSING`);
      continue;
    }
    console.log(`- ${key}: OK | updated_at=${row.updated_at} | size=${renderBytes(row.bytes)}`);
  }

  if (extraRows.length) {
    console.log("\n[sql-status] chaves extras (nao mapeadas):");
    for (const row of extraRows) {
      console.log(`- ${row.store_key}: updated_at=${row.updated_at} | size=${renderBytes(row.bytes)}`);
    }
  }
};

const runSqlite = async () => {
  if (!config.sqlitePath) {
    throw new Error("SQLITE_DB_PATH/SQL_STORE_SQLITE_PATH nao configurado.");
  }
  const table = sanitizeIdentifier(config.table, "tvassist_json_store");
  const db = new Database(config.sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `
          SELECT store_key, updated_at, length(payload) AS bytes
          FROM ${table}
          ORDER BY updated_at DESC
        `,
      )
      .all();
    const mappedKeys = listMappedStoreKeys().slice().sort();
    const mappedSet = new Set(mappedKeys);
    printRows({
      rows,
      mappedKeys,
      extraRows: rows.filter((row) => !mappedSet.has(String(row.store_key))),
    });
  } finally {
    db.close();
  }
};

const runPostgres = async () => {
  const connectionString = String(
    process.env.SQL_STORE_DATABASE_URL || process.env.DATABASE_URL || "",
  ).trim();
  if (!connectionString) {
    throw new Error("SQL_STORE_DATABASE_URL/DATABASE_URL nao configurada.");
  }
  const schema = sanitizeIdentifier(config.schema, "public");
  const table = sanitizeIdentifier(config.table, "tvassist_json_store");
  const tableRef = `"${schema}"."${table}"`;
  const pool = new Pool({
    connectionString,
    max: 2,
    ssl: String(process.env.SQL_STORE_SSL || "").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : false,
  });

  const client = await pool.connect();
  try {
    const existsResult = await client.query("SELECT to_regclass($1) AS table_name", [`${schema}.${table}`]);
    if (!existsResult.rows?.[0]?.table_name) {
      console.log(`[sql-status] tabela ausente: ${schema}.${table}`);
      process.exitCode = 2;
      return;
    }
    const rowsResult = await client.query(
      `
        SELECT store_key, updated_at, octet_length(payload::text) AS bytes
        FROM ${tableRef}
        ORDER BY updated_at DESC
      `,
    );
    const rows = (rowsResult.rows || []).map((row) => ({
      ...row,
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    }));
    const mappedKeys = listMappedStoreKeys().slice().sort();
    const mappedSet = new Set(mappedKeys);
    printRows({
      rows,
      mappedKeys,
      extraRows: rows.filter((row) => !mappedSet.has(String(row.store_key))),
    });
  } finally {
    client.release();
    await pool.end();
  }
};

(config.driver === "sqlite" ? runSqlite() : runPostgres()).catch((error) => {
  console.error("[sql-status] erro:", error?.message || error);
  process.exit(1);
});
