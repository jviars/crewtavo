-- Database tests for dates read in the company's zone, not UTC (20261112000310_company_day_dates):
-- a visit's invoice lines name the day it was finished on the company's calendar, west of UTC
-- (an evening there is already tomorrow in UTC) and east of it (a morning there is still yesterday
-- in UTC); and Home's "invoiced this month" starts on the 1st of the company's month, which east
-- of UTC used to take in the last day of the month before.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tcd;
grant usage on schema tcd to authenticated, service_role;
create function tcd.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tcd.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- The days an invoice's visit lines name, in the order they're printed.
create function tcd.visit_days(p_invoice uuid) returns text[] language sql as $$
  select array_agg(description order by sort) from public.invoice_line_items where invoice_id = p_invoice
$$;
-- Home's "Invoiced this month".
create function tcd.invoiced(p_company uuid) returns numeric language sql as $$
  select (public.dashboard(p_company) -> 'month' ->> 'invoiced')::numeric
$$;
grant execute on all functions in schema tcd to authenticated, service_role;

\set hana 'c7070000-0000-0000-0000-000000000001'
\set toru 'c7070000-0000-0000-0000-000000000002'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'hana', 'hana@harbor-mowing.test', '{"full_name": "Hana Harbor"}'),
  (:'toru', 'toru@tokyo-gardens.test', '{"full_name": "Toru Niwa"}');

-- ===== West of UTC: Harbor Mowing, in Los Angeles ================================================
begin;
set local role authenticated;
select tcd.as_user(:'hana');
select public.create_company('Harbor Mowing', 'lawn_exterior', 'America/Los_Angeles') as west \gset
insert into public.clients (company_id, display_name) values (:'west', 'Wes Pier') returning id as wes \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode)
values (:'west', :'wes', 'Weekly mow', 'recurring', 'FREQ=WEEKLY;BYDAY=SA', '2026-06-01', 'per_visit') returning id as mow \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price) values (:'west', :'mow', 'Mow', 1, 40);
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at) values
  -- Finished at 6pm on Saturday, Oct 31: 1am on Nov 1 in UTC.
  (:'west', :'mow', 'Mow', 'job', 'completed', '2026-10-31', '2026-11-01 01:00Z'),
  -- Finished at noon on Nov 2, the same day in UTC.
  (:'west', :'mow', 'Mow', 'job', 'completed', '2026-11-02', '2026-11-02 20:00Z'),
  -- Booked for Oct 28 and finished at noon on Oct 30: the line names the day it was finished, as it always has.
  (:'west', :'mow', 'Mow', 'job', 'completed', '2026-10-28', '2026-10-30 19:00Z');
select public.create_invoice_for_job(:'mow', 'visits') as west_inv \gset
select tcd.check(tcd.visit_days(:'west_inv') = '{"Visit on Oct 30, 2026","Visit on Oct 31, 2026","Visit on Nov 02, 2026"}',
  'a visit finished at 6pm on Oct 31 in Los Angeles is billed as Oct 31, not UTC''s Nov 1; the others as before, oldest first');

-- Home's month, where UTC's date of the company's midnight is already the company's own.
select date_trunc('month', private.company_today(:'west')::timestamp)::date as west_first \gset
insert into public.invoices (company_id, client_id, issued_on) values (:'west', :'wes', :'west_first'::date - 1) returning id as west_before \gset
insert into public.invoices (company_id, client_id, issued_on) values (:'west', :'wes', :'west_first') returning id as west_on \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price) values (:'west', :'west_before', 'Last month', 1, 70), (:'west', :'west_on', 'This month', 1, 30);
update public.invoices set status = 'sent' where id in (:'west_before', :'west_on');
select tcd.check(tcd.invoiced(:'west') = 30, 'west of UTC, invoiced this month is from the 1st, as it was: not the day before');
commit;

-- ===== East of UTC: Tokyo Gardens ================================================================
begin;
set local role authenticated;
select tcd.as_user(:'toru');
select public.create_company('Tokyo Gardens', 'lawn_exterior', 'Asia/Tokyo') as east \gset
insert into public.clients (company_id, display_name) values (:'east', 'Emi Mori') returning id as emi \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode)
values (:'east', :'emi', 'Weekly trim', 'recurring', 'FREQ=WEEKLY;BYDAY=SU', '2026-06-01', 'per_visit') returning id as trim \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price) values (:'east', :'trim', 'Trim', 1, 55);
-- Finished at 8:30am on Sunday, Nov 1 in Tokyo: still 11:30pm on Oct 31 in UTC.
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at) values
  (:'east', :'trim', 'Trim', 'job', 'completed', '2026-11-01', '2026-10-31 23:30Z');
select public.create_invoice_for_job(:'trim', 'visits') as east_inv \gset
select tcd.check(tcd.visit_days(:'east_inv') = '{"Visit on Nov 01, 2026"}', 'a visit finished at 8:30am on Nov 1 in Tokyo is billed as Nov 1, not UTC''s Oct 31');

-- Midnight on the 1st in Tokyo is 3pm the day before in UTC: that day isn't this month's.
select date_trunc('month', private.company_today(:'east')::timestamp)::date as east_first \gset
insert into public.invoices (company_id, client_id, issued_on) values (:'east', :'emi', :'east_first'::date - 1) returning id as east_before \gset
insert into public.invoices (company_id, client_id, issued_on) values (:'east', :'emi', :'east_first') returning id as east_on \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price) values (:'east', :'east_before', 'Last month', 1, 100), (:'east', :'east_on', 'This month', 1, 40);
update public.invoices set status = 'sent' where id in (:'east_before', :'east_on');
select tcd.check(tcd.invoiced(:'east') = 40, 'east of UTC, invoiced this month leaves out the last day of the month before');
commit;

\echo 'All company day dates tests passed.'
