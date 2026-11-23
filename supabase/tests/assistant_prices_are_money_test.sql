-- Database tests for 20261123100600_assistant_prices_are_money.sql: what clients pay is money to an
-- AI assistant. A job's lines, a visit's extra work, price changes across jobs and how a job is billed
-- go with the Prices area (the price list's), which "Full access, no money" leaves out; weather rules
-- go with the schedule; a client's tax exemption and payment terms, and the company's payment terms,
-- sales tax, minimum charge, late fees and tips, go with invoices. And an assistant gives no one more
-- than crew lead access. Ordinary sign-ins are unaffected.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1700;
grant usage on schema t1700 to anon, authenticated, service_role;
create function t1700.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement stops with, as "SQLSTATE: message", or 'none'.
create function t1700.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
-- Claims as PostgREST sets them, with the request's method and path.
create function t1700.as_request(p_user uuid, p_client text, p_method text default 'GET', p_path text default '/clients') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true),
         set_config('request.method', p_method, true),
         set_config('request.path', p_path, true);
$$;
-- What the pre-request hook says to a request: 'none' when it goes through.
create function t1700.hook(p_user uuid, p_client text, p_method text, p_path text) returns text language plpgsql as $$
begin
  perform t1700.as_request(p_user, p_client, p_method, p_path);
  return t1700.error_of('select hooks.before_request()');
end $$;
grant execute on all functions in schema t1700 to anon, authenticated, service_role;

\set owner 'b1700000-0000-0000-0000-000000000001'
\set ola 'b1700000-0000-0000-0000-000000000002'
\set cal 'b1700000-0000-0000-0000-000000000003'
\set newbie 'b1700000-0000-0000-0000-000000000004'
\set cory 'b1700000-0000-0000-0000-000000000005'

-- Rae owns Rae Lawns. Ola was office and Cal was crew; both have had their access taken away. Cory
-- is crew, with the Helper role. Newbie has an account and isn't on the team.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'owner', 'rae@rae-lawns.test', '{"full_name": "Rae Lawns"}'),
  (:'ola', 'ola@rae-lawns.test', '{"full_name": "Ola Office"}'),
  (:'cal', 'cal@rae-lawns.test', '{"full_name": "Cal Crew"}'),
  (:'newbie', 'newbie@elsewhere.test', '{"full_name": "New Person"}'),
  (:'cory', 'cory@rae-lawns.test', '{"full_name": "Cory Crew"}');

begin;
set local role authenticated;
select t1700.as_request(:'owner', null, 'POST', '/rpc/create_company');
select public.create_company('Rae Lawns', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Client') returning id as client \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode) values (:'co', :'client', 'Weekly mowing', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'per_visit') returning id as job \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Helper', 'field_crew', '{}') returning id as helper \gset
commit;
insert into public.memberships (company_id, user_id, role, active) values (:'co', :'ola', 'office', false), (:'co', :'cal', 'field_crew', false);
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'cory', 'field_crew', :'helper');

-- Rae's assistants.
\set full 'c1700000-0000-0000-0000-00000000000a'
\set nomoney 'c1700000-0000-0000-0000-00000000000b'
\set jobbing 'c1700000-0000-0000-0000-00000000000c'
\set pricing 'c1700000-0000-0000-0000-00000000000d'
\set details 'c1700000-0000-0000-0000-00000000000e'
\set billing 'c1700000-0000-0000-0000-00000000000f'
\set scheduling 'c1700000-0000-0000-0000-000000000010'
begin;
set local role authenticated;
select t1700.as_request(:'owner', null);
insert into public.assistant_connections (client_id, level, areas) values
  (:'full', 'full', '{}'), (:'nomoney', 'full_no_money', '{}'), (:'jobbing', 'areas', '{jobs,clients}'), (:'pricing', 'areas', '{jobs,prices}'),
  (:'details', 'areas', '{company}'), (:'billing', 'areas', '{company,clients,invoices}'), (:'scheduling', 'areas', '{schedule}');
commit;

\o
\echo 'What clients pay is money to an assistant'
\o /dev/null

-- ===== The Data API ============================================================================
begin;
set local role authenticated;
select t1700.check(e = 'PT403: This assistant can''t change money: prices, quotes, invoices, payments, pay or promo codes. To let it, give it Full access in Crewtavo, under Settings → AI assistants.',
  'full access without money doesn''t change the price list: ' || e) from (select t1700.hook(:'owner', :'nomoney', 'POST', '/services') as e) x;
