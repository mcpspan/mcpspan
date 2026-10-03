#!/usr/bin/env bash
#
# Restores an mcpspan backup over an empty database.
#
#   docker compose down
#   docker compose up -d db
#   ./scripts/restore.sh backups/mcpspan-....dump
#   docker compose up -d
#
# The database service is started on its own first, deliberately. Bringing the
# whole stack up would run migrations and start accepting events, and restoring
# on top of that is how two versions of the truth end up in one table.
#
# Everything the dump replaces is destroyed: this drops the database and builds
# it again. That is the only way to be sure what is left is what was in the
# backup rather than a mixture.
set -euo pipefail

cd "$(dirname "$0")/.."

file="${1:-}"

if [ -z "$file" ] || [ ! -f "$file" ]; then
  printf 'Usage: %s <dump file>\n' "$0" >&2
  exit 1
fi

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

user="${POSTGRES_USER:-mcpspan}"
database="${POSTGRES_DB:-mcpspan}"

run() { docker compose exec -T db psql --username "$user" --dbname postgres -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }

# Wait for the real server, not the one that initialises the container.
#
# A freshly created container starts a temporary server to build the database,
# stops it, then starts the one that serves. Both answer on the Unix socket, so
# pg_isready and a plain psql both say yes during the first of them and a
# script that trusts either runs its opening statement into a server that is
# about to disappear. Measured: the socket answers a second before TCP does.
#
# Only the real server listens on TCP, so that is what this asks.
printf 'Waiting for the database'
for _ in $(seq 1 60); do
  if docker compose exec -T db psql --host 127.0.0.1 --username "$user" --dbname postgres -c 'SELECT 1' >/dev/null 2>&1; then
    printf ' ready\n'
    break
  fi
  printf '.'
  sleep 1
done

if ! docker compose exec -T db psql --host 127.0.0.1 --username "$user" --dbname postgres -c 'SELECT 1' >/dev/null 2>&1; then
  printf '\nThe database did not come up. Is `docker compose up -d db` running?\n' >&2
  exit 1
fi

printf 'Restoring %s into %s. Everything currently in it is discarded.\n' "$file" "$database"

# Anything still connected would block the drop. The API should not be running
# at this point; this covers a psql somebody left open.
run "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$database' AND pid <> pg_backend_pid();"
run "DROP DATABASE IF EXISTS \"$database\";"
run "CREATE DATABASE \"$database\";"

docker compose exec -T db psql --username "$user" --dbname "$database" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;" >/dev/null

# TimescaleDB keeps its own catalog, with circular foreign keys between the
# tables describing hypertables and continuous aggregates. Restoring that with
# the extension active fails on ordering; these two calls put it into a state
# where the catalog can be written as data and then have it read back.
docker compose exec -T db psql --username "$user" --dbname "$database" -v ON_ERROR_STOP=1 \
  -c "SELECT timescaledb_pre_restore();" >/dev/null

docker compose exec -T db pg_restore --username "$user" --dbname "$database" --no-owner < "$file"

docker compose exec -T db psql --username "$user" --dbname "$database" -v ON_ERROR_STOP=1 \
  -c "SELECT timescaledb_post_restore();" >/dev/null

# The signing secret the backup carried, put back where the API reads it, so
# the restored keys verify. A secret set in .env takes precedence anyway.
if [ -f "$file.secret" ] && [ -z "${API_KEY_SECRET:-}" ]; then
  docker compose run --rm --no-deps -T --entrypoint sh api \
    -c 'umask 077 && cat > /var/lib/mcpspan/api-key-secret' < "$file.secret"
  printf 'Restored the key signing secret from %s.\n' "$file.secret"
fi

printf 'Done. Start the rest with: docker compose up -d\n'
if [ ! -f "$file.secret" ]; then
  printf '\nThis backup carries no signing secret. If API_KEY_SECRET differs from the\n'
  printf 'installation it came from, every restored key will refuse to\n'
  printf 'authenticate. Restore .env too.\n'
fi
