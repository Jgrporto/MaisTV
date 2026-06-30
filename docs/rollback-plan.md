# Plano de rollback da nova stack de chat

## Gatilhos

Execute rollback se houver perda/duplicação de mensagens, isolamento de tenant incorreto, fila crescendo sem consumo, falha de status, SSE instável em massa ou erro de mídia incompatível. Preserve evidências antes de reiniciar processos.

## Rollback operacional

1. Desative as feature flags/coortes novas e direcione frontend/webhook/envio às rotas legadas.
2. Pause produção de jobs novos; mantenha os dados e filas para auditoria.
3. Pare SSE e workers novos.
4. Recompile o frontend com `VITE_ENABLE_NEW_CHAT_DATA_LAYER=false` e `VITE_ENABLE_SSE_REALTIME=false`; mantenha `VITE_ENABLE_CHAT_VIRTUALIZATION=true`.
5. Restaure o include Nginx anterior e valide configuração.
6. Reinicie apenas os serviços legados afetados e execute smoke tests.

```bash
sudo systemctl stop maistv-sse.service 'maistv-worker-*'
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl restart maistv-api.service maistv-whatsapp.service
```

Os nomes devem ser conferidos com `systemctl list-unit-files 'maistv-*'` antes da execução. Checkout/NewBR, Mercado Pago, Tavinho, chatbot, rotinas, HSM, dashboard e filas de atendimento não participam do cutover e não devem ser reiniciados sem evidência de impacto.

## Dados

Não faça `DROP`, `TRUNCATE`, `FLUSHALL` nem apague jobs durante rollback. PostgreSQL continua como registro da tentativa; SQLite/JSON legado volta a atender somente o tráfego cuja compatibilidade já existia. Exporte contagens e IDs divergentes para reconciliação. Mensagens `pending` exigem reconciliação com a Meta antes de retry para evitar duplicidade.

## Rollback de código

Use o commit/release anterior por fast-forward/revert controlado; não edite arquivos rastreados diretamente na VPS. Refaça o build e publique `dist` para `/var/www/maistv/dist/` quando houver alteração frontend. Preserve `/etc/maistv/chat-stack.env` e backups fora do repositório.

## Critérios de encerramento

- envio/recebimento/status legados validados;
- nenhuma fila nova recebe jobs inesperados;
- Nginx e serviços estão ativos;
- health e logs sem erros novos;
- incidente, janela, contagens e plano de reconciliação registrados.

Uma nova tentativa de cutover exige causa raiz, correção validada localmente e ensaio de rollback.
