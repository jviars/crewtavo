-- Database tests for a missed invoice day (20261105000110_invoice_day_catch_up): when a monthly
-- job becomes monthly, and stops being; a run up to 7 days after an invoice day nobody ran makes
-- its reminder (any hour) or queues a monthly plan's charge, once however often it runs; not for a
-- month already invoiced, a job that became monthly after the day, or a day more than a week ago;
-- and the invoice day itself as before.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tidc;
grant usage on schema tidc to authenticated, service_role;
create function tidc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tidc.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- A plan at a fixed price, monthly on p_day.
create function tidc.plan(p_company uuid, p_client uuid, p_title text, p_day integer) returns uuid language plpgsql as $$
declare v_job uuid;
begin
  insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day)
  values (p_company, p_client, p_title, 'recurring', 'FREQ=WEEKLY;BYDAY=TU', 'fixed', 'monthly', p_day) returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (p_company, v_job, p_title, 1, 'month', 120);
  return v_job;
end $$;
-- Reminders made for the company, as "title month".
create function tidc.reminded(p_company uuid) returns text[] language sql as $$
  select coalesce(array_agg(j.title || ' ' || to_char(r.month, 'YYYY-MM') order by j.title), '{}')
  from public.invoice_reminders r join public.jobs j on j.id = r.job_id where r.company_id = p_company
$$;
grant execute on all functions in schema tidc to authenticated, service_role;

\set iva 'ba520000-0000-0000-0000-000000000001'
insert into auth.users (id, email, raw_user_meta_data) values (:'iva', 'iva@ivy-clean.test', '{"full_name": "Iva Ivy"}');

begin;
set local role authenticated;
select tidc.as_user(:'iva');
select public.create_company('Ivy Cleaning', 'cleaning', 'America/Chicago') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Lee') returning id as pat \gset
commit;

-- ===== When a job became monthly ==================================================================

begin;
set local role authenticated;
select tidc.as_user(:'iva');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode) values (:'co', :'pat', 'Weekly', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'per_visit') returning id as jw \gset
select tidc.check((select monthly_since is null from public.jobs where id = :'jw'), 'a job invoiced after each visit isn''t monthly');
update public.jobs set pricing = 'fixed', invoice_schedule = 'monthly' where id = :'jw';
select tidc.check((select monthly_since = now() from public.jobs where id = :'jw'), 'switched to monthly: monthly from now');
update public.jobs set monthly_since = now() - interval '1 year', title = 'Weekly plan' where id = :'jw';
select tidc.check((select monthly_since = now() from public.jobs where id = :'jw'), 'it''s the server''s to say, and stays while the job is monthly');
update public.jobs set invoice_schedule = 'as_needed' where id = :'jw';
select tidc.check((select monthly_since is null from public.jobs where id = :'jw'), 'not monthly any more: none');
rollback;

-- ===== Catching up ================================================================================

-- Two months on, on the 15th, a day the server was down. Four days later it's back.
select (date_trunc('month', private.company_today(:'co')::timestamp) + interval '2 months')::date as month \gset
select period_end as p_end from private.invoice_period(15, :'month') \gset
select ((:'p_end'::date + 4 + time '07:00') at time zone 'America/Chicago') as back_early, ((:'p_end'::date + 4 + time '10:00') at time zone 'America/Chicago') as back10,
  ((:'p_end'::date + 8 + time '10:00') at time zone 'America/Chicago') as week_late \gset

begin;
set local role authenticated;
select tidc.as_user(:'iva');
select tidc.plan(:'co', :'pat', 'Office plan', 15) as jf \gset
select tidc.plan(:'co', :'pat', 'Home plan', 15) as jh \gset
select tidc.plan(:'co', :'pat', 'Invoiced plan', 15) as ji \gset
select tidc.plan(:'co', :'pat', 'Switched plan', 15) as js \gset
commit;
-- The Invoiced plan's month was invoiced early (by the server: the office invoices the months due).
select public.create_invoice_for_job(:'ji', 'standard', null, :'month');
-- The Switched plan became monthly the day after its invoice day.
begin;
alter table public.jobs disable trigger monthly_since;
update public.jobs set monthly_since = (:'p_end'::date + 1 + time '09:00') at time zone 'America/Chicago' where id = :'js';
alter table public.jobs enable trigger monthly_since;
commit;

