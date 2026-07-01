# Deploy blue-green da MaisTV em homologação

Este guia instala `/root/MaisTV` ao lado da produção `/root/SaasTV`. Ele não substitui units `maistv-*`, não publica em `/var/www/maistv/dist` e não altera os webhooks oficiais durante a homologação.

## Mapa isolado

| Componente | Homologação |
| --- | --- |
| Código | `/root/MaisTV` |
| Frontend | `/var/www/maistv-next/dist` |
| Environment | `/etc/maistv-next/maistv-next.env` |
| Units | `maistv-next-*` |
| WhatsApp compatível | `127.0.0.1:5350` |
| Checkout | `127.0.0.1:5351` |
| API local/chat | `127.0.0.1:5353` |
| Whisper | `127.0.0.1:5354` |
| Auth | `127.0.0.1:5355` |
| SSE | `127.0.0.1:5356` |
| PostgreSQL | `127.0.0.1:55432` |
| Redis | `127.0.0.1:56379` |

## 1. Publicar o commit local

No PowerShell local, depois de revisar o diff:

```powershell
cd "D:\Haki One - VPS\MaisTV"
git status --short
npm run lint
npm run build
npm run maistv-next:validate-layout
git add .
git commit -m "feat: prepare isolated MaisTV blue-green homologation"
git push origin main
```

## 2. Confirmar DNS na VPS

```bash
getent ahostsv4 homolog-test.hakione.tech
getent ahostsv4 api-homolog-test.hakione.tech
```

Os dois devem resolver para `2.24.118.225` antes do Certbot.

## 3. Atualizar somente `/root/MaisTV`

```bash
cd /root/MaisTV
git status --short --branch
git pull --ff-only origin main
npm ci
npm run lint
npm run build
npm run maistv-next:validate-layout
```

Não execute Git, npm ou alterações dentro de `/root/SaasTV`.

## 4. Instalar Docker e Compose

O inventário de 2026-07-01 não encontrou Docker, PostgreSQL ou Redis instalados.

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
docker --version
docker compose version
```

Se `docker-compose-v2` não existir no repositório da distribuição, pare neste ponto; não use script remoto `curl | sh`.

## 5. Gerar environment isolado

O script lê `/root/SaasTV/.env`, preserva os segredos sem imprimi-los e grava um novo arquivo com portas, URLs, bancos e flags da homologação.

```bash
sudo install -d -m 0750 /etc/maistv-next
cd /root/MaisTV
sudo node scripts/prepare-maistv-next-env.mjs \
  --source /root/SaasTV/.env \
  --output /etc/maistv-next/maistv-next.env \
  --confirm
sudo stat -c '%a %U:%G %n' /etc/maistv-next/maistv-next.env
```

O modo esperado é `600 root:root`. Para conferir somente valores não secretos:

```bash
sudo grep -E '^(CHAT_|VITE_.*(URL|ENABLED)|POSTGRES_(HOST|PORT|DATABASE|USER)|REDIS_(HOST|PORT|DB)|BULLMQ_PREFIX|SQLITE_DB_PATH|SSE_PORT)=' /etc/maistv-next/maistv-next.env
```

## 6. Criar snapshot consistente dos dados legados

Nunca copie os arquivos `-wal` e `-shm` diretamente. Use o backup online do SQLite:

```bash
sudo install -d -m 0750 /root/MaisTV/server/data
sudo sqlite3 /root/SaasTV/server/data/maistv.sqlite \
  ".backup '/root/MaisTV/server/data/maistv.sqlite'"
sudo sqlite3 /root/SaasTV/server/data/maistv-history.sqlite \
  ".backup '/root/MaisTV/server/data/maistv-history.sqlite'"
sudo install -m 0640 /root/SaasTV/server/data/store.json /root/MaisTV/server/data/store.json
sudo install -d -m 0750 /root/MaisTV/server/data/whatsapp-template-media
sudo rsync -a /root/SaasTV/server/data/whatsapp-template-media/ /root/MaisTV/server/data/whatsapp-template-media/
```

Valide o snapshot:

```bash
sqlite3 -readonly /root/MaisTV/server/data/maistv.sqlite 'PRAGMA integrity_check; SELECT count(*) FROM whatsapp_conversations; SELECT count(*) FROM whatsapp_messages;'
sqlite3 -readonly /root/MaisTV/server/data/maistv-history.sqlite 'PRAGMA integrity_check; SELECT count(*) FROM history_messages;'
```

A referência inicial inventariada foi `2238` conversas, `54707` mensagens no banco principal e `69962` no histórico. Os números podem crescer até o momento do snapshot.

## 7. Subir PostgreSQL e Redis isolados

```bash
cd /root/MaisTV
sudo docker compose \
  --project-name maistv-next \
  --env-file /etc/maistv-next/maistv-next.env \
  -f docker-compose.homolog.yml \
  up -d postgres redis
sudo docker compose \
  --project-name maistv-next \
  --env-file /etc/maistv-next/maistv-next.env \
  -f docker-compose.homolog.yml \
  ps
```

Confirme que apenas loopback está exposto:

```bash
ss -ltnp | grep -E ':55432|:56379'
```

## 8. Migration e backfill

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run db:migrate:chat
npm run chat:backfill:dry
ls -lt scripts/migrations/chat-backfill/reports/ | head
```

Revise o relatório antes da gravação. Depois:

```bash
npm run chat:backfill
npm run chat:backfill:validate
```

Validação SQL complementar:

