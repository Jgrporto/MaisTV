# Auditoria segura do chatbot

Data: 2026-07-01

## Escopo

Esta fase nao ativa chatbot real, envio automatico, rotinas, schedulers, envio em massa ou cutover. O objetivo e mapear o estado atual e permitir simulacao dry-run sem chamada a Meta, sem job outbound real e sem alteracao de producao.

## Inventario de codigo

| Arquivo | Funcao | Ativo | Legado/nova arquitetura | Envia mensagem | Dependencia | Risco |
| --- | --- | --- | --- | --- | --- | --- |
| `src/pages/Chatbot.jsx` | Lista, cria, importa, ativa/desativa e exclui flows do editor | Sim, via UI | Legado/local-api | Nao diretamente | `/api/local/chatbot/flows` | Pode ativar flow legado se usado sem governanca |
| `src/pages/ChatbotFlowEditor.jsx` | Editor visual de flow, nos, URA, audio, midia, etiqueta, wait e finish | Sim, via UI | Legado/local-api | Nao diretamente | `/api/local/chatbot/assets` e `/flows` | Salva flows que o runtime legado pode executar |
| `src/lib/chatbot-flows-api.js` | Cliente HTTP do chatbot | Sim | Legado/local-api | Indiretamente via process-conversation | `/api/local/chatbot/*` | Chama processamento que pode disparar envio real se runtime habilitado |
| `src/lib/chatbot-runtime.js` | Heuristicas do frontend para detectar mensagem nova e flow ativo | Sim | Legado/local-api | Nao | Cache do frontend | Gatilho tambem pode nascer no browser se habilitado |
| `src/components/layout/SiteNotificationBridge.jsx` | Processamento em background do chatbot no frontend | Parcial | Legado/local-api | Indiretamente | `processChatbotConversation` | Evita polling agressivo, mas ainda e runtime fora dos workers novos |
| `server/local-api.mjs` | Runtime principal do chatbot local, store, assets, events, process-incoming/process-conversation | Sim | Legado | Sim | `store.json`/`tvassist_json_store`, WhatsApp API local | Chama `/api/whatsapp/send-*`, nao a nova fila outbound |
| `server/whatsapp-server.js` | Runtime legado de support flows e ponte para local chatbot | Sim em caminho legado | Legado | Sim | Meta direta e API WhatsApp local | Pode chamar Meta direta em flows de suporte |
| `server/flow-store.js` | Store PostgreSQL de support flows (`flows`, `flow_runs`, `flow_sessions`) | Condicional | Legado paralelo/PostgreSQL proprio | Nao | `DATABASE_URL`/`SQL_STORE_DATABASE_URL` | Nao usa tabelas novas `conversations/messages` como fonte principal |
| `server/flow-engine.js` | Motor de plano de support flows | Condicional | Legado paralelo | Nao, so monta outputs | `flow-store` | A execucao real acontece em `whatsapp-server.js` |
| `server/maistv-routine-worker.mjs` e rotinas | Rotinas/schedules | Desligado nesta fase | Legado/local-api | Sim se ativado | Scheduler/worker | Fora do escopo, manter desligado |
| `server/workers/automations.worker.mjs` | Worker BullMQ de automations | Inativo nesta fase | Nova fila, mas nao integrada ao chatbot legado | Nao validado | BullMQ | Nao usar como chatbot nesta fase |

## Onde ficam os fluxos

Existem dois modelos:

1. Chatbot do painel:
   - Armazenado no main store (`server/data/store.json`) ou na camada SQL/SQLite `tvassist_json_store` com chave `main_store`.
   - Campos principais: `chatbotFlows`, `chatbotAssets`, `chatbotExecutions`, `chatbotEvents`.
   - Rotas: `/api/local/chatbot/flows`, `/api/local/chatbot/runtime-state`, `/api/local/chatbot/process-conversation`, `/api/local/chatbot/process-incoming`.

2. Support flows do backend legado:
   - Armazenados em tabelas `flows`, `flow_runs`, `flow_sessions` por `server/flow-store.js`.
   - Usam `SQL_STORE_DATABASE_URL`/`DATABASE_URL` e schema configuravel.
   - Sao executados em `whatsapp-server.js` por `executeMatchingFlowForSupportMessage`.

