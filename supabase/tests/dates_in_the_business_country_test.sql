-- Database tests for 20261124100510_words_for_clients_subs_and_crew.sql and
-- 20261124100520_office_words_in_the_business_country.sql: the words the database writes for
-- people say dates, times and amounts the way the business's country and currency do. A UK business
-- in pounds reads "Tue 2 Nov", "17:00" and "£2,040.50", a Canadian one "Tue Nov 2", "5:00 p.m." and
-- "$2,040.50", and a US business in dollars reads every word as before: the new functions beside the
-- old ones write the old ones' words for it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tdbc;
grant usage on schema tdbc to authenticated, service_role;
create function tdbc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tdbc.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- The 'jobs' notices a sub's sign-in has about a pay, oldest first.
create function tdbc.told(p_user uuid, p_pay uuid) returns text[] language sql security definer as $$
  select coalesce(array_agg(title order by created_at, id), '{}') from public.notifications where user_id = p_user and kind = 'jobs' and link = '/field/jobs/' || p_pay
$$;
-- The newest notice someone has.
create function tdbc.last_title(p_user uuid) returns text language sql security definer as $$
  select title from public.notifications where user_id = p_user order by created_at desc, id desc limit 1
$$;
-- "Mon 1 Nov" and "Mon Nov 1": a day as a country writes it, spelled out here with to_char rather
-- than with private.date_text.
create function tdbc.day_first(p_at timestamp) returns text language sql immutable as $$ select to_char(p_at, 'Dy FMDD Mon') $$;
create function tdbc.month_first(p_at timestamp) returns text language sql immutable as $$ select to_char(p_at, 'Dy Mon FMDD') $$;
grant execute on all functions in schema tdbc to authenticated, service_role;

-- ===== Beside the old functions, the new ones write a US business's words as before ============
select tdbc.check(not exists (
  select 1 from generate_series('2026-01-01 00:00+00'::timestamptz, '2027-01-01 00:00+00'::timestamptz, interval '5 hours 7 minutes') t
    cross join (values ('America/New_York'), ('America/Los_Angeles'), ('Pacific/Honolulu'), (null)) z (tz)
  where private.visit_when(t, null, z.tz, 'US') is distinct from private.visit_when(t, null, z.tz)
     or private.visit_when(null, (t at time zone 'UTC')::date, z.tz, 'US') is distinct from private.visit_when(null, (t at time zone 'UTC')::date, z.tz)
     or private.visit_when(t, null, z.tz, 'PR') is distinct from private.visit_when(t, null, z.tz)
), 'a visit''s day and time in the US read as before');
select tdbc.check(private.visit_when(null, null, 'Europe/London', 'GB') = 'no date yet' and private.visit_when(null, null, null, 'US') = private.visit_when(null, null, null),
  'and a visit with no day yet says so');

select tdbc.check(not exists (
  select 1 from generate_series(0, 700) k cross join (values ('America/New_York'), ('America/Chicago'), ('Pacific/Honolulu')) z (tz)
  where private.auto_post_when(now() + k * interval '97 minutes', z.tz, 'US') is distinct from private.auto_post_when(now() + k * interval '97 minutes', z.tz)
     or private.auto_post_when(now() + k * interval '97 minutes', z.tz, 'PH') is distinct from private.auto_post_when(now() + k * interval '97 minutes', z.tz)
     or private.auto_post_when(now() + k * interval '97 minutes', z.tz, null) is distinct from private.auto_post_when(now() + k * interval '97 minutes', z.tz)
), 'when an automatic post goes out reads as before in the US, today, tomorrow and weeks out');
select tdbc.check(not exists (
  select 1 from generate_series(0, 2) d cross join (values (time '00:00'), (time '00:30'), (time '12:00'), (time '12:05'), (time '10:00'), (time '23:00')) h (at)
  where private.auto_post_when(((now() at time zone 'America/New_York')::date + d + h.at) at time zone 'America/New_York', 'America/New_York', 'US')
    is distinct from private.auto_post_when(((now() at time zone 'America/New_York')::date + d + h.at) at time zone 'America/New_York', 'America/New_York')
) and private.auto_post_when(((now() at time zone 'America/New_York')::date + 1 + time '00:00') at time zone 'America/New_York', 'America/New_York', 'US') = 'tomorrow at 12 AM'
  and private.auto_post_when(((now() at time zone 'America/New_York')::date + 1 + time '12:30') at time zone 'America/New_York', 'America/New_York', 'US') = 'tomorrow at 12:30 PM',
  'and around midnight and noon');

