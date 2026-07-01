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
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') {
      args.json = true;
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
  lines.push('# Inventario dos fluxos do chatbot');
  lines.push('');
  lines.push(`- Fonte: \`${report.source}\``);
  lines.push(`- Total: ${report.total}`);
  lines.push(`- Draft: ${report.summary.draft}`);
  lines.push(`- Published/active: ${report.summary.publishedActive}`);
  lines.push(`- Baixo risco: ${report.summary.lowRisk}`);
  lines.push(`- Medio risco: ${report.summary.mediumRisk}`);
  lines.push(`- Alto risco: ${report.summary.highRisk}`);
  lines.push(`- Bloqueado: ${report.summary.blocked}`);
  lines.push('');
  lines.push('| ID | Nome | Status | Ativo | Rota | Versao | Nos | Gatilho | Respostas | Risco | Issues |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | --- | ---: | --- | ---: |');
  report.items.forEach((item) => {
    lines.push([
      item.id,
      item.name,
      item.status,
      item.isActive ? 'sim' : 'nao',
      item.routeKey || '-',
      item.version || '-',
      item.nodeCount,
      `${item.triggers.rule}:${item.triggers.value || '-'}`,
      item.responses,
      item.risks,
      item.issues.length,
    ].map((value) => String(value).replace(/\|/g, '/')).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  });
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.source !== 'postgres') {
    throw new Error('chatbot:flows:report suporta somente --source postgres nesta etapa');
  }
  const flows = await listPostgresChatbotFlows({
    tenantId: args.tenant,
    routeKey: args.route || null,
    includeArchived: true,
  });
  const report = buildChatbotFlowsAuditReport({ flows });
  report.tenantId = args.tenant;
  report.routeFilter = args.route || null;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
};

main()
  .catch((error) => {
    console.error('[chatbot:flows:report] erro:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres().catch(() => {});
  });
