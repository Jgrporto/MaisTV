# Homologacao dos tres canais oficiais

## Limites

Esta etapa prepara a arquitetura. Nao executa cutover definitivo, nao ativa rotinas, schedulers, envio em massa ou o assignment worker. A SaasTV continua producao oficial.

## Canais

| Canal | Numero | Rota |
|---|---|---|
| default | +55 24 99966-3511 | `/api/whatsapp/webhook` |
| vendas2 | +55 24 99916-2165 | `/api/whatsapp/webhook-vendas2` |
| vendas | +55 24 99821-0417 | `/api/whatsapp/webhook-vendas` |

O canal nao participa da identidade nem da escolha da fila. A identidade e `(tenant_id, normalized_phone)`.

## Modelo persistido

Migration: `008_unified_customer_channels.sql`.

- `conversations.normalized_phone`: identidade canonica.
- `last_inbound_route_key` e `last_inbound_phone_number_id`: ultimo canal usado pelo cliente.
- `last_customer_message_at` e `last_24h_window_expires_at`: janela persistida.
- `standard_label*`: espelho operacional do perfil.
- `messages.route_key` e `messages.phone_number_id`: canal real de cada mensagem.
- `customer_profiles`: etiqueta padrao persistida por telefone.
- `queue_label_mappings`: uma etiqueta padrao aponta para uma fila ativa.
- `conversation_merge_audit`: preserva a linha completa de conversas consolidadas.

A migration consolida formatos duplicados de telefone, move mensagens/referencias para a conversa mais recente e registra a linha removida tecnicamente em `conversation_merge_audit`.

## Etiquetas

Prioridade implementada:

1. override manual;
2. confirmado vencido ha pelo menos um dia: `system-cancelados`;
3. confirmado criado nos ultimos 30 dias e nao vencido: `system-pos-venda`;
4. demais confirmados: `system-cliente`;
5. somente trial `EXPIRED`: `system-sql`;
6. desconhecido ou trial nao expirado: `system-lead`.

Cliente confirmado prevalece sobre trial. O sync recalcula e persiste; o frontend apenas le `standard_label`. Override manual nao e sobrescrito por sincronizacoes futuras.

## Filas

As configuracoes em `Configuracoes > Servicos` passam a usar `/api/queues` no PostgreSQL. O formulario contem nome, descricao, icone, usuarios e etiquetas. Nao contem numero, rota ou `phone_number_id`.

Durante a transicao, o mapeamento antigo por rota e somente fallback quando ainda nao existe `queue_label_mappings`, para nao quebrar `vendas` antes da configuracao das filas por etiqueta.

## Envio

- texto livre: exige janela aberta e usa o ultimo canal inbound;
- chatbot: passa pelo mesmo worker e pela mesma validacao;
- template/HSM: o resolvedor seleciona `default` independentemente do ultimo canal;
- o worker revalida a janela antes de chamar a Meta;
- a mensagem outbound grava o canal efetivamente resolvido.

## Implantacao segura na VPS

Antes de qualquer comando, confirmar que o cutover geral continua ausente.

```bash
cd /root/MaisTV
git pull --ff-only

unset NODE_ENV NPM_CONFIG_PRODUCTION NPM_CONFIG_OMIT
npm ci --include=dev

set -a
source /etc/maistv-next/maistv-next.env
set +a

npm run channels:test
npm run chatbot:sequence:test
npm run channels:migrate:dry
npm run db:migrate:chat
npm run channels:migrate
npm run build
```

Publicar o frontend e o Nginx de homologacao preservando backup do arquivo live:

```bash
rsync -a --delete /root/MaisTV/dist/ /var/www/maistv-next/dist/
chown -R www-data:www-data /var/www/maistv-next/dist

cp -a /etc/nginx/sites-available/homolog-test \
  "/etc/nginx/sites-available/homolog-test.bak.$(date -u +%Y%m%dT%H%M%SZ)"

sed -i \
  's#presence(?:/|$)|messages/send#customer-profiles(?:/|$)|presence(?:/|$)|queues(?:/|$)|messages/send#' \
  /etc/nginx/sites-available/homolog-test

nginx -t
systemctl reload nginx
systemctl restart maistv-next-api maistv-next-chat-worker@inbound
systemctl try-restart maistv-next-sse maistv-next-chat-worker@outbound
systemctl disable --now maistv-next-assignment-worker || true
```

Nao reiniciar nem alterar unidades da SaasTV.

## Validacao SQL

```sql
SELECT tenant_id,normalized_phone,count(*)
FROM conversations
GROUP BY tenant_id,normalized_phone HAVING count(*)>1;

SELECT contact_phone,normalized_phone,last_inbound_route_key,
       last_inbound_phone_number_id,last_customer_message_at,
       last_24h_window_expires_at,standard_label,queue_id,unread_count
FROM conversations
ORDER BY updated_at DESC LIMIT 30;

SELECT direction,route_key,phone_number_id,type,status,created_at
FROM messages WHERE conversation_id='<conversation_id>'
ORDER BY created_at;

SELECT * FROM customer_profiles ORDER BY updated_at DESC LIMIT 30;
SELECT * FROM queue_label_mappings ORDER BY label_key;
SELECT * FROM conversation_merge_audit ORDER BY merged_at DESC;
```

## Sequencia de testes

1. Manter apenas `vendas` no teste controlado atual.
2. Enviar inbound e confirmar conversa, etiqueta, fila, SSE e canal da mensagem.
3. Apontar temporariamente `vendas2`, enviar pelo mesmo telefone e confirmar o mesmo `conversation_id`.
4. Repetir com `default`.
5. Responder apos cada inbound e conferir o canal outbound.
6. Em uma conversa sintetica expirada, confirmar bloqueio de texto livre.
7. Enviar template controlado e confirmar `route_key=default`.
8. Testar as cinco classificacoes e override manual seguido de novo sync.
9. Abrir a conversa com outro usuario e confirmar `unread_count=0` via SSE.
10. Remover cada cutover temporario ao terminar seu teste.

## Auditoria de rotinas

Executar apenas leitura:

```bash
npm run routines:channel:audit
```

O resultado precisa ser revisado manualmente antes de qualquer ativacao. O script nao inicia scheduler nem rotina.
