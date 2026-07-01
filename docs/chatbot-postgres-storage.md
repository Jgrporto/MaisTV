# Chatbot no PostgreSQL

Data: 2026-07-01

## Objetivo

Os fluxos do chatbot passam a ter fonte oficial no PostgreSQL da nova arquitetura MaisTV. `store.json` e `tvassist_json_store` continuam existindo apenas como origem legada para importacao e auditoria.

Esta etapa nao ativa chatbot real, nao envia mensagem, nao chama Meta, nao cria job outbound e nao liga rotinas/schedulers.

## Tabelas

A migration `005_chatbot_postgres_storage.sql` cria:

- `chatbot_flows`: cadastro do fluxo, tenant, rota, status, prioridade, gatilho e versao atual.
- `chatbot_flow_versions`: versoes imutaveis do fluxo, definicao JSONB e checksum SHA-256.
- `chatbot_sessions`: estado futuro por conversa, com pausa/handoff/expiracao.
- `chatbot_events`: trilha de auditoria, principalmente para dry-run quando `--log` ou `CHATBOT_DRY_RUN_LOG_ENABLED=true`.

Status de flow:

- `draft`
- `published`
- `archived`
- `disabled`

Status de sessao:

- `active`
- `paused`
- `handoff`
- `closed`
- `expired`

## Fonte Oficial

Padrao esperado:

```env
CHATBOT_ENABLED=false
CHATBOT_DRY_RUN=true
CHATBOT_BACKEND_RUNTIME_ENABLED=false
CHATBOT_FRONTEND_PROCESSING_ENABLED=false
SUPPORT_FLOW_EXECUTION_ENABLED=false
CHATBOT_FLOW_SOURCE=postgres
CHATBOT_DRY_RUN_LOG_ENABLED=false
```

`npm run chatbot:dry-run` le PostgreSQL por padrao. Para consultar o legado explicitamente:

```bash
npm run chatbot:dry-run -- --source legacy --route vendas --text "oi" --json
```

## Importacao Legada

Dry-run:

```bash
npm run chatbot:import-legacy -- --dry-run --json
```

Importar como draft:

```bash
npm run chatbot:import-legacy -- --confirm --json
```

Importar atribuindo uma rota:

```bash
npm run chatbot:import-legacy -- --confirm --route vendas --json
```

Por seguranca, o importador:

- nao altera `store.json`;
- valida estrutura basica;
- calcula checksum;
- evita duplicidade por checksum ja existente no tenant;
- cria flow em `draft` por padrao;
- cria `chatbot_flow_versions` versao `1`;
- so publica/ativa se receber `--publish --activate` explicitamente.

## Dry-run PostgreSQL

Exemplos:

```bash
npm run chatbot:dry-run -- --route vendas --text "oi" --json
npm run chatbot:dry-run -- --route vendas --text "quero contratar" --json
npm run chatbot:dry-run -- --route vendas --text "falar com atendente" --json
npm run chatbot:dry-run -- --route vendas --all --json
```

Se nao houver flow `published` e `is_active=true` para tenant/rota, o resultado correto e `no_active_flows`. Isso nao e erro.

O dry-run retorna:

- `source`;
- `tenantId`;
- `routeKey`;
- `flowId`;
- `version`;
- `versionId`;
- `nodeId`;
- `reason`;
- `wouldSend`;
- garantias de que nao criou outbound, nao chamou Meta e nao alterou mensagens.

## Auditoria e homologacao dos 14 fluxos

Depois da importacao como `draft`, use:

```bash
npm run chatbot:flows:report -- --source postgres --json
npm run chatbot:flows:validate -- --source postgres --json
```

`chatbot:flows:report` gera o inventario completo dos fluxos importados:

- id, nome, status, rota, versao e checksum;
- gatilho;
- contagens de nos, respostas, condicoes e delays;
- midia, template/HSM, handoff, fallback e encerramento;
- origem legado;
- classificacao de risco;
- problemas encontrados.

`chatbot:flows:validate` usa a mesma auditoria, mas retorna codigo `2` se houver bloqueadores, exceto com `--allow-blocked`. Isso e esperado enquanto todos os fluxos estiverem sem `route_key` e sem revisao manual de fallback/handoff.

Classificacoes possiveis:

- `baixo risco`;
- `medio risco`;
- `alto risco`;
- `bloqueado`.

## Publicacao de 1 fluxo apenas para dry-run

Para simular um fluxo ativo sem ligar runtime real, publique apenas um fluxo seguro:

```bash
npm run chatbot:flows:publish-dry-run -- --flow-id <id> --route vendas --confirm --json
```

O comando so altera o PostgreSQL se:

- `--confirm` estiver presente;
- as flags de seguranca estiverem configuradas;
- nao existir outro flow `published/is_active`;
- o fluxo nao estiver classificado como `alto risco` ou `bloqueado`, a menos que `--force-risk` seja usado conscientemente.

Flags obrigatorias:

