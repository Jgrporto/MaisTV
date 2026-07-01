#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Execute como root." >&2
  exit 1
fi

stage=""
confirm="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) stage="${2:-}"; shift 2 ;;
    --confirm) confirm="true"; shift ;;
    *) echo "Argumento desconhecido: $1" >&2; exit 1 ;;
  esac
done

case "${stage}" in
  vendas2|vendas-only|vendas|all) ;;
  *) echo "Use --stage vendas2, --stage vendas-only, --stage vendas ou --stage all." >&2; exit 1 ;;
esac
[[ ${confirm} == "true" ]] || { echo "Use --confirm para ativar o cutover." >&2; exit 1; }

available_dir="/etc/nginx/maistv-next-webhook-cutover-available"
enabled_dir="/etc/nginx/maistv-next-webhook-cutover-enabled"
source_file="${available_dir}/${stage}.conf"
active_link="${enabled_dir}/active.conf"
previous_target=""

[[ -f ${source_file} ]] || {
  echo "Execute primeiro: bash scripts/prepare-maistv-next-webhook-cutover.sh --confirm" >&2
  exit 1
}

if [[ -L ${active_link} ]]; then
  previous_target="$(readlink "${active_link}")"
fi

temp_link="${enabled_dir}/.active.conf.$$"
ln -s "${source_file}" "${temp_link}"
mv -Tf "${temp_link}" "${active_link}"

if ! nginx -t; then
  rm -f "${active_link}"
  if [[ -n ${previous_target} ]]; then
    ln -s "${previous_target}" "${active_link}"
  fi
  nginx -t || true
  echo "Ativacao revertida porque nginx -t falhou." >&2
  exit 1
fi

systemctl reload nginx
echo "Cutover ativo no estagio: ${stage}"
echo "Rollback: bash scripts/rollback-maistv-next-webhook-cutover.sh --confirm"