## Gatilhos identificados

- Chatbot do painel inicia quando existe flow ativo e o no `chatbot-start` casa com `last_message`.
- Pode ser chamado por frontend em `SiteNotificationBridge.jsx`.
- Pode ser chamado por backend em `/api/local/chatbot/process-incoming`, usado pelo webhook legado.
- O backend runtime legado tambem pode varrer conversas se `CHATBOT_BACKEND_RUNTIME_ENABLED` estiver ativo.
- Support flows sao disparados em toda mensagem inbound do caminho legado, se `SUPPORT_FLOW_EXECUTION_ENABLED=true` e houver `DATABASE_URL`.

Nao ha filtro forte por rota/numero no runtime do chatbot do painel. A rota (`meta_route_key`) e passada ao envio, mas nao aparece como criterio obrigatorio para iniciar flow.

## Como envia mensagens

O chatbot do painel nao usa a nova rota `/api/messages/send`.

Ele chama a API WhatsApp local:

- `/api/whatsapp/send-text`
- `/api/whatsapp/send-image`
- `/api/whatsapp/send-document`
- `/api/whatsapp/send-video`
- `/api/whatsapp/send-audio`
- `/api/whatsapp/send-interactive`

Essas chamadas passam `origin: "chatbot"` e `agentName: "Bot"`. Portanto, antes de teste real, o envio precisa ser migrado para:

```txt
chatbot decide
-> registra acao/resposta
-> /api/messages/send ou servico interno equivalente
-> job outbound
-> worker outbound
-> Meta
-> status
-> SSE
```

## Dry-run criado

Foi adicionado suporte a:

```env
CHATBOT_ENABLED=false
CHATBOT_DRY_RUN=true
```

Com `CHATBOT_ENABLED=false`, `server/local-api.mjs` responde sem processar o chatbot real.

Com `CHATBOT_DRY_RUN=true`, `server/local-api.mjs` faz apenas a avaliacao inicial em memoria, registra log estruturado e nao executa `runChatbotFlow`, nao chama `/api/whatsapp/send-*` e nao altera o store.

Tambem foi criado o comando offline:

```bash
npm run chatbot:dry-run -- --route vendas --text "oi"
npm run chatbot:dry-run -- --route vendas --text "quero contratar"
npm run chatbot:dry-run -- --route vendas --text "suporte"
npm run chatbot:dry-run -- --route vendas --text "falar com atendente"
npm run chatbot:dry-run -- --route vendas --all
```

O script le o store via JSON ou `readJsonBackedStore`, gera inventario dos flows e mostra `wouldSend` sem chamada externa.

## Auditoria PostgreSQL dos fluxos importados

Depois da migration `005_chatbot_postgres_storage.sql` e da importacao dos 14 fluxos como `draft`, a auditoria oficial deve ler o PostgreSQL:

```bash
npm run chatbot:flows:report -- --source postgres --json
npm run chatbot:flows:validate -- --source postgres --json
```

O relatorio lista, por fluxo:

- id, nome, status, `is_active`, `route_key`, versao atual e checksum;
- quantidade de nos, respostas, condicoes e delays;
- gatilho;
- uso de midia;
- uso de template/HSM;
- handoff humano;
- fallback;
- encerramento;
- origem legado;
- problemas e classificacao de risco.

O validador aponta bloqueadores como:

- fluxo sem no inicial;
- referencia quebrada para no inexistente;
- possivel loop sem limite;
- fluxo sem fallback;
- fluxo sem handoff humano;
- delay perigoso;
- template sem nome;
- midia sem arquivo;
- fluxo sem `route_key`;
- referencia a rota legada `/api/whatsapp/send-*`.

Classificacao:

- `baixo risco`: fluxo simples, sem delay/template/midia e com handoff.
- `medio risco`: multiplas etapas, condicao, etiqueta ou fallback.
- `alto risco`: muitas mensagens, delay, template, cobranca/venda/reconquista.
- `bloqueado`: bloqueador estrutural ou regra de seguranca violada.

Observacao: como os 14 fluxos foram importados sem rota, o validador deve apontar `missing_route_key` ate que um unico fluxo seja escolhido para dry-run e publicado com rota controlada.

