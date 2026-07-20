# SPEC: Fundação do Projeto

## Objetivo

Definir a fundação técnica do projeto **MaisTV** (`+TV Atendimento`), garantindo uma base organizada para frontend, backend, workers, banco e documentação por SPEC, servindo de referência para o redesenho de tela e a busca de paridade de funcionalidades com o SaasTV.

## Contexto

O MaisTV é o painel web de atendimento, conversas WhatsApp, checkout/renovação NewBR, chatbot, rotinas e dashboard da +TV. O projeto existe há tempo suficiente para acumular duas arquiteturas de dados em paralelo (JSON/SQLite legado e um início de migração para PostgreSQL/Redis/BullMQ/SSE) e documentação de deploy desatualizada, já removida (ver `001-attendance-architecture`).

A partir de agora, toda funcionalidade nova ou redesenhada deve nascer com uma SPEC em `specs/<numero>-<dominio>/spec.md`, seguindo `specs/SPEC-GUIDELINES.md`.

## Escopo

- Adotar a pasta `specs/` como fonte de verdade de requisitos e decisões, substituindo os runbooks soltos que existiam em `docs/`.
- Manter a separação existente entre `src/` (frontend Vite+React), `server/` (API local, workers, stores) e `Checkout-Renovacao/` (serviço Python separado de renovação NewBR — fora de escopo nesta rodada, ver `004-checkout`).
- Corrigir o `README.md` da raiz, removendo referências a `PROJECT_CONTEXT.md` e `docs/maintenance/deploy-vps.md`, que não existem no repositório.
- Definir o que é documentação viva (specs, README) versus o que é artefato operacional descartável (relatórios de homologação, handoffs pontuais).

## Fora de escopo

- Reescrever a arquitetura de dados nesta SPEC (decisão tratada em `001-attendance-architecture`).
- Migrar para monorepo/workspaces — o MaisTV continua um único pacote Node na raiz.
- CI/CD.

## Impacto esperado

Qualquer pessoa (ou IA) que entrar no projeto deve conseguir ler `specs/` e entender o que existe, por que existe e o que está decidido, sem depender de conversas anteriores ou de runbooks de uma janela de deploy específica.

## Dependências

- Node.js 20+, npm 10+.
- Estrutura de pastas já existente (`src/`, `server/`, `entities/`, `Checkout-Renovacao/`).

## Riscos

- Specs desatualizadas se ninguém marcar tasks/decisões conforme o código evolui.
- Duplicar informação entre `README.md` e `specs/000-project-foundation`.

## Decisões técnicas

- Método de documentação: `specs/` no formato usado no Emex-Analytics (guidelines + template + pastas numeradas por domínio).
- `docs/` antigo foi removido por inteiro (`git rm -r docs/`) em 2026-07-20 por estar desatualizado e descrever uma migração de arquitetura inacabada.
- README da raiz permanece como ponto de entrada rápido (como rodar o projeto), specs concentram o "porquê" e o "o que vem a seguir".
