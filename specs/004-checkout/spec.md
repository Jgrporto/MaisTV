# SPEC: Checkout

## Objetivo

Definir a tela de Checkout do MaisTV (`src/pages/Checkout.jsx` + `server/checkout-server.js`), sem incluir o fluxo de renovação automática do NewBR.

## Contexto

O projeto tem hoje dois pontos relacionados a cobrança/renovação:

1. A tela **Checkout** dentro do próprio MaisTV (`src/pages/Checkout.jsx`, `server/checkout-server.js`), integrada ao fluxo de atendimento.
2. O subprojeto **`Checkout-Renovacao/`**, um serviço separado (backend Flask/Gunicorn + frontend estático) para renovação automática via NewBR/Mercado Pago, com Web Worker de login e captura de token, documentado em `Checkout-Renovacao/README.md`.

Por decisão do usuário em 2026-07-20, esta rodada de trabalho cobre **apenas a tela de Checkout** (item 1). A renovação automática (`Checkout-Renovacao/`) fica explicitamente de fora por enquanto.

## Escopo

- Nenhum redesenho funcional necessário: comparação feita em 2026-07-20 mostrou que `src/pages/Checkout.jsx` e `server/checkout-server.js` são **funcionalmente idênticos** entre MaisTV e SaasTV (branch `codex/general-flow-postgres-integration`) — mesmas rotas, mesmos payloads, mesma lógica.
- A única diferença real é operacional, não funcional: `checkout-server.js` do MaisTV usa `CHECKOUT_SERVER_HOST` para bind explícito de host (relevante para a topologia de deploy isolado descrita em `007-deploy-infra`); o SaasTV usa bind padrão. Preservar o comportamento do MaisTV.
- `ALTERACOES_CHECKOUT_RENOVACAO.md` do SaasTV documenta apenas mudanças de renovação automática (endpoints `POST /api/checkout/newbr/authorize`, `GET /api/checkout/renewals/customer-status`, novos status), que já existem de forma equivalente no `checkout-server.js` do próprio MaisTV — não há nada a portar aqui, e o assunto é fora de escopo de qualquer forma (ver abaixo).
- Ao redesenhar visualmente a tela em `002-frontend-ui`, tratar Checkout como tela estável: qualquer mudança visual não precisa reconciliar lógica de backend divergente, porque não há divergência.

## Fora de escopo

- `Checkout-Renovacao/` (serviço de renovação automática NewBR/Mercado Pago) — fica parado, sem alterações, até decisão explícita futura.
- Qualquer alteração em pagamento real, tokens ou credenciais do Mercado Pago/NewBR.
- Qualquer mudança na lógica de renovação automática dentro do próprio `checkout-server.js` (já existe e é idêntica nos dois projetos; não mexer).

## Impacto esperado

Nenhum retrabalho de lógica de checkout necessário. Esforço desta frente fica restrito a estilo/visual (se aplicável, dentro de `002-frontend-ui`) e à confirmação de que o bind de host (`CHECKOUT_SERVER_HOST`) é preservado no deploy.

## Dependências

- `002-frontend-ui` (só para eventual ajuste visual, sem mudança funcional).
- `007-deploy-infra` (preservar `CHECKOUT_SERVER_HOST`).
- `server/checkout-server.js`, `src/pages/Checkout.jsx`.

## Riscos

- Confundir o escopo desta SPEC com `Checkout-Renovacao/` durante a implementação, misturando os dois fluxos por engano.
- Nenhum risco funcional identificado na tela em si, dado que já está em paridade com o SaasTV.

## Decisões técnicas

- Renovação automática fica fora de escopo nesta fase (decisão do usuário, 2026-07-20).
- Levantamento comparativo concluído em 2026-07-20: **sem gap funcional** entre MaisTV e SaasTV nesta tela. Esta SPEC fica em estado "sem ação necessária" até que `002-frontend-ui` traga um requisito visual específico para Checkout.
