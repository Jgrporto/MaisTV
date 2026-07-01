# +TV Atendimento

Painel web para atendimento, acompanhamento de conversas, respostas rápidas e configurações da operação.

## Requisitos

- Node.js 20+ recomendado
- npm 10+ recomendado

## Configuracao local

1. Instale as dependencias:
   `npm install`
2. Crie um arquivo `.env.local` na raiz do projeto.
3. Defina as variaveis de ambiente da aplicacao:

```env
VITE_WHATSAPP_API_BASE_URL=http://localhost:5050
VITE_WHATSAPP_API_ADDITIONAL_BASE_URLS=
VITE_WHATSAPP_KNOWN_NUMBERS=
VITE_LOCAL_API_BASE_URL=http://localhost:5053/api/local
VITE_APP_BUILD_LABEL=
```

Para a tela `HSMs`, a integracao com os templates da Meta usa `VITE_WHATSAPP_API_BASE_URL`.
Para descobrir numeros adicionais em `Configuracoes > Servicos`, use `VITE_WHATSAPP_API_ADDITIONAL_BASE_URLS` com hosts extras separados por virgula e `VITE_WHATSAPP_KNOWN_NUMBERS` como fallback explicito.
Para a tela `Base de Clientes`, a persistencia e sincronizacao com o NewBr usam `VITE_LOCAL_API_BASE_URL` no frontend e variaveis `NEWBR_SYNC_*` no processo `server/local-api.mjs`.
O projeto nao usa mais Base44. A autenticacao da SPA acontece inteiramente pelo backend local.

### Variaveis do backend local

```env
PORT=5053
NEWBR_SYNC_BASE_URL=https://painel.newbr.top
NEWBR_SYNC_USERNAME=
NEWBR_SYNC_PASSWORD=
NEWBR_SYNC_PER_PAGE=100
CUSTOMER_AUTO_SYNC_INTERVAL_MS=1800000
CUSTOMER_SYNC_RETRY_INTERVAL_MS=300000
LOCAL_WHATSAPP_API_BASE_URL=http://127.0.0.1:5050
LOCAL_CHECKOUT_API_BASE_URL=http://127.0.0.1:5051
LOCAL_CHECKOUT_TOKEN_API_BASE_URL=http://127.0.0.1:5050
CHATBOT_WHATSAPP_TIMEOUT_MS=10000
ROUTINE_CHECKOUT_TIMEOUT_MS=15000
ROUTINE_WHATSAPP_TIMEOUT_MS=45000
```

`server/local-api.mjs` usa `LOCAL_WHATSAPP_API_BASE_URL` para `/api/whatsapp/*` e `LOCAL_CHECKOUT_API_BASE_URL` para `/api/checkout/*`.
Para a geracao de token usada nas rotinas com `{{checkoutoken}}`, o endpoint atual fica na stack WhatsApp e usa `LOCAL_CHECKOUT_TOKEN_API_BASE_URL`.
Em producao, prefira esses enderecos internos para evitar timeout por proxy externo quando a VPS fala com ela mesma.

### Transcricao de audio com Whisper

O chat permite transcrever mensagens de audio do WhatsApp pelo endpoint do backend local. O processo `server/whatsapp-server.js` baixa a midia da Meta, chama `server/whisper-transcribe.py` e salva o resultado em `message.transcription` no store principal.

Variaveis recomendadas para qualidade:

```env
WHISPER_MODEL=base
WHISPER_LANGUAGE=pt
WHISPER_TIMEOUT_MS=180000
WHISPER_TMP_DIR=
WHISPER_PYTHON_BIN=python
WHISPER_SERVICE_URL=http://127.0.0.1:5054
WHISPER_SERVICE_HOST=127.0.0.1
WHISPER_SERVICE_PORT=5054
WHISPER_SERVICE_WARM=true
```

