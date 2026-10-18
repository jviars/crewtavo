-- Database tests for company time zones and the hourly upkeep: a company's zone is always a zone
-- name (never an offset, which Postgres reads with the sign reversed, or a made-up zone), and one
-- company's odd clock settings fall back to the defaults instead of stopping upkeep for everyone.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t23;
grant usage on schema t23 to authenticated, service_role;
create function t23.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t23.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t23 to authenticated, service_role;

select t23.check(not exists (select 1 from public.companies where timezone not in
  (select name from pg_timezone_names where name not in ('Factory', 'posixrules'))), 'every company''s time zone is a zone name');

-- Everything below is rolled back at the end, so the upkeep run doesn't touch other tests' clocks.
begin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('d7000000-0000-0000-0000-000000000001', 'owner@quebec.test', '{"full_name": "Quinn Owner"}'),
  ('d7000000-0000-0000-0000-000000000002', 'crew@quebec.test', '{"full_name": "Quentin Crew"}'),
  ('d7000000-0000-0000-0000-000000000003', 'owner@romeo.test', '{"full_name": "Rae Owner"}');

-- ===== Only zone names ==========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t23.expect_error($$select public.create_company('Offset Lawn', 'general', '+05:00')$$, 'a new business can''t use an offset as its time zone');
select t23.expect_error($$select public.create_company('Typo Lawn', 'general', 'Not/AZone')$$, 'or a zone that doesn''t exist');
select public.create_company('Quebec Paving', 'paving', 'America/Chicago') as quebec \gset
select t23.check((select timezone from public.companies where id = :'quebec') = 'America/Chicago', 'a zone name is kept as given');
select t23.expect_error(format('update public.companies set timezone = %L where id = %L', '+05:00', :'quebec'), 'owners can''t set an offset directly either');
select t23.expect_error(format('update public.companies set timezone = %L where id = %L', 'Not/AZone', :'quebec'), 'or a made-up zone');
select t23.expect_error(format('update public.companies set timezone = %L where id = %L', 'Factory', :'quebec'), 'or Factory, which Postgres lists but browsers refuse');
select t23.expect_error(format('update public.companies set timezone = %L where id = %L', 'posixrules', :'quebec'), 'or posixrules');
update public.companies set timezone = 'Asia/Kolkata' where id = :'quebec';
select t23.check((select timezone from public.companies where id = :'quebec') = 'Asia/Kolkata', 'owners can move the business to another zone');
insert into public.memberships (company_id, user_id, role) values (:'quebec', 'd7000000-0000-0000-0000-000000000002', 'field_crew');
-- Settings people typed by hand: clock limits that aren't usable hours and a workday end that isn't a time.
update public.companies set settings = settings || '{"clock": {"remind_after_hours": "ten", "stop_after_hours": 1e12}, "working_hours": {"end": "late"}}'
where id = :'quebec';
select t23.check((select settings -> 'working_hours' ->> 'end' from public.companies where id = :'quebec') = 'late', 'other settings save as before');

select set_config('request.jwt.claims', '{"sub": "d7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.create_company('Romeo Lawn', 'lawn_exterior', 'Europe/London') as romeo \gset

-- ===== One company's odd settings don't stop clock upkeep =======================================
reset role;
insert into public.time_entries (company_id, user_id, started_at) values (:'quebec', 'd7000000-0000-0000-0000-000000000001', now() - interval '11 hours') returning id as quebec_long \gset
-- Started at 06:00 yesterday in Kolkata, so it's always past 16 hours whatever time the tests run.
insert into public.time_entries (company_id, user_id, started_at) values (:'quebec', 'd7000000-0000-0000-0000-000000000002',
  ((now() at time zone 'Asia/Kolkata')::date - 1 + time '06:00') at time zone 'Asia/Kolkata') returning id as quebec_overnight \gset
insert into public.time_entries (company_id, user_id, started_at) values (:'romeo', 'd7000000-0000-0000-0000-000000000003', now() - interval '11 hours') returning id as romeo_long \gset

set local role service_role;
select public.clock_upkeep();
reset role;
select t23.check((select reminded_at is not null and ended_at is null from public.time_entries where id = :'quebec_long'),
  'a company whose clock limits aren''t numbers gets the default reminder after 10 hours');
-- Kolkata has no daylight saving, so 18:00 that day is 12 hours after the start.
select t23.check((select ended_at = started_at + interval '12 hours' and auto_stopped_at is not null
  from public.time_entries where id = :'quebec_overnight'), 'and its overnight clock is stopped after the default 16 hours, at the default 18:00 end of its day');
select t23.check((select reminded_at is not null from public.time_entries where id = :'romeo_long'), 'other companies'' clocks are looked after too');
select t23.check((select count(*) from public.notifications where kind = 'time' and user_id in
  ('d7000000-0000-0000-0000-000000000001', 'd7000000-0000-0000-0000-000000000002', 'd7000000-0000-0000-0000-000000000003')) = 3,
  'each person hears about their clock');
rollback;

\echo 'All time zone tests passed.'
