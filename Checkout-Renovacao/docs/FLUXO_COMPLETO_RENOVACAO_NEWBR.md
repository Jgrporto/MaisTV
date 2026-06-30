# Fluxo completo da renovação NewBR

## 1. DNS e Nginx

Foi criado o domínio:

```txt
api.prod.hakione.tech -> 2.24.118.225
```

O Nginx serve a tela estática e encaminha APIs locais para o backend Flask.

Arquivo:

```txt
/etc/nginx/sites-available/newbr-login
```

Rotas:

```txt
/                       -> index.html
/newbr-login-worker.js  -> Worker público
/api/local/newbr/       -> Flask 127.0.0.1:8091
/api/webhooks/mercadopago/ -> Flask 127.0.0.1:8091
```

## 2. Login via Worker

O login não é feito pela VPS. Ele é feito pelo navegador.

Isso foi necessário porque a VPS recebeu bloqueio Cloudflare `403` ao tentar chamar diretamente:

```txt
https://painel.newbr.top/api/auth/login
```

Com o Worker, a chamada sai do navegador real.

## 3. Credenciais no Worker

As credenciais ficam em:

```txt
/var/www/newbr-login/newbr-login-worker.js
```

Campos:

```js
const SAVED_USERNAME = "COLOQUE_O_USUARIO_AQUI";
const SAVED_PASSWORD = "COLOQUE_A_SENHA_AQUI";
```

## 4. Captura correta do token

O retorno da NewBR possui muitos campos de texto, incluindo datas e templates.

A correção final garante que apenas o campo `token` seja usado, e que ele siga o formato:

```txt
numero|string
```

Exemplo:

```txt
237989|2Nila68qyezg0DaVtMhOiUdLc6NJs2oUIMLOueqya96ecc51
```

## 5. Renovação imediata

O botão `Renovar agora` executa:

```txt
POST https://painel.newbr.top/api/customers/mVLll6NELQ/renew
```

Headers principais:

```txt
Authorization: Bearer TOKEN_CORRETO
Accept: application/json
Content-Type: application/json
Locale: pt
X-App-Version: 3.81
```

Payload:

```json
{
  "package_id": "BV4D3rLaqZ",
  "connections": 1
}
```

## 6. Salvamento no backend

Token salvo em:

```txt
/var/www/newbr-login/runtime/tokens/newbr-main.json
```

Renovação salva em:

```txt
/var/www/newbr-login/runtime/renewals/newbr-renew-mVLll6NELQ-BV4D3rLaqZ.json
```

## 7. Webhook futuro

Endpoint preparado:

```txt
POST https://api.prod.hakione.tech/api/webhooks/mercadopago/newbr-renew
```

Payload de teste:

```json
{
  "status": "approved",
  "external_reference": "newbr-renew-mVLll6NELQ-BV4D3rLaqZ"
}
```

## 8. Teste de status

```bash
curl "https://api.prod.hakione.tech/api/local/newbr/renewal-status?external_reference=newbr-renew-mVLll6NELQ-BV4D3rLaqZ&account_key=newbr-main"
```
