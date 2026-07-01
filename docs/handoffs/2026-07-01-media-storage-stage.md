# Handoff: etapa de storage local e midia inbound da MaisTV

Data: 2026-07-01

## Objetivo e limites

A MaisTV homolog esta isolada em `/root/MaisTV`; a SaasTV em `/root/SaasTV` continua producao. A decisao final desta etapa e usar storage local privado em `/var/lib/maistv-next/media`, protegido por Nginx `internal` e entregue via `X-Accel-Redirect`.

Nao fazer cutover completo, nao ativar outbound, rotinas, schedulers ou assignment worker, nao alterar SaasTV e nao redirecionar novas rotas sem autorizacao explicita.

## Estado anterior confirmado

- PostgreSQL e Redis isolados estavam saudaveis.
- SSE estava saudavel.
- Inbound de texto da rota `vendas` foi homologado em tempo real.
- Cutover foi removido depois do teste.
- `maistv-next-chat-worker@media` estava ativo com 6 jobs failed por storage ausente.
- Outbound, worker legado, rotinas e assignment permaneciam desligados.
- Em leitura da VPS, `/root/MaisTV` ainda estava no commit `5c13b4f`; faltavam migration `002`, scripts de midia e colunas como `media_files.sha256`.

## Implementacao local desta etapa

- `STORAGE_PROVIDER=local` adicionado sem remover suporte futuro a `s3` e `r2`.
- Storage local cria diretorios automaticamente, bloqueia path traversal, suporta write/read/head/delete e metadados sidecar.
- Rotas de midia mantem a API do frontend: `/api/media/:id/signed-url` e `/api/media/:id/thumbnail`.
- Para provider local, a API retorna URLs temporarias da propria API, assinadas por HMAC com `MEDIA_ACCESS_TOKEN_SECRET`.
- Downloads locais validam sessao, tenant, permissao de conversa, token, media e chave antes de liberar `X-Accel-Redirect`.
- Nginx homolog ganhou `location /protected-media/ { internal; alias /var/lib/maistv-next/media/; }`.
- Smoke test de storage agora cobre provider local, incluindo token temporario e bloqueio de path traversal.
- `.env.homolog.example` foi atualizado para local privado e manteve variaveis S3/R2 em branco para uso futuro.

## Validacao realizada localmente

- `node --check` nos arquivos alterados: passou.
- `npm run storage:test -- --confirm` com `STORAGE_PROVIDER=local` e pasta temporaria: passou.
- `npm run lint`: passou.
- `npm run build`: passou.
- `npm install` foi executado apenas para instalar dependencias locais; `package-lock.json` foi restaurado sem alteracao funcional.

## Pendencias obrigatorias na VPS

1. Publicar o codigo novo em `/root/MaisTV`.
2. Criar `/var/lib/maistv-next/media` com dono/permissao corretos.
3. Configurar `/etc/maistv-next/maistv-next.env` com `STORAGE_PROVIDER=local`, `LOCAL_STORAGE_ROOT`, `LOCAL_STORAGE_INTERNAL_PREFIX`, `MEDIA_SIGNED_URL_TTL_SECONDS` e `MEDIA_ACCESS_TOKEN_SECRET`.
4. Aplicar migration `002`, publicar backend/frontend e reiniciar somente API, SSE, inbound, status e media.
5. Garantir Nginx com bloco `internal` e `nginx -t` valido.
6. Rodar `npm run storage:test -- --confirm`.
7. Gerar relatorio dos 6 jobs, reprocessar e gerar relatorio final; nao apagar jobs.
8. Homologar imagem/audio/documento/video real.
9. Validar lazy loading, clique, play, console e SSE no frontend publicado.
10. Validar transcricao de audio lendo arquivo privado local.
11. Conferir fila media sem failed inesperado, tabela `media_files` e logs Pino.
12. Documentar backup futuro de `/var/lib/maistv-next/media`.

## Decisao atual

A etapa ainda nao esta aprovada para producao. O codigo local foi adaptado e validado, mas a VPS ainda precisa receber o codigo novo, aplicar migration `002`, configurar storage local privado, reprocessar jobs e passar nos testes inbound reais.

O procedimento completo e os comandos estao em `docs/media-storage-homologation.md`.
