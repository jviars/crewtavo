#!/usr/bin/env bash
# Upgrades a database that already has rows in it, the way an instance upgrades: the schema as the
# previous release left it, filled by that release's own database tests, then every migration added
# since, applied by the runner the server starts with (scripts/migrate.mjs). test-db.sh only ever
# migrates an empty database, so a migration that fails on existing rows would otherwise first fail
# on someone's instance.
#   npm run test:upgrade              from the previous release (the highest v* tag behind HEAD)
#   npm run test:upgrade -- v0.4.10   from that release
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="crewtavo-upgrade-test-$$"
IMAGE="${PG_IMAGE:-postgres:17-alpine}"
OLD="$(mktemp -d)"

cleanup() {
  docker rm -fv "$NAME" >/dev/null 2>&1 || true
  rm -rf "$OLD"
}
trap cleanup EXIT

fail() {
  echo >&2
  echo "FAILED: $*" >&2
  exit 1
}

# The release before this commit. A tag on this very commit doesn't count: when a release is being
# checked, the upgrade to test is the one from the release before it.
FROM="${1:-}"
if [ -z "$FROM" ]; then
  FROM=$(git -C "$ROOT" tag --list 'v*' --merged HEAD --no-contains HEAD | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)
  [ -n "$FROM" ] || fail "no release tag (v1.2.3) behind this commit. Fetch the tags (git fetch --tags), or name one: npm run test:upgrade -- v0.4.10"
fi
git -C "$ROOT" rev-parse --verify --quiet "$FROM^{commit}" >/dev/null || fail "$FROM isn't a tag or commit in this repository."

# That release's migrations, its runner, and the tests that will fill its tables.
git -C "$ROOT" archive "$FROM" supabase/migrations supabase/tests scripts/migrate.mjs | tar -x -C "$OLD"
ln -s "$ROOT/node_modules" "$OLD/node_modules"
[ -d "$ROOT/node_modules/postgres" ] || fail "the migration runner needs its packages. Run npm ci first."

# Instances have already applied the released migrations, and never apply one twice, so a change to
# one of them reaches new instances only and the two kinds drift apart.
changed=$(git -C "$ROOT" diff --name-status "$FROM" -- supabase/migrations | grep -v '^A' || true)
[ -z "$changed" ] || fail "migrations released in $FROM were changed or removed. Put them back and make the change in a new migration:
$changed"

migrations_in() { find "$1" -maxdepth 1 -name '[0-9]*_*.sql' -exec basename {} \; | LC_ALL=C sort; }
new=$(LC_ALL=C comm -13 <(migrations_in "$OLD/supabase/migrations") <(migrations_in "$ROOT/supabase/migrations"))
expected=$(printf '%s' "$new" | grep -c . || true)
echo "Upgrading from $FROM: $expected migration(s) added since"

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 "$IMAGE" >/dev/null
# Over TCP: while Postgres sets itself up it answers on its socket only, then restarts.
for _ in $(seq 1 120); do
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -q && break
  sleep 0.5
done
docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -q || fail "Postgres didn't start."
PORT=$(docker port "$NAME" 5432/tcp | head -n 1 | sed 's/.*://')

run() { docker exec -i "$NAME" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
migrate() { SUPABASE_DB_URL="postgres://postgres:test@127.0.0.1:$PORT/postgres" CREWTAVO_MIGRATE_WAIT=30 CREWTAVO_MIGRATE_STATUS="$OLD/status.json" node "$1"; }
applied() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).applied ?? "")' "$OLD/status.json"; }

echo "Building the database as $FROM left it"
run < "$OLD/supabase/tests/prelude.sql"
migrate "$OLD/scripts/migrate.mjs" > "$OLD/build.log" 2>&1 || { tail -n 20 "$OLD/build.log" >&2; fail "couldn't build $FROM's own schema, before any upgrade."; }

