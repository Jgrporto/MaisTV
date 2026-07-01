# Cutover controlado dos webhooks para a MaisTV

## Escopo

Este procedimento move somente webhooks oficiais selecionados de `api.maistv.hakione.tech` para `127.0.0.1:5350`. Frontend, login, checkout, API genérica, rotinas e schedulers continuam na SaasTV.

Estágios disponíveis:

1. `vendas2`: somente `/api/whatsapp/webhook-vendas2`;
2. `vendas-only`: somente `/api/whatsapp/webhook-vendas` para teste isolado;
3. `vendas`: mantém `vendas2` e adiciona `/api/whatsapp/webhook-vendas`;
4. `all`: mantém as anteriores e adiciona `/api/whatsapp/webhook`.

O include ativo é um symlink em `/etc/nginx/maistv-next-webhook-cutover-enabled/active.conf`. Sem esse symlink, todas as rotas voltam à `location /api/` da SaasTV.

## Garantias do modo direto

Use estas flags na MaisTV:

```env
CHAT_ARCHITECTURE_ENABLED=true
CHAT_MIRROR_META_WEBHOOK_ENABLED=false
WHATSAPP_WEBHOOK_CHAT_ONLY=true
SUPPORT_FLOW_EXECUTION_ENABLED=false
WHATSAPP_SERVER_HOST=127.0.0.1
CHECKOUT_SERVER_HOST=127.0.0.1
WHATSAPP_SCHEDULERS_ENABLED=false
ROUTINE_SCHEDULER_ENABLED=false
QUICK_REPLY_SCHEDULE_ENABLED=false
CHECKOUT_RENEWAL_DISABLED=true
```

Em modo `chat-only`, o `whatsapp-server.js` valida a assinatura da rota, aguarda `acceptMetaWebhook`, grava o evento idempotente e cria o job inbound. Ele não executa `handleWebhookPayload`, flows ou respostas do caminho legado.

## 1. Publicar código e corrigir os binds

Depois do commit e push locais:

```bash
cd /root/MaisTV
git status --short --branch
git pull --ff-only origin main
npm ci
npm run lint
npm run build
npm run maistv-next:validate-layout
```

Atualize o environment sem imprimir segredos:

```bash
grep -q '^WHATSAPP_SERVER_HOST=' /etc/maistv-next/maistv-next.env \
  && sed -i 's/^WHATSAPP_SERVER_HOST=.*/WHATSAPP_SERVER_HOST="127.0.0.1"/' /etc/maistv-next/maistv-next.env \
  || printf '%s\n' 'WHATSAPP_SERVER_HOST="127.0.0.1"' >> /etc/maistv-next/maistv-next.env

grep -q '^CHECKOUT_SERVER_HOST=' /etc/maistv-next/maistv-next.env \
  && sed -i 's/^CHECKOUT_SERVER_HOST=.*/CHECKOUT_SERVER_HOST="127.0.0.1"/' /etc/maistv-next/maistv-next.env \
  || printf '%s\n' 'CHECKOUT_SERVER_HOST="127.0.0.1"' >> /etc/maistv-next/maistv-next.env

grep -q '^WHATSAPP_WEBHOOK_CHAT_ONLY=' /etc/maistv-next/maistv-next.env \
  && sed -i 's/^WHATSAPP_WEBHOOK_CHAT_ONLY=.*/WHATSAPP_WEBHOOK_CHAT_ONLY="true"/' /etc/maistv-next/maistv-next.env \
  || printf '%s\n' 'WHATSAPP_WEBHOOK_CHAT_ONLY="true"' >> /etc/maistv-next/maistv-next.env

grep -q '^CHAT_MIRROR_META_WEBHOOK_ENABLED=' /etc/maistv-next/maistv-next.env \
  && sed -i 's/^CHAT_MIRROR_META_WEBHOOK_ENABLED=.*/CHAT_MIRROR_META_WEBHOOK_ENABLED="false"/' /etc/maistv-next/maistv-next.env \
  || printf '%s\n' 'CHAT_MIRROR_META_WEBHOOK_ENABLED="false"' >> /etc/maistv-next/maistv-next.env

grep -q '^SUPPORT_FLOW_EXECUTION_ENABLED=' /etc/maistv-next/maistv-next.env \
  && sed -i 's/^SUPPORT_FLOW_EXECUTION_ENABLED=.*/SUPPORT_FLOW_EXECUTION_ENABLED="false"/' /etc/maistv-next/maistv-next.env \
  || printf '%s\n' 'SUPPORT_FLOW_EXECUTION_ENABLED="false"' >> /etc/maistv-next/maistv-next.env

chmod 600 /etc/maistv-next/maistv-next.env
```

Instale somente as duas units alteradas:

```bash
install -m 0644 infra/systemd/maistv-next-whatsapp.service /etc/systemd/system/
install -m 0644 infra/systemd/maistv-next-checkout.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart maistv-next-whatsapp maistv-next-checkout
systemctl --no-pager --full status maistv-next-whatsapp maistv-next-checkout
ss -ltnp | grep -E ':5350|:5351'
```

O resultado deve mostrar somente `127.0.0.1:5350` e `127.0.0.1:5351`.

## 2. Pré-validação

