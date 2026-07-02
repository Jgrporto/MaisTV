# Handoff - conversa unica, canais oficiais e filas por etiqueta

Data: 2026-07-01

## Implementado

- Migration 008 com identidade por telefone normalizado, canal inbound mais recente, janela 24h, perfil persistido, fila por etiqueta e auditoria de merges.
- Normalizacao central reconhece `5524998210417`, `24998210417` e `998210417` como a mesma identidade no contexto DDD 24.
- Inbound usa perfil/etiqueta persistida e fila por etiqueta; route mapping antigo ficou apenas como fallback transitorio.
- Mensagens preservam `route_key` e `phone_number_id`.
- Texto livre usa o ultimo canal inbound e e bloqueado fora da janela.
- Template/HSM resolve sempre `default` no resolvedor compartilhado.
- Chatbot passa pela mesma validacao no worker outbound.
- Sync NewBR recalcula perfis no PostgreSQL e respeita override manual.
- Frontend parou de recalcular etiqueta na renderizacao.
- Configuracao de fila foi movida para `/api/queues` e nao exige numero.
- Backfill passou a unificar pelo telefone canonico e preservar canal das mensagens.
- Leitura global existente foi preservada.
- Auditor read-only de rotinas foi adicionado.

## Validacao local

- `npm run channels:test`: 5/5.
- `npm run chatbot:sequence:test`: 4/4.
- `npm run lint`: aprovado.
- `npm run build`: aprovado.
- `npm run channels:migrate:dry`: aprovado; checkout local nao possui snapshot de filas/clientes.
- `npm run routines:channel:audit`: aprovado; checkout local nao possui rotinas persistidas.

## Nao executado

- Nenhuma migration foi aplicada na VPS.
- Nenhum webhook foi virado.
- Nenhuma chamada Meta foi realizada.
- Nenhum outbound, rotina, scheduler, massa ou assignment worker foi ativado.
- SaasTV nao foi alterada.

## Pendencias de aprovacao

- Aplicar migration e migracao de perfis/filas na VPS.
- Configurar os cinco mapeamentos etiqueta->fila no painel.
- Homologar conversa unica em `vendas`, depois `vendas2`, depois `default`.
- Homologar inbound de midia por canal.
- Homologar texto outbound por ultimo canal e HSM/default.
- Validar override seguido de sync real.
- Validar leitura global/SSE com dois usuarios.
- Auditar rotinas usando o snapshot real da VPS.

Procedimento: `docs/unified-official-channels-homologation.md`.

