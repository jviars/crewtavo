-- Database tests for the money figures added up in the database (20261112000300_money_totals):
-- what came in each day of the company's own calendar (Home), the Invoices tiles now and 30 days
-- ago, Stripe's fees (Deposits) and the per-visit jobs with visits to invoice. Each counts every
-- row, past the 1,000 the API hands the browser; a payment late in the evening is the company's
-- day's, not UTC's; and nobody gets more than they could read from the tables: someone without
-- the invoices area, the crew, a sub and another business get zeros or nothing.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmt;
grant usage on schema tmt to authenticated, service_role;
create function tmt.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tmt.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function tmt.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- The Invoices tiles as one line: owed/count, past due/count, collected/payments, then 30 days ago.
create function tmt.tiles(p_company uuid, p_today date) returns text language sql as $$
  select format('%s/%s %s/%s %s/%s | %s %s %s', owed, owed_count, past_due, past_due_count, collected, payments, owed_before, past_due_before, collected_before)
  from public.invoice_summary(p_company, p_today)
$$;
-- Each day's total as "MM-DD amount (payments)".
create function tmt.days(p_company uuid, p_from date, p_to date) returns text[] language sql as $$
  select coalesce(array_agg(to_char(day, 'MM-DD') || ' ' || collected || ' (' || payments || ')' order by day), '{}') from public.collected_by_day(p_company, p_from, p_to)
$$;
-- The jobs with visits to invoice, by title.
create function tmt.to_invoice(p_company uuid) returns text[] language sql as $$
  select coalesce(array_agg(title order by title), '{}') from public.jobs_with_visits_to_invoice(p_company)
$$;
grant execute on all functions in schema tmt to authenticated, service_role;

\set tess 'c3070000-0000-0000-0000-000000000001'
\set otto 'c3070000-0000-0000-0000-000000000002'
\set cy 'c3070000-0000-0000-0000-000000000003'
\set dee 'c3070000-0000-0000-0000-000000000004'
\set sal 'c3070000-0000-0000-0000-000000000005'
\set pat 'c3070000-0000-0000-0000-000000000006'
\set sub 'c3070000-0000-0000-0000-0000000000c1'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'tess', 'tess@tidewater.test', '{"full_name": "Tess Tide"}'),
  (:'otto', 'otto@tidewater.test', '{"full_name": "Otto Ops"}'),
  (:'cy', 'cy@tidewater.test', '{"full_name": "Cy Crew"}'),
  (:'dee', 'dee@tidewater.test', '{"full_name": "Dee Crew"}'),
  (:'sal', 'sal@salt-subs.test', '{"full_name": "Sal Salt"}'),
  (:'pat', 'pat@kauri.test', '{"full_name": "Pat Kauri"}');

-- Tess owns Tidewater Lawn in Los Angeles. Otto is an operations manager (no invoices area), Cy and
-- Dee are crew, and Salt Subs (Sal) is a sub with a sign-in. Kauri Gardens is another business, in
-- Auckland, a day ahead of UTC's evening.
begin;
set local role authenticated;
select tmt.as_user(:'tess');
select public.create_company('Tidewater Lawn', 'lawn_exterior', 'America/Los_Angeles') as co \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
commit;
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'otto', 'office', :'ops_role');
insert into public.memberships (company_id, user_id, role) values (:'co', :'cy', 'field_crew'), (:'co', :'dee', 'field_crew');
insert into public.subcontractors (id, company_id, name) values (:'sub', :'co', 'Salt Subs');
-- The sub's sign-in, as the server makes it (it has no signed-in person).
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', :'sub');

begin;
set local role authenticated;
select tmt.as_user(:'tess');
insert into public.clients (company_id, display_name) values (:'co', 'Ana Reef') returning id as ana \gset

-- Invoices, as of "today", Nov 12, 2026 (30 days ago was Oct 13):
--   A  $500, due Oct 1, $200 paid on Oct 20: $300 past due now; $500 past due then.
--   B  $300, issued Oct 20: owed now; not issued yet then.
--   C  $400, due Nov 1: past due now; owed but not late then.
--   D  $250, due Oct 5, paid off on Oct 25: nothing now; $250 past due then.
--   G  $150, paid off on Sep 20: nothing now or then.
--   and a draft for $999, which never counts.
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'ana', '2026-09-01', '2026-10-01') returning id as a \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'ana', '2026-10-20', '2099-01-01') returning id as b \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'ana', '2026-09-15', '2026-11-01') returning id as c \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'ana', '2026-09-10', '2026-10-05') returning id as d \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'ana', '2026-08-01', '2026-08-31') returning id as g \gset
insert into public.invoices (company_id, client_id, issued_on) values (:'co', :'ana', '2026-09-01') returning id as draft \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price) values
  (:'co', :'a', 'Fall cleanup', 1, 500), (:'co', :'b', 'Aeration', 1, 300), (:'co', :'c', 'Mulch', 1, 400),
  (:'co', :'d', 'Hedges', 1, 250), (:'co', :'g', 'Mowing', 1, 150), (:'co', :'draft', 'Not sent', 1, 999);
