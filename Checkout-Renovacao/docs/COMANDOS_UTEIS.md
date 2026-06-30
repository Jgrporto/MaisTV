# Comandos úteis

## Editar Worker

```bash
sudo nano /var/www/newbr-login/newbr-login-worker.js
```

## Reiniciar backend

```bash
sudo systemctl restart newbr-login-api
sudo systemctl status newbr-login-api --no-pager
```

## Ver logs

```bash
sudo journalctl -u newbr-login-api -f
```

## Testar backend local

```bash
curl http://127.0.0.1:8091/health
```

## Testar domínio

```bash
curl -I https://api.prod.hakione.tech
```

## Status token/renovação

```bash
curl "https://api.prod.hakione.tech/api/local/newbr/renewal-status?external_reference=newbr-renew-mVLll6NELQ-BV4D3rLaqZ&account_key=newbr-main"
```

## Simular webhook aprovado

```bash
curl -X POST https://api.prod.hakione.tech/api/webhooks/mercadopago/newbr-renew \
  -H "Content-Type: application/json" \
  -d '{"status":"approved","external_reference":"newbr-renew-mVLll6NELQ-BV4D3rLaqZ"}'
```

## Apagar token salvo

```bash
sudo rm -f /var/www/newbr-login/runtime/tokens/newbr-main.json
```

## Apagar registro da renovação

```bash
sudo rm -f /var/www/newbr-login/runtime/renewals/newbr-renew-mVLll6NELQ-BV4D3rLaqZ.json
```

## Recarregar Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```
