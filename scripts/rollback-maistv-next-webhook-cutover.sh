#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Execute como root." >&2
  exit 1
fi

if [[ ${1:-} != "--confirm" ]]; then
  echo "Uso: bash scripts/rollback-maistv-next-webhook-cutover.sh --confirm" >&2
  exit 1
fi

active_link="/etc/nginx/maistv-next-webhook-cutover-enabled/active.conf"
previous_target=""
if [[ -L ${active_link} ]]; then
  previous_target="$(readlink "${active_link}")"
fi

rm -f "${active_link}"
if ! nginx -t; then
  if [[ -n ${previous_target} ]]; then
    ln -s "${previous_target}" "${active_link}"
  fi
  nginx -t || true
  echo "Rollback cancelado porque nginx -t falhou; o estagio anterior foi restaurado." >&2
  exit 1
fi

systemctl reload nginx
echo "Cutover removido. As rotas voltaram a usar a location /api/ da SaasTV."
