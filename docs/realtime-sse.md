# Realtime por SSE

## Contrato

`GET /api/events` é o único transporte realtime desta fase. WebSocket e Socket.IO não são usados. A resposta usa `text/event-stream`, `Cache-Control: no-cache, no-transform`, heartbeat configurável e eventos pequenos: `new_message`, `conversation_updated`, `message_status_updated`, `queue_updated`, `agent_assigned` e `media_updated`.

O processo SSE autentica pelo mecanismo existente, associa a conexão a tenant/usuário/filas autorizadas,
e aceita `?conversations=<uuid>` somente após validar a conversa no PostgreSQL com o mesmo filtro de acesso da API. Eventos podem ser entregues por atribuição ao agente, fila autorizada ou assinatura explícita da conversa selecionada; troca de conversa encerra a conexão anterior no frontend.
revalida a sessão periodicamente e filtra antes da entrega os canais `tenant:{tenantId}`, `user:{userId}`,
`conversation:{conversationId}` e `queue:{queueId}`. Nunca se publica payload sensível em canal global.

## Reconexão e consistência

EventSource reconecta automaticamente. SSE é sinal de atualização, não fonte de verdade: após lacuna ou reconexão o cliente faz refetch seletivo no PostgreSQL, nunca invalidação global. Polling pode existir apenas como fallback alto (2–5 minutos).

Comandos de diagnóstico local:

```bash
curl -N -H 'Accept: text/event-stream' -b 'saastv_session=<sessao-de-teste>' http://127.0.0.1:5356/api/events
curl -fsS http://127.0.0.1:5356/api/health/realtime
journalctl -u maistv-next-sse.service -n 200 --no-pager
```

Não registre cookies, tokens ou o conteúdo integral de mensagens. O Nginx deve usar `proxy_buffering off`, `proxy_cache off`, `gzip off` e timeout de leitura alto; veja `infra/nginx/homolog-test.conf`.

## Uptime Kuma

Monitore `https://<dominio>/api/health/realtime` via HTTP a cada 60 segundos, com timeout de 10 segundos e três tentativas antes do alerta. O monitor de health não substitui um teste autenticado periódico de conexão SSE.

Com `CHAT_ARCHITECTURE_ENABLED=false`, os quatro endpoints `/api/health/{postgres,redis,queues,realtime}` respondem HTTP 200 com `status: "disabled"` e não tentam abrir dependências.
