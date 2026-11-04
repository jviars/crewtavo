-- Database tests for changing the upcoming visits in one update (20261107000400_refresh_upcoming_visits):
-- a recurring job's visits still waiting from today on get its title, crew and time where the
-- company is (the server's times, daylight saving and all), a moved one on its own day; done,
-- started, past and one-off visits stay as they were; an anytime job's have no times; only the
-- server can ask.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema ruv;
grant usage on schema ruv to authenticated, service_role;
create function ruv.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function ruv.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema ruv to authenticated, service_role;

-- The server's times (zonedTimeToUtc), clocks changing or not.
select ruv.check(private.zoned_time('2026-11-03', '09:00', 'America/Chicago') = '2026-11-03 15:00Z'
  and private.zoned_time('2026-07-01', '09:00', 'America/Chicago') = '2026-07-01 14:00Z', 'a time where the company is, in winter and summer');
select ruv.check(private.zoned_time('2026-11-01', '01:30', 'America/New_York') = '2026-11-01 05:30Z', 'one that happens twice as the clocks go back is the first');
select ruv.check(private.zoned_time('2026-03-08', '02:30', 'America/New_York') = '2026-03-08 07:30Z', 'one that doesn''t happen moves on with the clocks');
select ruv.check(private.zoned_time('2026-04-05', '02:30', 'Australia/Lord_Howe') = '2026-04-04 16:00Z', 'and half-hour changes too');
select ruv.check(private.zoned_time('2026-11-03', null, 'America/Chicago') is null, 'no time, no start');

-- Wes owns Willow Lawn in Chicago: a weekly job, and another of the same client's.
insert into auth.users (id, email, raw_user_meta_data) values
  ('d2000000-0000-0000-0000-000000000001', 'wes@willow-lawn.test', '{"full_name": "Wes Willow"}');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d2000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Willow Lawn', 'general', 'America/Chicago') as co \gset
commit;
select (now() at time zone 'America/Chicago')::date as today \gset
insert into public.crews (company_id, name) values (:'co', 'Willow crew') returning id as crew \gset
insert into public.clients (company_id, display_name) values (:'co', 'Wren Client') returning id as client \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on) values
  (:'co', :'client', 'Mow', 'recurring', 'FREQ=WEEKLY', :'today'::date - 14) returning id as job \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Other job') returning id as other_job \gset
insert into public.visits (company_id, job_id, title, recurrence_key, scheduled_on, status) values
  (:'co', :'job', 'Mow', '2036-01-15', '2036-01-15', 'scheduled'),
  (:'co', :'job', 'Mow', '2036-07-15', '2036-07-15', 'scheduled'),
  (:'co', :'job', 'Mow (moved)', '2036-02-01', '2036-02-03', 'scheduled'),
  (:'co', :'job', 'Mow (past)', (:'today'::date - 7)::text, :'today'::date - 7, 'scheduled'),
  (:'co', :'job', 'Mow (done early)', '2036-03-01', '2036-03-01', 'completed'),
  (:'co', :'job', 'Mow (on the way)', '2036-03-08', '2036-03-08', 'en_route'),
  (:'co', :'job', 'Mow (started)', '2036-03-15', '2036-03-15', 'in_progress'),
  (:'co', :'job', 'Extra trim', null, '2036-03-22', 'scheduled'),
  (:'co', :'other_job', 'Other', null, '2036-03-22', 'scheduled');
create temp table before_refresh as select id, title, crew_id, starts_at, ends_at, time_fixed from public.visits where company_id = :'co';

-- The job is renamed, given a crew and a fixed 8:30 start for 90 minutes.
update public.jobs set title = 'Mow and edge', default_crew_id = :'crew', visit_start_time = '08:30', visit_duration_min = 90, visit_time_fixed = true where id = :'job';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d2000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select ruv.expect_error(format('select public.refresh_upcoming_visits(%L)', :'job'), 'even the owner can''t ask: it''s the server''s');
rollback;

set role service_role;
select public.refresh_upcoming_visits(:'job') as changed \gset
reset role;
select ruv.check(:changed = 3, 'three visits still waiting from today on are changed');
select ruv.check((select bool_and(title = 'Mow and edge' and crew_id = :'crew' and time_fixed) from public.visits where job_id = :'job' and scheduled_on in ('2036-01-15', '2036-07-15', '2036-02-03')),
  'each gets the job''s title, crew and fixed time');
select ruv.check((select starts_at = '2036-01-15 14:30Z' and ends_at = '2036-01-15 16:00Z' from public.visits where job_id = :'job' and scheduled_on = '2036-01-15')
  and (select starts_at = '2036-07-15 13:30Z' and ends_at = '2036-07-15 15:00Z' from public.visits where job_id = :'job' and scheduled_on = '2036-07-15'),
  '8:30 to 10:00 in Chicago, winter (UTC-6) and summer (UTC-5)');
select ruv.check((select starts_at = '2036-02-03 14:30Z' from public.visits where job_id = :'job' and recurrence_key = '2036-02-01'), 'one moved by hand keeps its own day, at the job''s time');
select ruv.check(not exists (
  select 1 from public.visits v join before_refresh b on b.id = v.id
  where v.title in ('Mow (past)', 'Mow (done early)', 'Mow (on the way)', 'Mow (started)', 'Extra trim', 'Other')
    and row(v.title, v.crew_id, v.starts_at, v.ends_at, v.time_fixed) is distinct from row(b.title, b.crew_id, b.starts_at, b.ends_at, b.time_fixed)),
  'past, done, started, one-off and other jobs'' visits stay as they were');

-- Made an anytime job: its waiting visits have no times, so nothing to keep fixed.
update public.jobs set visit_start_time = null where id = :'job';
set role service_role;
select ruv.check(public.refresh_upcoming_visits(:'job') = 3, 'asked again, the same three');
reset role;
select ruv.check((select bool_and(starts_at is null and ends_at is null and not time_fixed) from public.visits where job_id = :'job' and recurrence_key in ('2036-01-15', '2036-07-15', '2036-02-01')),
  'an anytime job''s visits have no start or end');
set role service_role;
select ruv.check(public.refresh_upcoming_visits(gen_random_uuid()) = 0, 'a job that isn''t there changes nothing');
reset role;

\echo 'All refresh upcoming visits tests passed.'