\set rows '''[{"kind": "percent", "value": 30, "due": "approval"}, {"kind": "amount", "value": 600, "due": "work_done"}]'''
\set over '''[{"kind": "percent", "value": 30, "due": "approval"}, {"kind": "amount", "value": 800, "due": "work_done"}]'''
\set dated '''[{"kind": "percent", "value": 30, "due": "date", "on": "2026-03-01"}, {"kind": "rest", "due": "work_done"}]'''
select tdbc.check(private.schedule_problem(:rows, 1000, 'USD') = private.schedule_problem(:rows, 1000)
  and private.schedule_problem(:over, 1000, 'CAD') = private.schedule_problem(:over, 1000)
  and private.schedule_problem(:rows, 1000, 'USD') = 'The payments come to $100.00 less than the total.'
  and private.schedule_date_problem(:dated, '2026-11-01', 'US') = private.schedule_date_problem(:dated, '2026-11-01')
  and private.schedule_date_problem(:dated, '2026-11-01', 'US') = 'Payment 1 is due on Mar 1, 2026, which has already passed. Give it a new date.',
  'a payment schedule''s problems read as before in the US');
select tdbc.check(private.schedule_problem(:rows, 1000, 'GBP') = 'The payments come to £100.00 less than the total.'
  and private.schedule_problem(:over, 1000, 'EUR') = 'The payments come to €100.00 more than the total.'
  and private.schedule_date_problem(:dated, '2026-11-01', 'GB') = 'Payment 1 is due on 1 Mar 2026, which has already passed. Give it a new date.'
  and private.schedule_date_problem(:dated, '2026-11-01', 'CA') = 'Payment 1 is due on Mar 1, 2026, which has already passed. Give it a new date.',
  'and in the UK in pounds, in euros, and in Canada');

-- ===== What a sub reads: an offer's days, the time to answer by, and what they're paid ==========
\set olive 'e1240000-0000-4000-8000-000000000001'
\set cora 'e1240000-0000-4000-8000-000000000002'
\set una 'e1240000-0000-4000-8000-000000000003'
\set sid 'e1240000-0000-4000-8000-000000000004'
\set cal 'e1240000-0000-4000-8000-000000000005'
\set ulf 'e1240000-0000-4000-8000-000000000006'
\set gwen 'e1240000-0000-4000-8000-000000000007'
\set carl 'e1240000-0000-4000-8000-000000000008'
\set uri 'e1240000-0000-4000-8000-000000000009'
\set gbsub 'e1240000-0000-4000-8000-0000000000a1'
\set casub 'e1240000-0000-4000-8000-0000000000a2'
\set ussub 'e1240000-0000-4000-8000-0000000000a3'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@thames.test', '{"full_name": "Olive Owner"}'),
  (:'cora', 'cora@maple.test', '{"full_name": "Cora Owner"}'),
  (:'una', 'una@union.test', '{"full_name": "Una Owner"}'),
  (:'sid', 'sid@slate.test', '{"full_name": "Sid Slate"}'),
  (:'cal', 'cal@cedar.test', '{"full_name": "Cal Cedar"}'),
  (:'ulf', 'ulf@uplands.test', '{"full_name": "Ulf Uplands"}'),
  (:'gwen', 'gwen@thames.test', '{"full_name": "Gwen Crew"}'),
  (:'carl', 'carl@maple.test', '{"full_name": "Carl Crew"}'),
  (:'uri', 'uri@union.test', '{"full_name": "Uri Crew"}');

begin;
set local role authenticated;
select tdbc.as_user(:'olive');
select public.create_company('Thames Roofing', 'roofing', 'Europe/London') as gb \gset
select tdbc.as_user(:'cora');
select public.create_company('Maple Roofing', 'roofing', 'America/Toronto') as ca \gset
select tdbc.as_user(:'una');
select public.create_company('Union Roofing', 'roofing', 'America/New_York') as us \gset
commit;
update public.companies set country = 'GB', currency = 'GBP' where id = :'gb';
update public.companies set country = 'CA', currency = 'CAD' where id = :'ca';
insert into public.memberships (company_id, user_id, role) values (:'gb', :'gwen', 'field_crew'), (:'ca', :'carl', 'field_crew'), (:'us', :'uri', 'field_crew');

