# Atendimento humano pelo canal default

Este runbook move somente `/api/whatsapp/webhook` para a MaisTV. `vendas` e `vendas2`
permanecem como estao, a `location /api/` da SaasTV nao e alterada e assignment,
automations, rotinas, schedulers e disparos continuam desligados.

## Travas

- Nao executar migration 008 novamente: o preflight deve confirmar a linha em
  `chat_schema_migrations`.
- Nao inserir `queue_memberships` manualmente. Usuarios pertencem a autenticacao legada;
  os grants reais chegam em `auth.queueIds` e `/api/presence/start` sincroniza somente filas
  ja existentes no PostgreSQL.
- O cutover recusa execucao se assignment ou automations estiver ativo, se flags perigosas
  nao estiverem `false`, se o default nao for `779406741922236`, se health falhar ou se nao
  houver backup valido do commit atual.
- O rollback exclusivo restaura o estagio anterior e preserva `vendas` e `vendas2`.

## Estado de filas validado em 2026-07-02

| Etiqueta | Fila |
|---|---|
| `system-lead` | `service-sales` |
| `system-sql` | `service-sales` |
| `system-cliente` | `service-support` |
| `system-pos-venda` | `service-onboarding` |
| `system-cancelados` | `service-onboarding` |

Use `npm run assignment:readiness:audit -- --strict` como fonte atual. Se o estado mudou,
pare e configure pelo painel; nao replique este snapshot cegamente.

## Componentes publicados nesta etapa

- cutover Nginx exclusivo e rollback atomico;
- backup PostgreSQL/env/Nginx/systemd com hashes;
- auditoria de readiness e relatorio final somente leitura;
- sincronismo de memberships limitado aos grants reais da autenticacao;
- persistencia PostgreSQL/BullMQ de URA e botoes interativos;
- templates/HSM forcados ao canal default;
- testes do default, janela de 24h e interactive payload.

## Evidencia final

Execute o relatorio com o telefone controlado depois dos testes:

```bash
npm run default:cutover:report -- \
  --customer 5524999157259 \
  --output scripts/reports/default-cutover-final.json
```

O relatorio nao envia mensagens, nao reprocessa e nao remove jobs. A aprovacao final ainda
exige teste humano real no navegador e WhatsApp: inbound default, visibilidade, assumir,
texto, resposta rapida, imagem, audio, documento, video, reload de midia, unread e SSE.
