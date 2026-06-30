import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const DOCS_DIR = path.join(ROOT_DIR, 'docs');
const LARGE_FILE_THRESHOLD_BYTES = 80 * 1024;

const IGNORED_DIRS = new Set([
  '.git',
  'dist',
  'node_modules',
  'output',
  '.codex-tmp',
]);

const IGNORED_GENERATED_FILES = new Set([
  'docs/performance-audit-before.md',
  'docs/performance-audit-before.json',
  'docs/performance-optimization-report.md',
  'docs/sqlite-audit.md',
  'docs/sqlite-audit.json',
]);

const PRINCIPAL_FILES = [
  'server/local-api.mjs',
  'server/whatsapp-server.js',
  'server/painel-newbr.js',
  'src/App.jsx',
  'src/components/layout/SiteNotificationBridge.jsx',
  'src/pages/Attendance.jsx',
  'src/pages/QueuesServices.jsx',
  'src/lib/labels.js',
  'src/lib/AuthContext.jsx',
];

const HEAVY_IMPORT_NAMES = [
  'playwright',
  'playwright-extra',
  'puppeteer',
  'html2canvas',
  'jspdf',
  'react-quill',
  'three',
  'recharts',
  'leaflet',
  'framer-motion',
  'better-sqlite3',
  'pg',
  'canvas-confetti',
  'ffmpeg-static',
];

const SCAN_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.json',
  '.md',
]);

const toRelative = (filePath) => path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');

const ensureDocsDir = () => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
};

const readTextFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
};

const walkFiles = (dirPath, files = []) => {
  if (!fs.existsSync(dirPath)) return files;

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(fullPath);
  }

  return files;
};

const listScannableFiles = () =>
  walkFiles(ROOT_DIR).filter(
    (filePath) =>
      SCAN_EXTENSIONS.has(path.extname(filePath).toLowerCase()) &&
      !IGNORED_GENERATED_FILES.has(toRelative(filePath)),
  );

const countLines = (content) => (content ? content.split(/\r?\n/).length : 0);

const findOccurrences = (files, pattern, label) =>
  files.flatMap((filePath) => {
    const content = readTextFile(filePath);
    if (!content) return [];
    return content
      .split(/\r?\n/)
      .map((line, index) => ({
        file: toRelative(filePath),
        line: index + 1,
        text: line.trim(),
      }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => ({ ...entry, label }));
  });

const listLargeFiles = () =>
  walkFiles(ROOT_DIR)
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      return {
        file: toRelative(filePath),
        bytes: stat.size,
        kb: Number((stat.size / 1024).toFixed(1)),
      };
    })
    .filter((entry) => entry.bytes >= LARGE_FILE_THRESHOLD_BYTES)
    .filter((entry) => !IGNORED_GENERATED_FILES.has(entry.file))
    .sort((left, right) => right.bytes - left.bytes);

const listPrincipalLineCounts = () =>
  PRINCIPAL_FILES.map((file) => {
    const filePath = path.join(ROOT_DIR, file);
    const content = readTextFile(filePath);
    return {
      file,
      exists: fs.existsSync(filePath),
      lines: countLines(content),
      kb: fs.existsSync(filePath) ? Number((fs.statSync(filePath).size / 1024).toFixed(1)) : 0,
    };
  });

const listHeavyImports = (files) =>
  files.flatMap((filePath) => {
    const content = readTextFile(filePath);
    if (!content) return [];
    return content
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*import\s|require\(/.test(line))
      .flatMap(({ line, index }) =>
        HEAVY_IMPORT_NAMES
          .filter((name) => line.includes(name))
          .map((name) => ({
            file: toRelative(filePath),
            line: index + 1,
            module: name,
            text: line.trim(),
          })),
      );
  });

const listServerModules = () => {
  const modulesDir = path.join(ROOT_DIR, 'server', 'modules');
  if (!fs.existsSync(modulesDir)) return [];
  return walkFiles(modulesDir).map((filePath) => toRelative(filePath)).sort();
};