-- Each has a sub on a roof with two visits: Tuesday 2 and Thursday 4 November 2027.
begin;
set local role authenticated;
select tdbc.as_user(:'olive');
insert into public.subcontractors (id, company_id, name) values (:'gbsub', :'gb', 'Slate & Sons');
insert into public.clients (company_id, display_name) values (:'gb', 'Ann Smith') returning id as gb_client \gset
insert into public.jobs (company_id, client_id, title) values (:'gb', :'gb_client', 'Smith roof') returning id as gb_job \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'gb', :'gb_job', 'Smith roof', '2027-11-02') returning id as gb_v1 \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'gb', :'gb_job', 'Smith roof', '2027-11-04') returning id as gb_v2 \gset
select public.job_pay_start(:'gb_job', :'gbsub', null, array[:'gb_v1', :'gb_v2']::uuid[]) as gb_pay \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, rate) values (:'gb', :'gb_pay', 'Re-roof', 2040.5);
select tdbc.as_user(:'cora');
insert into public.subcontractors (id, company_id, name) values (:'casub', :'ca', 'Cedar Roofers');
insert into public.clients (company_id, display_name) values (:'ca', 'Ann Smith') returning id as ca_client \gset
insert into public.jobs (company_id, client_id, title) values (:'ca', :'ca_client', 'Smith roof') returning id as ca_job \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'ca', :'ca_job', 'Smith roof', '2027-11-02') returning id as ca_v1 \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'ca', :'ca_job', 'Smith roof', '2027-11-04') returning id as ca_v2 \gset
select public.job_pay_start(:'ca_job', :'casub', null, array[:'ca_v1', :'ca_v2']::uuid[]) as ca_pay \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, rate) values (:'ca', :'ca_pay', 'Re-roof', 2040.5);
select tdbc.as_user(:'una');
insert into public.subcontractors (id, company_id, name) values (:'ussub', :'us', 'Uplands Roofing');
insert into public.clients (company_id, display_name) values (:'us', 'Ann Smith') returning id as us_client \gset
insert into public.jobs (company_id, client_id, title) values (:'us', :'us_client', 'Smith roof') returning id as us_job \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'us', :'us_job', 'Smith roof', '2027-11-02') returning id as us_v1 \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'us', :'us_job', 'Smith roof', '2027-11-04') returning id as us_v2 \gset
select public.job_pay_start(:'us_job', :'ussub', null, array[:'us_v1', :'us_v2']::uuid[]) as us_pay \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, rate) values (:'us', :'us_pay', 'Re-roof', 2040.5);
commit;
insert into public.memberships (company_id, user_id, role, subcontractor_id) values
  (:'gb', :'sid', 'subcontractor', :'gbsub'), (:'ca', :'cal', 'subcontractor', :'casub'), (:'us', :'ulf', 'subcontractor', :'ussub');

select tdbc.check(private.sub_offer_line(:'gb_pay') = 'Smith roof, Tue 2 Nov to Thu 4 Nov, £2,040.50', 'an offer from a UK business gives its days day first, in pounds');
select tdbc.check(private.sub_offer_line(:'ca_pay') = 'Smith roof, Tue Nov 2 to Thu Nov 4, $2,040.50', 'one from a Canadian business month first, in dollars');
select tdbc.check(private.sub_offer_line(:'us_pay') = 'Smith roof, Tue Nov 2 to Thu Nov 4, $2,040.50', 'and a US business''s reads as before');

-- To answer by 5 PM a week from today, where each business is.
select ((current_date + 7) + time '17:00') as by_local \gset
begin;
set local role authenticated;
select tdbc.as_user(:'olive');
select public.send_sub_offer(:'gb_pay', :'by_local'::timestamp at time zone 'Europe/London');
select tdbc.as_user(:'cora');
select public.send_sub_offer(:'ca_pay', :'by_local'::timestamp at time zone 'America/Toronto');
select tdbc.as_user(:'una');
select public.send_sub_offer(:'us_pay', :'by_local'::timestamp at time zone 'America/New_York');
commit;
select tdbc.check(private.local_time_words(:'gb', :'by_local'::timestamp at time zone 'Europe/London') = tdbc.day_first(:'by_local') || ', 17:00'
  and private.local_time_words(:'ca', :'by_local'::timestamp at time zone 'America/Toronto') = tdbc.month_first(:'by_local') || ', 5:00 p.m.'
  and private.local_time_words(:'us', :'by_local'::timestamp at time zone 'America/New_York') = tdbc.month_first(:'by_local') || ', 5:00 PM',
  'the time to answer by: 17:00 in the UK, 5:00 p.m. in Canada, 5:00 PM in the US');
