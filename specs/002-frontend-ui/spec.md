# SPEC: Redesenho de Frontend

## Objetivo

Redesenhar a interface do MaisTV incorporando as funcionalidades que hoje existem no SaasTV (branch `codex/general-flow-postgres-integration`) e não existem no MaisTV, sem perder capacidades que o MaisTV já tem e o SaasTV descartou, na tela de Atendimento em especial.

## Contexto

Levantamento página a página (2026-07-20) comparando `src/pages/` do MaisTV com o worktree do SaasTV em `codex/general-flow-postgres-integration`. Conclusão geral: as páginas têm nomes idênticos (exceto `Tickets.jsx`, exclusiva do MaisTV), mas o SaasTV reescreveu a arquitetura de dados da tela de Atendimento e construiu um subsistema novo de chatbot ("Flow Geral"), enquanto simplificou/removeu algumas capacidades de robustez que o MaisTV já tinha.

### Attendance.jsx — maior divergência

O SaasTV move o cálculo pesado (buckets de conversa, labels, contagens, controle de acesso) para o backend via um único endpoint (`fetchAttendanceConversations`), em vez do pipeline client-side do MaisTV (enriquecimento de labels/serviços/bucket no navegador). Isso é uma melhoria estrutural real — inclusive de segurança, já que o controle de acesso deixa de depender só do frontend.

**O que o SaasTV tem e o MaisTV não:**
- Contagem por aba (`counts: {all, queue, chatbot, resolved, unread}`) e carregamento adiado da aba "Resolvidos".
- Fila de reconciliação SSE com lote (até 100 IDs), cooldown de 1s por ID, cache negativo de 30s, backoff de retry e recuperação por full-sync throttled.
- Mapa de alias de conversa (resolve por `conversationId`, telefone, IDs sintéticos) para SSE bater no cache certo antes do ID canônico ser conhecido.
- Patch otimista de conversa a partir do próprio payload SSE, sem esperar refetch.
- Tela de splash "Sincronizando conversas" no primeiro carregamento.
- Aba "Chatbot" dedicada na lista de conversas, com badge nas conversas sob controle do bot.
- Busca sem distinção de acento, com correspondência dedicada por dígitos de telefone (`lib/attendance-search.js`).
- Scroll por aba lembrado ao trocar de filtro.
- No `ChatWindow`: takeover automático de conversa do bot pelo admin, alerta de renovação/checkout inline, fluxo "marcar como teste" (NewBR), leitura explícita via API (`markAttendanceConversationRead`), carregamento de mensagens em janelas com fallback a histórico separado.

**O que o MaisTV tem e o SaasTV descartou (recuperar no redesenho, por decisão de 2026-07-20):**
- Scroll infinito/paginação da lista de conversas — o SaasTV carrega tudo de uma vez, o que não escala com alto volume.
- Heartbeat de presença — as funções (`startAttendancePresence`, liderança de aba via `presence-leadership.js`) existem no código do SaasTV mas nunca são chamadas.
- Carregamento lazy/progressivo de mídia com placeholders de estado (`LazyMedia`, `MediaLoadingPlaceholder`) — o SaasTV renderiza `attachment.url` direto, sem estado de carregamento nem erro de documento.
- Virtualização da lista de mensagens (`VirtualizedMessageThread`) — o SaasTV não virtualiza, threads longas renderizam todo o DOM.
- Merge de detalhe de cliente (senha/plano/vencimento) ao abrir a conversa — a função correspondente foi removida do SaasTV.

### Chatbot / ChatbotFlowEditor — "Flow Geral"

O SaasTV construiu um subsistema novo, adotado nesta rodada (decisão de 2026-07-20):
- Conceito de fluxo com `role` (`general` vs auxiliar), status `draft`/`published`, badge de bloqueadores de validação.
- 4 tipos de nó novos: Decisor (condicional), Solicitar (captura de variável com validação/máscara/timeout), Arquivo (upload), Grupo (container visual).
- Simulador de fluxo embutido no editor (chat de teste sem sair da tela).
- Import/export de fluxo em JSON.
- Aba "Chatbot" em Configurações, com fluxo geral publicado, fluxo de teste privado e filas de contingência/suporte/comercial.
- Nó `service` totalmente funcional (no MaisTV hoje é um placeholder desabilitado).

**Perda a recuperar**: o SaasTV removeu a regra de gatilho (`rule`/`triggerValue`) configurável diretamente no nó de início — o MaisTV tem isso hoje e deve ser preservado ao portar o editor novo.

### Demais telas

