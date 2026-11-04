-- Database tests for recurring billing (20261104000800_recurring_billing): the two questions and
-- billing_mode kept in step (old values map across, a repeating quote is per visit after each
-- visit); a month's days; on the invoice day, one reminder for each monthly job with something to
-- bill and one note to the office, never twice; the month showing as Requires invoicing; its
-- invoice (a per-visit job's visits from that month, a fixed price's lines once), never two for a
-- month; as needed never reminding; and another company seeing none of it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema trb;
grant usage on schema trb to authenticated, service_role;
create function trb.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function trb.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function trb.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema trb to authenticated, service_role;

-- A job's two answers and billing_mode, as "pricing/schedule/billing_mode".
create function trb.billing(p_job uuid) returns text language sql as $$
  select coalesce(pricing, '-') || '/' || coalesce(invoice_schedule, '-') || '/' || billing_mode from public.jobs where id = p_job
$$;
-- The company's invoice notifications for someone, as titles.
create function trb.told(p_user uuid) returns text[] language sql as $$
  select coalesce(array_agg(title order by title), '{}') from public.notifications where user_id = p_user and kind = 'invoice'
$$;

\set rhea 'ab880000-0000-0000-0000-000000000001'
\set omar 'ab880000-0000-0000-0000-000000000002'
\set otis 'ab880000-0000-0000-0000-000000000003'
\set ed 'ab880000-0000-0000-0000-000000000009'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'rhea', 'rhea@rill-clean.test', '{"full_name": "Rhea Rill"}'),
  (:'omar', 'omar@rill-clean.test', '{"full_name": "Omar Office"}'),
  (:'otis', 'otis@rill-clean.test', '{"full_name": "Otis Ops"}'),
  (:'ed', 'ed@elm-pools.test', '{"full_name": "Ed Elm"}');

-- Rhea owns Rill Cleaning; Omar is in its office, Otis too as an operations manager (no invoices
-- area). Ed owns Elm Pools.
begin;
set local role authenticated;
select trb.as_user(:'rhea');
select public.create_company('Rill Cleaning', 'cleaning', 'America/Chicago') as co \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'omar', 'office', null), (:'co', :'otis', 'office', :'ops_role');
set local role authenticated;
insert into public.clients (company_id, display_name) values (:'co', 'Pat Lee') returning id as pat \gset
select trb.as_user(:'ed');
select public.create_company('Elm Pools', 'pool_service', 'America/Chicago') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Xena Ward') returning id as xena \gset
commit;

-- ===== The two questions, and billing_mode in step ================================================
\set weekly 'FREQ=WEEKLY;BYDAY=MO'

begin;
set local role authenticated;
select trb.as_user(:'rhea');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode) values (:'co', :'pat', 'Per visit', 'recurring', :'weekly', 'per_visit') returning id as m1 \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode) values (:'co', :'pat', 'Fixed', 'recurring', :'weekly', 'fixed_schedule') returning id as m2 \gset
insert into public.jobs (company_id, client_id, title, kind, billing_mode) values (:'co', :'pat', 'Done', 'one_off', 'on_completion') returning id as m3 \gset
insert into public.jobs (company_id, client_id, title, kind, billing_mode) values (:'co', :'pat', 'Progress', 'one_off', 'progress') returning id as m4 \gset
select trb.check(trb.billing(:'m1') = 'per_visit/after_visit/per_visit' and trb.billing(:'m2') = 'fixed/monthly/fixed_schedule'
  and trb.billing(:'m3') = '-/-/on_completion' and trb.billing(:'m4') = '-/-/progress',
  'billing_mode alone maps across: per visit after each visit, a fixed price monthly, and when the job is done or progress unchanged');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing) values (:'co', :'pat', 'Fixed only', 'recurring', :'weekly', 'fixed') returning id as m5 \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day) values (:'co', :'pat', 'Monthly visits', 'recurring', :'weekly', 'per_visit', 'monthly', 15) returning id as m6 \gset
select trb.check(trb.billing(:'m5') = 'fixed/monthly/fixed_schedule' and trb.billing(:'m6') = 'per_visit/monthly/fixed_schedule',
  'the answers set billing_mode: per_visit only for per visit after each visit');
