# Handoff - filas e atribuicao PostgreSQL

Data: 2026-07-01

## Implementado localmente

- Migration 007 com filas, route mappings, memberships, presenca, auditoria e campos de assignment/leitura global.
- Rota inbound resolve mapeamento PostgreSQL e marca conversa como queued.
- Endpoints assign/unassign/transfer com permissao e lock de linha.
- Worker BullMQ separado, balanceado e limitado a `vendas`.
- Worker exclui admin, pausado, offline, heartbeat expirado, conversa fechada, antiga, atribuida ou com chatbot ativo.
- Presenca PostgreSQL com heartbeat, pausa e logout leve.
- Leitura global no campo `conversations.unread_count`.
- SSE atualiza atribuicao, fila, presenca e leitura.
- Frontend deixou de usar atribuição/presenca do local API legado.
- Atendente autorizado passou a visualizar a aba Filas.

## Estado live consultado antes do deploy

- assignment worker desabilitado/inativo;
- `vendas` sem queue/service no PostgreSQL;
- servico real: `service-sales` / Vendas;
- auth snapshot com apenas `user-admin`;
- 611 conversas vendas sem fila e algumas atribuicoes importadas a IDs ausentes do snapshot.

## Bloqueador para aprovacao completa

Ainda faltam atendentes reais de teste na autenticacao da homologacao e seus vinculos com `service-sales`. Sem isso nao e possivel aprovar balanceamento, pausa/offline, conflito entre atendentes e transferencia real.

## Restricoes

- nao tocar `/root/SaasTV`;
- nao mapear `vendas2/default` nesta etapa;
- nao ativar rotinas/schedulers/massa;
- nao habilitar worker antes dos testes manuais;
- nao apagar conversas antigas.

## Proximo passo

Seguir `docs/assignment-homologation.md`: deploy com worker desligado, migration, mapear `vendas -> service-sales`, disponibilizar dois atendentes de teste, validar manual e somente depois ativar produtor+worker.

## Veredito atual

Implementacao local pronta para deploy. Filas/atribuicao live ainda nao aprovadas.
