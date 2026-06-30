# Backfill SQLite/JSON para PostgreSQL

O backfill é uma etapa separada do deploy e nunca é executado automaticamente. Primeiro rode `npm run chat:backfill:dry`, arquive o relatório, compare contagens por origem e revise os itens ignorados. Arquivo ausente é reportado e não causa criação de SQLite vazio.

Somente em homologação, com backup e `DATABASE_URL` apontando para o banco correto, use `node scripts/migrations/chat-backfill/backfill-chat-from-legacy.mjs --confirm --tenant <tenant>`. Depois rode `npm run chat:backfill:validate -- --tenant <tenant>` e compare conversas, mensagens e órfãos.

O script faz upsert não destrutivo de conversas e `ON CONFLICT DO NOTHING` para mensagens. IDs sem identificador Meta recebem `client_message_id` determinístico. O rollback consiste em desativar os flags; não remova os dados gravados até a reconciliação.