-- In two parts (the day, then the time), and in the US exactly to_char's 'Dy Mon FMDD, FMHH12:MI AM',
-- around midnight and noon too.
select tdbc.check(not exists (
  select 1 from generate_series('2026-01-01 00:00+00'::timestamptz, '2027-01-01 00:00+00'::timestamptz, interval '47 minutes') t
  where private.local_time_words(:'us', t) is distinct from to_char(t at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM')
) and private.local_time_words(:'us', '2026-03-09 00:05'::timestamp at time zone 'America/New_York') = 'Mon Mar 9, 12:05 AM'
  and private.local_time_words(:'us', '2026-03-09 12:00'::timestamp at time zone 'America/New_York') = 'Mon Mar 9, 12:00 PM'
  and private.local_time_words(:'gb', '2026-03-09 00:05'::timestamp at time zone 'Europe/London') = 'Mon 9 Mar, 00:05'
  and private.local_time_words(:'ca', '2026-03-09 12:00'::timestamp at time zone 'America/Toronto') = 'Mon Mar 9, 12:00 p.m.',
  'a US business''s time to answer by is to_char''s, byte for byte, at every hour');
select tdbc.check(tdbc.told(:'sid', :'gb_pay') = array['Smith roof, Tue 2 Nov to Thu 4 Nov, £2,040.50. Answer by ' || tdbc.day_first(:'by_local') || ', 17:00. Open Crewtavo to accept or decline.'],
  'the UK sub''s offer says its days and the time to answer by the UK''s way');
select tdbc.check(tdbc.told(:'cal', :'ca_pay') = array['Smith roof, Tue Nov 2 to Thu Nov 4, $2,040.50. Answer by ' || tdbc.month_first(:'by_local') || ', 5:00 p.m. Open Crewtavo to accept or decline.'],
  'the Canadian sub''s Canada''s way');
select tdbc.check(tdbc.told(:'ulf', :'us_pay') = array['Smith roof, Tue Nov 2 to Thu Nov 4, $2,040.50. Answer by ' || tdbc.month_first(:'by_local') || ', 5:00 PM. Open Crewtavo to accept or decline.'],
  'and the US sub''s as before');

-- Taken, done and paid: "Paid £2,040.50 on 24 Nov".
begin;
set local role authenticated;
select tdbc.as_user(:'sid');
select public.answer_sub_offer(:'gb_pay', true);
select tdbc.as_user(:'cal');
select public.answer_sub_offer(:'ca_pay', true);
select tdbc.as_user(:'ulf');
select public.answer_sub_offer(:'us_pay', true);
commit;
-- Each on the business's own today: past midnight in London it's still yesterday in Toronto.
update public.job_pay set status = 'done', earned_on = private.company_today(company_id) where id in (:'gb_pay', :'ca_pay', :'us_pay');
begin;
set local role authenticated;
select tdbc.as_user(:'olive');
select public.job_pay_mark_paid(array[:'gb_pay']::uuid[], 'check', private.company_today(:'gb'));
select tdbc.as_user(:'cora');
select public.job_pay_mark_paid(array[:'ca_pay']::uuid[], 'check', private.company_today(:'ca'));
select tdbc.as_user(:'una');
select public.job_pay_mark_paid(array[:'us_pay']::uuid[], 'check', private.company_today(:'us'));
commit;
select tdbc.check(tdbc.told(:'sid', :'gb_pay') @> array['Paid £2,040.50 on ' || (select to_char(paid_at at time zone 'Europe/London', 'FMDD Mon') from public.job_pay where id = :'gb_pay')],
  'what the UK sub is paid says the day first, in pounds');
select tdbc.check(tdbc.told(:'cal', :'ca_pay') @> array['Paid $2,040.50 on ' || (select to_char(paid_at at time zone 'America/Toronto', 'Mon FMDD') from public.job_pay where id = :'ca_pay')],
  'the Canadian sub''s the month first');
select tdbc.check(tdbc.told(:'ulf', :'us_pay') @> array['Paid $2,040.50 on ' || (select to_char(paid_at at time zone 'America/New_York', 'Mon FMDD') from public.job_pay where id = :'us_pay')],
  'and the US sub''s as before');

-- ===== What the crew reads: a visit they're put on, with its time ===============================
begin;
set local role authenticated;
select tdbc.as_user(:'olive');
insert into public.visits (company_id, title, kind, starts_at, ends_at) values
  (:'gb', 'Clear the gutters', 'task', '2027-11-02 09:30'::timestamp at time zone 'Europe/London', '2027-11-02 11:00'::timestamp at time zone 'Europe/London') returning id as gb_task \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'gb', :'gb_task', :'gwen');