# Rows: that release's database tests commit what they make (companies, clients, jobs, invoices,
# payments and the rest), and they match its schema exactly, which a seed kept here wouldn't once the
# schema moves on. A test that fails this long after its release (one that goes by today's date,
# say) is only noted: what it committed before stopping stays, and the tables are checked below.
echo "Filling it with rows ($FROM's database tests)"
# The tests start from a database nothing has started on yet, so the row the runner keeps about the
# instance goes for now. Starting that release once more afterwards puts it back.
run -c "do \$\$ begin if to_regclass('private.instance') is not null then delete from private.instance; end if; end \$\$"
for file in "$OLD"/supabase/tests/*_test.sql "$OLD"/supabase/tests/rls_and_workflow.sql; do
  [ -f "$file" ] || continue
  run < "$file" > "$OLD/fill.log" 2>&1 || echo "  note: $(basename "$file") stopped early: $(grep -m 1 -E 'ERROR|FATAL' "$OLD/fill.log" || tail -n 1 "$OLD/fill.log")"
done
migrate "$OLD/scripts/migrate.mjs" > "$OLD/build.log" 2>&1 || { tail -n 20 "$OLD/build.log" >&2; fail "$FROM's own runner failed on its database once it had rows, before any upgrade."; }

# Every table's row count, before and after.
count_rows() {
  run -At <<'SQL'
select format('%I.%I', n.nspname, c.relname) || ' ' ||
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p') and not c.relispartition and n.nspname in ('public', 'private', 'auth', 'storage')
;
SQL
}
count_rows | LC_ALL=C sort > "$OLD/before.txt"

# The tables a business can't lose a row of. They must have rows going in, or this tests nothing,
# and exactly as many coming out.
MAIN="public.companies public.memberships public.profiles public.clients public.properties public.quotes public.quote_line_items public.jobs public.visits public.invoices public.invoice_line_items public.payments public.time_entries"
for table in $MAIN; do
  rows=$(awk -v t="$table" '$1 == t { print $2 }' "$OLD/before.txt")
  [ -n "$rows" ] || fail "$table isn't in $FROM's schema. Update the list of main tables in scripts/test-upgrade.sh."
  [ "$rows" -gt 0 ] || fail "$table has no rows after filling, so the upgrade wouldn't be tested against any."
done
echo "  $(awk '{ rows += $2 } $2 > 0 { tables++ } END { print rows " rows in " tables " of " NR " tables" }' "$OLD/before.txt")"

echo "Applying the migrations added since $FROM"
migrate "$ROOT/scripts/migrate.mjs" || fail "a migration that works on an empty database failed on one with rows in it (see above). Instances upgrading from $FROM would have stayed on $FROM."
[ "$(applied)" = "$expected" ] || fail "expected $expected migration(s) to be applied, and the runner applied $(applied)."

# A second start has nothing to do.
migrate "$ROOT/scripts/migrate.mjs" > "$OLD/again.log" 2>&1 || { tail -n 20 "$OLD/again.log" >&2; fail "the runner failed when run again on the upgraded database."; }
[ "$(applied)" = "0" ] || fail "the runner applied $(applied) migration(s) again on a database that was up to date."

count_rows | LC_ALL=C sort > "$OLD/after.txt"
lost=""
for table in $MAIN; do
  before=$(awk -v t="$table" '$1 == t { print $2 }' "$OLD/before.txt")
  after=$(awk -v t="$table" '$1 == t { print $2 }' "$OLD/after.txt")
  [ "$before" = "${after:-gone}" ] || lost="$lost
  $table: $before rows before, ${after:-gone} after"
done
[ -z "$lost" ] || fail "the upgrade changed how many rows the main tables hold:$lost"
# Other tables may gain or lose rows on purpose (a migration that fills a new table in, or tidies
# one up), so those are listed for whoever reads the log.
LC_ALL=C join -a 1 -e gone -o '0,1.2,2.2' "$OLD/before.txt" "$OLD/after.txt" | awk '$2 != $3 { print "  note: " $1 " went from " $2 " rows to " $3 }'

# What the upgraded database is for: the owner of the company with the most clients reads every
# table and view through its row checks, which run their functions against each existing row, and
# the background tasks' functions answer.
echo "Reading every table as an owner, and calling the tasks' functions"
run > /dev/null <<'SQL' || fail "the upgraded database couldn't be read as an owner, or a function the background tasks call failed (see above)."
begin;
select set_config('request.jwt.claims', json_build_object('sub', m.user_id, 'role', 'authenticated')::text, true)
  from public.memberships m
 where m.role = 'owner' and m.active
 order by (select count(*) from public.clients c where c.company_id = m.company_id) desc
 limit 1;
set local role authenticated;
do $$ begin
  if not exists (select 1 from public.clients) then raise exception 'the owner can''t see any of the company''s clients'; end if;
end $$;
select format('select count(*) from %I.%I', n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
   and has_table_privilege('authenticated', c.oid, 'select')
 order by c.relname \gexec
rollback;

begin;
set local role service_role;
select count(*) from public.review_syncs_due();
select public.refresh_upcoming_visits(id) from public.jobs;
select public.tidy_sign_in_codes();
select public.rate_limit_hit('upgrade-test', 5, 60);
rollback;
SQL

echo "Upgrade from $FROM passed: $expected migration(s) applied to a database with rows in it."
