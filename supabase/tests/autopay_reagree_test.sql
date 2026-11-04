-- Database tests for agreeing again to autopay's terms (20261105000100_autopay_reagree): a client
-- who agreed to the starter words from before they mentioned a monthly plan agrees to today's with
-- the same card and version, which replaces their agreement (its run unbroken, when it was resumed
-- kept); the month that waited for their words goes ahead and is charged; a client already on
-- today's words keeps their agreement as it is, and a month over the limit still waits.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tara;
grant usage on schema tara to authenticated, service_role;
create function tara.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tara.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tara to authenticated, service_role;

-- A client with a card, agreed to p_terms a day ago, and their pool plan on autopay (a fixed price,
-- monthly on the 15th). Returns the client.
create function tara.client(p_company uuid, p_name text, p_terms text, p_price numeric) returns uuid language plpgsql as $$
declare
  v_client uuid;
  v_key text := 'pm_ara_' || replace(lower(p_name), ' ', '_');
  v_pm uuid;
  v_job uuid;
begin
  insert into public.clients (company_id, display_name) values (p_company, p_name) returning id into v_client;
  v_pm := public.autopay_save_payment_method(p_company, v_client, jsonb_build_object(
    'stripe_payment_method_id', v_key, 'stripe_customer_id', 'cus' || v_key, 'stripe_account', 'acct_alder', 'livemode', false,
    'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2030, 'status', 'active', 'source', 'hub', 'make_default', true));
  insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source, link_kind, link_via, accepted_at)
  values (p_company, v_client, v_pm, p_terms, private.autopay_terms_version(p_company), 'hub', 'client', 'client', now() - interval '1 day');
  insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, invoice_day, autopay)
  values (p_company, v_client, 'Pool plan', 'recurring', 'FREQ=WEEKLY;BYDAY=TH', 'fixed', 'monthly', 15, true) returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (p_company, v_job, 'Weekly pool service', 1, 'month', p_price);
  return v_client;
end $$;
create function tara.charge_of(p_client uuid) returns uuid language sql as $$
  select id from public.autopay_charges where client_id = p_client order by created_at desc, id desc limit 1
$$;
create function tara.state(p_charge uuid) returns text language sql as $$
  select status || coalesce(': ' || last_error, '') from public.autopay_charges where id = p_charge
$$;
-- The task's claim and bill for one charge, as autopay.ts does: its answer.
create function tara.bill(p_company uuid, p_charge uuid) returns jsonb language plpgsql as $$
declare v_token uuid;
begin
  update public.autopay_charges set due_at = now() - interval '1 minute' where id = p_charge and status = 'waiting';
  select claim_token into v_token from public.claim_autopay_charges(100, p_company) where id = p_charge;
  update public.autopay_charges set status = 'waiting', claim_token = null, locked_until = null
  where company_id = p_company and status = 'charging' and id <> p_charge;
  return public.autopay_bill(p_charge, v_token);
end $$;
-- Agreeing in the Client Hub with the client's card, at the terms' version now (the server's call).
create function tara.agree(p_company uuid, p_client uuid) returns uuid language plpgsql as $$
declare
  v_pm uuid := (select payment_method_id from public.autopay_authorizations where client_id = p_client and revoked_at is null);
  v_version text := private.autopay_terms_version(p_company);
  v_id uuid;
begin
  set local role service_role;
  v_id := public.autopay_record_authorization(p_company, p_client, v_pm, 'hub', v_version, '203.0.113.9', 'Safari', 'client', 'client');
  reset role;
  return v_id;
end $$;

\set ada 'ba510000-0000-0000-0000-000000000001'
insert into auth.users (id, email, raw_user_meta_data) values (:'ada', 'ada@alder-pools.test', '{"full_name": "Ada Alder"}');

-- Ada owns Alder Pools, which turned autopay on without saving terms of its own: its clients agree
-- to the pool starter words, at version starter-pool_service-1.
begin;
set local role authenticated;
select tara.as_user(:'ada');
select public.create_company('Alder Pools', 'pool_service', 'America/Denver') as co \gset
commit;
begin;
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'stripe', 'connected', '{"autopay": true}');
select set_config('crewtavo.autopay', 'on', true);
update public.companies set settings = jsonb_set(coalesce(settings, '{}'), '{autopay}', '{"enabled": true, "max_amount": 500}') where id = :'co';
commit;
select tara.check(private.autopay_terms_version(:'co') = 'starter-pool_service-1' and private.autopay_covers_monthly(private.autopay_terms_shown(:'co')),
  'Alder''s clients agree to the starter words, which mention a monthly plan');