select tdbc.as_user(:'cora');
insert into public.visits (company_id, title, kind, starts_at, ends_at) values
  (:'ca', 'Clear the gutters', 'task', '2027-11-02 14:30'::timestamp at time zone 'America/Toronto', '2027-11-02 16:00'::timestamp at time zone 'America/Toronto') returning id as ca_task \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'ca', :'ca_task', :'carl');
select tdbc.as_user(:'una');
insert into public.visits (company_id, title, kind, starts_at, ends_at) values
  (:'us', 'Clear the gutters', 'task', '2027-11-02 14:30'::timestamp at time zone 'America/New_York', '2027-11-02 16:00'::timestamp at time zone 'America/New_York') returning id as us_task \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'us', :'us_task', :'uri');
commit;
select tdbc.check(tdbc.last_title(:'gwen') = 'You''re on Clear the gutters: Tue 2 Nov, 09:30', 'the UK crew is told the day first and the time on a 24-hour clock');
select tdbc.check(tdbc.last_title(:'carl') = 'You''re on Clear the gutters: Tue Nov 2, 2:30 p.m.', 'the Canadian crew the month first and "p.m."');
select tdbc.check(tdbc.last_title(:'uri') = 'You''re on Clear the gutters: Tue Nov 2, 2:30 PM', 'and the US crew as before');

-- ===== What the office reads, and a client's invoice: an amount and the day it was due ==========
begin;
set local role authenticated;
select tdbc.as_user(:'olive');
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'gb', :'gb_client', '2026-09-06', '2026-10-06') returning id as gb_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable) values (:'gb', :'gb_inv', 'Cleanup', 1, 'ea', 1250, false);
update public.invoices set status = 'sent' where id = :'gb_inv';
select tdbc.as_user(:'cora');
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'ca', :'ca_client', '2026-09-06', '2026-10-06') returning id as ca_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable) values (:'ca', :'ca_inv', 'Cleanup', 1, 'ea', 1250, false);
update public.invoices set status = 'sent' where id = :'ca_inv';
select tdbc.as_user(:'una');
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'us', :'us_client', '2026-09-06', '2026-10-06') returning id as us_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable) values (:'us', :'us_inv', 'Cleanup', 1, 'ea', 1250, false);
update public.invoices set status = 'sent' where id = :'us_inv';
commit;
-- Sent after the day it was due, each is past due at once.
select tdbc.check(exists (select 1 from public.activity a join public.invoices i on i.id = a.subject_id
                          where a.subject_id = :'gb_inv' and a.verb = 'invoice.overdue' and a.summary = format('Invoice #%s for Ann Smith is past due (£1,250.00 owing)', i.number)),
  'the UK business''s Activity says what''s owing in pounds');
select tdbc.check(exists (select 1 from public.activity a join public.invoices i on i.id = a.subject_id
                          where a.subject_id = :'us_inv' and a.verb = 'invoice.overdue' and a.summary = format('Invoice #%s for Ann Smith is past due ($1,250.00 owing)', i.number)),
  'the US business''s in dollars, as before');

-- A late fee goes on each: its line says the day the invoice was due. (Rolled back, late fees and
-- all: the run is for every business, and other tests count what it does.)
begin;
update public.companies set settings = settings || '{"late_fee": {"type": "flat", "amount": 25, "grace_days": 0}}' where id in (:'gb', :'ca', :'us');
set local role service_role;
select public.add_late_fees();
select tdbc.check((select description from public.invoice_line_items where invoice_id = :'gb_inv' and kind = 'late_fee') = 'The invoice was due 6 October 2026',
  'a UK client''s late fee says the day it was due, day first');
