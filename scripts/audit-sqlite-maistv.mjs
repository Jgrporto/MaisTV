import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT_DIR = process.cwd();
const DOCS_DIR = path.join(ROOT_DIR, 'docs');

const resolveSqlitePath = () => {
  const configured = String(process.env.SQLITE_DB_PATH || process.env.SQL_STORE_SQLITE_PATH || '').trim();
  if (configured) return path.resolve(ROOT_DIR, configured);
  return path.join(ROOT_DIR, 'server', 'data', 'maistv.sqlite');
};

const getFileSize = (filePath) => (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);

const main = () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const sqlitePath = resolveSqlitePath();
  const report = {
    generatedAt: new Date().toISOString(),
    sqlitePath,
    exists: fs.existsSync(sqlitePath),
    fileSizeBytes: getFileSize(sqlitePath),
    walExists: fs.existsSync(`${sqlitePath}-wal`),
    shmExists: fs.existsSync(`${sqlitePath}-shm`),
    journalMode: null,
    busyTimeout: null,
    tables: [],
    indexes: [],
    tableCounts: {},
    skipped: [],
  };

  if (report.exists) {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      report.journalMode = db.pragma('journal_mode', { simple: true });
      report.busyTimeout = db.pragma('busy_timeout', { simple: true });
      report.tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => row.name);
      report.indexes = db
        .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name, name")
        .all();
      report.tableCounts = Object.fromEntries(
        report.tables.map((table) => {
          try {
            const count = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count;
            return [table, count];
          } catch (error) {
            return [table, `erro: ${error?.message || error}`];
          }
        }),
      );
    } finally {
      db.close();
    }
  } else {
    report.skipped.push('Banco SQLite nao encontrado no caminho resolvido.');
  }

  const markdown = `# Auditoria SQLite MaisTV

Gerado em: ${report.generatedAt}

## Banco
- Caminho: \`${report.sqlitePath}\`
- Existe: ${report.exists ? 'sim' : 'nao'}
- Tamanho: ${report.fileSizeBytes} bytes
- WAL: ${report.walExists ? 'sim' : 'nao'}
- SHM: ${report.shmExists ? 'sim' : 'nao'}
- journal_mode: ${report.journalMode ?? '-'}
- busy_timeout: ${report.busyTimeout ?? '-'}

## Tabelas
${report.tables.length ? report.tables.map((table) => `- ${table}: ${report.tableCounts[table]}`).join('\n') : '- Nenhuma tabela listada.'}

## Indices
${report.indexes.length ? report.indexes.map((index) => `- ${index.name} em ${index.tbl_name}`).join('\n') : '- Nenhum indice listado.'}

## Observacoes
${report.skipped.length ? report.skipped.map((item) => `- ${item}`).join('\n') : '- Auditoria concluida sem alteracoes.'}
`;

  fs.writeFileSync(path.join(DOCS_DIR, 'sqlite-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(DOCS_DIR, 'sqlite-audit.md'), markdown);

  console.log(`SQLite audit: ${report.exists ? 'ok' : 'banco nao encontrado'}`);
  console.log(`Relatorios: docs/sqlite-audit.md, docs/sqlite-audit.json`);
};

main();
