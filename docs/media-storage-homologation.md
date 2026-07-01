# Homologacao de midia inbound com R2/S3

Este runbook e exclusivo da instalacao isolada `/root/MaisTV`. Ele nao altera `/root/SaasTV`, nao ativa outbound, rotinas, schedulers ou novas rotas de webhook.

## Configuracao recomendada para Cloudflare R2

Crie um bucket privado dedicado, por exemplo `maistv-homolog-media`, e uma credencial R2 limitada a leitura e escrita nesse bucket. Nao habilite acesso publico se a aplicacao usar URLs assinadas.

```dotenv
STORAGE_PROVIDER=r2
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=maistv-homolog-media
S3_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
S3_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
S3_PUBLIC_BASE_URL=
S3_FORCE_PATH_STYLE=false
MEDIA_SIGNED_URL_TTL_SECONDS=300
```

Para AWS S3, use `STORAGE_PROVIDER=s3`, a regiao real, deixe `S3_ENDPOINT` vazio e mantenha `S3_FORCE_PATH_STYLE=false`. Para MinIO/outro S3 compativel, informe o endpoint e use `S3_FORCE_PATH_STYLE=true` apenas se o provedor exigir.

O arquivo real e `/etc/maistv-next/maistv-next.env`, deve pertencer a `root:root` e ter modo `0600`. Nunca registre credenciais no Git ou em logs.

## CORS do bucket

URLs assinadas sao acessadas pelo navegador. Configure CORS no bucket para permitir somente a homologacao:

```json
[
  {
    "AllowedOrigins": ["https://homolog-test.hakione.tech"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-None-Match", "If-Modified-Since", "Content-Type"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Upload e leitura server-side usam a API S3 e nao dependem de CORS. Nao inclua `PUT` para a origem do frontend: o browser nao faz upload direto ao bucket nesta arquitetura.

## Deploy controlado na MaisTV

Depois de publicar as alteracoes no GitHub:

```bash
set -euo pipefail
cd /root/MaisTV

git pull --ff-only
unset NODE_ENV NPM_CONFIG_PRODUCTION NPM_CONFIG_OMIT
npm ci --include=dev

set -a
source /etc/maistv-next/maistv-next.env
set +a

npm run db:migrate:chat
npm run build

rsync -a --delete /root/MaisTV/dist/ /var/www/maistv-next/dist/
chown -R www-data:www-data /var/www/maistv-next/dist

nginx -t
systemctl restart maistv-next-api maistv-next-chat-worker@media
systemctl reload nginx
```

Nao iniciar `maistv-next-chat-worker@outbound`, `maistv-next-worker`, `maistv-next-routine-worker` ou `maistv-next-assignment-worker` nesta etapa.

## Smoke test do storage

O teste cria um objeto temporario, executa `PUT`, `HEAD`, leitura autenticada, gera URL assinada, baixa pela URL e apaga somente o objeto temporario:

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run storage:test -- --confirm
```

Todos os campos booleanos do relatorio devem ser `true`.

## Inspecao e reprocessamento dos jobs falhos

Primeiro gere um relatorio sem alterar a fila:

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run media:failed:report
```

O relatorio registra ID, payload, tentativas, motivo da falha e linha correspondente em `media_files`. Depois do smoke test do storage:

```bash
npm run media:failed:reprocess
sleep 15
npm run media:failed:report
```

Os JSONs ficam em `scripts/reports/media/`. O script nao apaga jobs. Ele usa `retry('failed')`; o processamento e idempotente por chave de objeto e confere o objeto existente antes de baixar novamente.

## Validacoes operacionais

```bash
# Bull Board autenticado
# https://api-homolog-test.hakione.tech/admin/queues

journalctl -u maistv-next-chat-worker@media -n 200 --no-pager
journalctl -f -u maistv-next-chat-worker@media -u maistv-next-api -u maistv-next-sse

docker exec maistv-next-postgres-1 psql -U maistv_next -d maistv_next -x -c "
SELECT id,provider_media_id,message_id,type,mime_type,size_bytes,status,
       storage_key,thumbnail_key,sha256,error_message,last_attempt_at,available_at
FROM media_files
ORDER BY updated_at DESC
LIMIT 30;"

docker exec maistv-next-postgres-1 pg_isready -U maistv_next -d maistv_next
docker exec maistv-next-redis-1 redis-cli ping

systemctl is-active \
  maistv-next-api \
  maistv-next-chat-worker@inbound \
  maistv-next-chat-worker@status \
  maistv-next-chat-worker@media \
  maistv-next-sse

systemctl is-active \
  maistv-next-chat-worker@outbound \
  maistv-next-worker \
  maistv-next-routine-worker \
  maistv-next-assignment-worker || true
```

Os quatro ultimos devem continuar inativos.

## Validar uma URL assinada

Com um `mediaId` disponivel e uma sessao autenticada no painel, a chamada e:

```text
GET https://api-homolog-test.hakione.tech/api/media/<MEDIA_ID>/signed-url
GET https://api-homolog-test.hakione.tech/api/media/<MEDIA_ID>/thumbnail
```

O original exige `status=available` e `storage_key`; thumbnail exige `thumbnail_key`. O TTL vem de `MEDIA_SIGNED_URL_TTL_SECONDS`.

## Matriz de aceite

1. Envie imagem, audio, PDF e video por uma rota explicitamente autorizada para homologacao.
2. Confirme job `completed`, `media_files.status='available'` e objeto no bucket.
3. Imagem deve gerar `thumbnail_key`; video usa placeholder seguro; audio nao gera thumbnail; documento preserva nome, MIME e tamanho.
4. Na tela, imagem solicita thumbnail perto da viewport e original somente ao abrir; documento solicita original somente no clique; audio solicita original quando o usuario escolhe reproduzir; video solicita original quando ativado.
5. O evento SSE `media_updated` invalida apenas o cache de mensagens da conversa e refaz a consulta sem polling agressivo.
6. Para audio, use `Transcrever audio`. A API le o objeto privado, chama o Whisper configurado e persiste `messages.transcription_json`. Falha fica registrada e nao remove nem quebra a mensagem.

Sem uma rota temporariamente autorizada ou IDs Meta ainda validos nos jobs falhos, e possivel aprovar o storage, mas nao o recebimento inbound Meta de todos os quatro tipos.
