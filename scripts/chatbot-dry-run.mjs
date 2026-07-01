import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePostgres } from '../server/db/postgres.mjs';
import { readJsonBackedStore } from '../server/sql-store.js';
import {
  buildDryRunConversation,
  buildChatbotDefinition,
  extractTriggerConfig,
  findMatchingChatbotFlow,
  normalizeLegacyChatbotFlows,
  simulateChatbotFlow,
} from '../server/services/chatbot-engine.service.mjs';
import {
  listPostgresChatbotFlows,
  runPostgresChatbotDryRun,
} from '../server/services/chatbot-flow.service.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STORE_PATH = path.join(ROOT_DIR, 'server', 'data', 'store.json');
const DEFAULT_SCENARIOS = [
  { name: 'primeira_mensagem_oi', text: 'oi', type: 'text' },
  { name: 'lead_quer_contratar', text: 'quero contratar', type: 'text' },
  { name: 'cliente_pede_suporte', text: 'suporte', type: 'text' },
  { name: 'cliente_pede_humano', text: 'falar com atendente', type: 'text' },
  { name: 'fora_do_fluxo', text: 'xyz sem fluxo', type: 'text' },
  { name: 'audio', text: '[audio]', type: 'audio' },
  { name: 'imagem', text: '[imagem]', type: 'image' },
];

const parseArgs = (argv) => {
  const args = {
    tenant: process.env.CHATBOT_TENANT_ID || 'maistv',
    route: 'vendas',
    text: '',
    type: 'text',
    phone: '5524999999999',
    conversationId: '',
    source: process.env.CHATBOT_FLOW_SOURCE || 'postgres',
    store: '',
    json: false,
    all: false,
    log: ['true', '1', 'yes', 'sim'].includes(String(process.env.CHATBOT_DRY_RUN_LOG_ENABLED || '').toLowerCase()),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') {
      args.json = true;
      continue;
    }
    if (item === '--all' || item === '--scenarios') {
      args.all = true;
      continue;
    }
    if (item === '--log') {
      args.log = true;
      continue;
    }
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : '';
    if (key === 'tenant') args.tenant = value || args.tenant;
    if (key === 'route') args.route = value || args.route;
    if (key === 'text') args.text = value;
    if (key === 'type') args.type = value || args.type;
    if (key === 'phone') args.phone = value || args.phone;
    if (key === 'conversation-id') args.conversationId = value;
    if (key === 'source') args.source = value || args.source;
    if (key === 'store') args.store = value;
  }

  args.source = String(args.source || 'postgres').trim().toLowerCase();
  return args;
};

const nowIso = () => new Date().toISOString();

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
  return { store: store && typeof store === 'object' ? store : {}, storePath: resolvedPath };
};

const buildLegacyRuntimeFlows = (legacyFlows = [], source = 'legacy') =>
  normalizeLegacyChatbotFlows(legacyFlows)
    .filter((flow) => flow.active)
    .map((legacyFlow) => {
      const definition = buildChatbotDefinition({ legacyFlow, source });
      return {
        id: legacyFlow.id,
        name: legacyFlow.name,
        routeKey: null,
        status: 'legacy',
        isActive: Boolean(legacyFlow.active),
        version: 'legacy',
        versionId: '',
        triggerConfig: extractTriggerConfig(definition),
        definition,
      };
    });

const runLegacyDryRun = async ({ args, scenario }) => {
  const { store, storePath } = await loadLegacyStore(args.store);
  const flows = buildLegacyRuntimeFlows(store.chatbotFlows, 'legacy-store');
  const conversation = buildDryRunConversation({
    routeKey: args.route,
    text: scenario.text,
    type: scenario.type || args.type,
    phone: args.phone,
    conversationId: args.conversationId,
  });
  const matchedFlow = findMatchingChatbotFlow(flows, scenario.text);

  if (!matchedFlow) {
    return {
      scenario: scenario.name || 'single',
      source: 'legacy',
      storePath,
      mode: 'dry-run',
      routeKey: args.route,
      text: scenario.text,
      messageType: scenario.type || args.type,
      matched: false,
      reason: flows.length ? 'no_trigger' : 'no_active_flows',
      flowId: '',
      version: null,
      versionId: '',
      nodeId: '',
      wouldSend: [],
      nextState: null,
      trace: [],
      createsOutboundJob: false,
      callsMeta: false,
      mutatesMessages: false,
    };
  }

  const plan = simulateChatbotFlow({ flow: matchedFlow, conversation });
  return {
    scenario: scenario.name || 'single',
    source: 'legacy',
    storePath,
    mode: 'dry-run',
    routeKey: args.route,
    text: scenario.text,
    messageType: scenario.type || args.type,
    matched: true,
    reason: 'trigger_matched',
    flowId: matchedFlow.id,
    flowName: matchedFlow.name,
    version: 'legacy',
    versionId: '',
    nodeId: plan.trace[0]?.nodeId || '',
    wouldSend: plan.outputs,
    nextState: plan.nextState,
    trace: plan.trace,
    createsOutboundJob: false,
    callsMeta: false,
    mutatesMessages: false,
  };
};

