-- Database tests for 20261112000510_lookup_indexes.sql: each column these lookups go by leads an
-- index that covers every row with a value in it, and a lookup by it uses that index.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tlix;
create function tlix.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- Whether a usable index leads with the column: valid, and for every row or every row with a value
-- (an index for only some rows, like one invoice a month, doesn't count).
create function tlix.indexed(p_table regclass, p_column text) returns boolean language sql stable as $$
  select exists (
    select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = p_table and a.attname = p_column and i.indisvalid
      and (i.indpred is null or pg_get_expr(i.indpred, i.indrelid) = format('(%I IS NOT NULL)', p_column)))
$$;
-- The plan for looking rows up by the column, when Postgres isn't allowed to read the whole table.
create function tlix.plan(p_table regclass, p_column text, p_value text) returns text language plpgsql as $$
declare v_line text; v_plan text := '';
begin
  set local enable_seqscan = off;
  for v_line in execute format('explain (costs off) select 1 from %s where %I = %L', p_table, p_column, p_value) loop
    v_plan := v_plan || v_line || ' ';
  end loop;
  return v_plan;
end $$;

select tlix.check(tlix.indexed('public.' || tbl, col), format('%s are looked up by %s with an index', tbl, col))
from (values ('time_entries', 'visit_id'), ('time_entries', 'job_id'), ('checklist_responses', 'visit_id'), ('job_materials', 'visit_id'),
             ('invoices', 'job_id'), ('payments', 'client_id'), ('payments', 'received_at'), ('jobs', 'client_id')) as want(tbl, col);

begin;
select tlix.check(tlix.plan('public.' || tbl, col, val) ~ 'Index', format('and a lookup of %s by %s uses it', tbl, col))
from (values ('time_entries', 'visit_id', '00000000-0000-0000-0000-000000000000'), ('time_entries', 'job_id', '00000000-0000-0000-0000-000000000000'),
             ('checklist_responses', 'visit_id', '00000000-0000-0000-0000-000000000000'), ('job_materials', 'visit_id', '00000000-0000-0000-0000-000000000000'),
             ('invoices', 'job_id', '00000000-0000-0000-0000-000000000000'), ('payments', 'client_id', '00000000-0000-0000-0000-000000000000'),
             ('payments', 'received_at', '2026-01-01'), ('jobs', 'client_id', '00000000-0000-0000-0000-000000000000')) as want(tbl, col, val);
rollback;

set client_min_messages = warning;
drop schema tlix cascade;
reset client_min_messages;

\o
\echo 'All lookup index tests passed.'
