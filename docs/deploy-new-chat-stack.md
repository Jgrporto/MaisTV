# Deploy da nova stack de chat

> Guia proposto. Nenhum comando deste documento foi executado em VPS nesta entrega.

## Pré-requisitos

Node.js 20+, PostgreSQL 16, Redis 7, Nginx, systemd e TLS válido. O host atual usa `/root/SaasTV`; os units refletem esse caminho e rodam como root por compatibilidade transitória. Planeje mover a aplicação para usuário/caminho sem privilégios em etapa separada.

## Preparação

```bash
cd /root/SaasTV
git pull --ff-only
npm ci
npm run build
sudo install -d -m 0750 /etc/maistv
sudo install -m 0600 /dev/null /etc/maistv/chat-stack.env
```

Preencha `/etc/maistv/chat-stack.env` diretamente no host; não copie segredos para Git. Aplique `server/db/migrations/001_chat_architecture.sql` conforme [postgres-migration.md](postgres-migration.md).

Antes do cutover, mantenha `CHAT_ARCHITECTURE_ENABLED=false`, execute `npm run db:migrate:chat`,
conclua o backfill e configure `CHAT_DEFAULT_TENANT_ID`. Ative a flag somente depois dos health
checks; as rotas `/api/whatsapp/*` continuam no runtime legado durante toda esta fase.

## Instalação dos units e Nginx

```bash
sudo cp infra/systemd/maistv-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo nginx -t
sudo systemctl reload nginx
```

Inclua `infra/nginx/maistv-sse.conf` dentro do vhost HTTPS existente antes de `nginx -t`. A porta SSE interna é `5055`; `5054` permanece reservada ao Whisper.

## Ordem de ativação

```bash
sudo systemctl enable --now maistv-worker-inbound.service maistv-worker-outbound.service maistv-worker-status.service maistv-worker-media.service
sudo systemctl enable --now maistv-worker-automations.service maistv-worker-metrics.service
sudo systemctl enable --now maistv-sse.service
sudo systemctl restart maistv-api.service
```

Valide antes de direcionar tráfego:

```bash
curl -fsS http://127.0.0.1:5053/api/health/postgres
curl -fsS http://127.0.0.1:5053/api/health/redis
curl -fsS http://127.0.0.1:5053/api/health/queues
curl -fsS http://127.0.0.1:5055/api/health/realtime
systemctl --no-pager --full status maistv-api.service maistv-sse.service 'maistv-worker-*'
journalctl -u maistv-api.service -u maistv-sse.service --since '-10 min' --no-pager
```

Publique o frontend somente depois de build bem-sucedido:

```bash
sudo rsync -a --delete /root/SaasTV/dist/ /var/www/maistv/dist/
```

## Observabilidade

- Logs Pino JSON: `journalctl -u <unit>`; configure retenção no journald.
- Sentry: opcional por `SENTRY_DSN`; sem DSN a aplicação continua funcionando.
- Bull Board: `/admin/queues`, somente autenticado/restrito.
- Uptime Kuma: monitors HTTP para health geral, PostgreSQL, Redis, filas e realtime, sem credenciais na URL.

Ative inicialmente para um tenant/coorte e acompanhe duplicidade, failed jobs, latência, reconexões SSE e divergência com legado. Veja [rollback](rollback-plan.md).