update public.invoices set status = 'sent' where id in (:'a', :'b', :'c', :'d', :'g');

-- Payments, each at a time on the company's own clock:
insert into public.payments (company_id, client_id, invoice_id, amount, method, received_at, processor, fee_amount) values
  (:'co', :'ana', :'a', 200, 'check', '2026-10-20 12:00 America/Los_Angeles', null, 0),
  (:'co', :'ana', :'d', 250, 'check', '2026-10-25 12:00 America/Los_Angeles', null, 0),
  (:'co', :'ana', :'g', 150, 'card', '2026-09-20 12:00 America/Los_Angeles', 'stripe', 4.65),
  -- 11:30pm on Sep 13 and on Oct 13: the next day already in UTC, but the 30 days before start
  -- after Sep 13 and the past 30 days after Oct 13, so the first is in neither and the second is in the earlier 30.
  (:'co', :'ana', null, 1000, 'cash', '2026-09-13 23:30 America/Los_Angeles', null, 0),
  (:'co', :'ana', null, 40, 'cash', '2026-10-13 23:30 America/Los_Angeles', null, 0),
  -- Half past midnight on Oct 14: the first of the past 30 days.
  (:'co', :'ana', null, 60, 'cash', '2026-10-14 00:30 America/Los_Angeles', null, 0),
  -- A refund.
  (:'co', :'ana', null, -20, 'cash', '2026-11-01 12:00 America/Los_Angeles', null, 0),
  -- 11:30pm today: tomorrow in UTC, today here.
  (:'co', :'ana', null, 70, 'cash', '2026-11-12 23:30 America/Los_Angeles', null, 0);
-- A busy day: 1,500 card payments of $1 on Oct 28, more than the API hands over in one request.
insert into public.payments (company_id, client_id, amount, method, received_at, processor, fee_amount)
select :'co', :'ana', 1, 'card', timestamptz '2026-10-28 08:00 America/Los_Angeles' + g * interval '20 seconds', 'stripe', 0.59 from generate_series(1, 1500) g;

-- Jobs: two invoiced after each visit with a finished visit to bill (Cy and Sal are on Mow A's),
-- one whose finished visit is on an invoice already, one with nothing finished, one that's closed,
-- and a monthly plan, whose finished visits never go on a visit invoice.
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode) values (:'co', :'ana', 'Mow A', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', '2026-06-01', 'per_visit') returning id as mow_a \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode) values (:'co', :'ana', 'Mow B', 'recurring', 'FREQ=WEEKLY;BYDAY=TU', '2026-06-01', 'per_visit') returning id as mow_b \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode) values (:'co', :'ana', 'Mow billed', 'recurring', 'FREQ=WEEKLY;BYDAY=WE', '2026-06-01', 'per_visit') returning id as mow_billed \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode) values (:'co', :'ana', 'Mow not yet', 'recurring', 'FREQ=WEEKLY;BYDAY=TH', '2026-06-01', 'per_visit') returning id as mow_none \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode) values (:'co', :'ana', 'Mow closed', 'recurring', 'FREQ=WEEKLY;BYDAY=FR', '2026-06-01', 'per_visit') returning id as mow_closed \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day)
  values (:'co', :'ana', 'Office plan', 'recurring', 'FREQ=WEEKLY;BYDAY=FR', 'fixed', 'monthly', 15) returning id as plan \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price)
