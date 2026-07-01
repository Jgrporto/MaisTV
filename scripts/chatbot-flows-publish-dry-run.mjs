import 'dotenv/config';

import { closePostgres } from '../server/db/postgres.mjs';
import {
  moveChatbotFlowToDraft,
  publishChatbotFlowForDryRun,
} from '../server/repositories/chatbot-flow.repository.mjs';
import { auditChatbotFlow } from '../server/services/chatbot-audit.service.mjs';
import { listPostgresChatbotFlows } from '../server/services/chatbot-flow.service.mjs';

const REQUIRED_SAFE_FLAGS = {
  CHATBOT_ENABLED: 'false',
  CHATBOT_DRY_RUN: 'true',
  CHATBOT_BACKEND_RUNTIME_ENABLED: 'false',
  CHATBOT_FRONTEND_PROCESSING_ENABLED: 'false',
  SUPPORT_FLOW_EXECUTION_ENABLED: 'false',
  CHATBOT_FLOW_SOURCE: 'postgres',
};

const parseArgs = (argv) => {
  const args = {
    tenant: process.env.CHATBOT_TENANT_ID || 'maistv',
    flowId: '',
    route: '',
    confirm: false,
    json: false,
    draft: false,
    forceRisk: false,
    skipEnvCheck: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--confirm') {
      args.confirm = true;
      continue;
    }
    if (item === '--json') {
      args.json = true;
      continue;
    }
    if (item === '--draft' || item === '--unpublish') {
      args.draft = true;
      continue;
    }
    if (item === '--force-risk') {
      args.forceRisk = true;
      continue;
    }
    if (item === '--skip-env-check') {
      args.skipEnvCheck = true;
      continue;
    }
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : '';
    if (key === 'tenant') args.tenant = value || args.tenant;
    if (key === 'flow-id') args.flowId = value || args.flowId;
    if (key === 'route') args.route = value || args.route;
  }

  return args;
};

const checkSafeFlags = () => Object.entries(REQUIRED_SAFE_FLAGS).map(([key, expected]) => {
  const actual = String(process.env[key] ?? '').trim().toLowerCase();
  return {
    key,
    expected,
    actual: actual || '<missing>',
    ok: actual === expected,
  };
});

const formatMarkdown = (report) => {
  const lines = [];
  lines.push('# Publicacao dry-run do chatbot');
  lines.push('');
  lines.push(`- Modo: \`${report.mode}\``);
  lines.push(`- Acao: \`${report.action}\``);
  lines.push(`- Flow: \`${report.flowId || '-'}\``);
  lines.push(`- Rota: \`${report.routeKey || '-'}\``);
  lines.push(`- Confirmado: ${report.confirmed ? 'sim' : 'nao'}`);
  lines.push(`- Alterou banco: ${report.changed ? 'sim' : 'nao'}`);
  if (report.flowName) lines.push(`- Nome: ${report.flowName}`);
  if (report.risk) lines.push(`- Risco: \`${report.risk}\``);
  if (report.blockedReason) lines.push(`- Bloqueado: ${report.blockedReason}`);
  lines.push('');
  lines.push('## Flags');
  report.safeFlags.forEach((flag) => {
    lines.push(`- ${flag.key}: esperado=${flag.expected} atual=${flag.actual} ok=${flag.ok}`);
  });
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.flowId) throw new Error('Informe --flow-id <id>');
  if (!args.draft && !args.route) throw new Error('Informe --route <rota> para publicar dry-run');

  const safeFlags = checkSafeFlags();
  const unsafeFlags = safeFlags.filter((flag) => !flag.ok);
  const flows = await listPostgresChatbotFlows({
    tenantId: args.tenant,
    includeArchived: true,
  });
  const target = flows.find((flow) => flow.id === args.flowId);
  if (!target) throw new Error(`Fluxo nao encontrado: ${args.flowId}`);
  const targetForAudit = args.draft ? target : { ...target, routeKey: args.route };
  const audit = auditChatbotFlow(targetForAudit);
  const otherActiveFlows = flows.filter((flow) =>
    flow.id !== args.flowId && flow.status === 'published' && flow.isActive);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.confirm ? 'confirm' : 'dry-run',
    action: args.draft ? 'move-to-draft' : 'publish-for-dry-run',
    tenantId: args.tenant,
    flowId: args.flowId,
    flowName: target.name,
    routeKey: args.draft ? target.routeKey : args.route,
    risk: audit.risks,
    issues: audit.issues,
    safeFlags,
    confirmed: args.confirm,
    changed: false,
    result: null,
  };

  if (unsafeFlags.length && !args.skipEnvCheck) {
    report.blockedReason = 'flags de seguranca obrigatorias nao estao configuradas';
  } else if (!args.confirm) {
    report.blockedReason = 'dry-run apenas; use --confirm para alterar o PostgreSQL';
  } else if (!args.draft && otherActiveFlows.length) {
    report.blockedReason = `ja existem ${otherActiveFlows.length} fluxos published/is_active`;
    report.otherActiveFlows = otherActiveFlows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      routeKey: flow.routeKey,
    }));
  } else if (!args.draft && ['alto risco', 'bloqueado'].includes(audit.risks) && !args.forceRisk) {
    report.blockedReason = `risco ${audit.risks}; escolha um fluxo baixo risco ou use --force-risk conscientemente`;
  }

  if (!report.blockedReason && args.confirm) {
    report.result = args.draft
      ? await moveChatbotFlowToDraft({
        tenantId: args.tenant,
        flowId: args.flowId,
      })
      : await publishChatbotFlowForDryRun({
        tenantId: args.tenant,
        flowId: args.flowId,
        routeKey: args.route,
      });
    report.changed = Boolean(report.result);
    if (!report.result) {
      report.blockedReason = 'fluxo nao possui current_version_id publicado';
      report.changed = false;
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMarkdown(report));
    console.log(JSON.stringify(report, null, 2));
  }

  if (report.blockedReason) {
    process.exitCode = 2;
  }
};

main()
  .catch((error) => {
    console.error('[chatbot:flows:publish-dry-run] erro:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres().catch(() => {});
  });
