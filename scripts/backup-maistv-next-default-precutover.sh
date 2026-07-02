#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ ${EUID} -eq 0 ]] || { echo "Execute como root." >&2; exit 1; }
[[ ${1:-} == "--confirm" && $# -eq 1 ]] || {
  echo "Uso: bash scripts/backup-maistv-next-default-precutover.sh --confirm" >&2
  exit 1
}

repo_root="/root/MaisTV"
container="maistv-next-postgres-1"
db_user="maistv_next"
db_name="maistv_next"
env_file="/etc/maistv-next/maistv-next.env"
site_file="/etc/nginx/sites-available/maistv-api"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${repo_root}/.deploy-backups/${timestamp}-default-precutover"

for command in docker sha256sum find sort xargs stat git du install nginx; do
  command -v "${command}" >/dev/null || { echo "Comando obrigatorio ausente: ${command}" >&2; exit 1; }
done
[[ -d ${repo_root} ]] || { echo "Repositorio ausente: ${repo_root}" >&2; exit 1; }
[[ -f ${env_file} ]] || { echo "Env ausente: ${env_file}" >&2; exit 1; }
[[ -f ${site_file} ]] || { echo "Nginx site ausente: ${site_file}" >&2; exit 1; }
docker inspect "${container}" >/dev/null 2>&1 || { echo "Container ausente: ${container}" >&2; exit 1; }
[[ $(docker inspect -f '{{.State.Running}}' "${container}") == "true" ]] || {
  echo "Container PostgreSQL nao esta em execucao: ${container}" >&2; exit 1;
}

mkdir -p "${backup_dir}/postgres" "${backup_dir}/env" "${backup_dir}/nginx" "${backup_dir}/systemd"
printf 'incomplete\n' > "${backup_dir}/.INCOMPLETE"
chmod 0700 "${backup_dir}" "${backup_dir}/postgres" "${backup_dir}/env" "${backup_dir}/nginx" "${backup_dir}/systemd"

docker exec "${container}" pg_dump \
  -U "${db_user}" -d "${db_name}" \
  --format=custom --compress=6 --no-owner --no-privileges \
  > "${backup_dir}/postgres/maistv_next.dump"

dump_size="$(stat -c '%s' "${backup_dir}/postgres/maistv_next.dump")"
[[ ${dump_size} -gt 1024 ]] || { echo "Dump PostgreSQL inesperadamente pequeno (${dump_size} bytes)." >&2; exit 1; }
docker exec -i "${container}" pg_restore --list \
  < "${backup_dir}/postgres/maistv_next.dump" >/dev/null

install -m 0600 "${env_file}" "${backup_dir}/env/maistv-next.env"
cp -a "${site_file}" "${backup_dir}/nginx/maistv-api"
[[ ! -f /etc/nginx/nginx.conf ]] || cp -a /etc/nginx/nginx.conf "${backup_dir}/nginx/nginx.conf"
[[ ! -e /etc/nginx/sites-available/homolog-test && ! -L /etc/nginx/sites-available/homolog-test ]] \
  || cp -a /etc/nginx/sites-available/homolog-test "${backup_dir}/nginx/sites-available-homolog-test"
[[ ! -e /etc/nginx/sites-enabled/homolog-test && ! -L /etc/nginx/sites-enabled/homolog-test ]] \
  || cp -a /etc/nginx/sites-enabled/homolog-test "${backup_dir}/nginx/sites-enabled-homolog-test"
[[ ! -e /etc/nginx/sites-enabled/maistv-api && ! -L /etc/nginx/sites-enabled/maistv-api ]] \
  || cp -a /etc/nginx/sites-enabled/maistv-api "${backup_dir}/nginx/sites-enabled-maistv-api"
for nginx_dir in available enabled state; do
  nginx_path="/etc/nginx/maistv-next-webhook-cutover-${nginx_dir}"
  [[ ! -e ${nginx_path} && ! -L ${nginx_path} ]] \
    || cp -a "${nginx_path}" "${backup_dir}/nginx/cutover-${nginx_dir}"
done

unit_count=0
while IFS= read -r -d '' unit_path; do
  cp -a "${unit_path}" "${backup_dir}/systemd/"
  unit_count=$((unit_count + 1))
done < <(find /etc/systemd/system -mindepth 1 -maxdepth 1 -name 'maistv-next-*' -print0)
[[ ${unit_count} -gt 0 ]] || { echo "Nenhuma unit maistv-next-* encontrada." >&2; exit 1; }

git -C "${repo_root}" rev-parse HEAD > "${backup_dir}/RELEASE_COMMIT"
printf 'created_at_utc=%s\npostgres_dump_bytes=%s\nsystemd_entries=%s\n' \
  "${timestamp}" "${dump_size}" "${unit_count}" > "${backup_dir}/BACKUP_METADATA"
nginx -t > "${backup_dir}/NGINX_TEST" 2>&1

(
  cd "${backup_dir}"
  find . -type l -printf '%P -> %l\n' | sort > SYMLINKS
  find . -type f ! -name SHA256SUMS ! -name .INCOMPLETE -print0 \
    | sort -z \
    | xargs -0 sha256sum -- > SHA256SUMS
  sha256sum --quiet -c SHA256SUMS
)

chmod -R go-rwx "${backup_dir}"
rm -f "${backup_dir}/.INCOMPLETE"

echo "Backup pre-cutover concluido e validado: ${backup_dir}"
echo "Dump PostgreSQL: ${dump_size} bytes"
echo "Units systemd copiadas: ${unit_count}"
du -sh "${backup_dir}"
