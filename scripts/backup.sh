#!/usr/bin/env bash
#
# Takes a backup of a running mcpspan installation.
#
#   ./scripts/backup.sh [directory]
#
# Writes a compressed dump named after the moment it was taken. The database
# keeps serving throughout: pg_dump reads a consistent snapshot rather than
# locking anything.
#
# The dump is only half of a backup. API keys are stored as HMACs of a signing
# secret, so a database restored beside a different secret has a complete set
# of keys that all refuse to authenticate. The secret the API made itself is
# copied beside the dump, as <dump>.secret; one set in .env is not, so keep .env
# with the dump then. Keep both somewhere the machine they describe cannot take
# with it.
set -euo pipefail

cd "$(dirname "$0")/.."

directory="${1:-backups}"
mkdir -p "$directory"

# Read from .env when it is there, so this works with the credentials the
# stack was actually started with rather than only the defaults.
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

user="${POSTGRES_USER:-mcpspan}"
database="${POSTGRES_DB:-mcpspan}"
file="$directory/mcpspan-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Custom format rather than plain SQL. It is what pg_restore reads, and
# restoring a TimescaleDB database needs pg_restore's ordering control.
docker compose exec -T db pg_dump --username "$user" --format=custom --no-owner "$database" > "$file"

printf 'Wrote %s (%s)\n' "$file" "$(du -h "$file" | cut -f1)"

if [ -n "${API_KEY_SECRET:-}" ]; then
  printf '\nKeep .env beside it. Without the same API_KEY_SECRET, every restored\n'
  printf 'key is unverifiable and no server can report to the restored install.\n'
else
  # Readable by nobody else: it is what makes a key verify.
  (umask 077 && docker compose exec -T api cat /var/lib/mcpspan/api-key-secret > "$file.secret")
  printf 'Wrote %s, the key signing secret. Keep it with the dump, and private.\n' "$file.secret"
fi