```env
CHATBOT_ENABLED=false
CHATBOT_DRY_RUN=true
CHATBOT_BACKEND_RUNTIME_ENABLED=false
CHATBOT_FRONTEND_PROCESSING_ENABLED=false
SUPPORT_FLOW_EXECUTION_ENABLED=false
CHATBOT_FLOW_SOURCE=postgres
```

O comando define somente:

```sql
status = 'published'
is_active = true
route_key = '<route>'
```

Ele nao liga chatbot real, nao envia mensagem, nao chama Meta e nao cria job outbound.

Para retornar o fluxo para rascunho:

```bash
npm run chatbot:flows:publish-dry-run -- --flow-id <id> --draft --confirm --json
```

## Teste real controlado pelo PostgreSQL

O runtime real legado continua desligado. O teste real controlado usa somente:

```txt
webhook inbound real
-> messages/conversations PostgreSQL
-> engine PostgreSQL
-> mensagem outbound pending
-> fila outbound
-> outbound.worker.mjs
-> Meta
```

Flags obrigatorias para um teste real estreito:

```env
CHATBOT_ENABLED=false
CHATBOT_DRY_RUN=true
CHATBOT_BACKEND_RUNTIME_ENABLED=false
CHATBOT_FRONTEND_PROCESSING_ENABLED=false
SUPPORT_FLOW_EXECUTION_ENABLED=false
CHATBOT_FLOW_SOURCE=postgres
CHATBOT_POSTGRES_RUNTIME_ENABLED=true
CHATBOT_POSTGRES_OUTBOUND_ENABLED=true
CHATBOT_POSTGRES_ALLOWED_ROUTES=vendas
CHATBOT_POSTGRES_ALLOWED_FLOW_IDS=<flow-id>
CHATBOT_POSTGRES_ALLOW_ASSIGNED_CONVERSATIONS=false
CHATBOT_POSTGRES_MAX_OUTPUTS=50
CHATBOT_POSTGRES_BOT_USER_ID=chatbot-postgres
```

Observacoes:

- `CHATBOT_ENABLED=false` deve continuar assim para nao ligar o runtime legado.
- `CHATBOT_DRY_RUN=true` pode continuar assim para manter o caminho legado em modo seguro; o runtime novo usa as flags `CHATBOT_POSTGRES_*`.
- Saidas `text` e `interactive` sao enviadas pela fila outbound nova.
- Componentes `variables`, `label`, `finish`, `redirect` e `wait` sao processados no estado do chatbot.
- Componentes `media` e `audio` sao mapeados/auditados; envio real depende de asset compativel com a Cloud API e deve ser homologado por fluxo.
- O worker `maistv-next-chat-worker@outbound` precisa estar ativo para entregar a mensagem real.
- O fluxo deve estar `published/is_active=true` e restrito por `CHATBOT_POSTGRES_ALLOWED_FLOW_IDS`.

Para liberar todos os fluxos publicados da rota controlada, deixe `CHATBOT_POSTGRES_ALLOWED_FLOW_IDS` vazio. Para homologacao, prefira liberar um fluxo por vez.

Rollback imediato do teste real:

```env
CHATBOT_POSTGRES_RUNTIME_ENABLED=false
CHATBOT_POSTGRES_OUTBOUND_ENABLED=false
```

Depois reinicie o worker inbound:

```bash
systemctl restart maistv-next-chat-worker@inbound
```

## Versionamento

Cada import cria uma linha em `chatbot_flow_versions` com:

- `version=1`;
- `definition` em JSONB;
- `checksum` SHA-256 deterministico;
- `notes` com origem legada.

`chatbot_flows.current_version_id` aponta para a versao atual. O dry-run so considera flows `published` com `is_active=true`, usando a `current_version_id`.

## Editor Frontend

Pendencia: a tela atual `src/pages/Chatbot.jsx` e `src/pages/ChatbotFlowEditor.jsx` ainda usa `/api/local/chatbot/flows`, que salva no store legado. Ela deve ser migrada futuramente para endpoints PostgreSQL antes de qualquer ativacao real.

Endpoints PostgreSQL de escrita/publicacao nao foram ativados nesta fase para evitar publicar flows sem validacao/permissao.

## Envio Real Futuro

Quando o chatbot for ativado, o runtime novo nao deve usar:

- `/api/whatsapp/send-*`;
- chamada direta a Meta;
- `store.json` como fonte oficial;
- envio real em dry-run.

Fluxo desejado:

```txt
chatbot decide
-> cria acao rastreavel
-> usa servico interno equivalente a /api/messages/send
-> cria mensagem pending
-> cria job outbound
-> worker outbound envia
-> status volta
-> SSE atualiza
```

## Recomendacao

Status: preparado para persistencia PostgreSQL e auditoria dry-run.

Ainda nao aprovar teste real. Antes disso, migrar editor para PostgreSQL, implementar handoff humano robusto, limites anti-loop, janela de 24h/template e envio via nova fila outbound.
