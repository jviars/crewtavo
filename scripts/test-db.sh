#!/usr/bin/env bash
# Applies every migration to a throwaway Postgres in Docker and runs the database tests.
#   npm run test:db
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="crewtavo-db-test-$$"
IMAGE="${PG_IMAGE:-postgres:17-alpine}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -q && break
  sleep 0.5
done
sleep 1

run() { docker exec -i "$NAME" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

echo "Applying Supabase stand-ins"
run < "$ROOT/supabase/tests/prelude.sql"
for file in "$ROOT"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$file")"
  run -o /dev/null < "$file"
done
for file in "$ROOT"/supabase/tests/*_test.sql "$ROOT"/supabase/tests/rls_and_workflow.sql; do
  [ -f "$file" ] || continue
  echo "Running $(basename "$file")"
  run < "$file" 2>&1 | sed -E 's/^(psql:<stdin>:[0-9]+: )?NOTICE:  /  /'
done
