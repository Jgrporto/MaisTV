# Handoff - sequenciamento do chatbot PostgreSQL

Data: 2026-07-01

## Objetivo

Corrigir a inversao de outputs do chatbot PostgreSQL mantendo todos os fluxos publicados/ativos em homologacao. O caminho oficial continua runtime PostgreSQL -> BullMQ outbound -> worker outbound -> Meta.

## Diagnostico confirmado

O runtime anterior iterava todos os outputs e criava um job BullMQ para cada um imediatamente. Como o outbound worker processa com concorrencia global, a Meta podia aceitar a URA antes da mensagem de boas-vindas.

## Implementado localmente

- Migration `006_chatbot_output_sequencing.sql` com batches, itens, estados, FKs e indices unicos.
- Apenas o output zero e criado/enfileirado inicialmente.
- O proximo output so e criado depois que a Meta retorna o ID do output atual.
- Falha explicita ou resultado incerto interrompe o batch e nao libera itens posteriores.
- Advisory lock transacional por tenant/conversa.
- Um batch por inbound e no maximo um batch ativo por conversa, garantidos no PostgreSQL.
- Selecao deterministica: priority, especificidade do gatilho, rota exata, versao atual, updated_at e id.
- Auditoria completa em `chatbot_events`.
- Normalizacao de text, button e interactive, incluindo title, payload, id, numero, edge e target node.
- Guardrail para conversa atribuida a humano.
- Jobs residuais sao bloqueados antes da chamada Meta quando o batch/item nao autoriza envio.
- Envio manual fica fora da sequencia porque nao possui `origin=chatbot-postgres`.
- Relatorio read-only `npm run chatbot:sequence:report`.

## Validacao local executada

- `npm run chatbot:sequence:test`: 4/4 testes passaram.
- `npm run lint`: passou.
- `npm run build`: passou.
- `node --check` no runtime, sequence service e outbound worker: passou.
- `git diff --check`: passou; somente avisos de conversao LF/CRLF.
- O dry-run foi invocado localmente, mas retornou `postgres_unavailable` porque esta estacao nao tem as credenciais PostgreSQL da VPS. Nao houve chamada Meta nem mutacao.

## Estado que ainda nao foi validado

- A migration 006 ainda nao foi aplicada na VPS por esta entrega local.
- O codigo ainda nao foi publicado/deployado na VPS.
- `#testeBot` ainda nao foi testado com esta correcao no WhatsApp.
- TV, Celular, 1, 2, cliques e texto invalido ainda nao foram validados live.
- Estado final de batches, sessions, events e fila outbound ainda depende do deploy/teste.
- O envio manual precisa de regressao live depois do deploy.

## Restricoes preservadas

- Nao alterar `/root/SaasTV`.
- Nao ativar rotinas, schedulers, envio em massa ou novas rotas.
- Manter apenas `vendas` em `CHATBOT_POSTGRES_ALLOWED_ROUTES`.
- Nao parar o outbound worker no rollback, pois ele atende envio manual.
- Nao chamar Meta no runtime e nao voltar para `/api/whatsapp/send-*`.

## Proximo passo

Seguir `docs/chatbot-sequencing-homologation.md`: publicar o codigo, aplicar a migration, reiniciar somente inbound/outbound da MaisTV, executar dry-run conectado, realizar os testes WhatsApp e coletar o relatorio consolidado.

## Veredito atual

Implementacao local aprovada pelos gates estaticos e testes unitarios. Sequenciamento live ainda **nao aprovado** ate concluir a homologacao na VPS.
