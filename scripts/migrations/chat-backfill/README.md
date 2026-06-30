# Backfill do chat

Os scripts consolidam, sem apagar a origem, conversas e mensagens encontradas no JSON legado, no SQLite principal e no SQLite de histórico. A execução padrão é apenas leitura e gera um relatório em `reports/`.

```powershell
npm run chat:backfill:dry
node scripts/migrations/chat-backfill/backfill-conversations-from-store-json.mjs
node scripts/migrations/chat-backfill/backfill-messages-from-sqlite.mjs
```

Para gravar no PostgreSQL é obrigatório fornecer a conexão, revisar o relatório e usar `--confirm` explicitamente:

```powershell
$env:DATABASE_URL='postgresql://...'
node scripts/migrations/chat-backfill/backfill-chat-from-legacy.mjs --confirm --tenant maistv
npm run chat:backfill:validate -- --tenant maistv
```

Variáveis opcionais: `LEGACY_WHATSAPP_JSON_PATH`, `LEGACY_MAIN_STORE_JSON_PATH`, `WHATSAPP_BACKFILL_SQLITE_PATH` e `WHATSAPP_HISTORY_DB_PATH`. Reexecuções são idempotentes por telefone, `provider_message_id` e `client_message_id`. Não há `DELETE`, `TRUNCATE` ou alteração dos arquivos de origem.
