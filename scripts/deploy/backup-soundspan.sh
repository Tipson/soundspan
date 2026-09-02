#!/bin/sh
set -eu

umask 077

container_name=${SOUNDSPAN_POSTGRES_CONTAINER_NAME:-}
backup_dir=${SOUNDSPAN_BACKUP_DIR:-/opt/music-stack/soundspan/backups}
database_user=${SOUNDSPAN_POSTGRES_USER:-soundspan}
backup_kind=${1:-pre-provision}
retention_days=${SOUNDSPAN_BACKUP_RETENTION_DAYS:-30}

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: run as root on the Soundspan Docker host' >&2
  exit 1
fi
case "$backup_kind" in
  pre-provision|nightly) ;;
  *) echo 'ERROR: backup kind must be pre-provision or nightly' >&2; exit 1 ;;
esac
case "$retention_days" in
  ''|*[!0-9]*) echo 'ERROR: SOUNDSPAN_BACKUP_RETENTION_DAYS must be an integer' >&2; exit 1 ;;
esac
if [ "$retention_days" -lt 7 ] || [ "$retention_days" -gt 3650 ]; then
  echo 'ERROR: backup retention must be between 7 and 3650 days' >&2
  exit 1
fi
for required in docker flock sha256sum find; do
  command -v "$required" >/dev/null 2>&1 || {
    echo "ERROR: required command is missing: $required" >&2
    exit 1
  }
done
if [ -z "$container_name" ]; then
  if [ "$(docker inspect -f '{{.State.Running}}' soundspan-prod-postgres 2>/dev/null || true)" = true ]; then
    container_name=soundspan-prod-postgres
  else
    # Rollback compatibility while the retained AIO container remains the
    # active database owner.
    container_name=soundspan
  fi
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != true ]; then
  echo "ERROR: Soundspan PostgreSQL container is not running: $container_name" >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$backup_dir"
if [ -L "$backup_dir" ] || [ "$(stat -c '%U:%G:%a' "$backup_dir")" != root:root:700 ]; then
  echo "ERROR: unsafe Soundspan backup directory: $backup_dir" >&2
  exit 1
fi
exec 9>/run/lock/music-soundspan-backup.lock
if ! flock -n 9; then
  echo 'SOUNDSPAN_BACKUP_SKIPPED_ALREADY_RUNNING'
  exit 0
fi
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file=${backup_dir}/soundspan-${backup_kind}-${timestamp}.dump
backup_tmp=$(mktemp "${backup_dir}/.soundspan-backup.XXXXXX")
cleanup() {
  status=$?
  rm -f "$backup_tmp"
  return "$status"
}
trap cleanup EXIT INT TERM

docker exec --user postgres "$container_name" \
  pg_dump --format=custom --no-owner --no-acl --username="$database_user" --dbname=soundspan >"$backup_tmp"
if [ ! -s "$backup_tmp" ]; then
  echo 'ERROR: pg_dump produced an empty file' >&2
  exit 1
fi
docker exec --user postgres -i "$container_name" \
  pg_restore --list >/dev/null <"$backup_tmp"

chmod 0600 "$backup_tmp"
chown root:root "$backup_tmp"
mv "$backup_tmp" "$backup_file"

backup_size=$(stat -c '%s' "$backup_file")
backup_sha256=$(sha256sum "$backup_file" | awk '{print $1}')
printf '%s  %s\n' "$backup_sha256" "$(basename "$backup_file")" > "$backup_file.sha256"
docker exec --user postgres "$container_name" pg_restore --version > "$backup_file.tool-version"
chmod 0600 "$backup_file.sha256" "$backup_file.tool-version"

if [ "$backup_kind" = nightly ]; then
  find "$backup_dir" -mindepth 1 -maxdepth 1 -type f \
    -name 'soundspan-nightly-*.dump' -mtime "+$retention_days" -print |
  while IFS= read -r old_dump; do
    case "$old_dump" in
      "$backup_dir"/soundspan-nightly-*.dump)
        rm -f -- "$old_dump" "$old_dump.sha256" "$old_dump.tool-version"
        ;;
      *) echo 'ERROR: refusing to prune outside the approved directory' >&2; exit 1 ;;
    esac
  done
fi
printf 'SOUNDSPAN_BACKUP_OK path=%s bytes=%s sha256=%s\n' \
  "$backup_file" "$backup_size" "$backup_sha256"