```bash
sudo docker compose --project-name maistv-next --env-file /etc/maistv-next/maistv-next.env -f docker-compose.homolog.yml exec -T postgres \
  psql -U maistv_next -d maistv_next -c "SELECT count(*) AS conversations FROM conversations; SELECT count(*) AS messages FROM messages; SELECT count(*) AS webhook_events FROM webhook_events;"
```

## 9. Build e publicação do frontend de teste

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run build
sudo install -d -m 0755 /var/www/maistv-next/dist
sudo rsync -a --delete /root/MaisTV/dist/ /var/www/maistv-next/dist/
sudo chown -R www-data:www-data /var/www/maistv-next/dist
```

## 10. Instalar units sem tocar nas units atuais

```bash
cd /root/MaisTV
sudo install -m 0644 infra/systemd/maistv-next-*.service /etc/systemd/system/
sudo systemctl daemon-reload
systemctl list-unit-files 'maistv-next-*'
```

Inicialização segura de homologação. Schedulers legados e outbound novo permanecem parados:

```bash
sudo systemctl enable --now \
  maistv-next-auth.service \
  maistv-next-api.service \
  maistv-next-whatsapp.service \
  maistv-next-checkout.service \
  maistv-next-transcription.service \
  maistv-next-sse.service \
  maistv-next-chat-worker@inbound.service \
  maistv-next-chat-worker@status.service \
  maistv-next-chat-worker@media.service \
  maistv-next-chat-worker@automations.service \
  maistv-next-chat-worker@metrics.service
```

Não inicie ainda:

- `maistv-next-chat-worker@outbound.service`;
- `maistv-next-worker.service`;
- `maistv-next-routine-worker.service`;
- `maistv-next-assignment-worker.service`.

Valide portas e serviços:

```bash
systemctl --no-pager --full status 'maistv-next-*'
ss -ltnp | grep -E ':5350|:5351|:5353|:5354|:5355|:5356|:55432|:56379'
curl -fsS http://127.0.0.1:5353/api/health/postgres
curl -fsS http://127.0.0.1:5353/api/health/redis
curl -fsS http://127.0.0.1:5353/api/health/queues
curl -fsS http://127.0.0.1:5356/api/health/realtime
```

## 11. Nginx e certificados de homologação

```bash
cd /root/MaisTV
sudo install -m 0644 infra/nginx/homolog-test.conf /etc/nginx/sites-available/homolog-test
sudo ln -s /etc/nginx/sites-available/homolog-test /etc/nginx/sites-enabled/homolog-test
sudo nginx -t
sudo systemctl reload nginx
```

Emita o certificado substituindo o e-mail:

```bash
sudo certbot --nginx \
  -d homolog-test.hakione.tech \
  -d api-homolog-test.hakione.tech \
  --redirect --agree-tos --no-eff-email \
  -m SEU_EMAIL
sudo nginx -t
sudo systemctl reload nginx
```

## 12. Smoke tests

```bash
curl -fsS https://homolog-test.hakione.tech/ -o /dev/null -w 'frontend=%{http_code}\n'
curl -fsS https://api-homolog-test.hakione.tech/health
curl -fsS https://api-homolog-test.hakione.tech/api/health/postgres
curl -fsS https://api-homolog-test.hakione.tech/api/health/redis
curl -fsS https://api-homolog-test.hakione.tech/api/health/queues
curl -fsS https://api-homolog-test.hakione.tech/api/health/realtime
```

Teste sintético do webhook novo, sem alterar a Meta:

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run maistv-next:test-webhook -- --confirm --customer 5500000000000
sleep 3
sudo docker compose --project-name maistv-next --env-file /etc/maistv-next/maistv-next.env -f docker-compose.homolog.yml exec -T postgres \
  psql -U maistv_next -d maistv_next -c "SELECT contact_phone,last_message,last_message_at FROM conversations WHERE contact_phone='5500000000000';"
```

Depois, no navegador, valide login, Attendance, paginação, SSE com admin e atendente, documento sob clique, templates, quick replies, checkout sem pagamento real e demais módulos.

## 13. Outbound controlado

Inicie o outbound somente quando houver um telefone de teste pertencente à equipe:

```bash
sudo systemctl enable --now maistv-next-chat-worker@outbound.service
journalctl -u maistv-next-chat-worker@outbound.service -f
```

Teste separadamente as rotas `default`, `vendas` e `vendas2`. O worker escolhe token e `phone_number_id` conforme o seletor persistido na conversa.

## 14. Preparação do cutover futuro

Não execute esta seção durante a homologação. O snippet `infra/nginx/production-webhook-cutover.conf` contém somente as três rotas oficiais de webhook e aponta para `5350`. O `whatsapp-server.js` da MaisTV mantém o fluxo legado e, com `CHAT_MIRROR_META_WEBHOOK_ENABLED=true`, espelha cada evento de forma idempotente para PostgreSQL/BullMQ.

Antes do corte será necessário:

1. parar temporariamente os serviços `maistv-next-*` que escrevem no snapshot;
2. refazer snapshot/delta e backfill;
3. instalar os overrides de scheduler em `infra/systemd/cutover/`;
4. validar a MaisTV com portas locais;
5. incluir o snippet no `server` HTTPS de `api.maistv.hakione.tech`;
6. executar `nginx -t` e reload;
7. confirmar webhooks e eventos no PostgreSQL;
8. somente então parar os consumidores equivalentes da SaasTV.

O rollback consiste em remover o include do snippet, validar Nginx e recarregar. A rota genérica `/api/` da SaasTV continua preservada durante esta primeira virada.