const extractLocalApiRoutes = () => {
  const filePath = path.join(ROOT_DIR, 'server', 'local-api.mjs');
  const content = readTextFile(filePath);
  const routeSet = new Set();
  const routeRegexes = [
    /url\.pathname\s*===\s*['"`]([^'"`]+)['"`]/g,
    /url\.pathname\.startsWith\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /matchRoute\([^,]+,\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /new URLPattern\(\{\s*pathname:\s*['"`]([^'"`]+)['"`]/g,
  ];

  for (const regex of routeRegexes) {
    let match = regex.exec(content);
    while (match) {
      if (match[1]?.startsWith('/api/local')) {
        routeSet.add(match[1]);
      }
      match = regex.exec(content);
    }
  }

  return Array.from(routeSet).sort();
};

const identifySqliteUsage = (files) => {
  const terms = [
    'better-sqlite3',
    'SQLITE_DB_PATH',
    'SQL_STORE_SQLITE_PATH',
    'SQL_STORE_DRIVER',
    'SQL_STORE_ENABLED',
    'maistv.sqlite',
    'server/sql-store.js',
  ];

  return files.flatMap((filePath) => {
    const content = readTextFile(filePath);
    if (!content) return [];
    return terms
      .filter((term) => content.includes(term))
      .map((term) => ({
        file: toRelative(filePath),
        term,
      }));
  });
};

const auditNewbrReadonly = (files) => {
  const newbrTerms = [
    'painel-newbr',
    'newbr-login-worker',
    'CheckoutRenewalWorkerBridge',
    '/api/local/newbr',
    '/api/local/checkout/renewals',
    '/api/checkout',
    'Mercado Pago',
    'mercadopago',
    'checkout-renewals',
  ];

  const references = files.flatMap((filePath) => {
    const content = readTextFile(filePath);
    if (!content) return [];
    return content
      .split(/\r?\n/)
      .flatMap((line, index) =>
        newbrTerms
          .filter((term) => line.includes(term))
          .map((term) => ({
            file: toRelative(filePath),
            line: index + 1,
            term,
            text: line.trim(),
          })),
      );
  });

  const painelImports = references.filter((entry) => entry.term === 'painel-newbr');
  const routeReferences = references.filter((entry) => entry.text.includes('/api/local/newbr') || entry.text.includes('/api/checkout'));

  return {
    references,
    painelImports,
    routeReferences,
    note: 'Auditoria somente leitura. Nenhum arquivo NewBR, checkout, Mercado Pago ou renovacao foi alterado por este script.',
  };
};

const buildMarkdown = (report) => {
  const bulletList = (items, renderItem, empty = '- Nenhum item encontrado.') =>
    items.length ? items.map((item) => `- ${renderItem(item)}`).join('\n') : empty;

  return `# Auditoria De Performance Antes Das Alteracoes

Gerado em: ${report.generatedAt}

## Resumo
- Arquivos acima de 80 KB: ${report.largeFiles.length}
- Ocorrencias de setInterval: ${report.setIntervalOccurrences.length}
- Ocorrencias de refetchInterval: ${report.refetchIntervalOccurrences.length}
- Ocorrencias de LABEL_REFRESH_INTERVAL_MS: ${report.labelRefreshOccurrences.length}
- Rotas locais identificadas: ${report.localApiRoutes.length}
- Modulos existentes em server/modules: ${report.serverModules.length}

## Arquivos Acima De 80 KB
${bulletList(report.largeFiles, (item) => `${item.file} (${item.kb} KB)`)}

## Linhas Dos Principais Arquivos
${bulletList(report.principalLineCounts, (item) => `${item.file}: ${item.exists ? `${item.lines} linhas (${item.kb} KB)` : 'nao encontrado'}`)}

## Polling E Intervalos

### setInterval
${bulletList(report.setIntervalOccurrences, (item) => `${item.file}:${item.line} - \`${item.text}\``)}

### refetchInterval
${bulletList(report.refetchIntervalOccurrences, (item) => `${item.file}:${item.line} - \`${item.text}\``)}

### LABEL_REFRESH_INTERVAL_MS
${bulletList(report.labelRefreshOccurrences, (item) => `${item.file}:${item.line} - \`${item.text}\``)}

### Polling No Frontend
${bulletList(report.frontendPollingOccurrences, (item) => `${item.file}:${item.line} - \`${item.text}\``)}

## Imports Pesados
${bulletList(report.heavyImports, (item) => `${item.file}:${item.line} - ${item.module} - \`${item.text}\``)}

## Modulos Existentes Em server/modules
${bulletList(report.serverModules, (item) => item)}

## Rotas Identificadas Em server/local-api.mjs
${bulletList(report.localApiRoutes, (item) => `\`${item}\``)}

## Uso De SQLite
${bulletList(report.sqliteUsage, (item) => `${item.file} - ${item.term}`)}

## Auditoria NewBR/Checkout Somente Leitura
${report.newbrReadonlyAudit.note}

### Referencias NewBR/Checkout/Mercado Pago
${bulletList(report.newbrReadonlyAudit.references.slice(0, 120), (item) => `${item.file}:${item.line} - ${item.term} - \`${item.text}\``)}

## Observacoes
- Esta auditoria nao aplica alteracoes destrutivas.
- Esta auditoria nao altera VPS, NewBR, checkout, Mercado Pago ou renovacao automatica.
- SQLite foi apenas identificado por referencias locais e variaveis de ambiente.
`;
};

const main = () => {
  ensureDocsDir();
  const files = listScannableFiles();
  const frontendFiles = files.filter((filePath) => toRelative(filePath).startsWith('src/'));
  const pollingPattern = /setInterval|refetchInterval|poll|EventSource|subscribeLocalRealtimeEvent/;

  const report = {
    generatedAt: new Date().toISOString(),
    rootDir: ROOT_DIR,
    largeFileThresholdBytes: LARGE_FILE_THRESHOLD_BYTES,
    largeFiles: listLargeFiles(),
    principalLineCounts: listPrincipalLineCounts(),
    setIntervalOccurrences: findOccurrences(files, /setInterval/, 'setInterval'),
    refetchIntervalOccurrences: findOccurrences(files, /refetchInterval/, 'refetchInterval'),
    labelRefreshOccurrences: findOccurrences(files, /LABEL_REFRESH_INTERVAL_MS/, 'LABEL_REFRESH_INTERVAL_MS'),
    frontendPollingOccurrences: findOccurrences(frontendFiles, pollingPattern, 'frontend-polling'),
    heavyImports: listHeavyImports(files),
    serverModules: listServerModules(),
    localApiRoutes: extractLocalApiRoutes(),
    sqliteUsage: identifySqliteUsage(files),
    newbrReadonlyAudit: auditNewbrReadonly(files),
  };

  fs.writeFileSync(path.join(DOCS_DIR, 'performance-audit-before.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(DOCS_DIR, 'performance-audit-before.md'), buildMarkdown(report));

  console.log(`Auditoria gerada: docs/performance-audit-before.md`);
  console.log(`Auditoria JSON gerada: docs/performance-audit-before.json`);
  console.log(`Arquivos >80KB: ${report.largeFiles.length}`);
  console.log(`Rotas locais identificadas: ${report.localApiRoutes.length}`);
};

main();
