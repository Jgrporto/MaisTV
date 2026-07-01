# Homologacao de midia inbound com storage local privado

Este runbook e exclusivo da instalacao isolada `/root/MaisTV`. Ele nao altera `/root/SaasTV`, nao ativa outbound, rotinas, schedulers ou novas rotas de webhook.

## Decisao de storage

A etapa de homologacao usa obrigatoriamente storage local privado na VPS:

```dotenv
STORAGE_PROVIDER=local
LOCAL_STORAGE_ROOT=/var/lib/maistv-next/media
LOCAL_STORAGE_INTERNAL_PREFIX=/protected-media
MEDIA_SIGNED_URL_TTL_SECONDS=300
MEDIA_ACCESS_TOKEN_SECRET=<secret-gerado-com-openssl-rand-hex-32>
```

Nao configurar Cloudflare R2, AWS S3, MinIO ou outro object storage externo nesta etapa. O suporte a `s3` e `r2` permanece no codigo para uso futuro.

## Protecao no Nginx

Os arquivos nao ficam publicos. O Nginx deve entregar somente requisicoes autorizadas pela API via `X-Accel-Redirect`:

```nginx
location /protected-media/ {
    internal;
    alias /var/lib/maistv-next/media/;
}
```

A pasta real `/var/lib/maistv-next/media` nao deve aparecer como `root`, `alias` publico ou rota estatica comum. O frontend recebe URLs temporarias da API, por exemplo:

```text
GET /api/media/<MEDIA_ID>/signed-url
GET /api/media/<MEDIA_ID>/thumbnail
```

Com `STORAGE_PROVIDER=local`, essas rotas retornam URLs temporarias da propria API:

```json
{
  "url": "https://api-homolog-test.hakione.tech/api/media/<MEDIA_ID>/download?token=<token>",
  "expiresIn": 300
}
```

O token e assinado por HMAC com `MEDIA_ACCESS_TOKEN_SECRET` e escopado por tenant, usuario, media, chave do arquivo, tipo e expiracao.

## Permissoes da pasta local

Crie a pasta antes de iniciar os servicos:

```bash
mkdir -p /var/lib/maistv-next/media
chown -R root:root /var/lib/maistv-next/media
chmod 750 /var/lib/maistv-next/media
```

Se os servicos systemd forem executados por outro usuario, troque o dono para esse usuario, por exemplo `maistv:maistv`.

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
systemctl reload nginx
systemctl restart maistv-next-api maistv-next-sse maistv-next-chat-worker@media maistv-next-chat-worker@inbound maistv-next-chat-worker@status
```

Nao iniciar `maistv-next-chat-worker@outbound`, `maistv-next-worker`, `maistv-next-routine-worker` ou `maistv-next-assignment-worker` nesta etapa.

## Smoke test do storage

O teste cria um objeto temporario, executa write, head, read, token temporario local, bloqueio de path traversal e delete:

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run storage:test -- --confirm
```

Todos os campos booleanos do relatorio devem ser `true`, incluindo `pathTraversalBlocked`.

## Inspecao e reprocessamento dos jobs falhos

Primeiro gere um relatorio sem alterar a fila:

```bash
cd /root/MaisTV
set -a
source /etc/maistv-next/maistv-next.env
set +a
npm run media:failed:report
```

Depois do smoke test do storage:

```bash
npm run media:failed:reprocess
sleep 15
npm run media:failed:report
```

Os JSONs ficam em `scripts/reports/media/`. O script nao apaga jobs.

## Validacoes operacionais

```bash
journalctl -u maistv-next-chat-worker@media -n 200 --no-pager
journalctl -f -u maistv-next-chat-worker@media -u maistv-next-api -u maistv-next-sse

docker exec maistv-next-postgres-1 psql -U maistv_next -d maistv_next -x -c "
SELECT id,provider_media_id,message_id,type,mime_type,size_bytes,status,
       storage_key,thumbnail_key,sha256,error_message,last_attempt_at,available_at
FROM media_files
ORDER BY updated_at DESC
LIMIT 30;"

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

## Matriz de aceite

1. Envie imagem, audio, PDF e video por uma rota explicitamente autorizada para homologacao.
2. Confirme job `completed`, `media_files.status='available'` e arquivo em `/var/lib/maistv-next/media`.
3. Imagem deve gerar `thumbnail_key`; video usa placeholder seguro; audio nao gera thumbnail; documento preserva nome, MIME e tamanho.
4. Na tela, imagem solicita thumbnail perto da viewport e original somente ao abrir; documento solicita original somente no clique; audio solicita original quando o usuario escolhe reproduzir; video solicita original quando ativado.
5. O evento SSE `media_updated` invalida apenas o cache de mensagens da conversa e refaz a consulta sem polling agressivo.
6. Para audio, use `Transcrever audio`. A API le o objeto privado local, chama o Whisper configurado e persiste `messages.transcription_json`.

## Backup futuro

Documentar backup da pasta:

```text
/var/lib/maistv-next/media
```

Recomendacao futura: backup diario com `rsync` ou snapshot para outro disco/servidor, retencao minima e teste de restore. Nao ativar automacao de backup nesta etapa sem autorizacao explicita.