select t1700.check(t1700.hook(:'owner', :'nomoney', 'POST', '/job_line_items') like 'PT403: This assistant can''t change money: prices%', 'or a job''s lines');
select t1700.check(t1700.hook(:'owner', :'nomoney', 'POST', '/visit_extras') like 'PT403: This assistant can''t change money: prices%', 'or extra work on a visit');
select t1700.check(t1700.hook(:'owner', :'nomoney', 'POST', '/jobs') = 'none', 'but still makes jobs');
select t1700.check(e = 'PT403: This assistant can''t change prices. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.',
  'an assistant given jobs doesn''t change their lines: ' || e) from (select t1700.hook(:'owner', :'jobbing', 'POST', '/job_line_items') as e) x;
select t1700.check(t1700.hook(:'owner', :'jobbing', 'PATCH', '/visit_extras') like 'PT403: This assistant can''t change prices.%', 'or extra work');
select t1700.check(t1700.hook(:'owner', :'pricing', 'POST', '/job_line_items') = 'none', 'one given prices does');
select t1700.check(t1700.hook(:'owner', :'pricing', 'POST', '/visit_extras') = 'none', 'and extra work');
select t1700.check(t1700.hook(:'owner', :'pricing', 'PATCH', '/services') = 'none', 'and the price list');
rollback;

-- Price changes across jobs write with prices; weather rules with the schedule. (The hook runs
-- directly: a read-only setting made inside error_of's block wouldn't outlast it.)
begin;
set local role authenticated;
select t1700.as_request(:'owner', :'jobbing', 'POST', '/rpc/apply_price_change');
select hooks.before_request();
select t1700.check(current_setting('transaction_read_only') = 'on', 'an assistant given jobs can''t change prices across them');
rollback;
begin;
set local role authenticated;
select t1700.as_request(:'owner', :'pricing', 'POST', '/rpc/undo_price_change');
select hooks.before_request();
select t1700.check(current_setting('transaction_read_only') = 'off', 'one given prices can');
rollback;
begin;
set local role authenticated;
select t1700.as_request(:'owner', :'nomoney', 'POST', '/rpc/set_weather_rules');
select hooks.before_request();
select t1700.check(current_setting('transaction_read_only') = 'off', 'weather rules change no price: full access without money sets them');
rollback;
begin;
set local role authenticated;
select t1700.as_request(:'owner', :'scheduling', 'POST', '/rpc/set_weather_rules');
select hooks.before_request();
select t1700.check(current_setting('transaction_read_only') = 'off', 'and so does one given the schedule');
rollback;
begin;
set local role authenticated;
select t1700.as_request(:'owner', :'pricing', 'POST', '/rpc/set_weather_rules');
select hooks.before_request();
select t1700.check(current_setting('transaction_read_only') = 'on', 'but not one given only jobs and prices');
rollback;

-- ===== How a job is billed =====================================================================
begin;
set local role authenticated;
select t1700.as_request(:'owner', :'nomoney', 'PATCH', '/jobs');
select t1700.check(t1700.error_of(format('update public.jobs set invoice_day = 15 where id = %L', :'job')) like '42501: This assistant can''t change how a job is priced or billed.%',
  'full access without money doesn''t change how a job is billed');
select t1700.check(t1700.error_of(format('update public.jobs set title = %L where id = %L', 'Mowing', :'job')) = 'none', 'but changes the rest of it');
select t1700.as_request(:'owner', :'pricing', 'PATCH', '/jobs');
select t1700.check(t1700.error_of(format('update public.jobs set invoice_day = 15 where id = %L', :'job')) = 'none', 'one given prices does');
rollback;
begin;
set local role authenticated;
select t1700.as_request(:'owner', null, 'PATCH', '/jobs');
select t1700.check(t1700.error_of(format('update public.jobs set invoice_day = 20 where id = %L', :'job')) = 'none', 'and so does an ordinary sign-in');
rollback;

-- ===== A client's tax exemption and payment terms ==============================================
begin;
set local role authenticated;
select t1700.as_request(:'owner', :'nomoney', 'PATCH', '/clients');
select t1700.check(t1700.error_of(format('update public.clients set tax_exempt = true where id = %L', :'client')) like '42501: This assistant can''t change a client''s tax exemption or payment terms%',
  'full access without money doesn''t make a client tax exempt');
