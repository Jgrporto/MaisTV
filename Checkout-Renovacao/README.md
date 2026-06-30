# NewBR Renovação Final Funcionando

Este pacote reúne tudo que foi realizado para a tela de renovação NewBR:

- Nginx para `api.prod.hakione.tech`;
- frontend em `/var/www/newbr-login/index.html`;
- Web Worker em `/var/www/newbr-login/newbr-login-worker.js`;
- backend Flask/Gunicorn em `127.0.0.1:8091`;
- salvamento de token;
- salvamento de intenção/resultado de renovação;
- botão `Renovar agora`;
- fallback para webhook futuro do Mercado Pago;
- correção do bug onde a data era capturada como token.

## Dados finais configurados

```txt
customer_id: mVLll6NELQ
package_id: BV4D3rLaqZ
connections: 1
external_reference: newbr-renew-mVLll6NELQ-BV4D3rLaqZ
```

## Fluxo que funcionou

```txt
1. Usuário acessa https://api.prod.hakione.tech
2. Clica em Renovar agora.
3. Frontend cria o Web Worker.
4. Worker faz login em:
   POST https://painel.newbr.top/api/auth/login
5. Worker captura o campo correto:
   response.token
6. Worker chama:
   POST https://painel.newbr.top/api/customers/mVLll6NELQ/renew
7. Payload:
   {
     "package_id": "BV4D3rLaqZ",
     "connections": 1
   }
8. Frontend salva token, intenção e resultado no backend.
```

## Correção importante do token

Antes, o extrator de token aceitava qualquer string grande do JSON. Por isso ele pegou uma data:

```txt
2024-08-27T11:25:37.000000Z
```

Agora o Worker procura primeiro campos chamados:

```txt
token
access_token
bearer_token
jwt
```

E só aceita valores com formato parecido com o token NewBR:

```txt
237989|2Nila68qyezg0DaVtMhOiUdLc6NJs2oUIMLOueqya96ecc51
```

## Onde editar usuário e senha

```bash
sudo nano /var/www/newbr-login/newbr-login-worker.js
```

Troque:

```js
const SAVED_USERNAME = "COLOQUE_O_USUARIO_AQUI";
const SAVED_PASSWORD = "COLOQUE_A_SENHA_AQUI";
```

Depois limpe cache do navegador com `Ctrl + F5`.

## Instalação

```bash
cd newbr-renovacao-final-funcionando
chmod +x install.sh
./install.sh
```

## Atualização manual

```bash
sudo cp public/index.html /var/www/newbr-login/index.html
sudo cp public/newbr-login-worker.js /var/www/newbr-login/newbr-login-worker.js
sudo cp backend/app.py /var/www/newbr-login/app.py
sudo cp backend/requirements.txt /var/www/newbr-login/requirements.txt
sudo cp deploy/nginx/newbr-login.conf /etc/nginx/sites-available/newbr-login
sudo cp deploy/systemd/newbr-login-api.service /etc/systemd/system/newbr-login-api.service

sudo mkdir -p /var/www/newbr-login/runtime/tokens
sudo mkdir -p /var/www/newbr-login/runtime/renewals
sudo mkdir -p /var/www/newbr-login/runtime/logs

sudo chown -R www-data:www-data /var/www/newbr-login

sudo systemctl daemon-reload
sudo systemctl restart newbr-login-api

sudo nginx -t
sudo systemctl reload nginx
```
