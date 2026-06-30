import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT_DIR = process.cwd();
const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');
const dryRun = args.has('--dry-run') || !shouldApply;

const resolveSqlitePath = () => {
  const configured = String(process.env.SQLITE_DB_PATH || process.env.SQL_STORE_SQLITE_PATH || '').trim();
  if (configured) return path.resolve(ROOT_DIR, configured);
  return path.join(ROOT_DIR, 'server', 'data', 'maistv.sqlite');
};

const candidateIndexes = [
  { table: 'auth_sessions', columns: ['user_id'] },
  { table: 'auth_sessions', columns: ['token_hash'] },
  { table: 'auth_sessions', columns: ['expires_at'] },
  { table: 'attendance_presence', columns: ['status'] },
  { table: 'attendance_presence', columns: ['updated_at'] },
  { table: 'attendance_presence', columns: ['paused_until'] },
  { table: 'tvassist_json_store', columns: ['updated_at'] },
  { table: 'conversations', columns: ['updated_at'] },
  { table: 'conversations', columns: ['assigned_agent_id'] },
  { table: 'conversations', columns: ['phone'] },
  { table: 'messages', columns: ['conversation_id'] },
  { table: 'messages', columns: ['phone'] },
  { table: 'messages', columns: ['timestamp_ms'] },
];

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const buildIndexName = (table, columns) => `idx_${table}_${columns.join('_')}`;

const main = () => {
  const sqlitePath = resolveSqlitePath();
  const report = {
    generatedAt: new Date().toISOString(),
    sqlitePath,
    mode: dryRun ? 'dry-run' : 'apply',
    applied: [],
    planned: [],
    skipped: [],
  };

  if (!fs.existsSync(sqlitePath)) {
    report.skipped.push({ reason: 'sqlite_not_found', sqlitePath });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const db = new Database(sqlitePath);
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => row.name),
    );

    for (const candidate of candidateIndexes) {
      if (!tables.has(candidate.table)) {
        report.skipped.push({ table: candidate.table, columns: candidate.columns, reason: 'table_not_found' });
        continue;
      }

      const tableColumns = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(candidate.table)})`).all().map((row) => row.name));
      const missingColumn = candidate.columns.find((column) => !tableColumns.has(column));
      if (missingColumn) {
        report.skipped.push({
          table: candidate.table,
          columns: candidate.columns,
          reason: `column_not_found:${missingColumn}`,
        });
        continue;
      }

      const indexName = buildIndexName(candidate.table, candidate.columns);
      const sql = `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(candidate.table)} (${candidate.columns.map(quoteIdentifier).join(', ')})`;
      report.planned.push({ table: candidate.table, columns: candidate.columns, indexName, sql });

      if (shouldApply) {
        db.exec(sql);
        report.applied.push({ table: candidate.table, columns: candidate.columns, indexName });
      }
    }
  } finally {
    db.close();
  }

  console.log(JSON.stringify(report, null, 2));
};

main();
