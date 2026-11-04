-- Database tests for pausing not shortening "ends after N visits" (20261106000500_pause_keeps_visit_count):
-- resuming a recurring job keeps the stretch it was paused, in the company's days, from the day it
-- was paused (the day after, when that day's visit stayed) to the day it resumed; paused and
-- resumed the same day keeps none; and only the server writes the stretches.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tpk;
grant usage on schema tpk to authenticated, service_role;
create function tpk.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tpk.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tpk to authenticated, service_role;

\set kim 'c7a10000-0000-0000-0000-000000000001'
insert into auth.users (id, email, raw_user_meta_data) values (:'kim', 'kim@kestrel-pools.test', '{"full_name": "Kim Kestrel"}');

-- Kim owns Kestrel Pools, whose day is Chicago's; two weekly jobs that end after 10 visits.
begin;
set local role authenticated;
select tpk.as_user(:'kim');
select public.create_company('Kestrel Pools', 'pool_service', 'America/Chicago') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Kai Lane') returning id as kai \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, pauses)
values (:'co', :'kai', 'Kestrel weekly', 'recurring', 'FREQ=WEEKLY;COUNT=10', current_date - 60, '[{"from": "2020-01-01", "until": "2030-01-01"}]')
returning id as job \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on)
values (:'co', :'kai', 'Kestrel kept visit', 'recurring', 'FREQ=WEEKLY;COUNT=10', current_date - 60) returning id as kept \gset
commit;
select private.company_today(:'co') as today \gset

begin;
set local role authenticated;
select tpk.as_user(:'kim');
select tpk.check((select pauses = '[]' from public.jobs where id = :'job'), 'a new job has no pauses, whatever it was given');
update public.jobs set pauses = '[{"from": "2020-01-01", "until": "2030-01-01"}]' where id = :'job';
select tpk.check((select pauses = '[]' from public.jobs where id = :'job'), 'and the office can''t write them');
-- Paused and resumed in the same day: no date went without its visit.
update public.jobs set paused_at = now() where id = :'job';
update public.jobs set paused_at = null where id = :'job';
select tpk.check((select pauses = '[]' and resumed_at = now() from public.jobs where id = :'job'), 'paused and resumed the same day keeps no stretch');
commit;

-- Both were paused ten days ago; the kept one's visit that day stayed (done before the pause).
begin;
alter table public.jobs disable trigger job_pause;
-- Ten of Chicago's days back, whatever the clocks did since.
update public.jobs set paused_at = (now() at time zone 'America/Chicago' - interval '10 days') at time zone 'America/Chicago' where id in (:'job', :'kept');
alter table public.jobs enable trigger job_pause;
insert into public.visits (company_id, job_id, title, scheduled_on, recurrence_key, status)
values (:'co', :'kept', 'Kestrel kept visit', :'today'::date - 10, (:'today'::date - 10)::text, 'completed');
commit;

begin;
set local role authenticated;
select tpk.as_user(:'kim');
update public.jobs set paused_at = null where id in (:'job', :'kept');
select tpk.check((select pauses = jsonb_build_array(jsonb_build_object('from', :'today'::date - 10, 'until', :'today'::date)) from public.jobs where id = :'job'),
  'resumed: the stretch from the day it was paused to the day it resumed, in the company''s days');
select tpk.check((select pauses = jsonb_build_array(jsonb_build_object('from', :'today'::date - 9, 'until', :'today'::date)) from public.jobs where id = :'kept'),
  'a visit that stayed on the day it was paused is one: the stretch starts the day after');
-- Paused again, and resumed by the server (the nightly run) days later.
update public.jobs set paused_at = now(), resume_on = :'today'::date + 3 where id = :'job';
commit;

begin;
alter table public.jobs disable trigger job_pause;
update public.jobs set paused_at = (now() at time zone 'America/Chicago' - interval '4 days') at time zone 'America/Chicago' where id = :'job';
alter table public.jobs enable trigger job_pause;
set local role service_role;
update public.jobs set paused_at = null where id = :'job';
select tpk.check((select jsonb_array_length(pauses) = 2 and pauses -> 1 = jsonb_build_object('from', :'today'::date - 4, 'until', :'today'::date) and resume_on is null from public.jobs where id = :'job'),
  'a second pause adds its own stretch after the first');
commit;

\echo 'All pause visit count tests passed.'
