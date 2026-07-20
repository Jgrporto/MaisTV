# SPEC: Autenticação e Permissões

## Objetivo

Definir autenticação, sessão e controle de acesso do MaisTV, incluindo a migração do modelo de usuários/perfis/permissões para tabelas relacionais no PostgreSQL.

## Contexto

A autenticação em si (login em `/login`, sessão por cookie HttpOnly `saastv_session`, "Manter-me conectado", `server/modules/auth/session-store.js`, `src/lib/local-auth.js`) já está em paridade completa entre MaisTV e SaasTV — comparação de 2026-07-20 não encontrou nenhuma diferença real aqui.

A divergência real está em dois pontos:

1. **Onde vivem usuários/perfis/permissões.** No MaisTV, usuários, roles, `department_key` e `settings_access` vivem no store JSON legado (via `requestLocalEntity('Role'/'User')`), sem tabelas SQL dedicadas. O SaasTV já tem um schema relacional pronto: `core.users`, `core.roles`, `core.permissions`, `core.user_roles`, `core.role_permissions`, `core.services`/`core.service_members` (migration `0002_core_crm.sql`). O frontend do SaasTV (`Settings.jsx`) ainda lê roles pela mesma abstração de "entidade" do MaisTV, então o schema mais rico ainda não está totalmente exposto na UI de permissões de lá — mas a base relacional existe e pode ser adotada.
2. **Verificação de permissão de acesso a Configurações.** `src/lib/navigation-permissions.js` é quase idêntico nos dois projetos (mesmo `canViewNavigationPermission`, mesmo `resolveUserNavigationPermissions`), com duas diferenças pontuais: MaisTV tem a permissão `tickets` (SaasTV não, consistente com não ter a tela de Tickets); e MaisTV trata `role_id === 'role-admin'` como admin, enquanto SaasTV trata `role_name === 'admin'` (bare) como admin — vale unificar as duas checagens de admin. A regressão real está em `Settings.jsx`: MaisTV usa `canViewNavigationPermission` (passa por `department_key`/`settings_access`), SaasTV reimplementou a checagem inline e **perdeu o caminho por `department_key === 'administracao'`** — um não-admin de um departamento com acesso concedido a Configurações perde esse acesso na versão do SaasTV.

O modelo de filas/presença (`support_queues`, `queue_memberships.is_assignable`, `agent_presence`, `conversation_assignment_events`, migration `007_queue_assignment.sql`) já foi decidido em `001-attendance-architecture`: o MaisTV mantém e evolui o seu próprio (não adota o modelo `chat.queue_entries`/`chat.routing_events` baseado em `service_id` do SaasTV, que é um desenho different, não superior).

## Escopo

- Migrar usuários, perfis (roles) e permissões do store JSON legado para tabelas PostgreSQL, adotando como base o schema relacional do SaasTV (`core.users`, `core.roles`, `core.permissions`, `core.user_roles`, `core.role_permissions`), adaptado para preservar os campos que o MaisTV já usa e o SaasTV não expõe na UI: `department_key`, `settings_access`, permissão `tickets`.
- Unificar a checagem de "é admin" para aceitar tanto `role_id === 'role-admin'` quanto `role_name === 'admin'`.
- Ao portar `Settings.jsx` (junto de `002-frontend-ui`), usar `canViewNavigationPermission` (o caminho completo do MaisTV) em vez da checagem inline simplificada do SaasTV, preservando o acesso por `department_key`.
- Vincular `core.user_roles`/`core.services`/`core.service_members` ao modelo de filas já decidido (`queue_memberships`) para que atribuição automática (`001-attendance-architecture`) e controle de acesso por fila usem a mesma base de usuários.
- Gerenciamento de usuários/perfis continua dentro de `Settings.jsx` (abas Team/Roles) — nenhum dos dois projetos tem uma tela dedicada separada, e não há motivo para criar uma nesta rodada.

## Fora de escopo

- SSO, MFA, OAuth externo — não fazem parte do produto atual e não estão sendo pedidos.
- Trocar a credencial padrão de admin fora do fluxo normal de gestão de usuários.
- Recriar o modelo de filas do SaasTV (`chat.queue_entries`/`chat.routing_events`) — já decidido manter o modelo próprio do MaisTV em `001-attendance-architecture`.
- Criar uma tela dedicada de gestão de usuários separada de Configurações.

## Impacto esperado

Usuários/perfis/permissões passam a viver no PostgreSQL junto do resto do sistema, eliminando a última fonte de dados relevante que ainda ficava fora do banco relacional. Acesso por departamento a Configurações é preservado (não regride como no SaasTV). Base pronta para 10+ atendentes com controle de acesso por fila consistente entre autenticação e atribuição automática.

## Dependências

- `001-attendance-architecture` (modelo de filas/presença já decidido; usuários migrados precisam se conectar a `queue_memberships`).
- `002-frontend-ui` (porta `Settings.jsx`, onde a checagem de permissão e a UI de Team/Roles vivem).
- Migration de referência: `0002_core_crm.sql` do SaasTV (`core.users`/`roles`/`permissions`/`user_roles`/`role_permissions`/`services`/`service_members`).
- `server/local-api.mjs` (origem atual dos dados de usuário/role via store JSON, a ser substituída), `src/lib/navigation-permissions.js`, `src/lib/local-auth.js` (sem mudança, já em paridade).

## Riscos

- Migrar usuários sem migrar corretamente `department_key`/`settings_access`/`tickets` (campos que o schema do SaasTV não usa) quebra o controle de acesso já validado no MaisTV — a migration adaptada precisa preservar esses campos, não só copiar o schema do SaasTV cru.
- Histórico de problema já visto: numa tentativa anterior de homologação, só existia `user-admin` no snapshot de teste, o que impediu validar atribuição/distribuição real entre atendentes. Ao migrar para tabelas relacionais, garantir que todos os usuários reais sejam migrados, não só o admin.
- Migrar sem antes corrigir a checagem de admin unificada pode deixar usuários com `role_name==='admin'` mas sem `role_id==='role-admin'` (ou vice-versa) temporariamente sem acesso administrativo.

## Decisões técnicas

Decidido em 2026-07-20:

1. Migrar usuários/perfis/permissões do store JSON para tabelas PostgreSQL, usando como base o schema relacional já existente no SaasTV (`core.users`/`roles`/`permissions`/`user_roles`/`role_permissions`/`services`/`service_members`), adaptado para preservar `department_key`, `settings_access` e a permissão `tickets`.
2. Unificar checagem de admin (`role_id === 'role-admin'` OU `role_name === 'admin'`).
3. Preservar `canViewNavigationPermission` com o caminho por `department_key` ao portar `Settings.jsx` — não adotar a checagem inline simplificada do SaasTV.
4. Modelo de filas/presença permanece o do MaisTV (`001-attendance-architecture`), não o do SaasTV — usuários migrados se conectam a `queue_memberships`, não a `service_members` como conceito de acesso primário.