```bash
systemctl is-active maistv-next-api maistv-next-whatsapp maistv-next-sse \
  maistv-next-chat-worker@inbound maistv-next-chat-worker@status maistv-next-chat-worker@media
systemctl is-active maistv-next-chat-worker@outbound || true
systemctl is-active maistv-next-worker maistv-next-routine-worker maistv-next-assignment-worker || true
curl -fsS https://api-homolog-test.hakione.tech/api/health/postgres
curl -fsS https://api-homolog-test.hakione.tech/api/health/redis
curl -fsS https://api-homolog-test.hakione.tech/api/health/queues
curl -fsS https://api-homolog-test.hakione.tech/api/health/realtime
nginx -t
```

Outbound e os três serviços legados devem permanecer `inactive`.

## 3. Webhook sintético

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run maistv-next:test-webhook -- --confirm --route vendas2 --customer 5500000000000
sleep 3
```

Valide no PostgreSQL:

```bash
docker exec maistv-next-postgres-1 psql -U maistv_next -d maistv_next -c "
SELECT id,event_key,status,attempts,received_at,processed_at,error_message
FROM webhook_events ORDER BY received_at DESC LIMIT 5;
SELECT id,contact_phone,last_message,last_message_at,active_route_selector_json
FROM conversations WHERE contact_phone='5500000000000';
SELECT provider_message_id,direction,type,body,status,created_at
FROM messages WHERE raw_json->>'from'='5500000000000' ORDER BY created_at DESC LIMIT 5;
"
```

O evento deve ficar `processed`, sem `error_message`, com uma conversa e uma mensagem inbound.

## 4. Preparar Nginx sem ativar rota

Este comando cria backup do site produtivo, instala os três estágios, adiciona um include wildcard antes da rota genérica `/api/`, executa `nginx -t` e recarrega sem ativar qualquer webhook:

```bash
cd /root/MaisTV
bash scripts/prepare-maistv-next-webhook-cutover.sh --confirm
```

Confirme que não há estágio ativo:

```bash
ls -la /etc/nginx/maistv-next-webhook-cutover-enabled/
nginx -t
```

## 5. Ativar somente vendas2

Execute apenas durante a janela monitorada:

```bash
cd /root/MaisTV
bash scripts/enable-maistv-next-webhook-cutover.sh --stage vendas2 --confirm
```

Comando exato de rollback:

```bash
cd /root/MaisTV
bash scripts/rollback-maistv-next-webhook-cutover.sh --confirm
```

Para testar somente `vendas`, sem ativar `vendas2`:

```bash
bash scripts/enable-maistv-next-webhook-cutover.sh --stage vendas-only --confirm
```

## 6. Monitoramento da primeira rota

Use terminais separados:

```bash
journalctl -u maistv-next-whatsapp -f
journalctl -u maistv-next-chat-worker@inbound -f
journalctl -u maistv-next-chat-worker@status -f
journalctl -u maistv-next-chat-worker@media -f
journalctl -u maistv-next-sse -f
```

Envie uma mensagem real ao número `vendas2` e confira:

```bash
docker exec maistv-next-postgres-1 psql -U maistv_next -d maistv_next -c "
SELECT id,event_key,status,attempts,phone_number_id,received_at,processed_at,error_message
FROM webhook_events ORDER BY received_at DESC LIMIT 20;
SELECT id,contact_phone,last_message,last_message_at,active_route_selector_json
FROM conversations ORDER BY last_message_at DESC LIMIT 20;
SELECT provider_message_id,direction,type,body,status,created_at
FROM messages ORDER BY created_at DESC LIMIT 20;
"
curl -fsS https://api-homolog-test.hakione.tech/api/health/queues
curl -fsS https://api.maistv.hakione.tech/api/local/health
```

Na interface `https://homolog-test.hakione.tech`, confirme a conversa, mensagem e atualização por SSE. O Bull Board fica em `https://api-homolog-test.hakione.tech/admin/queues` e exige autenticação.

## 7. Critério de avanço

Avance somente se o webhook responder sem 4xx/5xx, o evento ficar `processed`, a mensagem aparecer uma única vez, filas não acumularem falhas, SSE atualizar a interface e a SaasTV continuar saudável.

Segundo estágio:

```bash
bash scripts/enable-maistv-next-webhook-cutover.sh --stage vendas --confirm
```

Estágio final:

```bash
bash scripts/enable-maistv-next-webhook-cutover.sh --stage all --confirm
```

Cada estágio substitui atomicamente o anterior e passa por `nginx -t` antes do reload.

## 8. Outbound controlado

Mantenha outbound inativo durante todo o teste inbound. Depois da aprovação, escolha um telefone interno e só então execute:

```bash
systemctl enable --now maistv-next-chat-worker@outbound.service
journalctl -u maistv-next-chat-worker@outbound.service -f
```

Se o teste não terminar na mesma janela:

```bash
systemctl disable --now maistv-next-chat-worker@outbound.service
```

## Riscos conhecidos

- A rota desviada deixa de nascer na SaasTV enquanto o estágio estiver ativo; use a interface MaisTV para operar e validar essa rota.
- Um snapshot antigo não contém mensagens posteriores; antes de uma migração longa ou definitiva, refaça snapshot e backfill incremental.
- Não mantenha o cutover sem monitoramento.
- Não ative outbound, rotinas, schedulers ou renovação durante o primeiro teste inbound.
- Em qualquer 4xx/5xx, mensagens ausentes, filas falhando ou exception repetida, execute rollback imediatamente.
