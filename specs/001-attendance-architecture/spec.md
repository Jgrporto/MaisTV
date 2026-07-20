# SPEC: Arquitetura de Atendimento

## Objetivo

Definir a arquitetura de dados e mensageria que sustenta o atendimento (conversas, mensagens, mídia, fila/assignment, presença) do MaisTV, para suportar alto volume: 3 ou mais números/endpoints da Meta recebendo conversas diretamente e 10 ou mais atendentes online simultaneamente, com estabilidade como prioridade sobre velocidade de entrega.

## Contexto

O MaisTV hoje roda majoritariamente sobre `server/local-api.mjs`, com persistência em `server/data/store.json` e SQLite (`maistv.sqlite`, `maistv-history.sqlite`). Em paralelo, existe uma segunda arquitetura (tabelas `webhook_events`, `conversations`, `messages`, `message_statuses`, `media_files`, filas BullMQ, SSE, `server/db/migrations/001` a `008`) desligada por padrão (`CHAT_ARCHITECTURE_ENABLED=false`), criada como estratégia strangler pattern e validada apenas em homologação isolada.

O SaasTV, no branch `codex/general-flow-postgres-integration`, foi além dessa base (outbox, mirror-worker, verify, `server/modernization/chat/`), mas é referência técnica, não código a copiar cegamente — decidiu-se evoluir a base própria do MaisTV em vez de portar a do SaasTV (ver Decisões técnicas).

SQLite/JSON não sustentam escrita concorrente de 3+ webhooks simultâneos nem consulta de 10+ atendentes ao mesmo tempo — este é o principal motivador técnico da decisão abaixo.

## Escopo

- Evoluir a arquitetura Postgres/Redis/BullMQ/SSE já iniciada no MaisTV até virar única fonte de verdade do atendimento.
- Cutover faseado por endpoint/rota Meta (um número por vez), reaproveitando o desenho de estágios já existente (`vendas2` → `vendas` → `default`).
- Identidade única de conversa por telefone normalizado, independente de qual dos 3+ números da Meta o cliente usa (reaproveita migration `008_unified_customer_channels`).
- Distribuição automática de conversas entre atendentes por menor carga + presença/heartbeat (reaproveita `agent_presence`, `queue_memberships`, migration `007`).
- Rate limit de envio por `phone_number_id` no worker outbound, isolando o throttling da Meta por número.
- Storage de mídia em disco local na VPS (com proteção Nginx `X-Accel-Redirect`, já validado em homologação).
- SSE como único transporte realtime para a UI, com Redis Pub/Sub por trás.
- Chatbot migra para rodar sobre esta mesma base (fila outbound nova), em vez de manter runtime próprio sobre o store legado — detalhado em `003-chatbot`.

## Fora de escopo

- Rotinas, schedulers e envio em massa — seguem fora até SPEC própria.
- Object storage (S3/R2) para mídia — decisão explícita de ficar em disco local por ora; pode ser revisitada se o volume de mídia crescer além da capacidade da VPS.
- Escalar Postgres/Redis/workers horizontalmente em múltiplas máquinas — a topologia escolhida é uma única VPS com systemd (ver `007-deploy-infra`).

## Impacto esperado

Elimina a ambiguidade de "duas fontes de verdade" para conversas/mensagens. Sustenta 3+ webhooks Meta gravando concorrentemente e 10+ atendentes consultando/atualizando em tempo real, com falha de um número (throttling, fila travada) isolada dos demais.

## Dependências

- PostgreSQL, Redis, BullMQ (já presentes no `package.json`).
- PgBouncer na frente do Postgres, para não esgotar conexões com API + SSE + múltiplos workers + 10+ sessões de atendente (ver `007-deploy-infra`).
- Migrations existentes em `server/db/migrations/001` a `008`.

## Riscos

- Reter os dois modelos (legado + novo) por tempo indefinido aumenta complexidade e risco de dessincronia — mitigado pelo cutover faseado, que deve ter prazo, não ficar aberto indefinidamente.
- Backup do Postgres é **manual, antes de mudanças grandes** (decisão explícita do usuário) — não há backup automático diário nem teste de restore periódico. Como o Postgres vira fonte única de verdade do atendimento, perda de dados fora de uma janela de mudança (disco corrompido, erro humano, falha de infra) não está coberta. Risco aceito conscientemente; revisitar se o volume de conversas tornar essa lacuna inaceitável.
- Disco local para mídia é ponto único de falha e não escala horizontalmente — aceitável no volume atual (10+ atendentes), reavaliar se o volume de mídia crescer muito.
- Distribuição automática mal calibrada (heartbeat expirado, atendente pausado não removido a tempo) pode deixar conversa "presa" sem atendente — mitigado pelas regras já desenhadas (offline/pausado/heartbeat >90s inelegíveis).

## Decisões técnicas

Decididas em 2026-07-20, com o usuário, para sustentar 3+ endpoints Meta e 10+ atendentes online com foco em estabilidade:

1. **Base de dados/mensageria**: evoluir a arquitetura já existente no MaisTV (Postgres + Redis + BullMQ + SSE), não portar a pipeline do SaasTV nem manter o legado JSON/SQLite.
2. **Cutover**: faseado por endpoint/rota Meta, um número por vez, com validação antes de avançar para o próximo.
3. **Storage de mídia**: disco local na VPS, com proteção Nginx `internal`/`X-Accel-Redirect`. Sem object storage (S3/R2) nesta fase.
4. **Distribuição de filas**: automática, por menor carga + presença (heartbeat), reaproveitando o modelo já implementado em migration `007`.
5. **Realtime**: SSE como único transporte, com Redis Pub/Sub. Sem WebSocket, sem polling agressivo.
6. **Topologia de deploy**: systemd na VPS, um serviço por processo (API, SSE, um worker por fila). Sem Docker Compose para app/workers nesta fase (ver `007-deploy-infra`).
7. **Rate limit de envio**: por `phone_number_id`, isolado por número no worker outbound.
8. **Identidade do cliente**: conversa única por telefone normalizado, independente de qual dos 3+ números o cliente usa (migration `008`).
9. **Pool de conexões Postgres**: PgBouncer na frente do banco.
10. **Backup**: manual, antes de mudanças grandes (sem automação diária) — ver risco acima.
11. **Observabilidade**: logs estruturados Pino + Bull Board autenticado + Uptime Kuma (health checks a cada 60s) + Sentry opcional.
12. **Chatbot**: migra para rodar sobre esta base (fila outbound nova) nesta mesma rodada, em vez de permanecer no store legado (ver `003-chatbot`).