select public.emit_invoice_reminders(:'week_late');
select tidc.check(tidc.reminded(:'co') = '{}', 'more than a week after the invoice day, it isn''t caught up');

-- And one whose invoice day is the day the server comes back.
begin;
set local role authenticated;
select tidc.as_user(:'iva');
select tidc.plan(:'co', :'pat', 'Today plan', 19) as jt \gset
commit;

select public.emit_invoice_reminders(:'back_early');
select tidc.check(tidc.reminded(:'co') = array['Home plan ' || to_char(:'month'::date, 'YYYY-MM'), 'Office plan ' || to_char(:'month'::date, 'YYYY-MM')],
  'back within the week, before 8 in the morning: the missed month''s reminders, not the invoiced one''s, the switched one''s or today''s yet');
select tidc.check((select count(*) from public.notifications where user_id = :'iva' and kind = 'invoice') = 1
  and (select title from public.notifications where user_id = :'iva' and kind = 'invoice') = format('2 monthly jobs need their %s invoice', to_char(:'month'::date, 'FMMonth')),
  'the office hears once');

select public.emit_invoice_reminders(:'back10'), public.emit_invoice_reminders(:'back10'), public.emit_invoice_reminders(:'back10'::timestamptz + interval '1 day');
select tidc.check(tidc.reminded(:'co') = array['Home plan ' || to_char(:'month'::date, 'YYYY-MM'), 'Office plan ' || to_char(:'month'::date, 'YYYY-MM'), 'Today plan ' || to_char(:'month'::date, 'YYYY-MM')],
  'run again and again: only today''s invoice day is added, at 8 as before');
select tidc.check((select count(*) from public.notifications where user_id = :'iva' and kind = 'invoice') = 2, 'and the office hears about it alone');

-- ===== A monthly plan's charge ====================================================================

\set ula 'ba520000-0000-0000-0000-000000000002'
insert into auth.users (id, email, raw_user_meta_data) values (:'ula', 'ula@umber-pools.test', '{"full_name": "Ula Umber"}');
select private.autopay_starter_terms('pool_service') as pool_terms \gset
begin;
set local role authenticated;
select tidc.as_user(:'ula');
select public.create_company('Umber Pools', 'pool_service', 'America/Chicago') as uco \gset
reset role;
insert into public.integrations (company_id, provider, status, settings) values (:'uco', 'stripe', 'connected', '{"autopay": true}');
set local role authenticated;
select public.autopay_set_settings(:'uco', jsonb_build_object('enabled', true, 'terms', :'pool_terms'::text, 'timing', 'end_of_day',
  'max_amount', 500, 'receipts', true, 'jobs_default', false, 'card_required', false));
insert into public.clients (company_id, display_name) values (:'uco', 'Cy Card') returning id as cy \gset
commit;
select public.autopay_save_payment_method(:'uco', :'cy', jsonb_build_object(
  'stripe_payment_method_id', 'pm_idc_cy', 'stripe_customer_id', 'cus_idc_cy', 'stripe_account', 'acct_umber', 'livemode', false,
  'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2030, 'status', 'active', 'source', 'hub', 'make_default', true)) as cy_pm \gset
insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source, link_kind, link_via, accepted_at)
values (:'uco', :'cy', :'cy_pm', private.autopay_terms_shown(:'uco'), private.autopay_terms_version(:'uco'), 'hub', 'client', 'client', now() - interval '1 day');
begin;
set local role authenticated;
select tidc.as_user(:'ula');
select tidc.plan(:'uco', :'cy', 'Pool plan', 15) as jp \gset
update public.jobs set autopay = true where id = :'jp';
commit;

select public.emit_invoice_reminders(:'back10'), public.emit_invoice_reminders(:'back10');
select tidc.check((select count(*) from public.autopay_charges where job_id = :'jp' and bill = 'month' and billing_month = :'month' and status = 'waiting') = 1
  and tidc.reminded(:'uco') = array['Pool plan ' || to_char(:'month'::date, 'YYYY-MM')]
  and not exists (select 1 from public.notifications where user_id = :'ula' and kind = 'invoice'),
  'a monthly plan on autopay has its missed month''s charge queued, once, and the office isn''t asked to invoice it');

\echo 'All missed invoice day tests passed.'
