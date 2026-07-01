# Homologacao de filas e atribuicao - MaisTV Next

## Estado encontrado em 2026-07-01

- `maistv-next-assignment-worker.service`: `disabled` e `inactive`.
- As conversas da rota `vendas` no PostgreSQL ainda nao possuem `queue_id` nem `service_id`.
- O snapshot de autenticacao da homologacao possui apenas `user-admin`.
- O servico de vendas existente e `service-sales` (`Vendas`).
- Existem IDs de atendentes em conversas importadas, mas esses usuarios nao existem no snapshot de autenticacao atual.

Consequencia: o modelo pode ser implantado e a atribuicao manual do admin pode ser validada, mas a distribuicao entre atendentes exige primeiro disponibilizar usuarios de teste reais na autenticacao da homologacao e vincula-los ao servico `service-sales`.

## Inventario

| Arquivo | Responsabilidade | Camada | Estado/risco |
| --- | --- | --- | --- |
| `server/db/migrations/007_queue_assignment.sql` | filas, mapeamentos, memberships, presenca e auditoria | nova/PostgreSQL | novo |
| `server/repositories/assignment.repository.mjs` | persistencia de rota/fila, membership e presenca | nova/PostgreSQL | novo |
| `server/services/assignment.service.mjs` | permissoes, assign, unassign, transfer e balanceamento | nova/PostgreSQL | novo |
| `server/routes/assignment.routes.mjs` | endpoints autenticados de atribuicao/presenca | nova | novo |
| `server/workers/assignment.worker.mjs` | consumo BullMQ e atribuicao automatica | nova | novo; ativacao controlada |
| `server/services/inbound-message.service.mjs` | resolve rota/fila e produz job de assignment | nova | produtor protegido por flag |
| `server/repositories/conversations.repository.mjs` | conversa, estado de assignment e unread global | nova/PostgreSQL | alterado |
| `server/services/chat.service.mjs` | listagem e leitura global | nova | alterado |
| `server/realtime/sse.service.mjs` | eventos de fila, atribuicao, presenca e leitura | nova | alterado |
| `src/lib/conversation-assignment-api.js` | cliente frontend dos endpoints novos | nova | deixou de chamar local API legada |
| `src/lib/presence-api.js` | presenca/pause PostgreSQL | nova | deixou de chamar SQLite legado |
| `src/features/chat/hooks/useChatEvents.js` | atualizacao de sidebar/cache via SSE | nova | sem polling agressivo |
| `src/components/chat/ConversationList.jsx` | permite aba Filas ao atendente autorizado | frontend | acesso real continua validado no backend |
| `server/local-api.mjs` | atribuicao/presenca antiga em JSON/SQLite | legado | preservado, nao usado pelo frontend novo |
| `server/modules/attendance/presence-store.js` | presenca SQLite | legado | preservado, nao e fonte da nova atribuicao |
| `server/maistv-assignment-worker.mjs` | recovery de logout legado | legado | nao e usado pela unit nova |

## Modelo PostgreSQL

- `support_queues`: cadastro da fila.
- `queue_route_mappings`: rota/phone number para fila e servico.
- `queue_memberships`: usuarios permitidos e flag `is_assignable`.
- `agent_presence`: online, paused, offline, heartbeat e motivo.
- `conversation_assignment_events`: auditoria de assign/unassign/transfer/automatic.
- `conversations`: `assignment_status`, `assigned_at`, `last_assignment_at`, `route_key`, `phone_number_id`, leitura global.

O admin e sincronizado como membro para operacoes manuais, mas `is_assignable=false`; portanto nao recebe distribuicao automatica.

## Deploy sem ativar automatico

```bash
set -euo pipefail
cd /root/MaisTV
git pull --ff-only

unset NODE_ENV NPM_CONFIG_PRODUCTION NPM_CONFIG_OMIT
npm ci --include=dev

set -a
source /etc/maistv-next/maistv-next.env
set +a

npm run db:migrate:chat
npm run lint
npm run build

rsync -a --delete /root/MaisTV/dist/ /var/www/maistv-next/dist/
chown -R www-data:www-data /var/www/maistv-next/dist

install -m 0644 infra/systemd/maistv-next-assignment-worker.service /etc/systemd/system/
systemctl daemon-reload

systemctl restart maistv-next-api.service
systemctl restart maistv-next-sse.service
systemctl restart maistv-next-chat-worker@inbound.service
nginx -t
systemctl reload nginx

systemctl disable --now maistv-next-assignment-worker.service || true
```

## Mapear somente `vendas`

Use `service-sales` como `queue_id` para manter compatibilidade com os IDs de servico presentes na sessao dos usuarios:

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a

npm run assignment:route:configure -- \
  --route vendas \
  --queue-id service-sales \
  --service-id service-sales \
  --queue-name Vendas

