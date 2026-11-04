-- Database tests for pausing a recurring job (20261105000500_job_pause): when it was paused and
-- resumed are the server's, only a recurring job pauses, and it reads Paused (after Requires
-- invoicing) until it resumes; on the invoice day a fixed price paused all month has no reminder
-- and no monthly plan charge, one paused partway or back by the day is billed in full, a per-visit
-- job bills the visits it had, and a missed day isn't caught up once it resumed since; and another
-- company can't see or pause it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tjp;
grant usage on schema tjp to authenticated, service_role;
create function tjp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tjp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- How many rows a statement changed.
create function tjp.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
-- A recurring job monthly on the 15th: a fixed price, or per visit.
create function tjp.plan(p_company uuid, p_client uuid, p_title text, p_pricing text default 'fixed') returns uuid language plpgsql as $$
declare v_job uuid;
begin
  insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day)
  values (p_company, p_client, p_title, 'recurring', 'FREQ=WEEKLY;BYDAY=TU', p_pricing, 'monthly', 15) returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (p_company, v_job, p_title, 1, 'month', 120);
  return v_job;
end $$;
-- Reminders made for the company, as titles.
create function tjp.reminded(p_company uuid) returns text[] language sql as $$
  select coalesce(array_agg(j.title order by j.title), '{}')
  from public.invoice_reminders r join public.jobs j on j.id = r.job_id where r.company_id = p_company
$$;
grant execute on all functions in schema tjp to authenticated, service_role;

\set june 'bb5f0000-0000-0000-0000-000000000001'
\set ed 'bb5f0000-0000-0000-0000-000000000009'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'june', 'june@juniper-clean.test', '{"full_name": "June Juniper"}'),
  (:'ed', 'ed@elder-lawn.test', '{"full_name": "Ed Elder"}');

-- June owns Juniper Cleaning; Ed owns another business.
begin;
set local role authenticated;
select tjp.as_user(:'ed');
select public.create_company('Elder Lawn', 'lawn_exterior', 'America/Chicago') as other \gset
select tjp.as_user(:'june');
select public.create_company('Juniper Cleaning', 'cleaning', 'America/Chicago') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Lee') returning id as pat \gset
commit;

-- ===== Pausing and resuming =======================================================================

begin;
set local role authenticated;
select tjp.as_user(:'june');
select tjp.plan(:'co', :'pat', 'Weekly plan') as jw \gset
insert into public.jobs (company_id, client_id, title, kind) values (:'co', :'pat', 'One-off', 'one_off') returning id as jo \gset
update public.jobs set paused_at = now() - interval '1 year', resume_on = current_date + 30 where id in (:'jw', :'jo');
select tjp.check((select paused_at = now() and resume_on = current_date + 30 and resumed_at is null from public.jobs where id = :'jw'), 'paused: from the server''s time, whatever was sent, with its resume date');
select tjp.check((select paused_at is null and resume_on is null from public.jobs where id = :'jo'), 'a one-off job doesn''t pause');
select tjp.check((select public.job_state(j) from public.jobs j where id = :'jw') = 'paused', 'a paused job reads paused');
update public.jobs set paused_at = now() - interval '1 year', resume_on = null where id = :'jw';
select tjp.check((select paused_at = now() and resume_on is null from public.jobs where id = :'jw'), 'paused again: still since then, now until resumed');
update public.jobs set paused_at = null, resume_on = current_date + 5 where id = :'jw';
select tjp.check((select paused_at is null and resume_on is null and resumed_at = now() from public.jobs where id = :'jw'), 'resumed: no resume date left, and when it resumed kept');
select tjp.check((select public.job_state(j) from public.jobs j where id = :'jw') = 'unscheduled', 'and it reads from its visits again');
rollback;

-- ===== The invoice day ============================================================================

-- Two months on, monthly on the 15th: the month runs from the 16th before to the 15th.
select (date_trunc('month', private.company_today(:'co')::timestamp) + interval '2 months')::date as month \gset
select period_start as p_start, period_end as p_end from private.invoice_period(15, :'month') \gset
select ((:'p_end'::date + time '10:00') at time zone 'America/Chicago') as at10, ((:'p_end'::date + 2 + time '10:00') at time zone 'America/Chicago') as later10 \gset

begin;
set local role authenticated;
select tjp.as_user(:'june');
select tjp.plan(:'co', :'pat', 'All month plan') as j_all \gset
select tjp.plan(:'co', :'pat', 'Back in time plan') as j_back \gset
select tjp.plan(:'co', :'pat', 'Partway plan') as j_part \gset
select tjp.plan(:'co', :'pat', 'Running plan') as j_run \gset
select tjp.plan(:'co', :'pat', 'Resumed plan') as j_res \gset
select tjp.plan(:'co', :'pat', 'Per visit paused', 'per_visit') as j_pv \gset
select tjp.plan(:'co', :'pat', 'Per visit, nothing done', 'per_visit') as j_pn \gset
insert into public.visits (company_id, job_id, title, scheduled_on, status) values (:'co', :'j_pv', 'Clean', :'p_start'::date + 1, 'completed');
-- Paused now, before the month begins: all month, back on the invoice day, or until resumed.
update public.jobs set paused_at = now() where id in (:'j_all', :'j_res', :'j_pv', :'j_pn');
update public.jobs set paused_at = now(), resume_on = :'p_end' where id = :'j_back';
commit;
-- The Partway plan was paused three days into the month.
begin;
alter table public.jobs disable trigger job_pause;
update public.jobs set paused_at = (:'p_start'::date + 3 + time '09:00') at time zone 'America/Chicago' where id = :'j_part';
alter table public.jobs enable trigger job_pause;
commit;

