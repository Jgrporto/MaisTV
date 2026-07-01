import 'dotenv/config';

import { closePostgres } from '../server/db/postgres.mjs';
import { buildChatbotFlowsAuditReport } from '../server/services/chatbot-audit.service.mjs';
import { listPostgresChatbotFlows } from '../server/services/chatbot-flow.service.mjs';

const parseArgs = (argv) => {
  const args = {
    tenant: process.env.CHATBOT_TENANT_ID || 'maistv',
    route: '',
    source: process.env.CHATBOT_FLOW_SOURCE || 'postgres',
    json: false,
    allowBlocked: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') {
      args.json = true;
      continue;
    }
    if (item === '--allow-blocked') {
      args.allowBlocked = true;
      continue;
    }
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : '';
    if (key === 'tenant') args.tenant = value || args.tenant;
    if (key === 'route') args.route = value || args.route;
    if (key === 'source') args.source = value || args.source;
  }

  args.source = String(args.source || 'postgres').trim().toLowerCase();
  return args;
};

const formatMarkdown = (report) => {
  const lines = [];
  lines.push('# Validacao dos fluxos do chatbot');
  lines.push('');
  lines.push(`- Total: ${report.total}`);
  lines.push(`- Validos sem bloqueador: ${report.validation.validWithoutBlockers}`);
  lines.push(`- Com bloqueador: ${report.validation.withBlockers}`);
  lines.push(`- Warnings: ${report.validation.warnings}`);
  lines.push('');
  report.items.forEach((item) => {
    lines.push(`## ${item.name}`);
    lines.push(`- id: \`${item.id}\``);
    lines.push(`- risco: \`${item.risks}\``);
    lines.push(`- route_key: \`${item.routeKey || 'null'}\``);
    if (!item.issues.length) {
      lines.push('- problemas: nenhum');
    } else {
      item.issues.forEach((issue) => {
        lines.push(`- ${issue.severity}/${issue.code}: ${issue.message}`);
      });
    }
    lines.push('');
  });
  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.source !== 'postgres') {
    throw new Error('chatbot:flows:validate suporta somente --source postgres nesta etapa');
  }

  const flows = await listPostgresChatbotFlows({
    tenantId: args.tenant,
    routeKey: args.route || null,
    includeArchived: true,
  });
  const report = buildChatbotFlowsAuditReport({ flows });
  const blockingItems = report.items.filter((item) =>
    item.issues.some((issue) => issue.severity === 'blocker'));
  const warningCount = report.items.reduce(
    (total, item) => total + item.issues.filter((issue) => issue.severity === 'warning').length,
    0,
  );
  report.tenantId = args.tenant;
  report.routeFilter = args.route || null;
  report.validation = {
    validWithoutBlockers: report.total - blockingItems.length,
    withBlockers: blockingItems.length,
    warnings: warningCount,
    ok: blockingItems.length === 0,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMarkdown(report));
    console.log(JSON.stringify(report, null, 2));
  }

  if (blockingItems.length && !args.allowBlocked) {
    process.exitCode = 2;
  }
};

main()
  .catch((error) => {
    console.error('[chatbot:flows:validate] erro:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres().catch(() => {});
  });
