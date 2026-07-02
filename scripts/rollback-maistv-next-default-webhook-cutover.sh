#!/usr/bin/env bash
set -Eeuo pipefail

[[ ${EUID} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }
[[ ${1:-} == "--confirm" && $# -eq 1 ]] || {
  echo "Uso: bash scripts/rollback-maistv-next-default-webhook-cutover.sh --confirm" >&2
  exit 1
}

repo_root="/root/MaisTV"
available_dir="/etc/nginx/maistv-next-webhook-cutover-available"
enabled_dir="/etc/nginx/maistv-next-webhook-cutover-enabled"
state_dir="/etc/nginx/maistv-next-webhook-cutover-state"
active_link="${enabled_dir}/active.conf"
default_file="${available_dir}/default.conf"
previous_state="${state_dir}/default-previous-target"
backup_dir="${repo_root}/.deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-default-webhook-rollback"

route_count() {
  grep -Ec "^[[:space:]]*location = $1[[:space:]]*\\{" "$2" || true
}

[[ -L ${active_link} ]] || { echo "Link de cutover ativo ausente; interrompido." >&2; exit 1; }
current_target="$(readlink -f "${active_link}")"

if [[ ! -f ${previous_state} ]]; then
  if [[ -f ${current_target} && $(route_count /api/whatsapp/webhook-vendas2 "${current_target}") -eq 1 \
      && $(route_count /api/whatsapp/webhook-vendas "${current_target}") -eq 1 \
      && $(route_count /api/whatsapp/webhook "${current_target}") -eq 0 ]]; then
    nginx -t
    echo "O default ja esta em rollback; vendas e vendas2 continuam ativos."
    exit 0
  fi
  echo "Estado de rollback ausente: ${previous_state}" >&2
  exit 1
fi

[[ ${current_target} == "${default_file}" ]] || {
  echo "O estagio ativo nao e o default gerenciado por este script; interrompido." >&2
  exit 1
}
previous_target="$(head -n 1 "${previous_state}")"
[[ ${previous_target} == "${available_dir}/"*.conf && -f ${previous_target} ]] || {
  echo "Destino anterior inseguro ou ausente: ${previous_target}" >&2; exit 1;
}
[[ $(route_count /api/whatsapp/webhook-vendas2 "${previous_target}") -eq 1 ]] || {
  echo "Rollback recusado: destino anterior nao preserva vendas2." >&2; exit 1;
}
[[ $(route_count /api/whatsapp/webhook-vendas "${previous_target}") -eq 1 ]] || {
  echo "Rollback recusado: destino anterior nao preserva vendas." >&2; exit 1;
}
[[ $(route_count /api/whatsapp/webhook "${previous_target}") -eq 0 ]] || {
  echo "Rollback recusado: destino anterior ainda contem o default." >&2; exit 1;
}

mkdir -p "${backup_dir}"
cp -a "${current_target}" "${backup_dir}/active-before.conf"
cp -a "${previous_state}" "${backup_dir}/default-previous-target"

temp_link="${enabled_dir}/.active.conf.$$"
cleanup() { rm -f "${temp_link}"; }
trap cleanup EXIT
ln -s "${previous_target}" "${temp_link}"
mv -Tf "${temp_link}" "${active_link}"

restore_default() {
  rm -f "${active_link}"
  ln -s "${default_file}" "${active_link}"
  nginx -t || true
  systemctl reload nginx || true
}

if ! nginx -t; then
  restore_default
  echo "Rollback cancelado porque nginx -t falhou; default restaurado." >&2
  exit 1
fi
if ! systemctl reload nginx; then
  restore_default
  echo "Rollback cancelado porque o reload do Nginx falhou; default restaurado." >&2
  exit 1
fi

mv "${previous_state}" "${backup_dir}/default-previous-target.applied"
echo "Webhook default devolvido ao estagio anterior. vendas e vendas2 continuam na MaisTV."
echo "Backup: ${backup_dir}"