npm run assignment:route:configure -- \
  --route vendas \
  --queue-id service-sales \
  --service-id service-sales \
  --queue-name Vendas \
  --confirm
```

Nao criar ainda mapeamentos para `vendas2` ou `default`.

## Presenca e memberships

Ao abrir Atendimento, o frontend chama `/api/presence/start` e renova heartbeat a cada 30 segundos. O backend sincroniza os `queueIds` da sessao em `queue_memberships`.

- online: elegivel;
- paused com prazo futuro: inelegivel;
- offline: inelegivel;
- heartbeat mais antigo que 90 segundos: inelegivel;
- admin: `is_assignable=false`.

Pausa nao remove conversas ja atribuidas. Logout marca offline antes de invalidar a sessao e nao executa redistribuicao pesada.

## Atribuicao manual antes do worker

Endpoints:

```text
POST /api/conversations/:id/assign
POST /api/conversations/:id/unassign
POST /api/conversations/:id/transfer
GET  /api/conversations/:id/assignment-history
```

Regras:

- admin pode atribuir para membro permitido da fila;
- atendente pode assumir somente para si e somente em fila permitida;
- conversa atribuida a outro atendente retorna conflito;
- responsavel atual ou admin pode devolver/transferir;
- conversa encerrada nao e redistribuida;
- toda mudanca usa lock de linha, grava auditoria e publica SSE.

## Ativacao automatica controlada

Pre-condicoes:

1. Pelo menos dois atendentes de teste autenticados na homologacao.
2. Ambos vinculados a `service-sales`.
3. Ambos abriram Atendimento e aparecem em `agent_presence`/`queue_memberships`.
4. Nenhuma conversa antiga deve ser usada como teste.
5. Manual assign, conflito e transfer ja aprovados.

Ativar produtor somente para novos inbounds e iniciar worker:

```bash
set -euo pipefail
ENV_FILE=/etc/maistv-next/maistv-next.env
cp -a "$ENV_FILE" "${ENV_FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"

set_env() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

set_env ASSIGNMENT_ENQUEUE_ENABLED true
set_env ASSIGNMENT_ALLOWED_ROUTES vendas
set_env ASSIGNMENT_MAX_QUEUE_AGE_MINUTES 60
set_env ASSIGNMENT_PRESENCE_TTL_SECONDS 90
chmod 0600 "$ENV_FILE"

systemctl restart maistv-next-chat-worker@inbound.service
systemctl enable --now maistv-next-assignment-worker.service
systemctl --no-pager --full status maistv-next-assignment-worker.service
```

O worker usa menor carga atual, depois `last_assigned_at` e `user_id` como desempate estavel. Sessao ativa do chatbot bloqueia assignment; um inbound posterior, depois do encerramento da sessao, produz nova tentativa.

## Leitura global

`POST /api/conversations/:id/read` agora zera `conversations.unread_count` para todos e registra `last_read_at`, `last_read_message_id` e `last_read_by`. A tabela antiga `conversation_reads` permanece apenas por compatibilidade, mas nao participa mais da listagem.

O evento SSE `conversation_read` e entregue a todos com acesso a conversa. Se a conversa selecionada recebe inbound, o frontend chama o endpoint de leitura, em vez de apenas esconder o contador localmente.

## Validacao

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run assignment:report
```

```bash
journalctl -f \
  -u maistv-next-assignment-worker.service \
  -u maistv-next-chat-worker@inbound.service \
  -u maistv-next-api.service \
  -u maistv-next-sse.service
```

No Bull Board autenticado, verificar a fila `conversation_assignments`.

SQL:

```sql
SELECT * FROM queue_route_mappings ORDER BY route_key,phone_number_id;
SELECT * FROM queue_memberships ORDER BY queue_id,user_id;
SELECT * FROM agent_presence ORDER BY updated_at DESC;
SELECT id,contact_phone,route_key,queue_id,service_id,assignment_status,assigned_agent_id,unread_count,last_message_at
FROM conversations ORDER BY updated_at DESC LIMIT 50;
SELECT * FROM conversation_assignment_events ORDER BY created_at DESC LIMIT 100;
```

## Rollback do automatico

```bash
set -euo pipefail
ENV_FILE=/etc/maistv-next/maistv-next.env
sed -i 's/^ASSIGNMENT_ENQUEUE_ENABLED=.*/ASSIGNMENT_ENQUEUE_ENABLED=false/' "$ENV_FILE"
systemctl restart maistv-next-chat-worker@inbound.service
systemctl disable --now maistv-next-assignment-worker.service
```

Inbound, outbound, chatbot, midia e SSE permanecem ativos. As tabelas e atribuicoes existentes nao sao apagadas.
