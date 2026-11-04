-- Database tests for monthly plans charged automatically (20261104000900_monthly_plan_autopay): a
-- recurring job at a fixed price, invoiced monthly, can be on autopay; on its invoice day the
-- month's charge is queued once (not the office's note) and billed through autopay's own path,
-- with the cap and the office's OK for a month that began before autopay did or a client whose
-- terms don't mention a monthly plan; never two invoices for the month; per-visit autopay as it
-- was; the starter terms; and another company seeing none of it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmpa;
grant usage on schema tmpa to authenticated, service_role;
create function tmpa.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tmpa.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
create function tmpa.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tmpa to authenticated, service_role;

-- The server's and the test's shortcuts, past row-level security.

-- A client with a card, agreed to p_terms at p_accepted (the server records agreements as made).
create function tmpa.client(p_company uuid, p_name text, p_terms text, p_accepted timestamptz) returns uuid language plpgsql as $$
declare
  v_client uuid;
  v_key text := 'pm_mpa_' || replace(lower(p_name), ' ', '_');
  v_pm uuid;
begin
  insert into public.clients (company_id, display_name, email) values (p_company, p_name, replace(lower(p_name), ' ', '.') || '@brook.test') returning id into v_client;
  if p_terms is null then return v_client; end if;
  v_pm := public.autopay_save_payment_method(p_company, v_client, jsonb_build_object(
    'stripe_payment_method_id', v_key, 'stripe_customer_id', 'cus' || v_key, 'stripe_account', 'acct_brook', 'livemode', false,
    'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2030, 'status', 'active', 'source', 'hub', 'make_default', true));
  insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source, link_kind, link_via, accepted_at)
  values (p_company, v_client, v_pm, p_terms, private.autopay_terms_version(p_company), 'hub', 'client', 'client', p_accepted);
  return v_client;
end $$;
-- A pool plan for a client: a fixed price, monthly on the 15th.
create function tmpa.plan(p_company uuid, p_client uuid, p_price numeric) returns uuid language plpgsql as $$
declare v_job uuid;
begin
  insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day)
  values (p_company, p_client, 'Pool plan', 'recurring', 'FREQ=WEEKLY;BYDAY=TH', 'fixed', 'monthly', 15) returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (p_company, v_job, 'Weekly pool service', 1, 'month', p_price);
  return v_job;
end $$;
-- The job's charge.
create function tmpa.charge_of(p_job uuid) returns uuid language sql as $$
  select id from public.autopay_charges where job_id = p_job order by created_at desc, id desc limit 1
$$;
create function tmpa.state(p_charge uuid) returns text language sql as $$
  select status || coalesce(': ' || last_error, '') from public.autopay_charges where id = p_charge
$$;
-- The task's claim and bill for one charge, as autopay.ts does: its answer.
create function tmpa.bill(p_company uuid, p_charge uuid) returns jsonb language plpgsql as $$
declare v_token uuid;
begin
  update public.autopay_charges set due_at = now() - interval '1 minute' where id = p_charge and status = 'waiting';
  select claim_token into v_token from public.claim_autopay_charges(100, p_company) where id = p_charge;
  -- The rest stay as they were for the next one.
  update public.autopay_charges set status = case when failures > 0 then 'failed' else 'waiting' end, claim_token = null, locked_until = null
  where company_id = p_company and status = 'charging' and id <> p_charge;
  return public.autopay_bill(p_charge, v_token);
end $$;

\set bea 'ab890000-0000-0000-0000-000000000001'
\set oli 'ab890000-0000-0000-0000-000000000002'
\set ty 'ab890000-0000-0000-0000-000000000009'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'bea', 'bea@brook.test', '{"full_name": "Bea Brook"}'),
  (:'oli', 'oli@brook.test', '{"full_name": "Oli Office"}'),
  (:'ty', 'ty@tarn.test', '{"full_name": "Ty Tarn"}');

-- ===== The terms ==================================================================================

select tmpa.check(private.autopay_starter_terms('pool_service') = 'We charge the card on file after each pool service visit, or once a month for a monthly plan, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    and (select bool_and(private.autopay_covers_monthly(private.autopay_starter_terms(t))) from unnest(array['lawn_exterior', 'cleaning', 'pool_service', 'pest_control', 'general', 'snow']) t)
    and not private.autopay_covers_monthly(private.autopay_starter_terms('paving'))
    and not private.autopay_covers_monthly('We charge the card on file after each pool service visit, and for other invoices we send you.'),
  'the plan trades'' and the general starter terms say once a month for a monthly plan; paving''s and per-visit words don''t');

-- ===== Brook Pools =================================================================================
-- Bea owns it, Oli is in its office. Ty owns Tarn Pools. Brook's terms are the pool starter words.
select private.autopay_starter_terms('pool_service') as pool_terms \gset
begin;
set local role authenticated;
select tmpa.as_user(:'bea');
select public.create_company('Brook Pools', 'pool_service', 'America/Denver') as co \gset
reset role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'oli', 'office');
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'stripe', 'connected', '{"autopay": true}');
set local role authenticated;
select public.autopay_set_settings(:'co', jsonb_build_object('enabled', true, 'terms', :'pool_terms'::text, 'timing', 'end_of_day',
  'max_amount', 500, 'receipts', true, 'jobs_default', true, 'card_required', false));
