# Homologacao do sequenciamento do chatbot PostgreSQL

## Escopo e seguranca

Esta etapa altera somente a MaisTV em `/root/MaisTV`. Nao altera `/root/SaasTV`, nao ativa rotinas, schedulers ou envio em massa e nao muda o envio manual. O controle sequencial so e aplicado a mensagens com `raw_json.origin='chatbot-postgres'`.

Flags recomendadas na homologacao:

```env
CHATBOT_POSTGRES_RUNTIME_ENABLED=true
CHATBOT_POSTGRES_OUTBOUND_ENABLED=true
CHATBOT_POSTGRES_ALLOWED_ROUTES=vendas
CHATBOT_POSTGRES_MAX_OUTPUTS=10
CHATBOT_POSTGRES_ALLOW_ASSIGNED_CONVERSATIONS=false
```

O worker outbound precisa permanecer ativo porque tambem atende o envio manual. O rollback desliga somente o runtime PostgreSQL do chatbot.

## Modelo implementado

- `chatbot_output_batches`: um lote por mensagem inbound e no maximo um lote `pending/processing` por conversa.
- `chatbot_output_items`: todos os outputs planejados, com indice e estado individual.
- O runtime cria o lote e todos os itens, mas cria/enfileira somente o item zero.
- O worker outbound chama `handleChatbotOutboundSent` depois que a Meta retorna um `message id`.
- O callback marca o item atual como `sent`, cria a mensagem seguinte e enfileira somente esse proximo item.
- Uma falha marca item e lote como `failed`; itens posteriores continuam `pending` e nao sao liberados.
- Um advisory lock transacional por tenant/conversa impede duas decisoes simultaneas.
- Os indices unicos no PostgreSQL impedem batch duplicado por inbound e dois batches ativos na mesma conversa.
- Jobs residuais consultam batch/item antes de chamar a Meta e sao bloqueados se o lote nao estiver `processing` e o item nao estiver `queued`.

## Deploy controlado na VPS

Antes, publique este codigo no repositorio Git. Na VPS:

```bash
set -euo pipefail
cd /root/MaisTV
git pull --ff-only

unset NODE_ENV NPM_CONFIG_PRODUCTION NPM_CONFIG_OMIT
npm ci --include=dev

set -a
source /etc/maistv-next/maistv-next.env
set +a

npm run chatbot:sequence:test
npm run db:migrate:chat

systemctl restart maistv-next-chat-worker@inbound.service
systemctl restart maistv-next-chat-worker@outbound.service

systemctl --no-pager --full status \
  maistv-next-chat-worker@inbound.service \
  maistv-next-chat-worker@outbound.service
```

Nao reiniciar ou habilitar `maistv-next-worker`, `maistv-next-routine-worker`, `maistv-next-assignment-worker` ou qualquer scheduler nesta etapa.

## Configurar os guardrails

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

set_env CHATBOT_POSTGRES_RUNTIME_ENABLED true
set_env CHATBOT_POSTGRES_OUTBOUND_ENABLED true
set_env CHATBOT_POSTGRES_ALLOWED_ROUTES vendas
set_env CHATBOT_POSTGRES_MAX_OUTPUTS 10
set_env CHATBOT_POSTGRES_ALLOW_ASSIGNED_CONVERSATIONS false
chmod 0600 "$ENV_FILE"

systemctl restart maistv-next-chat-worker@inbound.service
systemctl restart maistv-next-chat-worker@outbound.service
```

## Dry-run

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a

npm run chatbot:dry-run -- \
  --route vendas \
  --text '#testeBot' \
  --source postgres \
  --json
```

O resultado deve ter `matched=true` e `wouldSend` nesta ordem: boas-vindas, pergunta e interactive TV/Celular.

## Teste live controlado

Em um telefone de homologacao, enviar `#testeBot` para a rota `vendas`. Confirmar no WhatsApp:

1. `Seja bem vindo!`
2. `Voce quer falar com qual setor`
3. botoes/lista `TV` e `Celular`

Em seguida, repetir em sessoes limpas ou conforme o fluxo permitir:

- `TV`
- `Celular`
- `1`
- `2`
- clique no botao TV
- clique no botao Celular
- texto invalido

Texto invalido deve registrar `ura_option_not_matched`, preservar a sessao aguardando URA e nao iniciar outro fluxo.

## Observabilidade

Bull Board autenticado:

```text
https://api-homolog-test.hakione.tech/admin/queues
```

Logs:

```bash
journalctl -f \
  -u maistv-next-chat-worker@inbound.service \
  -u maistv-next-chat-worker@outbound.service
```

Relatorio consolidado:

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run chatbot:sequence:report -- --limit 30
```

Para uma conversa especifica:

```bash
npm run chatbot:sequence:report -- \
  --conversation-id UUID_DA_CONVERSA \
  --limit 100
```

Consultas diretas:

```bash
docker exec -i maistv-next-postgres-1 \
  psql -U maistv_next -d maistv_next <<'SQL'
SELECT id,conversation_id,inbound_message_id,flow_id,status,current_index,total_outputs,error_message,created_at,updated_at
FROM chatbot_output_batches
ORDER BY created_at DESC
LIMIT 30;

SELECT batch_id,output_index,output_type,status,message_id,queued_at,sent_at,failed_at,error_message
FROM chatbot_output_items
ORDER BY created_at DESC,output_index ASC
LIMIT 100;

SELECT event_type,payload,created_at
FROM chatbot_events
WHERE mode='live'
ORDER BY created_at DESC
LIMIT 150;

SELECT id,conversation_id,flow_id,current_node_id,status,state,last_inbound_message_id,last_outbound_message_id,updated_at
FROM chatbot_sessions
ORDER BY updated_at DESC
LIMIT 30;
SQL
```

Para um batch aprovado, os itens devem estar todos `sent`, em `output_index` crescente, e o batch deve estar `completed`. Nao pode haver mais de um item `queued` no mesmo batch.

## Verificacao do envio manual

Enviar uma mensagem manual pela tela na rota `vendas`. Confirmar que:

- a mensagem nao possui `raw_json.origin='chatbot-postgres'`;
- ela e enviada normalmente pelo worker outbound;
- nenhuma linha e criada em `chatbot_output_items` para essa mensagem.

## Rollback rapido

```bash
set -euo pipefail
ENV_FILE=/etc/maistv-next/maistv-next.env
sed -i 's/^CHATBOT_POSTGRES_RUNTIME_ENABLED=.*/CHATBOT_POSTGRES_RUNTIME_ENABLED=false/' "$ENV_FILE"
sed -i 's/^CHATBOT_POSTGRES_OUTBOUND_ENABLED=.*/CHATBOT_POSTGRES_OUTBOUND_ENABLED=false/' "$ENV_FILE"
systemctl restart maistv-next-chat-worker@inbound.service
```

Nao parar o worker outbound: ele continua necessario para mensagens manuais. A migration pode permanecer instalada; com o runtime desligado ela fica inerte.

## Criterio de aprovacao

A etapa so pode ser aprovada depois do dry-run conectado ao PostgreSQL e dos testes live confirmarem ordem, retomada da URA, ausencia de duplicidade, batch final `completed`, filas sem falha inexplicada e envio manual preservado.