const safeRunPostgresDryRun = async ({ args, scenario }) => {
  try {
    return {
      scenario: scenario.name || 'single',
      ...(await runPostgresChatbotDryRun({
        tenantId: args.tenant,
        routeKey: args.route,
        text: scenario.text,
        type: scenario.type || args.type,
        phone: args.phone,
        conversationId: args.conversationId,
        log: args.log,
      })),
    };
  } catch (error) {
    return {
      scenario: scenario.name || 'single',
      source: 'postgres',
      mode: 'dry-run',
      tenantId: args.tenant,
      routeKey: args.route,
      text: scenario.text,
      messageType: scenario.type || args.type,
      matched: false,
      reason: 'postgres_unavailable',
      error: error?.message || 'PostgreSQL unavailable',
      flowId: '',
      version: null,
      versionId: '',
      nodeId: '',
      wouldSend: [],
      nextState: null,
      trace: [],
      createsOutboundJob: false,
      callsMeta: false,
      mutatesMessages: false,
    };
  }
};

const loadInventory = async (args) => {
  if (args.source === 'postgres') {
    try {
      const flows = await listPostgresChatbotFlows({
        tenantId: args.tenant,
        includeArchived: true,
      });
      return flows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        routeKey: flow.routeKey,
        status: flow.status,
        isActive: flow.isActive,
        priority: flow.priority,
        currentVersionId: flow.currentVersionId,
        version: flow.version?.version || null,
      }));
    } catch (error) {
      return [{ error: error?.message || 'PostgreSQL unavailable' }];
    }
  }
  const { store, storePath } = await loadLegacyStore(args.store);
  return normalizeLegacyChatbotFlows(store.chatbotFlows).map((flow) => ({
    id: flow.id,
    name: flow.name,
    active: flow.active,
    source: 'legacy',
    storePath,
  }));
};

const formatMarkdown = (report) => {
  const lines = [];
  lines.push('# Dry-run do chatbot');
  lines.push('');
  lines.push(`- Fonte: \`${report.source}\``);
  lines.push(`- Tenant: \`${report.tenantId}\``);
  lines.push(`- Rota: \`${report.routeKey}\``);
  lines.push(`- Cenários: ${report.simulations.length}`);
  lines.push('');
  lines.push('## Resultado');
  report.simulations.forEach((simulation) => {
    const sendSummary = simulation.wouldSend.length
      ? simulation.wouldSend.map((item) => item.type).join(', ')
      : 'nenhum envio';
    lines.push(`- ${simulation.scenario}: matched=${simulation.matched} reason=${simulation.reason} flow=${simulation.flowId || '-'} wouldSend=${sendSummary}`);
  });
  lines.push('');
  lines.push('## Garantias');
  lines.push('- Nenhuma chamada Meta foi feita.');
  lines.push('- Nenhum job outbound real foi criado.');
  lines.push('- Nenhuma mensagem real foi alterada.');
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = args.all
    ? DEFAULT_SCENARIOS
    : [{ name: 'single', text: args.text || 'oi', type: args.type || 'text' }];
  const simulations = [];

  for (const scenario of scenarios) {
    simulations.push(
      args.source === 'postgres'
        ? await safeRunPostgresDryRun({ args, scenario })
        : await runLegacyDryRun({ args, scenario }),
    );
  }

  const inventory = await loadInventory(args);
  const report = {
    generatedAt: nowIso(),
    mode: 'dry-run',
    source: args.source,
    tenantId: args.tenant,
    routeKey: args.route,
    logEnabled: args.log,
    summary: {
      totalInventoryItems: inventory.length,
      matchedScenarios: simulations.filter((item) => item.matched).length,
      noActiveFlows: simulations.every((item) => item.reason === 'no_active_flows'),
    },
    inventory,
    simulations,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
};

main()
  .catch((error) => {
    console.error('[chatbot:dry-run] erro:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres().catch(() => {});
  });