update public.jobs set invoice_schedule = 'as_needed' where id = :'m1';
select trb.check(trb.billing(:'m1') = 'per_visit/as_needed/fixed_schedule', 'as needed isn''t billed visit by visit');
update public.jobs set invoice_schedule = 'after_visit' where id = :'m1';
select trb.check(trb.billing(:'m1') = 'per_visit/after_visit/per_visit', 'and back to after each visit is per_visit again');
update public.jobs set pricing = 'fixed' where id = :'m1';
select trb.check(trb.billing(:'m1') = 'fixed/monthly/fixed_schedule', 'a fixed price on a job invoiced after each visit becomes monthly');
update public.jobs set billing_mode = 'per_visit' where id = :'m1';
select trb.check(trb.billing(:'m1') = 'per_visit/after_visit/per_visit', 'billing_mode written alone (an older screen) answers the questions');
update public.jobs set billing_mode = 'progress' where id = :'m6';
select trb.check(trb.billing(:'m6') = '-/-/progress', 'progress billing clears them');
update public.jobs set pricing = null, invoice_schedule = null where id = :'m2';
select trb.check(trb.billing(:'m2') = '-/-/on_completion', 'both taken off is when the job is done');
select trb.expect_error(format('insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule) values (%L, %L, %L, %L, %L, %L, %L)',
  :'co', :'pat', 'Nope', 'recurring', :'weekly', 'fixed', 'after_visit'), 'a fixed price isn''t invoiced after each visit');
select trb.expect_error(format('update public.jobs set invoice_day = 31 where id = %L', :'m6'), 'the invoice day is 1 to 28 (or the last day)');

-- A quote that repeats becomes per visit, after each visit, as before; a one-time one when it's done.
insert into public.quotes (company_id, client_id, title, recurrence_rule) values (:'co', :'pat', 'Weekly clean', 'FREQ=WEEKLY;BYDAY=TU') returning id as q1 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'q1', 'Clean', 1, 'visit', 80);
select public.convert_quote_to_job(:'q1') as qj1 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'pat', 'Move-out clean') returning id as q2 \gset
select public.convert_quote_to_job(:'q2') as qj2 \gset
select trb.check(trb.billing(:'qj1') = 'per_visit/after_visit/per_visit' and trb.billing(:'qj2') = '-/-/on_completion',
  'a repeating quote becomes per visit, after each visit; a one-time one is invoiced when the job is done');
rollback;

select trb.check(not exists (
  select 1 from public.jobs
  where (billing_mode = 'per_visit') is distinct from coalesce(pricing = 'per_visit' and invoice_schedule = 'after_visit', false)
     or (billing_mode in ('on_completion', 'progress')) is distinct from (pricing is null)),
  'every job''s answers and billing_mode agree');

-- ===== A month's days =============================================================================

select trb.check((select row(period_start, period_end)::text from private.invoice_period(null, '2026-11-20')) = '(2026-11-01,2026-11-30)'
  and (select row(period_start, period_end)::text from private.invoice_period(15, '2026-11-20')) = '(2026-10-16,2026-11-15)'
  and (select row(period_start, period_end)::text from private.invoice_period(28, '2028-03-01')) = '(2028-02-29,2028-03-28)'
  and (select row(period_start, period_end)::text from private.invoice_period(1, '2026-01-31')) = '(2025-12-02,2026-01-01)'
  and (select row(period_start, period_end)::text from private.invoice_period(null, '2028-02-03')) = '(2028-02-01,2028-02-29)',
  'a month runs from the day after last month''s invoice day to this month''s, the last day of the month by default (core invoicePeriod)');

-- ===== Monthly reminders ==========================================================================

-- Two months on, on the 15th: a period wholly ahead of today, so nothing else in the database is due.
select (date_trunc('month', private.company_today(:'co')::timestamp) + interval '2 months')::date as month \gset
select period_start as p_start, period_end as p_end from private.invoice_period(15, :'month') \gset
select ((:'p_end'::date + time '07:00') at time zone 'America/Chicago') as early, ((:'p_end'::date + time '10:00') at time zone 'America/Chicago') as at10,
  ((:'p_end'::date + time '11:00') at time zone 'America/Chicago') as at11, ((:'p_end'::date + 1 + time '10:00') at time zone 'America/Chicago') as next_day \gset
select (date_trunc('month', :'month'::timestamp) + interval '1 month')::date - 1 as last_day \gset
select extract(month from (:'month'::date + interval '3 months'))::integer as off_month \gset

begin;
set local role authenticated;
select trb.as_user(:'rhea');
-- Weekly cleaning, per visit, monthly on the 15th: two visits done in the month, one done the month
-- before, one not done yet.
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, pricing, invoice_schedule, invoice_day)
  values (:'co', :'pat', 'Weekly cleaning', 'recurring', 'FREQ=WEEKLY;BYDAY=TU', :'p_start'::date - 30, 'per_visit', 'monthly', 15) returning id as jp \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'jp', 'Clean', 1, 'visit', 40);
insert into public.visits (company_id, job_id, title, scheduled_on, status) values
  (:'co', :'jp', 'Clean', :'p_start', 'completed'), (:'co', :'jp', 'Clean', :'p_end', 'completed'),
  (:'co', :'jp', 'Clean', :'p_start'::date - 1, 'completed'), (:'co', :'jp', 'Clean', :'p_end'::date - 3, 'scheduled');
