# Migração incremental da arquitetura de chat

## Estado e objetivo

Esta fase aplica strangler pattern ao núcleo de atendimento. A nova camada nasce ao lado do legado; rotas antigas continuam disponíveis até a validação funcional e operacional do caminho novo. Nenhuma implantação em VPS faz parte desta alteração local.

Decisão arquitetural: PostgreSQL persiste dados; BullMQ processa trabalhos; Redis Pub/Sub distribui eventos internos; SSE atualiza o frontend; React busca dados sob demanda.

## Fluxos

### Recebimento

Meta → Nginx → webhook Express → validação da assinatura → `webhook_events` no PostgreSQL → fila `inbound_messages` → resposta HTTP 200 → worker inbound → `conversations`/`messages` → Redis Pub/Sub → SSE → cache do React.

O webhook não baixa mídia, executa automações pesadas nem atualiza dashboard. `event_key` e o identificador do provedor impedem duplicidade.

### Envio

Frontend → `POST /api/messages/send` → mensagem `pending` no PostgreSQL → fila `outbound_messages` → worker outbound → Meta. Os webhooks de status entram em `message_status`; o worker atualiza PostgreSQL e publica `message_status_updated` para o SSE.

As consultas e URLs de mídia aplicam tenant e escopo de agente/fila; administradores são o único papel
com acesso transversal ao tenant. O outbound muda para `sending` antes da chamada à Meta e bloqueia
reenvio automático quando o resultado de transporte é ambíguo, evitando duplicação silenciosa.

### Consulta

- `GET /api/conversations?limit=30&cursor=...`: somente resumos, cursor por `last_message_at,id`.
- `GET /api/conversations/:conversationId/messages?limit=20&before=...`: páginas em ordem cronológica, cursor por `created_at,id`.
- Nenhuma paginação de mensagens usa `OFFSET`.

### Mídia

A mensagem retorna metadados. Thumbnail é pedida perto da viewport; original, áudio, vídeo e documento somente por ação do usuário. O storage novo abstrai S3/R2 e mantém a mídia legada compatível durante a transição.

## Rotas da nova camada

- `GET /api/conversations`
- `GET /api/conversations/:conversationId/messages`
- `POST /api/messages/send`
- `GET /api/media/:mediaId/thumbnail`
- `GET /api/media/:mediaId/signed-url`
- `GET /api/events`
- `GET /api/health/postgres`
- `GET /api/health/redis`
- `GET /api/health/queues`
- `GET /api/health/realtime`
- `GET /admin/queues` quando `BULL_BOARD_ENABLED=true` e o usuário estiver autorizado

O worker de mídia grava o original no S3/R2 e gera thumbnail JPEG com `sharp` para imagens. O frontend
solicita a thumbnail somente perto da viewport e solicita o original, áudio ou vídeo apenas por interação.

## Compatibilidade preservada

Continuam no legado enquanto consumidores são migrados: `GET /api/whatsapp/conversations`, `GET /api/whatsapp/conversations/:id`, `GET /api/whatsapp/messages`, `GET /api/whatsapp/history/messages`, os `POST /api/whatsapp/send-*`, templates e `GET /api/whatsapp/media`.

Também permanecem fora desta etapa checkout/NewBR, Mercado Pago, Tavinho, chatbot, rotinas, HSM, envio em massa, dashboard, clientes, autenticação/permissões, transcrição e distribuição de filas. SQLite e JSON são somente compatibilidade/migração; não são a nova fonte de verdade.

## Fases de ativação

1. Subir PostgreSQL e Redis; aplicar migration e validar health checks.
2. Subir workers sem direcionar tráfego; validar Bull Board e logs.
3. Subir SSE; testar autenticação, heartbeat e isolamento por tenant.
4. Ativar webhook novo para tenant piloto, preservando o endpoint antigo.
5. Ativar leitura e envio novos por feature flag/coorte.
6. Expandir somente após comparar contagens, status e mídia com o legado.
7. Remover legado apenas em fase futura, após janela de estabilidade e backup testado.

Consulte também [SSE](realtime-sse.md), [workers](bullmq-workers.md), [PostgreSQL](postgres-migration.md), [deploy](deploy-new-chat-stack.md) e [rollback](rollback-plan.md).