select tdbc.check((select description from public.invoice_line_items where invoice_id = :'ca_inv' and kind = 'late_fee') = 'The invoice was due October 6, 2026',
  'a Canadian client''s month first');
select tdbc.check((select description from public.invoice_line_items where invoice_id = :'us_inv' and kind = 'late_fee') = 'The invoice was due October 6, 2026',
  'and a US client''s as before');
rollback;

-- A job billed visit by visit: each line says the visit's day. Canada writes it as the US does.
begin;
set local role authenticated;
select tdbc.as_user(:'olive');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode)
values (:'gb', :'gb_client', 'Weekly mow', 'recurring', 'FREQ=WEEKLY;BYDAY=TU', '2026-06-01', 'per_visit') returning id as gb_mow \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price) values (:'gb', :'gb_mow', 'Mow', 1, 40);
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at) values (:'gb', :'gb_mow', 'Mow', 'job', 'completed', '2026-10-06', '2026-10-06 15:00Z');
select public.create_invoice_for_job(:'gb_mow', 'visits') as gb_mow_inv \gset
select tdbc.as_user(:'cora');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode)
values (:'ca', :'ca_client', 'Weekly mow', 'recurring', 'FREQ=WEEKLY;BYDAY=TU', '2026-06-01', 'per_visit') returning id as ca_mow \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price) values (:'ca', :'ca_mow', 'Mow', 1, 40);
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at) values (:'ca', :'ca_mow', 'Mow', 'job', 'completed', '2026-10-06', '2026-10-06 15:00Z');
select public.create_invoice_for_job(:'ca_mow', 'visits') as ca_mow_inv \gset
commit;
select tdbc.check((select array_agg(description) from public.invoice_line_items where invoice_id = :'gb_mow_inv') = '{"Visit on 6 Oct 2026"}',
  'a UK client''s invoice says the visit''s day, day first');
select tdbc.check((select array_agg(description) from public.invoice_line_items where invoice_id = :'ca_mow_inv') = '{"Visit on Oct 06, 2026"}',
  'a Canadian client''s as a US client''s does');

-- A payment schedule's problem, as the office's quote page shows it.
select tdbc.check(private.schedule_problem(:rows, 1000, (select currency from public.companies where id = :'gb')) = 'The payments come to £100.00 less than the total.'
  and private.schedule_problem(:rows, 1000, (select currency from public.companies where id = :'ca')) = 'The payments come to $100.00 less than the total.',
  'a payment schedule''s problem is in the business''s currency');

-- When an automatic post goes out: "6 Nov at 17:30" in the UK, "tomorrow at 5 p.m." in Canada,
-- "today at 5:30 pm" in Australia.
select tdbc.check(private.auto_post_when(((now() at time zone 'Europe/London')::date + 3 + time '17:30') at time zone 'Europe/London', 'Europe/London', 'GB')
    = to_char((now() at time zone 'Europe/London')::date + 3, 'FMDD Mon') || ' at 17:30', 'a UK business''s post goes out on the day, then at 17:30');
select tdbc.check(private.auto_post_when(((now() at time zone 'America/Toronto')::date + 1 + time '17:00') at time zone 'America/Toronto', 'America/Toronto', 'CA') = 'tomorrow at 5 p.m.'
  and private.auto_post_when(((now() at time zone 'America/Toronto')::date + 1 + time '09:05') at time zone 'America/Toronto', 'America/Toronto', 'CA') = 'tomorrow at 9:05 a.m.',
  'a Canadian one''s at 5 p.m.');
select tdbc.check(private.auto_post_when(((now() at time zone 'Australia/Sydney')::date + time '17:30') at time zone 'Australia/Sydney', 'Australia/Sydney', 'AU') = 'today at 5:30 pm'
  and private.auto_post_when(((now() at time zone 'Europe/London')::date + 1 + time '09:00') at time zone 'Europe/London', 'Europe/London', 'GB') = 'tomorrow at 09:00',
  'an Australian one''s at 5:30 pm, and a 24-hour clock keeps its minutes');

\echo 'All tests of dates and amounts in the business''s country passed.'