-- A fixed-price plan, monthly on the 15th.
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, pricing, invoice_schedule, invoice_day)
  values (:'co', :'pat', 'Office plan', 'recurring', 'FREQ=WEEKLY;BYDAY=FR', :'p_start', 'fixed', 'monthly', 15) returning id as jf \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'jf', 'Monthly cleaning', 1, 'month', 120), (:'co', :'jf', 'Windows', 1, 'month', 30);
-- As needed, with a visit done: never reminded.
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule) values (:'co', :'pat', 'Deep clean', 'recurring', 'FREQ=MONTHLY;BYMONTHDAY=1', 'per_visit', 'as_needed') returning id as ja \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'ja', 'Deep clean', 1, 'visit', 200);
insert into public.visits (company_id, job_id, title, scheduled_on, status) values (:'co', :'ja', 'Deep clean', :'p_start', 'completed');
-- Monthly per visit with nothing done; a plan out of season; one not started yet; one on the last day.
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day) values (:'co', :'pat', 'Nothing done', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'per_visit', 'monthly', 15) returning id as je \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'je', 'Clean', 1, 'visit', 40);
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, active_months, pricing, invoice_schedule, invoice_day)
  values (:'co', :'pat', 'Summer plan', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', array[:'off_month'::integer], 'fixed', 'monthly', 15) returning id as js \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, pricing, invoice_schedule, invoice_day)
  values (:'co', :'pat', 'Starts later', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', :'p_end'::date + 1, 'fixed', 'monthly', 15) returning id as jn \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule) values (:'co', :'pat', 'Month end plan', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'fixed', 'monthly') returning id as jl \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values
  (:'co', :'js', 'Plan', 1, 'month', 99), (:'co', :'jn', 'Plan', 1, 'month', 99), (:'co', :'jl', 'Plan', 1, 'month', 75);
insert into public.jobs (company_id, client_id, title, kind, billing_mode) values (:'co', :'pat', 'One-off', 'one_off', 'on_completion') returning id as jo \gset
select trb.as_user(:'ed');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day) values (:'other', :'xena', 'Pool plan', 'recurring', 'FREQ=WEEKLY;BYDAY=WE', 'fixed', 'monthly', 15) returning id as jx \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'other', :'jx', 'Pool plan', 1, 'month', 160);
commit;

-- Other tests' companies may have jobs due too, so only these two companies' are counted.
select public.emit_invoice_reminders(:'early');
select trb.check(not exists (select 1 from public.invoice_reminders where company_id in (:'co', :'other')),
  'before 8 in the morning on the invoice day, nothing yet');
select public.emit_invoice_reminders(:'at10');
select trb.check((select count(*) from public.invoice_reminders where company_id in (:'co', :'other')) = 3, 'at 10 on the 15th: the per-visit job with visits, the fixed price, and Elm''s plan');
select trb.check((select array_agg(job_id order by job_id) from public.invoice_reminders where company_id = :'co') = (select array_agg(x order by x) from unnest(array[:'jp', :'jf']::uuid[]) x)
  and (select row(month, period_start, period_end)::text from public.invoice_reminders where job_id = :'jp') = row(:'month'::date, :'p_start'::date, :'p_end'::date)::text,
  'not as needed, nothing done, out of season, not started or the last day''s; each for the month and its days');
select trb.check(trb.told(:'rhea') = array[format('2 monthly jobs need their %s invoice', to_char(:'month'::date, 'FMMonth'))]
  and trb.told(:'omar') = trb.told(:'rhea') and trb.told(:'otis') = '{}'
  and trb.told(:'ed') = array[format('Xena Ward: Pool plan needs its %s invoice', to_char(:'month'::date, 'FMMonth'))],
  'the office with the invoices area hears once for each company (one job by name), the office without it doesn''t');
select trb.check((select link from public.notifications where user_id = :'ed' and kind = 'invoice') = '/jobs/' || :'jx'
  and (select link from public.notifications where user_id = :'rhea' and kind = 'invoice') = '/invoices', 'pointing at the job, or at Invoices for more than one');
select public.emit_invoice_reminders(:'at10'), public.emit_invoice_reminders(:'at11'), public.emit_invoice_reminders(:'next_day');
select trb.check(true
  and (select count(*) from public.invoice_reminders where company_id in (:'co', :'other')) = 3
  and cardinality(trb.told(:'rhea')) = 1 and cardinality(trb.told(:'ed')) = 1,
  'run again that hour, later that day or the next: no second reminder or note');