- **Tickets.jsx**: exclusiva do MaisTV, mantida por decisão de 2026-07-20 (sistema completo de status/prioridade/comentários/anexos, painel lateral no chat).
- **Settings.jsx**: SaasTV ganha aba "Flow Geral" (adotar, acompanha o chatbot) e coluna de números WhatsApp por serviço; mas perde granularidade de permissão por departamento (`canViewNavigationPermission`) e para de invalidar cache de chat/atendimento após salvar configurações — **ambas são regressões a evitar ao portar**, não a copiar.
- **Checkout.jsx, Login.jsx, Hsms.jsx, Dashboard.jsx, QuickReplies.jsx**: sem diferença funcional relevante entre os dois projetos.
- **CustomerBase.jsx, EnvioEmMassa.jsx, Labels.jsx, QueuesServices.jsx, Rotinas.jsx**: diferenças pequenas e internas (renomes de função, chaves de cache); atenção a um ponto real: no SaasTV, o cálculo de janela de 24h no Envio em Massa passou a ser feito no frontend com constante fixa em vez de vir do backend — validar se essa mudança é intencional antes de portar.

## Escopo

- Redesenhar `Attendance.jsx` com a arquitetura server-side do SaasTV (endpoint único, buckets/contagens/controle de acesso no backend) **e** as 5 capacidades de robustez do MaisTV recuperadas (scroll infinito, heartbeat de presença, mídia lazy, virtualização de mensagens, detalhe de cliente ao abrir conversa).
- Portar o subsistema "Flow Geral" do chatbot (novos nós, simulador, draft/publish, import/export), preservando a regra de gatilho do nó de início que o MaisTV já tem.
- Portar a aba "Flow Geral" em Configurações, sem repetir as duas regressões identificadas (permissão por departamento e invalidação de cache pós-save).
- Manter o sistema de Tickets como está, integrando-o à nova tela de Atendimento redesenhada.
- Reorganizar hooks de chat (`src/features/chat/hooks/`) preservando a estrutura reutilizável do MaisTV, mas incorporando a lógica de robustez SSE do SaasTV (fila de reconciliação, alias map, patch otimista) — portar a lógica para dentro da estrutura de hooks, não adotar o código todo inline como o SaasTV fez.

## Fora de escopo

- Renovação automática NewBR (`Checkout-Renovacao/`) — segue fora, conforme `004-checkout`.
- Reescrever páginas sem diferença funcional relevante (Login, Hsms, Dashboard, QuickReplies) nesta rodada.
- Migrar `EnvioEmMassa.jsx` para o cálculo de janela 24h client-side do SaasTV sem antes validar se diverge da lógica real do backend.
- Qualquer decisão de arquitetura de dados já coberta por `001-attendance-architecture` — esta SPEC assume esse modelo pronto.

## Impacto esperado

Tela de Atendimento com a robustez de tempo real do SaasTV e a estabilidade de performance/UX que o MaisTV já tinha, sem repetir as regressões identificadas. Chatbot com fluxo de publicação seguro (simulador + draft/publish) alinhado à migração de arquitetura decidida em `003-chatbot`. Nenhuma funcionalidade real perdida na transição (Tickets mantido).

## Dependências

- `001-attendance-architecture` (o endpoint único `fetchAttendanceConversations` e os buckets server-side pressupõem a base Postgres/BullMQ/SSE já decidida).
- `003-chatbot` (o "Flow Geral" e a migração de runtime do chatbot são a mesma frente de trabalho).
- Componentes de referência no worktree SaasTV: `src/pages/Attendance.jsx`, `src/components/chat/ChatWindow.jsx`, `src/components/chat/ConversationList.jsx`, `src/lib/attendance-api.js`, `src/lib/attendance-realtime-queue.js`, `src/lib/attendance-search.js`, `src/pages/ChatbotFlowEditor.jsx`.
- Componentes do MaisTV a preservar/portar: `src/features/chat/components/VirtualizedMessageThread.jsx`, `src/features/chat/components/LazyMedia.jsx`, `src/lib/presence-leadership.js`, `src/lib/tickets-api.js`, `src/components/chat/TicketSidePanel.jsx`.

## Riscos

- Portar as duas arquiteturas (server-side buckets do SaasTV + robustez client-side do MaisTV) ao mesmo tempo é o item de maior esforço desta SPEC — risco de ficar num meio-termo instável se não for bem sequenciado.
- Duplicar lógica de roteamento de resposta (`resolveConversationReplyRouteSelector`) já existe nos dois projetos de forma diferente (módulo compartilhado no MaisTV, inline no SaasTV) — consolidar em um só lugar durante o port, não manter as duas versões.
- Settings.jsx do SaasTV tem uma regressão real (parar de invalidar cache de chat/atendimento após salvar) — portar sem corrigir isso introduz um bug conhecido.

## Decisões técnicas

Decididas em 2026-07-20:

1. **Tickets**: mantido no redesenho, integrado à nova tela de Atendimento.
2. **Regressões do SaasTV** (scroll infinito, heartbeat de presença, mídia lazy, virtualização, detalhe de cliente): todas recuperadas no redesenho, não adotar a versão simplificada do SaasTV nesses 5 pontos.
3. **Flow Geral (chatbot)**: adotado integralmente (novos nós, simulador, draft/publish, import/export), preservando a regra de gatilho do nó de início que o SaasTV removeu.
4. Consolidar lógica duplicada entre os dois projetos (roteamento de resposta, cache patching) em um único módulo compartilhado ao portar, em vez de manter implementações paralelas.
