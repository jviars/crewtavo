-- Database tests for 20261112000400_paid_hours_once.sql: with overlapping pay periods, a line marked
-- paid carries only hours no other period has paid, and a mark can't be taken back while a later
-- overlapping one that left its days out still stands. Lines from before the migration stay as they are.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tonce;
grant usage on schema tonce to anon, authenticated, service_role;
create function tonce.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tonce.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function tonce.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on all functions in schema tonce to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('0ce00000-0000-0000-0000-000000000001', 'owner@once.test', '{"full_name": "Pat Owner"}'),
  ('0ce00000-0000-0000-0000-000000000002', 'crew@once.test', '{"full_name": "Cam Crew"}');
\set owner '0ce00000-0000-0000-0000-000000000001'
\set crew '0ce00000-0000-0000-0000-000000000002'

begin;
set local role authenticated;
select tonce.as_user(:'owner');
select public.create_company('Once Roofing', 'general') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'crew', 'field_crew');
update public.companies set timezone = 'America/New_York' where id = :'co';
-- Cam: 8 hours on Monday Oct 5 and 8 on Monday Oct 12 (8 to 4 in New York), and an evening hour
-- on Sunday Oct 11 that is already Monday in UTC: it belongs to the first week, as the lock counts days.
insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values
  (:'co', :'crew', 'visit', '2026-10-05T12:00:00Z', '2026-10-05T20:00:00Z'),
  (:'co', :'crew', 'shop', '2026-10-12T01:00:00Z', '2026-10-12T02:00:00Z'),
  (:'co', :'crew', 'visit', '2026-10-12T12:00:00Z', '2026-10-12T20:00:00Z');
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', '2026-10-05', '2026-10-11') returning id as week \gset
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', '2026-10-05', '2026-10-18') returning id as two \gset
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', '2026-10-19', '2026-10-25') returning id as next \gset
commit;

\o
\echo 'Paid hours once'
\o /dev/null

-- Last week is paid; the last two weeks then pay only the week that isn't.
begin;
set local role authenticated;
select tonce.as_user(:'owner');
select tonce.check(tonce.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at) values (%L, %L, %L, 9, 180, 180, %L, now())', :'co', :'week', :'crew', 'check')) = 'none',
  'last week is marked paid: 9 hours');
select tonce.check((select marked_at is not null from public.pay_period_lines where period_id = :'week'), 'and the line says when it was marked');
select tonce.check(e like '22023: Some of their hours in this period have already been paid with another period (8.00 h are left to pay).%', 'the last two weeks can''t be marked at all 17 hours: ' || e)
from (select tonce.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at) values (%L, %L, %L, 17, 340, 340, %L, now())', :'co', :'two', :'crew', 'check')) as e) x;
select tonce.check(tonce.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount) values (%L, %L, %L, 17, 340)', :'co', :'two', :'crew')) = 'none',
  'a line that isn''t marked paid isn''t checked');
select tonce.check(e like '22023: Some of their hours%', 'marking that line paid is: ' || e)
from (select tonce.error_of(format('update public.pay_period_lines set paid_at = now(), method = %L where period_id = %L', 'check', :'two')) as e) x;
select tonce.check(tonce.error_of(format('update public.pay_period_lines set hours = 8, amount = 160, paid_amount = 160, paid_at = now(), method = %L where period_id = %L', 'check', :'two')) = 'none',
  'at the 8 hours that are left, it''s marked paid');
select tonce.check(tonce.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at) values (%L, %L, %L, 3, 60, 60, %L, now())', :'co', :'next', :'crew', 'check')) = 'none',
  'a period that overlaps no paid one is marked as before');

-- When it was marked is the database's to say.
update public.pay_period_lines set marked_at = '2000-01-01' where period_id = :'two';
select tonce.check((select marked_at > now() - interval '1 hour' from public.pay_period_lines where period_id = :'two'), 'marked_at can''t be set by hand');

-- The two weeks left last week's days out, so last week's mark stays while the two weeks' stands.
select tonce.check(e like '22023: Cam Crew was also marked paid for Oct 5 to Oct 18 after this%', 'last week''s mark can''t be taken back first: ' || e)
from (select tonce.error_of(format('update public.pay_period_lines set paid_at = null where period_id = %L', :'week')) as e) x;
select tonce.check(tonce.error_of(format('update public.pay_period_lines set paid_at = null where period_id = %L', :'two')) = 'none', 'the later one is taken back first');
select tonce.check((select marked_at is null from public.pay_period_lines where period_id = :'two'), 'which clears when it was marked');
select tonce.check(tonce.error_of(format('update public.pay_period_lines set paid_at = null where period_id = %L', :'week')) = 'none', 'then the earlier one');
-- With neither paid, the two weeks can be marked at everything in them.
select tonce.check(tonce.error_of(format('update public.pay_period_lines set hours = 17, paid_at = now(), method = %L where period_id = %L', 'check', :'two')) = 'none', 'with nothing else paid, the two weeks are marked at all 17 hours');
rollback;

-- Lines from before the migration: two overlapping periods both marked paid in full, with no marked_at.
begin;
set local session_replication_role = replica;
insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at) values
  (:'co', :'week', :'crew', 9, 180, 180, 'check', '2026-10-12T16:00:00Z'),
  (:'co', :'two', :'crew', 17, 340, 340, 'check', '2026-10-19T16:00:00Z');
set local session_replication_role = origin;
set local role authenticated;
select tonce.as_user(:'owner');
select tonce.check((select count(*) = 2 and bool_and(marked_at is null) and sum(paid_amount) = 520 from public.pay_period_lines where company_id = :'co'), 'old overlapping paid lines stay as they were recorded');
select tonce.check(tonce.error_of(format('update public.pay_period_lines set reference = %L where period_id = %L', '1042', :'two')) = 'none', 'and can still be written to');
savepoint marked;
select tonce.check(tonce.error_of(format('update public.pay_period_lines set paid_at = null where period_id = %L', :'week')) = 'none', 'either old mark can be taken back: the week''s');
rollback to marked;
select tonce.check(tonce.error_of(format('update public.pay_period_lines set paid_at = null where period_id = %L', :'two')) = 'none', 'or the two weeks''');
-- Marked again now, the two weeks pay only what the week didn't.
select tonce.check(tonce.error_of(format('update public.pay_period_lines set paid_at = now(), method = %L where period_id = %L', 'check', :'two')) like '22023: Some of their hours%', 'marked again, the two weeks can''t carry the week''s hours a second time');
select tonce.check(tonce.error_of(format('update public.pay_period_lines set hours = 8, amount = 160, paid_amount = 160, paid_at = now(), method = %L where period_id = %L', 'check', :'two')) = 'none', 'only the 8 that are left');
select tonce.check(tonce.error_of(format('update public.pay_period_lines set paid_at = null where period_id = %L', :'week')) like '22023: Cam Crew was also marked paid%', 'and now the old week''s mark waits for the newer one');
rollback;

\o
\echo 'All paid-hours-once tests passed.'