select tmpa.as_user(:'ty');
select public.create_company('Tarn Pools', 'pool_service', 'America/Denver') as other \gset
commit;

-- Two months on, on the 15th, so the month begins after everyone below agreed.
select (date_trunc('month', private.company_today(:'co')::timestamp) + interval '2 months')::date as month \gset
select period_start as p_start, period_end as p_end from private.invoice_period(15, :'month') \gset
select ((:'p_end'::date + time '10:00') at time zone 'America/Denver') as at10 \gset

\set per_visit_words 'We charge the card on file after each pool service visit, and for other invoices we send you. You''ll get a receipt each time.'
select tmpa.client(:'co', 'Pia Plan', private.autopay_terms_shown(:'co'), now() - interval '1 day') as c_pia \gset
select tmpa.client(:'co', 'Olga Old', :'per_visit_words', now() - interval '1 day') as c_old \gset
-- Nina agreed partway through the month.
select tmpa.client(:'co', 'Nina New', private.autopay_terms_shown(:'co'), :'p_start'::date + interval '2 days') as c_new \gset
select tmpa.client(:'co', 'Cy None', null, null) as c_none \gset

begin;
set local role authenticated;
select tmpa.as_user(:'oli');
select tmpa.plan(:'co', :'c_pia', 90) as j_pia \gset
select tmpa.plan(:'co', :'c_pia', 650) as j_big \gset
select tmpa.plan(:'co', :'c_old', 90) as j_old \gset
select tmpa.plan(:'co', :'c_new', 90) as j_new \gset
select tmpa.plan(:'co', :'c_none', 90) as j_none \gset
select tmpa.plan(:'co', :'c_pia', 90) as j_off \gset
select tmpa.check((select bool_and(not autopay) from public.jobs where id in (:'j_pia', :'j_big', :'j_old', :'j_new', :'j_none', :'j_off')),
  'a monthly plan doesn''t start on autopay by itself (that default is still per-visit jobs'')');
update public.jobs set autopay = true where id in (:'j_pia', :'j_big', :'j_old', :'j_new', :'j_off');
select tmpa.check((select bool_and(autopay and autopay_since is not null) from public.jobs where id in (:'j_pia', :'j_big', :'j_old', :'j_new', :'j_off')),
  'the office puts monthly plans on autopay');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule) values (:'co', :'c_pia', 'Visits monthly', 'recurring', 'FREQ=WEEKLY;BYDAY=TH', 'per_visit', 'monthly') returning id as j_pvm \gset
select tmpa.check(tmpa.error_of(format('update public.jobs set autopay = true where id = %L', :'j_pvm')) = '22023: Autopay works with recurring jobs billed per visit or at a fixed price monthly, or one-off jobs billed when the work is done',
  'per visit invoiced monthly isn''t one autopay charges');
-- Per-visit autopay as before: the job starts on it, and a finished visit queues its charge.
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode) values (:'co', :'c_pia', 'Weekly service', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'per_visit') returning id as j_pv \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'j_pv', 'Pool service', 1, 'visit', 45);
insert into public.visits (company_id, job_id, title, scheduled_on, status) values (:'co', :'j_pv', 'Pool service', private.company_today(:'co'), 'completed');
commit;
select tmpa.check((select autopay from public.jobs where id = :'j_pv') and (select bill = 'visits' and billing_month is null and status = 'waiting' from public.autopay_charges where job_id = :'j_pv'),
  'per-visit autopay is as it was');
select tmpa.check(not exists (select 1 from public.autopay_charges where job_id in (:'j_pia', :'j_big', :'j_old', :'j_new', :'j_none', :'j_off')), 'nothing for the plans before the invoice day');

-- Becoming a plan counts as autopay starting for it.
select autopay_since as pv_since from public.jobs where id = :'j_pv' \gset
begin;
set local role authenticated;
select tmpa.as_user(:'oli');
update public.jobs set pricing = 'fixed', invoice_schedule = 'monthly' where id = :'j_pv';
commit;
select tmpa.check((select autopay and autopay_since > :'pv_since'::timestamptz from public.jobs where id = :'j_pv'), 'a per-visit job made a monthly plan keeps autopay, from now');
begin;
set local role authenticated;
select tmpa.as_user(:'oli');
update public.jobs set pricing = 'per_visit', invoice_schedule = 'after_visit' where id = :'j_pv';
commit;

-- ===== The invoice day ============================================================================