select public.emit_invoice_reminders(:'at10');
select tjp.check(tjp.reminded(:'co') = '{"Back in time plan","Partway plan","Per visit paused","Running plan"}',
  'the invoice day: not a fixed price paused all month, or a per-visit job with nothing done; one partway or back by the day in full, and the visits a paused one had');
select tjp.check((select count(*) from public.notifications where user_id = :'june' and kind = 'invoice') = 1
  and (select title from public.notifications where user_id = :'june' and kind = 'invoice') = format('4 monthly jobs need their %s invoice', to_char(:'month'::date, 'FMMonth')),
  'the office hears once, about those');
begin;
set local role authenticated;
select tjp.as_user(:'june');
select tjp.check((select public.job_state(j) from public.jobs j where id = :'j_pv') = 'requires_invoicing' and (select public.job_state(j) from public.jobs j where id = :'j_all') = 'paused',
  'a paused job with its month to invoice reads Requires invoicing, the others Paused');
commit;

-- Resumed the day after its invoice day: the missed day isn't caught up, as it was paused then.
begin;
alter table public.jobs disable trigger job_pause;
update public.jobs set paused_at = null, resumed_at = (:'p_end'::date + 1 + time '06:15') at time zone 'America/Chicago' where id = :'j_res';
alter table public.jobs enable trigger job_pause;
commit;
select public.emit_invoice_reminders(:'later10');
select tjp.check(not ('Resumed plan' = any (tjp.reminded(:'co'))) and cardinality(tjp.reminded(:'co')) = 4, 'a day gone by isn''t caught up for a job resumed since');

-- ===== A monthly plan's charge ====================================================================

\set uma 'bb5f0000-0000-0000-0000-000000000002'
insert into auth.users (id, email, raw_user_meta_data) values (:'uma', 'uma@ulmus-pools.test', '{"full_name": "Uma Ulmus"}');
select private.autopay_starter_terms('pool_service') as pool_terms \gset
begin;
set local role authenticated;
select tjp.as_user(:'uma');
select public.create_company('Ulmus Pools', 'pool_service', 'America/Chicago') as uco \gset
reset role;
insert into public.integrations (company_id, provider, status, settings) values (:'uco', 'stripe', 'connected', '{"autopay": true}');
set local role authenticated;
select public.autopay_set_settings(:'uco', jsonb_build_object('enabled', true, 'terms', :'pool_terms'::text, 'timing', 'end_of_day',
  'max_amount', 500, 'receipts', true, 'jobs_default', false, 'card_required', false));
insert into public.clients (company_id, display_name) values (:'uco', 'Cy Card') returning id as cy \gset
commit;
select public.autopay_save_payment_method(:'uco', :'cy', jsonb_build_object(
  'stripe_payment_method_id', 'pm_tjp_cy', 'stripe_customer_id', 'cus_tjp_cy', 'stripe_account', 'acct_ulmus', 'livemode', false,
  'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2030, 'status', 'active', 'source', 'hub', 'make_default', true)) as cy_pm \gset
insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source, link_kind, link_via, accepted_at)
values (:'uco', :'cy', :'cy_pm', private.autopay_terms_shown(:'uco'), private.autopay_terms_version(:'uco'), 'hub', 'client', 'client', now() - interval '1 day');
begin;
set local role authenticated;
select tjp.as_user(:'uma');
select tjp.plan(:'uco', :'cy', 'Paused pool plan') as jpp \gset
select tjp.plan(:'uco', :'cy', 'Pool plan') as jpr \gset
update public.jobs set autopay = true where id in (:'jpp', :'jpr');
update public.jobs set paused_at = now() where id = :'jpp';
commit;

select public.emit_invoice_reminders(:'at10');
select tjp.check((select array_agg(j.title order by j.title) from public.autopay_charges a join public.jobs j on j.id = a.job_id where a.company_id = :'uco' and a.bill = 'month') = '{"Pool plan"}'
  and tjp.reminded(:'uco') = '{"Pool plan"}',
  'a monthly plan paused all month isn''t charged; the running one is');

-- ===== Another company ============================================================================

begin;
set local role authenticated;
select tjp.as_user(:'ed');
select tjp.check(tjp.changed(format('update public.jobs set paused_at = null where id = %L', :'j_all')) = 0
  and not exists (select 1 from public.jobs where id = :'j_all'),
  'another company can''t see the job or resume it');
reset role;
select tjp.check((select paused_at is not null from public.jobs where id = :'j_all'), 'it''s still paused');
commit;

\echo 'All job pause tests passed.'
