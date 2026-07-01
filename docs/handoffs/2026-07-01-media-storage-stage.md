# Handoff: etapa de storage e midia inbound da MaisTV

Data: 2026-07-01

## Objetivo e limites

A MaisTV homolog esta isolada em `/root/MaisTV`; a SaasTV em `/root/SaasTV` continua producao. Esta etapa prepara R2/S3 e midia inbound. Nao fazer cutover completo, nao ativar outbound, rotinas, schedulers ou assignment worker, nao alterar SaasTV e nao redirecionar novas rotas sem autorizacao explicita.

## Estado anterior confirmado

- PostgreSQL e Redis isolados estavam saudaveis.
- SSE estava saudavel.
- Inbound de texto da rota `vendas` foi homologado em tempo real.
- Cutover foi removido depois do teste.
- `maistv-next-chat-worker@media` estava ativo com 6 jobs failed por storage ausente.
- Outbound, worker legado, rotinas e assignment permaneciam desligados.

## Implementacao local desta etapa

- Storage S3/R2 agora valida provider, aceita AWS sem endpoint, aplica `forcePathStyle`, TTL configuravel, `PUT`, `GET`, `HEAD`, `DELETE` e signed URL.
- Worker de midia escolhe token Meta por `phone_number_id`, usa fallback da rota persistida para jobs antigos, tem chaves idempotentes, hash SHA-256, Pino, estado processing/failed/available e evento SSE.
- Imagem gera JPEG thumbnail; audio/documento/video nao tentam thumbnail invalida.
- `media_files` ganhou auditoria, metadados, erro, timestamps e hash; `messages` ganhou `transcription_json`.
- Midia agora e vinculada ao `message_id` na mesma transacao inbound.
- API de mensagens devolve estado e metadados reais da midia.
- `media_updated` invalida o cache React Query da conversa por SSE.
- Documento pede signed URL apenas no clique; audio ativa URL no clique de reproducao; original da imagem/video e resolvido ao abrir/ativar.
- Transcricao do chat novo le o audio do storage, chama Whisper, persiste no PostgreSQL e publica atualizacao SSE; falha nao quebra o chat.
- Scripts adicionados para smoke test do bucket e relatorio/retry auditavel dos jobs falhos.
- Migrador corrigido para aplicar todos os arquivos SQL em ordem e registrar `chat_schema_migrations`.

## Validacao realizada localmente

- `npm run lint`: passou.
- `npm run build`: passou.
- `git diff --check`: passou.
- `node --check` nos novos servicos/scripts: passou.
- Parser R2/S3/TTL: passou com configuracao sintetica.
- Normalizacao de documento Meta com filename/MIME: passou com payload sintetico.
- `npm run typecheck`: continua falhando por muitos erros preexistentes e globais do projeto; nao e gate confiavel desta etapa.
- A validacao renderizada no browser local foi bloqueada pela politica do ambiente para `127.0.0.1`; nao houve fallback para outro navegador.
- A tentativa de inspecao somente leitura da VPS nao iniciou porque o ambiente atingiu o limite de aprovacoes de rede; nenhuma alteracao remota foi feita.

## Pendencias obrigatorias

1. Criar/selecionar bucket privado R2/S3 e credencial limitada ao bucket.
2. Preencher `/etc/maistv-next/maistv-next.env` com os nove campos de storage e manter `0600`.
3. Aplicar migration `002`, publicar backend/frontend e reiniciar apenas API e media worker.
4. Rodar `npm run storage:test -- --confirm`.
5. Gerar relatorio dos 6 jobs, reprocessar e gerar relatorio final; nao apagar jobs.
6. Confirmar que os seis IDs Meta ainda sao baixaveis e quais tipos representam.
7. Homologar imagem/audio/documento/video real somente quando houver autorizacao explicita de rota ou payloads Meta validos.
8. Validar lazy loading, clique, play, console e SSE no frontend publicado.
9. Instalar/ativar `maistv-next-transcription.service` somente se a homologacao de transcricao for autorizada; isso nao e scheduler nem outbound.
10. Conferir fila media sem failed, tabela `media_files` e logs Pino.

## Decisao atual

A etapa ainda nao esta aprovada para producao. O codigo e o runbook estao preparados e passaram lint/build, mas credenciais/bucket, reprocessamento real, testes inbound dos quatro tipos, transcricao real e QA no frontend publicado ainda nao foram executados.

O procedimento completo e os comandos estao em `docs/media-storage-homologation.md`.
