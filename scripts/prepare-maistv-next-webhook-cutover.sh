#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Execute como root." >&2
  exit 1
fi

if [[ ${1:-} != "--confirm" ]]; then
  echo "Uso: bash scripts/prepare-maistv-next-webhook-cutover.sh --confirm" >&2
  exit 1
fi

repo_root="/root/MaisTV"
site_file="/etc/nginx/sites-available/maistv-api"
available_dir="/etc/nginx/maistv-next-webhook-cutover-available"
enabled_dir="/etc/nginx/maistv-next-webhook-cutover-enabled"
include_line="    include /etc/nginx/maistv-next-webhook-cutover-enabled/*.conf;"
backup_dir="${repo_root}/.deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-webhook-cutover-prepare"

[[ -f ${site_file} ]] || { echo "Nginx site ausente: ${site_file}" >&2; exit 1; }
grep -Eq 'server_name[[:space:]]+api\.maistv\.hakione\.tech' "${site_file}" || {
  echo "O arquivo ${site_file} nao pertence ao dominio produtivo esperado." >&2
  exit 1
}

mkdir -p "${backup_dir}" "${available_dir}" "${enabled_dir}"
if compgen -G "${enabled_dir}/*.conf" >/dev/null; then
  echo "Existe um cutover ativo em ${enabled_dir}; execute rollback antes de preparar novamente." >&2
  exit 1
fi

cp -a "${site_file}" "${backup_dir}/maistv-api"
install -m 0644 "${repo_root}/infra/nginx/production-webhook-cutover.conf" "${available_dir}/vendas2.conf"
install -m 0644 "${repo_root}/infra/nginx/production-webhook-cutover-vendas-only.conf" "${available_dir}/vendas-only.conf"
install -m 0644 "${repo_root}/infra/nginx/production-webhook-cutover-vendas.conf" "${available_dir}/vendas.conf"
install -m 0644 "${repo_root}/infra/nginx/production-webhook-cutover-all.conf" "${available_dir}/all.conf"

if ! grep -Fq "${include_line#    }" "${site_file}"; then
  temp_file="$(mktemp)"
  awk -v include_line="${include_line}" '
    !inserted && /^[[:space:]]*location \/api\/ \{/ {
      print include_line
      print ""
      inserted=1
    }
    { print }
    END { if (!inserted) exit 42 }
  ' "${site_file}" > "${temp_file}" || {
    rm -f "${temp_file}"
    echo "Nao foi possivel localizar a rota generica /api/ para inserir o include." >&2
    exit 1
  }
  install -m 0644 "${temp_file}" "${site_file}"
  rm -f "${temp_file}"
fi

if ! nginx -t; then
  cp -a "${backup_dir}/maistv-api" "${site_file}"
  nginx -t || true
  echo "Preparacao revertida porque nginx -t falhou." >&2
  exit 1
fi

systemctl reload nginx
echo "Preparacao concluida sem rota ativa. Backup: ${backup_dir}"
echo "Proximo passo controlado: bash scripts/enable-maistv-next-webhook-cutover.sh --stage vendas2 --confirm"
