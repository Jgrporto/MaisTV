# Cutover exclusivo do webhook default

Este fluxo existe para o estado em que `vendas` e `vendas2` ja estao na MaisTV e somente
`/api/whatsapp/webhook` ainda chega a SaasTV. Ele nao altera a `location /api/`, frontend,
checkout ou qualquer outro endpoint.

## Pre-condicoes

- o include `/etc/nginx/maistv-next-webhook-cutover-enabled/*.conf` ja existe no site produtivo;
- `active.conf` aponta para um estagio com exatamente `vendas` e `vendas2`, sem o default;
- a MaisTV esta ouvindo em `127.0.0.1:5350` e seus workers/filas foram validados;
- backups de PostgreSQL, env, Nginx e systemd foram feitos antes da janela.

## Ativacao

Primeiro gere e valide o backup sem alterar o roteamento:

```bash
cd /root/MaisTV
bash scripts/backup-maistv-next-default-precutover.sh --confirm
```

O backup restrito (`0700`/`0600`) contem dump PostgreSQL em formato custom, env, site e
includes Nginx, units `maistv-next-*`, commit publicado e manifesto SHA-256. O dump e
validado com `pg_restore --list`; nenhum segredo do env e escrito no terminal.

Depois, durante a janela monitorada:

```bash
cd /root/MaisTV
bash scripts/enable-maistv-next-default-webhook-cutover.sh --confirm
```

O script valida o dominio, o include, o estagio anterior e as tres locations exatas. Depois
grava o destino anterior em `/etc/nginx/maistv-next-webhook-cutover-state`, troca o symlink
atomicamente, executa `nginx -t` e recarrega o Nginx. Falha de validacao ou reload restaura
o estagio anterior.

Ele tambem recusa o cutover se assignment/automations estiver ativo, se flags de rotinas ou
schedulers nao estiverem desligadas, se os health checks falharem, se o numero default nao
for o esperado ou se o backup nao pertencer ao commit atual.

## Rollback exclusivo

```bash
cd /root/MaisTV
bash scripts/rollback-maistv-next-default-webhook-cutover.sh --confirm
```

Este rollback devolve somente o default para a SaasTV. `vendas` e `vendas2` continuam na
MaisTV. Nao use o rollback generico nesta janela, pois ele remove todo o cutover.

Os dois scripts sao idempotentes: repetir ativacao valida o default ja ativo; repetir rollback
valida que o estagio anterior ja esta ativo, sem nova alteracao.
