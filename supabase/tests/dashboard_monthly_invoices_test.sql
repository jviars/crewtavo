-- Database tests for Home's "to invoice" (20261105000130_dashboard_monthly_invoices): a monthly
-- job whose month waits for its invoice counts with the finished jobs, once, with its fixed price
-- for each month due (nothing yet for one billed by its visits); invoiced, it's gone; someone
-- without the invoices area counts only the finished jobs.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tdmi;
grant usage on schema tdmi to authenticated, service_role;
create function tdmi.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tdmi.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- Home's jobs to invoice, as "count/value".
create function tdmi.to_invoice(p_company uuid) returns text language sql as $$
  select (j ->> 'to_invoice') || '/' || (j ->> 'to_invoice_value')::numeric::integer from (select public.dashboard(p_company) -> 'workflow' -> 'jobs' as j) x
$$;
grant execute on all functions in schema tdmi to authenticated, service_role;

\set vera 'ba540000-0000-0000-0000-000000000001'
\set otto 'ba540000-0000-0000-0000-000000000002'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'vera', 'vera@vale-clean.test', '{"full_name": "Vera Vale"}'),
  (:'otto', 'otto@vale-clean.test', '{"full_name": "Otto Ops"}');

-- Vera owns Vale Cleaning; Otto is an operations manager there (no invoices area).
begin;
set local role authenticated;
select tdmi.as_user(:'vera');
select public.create_company('Vale Cleaning', 'cleaning', 'America/Chicago') as co \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'otto', 'office', :'ops_role');
set local role authenticated;
insert into public.clients (company_id, display_name) values (:'co', 'Pat Lee') returning id as pat \gset
-- A one-off job finished, for $200.
insert into public.jobs (company_id, client_id, title, kind, billing_mode, status) values (:'co', :'pat', 'Move-out clean', 'one_off', 'on_completion', 'requires_invoicing') returning id as jd \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'jd', 'Move-out clean', 1, 'ea', 200);
-- A $150 monthly plan with two months due, and a monthly per-visit job with one.
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day)
  values (:'co', :'pat', 'Office plan', 'recurring', 'FREQ=WEEKLY;BYDAY=FR', 'fixed', 'monthly', 15) returning id as jf \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'jf', 'Monthly cleaning', 1, 'month', 150);
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day)
  values (:'co', :'pat', 'Weekly cleaning', 'recurring', 'FREQ=WEEKLY;BYDAY=TU', 'per_visit', 'monthly', 15) returning id as jp \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'jp', 'Clean', 1, 'visit', 40);
commit;

select date_trunc('month', private.company_today(:'co')::timestamp)::date as m1 \gset
select (:'m1'::date - interval '1 month')::date as m0 \gset
insert into public.visits (company_id, job_id, title, scheduled_on, status) values (:'co', :'jp', 'Clean', (private.invoice_period(15, :'m1')).period_end, 'completed');
-- The months' reminders, as their invoice days made them.
insert into public.invoice_reminders (company_id, job_id, month, period_start, period_end)
select :'co', j, m, (private.invoice_period(15, m)).period_start, (private.invoice_period(15, m)).period_end
from (values (:'jf'::uuid, :'m0'::date), (:'jf'::uuid, :'m1'::date), (:'jp'::uuid, :'m1'::date)) x (j, m);

begin;
set local role authenticated;
select tdmi.as_user(:'vera');
select tdmi.check(tdmi.to_invoice(:'co') = '3/500', 'the finished job, and each monthly job once: $200, the plan''s $150 for each of its two months, nothing yet for visits');
select public.create_invoice_for_job(:'jf', 'standard', null, :'m0');
select public.create_invoice_for_job(:'jf', 'standard', null, :'m1');
select tdmi.check(tdmi.to_invoice(:'co') = '2/200', 'its months invoiced, the plan isn''t counted');
select tdmi.as_user(:'otto');
select tdmi.check((public.dashboard(:'co') -> 'workflow' -> 'jobs' ->> 'to_invoice')::integer = 1, 'without the invoices area, only the finished job');
commit;

\echo 'All Home to-invoice tests passed.'
