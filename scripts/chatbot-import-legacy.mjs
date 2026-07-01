import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePostgres } from '../server/db/postgres.mjs';
import { readJsonBackedStore } from '../server/sql-store.js';
import {
  buildLegacyImportPlan,
  importLegacyChatbotFlows,
} from '../server/services/chatbot-flow.service.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STORE_PATH = path.join(ROOT_DIR, 'server', 'data', 'store.json');

const parseArgs = (argv) => {
  const args = {
    tenant: process.env.CHATBOT_TENANT_ID || 'maistv',
    route: '',
    store: '',
    source: 'store.json',
    confirm: false,
    publish: false,
    activate: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--confirm') {
      args.confirm = true;
      continue;
    }
    if (item === '--dry-run') {
      args.confirm = false;
      continue;
    }
    if (item === '--publish') {
      args.publish = true;
      continue;
    }
    if (item === '--activate') {
      args.activate = true;
      continue;
    }
    if (item === '--json') {
      args.json = true;
      continue;
    }
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : '';
    if (key === 'tenant') args.tenant = value || args.tenant;
    if (key === 'route') args.route = value || args.route;
    if (key === 'store') args.store = value;
    if (key === 'source') args.source = value || args.source;
  }

  return args;
};

const loadLegacyStore = async (storePathArg) => {
  const resolvedPath = path.resolve(ROOT_DIR, storePathArg || process.env.LEGACY_MAIN_STORE_JSON_PATH || DEFAULT_STORE_PATH);
  const readJson = async () => {
    try {
      const raw = await fs.readFile(resolvedPath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  };
  const store = await readJsonBackedStore(resolvedPath, {}, readJson);
  return {
    store: store && typeof store === 'object' ? store : {},
    storePath: resolvedPath,
  };
};

const buildOfflineReport = ({ args, storePath, legacyFlows }) => {
  const plan = buildLegacyImportPlan({
    legacyFlows,
    source: args.source,
  });
  return {
    source: args.source,
    storePath,
    tenantId: args.tenant,
    routeKey: args.route || null,
    mode: 'dry-run',
    foundFlows: plan.foundFlows,
    validFlows: plan.validFlows,
    invalidFlows: plan.invalidFlows,
    wouldInsertFlows: plan.validFlows,
    wouldInsertVersions: plan.validFlows,
    wouldSkipDuplicates: 0,
    duplicateCheck: 'skipped',
    errors: plan.items
      .filter((item) => !item.validation.valid)
      .map((item) => ({
        legacyId: item.legacyId,
        name: item.name,
        errors: item.validation.errors,
      })),
    items: plan.items.map((item) => ({
      legacyId: item.legacyId,
      name: item.name,
      status: item.validation.valid ? 'would_insert' : 'invalid',
      checksum: item.checksum,
      triggerConfig: item.triggerConfig,
      errors: item.validation.errors,
    })),
  };
};

const formatMarkdown = (report) => {
  const lines = [];
  lines.push('# Importacao legacy do chatbot');
  lines.push('');
  lines.push(`- Fonte: \`${report.source}\``);
  lines.push(`- Store: \`${report.storePath || '-'}\``);
  lines.push(`- Tenant: \`${report.tenantId}\``);
  lines.push(`- Rota atribuida: \`${report.routeKey || 'null'}\``);
  lines.push(`- Modo: \`${report.mode}\``);
  lines.push('');
  lines.push('## Resumo');
  lines.push(`- foundFlows: ${report.foundFlows}`);
  lines.push(`- validFlows: ${report.validFlows}`);
  lines.push(`- invalidFlows: ${report.invalidFlows}`);
  lines.push(`- wouldInsertFlows: ${report.wouldInsertFlows}`);
  lines.push(`- wouldInsertVersions: ${report.wouldInsertVersions}`);
  lines.push(`- wouldSkipDuplicates: ${report.wouldSkipDuplicates}`);
  lines.push(`- insertedFlows: ${report.insertedFlows || 0}`);
  lines.push(`- insertedVersions: ${report.insertedVersions || 0}`);
  lines.push('');
  if (report.errors?.length) {
    lines.push('## Erros');
    report.errors.forEach((error) => {
      lines.push(`- ${error.name || error.legacyId}: ${(error.errors || []).join('; ')}`);
    });
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const { store, storePath } = await loadLegacyStore(args.store);
  const legacyFlows = Array.isArray(store.chatbotFlows) ? store.chatbotFlows : [];
  let report;

  if (!args.confirm) {
    try {
      report = await importLegacyChatbotFlows({
        tenantId: args.tenant,
        routeKey: args.route || null,
        legacyFlows,
        source: args.source,
        confirm: false,
        publish: args.publish,
        activate: args.activate,
      });
      report.storePath = storePath;
    } catch (error) {
      report = buildOfflineReport({ args, storePath, legacyFlows });
      report.duplicateCheck = 'skipped_postgres_unavailable';
      report.postgresError = error?.message || 'PostgreSQL unavailable';
    }
  } else {
    report = await importLegacyChatbotFlows({
      tenantId: args.tenant,
      routeKey: args.route || null,
      legacyFlows,
      source: args.source,
      confirm: true,
      publish: args.publish,
      activate: args.activate,
    });
    report.storePath = storePath;
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
};

main()
  .catch((error) => {
    console.error('[chatbot:import-legacy] erro:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres().catch(() => {});
  });
