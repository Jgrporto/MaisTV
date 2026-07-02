#!/usr/bin/env bash
set -Eeuo pipefail

[[ ${EUID} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }
[[ ${1:-} == "--confirm" && $# -eq 1 ]] || {
  echo "Uso: bash scripts/enable-maistv-next-default-webhook-cutover.sh --confirm" >&2
  exit 1
}

repo_root="/root/MaisTV"
site_file="/etc/nginx/sites-available/maistv-api"
available_dir="/etc/nginx/maistv-next-webhook-cutover-available"
enabled_dir="/etc/nginx/maistv-next-webhook-cutover-enabled"
state_dir="/etc/nginx/maistv-next-webhook-cutover-state"
source_file="${repo_root}/infra/nginx/production-webhook-cutover-default.conf"
default_file="${available_dir}/default.conf"
active_link="${enabled_dir}/active.conf"
previous_state="${state_dir}/default-previous-target"
backup_dir="${repo_root}/.deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-default-webhook-cutover"
env_file="/etc/maistv-next/maistv-next.env"

[[ -f ${env_file} ]] || { echo "Env ausente: ${env_file}" >&2; exit 1; }
env_is_false() {
  grep -Eq "^[[:space:]]*$1[[:space:]]*=[[:space:]]*['\"]?(false|0|no|off)['\"]?[[:space:]]*$" "${env_file}"
}
env_equals_digits() {
  local actual
  actual="$(grep -E "^[[:space:]]*$1[[:space:]]*=" "${env_file}" | tail -n 1 | cut -d= -f2- | tr -cd '0-9')"
  [[ ${actual} == "$2" ]]
}

for flag in ASSIGNMENT_WORKER_ENABLED ASSIGNMENT_ENQUEUE_ENABLED ROUTINE_DISPATCH_QUEUE_ENABLED \
  ROUTINE_DISPATCH_QUEUE_WORKER_ENABLED ROUTINE_SCHEDULER_ENABLED WHATSAPP_SCHEDULERS_ENABLED; do
  env_is_false "${flag}" || { echo "Cutover recusado: ${flag} precisa estar false." >&2; exit 1; }
done
env_equals_digits WHATSAPP_PHONE_NUMBER_ID 779406741922236 || {
  echo "Cutover recusado: WHATSAPP_PHONE_NUMBER_ID default inesperado." >&2; exit 1;
}
env_equals_digits WHATSAPP_DISPLAY_PHONE_NUMBER 5524999663511 || {
  echo "Cutover recusado: WHATSAPP_DISPLAY_PHONE_NUMBER default inesperado." >&2; exit 1;
}
grep -Eq "^[[:space:]]*WHATSAPP_WEBHOOK_CHAT_ONLY[[:space:]]*=[[:space:]]*['\"]?true['\"]?[[:space:]]*$" "${env_file}" || {
  echo "Cutover recusado: WHATSAPP_WEBHOOK_CHAT_ONLY precisa estar true." >&2; exit 1;
}

for unit in maistv-next-api.service maistv-next-whatsapp.service maistv-next-sse.service \
  maistv-next-chat-worker@inbound.service maistv-next-chat-worker@outbound.service \
  maistv-next-chat-worker@status.service maistv-next-chat-worker@media.service; do
  systemctl is-active --quiet "${unit}" || { echo "Cutover recusado: ${unit} nao esta ativo." >&2; exit 1; }
done
for forbidden_unit in maistv-next-chat-worker@assignment.service maistv-next-chat-worker@automations.service; do
  if systemctl is-active --quiet "${forbidden_unit}"; then
    echo "Cutover recusado: ${forbidden_unit} precisa estar parado." >&2
    exit 1
  fi
done
for health_path in postgres redis queues; do
  curl -fsS "http://127.0.0.1:5353/api/health/${health_path}" >/dev/null || {
    echo "Cutover recusado: health ${health_path} falhou." >&2; exit 1;
  }
done

[[ -d ${repo_root}/.deploy-backups ]] || {
  echo "Cutover recusado: diretorio de backups ausente." >&2; exit 1;
}
precutover_backup="$(find "${repo_root}/.deploy-backups" -mindepth 1 -maxdepth 1 -type d \
  -name '*-default-precutover' -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed -n '1p' | cut -d' ' -f2-)"
[[ -n ${precutover_backup} && -f ${precutover_backup}/SHA256SUMS && ! -e ${precutover_backup}/.INCOMPLETE ]] || {
  echo "Cutover recusado: execute e valide o backup pre-cutover nesta release." >&2; exit 1;
}
[[ $(cat "${precutover_backup}/RELEASE_COMMIT") == $(git -C "${repo_root}" rev-parse HEAD) ]] || {
  echo "Cutover recusado: o backup nao corresponde ao commit atual." >&2; exit 1;
}
(cd "${precutover_backup}" && sha256sum --quiet -c SHA256SUMS) || {
  echo "Cutover recusado: hashes do backup nao conferem." >&2; exit 1;
}

[[ -f ${site_file} ]] || { echo "Nginx site ausente: ${site_file}" >&2; exit 1; }
[[ -f ${source_file} ]] || { echo "Configuracao ausente: ${source_file}" >&2; exit 1; }
grep -Eq 'server_name[[:space:]]+api\.maistv\.hakione\.tech' "${site_file}" || {
  echo "O arquivo ${site_file} nao pertence ao dominio produtivo esperado." >&2
  exit 1
}
grep -Fq 'include /etc/nginx/maistv-next-webhook-cutover-enabled/*.conf;' "${site_file}" || {
  echo "Include de cutover ausente. Nao altere o site manualmente; execute a preparacao existente." >&2
  exit 1
}
[[ -L ${active_link} ]] || {
  echo "Nao existe estagio ativo para preservar vendas/vendas2." >&2
  exit 1
}

current_target="$(readlink -f "${active_link}")"
[[ -f ${current_target} ]] || { echo "Destino ativo invalido: ${current_target}" >&2; exit 1; }

route_count() {
  grep -Ec "^[[:space:]]*location = $1[[:space:]]*\\{" "$2" || true
}

if [[ ${current_target} == "${default_file}" ]]; then
  [[ -f ${previous_state} ]] || {
    echo "Default ja esta ativo, mas o estado de rollback esta ausente. Interrompido." >&2
    exit 1
  }
  nginx -t
  echo "Cutover default ja esta ativo; nenhuma alteracao realizada."
  exit 0
fi

[[ $(route_count /api/whatsapp/webhook-vendas2 "${current_target}") -eq 1 ]] || {
  echo "O estagio atual nao preserva exatamente uma rota vendas2." >&2; exit 1;
}
[[ $(route_count /api/whatsapp/webhook-vendas "${current_target}") -eq 1 ]] || {
  echo "O estagio atual nao preserva exatamente uma rota vendas." >&2; exit 1;
}
[[ $(route_count /api/whatsapp/webhook "${current_target}") -eq 0 ]] || {
  echo "O webhook default ja aparece no estagio atual; interrompido." >&2; exit 1;
}
for route in /api/whatsapp/webhook-vendas2 /api/whatsapp/webhook-vendas /api/whatsapp/webhook; do
  [[ $(route_count "${route}" "${source_file}") -eq 1 ]] || {
    echo "Configuracao default invalida para ${route}." >&2; exit 1;
  }
done
grep -Fq 'proxy_pass http://127.0.0.1:5350;' "${source_file}" || {
  echo "Upstream 5350 ausente da configuracao default." >&2; exit 1;
}

mkdir -p "${backup_dir}" "${available_dir}" "${enabled_dir}" "${state_dir}"
cp -a "${site_file}" "${backup_dir}/maistv-api"
cp -a "${current_target}" "${backup_dir}/active-before.conf"
printf '%s\n' "${current_target}" > "${backup_dir}/active-before.target"
[[ ! -e ${default_file} ]] || cp -a "${default_file}" "${backup_dir}/default-before.conf"
[[ ! -e ${previous_state} ]] || {
  echo "Existe estado pendente em ${previous_state}; execute ou corrija o rollback antes." >&2
  exit 1
}

temp_default="${available_dir}/.default.conf.$$"
temp_link="${enabled_dir}/.active.conf.$$"
temp_state="${state_dir}/.default-previous-target.$$"
cleanup() { rm -f "${temp_default}" "${temp_link}" "${temp_state}"; }
trap cleanup EXIT

install -m 0644 "${source_file}" "${temp_default}"
mv -Tf "${temp_default}" "${default_file}"
printf '%s\n' "${current_target}" > "${temp_state}"
chmod 0600 "${temp_state}"
mv -Tf "${temp_state}" "${previous_state}"
ln -s "${default_file}" "${temp_link}"
mv -Tf "${temp_link}" "${active_link}"

restore_previous() {
  rm -f "${active_link}"
  ln -s "${current_target}" "${active_link}"
  rm -f "${previous_state}"
  nginx -t || true
  systemctl reload nginx || true
}

if ! nginx -t; then
  restore_previous
  echo "Cutover default revertido porque nginx -t falhou." >&2
  exit 1
fi
if ! systemctl reload nginx; then
  restore_previous
  echo "Cutover default revertido porque o reload do Nginx falhou." >&2
  exit 1
fi

echo "Cutover exclusivo do default ativo. vendas e vendas2 foram preservados."
echo "Backup: ${backup_dir}"
echo "Rollback: bash scripts/rollback-maistv-next-default-webhook-cutover.sh --confirm"
