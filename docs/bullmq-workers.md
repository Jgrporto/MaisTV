# BullMQ e workers

## Filas e processos

| Fila | Processo systemd | Responsabilidade |
| --- | --- | --- |
| `inbound_messages` | `maistv-worker-inbound` | normalizar e persistir recebimentos |
| `outbound_messages` | `maistv-worker-outbound` | enviar à Meta sem bloquear a API |
| `message_status` | `maistv-worker-status` | aplicar sent/delivered/read/failed |
| `media_downloads` | `maistv-worker-media` | baixar/processar mídia fora do webhook |
| `automations` | `maistv-worker-automations` | placeholder seguro; legado continua ativo |
| `metrics` | `maistv-worker-metrics` | placeholder seguro; dashboard legado continua ativo |
| `notifications` | futuro/consumidor dedicado | notificações desacopladas |

Cada worker é um processo separado, com `attempts=5`, backoff exponencial, retenção limitada de concluídos e falhas preservadas para análise. Jobs precisam de identificador idempotente. Redis não armazena mensagens definitivamente.

## Operação

```bash
systemctl status 'maistv-worker-*'
journalctl -u maistv-worker-inbound.service -f
systemctl restart maistv-worker-inbound.service
```

Interromper um worker não autoriza apagar sua fila. Antes de retry manual, confirme idempotência no PostgreSQL. Em incidente da Meta, pause outbound sem parar inbound/status.

## Bull Board

Quando `BULL_BOARD_ENABLED=true`, o painel fica em `/admin/queues`. Exponha-o somente atrás da autenticação administrativa atual e, preferencialmente, allowlist/VPN no Nginx. O painel nunca deve permitir acesso público. Falhas devem ser correlacionadas por `jobId`, `tenantId`, `conversationId` e `messageId`, sem payload sensível.

## Uptime Kuma e alertas

Monitore `/api/health/redis` e `/api/health/queues`. Um health verde comprova conectividade, não backlog saudável; crie alerta separado para idade/quantidade de jobs waiting, active e failed. Use Pino em JSON no journald e Sentry opcional para exceções não tratadas.