select t1700.check(t1700.error_of(format('update public.clients set payment_terms_days = 90 where id = %L', :'client')) like '42501: This assistant can''t change a client''s%', 'or change their payment terms');
select t1700.check(t1700.error_of(format('insert into public.clients (company_id, display_name, payment_terms_days) values (%L, %L, 60)', :'co', 'New client')) like '42501:%', 'or add a client with them');
select t1700.check(t1700.error_of(format('update public.clients set phone = %L where id = %L', '540-555-0101', :'client')) = 'none', 'but changes the rest of a client');
select t1700.check(t1700.error_of(format('insert into public.clients (company_id, display_name) values (%L, %L)', :'co', 'Another client')) = 'none', 'and adds them');
select t1700.as_request(:'owner', :'billing', 'PATCH', '/clients');
select t1700.check(t1700.error_of(format('update public.clients set tax_exempt = true, payment_terms_days = 0 where id = %L', :'client')) = 'none', 'one given invoices does');
rollback;

-- ===== The company's money settings ============================================================
begin;
set local role authenticated;
select t1700.as_request(:'owner', :'details', 'POST', '/rpc/merge_company_settings');
select t1700.check(t1700.error_of(format($q$select public.merge_company_settings(%L, '{"default_tax_rate": 0.07}')$q$, :'co'))
    like '42501: This assistant can''t change payment terms, sales tax, the minimum charge, late fees or tips%',
  'an assistant given company details doesn''t change the sales tax');
select t1700.check(t1700.error_of(format($q$select public.merge_company_settings(%L, '{"minimum_charge": 75}')$q$, :'co')) like '42501:%', 'or the minimum charge');
select t1700.check(t1700.error_of(format($q$select public.merge_company_settings(%L, '{"hub_tips": true}')$q$, :'co')) like '42501:%', 'or tips');
select t1700.check(t1700.error_of(format($q$select public.merge_company_settings(%L, '{"quote_valid_days": 45}')$q$, :'co')) = 'none', 'but changes the rest of Settings → Company');
select t1700.as_request(:'owner', :'billing', 'POST', '/rpc/merge_company_settings');
select t1700.check(t1700.error_of(format($q$select public.merge_company_settings(%L, '{"default_tax_rate": 0.07, "payment_terms_days": 15}')$q$, :'co')) = 'none', 'one given invoices too does');
rollback;

\o
\echo 'An assistant gives no one more than crew lead access'
\o /dev/null

begin;
set local role authenticated;
select t1700.as_request(:'owner', :'full', 'POST', '/memberships');
select t1700.check(t1700.error_of(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'co', :'newbie', 'office'))
    like '42501: An AI assistant only gives crew lead or field crew access.%',
  'even with full access, an assistant doesn''t add someone as office');
select t1700.check(t1700.error_of(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'co', :'newbie', 'estimator')) like '42501: An AI assistant only%', 'or as an estimator');
select t1700.check(t1700.error_of(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', :'ola')) like '42501: An AI assistant only%',
  'or gives a removed office member their access back');
select t1700.check(t1700.error_of(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'office', :'co', :'cory')) like '42501: An AI assistant only%',
  'or moves crew up to office');
select t1700.check(t1700.error_of(format('update public.company_roles set base_role = %L where id = %L', 'office', :'helper')) like '42501: An AI assistant only%',
  'or makes the crew''s role an office one');
select t1700.check(t1700.error_of(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', :'cal')) = 'none', 'but gives crew their access back');
select t1700.check(t1700.error_of(format('update public.memberships set role = %L where company_id = %L and user_id = %L', 'crew_lead', :'co', :'cal')) = 'none', 'makes them a crew lead');
select t1700.check(t1700.error_of(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'co', :'newbie', 'field_crew')) = 'none', 'and adds field crew');
select t1700.check(t1700.error_of(format('update public.memberships set active = false where company_id = %L and user_id = %L', :'co', :'newbie')) = 'none', 'and takes access away');
rollback;

-- People do it themselves on Settings → People.
begin;
set local role authenticated;
select t1700.as_request(:'owner', null, 'POST', '/memberships');
select t1700.check(t1700.error_of(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'co', :'newbie', 'office')) = 'none', 'the owner adds someone as office');
select t1700.check(t1700.error_of(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', :'ola')) = 'none', 'and gives office access back');
rollback;

\echo 'All assistant prices-are-money tests passed.'