-- Olga agreed to the starter words from before (the same version, no monthly plan); Pia to today's;
-- Bo to the old words too, with a plan over the autopay limit.
\set old_words 'We charge the card on file after each pool service visit, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.\n\nWe charge at the end of the day of each visit.'
select tara.client(:'co', 'Olga Old', :'old_words', 90) as c_old \gset
select tara.client(:'co', 'Pia Plan', private.autopay_terms_shown(:'co'), 90) as c_pia \gset
select tara.client(:'co', 'Bo Big', :'old_words', 650) as c_big \gset
select id as a_old from public.autopay_authorizations where client_id = :'c_old' \gset
select id as a_pia from public.autopay_authorizations where client_id = :'c_pia' \gset

-- Two months on, the 15th: each plan's month is queued and billed.
select (date_trunc('month', private.company_today(:'co')::timestamp) + interval '2 months')::date as month \gset
select public.emit_invoice_reminders(((private.invoice_period(15, :'month')).period_end + time '10:00') at time zone 'America/Denver');
select tara.bill(:'co', tara.charge_of(:'c_old')), tara.bill(:'co', tara.charge_of(:'c_big'));
select tara.check(tara.state(tara.charge_of(:'c_old')) = 'needs_approval: Their autopay terms don''t mention a monthly plan'
  and tara.state(tara.charge_of(:'c_big')) = 'needs_approval: Their autopay terms don''t mention a monthly plan',
  'a client on the old words has their month wait for the office''s OK');

-- ===== Agreeing again ==============================================================================

-- The office last turned Olga's autopay back on an hour ago.
update public.autopay_authorizations set resumed_at = now() - interval '1 hour' where id = :'a_old';
select resumed_at as old_resumed from public.autopay_authorizations where id = :'a_old' \gset

select tara.agree(:'co', :'c_old') as a_new \gset
select tara.check(:'a_new'::uuid <> :'a_old'::uuid
  and (select revoked_via = 'replaced' from public.autopay_authorizations where id = :'a_old')
  and (select terms = private.autopay_terms_shown(:'co') and terms_version = 'starter-pool_service-1' and resumed_at = :'old_resumed'::timestamptz and ip = '203.0.113.9'
       from public.autopay_authorizations where id = :'a_new'),
  'the same card at the same version, with other words: a new agreement with today''s words, keeping when autopay was last resumed');
select tara.check(tara.state(tara.charge_of(:'c_old')) = 'waiting' and (select due_at <= now() from public.autopay_charges where id = tara.charge_of(:'c_old')),
  'the month that waited only for their words goes ahead now');
select tara.check((select tara.bill(:'co', tara.charge_of(:'c_old')) ->> 'outcome') = 'charge',
  'and is charged: their run of agreements wasn''t broken, so the month began after autopay did');

select tara.check(tara.agree(:'co', :'c_old') = :'a_new'::uuid and (select count(*) from public.autopay_authorizations where client_id = :'c_old') = 2,
  'agreed again to the same words: the one in force, as before');
select tara.check(tara.agree(:'co', :'c_pia') = :'a_pia'::uuid and (select count(*) from public.autopay_authorizations where client_id = :'c_pia') = 1,
  'a client already on today''s words keeps their agreement');
select tara.agree(:'co', :'c_big');
select tara.check((tara.bill(:'co', tara.charge_of(:'c_big')) ->> 'outcome') = 'needs_approval' and tara.state(tara.charge_of(:'c_big')) = 'needs_approval',
  'a month over the autopay limit, checked again, still waits for the office''s OK for that');

\echo 'All autopay agreeing again tests passed.'
