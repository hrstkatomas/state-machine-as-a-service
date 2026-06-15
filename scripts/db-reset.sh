#!/usr/bin/env sh
# Wipe the local dev database and re-apply migrations from scratch.
#
# Default (soft): drop & recreate the `public` schema in the running Postgres
#   container, then re-run migrations. Fast, keeps the container and the
#   separate test databases (flow_test_*) intact.
# --hard: destroy the Docker volume entirely (also recreates the test
#   databases via scripts/initdb), then re-run migrations. Use when the soft
#   reset can't get a clean state.
set -eu

cd "$(dirname "$0")/.."

DB_USER="${POSTGRES_USER:-flow}"
DB_NAME="${POSTGRES_DB:-flow}"

if [ "${1:-}" = "--hard" ]; then
  echo "Hard reset: destroying the Postgres volume..."
  docker compose down -v
  docker compose up -d --wait postgres
else
  echo "Soft reset: dropping the public schema (pass --hard to wipe the volume)..."
  docker compose exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
    -c 'drop schema public cascade;' \
    -c 'create schema public;'
fi

echo "Re-applying migrations..."
pnpm db:migrate
echo "Done — fresh database."