-- Other tests' companies may have jobs due too, so only Brook's are counted.
select public.emit_invoice_reminders(:'at10');
select tmpa.check((select count(*) from public.invoice_reminders where company_id = :'co' and month = :'month') = 6, 'on the 15th each plan has its month''s reminder');
select tmpa.check((select count(*) from public.autopay_charges where job_id in (:'j_pia', :'j_big', :'j_old', :'j_new', :'j_off') and bill = 'month' and billing_month = :'month' and status = 'waiting' and due_at <= now()) = 5
  and not exists (select 1 from public.autopay_charges where job_id = :'j_none'),
  'the plans on autopay have the month''s charge queued, due now; the one whose client has no card doesn''t');
select tmpa.check((select array_agg(title) from public.notifications where user_id = :'bea' and kind = 'invoice') = array[format('Cy None: Pool plan needs its %s invoice', to_char(:'month'::date, 'FMMonth'))],
  'and only that one is the office''s to invoice');
select public.emit_invoice_reminders(:'at10'), public.emit_invoice_reminders(:'at10'::timestamptz + interval '3 hours');
select tmpa.check((select count(*) from public.invoice_reminders where company_id = :'co') = 6 and (select count(*) from public.autopay_charges where job_id in (:'j_pia', :'j_big', :'j_old', :'j_new', :'j_off')) = 5
  and (select count(*) from public.notifications where user_id = :'bea' and kind = 'invoice') = 1,
  'run again: no second reminder, charge or note');

-- ===== Billing the charges =========================================================================

select tmpa.bill(:'co', tmpa.charge_of(:'j_pia')) as pia \gset
select tmpa.check(:'pia'::jsonb ->> 'outcome' = 'charge' and (:'pia'::jsonb ->> 'balance_due')::numeric = 90
  and (select billing_month = :'month' and kind = 'standard' and status = 'draft' from public.invoices where id = (:'pia'::jsonb ->> 'invoice_id')::uuid),
  'the month''s invoice is made and charged, as a visit''s is');
select tmpa.check(public.autopay_mark_sent(tmpa.charge_of(:'j_pia'), (select claim_token from public.autopay_charges where id = tmpa.charge_of(:'j_pia')), 9000)
  and public.finish_autopay_charge(tmpa.charge_of(:'j_pia'), 'paid', (select claim_token from public.autopay_charges where id = tmpa.charge_of(:'j_pia')), null, null, 90),
  'Stripe charges it and it''s marked paid');
select tmpa.check(tmpa.state(tmpa.charge_of(:'j_pia')) = 'paid'
  and exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = tmpa.charge_of(:'j_pia')::text),
  'with the receipt, as autopay''s charges have');
begin;
set local role authenticated;
select tmpa.as_user(:'oli');
select tmpa.check(tmpa.error_of(format('select public.create_invoice_for_job(%L, %L, null, %L)', :'j_pia', 'standard', :'month')) like '22023: This job already has its % invoice (#%)',
  'the office can''t invoice the month a second time');
commit;

select tmpa.bill(:'co', tmpa.charge_of(:'j_big')) as big \gset
select tmpa.check(:'big'::jsonb ->> 'outcome' = 'needs_approval' and tmpa.state(tmpa.charge_of(:'j_big')) = 'needs_approval',
  'over the autopay limit, it waits for the office''s OK');
select tmpa.bill(:'co', tmpa.charge_of(:'j_old')) as old \gset
select tmpa.check(tmpa.state(tmpa.charge_of(:'j_old')) = 'needs_approval: Their autopay terms don''t mention a monthly plan',
  'a client who agreed to per-visit words waits for the office''s OK');
select tmpa.bill(:'co', tmpa.charge_of(:'j_new')) as new \gset
select tmpa.check(tmpa.state(tmpa.charge_of(:'j_new')) = 'needs_approval: Covers days from before autopay started',
  'so does a month that began before the client agreed');
select tmpa.check((select count(*) from public.notifications where user_id = :'oli' and kind = 'autopay' and title like 'Approve a %') = 3,
  'the office is asked about each');

begin;
set local role authenticated;
select tmpa.as_user(:'oli');
select public.approve_autopay_charge(tmpa.charge_of(:'j_old'));
-- Taking a plan off monthly takes it off autopay, and its charge with it.
update public.jobs set invoice_schedule = 'as_needed' where id = :'j_off';
commit;
select tmpa.bill(:'co', tmpa.charge_of(:'j_old')) as old \gset
select tmpa.check(:'old'::jsonb ->> 'outcome' = 'charge', 'approved, it''s charged');
select tmpa.check((select not autopay from public.jobs where id = :'j_off') and tmpa.state(tmpa.charge_of(:'j_off')) = 'called_off: Autopay was turned off for this job',
  'a plan made as needed comes off autopay, and its waiting charge is called off');

-- ===== Another company =============================================================================

begin;
set local role authenticated;
select tmpa.as_user(:'ty');
select tmpa.check(not exists (select 1 from public.autopay_charges) and not exists (select 1 from public.invoice_reminders) and not exists (select 1 from public.due_invoices),
  'another company sees none of Brook''s charges or reminders');
update public.jobs set autopay = true where id = :'j_none';
commit;
select tmpa.check((select not autopay from public.jobs where id = :'j_none'), 'nor puts its jobs on autopay');

\echo 'All monthly plan autopay tests passed.'
