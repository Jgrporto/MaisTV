# Handoff: dry-run PostgreSQL dos fluxos do chatbot

Data: 2026-07-01

## Estado anterior confirmado

- `005_chatbot_postgres_storage.sql` aplicada.
- 14 fluxos legados importados para PostgreSQL.
- 14 versoes criadas.
- Todos importados como `draft`.
- `active_published: 0`.
- `CHATBOT_FLOW_SOURCE=postgres`.
- `CHATBOT_ENABLED=false`.
- `CHATBOT_DRY_RUN=true`.
- Nenhuma chamada Meta.
- Nenhum job outbound.
- Nenhuma mutacao real em mensagens.

## Entrega desta etapa

Foram adicionados comandos de auditoria e homologacao segura:

```bash
npm run chatbot:flows:report -- --source postgres --json
npm run chatbot:flows:validate -- --source postgres --json
npm run chatbot:flows:publish-dry-run -- --flow-id <id> --route vendas --confirm --json
```

Scripts criados:

- `scripts/chatbot-flows-report.mjs`
- `scripts/chatbot-flows-validate.mjs`
- `scripts/chatbot-flows-publish-dry-run.mjs`

Servico de auditoria criado:

- `server/services/chatbot-audit.service.mjs`

Repositorio atualizado:

- `server/repositories/chatbot-flow.repository.mjs`

Documentacao atualizada:

- `docs/chatbot-audit-dry-run.md`
- `docs/chatbot-postgres-storage.md`

## Regras de seguranca

Manter obrigatoriamente:

```env
CHATBOT_ENABLED=false
CHATBOT_DRY_RUN=true
CHATBOT_BACKEND_RUNTIME_ENABLED=false
CHATBOT_FRONTEND_PROCESSING_ENABLED=false
SUPPORT_FLOW_EXECUTION_ENABLED=false
CHATBOT_FLOW_SOURCE=postgres
```

Nao fazer nesta etapa:

- nao ativar runtime real;
- nao ativar frontend processing;
- nao ativar support flow execution;
- nao ativar rotinas/schedulers;
- nao fazer cutover;
- nao publicar todos os fluxos;
- nao chamar Meta;
- nao criar outbound real;
- nao enviar mensagem real;
- nao alterar SaasTV producao.

## Ordem recomendada na VPS

Depois de publicar o codigo:

```bash
cd /root/MaisTV

set -a
source /etc/maistv-next/maistv-next.env
set +a

npm run chatbot:flows:report -- --source postgres --json
npm run chatbot:flows:validate -- --source postgres --json
```

Escolher apenas 1 fluxo baixo risco. Se todos aparecerem como `bloqueado` por falta de `route_key`, isso e esperado antes da publicacao controlada. O publish simula a rota escolhida na auditoria.

Publicar somente o fluxo escolhido:

```bash
npm run chatbot:flows:publish-dry-run -- --flow-id <id> --route vendas --confirm --json
```

Simular:

```bash
npm run chatbot:dry-run -- --route vendas --text "oi" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "ola" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "quero contratar" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "suporte" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "falar com atendente" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "nao entendi" --source postgres --json
npm run chatbot:dry-run -- --route vendas2 --text "oi" --source postgres --json
```

Validar em todos:

- `source: "postgres"`;
- `createsOutboundJob: false`;
- `callsMeta: false`;
- `mutatesMessages: false`;
- se houver match, deve retornar `flowId`, `versionId`, `nodeId` e `wouldSend`;
- rota sem fluxo ativo deve retornar `no_active_flows` ou `no_trigger`.

Ao final, se a politica for manter zero ativos:

```bash
npm run chatbot:flows:publish-dry-run -- --flow-id <id> --draft --confirm --json
```

## Criterio de aprovacao

Esta etapa so pode ser aprovada quando:

- os 14 fluxos forem inventariados;
- os 14 fluxos forem validados;
- cada fluxo tiver risco classificado;
- apenas 1 fluxo seguro for publicado para dry-run;
- o dry-run encontrar esse fluxo pelo PostgreSQL;
- `wouldSend` aparecer nos casos esperados;
- handoff/fallback forem avaliados;
- rotas sem fluxo ativo retornarem corretamente;
- flags finais permanecerem desligadas;
- nenhum envio real acontecer.

## Recomendacao atual

O teste real controlado pode ser feito apenas pelo runtime PostgreSQL da nova arquitetura, mantendo o runtime legado desligado.

Flags para teste real estreito:

```env
CHATBOT_ENABLED=false
CHATBOT_DRY_RUN=true
CHATBOT_BACKEND_RUNTIME_ENABLED=false
CHATBOT_FRONTEND_PROCESSING_ENABLED=false
SUPPORT_FLOW_EXECUTION_ENABLED=false
CHATBOT_FLOW_SOURCE=postgres
CHATBOT_POSTGRES_RUNTIME_ENABLED=true
CHATBOT_POSTGRES_OUTBOUND_ENABLED=true
CHATBOT_POSTGRES_ALLOWED_ROUTES=vendas
CHATBOT_POSTGRES_ALLOWED_FLOW_IDS=48573c2e-1a58-4c9e-9f3c-1298f77df557
CHATBOT_POSTGRES_ALLOW_ASSIGNED_CONVERSATIONS=false
CHATBOT_POSTGRES_MAX_OUTPUTS=50
```

O worker outbound precisa estar ativo para entrega real:

```bash
systemctl start maistv-next-chat-worker@outbound
```

Rollback imediato:

```bash
CHATBOT_POSTGRES_RUNTIME_ENABLED=false
CHATBOT_POSTGRES_OUTBOUND_ENABLED=false
systemctl restart maistv-next-chat-worker@inbound
systemctl stop maistv-next-chat-worker@outbound
```

Nao ligar `CHATBOT_ENABLED=true` nesta fase.
