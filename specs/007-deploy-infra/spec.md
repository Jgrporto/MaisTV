# SPEC: Deploy e Infraestrutura

## Objetivo

Definir como o MaisTV é implantado, uma vez que os runbooks antigos de homologação blue-green (`/root/MaisTV` ao lado de `/root/SaasTV` na mesma VPS) foram removidos por estarem desatualizados.

## Contexto

Os documentos removidos descreviam um cenário específico: MaisTV como ambiente de homologação isolado (units `maistv-next-*`, portas `5350–5356`, PostgreSQL `55432`, Redis `56379`) ao lado de uma produção chamada SaasTV no mesmo servidor (`/root/SaasTV`). Não está claro, sem confirmação, se esse ainda é o cenário real de produção hoje (2026-07-20) — os documentos são de 2026-06-30 a 2026-07-02 e não houve atualização desde então.

## Escopo

- Confirmar o estado real de deploy atual (o que está de fato rodando em produção, onde, com quais variáveis) antes de escrever qualquer procedimento novo.
- Implantar PgBouncer na frente do PostgreSQL, para sustentar API + SSE + múltiplos workers + 10+ sessões de atendente sem esgotar conexões.
- Manter topologia systemd (um serviço por processo: API, SSE, um worker por fila) — sem Docker Compose para app/workers nesta fase.
- Definir e documentar a rotina de backup manual do PostgreSQL antes de cada mudança grande (migration, cutover de rota, deploy de risco).
- Configurar rate limit de envio por `phone_number_id` nos workers outbound, isolando throttling da Meta por número.
- Padronizar observabilidade: logs Pino estruturados no journald, Bull Board autenticado em `/admin/queues`, health checks monitorados por Uptime Kuma a cada 60s, Sentry opcional via `SENTRY_DSN`.

## Fora de escopo

- Reescrever scripts de cutover/rollback específicos de uma migração ainda não decidida em detalhe operacional (isso é consequência de `001-attendance-architecture`, executado quando a implementação começar).
- Migrar para Docker Compose ou orquestração de containers para app/workers.
- Object storage (S3/R2) para mídia — mídia fica em disco local (ver `001-attendance-architecture`).
- Backup automático diário com teste de restore — decisão explícita foi backup manual antes de mudanças grandes (ver risco em `001-attendance-architecture`); pode ser revisitado depois.
- Qualquer execução em VPS a partir desta SPEC isoladamente.

## Impacto esperado

Deploy documentado de forma confiável, refletindo o estado real do servidor, com infraestrutura dimensionada para 3+ webhooks Meta concorrentes e 10+ atendentes online, sem depender de um plano de homologação desatualizado.

## Dependências

- Acesso/confirmação do estado atual da VPS.
- `001-attendance-architecture` (decisões de base de dados, cutover, storage, realtime, distribuição de filas já tomadas — esta SPEC trata de como implantar essas decisões).

## Riscos

- Escrever procedimento de deploy sem antes confirmar o estado real da VPS reproduz o mesmo problema que motivou apagar a documentação anterior.
- PgBouncer mal configurado (modo de pooling errado para uso com prepared statements do driver Postgres da aplicação) pode causar erros sutis de conexão — validar em homologação antes de produção.
- Backup manual depende de disciplina humana de lembrar de rodar antes de cada mudança — sem automação, é o elo mais fraco da confiabilidade de dados (ver `001-attendance-architecture`).

## Decisões técnicas

Decididas em 2026-07-20 (ver `001-attendance-architecture` para o conjunto completo):

- Topologia: systemd na VPS, um serviço por processo.
- PgBouncer na frente do Postgres.
- Backup manual antes de mudanças grandes, sem automação diária.
- Rate limit de envio por `phone_number_id` no worker outbound.
- Observabilidade: Pino + Bull Board + Uptime Kuma + Sentry opcional.
- Confirmação do estado real da VPS de produção ainda pendente de execução (não é uma decisão de design, é um passo de verificação antes de qualquer deploy novo).