select :'co', j, 'Mow', 1, 40 from unnest(array[:'mow_a', :'mow_b', :'mow_billed', :'mow_none', :'mow_closed', :'plan']::uuid[]) j;
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at) values
  (:'co', :'mow_a', 'Mow', 'job', 'completed', '2026-11-09', '2026-11-09 15:00Z') returning id as mow_a_visit \gset
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at) values
  (:'co', :'mow_b', 'Mow', 'job', 'completed', '2026-11-10', '2026-11-10 15:00Z'),
  (:'co', :'mow_billed', 'Mow', 'job', 'completed', '2026-11-11', '2026-11-11 15:00Z'),
  (:'co', :'mow_closed', 'Mow', 'job', 'completed', '2026-11-06', '2026-11-06 15:00Z');
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on) values (:'co', :'mow_none', 'Mow', 'job', 'scheduled', '2026-11-12');
-- Three years of the plan's weekly visits, all finished and none on an invoice: 1,100 of them.
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at)
select :'co', :'plan', 'Clean', 'job', 'completed', date '2026-11-06' - g, timestamptz '2026-11-06 15:00Z' - g * interval '1 day' from generate_series(1, 1100) g;
select public.create_invoice_for_job(:'mow_billed', 'visits');
update public.jobs set status = 'archived' where id = :'mow_closed';
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'mow_a_visit', :'cy'), (:'co', :'mow_a_visit', :'sal');

select tmt.as_user(:'pat');
select public.create_company('Kauri Gardens', 'lawn_exterior', 'Pacific/Auckland') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Kiri Fern') returning id as kiri \gset
-- Half past noon UTC on Oct 31 is half past one in the morning of Nov 1 in Auckland.
insert into public.payments (company_id, client_id, amount, method, received_at, processor, fee_amount) values (:'other', :'kiri', 90, 'card', '2026-10-31 12:30Z', 'stripe', 2.91);
commit;

select tmt.check((select array_agg(status order by issued_on) from public.invoices where id in (:'g', :'a', :'d', :'c', :'b')) = '{paid,overdue,paid,overdue,sent}',
  'the invoices stand as meant: A and C past due, B sent, D and G paid');

-- ===== The owner ================================================================================
begin;
set local role authenticated;
select tmt.as_user(:'tess');

-- What came in each day.
select tmt.check(tmt.days(:'co', '2026-09-01', '2026-11-12') = '{"09-13 1000.00 (1)","09-20 150.00 (1)","10-13 40.00 (1)","10-14 60.00 (1)","10-20 200.00 (1)","10-25 250.00 (1)","10-28 1500.00 (1500)","11-01 -20.00 (1)","11-12 70.00 (1)"}',
  'each day''s total, all 1,500 of a busy day''s payments in it, and a refund taken away');
select tmt.check(tmt.days(:'co', '2026-10-13', '2026-10-13') = '{"10-13 40.00 (1)"}' and tmt.days(:'co', '2026-10-14', '2026-10-14') = '{"10-14 60.00 (1)"}',
  'a payment at 11:30pm is that day''s in the company''s zone, though UTC is already on the next, and one after midnight is the next day''s');
select tmt.check(tmt.days(:'co', '2026-11-12', '2026-11-12') = '{"11-12 70.00 (1)"}' and tmt.days(:'co', '2026-11-13', '2026-11-13') = '{}',
  'so this evening''s payment counts today, not tomorrow');
select tmt.check(tmt.days(:'co', '2026-10-15', '2026-10-19') = '{}', 'days with nothing aren''t listed');
select tmt.expect_error(format('select * from public.collected_by_day(%L, %L, %L)', :'co', '2024-01-01', '2026-11-12'),
  'more days than the API hands over in one request are refused, rather than cut short');
select tmt.check((select count(*) from public.collected_by_day(:'co', '2024-02-17', '2026-11-12')) = 9, 'up to 999 days are fine');

-- The Invoices tiles.
select tmt.check(tmt.tiles(:'co', '2026-11-12') = '1000.00/3 700.00/2 2060.00/1504 | 1150.00 750.00 190.00',
  'owed $1,000 on 3 invoices and $700 past due on 2; $2,060 in over the past 30 days in 1,504 payments (the refund off, not counted); 30 days ago $1,150 was owed, $750 of it late, and $190 had come in');
select tmt.check(tmt.tiles(:'co', '2026-11-13') = '1000.00/3 700.00/2 2000.00/1503 | 1150.00 750.00 250.00',
  'a day on, the first of the 30 days (half past midnight on Oct 14) has moved to the 30 before');

-- Stripe's fees.
select tmt.check(public.stripe_fees(:'co', '2026-10-14 00:00Z') = 885.00, 'Stripe''s fees on all 1,500 payments since a time');
select tmt.check(public.stripe_fees(:'co', '2026-09-01 00:00Z') = 889.65 and public.stripe_fees(:'co', '2026-10-29 00:00Z') = 0, 'with an earlier payment''s from an earlier time, and nothing after the last');

-- Jobs with visits to invoice.
select tmt.check(tmt.to_invoice(:'co') = '{"Mow A","Mow B"}',
  'the per-visit jobs with a finished visit to bill: not one billed already, one with nothing finished, a closed one, or the monthly plan with its 1,100 finished visits');