select public.emit_invoice_reminders(((:'last_day'::date + time '10:00') at time zone 'America/Chicago'));
select trb.check((select count(*) from public.invoice_reminders where company_id in (:'co', :'other')) = 4 and exists (select 1 from public.invoice_reminders where job_id = :'jl' and month = :'month'),
  'the last day of the month is the last day job''s invoice day');

-- ===== Requires invoicing =========================================================================

begin;
set local role authenticated;
select trb.as_user(:'omar');
select trb.check((select array_agg(job_id order by job_id) from public.due_invoices) = (select array_agg(x order by x) from unnest(array[:'jp', :'jf', :'jl']::uuid[]) x),
  'the office sees the months to invoice');
select trb.check((select array_agg(public.job_state(j) order by j.id) from public.jobs j where j.id in (:'jp', :'jf')) = '{requires_invoicing,requires_invoicing}'
  and (select public.job_state(j) from public.jobs j where j.id = :'ja') <> 'requires_invoicing',
  'those jobs read Requires invoicing; as needed doesn''t');
select trb.as_user(:'otis');
select trb.check(not exists (select 1 from public.due_invoices) and not exists (select 1 from public.invoice_reminders)
  and (select public.job_state(j) from public.jobs j where j.id = :'jp') <> 'requires_invoicing',
  'without the invoices area: no reminders, and the job reads as its visits do');
select trb.as_user(:'ed');
select trb.check((select array_agg(job_id) from public.due_invoices) = array[:'jx']::uuid[] and (select count(*) from public.invoice_reminders) = 1,
  'another company sees only its own');
select trb.expect_error(format('select public.create_invoice_for_job(%L, %L, null, %L)', :'jf', 'standard', :'month'), 'and can''t invoice this company''s month');
select trb.as_user(:'rhea');
select trb.expect_error('select public.emit_invoice_reminders()', 'reminders are the server''s to make');
select trb.expect_error(format('insert into public.invoice_reminders (company_id, job_id, month, period_start, period_end) values (%L, %L, %L, %L, %L)',
  :'co', :'je', :'month', :'p_start', :'p_end'), 'nobody signed in writes them');
commit;

-- ===== The month's invoice ========================================================================

begin;
set local role authenticated;
select trb.as_user(:'omar');
select public.create_invoice_for_job(:'jp', 'visits', null, :'month') as inv_p \gset
select trb.check((select kind = 'visits' and billing_month = :'month' and subject = 'Weekly cleaning (' || to_char(:'month'::date, 'FMMonth YYYY') || ')' and subtotal = 80
  from public.invoices where id = :'inv_p') and (select count(*) from public.invoice_line_items where invoice_id = :'inv_p') = 2,
  'a per-visit job''s month bills its two visits done that month');
select trb.check((select array_agg(scheduled_on order by scheduled_on) from public.visits where job_id = :'jp' and invoice_id is null) = array[:'p_start'::date - 1, :'p_end'::date - 3],
  'not the one from the month before, nor the one not done');
select trb.expect_error(format('select public.create_invoice_for_job(%L, %L, null, %L)', :'jp', 'visits', :'month'), 'a second invoice for the month');
select public.create_invoice_for_job(:'jf', 'standard', null, :'month') as inv_f \gset
select trb.check((select kind = 'standard' and billing_month = :'month' and subtotal = 150 from public.invoices where id = :'inv_f'),
  'a fixed price''s month bills its lines once');
select trb.expect_error(format('select public.create_invoice_for_job(%L, %L, null, %L)', :'jf', 'standard', :'month'), 'never two for one month');
select trb.expect_error(format('select public.create_invoice_for_job(%L, %L, null, %L)', :'jo', 'standard', :'month'), 'a one-off job isn''t invoiced by the month');
select trb.check((select array_agg(job_id) from public.due_invoices) = array[:'jl']::uuid[]
  and (select public.job_state(j) from public.jobs j where j.id = :'jf') <> 'requires_invoicing',
  'invoiced, they''re no longer due');
update public.invoices set status = 'void' where id = :'inv_f';
select trb.check(exists (select 1 from public.due_invoices where job_id = :'jf'), 'voided, the month is due again');
select trb.check(public.create_invoice_for_job(:'jf', 'standard', null, :'month') is not null, 'and can be invoiced again');
-- The month after has no reminder yet: the office can still invoice it (20261105000140_invoice_period_grant).
select trb.check(public.create_invoice_for_job(:'jf', 'standard', null, (:'month'::date + interval '1 month')::date) is not null, 'a month with no reminder yet can be invoiced too');
commit;
select public.emit_invoice_reminders(:'at10');
select trb.check((select count(*) from public.invoice_reminders where company_id in (:'co', :'other')) = 4, 'and the reminders aren''t made again');

\echo 'All recurring billing tests passed.'
