# SPEC: HSM e Templates

## Objetivo

Definir o funcionamento da tela de HSMs (`src/pages/Hsms.jsx`) e a integração com templates da Meta (WhatsApp Cloud API).

## Contexto

Segundo o `README.md` atual, a tela `HSMs` usa `VITE_WHATSAPP_API_BASE_URL` para integração com os templates da Meta. Números adicionais são descobertos via `VITE_WHATSAPP_API_ADDITIONAL_BASE_URLS`/`VITE_WHATSAPP_KNOWN_NUMBERS` em Configurações > Serviços. `server/template-media-url.js` participa dessa integração.

## Escopo

- Nenhum redesenho funcional necessário no caminho de templates: comparação feita em 2026-07-20 mostrou que `server/template-media-url.js`, `src/lib/hsm-api.js` e `src/components/hsm/HsmSection.jsx` são **byte-idênticos** entre MaisTV e SaasTV. A busca/envio de templates HSM em si já está em paridade.
- Diferença real encontrada, uma camada abaixo: o seletor de fila/serviço que a tela HSM também carrega (`src/lib/services-api.js`, usado por `HsmSection.jsx`) usa fontes de dado diferentes nos dois projetos — MaisTV chama `/api/queues` (chat-api), SaasTV chama `/entities/Service?sort=name` (local-api genérico). Essa divergência precisa ser resolvida em conjunto com o modelo de filas decidido em `001-attendance-architecture` (que já prevê `support_queues`/`queue_memberships` no PostgreSQL) — não é um problema isolado da tela HSM.
- O SaasTV também tem `fetchAvailableWhatsappNumbers()` (descoberta de números via `VITE_WHATSAPP_API_DISCOVERY_URLS`/`VITE_WHATSAPP_API_ADDITIONAL_BASE_URLS`/`VITE_WHATSAPP_KNOWN_NUMBERS`/`VITE_WHATSAPP_EXCLUDED_NUMBERS`), mas essa função só é usada em `Settings.jsx` (já coberto em `002-frontend-ui`), não em `HsmSection.jsx` — não afeta esta SPEC.

## Fora de escopo

- Alterações na integração com a API da Meta em si.
- Envio em massa via HSM (tratado, se necessário, em SPEC própria).
- Redesenho visual da tela HSM em si — sem gap funcional a resolver, eventual ajuste visual fica em `002-frontend-ui`.

## Impacto esperado

Fluxo de templates HSM confirmado em paridade; único ponto de atenção é migrar o seletor de fila/serviço para a mesma fonte de dado que o resto do atendimento usar, evitando que a tela HSM fique lendo de uma API de filas diferente do restante do sistema.

## Dependências

- `001-attendance-architecture` (fonte de dado definitiva para filas/serviços — decide se `services-api.js` migra para o modelo PostgreSQL de filas).
- `VITE_WHATSAPP_API_BASE_URL` (nota: não está de fato documentada em nenhum dos dois `.env.example`, apenas `WHATSAPP_API_BASE_URL`/`LOCAL_WHATSAPP_API_BASE_URL` — corrigir o `README.md` do MaisTV, que cita a variável errada), `server/template-media-url.js`.

## Riscos

- Migrar o seletor de fila da HSM para o modelo Postgres sem coordenar com `001-attendance-architecture` pode criar uma terceira fonte de dado de filas, em vez de unificar.

## Decisões técnicas

- Levantamento comparativo concluído em 2026-07-20: **sem gap funcional** no fluxo de templates HSM em si.
- O seletor de fila/serviço da tela HSM deve migrar para a mesma fonte de dado de filas que `001-attendance-architecture` definir como padrão (ainda pendente de execução, não de decisão — a decisão de arquitetura já foi tomada).
