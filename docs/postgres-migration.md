# Migração do chat para PostgreSQL

## Escopo

A migration `server/db/migrations/001_chat_architecture.sql` cria somente `webhook_events`, `conversations`, `messages`, `message_statuses` e `media_files`, com unicidade/idempotência e índices de cursor. Checkout, NewBR, rotinas, dashboard e demais stores legados não são migrados nesta fase.

## Execução segura

1. Faça backup verificável do banco e registre o commit do aplicativo.
2. Suba PostgreSQL e valide `pg_isready`.
3. Exporte as variáveis sem colocá-las no histórico do shell.
4. Aplique a migration em transação no banco alvo.
5. Valide tabelas, índices e health check antes de subir workers.

Exemplo local:

```bash
docker compose -f docker-compose.infra.yml up -d postgres redis
docker compose -f docker-compose.infra.yml exec postgres pg_isready -U maistv -d maistv
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/migrations/001_chat_architecture.sql
```

Validações mínimas:

```sql
SELECT to_regclass('public.webhook_events'), to_regclass('public.conversations'),
       to_regclass('public.messages'), to_regclass('public.message_statuses'),
       to_regclass('public.media_files');
SELECT indexname FROM pg_indexes
WHERE tablename IN ('webhook_events','conversations','messages','message_statuses','media_files')
ORDER BY tablename, indexname;
```

## Dados legados

SQLite/store JSON permanecem disponíveis em modo compatibilidade/leitura. Backfill deve ser repetível, por tenant, com checkpoint e relatório de contagem; nunca altere a origem durante o ensaio. Antes do cutover compare conversas, mensagens, status, últimos timestamps e amostras de mídia. Dual-write, se usado, deve ser temporário e observável; PostgreSQL só vira fonte de verdade para a coorte após validação.

Não reverta a migration destrutivamente durante rollback operacional. Primeiro retorne leitura/escrita às rotas antigas, preserve as tabelas novas para auditoria e só faça limpeza após backup e aprovação explícita.
