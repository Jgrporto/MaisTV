# SPEC: Chatbot

## Objetivo

Definir o estado atual, os riscos conhecidos e o caminho de evolução do chatbot do MaisTV (editor de fluxos, runtime e envio de mensagens automáticas).

## Contexto

Existem hoje dois modelos de fluxo no MaisTV:

1. **Chatbot do painel** — `src/pages/Chatbot.jsx` e `ChatbotFlowEditor.jsx`, armazenado em `server/data/store.json` (ou SQLite `tvassist_json_store`), rotas `/api/local/chatbot/*`, executado por `server/local-api.mjs`. Envia mensagens pelas rotas legadas `/api/whatsapp/send-*`, não pela fila outbound nova.
2. **Support flows do backend legado** — `server/flow-store.js` e `server/flow-engine.js`, tabelas próprias `flows`/`flow_runs`/`flow_sessions`, executados em `server/whatsapp-server.js`.

Havia também uma tentativa de mover a fonte oficial dos fluxos para PostgreSQL (migration `005_chatbot_postgres_storage.sql`, tabelas `chatbot_flows`/`chatbot_flow_versions`/`chatbot_sessions`/`chatbot_events`, 14 fluxos legados importados como `draft`), documentada nos runbooks removidos. Nenhum fluxo chegou a ser aprovado para produção; o editor (`ChatbotFlowEditor.jsx`) continua salvando no store legado.

O SaasTV (branch `codex/general-flow-postgres-integration`) construiu, em cima de uma base equivalente, um subsistema "Flow Geral": fluxos com `role` (`general`/auxiliar), status `draft`/`published` com bloqueadores de validação, 4 tipos de nó novos (Decisor, Solicitar, Arquivo, Grupo), simulador de fluxo embutido no editor, import/export em JSON e nó `service` totalmente funcional (no MaisTV hoje é um placeholder desabilitado). Por decisão de 2026-07-20 (ver `002-frontend-ui`), esse subsistema é adotado integralmente nesta migração, com uma ressalva: o SaasTV removeu a regra de gatilho (`rule`/`triggerValue`) configurável no nó de início, que o MaisTV tem hoje — essa capacidade deve ser preservada ao portar o editor.

## Escopo

- Migrar o chatbot do painel para rodar sobre a base PostgreSQL/BullMQ definida em `001-attendance-architecture` (tabelas `chatbot_flows`/`chatbot_flow_versions`/`chatbot_sessions`/`chatbot_events` da migration `005`, já existentes), usando a fila outbound nova em vez de `/api/whatsapp/send-*`.
- Fechar, nesta migração, as lacunas de segurança já identificadas: separação obrigatória por rota/número antes de iniciar flow, handoff humano robusto, limite por minuto/conversa, controle de janela de 24h antes de enviar texto livre.
- Migrar o editor visual (`ChatbotFlowEditor.jsx`) para salvar/ler direto do PostgreSQL, em vez de `/api/local/chatbot/flows`, portando o subsistema "Flow Geral" do SaasTV (novos nós, simulador, draft/publish, import/export) e preservando a regra de gatilho do nó de início.
- Portar a aba "Flow Geral" em Configurações (fluxo geral publicado, fluxo de teste privado, filas de contingência/suporte/comercial), sem repetir a regressão do SaasTV de parar de invalidar cache de chat/atendimento após salvar.
- Decidir o destino dos 14 fluxos legados já importados como `draft` (auditar, corrigir bloqueadores, publicar um a um).

## Fora de escopo

- Manter dois runtimes de flow em paralelo além do necessário para a transição — o objetivo é consolidar em um só.
- Ativação de rotinas, schedulers ou envio em massa via chatbot.
- Support flows do backend legado (`server/flow-store.js`/`server/flow-engine.js`) — avaliar separadamente se ainda têm uso depois da consolidação do chatbot do painel.

## Impacto esperado

Chatbot passa a usar a mesma base de dados, fila e rate limit por número que o atendimento humano (`001-attendance-architecture`), eliminando um runtime de envio paralelo e as lacunas de segurança associadas a ele.

## Dependências

- `001-attendance-architecture` (decisão já tomada: evoluir base própria do MaisTV, chatbot migra junto).
- Migration `005_chatbot_postgres_storage.sql`, já aplicada localmente.
- `server/local-api.mjs` (runtime atual, a ser substituído), `ChatbotFlowEditor.jsx`.

## Riscos

- Migrar sem antes corrigir separação por rota/número pode repetir o problema atual (chatbot pode disparar mensagem sem filtro forte).
- Publicar fluxo legado sem revisão de handoff/fallback pode deixar cliente sem saída para atendimento humano.
- Dois runtimes coexistindo durante a transição (painel legado + PostgreSQL) exige que apenas um esteja realmente ativo por vez, com flags claras.

## Decisões técnicas

- Chatbot migra para o runtime PostgreSQL/fila outbound nova nesta mesma rodada de trabalho, junto com a base de atendimento (decisão de 2026-07-20, ver `001-attendance-architecture`).
- Fluxos legados são auditados e publicados individualmente, não em lote, priorizando os de menor risco primeiro.
