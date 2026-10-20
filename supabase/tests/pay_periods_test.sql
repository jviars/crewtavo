-- Database tests for 20261019002100_pay_periods.sql: pay periods are the office's (with job costs),
-- and time in a period someone was marked paid for stays as it was paid until the mark is taken back.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tpay;
grant usage on schema tpay to anon, authenticated, service_role;
create function tpay.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tpay.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function tpay.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on all functions in schema tpay to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('be7a0000-0000-0000-0000-000000000001', 'owner@pay.test', '{"full_name": "Pat Owner"}'),
  ('be7a0000-0000-0000-0000-000000000002', 'office@pay.test', '{"full_name": "Oli Office"}'),
  ('be7a0000-0000-0000-0000-000000000003', 'crew@pay.test', '{"full_name": "Cam Crew"}');
\set owner 'be7a0000-0000-0000-0000-000000000001'
\set office 'be7a0000-0000-0000-0000-000000000002'
\set crew 'be7a0000-0000-0000-0000-000000000003'

begin;
set local role authenticated;
select tpay.as_user(:'owner');
select public.create_company('Pay Gardens', 'general') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'office', 'office'), (:'co', :'crew', 'field_crew');
-- Monday 2026-10-12, 8 to 4 in New York (the company's zone is UTC unless set; set it).
update public.companies set timezone = 'America/New_York' where id = :'co';
insert into public.time_entries (company_id, user_id, category, started_at, ended_at)
values (:'co', :'crew', 'visit', '2026-10-12T12:00:00Z', '2026-10-12T20:00:00Z') returning id as entry \gset
commit;

\o
\echo 'Pay periods'
\o /dev/null

-- Who sees and writes pay periods.
begin;
set local role authenticated;
select tpay.as_user(:'office');
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', '2026-10-12', '2026-10-18') returning id as period \gset
select tpay.check(tpay.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at) values (%L, %L, %L, 8, 160, 160, %L, now())', :'co', :'period', :'crew', 'check')) = 'none',
  'the office marks someone paid');
commit;

begin;
set local role authenticated;
select tpay.as_user(:'crew');
select tpay.check((select count(*) = 0 from public.pay_periods), 'field crew don''t see pay periods');
select tpay.check(tpay.error_of(format('insert into public.pay_periods (company_id, starts_on, ends_on) values (%L, %L, %L)', :'co', '2026-10-19', '2026-10-25')) like '42501:%', 'or make them');
rollback;

-- Paid time is locked, for everyone.
begin;
set local role authenticated;
select tpay.as_user(:'office');
select tpay.check(e like '42501: This time is in a pay period that''s been marked paid.%', 'paid time can''t be changed: ' || e)
from (select tpay.error_of(format('update public.time_entries set ended_at = %L where id = %L', '2026-10-12T21:00:00Z', :'entry')) as e) x;
select tpay.check(tpay.error_of(format('delete from public.time_entries where id = %L', :'entry')) like '42501:%', 'or deleted');
select tpay.check(tpay.error_of(format('insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values (%L, %L, %L, %L, %L)', :'co', :'crew', 'shop', '2026-10-13T12:00:00Z', '2026-10-13T13:00:00Z')) like '42501:%',
  'and no time is added to it');
select tpay.check(tpay.error_of(format('insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values (%L, %L, %L, %L, %L)', :'co', :'office', 'shop', '2026-10-13T12:00:00Z', '2026-10-13T13:00:00Z')) = 'none',
  'someone not marked paid still adds theirs');
select tpay.check(tpay.error_of(format('insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values (%L, %L, %L, %L, %L)', :'co', :'crew', 'shop', '2026-10-20T12:00:00Z', '2026-10-20T13:00:00Z')) = 'none',
  'and the next week is open');
rollback;

-- Taking the mark back unlocks it.
begin;
set local role authenticated;
select tpay.as_user(:'office');
update public.pay_period_lines set paid_at = null where period_id = :'period';
select tpay.check(tpay.error_of(format('update public.time_entries set ended_at = %L where id = %L', '2026-10-12T21:00:00Z', :'entry')) = 'none', 'once the paid mark is taken back, the time can change again');
rollback;

\o
\echo 'All pay period tests passed.'
