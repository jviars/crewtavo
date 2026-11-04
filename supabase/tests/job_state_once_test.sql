-- Database tests for a job's state working today out once (20261107000300_job_state_once): each job
-- looks up the company's today once, whatever its state, and its earliest open visit comes from the
-- open visits' index. The states themselves are job_states_test.sql's, job_pause_test.sql's and
-- recurring_billing_test.sql's.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema jso;
grant usage on schema jso to authenticated, service_role;
create function jso.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function jso.plan(p_sql text) returns text language plpgsql as $$
declare v_line text; v_plan text := '';
begin
  for v_line in execute 'explain ' || p_sql loop v_plan := v_plan || v_line || E'\n'; end loop;
  return v_plan;
end $$;
grant execute on all functions in schema jso to authenticated, service_role;

-- Everything below is rolled back at the end.
begin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('d1900000-0000-0000-0000-000000000001', 'oda@olive-lawn.test', '{"full_name": "Oda Olive"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1900000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Olive Job State Lawn', 'general', 'UTC') as co \gset
reset role;
select (now() at time zone 'UTC')::date as today \gset
insert into public.clients (company_id, status, display_name) values (:'co', 'active', 'Olive Job State Client') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Late') returning id as late \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Today') returning id as on_today \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Upcoming') returning id as upcoming \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Nothing yet') returning id as bare \gset
-- A year of finished weekly visits ahead of each open one, which the index leaves out.
insert into public.visits (company_id, job_id, title, scheduled_on, status)
select :'co', j, 'Done', :'today'::date - 7 * w, 'completed' from unnest(array[:'late', :'on_today', :'upcoming']::uuid[]) j, generate_series(1, 52) w;
insert into public.visits (company_id, job_id, title, scheduled_on) values
  (:'co', :'late', 'Missed', :'today'::date - 2), (:'co', :'on_today', 'Now', :'today'), (:'co', :'upcoming', 'Soon', :'today'::date + 3);

-- Counted in this transaction: today's lookup, once a job (it was twice for today and upcoming).
set local track_functions = 'all';
create temp table states on commit drop as
  select j.title, public.job_state(j) as state from public.jobs j where j.company_id = :'co';
select jso.check((select string_agg(title || '=' || state, ', ' order by title) from states) = 'Late=late, Nothing yet=unscheduled, Today=today, Upcoming=upcoming',
  'each job''s state is as before');
select jso.check(pg_stat_get_xact_function_calls('private.company_today(uuid)'::regprocedure) = 4, 'and today is looked up once for each of the 4 jobs');

-- The earliest open visit, as job_state asks for it, comes from the open visits' index (with reading
-- the whole table ruled out: for the few visits here, it would be cheaper).
set local enable_seqscan = off;
select jso.check(jso.plan(format($q$select min(v.scheduled_on) from public.visits v
  where v.job_id = %L and v.status not in ('completed', 'cancelled') and v.scheduled_on is not null$q$, :'late')) like '%visits_open_job_day_idx%',
  'a job''s earliest open visit is read from the open visits'' index');
rollback;

\echo 'All job state once tests passed.'