Para menor latencia em CPU fraca, `WHISPER_MODEL=tiny` continua disponivel, com menor qualidade.

No host que executa o servico de transcricao, instale `ffmpeg` e o pacote Python do Whisper no mesmo ambiente apontado por `WHISPER_PYTHON_BIN`:

```bash
python -m pip install -U openai-whisper
```

Em producao, rode o Whisper em um processo separado:

```bash
cd /root/SaasTV
/opt/maistv-whisper-venv/bin/python server/whisper-service.py
```

O `server/whatsapp-server.js` chama esse processo por `WHISPER_SERVICE_URL`. Se essa variavel nao estiver configurada, ele usa o modo antigo de subprocesso Python por transcricao.

### Login local

- Rota: `/login`
- Sessao: cookie HttpOnly emitido por `server/local-api.mjs`
- Persistencia longa: opcao `Manter-me conectado`
- Credencial padrao de migracao do admin local: `admin` / `admin`

## Execucao

Ambiente de desenvolvimento:

```bash
npm run dev
```

Build de producao:

```bash
npm run build
```

Pre-visualizacao local do build:

```bash
npm run preview
```

## Estrutura principal

- `src/pages`: telas da aplicacao
- `src/components`: componentes de layout, chat e dashboard
- `src/lib/local-api.js`: cliente compartilhado da API local
- `src/lib/local-auth.js`: login, logout e consulta da sessao local
- `server/local-api.mjs`: API local com persistencia em arquivo e sincronizacao do NewBr

## Documentacao complementar

- Contexto funcional e tecnico: `PROJECT_CONTEXT.md`
- Fluxo operacional de deploy na VPS: `docs/maintenance/deploy-vps.md`

## Nova arquitetura incremental de chat

A migração do núcleo de atendimento segue strangler pattern: PostgreSQL guarda os dados, BullMQ processa trabalhos, Redis Pub/Sub distribui eventos e SSE atualiza o frontend. SQLite/JSON e as rotas `/api/whatsapp/*` permanecem somente para compatibilidade enquanto cada coorte é validada. Checkout/NewBR, Mercado Pago, Tavinho, chatbot, rotinas, HSM, dashboard, autenticação e distribuição existentes estão fora desta migração.

Infra local:

```bash
docker compose -f docker-compose.infra.yml up -d
npm run db:migrate:chat
```

O cutover permanece desativado por padrão. A homologação compartilhada usa `/root/MaisTV`,
`CHAT_ARCHITECTURE_ENABLED=true` e units `maistv-next-*`, sem substituir a produção em `/root/SaasTV`.
Para desenvolvimento, use `npm run sse` e os scripts `npm run worker:*`; as rotas REST novas sao
delegadas pelo `server/local-api.mjs`, sem remover as rotas `/api/whatsapp/*`.

Processos novos são separados em API, SSE e workers. Os units isolados ficam em `infra/systemd`; o vhost de teste fica em `infra/nginx/homolog-test.conf`. Na VPS compartilhada, o SSE usa `5356` porque `5055` pertence à autenticação da SaasTV.

Documentação:

- Arquitetura e compatibilidade: `docs/chat-architecture-migration.md`
- SSE, reconexão e troubleshooting: `docs/realtime-sse.md`
- BullMQ, Bull Board e workers: `docs/bullmq-workers.md`
- Migration e backfill PostgreSQL: `docs/postgres-migration.md`
- Deploy proposto e Uptime Kuma: `docs/deploy-new-chat-stack.md`
- Rollback e reconciliação: `docs/rollback-plan.md`
- Homologação blue-green isolada em `/root/MaisTV`: `docs/maistv-next-blue-green-deploy.md`

Sentry é opcional por `SENTRY_DSN`; sem configuração, a nova camada continua ativa. Bull Board deve permanecer autenticado/restrito. Os artefatos de deploy são sugestões versionadas: nenhuma implantação ou alteração de VPS foi executada nesta entrega.