select tmt.check(not exists (select 1 from public.jobs_with_visits_to_invoice(:'other')) and tmt.days(:'other', '2026-10-01', '2026-11-12') = '{}'
  and tmt.tiles(:'other', '2026-11-12') = '0/0 0/0 0/0 | 0 0 0' and public.stripe_fees(:'other', '2026-01-01 00:00Z') = 0,
  'and nothing of another business''s');
commit;

-- ===== Everyone else ============================================================================
begin;
set local role authenticated;
-- Without the invoices area: the money is hidden, the jobs aren't (he can read them from the tables).
select tmt.as_user(:'otto');
select tmt.check(not exists (select 1 from public.payments) and not exists (select 1 from public.invoices), 'an operations manager reads no payments or invoices');
select tmt.check(tmt.days(:'co', '2026-09-01', '2026-11-12') = '{}' and tmt.tiles(:'co', '2026-11-12') = '0/0 0/0 0/0 | 0 0 0' and public.stripe_fees(:'co', '2026-01-01 00:00Z') = 0,
  'so every money figure is zero for him');
select tmt.check(tmt.to_invoice(:'co') = '{"Mow A","Mow B"}' and (select count(*) from public.jobs where id in (:'mow_a', :'mow_b')) = 2, 'he gets the jobs, which he can read anyway');

-- The crew: no money; of the jobs, only the one whose visit they're on, as from the tables.
select tmt.as_user(:'cy');
select tmt.check(tmt.days(:'co', '2026-09-01', '2026-11-12') = '{}' and tmt.tiles(:'co', '2026-11-12') = '0/0 0/0 0/0 | 0 0 0' and public.stripe_fees(:'co', '2026-01-01 00:00Z') = 0,
  'a crew member gets no money figure');
select tmt.check((select array_agg(title order by title) from public.jobs) = '{"Mow A"}' and tmt.to_invoice(:'co') = '{"Mow A"}', 'and only the job of the visit they''re on, which is all they can read');
select tmt.as_user(:'dee');
select tmt.check(tmt.to_invoice(:'co') = '{}' and tmt.days(:'co', '2026-09-01', '2026-11-12') = '{}' and tmt.tiles(:'co', '2026-11-12') = '0/0 0/0 0/0 | 0 0 0',
  'one on no visit gets nothing at all');

-- A sub: the same.
select tmt.as_user(:'sal');
select tmt.check(tmt.days(:'co', '2026-09-01', '2026-11-12') = '{}' and tmt.tiles(:'co', '2026-11-12') = '0/0 0/0 0/0 | 0 0 0' and public.stripe_fees(:'co', '2026-01-01 00:00Z') = 0,
  'a sub gets no money figure');
select tmt.check(tmt.to_invoice(:'co') = array(select title::text from public.jobs order by title) and (select count(*) from public.jobs) = 1,
  'and of the jobs, no more than their own visit''s, which they can read');

-- Another business, east of UTC.
select tmt.as_user(:'pat');
select tmt.check(tmt.days(:'co', '2026-09-01', '2026-11-12') = '{}' and tmt.tiles(:'co', '2026-11-12') = '0/0 0/0 0/0 | 0 0 0' and public.stripe_fees(:'co', '2026-01-01 00:00Z') = 0
  and tmt.to_invoice(:'co') = '{}', 'another business gets nothing of Tidewater''s');
select tmt.check(tmt.days(:'other', '2026-10-01', '2026-11-12') = '{"11-01 90.00 (1)"}' and tmt.tiles(:'other', '2026-11-30') like '0/0 0/0 90.00/1 |%'
  and tmt.tiles(:'other', '2026-12-01') like '0/0 0/0 0/0 | 0 0 90.00',
  'in Auckland a payment at half past noon UTC on Oct 31 is Nov 1''s: still in the 30 days on Nov 30, and in the 30 before on Dec 1');
commit;

-- Nobody signed out can call them, and each runs as the person calling.
select tmt.check(not exists (
  select 1 from unnest(array['public.collected_by_day(uuid, date, date)', 'public.invoice_summary(uuid, date)', 'public.stripe_fees(uuid, timestamptz)',
                             'public.jobs_with_visits_to_invoice(uuid)']::regprocedure[]) f
  where has_function_privilege('anon', f, 'execute') or has_function_privilege('public', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
     or (select prosecdef from pg_proc where oid = f)),
  'the four functions are for signed-in people only, and run with the caller''s own access');

\echo 'All money totals tests passed.'
