#!/usr/bin/env bash
set -euo pipefail

SITE_DIR="/var/www/newbr-login"

echo "==> Criando estrutura"
sudo mkdir -p "$SITE_DIR/runtime/tokens" "$SITE_DIR/runtime/renewals" "$SITE_DIR/runtime/logs"

echo "==> Copiando frontend"
sudo cp public/index.html "$SITE_DIR/index.html"
sudo cp public/newbr-login-worker.js "$SITE_DIR/newbr-login-worker.js"

echo "==> Copiando backend"
sudo cp backend/app.py "$SITE_DIR/app.py"
sudo cp backend/requirements.txt "$SITE_DIR/requirements.txt"
sudo cp backend/.env.example "$SITE_DIR/.env.example"

echo "==> Instalando dependências"
sudo apt update
sudo apt install -y python3-venv python3-pip nginx
cd "$SITE_DIR"
sudo python3 -m venv venv
sudo "$SITE_DIR/venv/bin/pip" install -r "$SITE_DIR/requirements.txt"

echo "==> Permissões"
sudo chown -R www-data:www-data "$SITE_DIR"

echo "==> Instalando systemd"
sudo cp deploy/systemd/newbr-login-api.service /etc/systemd/system/newbr-login-api.service
sudo systemctl daemon-reload
sudo systemctl enable newbr-login-api
sudo systemctl restart newbr-login-api

echo "==> Instalando Nginx"
sudo cp deploy/nginx/newbr-login.conf /etc/nginx/sites-available/newbr-login
sudo ln -sf /etc/nginx/sites-available/newbr-login /etc/nginx/sites-enabled/newbr-login
sudo nginx -t
sudo systemctl reload nginx

echo "==> Finalizado"
echo "Agora edite as credenciais no Worker:"
echo "sudo nano /var/www/newbr-login/newbr-login-worker.js"
echo ""
echo "Depois limpe cache do navegador com Ctrl + F5."