## Publicacao controlada para dry-run

Para permitir que o dry-run encontre exatamente um fluxo ativo no PostgreSQL, existe um comando especifico:

```bash
npm run chatbot:flows:publish-dry-run -- --flow-id <id> --route vendas --confirm --json
```

Ele exige as flags seguras no ambiente:

```env
CHATBOT_ENABLED=false
CHATBOT_DRY_RUN=true
CHATBOT_BACKEND_RUNTIME_ENABLED=false
CHATBOT_FRONTEND_PROCESSING_ENABLED=false
SUPPORT_FLOW_EXECUTION_ENABLED=false
CHATBOT_FLOW_SOURCE=postgres
```

O comando:

- exige `--confirm` para alterar banco;
- publica apenas o flow informado;
- define `status='published'`, `is_active=true` e `route_key=<route>`;
- recusa publicar se ja existir outro flow `published/is_active`;
- recusa `alto risco` ou `bloqueado` sem `--force-risk`;
- nao chama Meta;
- nao cria outbound;
- nao envia mensagem real.

Para voltar o fluxo escolhido para `draft` ao final:

```bash
npm run chatbot:flows:publish-dry-run -- --flow-id <id> --draft --confirm --json
```

Com um fluxo publicado apenas para dry-run, as simulacoes esperadas sao:

```bash
npm run chatbot:dry-run -- --route vendas --text "oi" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "ola" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "quero contratar" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "suporte" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "falar com atendente" --source postgres --json
npm run chatbot:dry-run -- --route vendas --text "nao entendi" --source postgres --json
npm run chatbot:dry-run -- --route vendas2 --text "oi" --source postgres --json
```

Todo resultado de dry-run deve manter:

- `createsOutboundJob: false`;
- `callsMeta: false`;
- `mutatesMessages: false`.

## Regras de seguranca

Existentes:

- Cache/in-flight por chave de mensagem no `local-api`.
- Janela de frescor de mensagem por `CHATBOT_TRIGGER_FRESH_WINDOW_MS`.
- Sessao por conversa em `chatbotExecutions.sessions`.
- Estados `active`, `waiting_timer`, `awaiting_ura`, `finished`.
- Timeout de URA.
- Guard de 50 nos no runtime local.
- Eventos `started` e `finished`.
- `CHATBOT_BACKEND_RUNTIME_ENABLED` permite desligar runtime backend.
- Novo `CHATBOT_ENABLED=false` desliga o runtime local.
- Novo `CHATBOT_DRY_RUN=true` bloqueia execucao real.

Ausentes ou insuficientes:

- Separacao obrigatoria por rota/numero antes de iniciar flow.
- Handoff humano robusto antes de responder.
- Pausa explicita por atendente/conversa.
- Limite por minuto/conversa.
- Controle explicito de janela de 24h antes de enviar texto livre.
- Uso de template quando fora da janela.
- Integracao com `conversations/messages` da nova arquitetura.
- Uso da nova fila outbound.
- Garantia de nao responder conversa humana ativa.
- Relatorio persistente de cada decisao dry-run em tabela auditavel.

## Compatibilidade com a nova arquitetura

Parcial e insuficiente para teste real.

O chatbot atual ainda depende de store legado/local-api e envio por API WhatsApp local. Ele nao cria `messages` pela nova arquitetura, nao cria job `outbound` BullMQ, nao depende do `outbound.worker.mjs` novo e nao usa SSE/status do novo chat como trilha principal.

## Recomendacao final

Status: parcialmente pronto apenas para auditoria.

Atualizacao: a fonte oficial planejada para os flows passou a ser PostgreSQL. Consulte `docs/chatbot-postgres-storage.md`.

Nao aprovar teste real do chatbot ainda. Primeiro aplicar a migration PostgreSQL, importar o legado como `draft`, validar dry-run com `CHATBOT_ENABLED=false` e `CHATBOT_DRY_RUN=true`, confirmar se ha flows publicados/ativos e corrigir os bloqueadores: editor ainda legado, handoff humano, janela de 24h, anti-loop e migracao do envio para a nova fila outbound.
