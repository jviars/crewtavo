-- Database tests for 20261123100100_prices_and_settings_for_the_office.sql: the company's money
-- settings are read by the roles that see prices (and the server), never by crew leads, field crew
-- or subs, and crews still read what their screens use; what a visit bills is read by the office
-- with Invoices and payments and the server, as 20261122000100_prices_and_own_pay_stay_with_their_roles.sql
-- has it, through visit_prices() too; and the functions that read them as the person asking
-- (invoices, copies of quotes, saving settings) work as before, autopay's invoices as the server too.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1122p;
grant usage on schema t1122p to authenticated, service_role;
create function t1122p.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "code: message", or 'none'.
create function t1122p.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1122p.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- An invoice the server makes, as autopay makes one (public.autopay_bill runs as the database and
-- calls create_invoice_for_job).
create function t1122p.server_invoice(p_job uuid) returns uuid language sql security definer set search_path = '' as $$
  select public.create_invoice_for_job(p_job, 'visits')
$$;
grant execute on all functions in schema t1122p to authenticated, service_role;

\set olive '11220000-0000-4000-8000-000000000001'
\set ada '11220000-0000-4000-8000-000000000002'
\set opal '11220000-0000-4000-8000-000000000003'
\set eve '11220000-0000-4000-8000-000000000004'
\set lou '11220000-0000-4000-8000-000000000005'
\set cy '11220000-0000-4000-8000-000000000006'
\set sal '11220000-0000-4000-8000-000000000007'
\set nora '11220000-0000-4000-8000-000000000008'
\set salsub '11220000-0000-4000-8000-0000000000c1'

-- Olive owns Pike Plowing: Ada is an admin, Opal office, Eve an estimator, Lou leads the Plow crew
-- with Cy on it, and Sal signs in for a sub. Nora owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@pike.test', '{"full_name": "Olive Owner"}'),
  (:'ada', 'ada@pike.test', '{"full_name": "Ada Admin"}'),
  (:'opal', 'opal@pike.test', '{"full_name": "Opal Office"}'),
  (:'eve', 'eve@pike.test', '{"full_name": "Eve Estimator"}'),
  (:'lou', 'lou@pike.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@pike.test', '{"full_name": "Cy Crew"}'),
  (:'sal', 'sal@salt.test', '{"full_name": "Sal Sub"}'),
  (:'nora', 'nora@nora.test', '{"full_name": "Nora Other"}');

begin;
set local role authenticated;
select t1122p.as_user(:'nora');
select public.create_company('Nora Yards', 'general') as other \gset
select t1122p.as_user(:'olive');
select public.create_company('Pike Plowing', 'general') as co \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Mall Lot', 'mall@lot.test') returning id as client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '1 Mall Way') returning id as prop \gset
insert into public.jobs (company_id, client_id, property_id, title, kind, recurrence_rule, billing_mode)
  values (:'co', :'client', :'prop', 'Plow the lot', 'recurring', 'FREQ=YEARLY', 'per_visit') returning id as job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'job', 'Snow plowing', 1, 'push', 60);
insert into public.quotes (company_id, is_template, title) values (:'co', true, 'Plowing season') returning id as tpl \gset
commit;
-- People, as the server adds them (admins and subs aren't added from the browser).
insert into public.memberships (company_id, user_id, role) values
  (:'co', :'ada', 'admin'), (:'co', :'opal', 'office'), (:'co', :'eve', 'estimator'), (:'co', :'lou', 'crew_lead'), (:'co', :'cy', 'field_crew');
insert into public.subcontractors (id, company_id, name) values (:'salsub', :'co', 'Sal Salt LLC');
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', :'salsub');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Plow', :'lou') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', :'cy');
insert into public.visits (company_id, job_id, property_id, title, scheduled_on, crew_id)
  values (:'co', :'job', :'prop', 'Plow the lot (storm)', private.company_today(:'co'), :'crew') returning id as storm \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on, crew_id)
  values (:'co', :'job', :'prop', 'Plow the lot', private.company_today(:'co'), :'crew') returning id as plain \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'storm', :'cy'), (:'co', :'storm', :'sal'), (:'co', :'plain', :'cy');
-- What the storm bills, as the server prices it, and the company's settings, money and the rest.
update public.visits set price = 150, price_note = 'Snow plow, 2in+ storm rate' where id = :'storm';
update public.companies set settings = settings || '{
  "minimum_charge": 75, "late_fee": {"type": "flat", "amount": 25, "grace_days": 7}, "payment_terms_days": 15, "default_tax_rate": 0.1,
  "quote_valid_days": 14, "profit_alert_percent": 20, "snow_storm_prices": [{"times": 1}, {"times": 1.5}], "revenue_goal": 500000,
  "clock": {"mode": "day", "record_location": true}, "working_hours": {"start": "07:00", "end": "17:00"}, "arrival_window_min": 60,
  "branding": {"color": "#225588"}, "depot": {"lat": 40.1, "lng": -75.1}, "schedule": {"timeStep": 15},
  "team_chat": {"enabled": true, "pinned": "x"}, "marketing": {"enabled": true, "review_message": "Thanks!"}, "snow_app": {"enabled": true}}'::jsonb
where id = :'co';

\o
\echo 'What the browser reads'
\o /dev/null

select t1122p.check(not has_column_privilege('authenticated', 'public.visits', 'price', 'select')
    and not has_column_privilege('authenticated', 'public.visits', 'price_note', 'select')
    and has_column_privilege('authenticated', 'public.visits', 'title', 'select') and has_column_privilege('authenticated', 'public.visits', 'eta_at', 'select')
    and has_column_privilege('authenticated', 'public.visits', 'price', 'update'),
  'the browser reads every column of a visit but what it bills, which the office still sets');
select t1122p.check(not has_column_privilege('authenticated', 'public.companies', 'settings', 'select')
    and has_column_privilege('authenticated', 'public.companies', 'timezone', 'select') and has_column_privilege('authenticated', 'public.companies', 'name', 'select')
    and has_column_privilege('authenticated', 'public.companies', 'settings', 'update'),
  'and every column of the company but its settings, which owners and admins still save');
select t1122p.check(not has_column_privilege('anon', 'public.visits', 'title', 'select') and not has_column_privilege('anon', 'public.companies', 'name', 'select'),
  'someone signed out reads neither');

-- ===== Field crew, crew leads and subs ==========================================================
begin;
set local role authenticated;
select t1122p.as_user(:'cy');
select t1122p.check(t1122p.error_of(format('select price from public.visits where id = %L', :'storm')) like '42501:%'
    and t1122p.error_of(format('select price_note from public.visits where id = %L', :'storm')) like '42501:%',
  'field crew can''t read what their visit bills');
select t1122p.check((select count(*) = 1 from public.visits where id = :'storm' and title like 'Plow%' and status = 'scheduled'), 'but read the visit itself as before');
select t1122p.check((select count(*) = 0 from public.visit_prices(array[:'storm']::uuid[])), 'nor through visit_prices');
select t1122p.check(t1122p.error_of(format('select settings from public.companies where id = %L', :'co')) like '42501:%', 'nor the company''s settings');
select t1122p.check((select name = 'Pike Plowing' and timezone is not null from public.companies where id = :'co'), 'the company''s name and time zone they still read');
select public.company_settings(:'co') as crew_settings \gset
select t1122p.check(not (:'crew_settings'::jsonb ?| array['minimum_charge', 'late_fee', 'payment_terms_days', 'default_tax_rate', 'quote_valid_days', 'profit_alert_percent', 'snow_storm_prices', 'revenue_goal']),
  'company_settings gives them none of the money settings');
select t1122p.check(:'crew_settings'::jsonb -> 'clock' = '{"mode": "day", "record_location": true}' and :'crew_settings'::jsonb ->> 'arrival_window_min' = '60'
    and :'crew_settings'::jsonb -> 'working_hours' ->> 'start' = '07:00' and :'crew_settings'::jsonb -> 'depot' ->> 'lat' = '40.1'
    and :'crew_settings'::jsonb #>> '{branding,color}' = '#225588' and :'crew_settings'::jsonb #>> '{schedule,timeStep}' = '15',
  'but the time clock, the workday, arrival windows, the shop, branding and the schedule''s own settings, as their screens use them');
select t1122p.check(:'crew_settings'::jsonb -> 'team_chat' = '{"enabled": true}' and :'crew_settings'::jsonb -> 'marketing' = '{"enabled": true}'
    and :'crew_settings'::jsonb -> 'snow_app' = '{"enabled": true}',
  'and only whether each app is on, not how it''s set up');
-- What they do on their visit is as before.
update public.visits set status = 'en_route' where id = :'storm';
select t1122p.check((select status = 'en_route' from public.visits where id = :'storm'), 'and they move their visit along as before');
select t1122p.check(t1122p.error_of(format('update public.visits set price = 1 where id = %L', :'storm')) like '42501:%', 'they still can''t change what it bills');
rollback;

begin;
set local role authenticated;
select t1122p.as_user(:'lou');
select t1122p.check(t1122p.error_of(format('select price from public.visits where id = %L', :'storm')) like '42501:%'
    and (select count(*) = 0 from public.visit_prices(array[:'storm', :'plain']::uuid[])),
  'a crew lead reads no visit''s price either');
select t1122p.check(not (public.company_settings(:'co') ?| array['minimum_charge', 'late_fee', 'snow_storm_prices', 'profit_alert_percent'])
    and public.company_settings(:'co') ? 'clock',
  'nor the money settings');
select t1122p.as_user(:'sal');
select t1122p.check(t1122p.error_of(format('select price from public.visits where id = %L', :'storm')) like '42501:%'
    and (select count(*) = 0 from public.visit_prices(array[:'storm']::uuid[])),
  'nor does a sub on the visit');
select t1122p.check(public.company_settings(:'co') is null, 'and a sub gets no settings from company_settings (company_basics is theirs)');
select t1122p.check((select settings = '{"clock": {"mode": "day", "record_location": true}, "branding": {"color": "#225588"}, "working_hours": {"start": "07:00", "end": "17:00"}}'::jsonb
    from public.company_basics(:'co')),
  'which still gives them the clock, branding and the workday only');
select t1122p.as_user(:'nora');
select t1122p.check((select count(*) = 0 from public.visit_prices(array[:'storm']::uuid[])) and public.company_settings(:'co') is null,
  'another business reads neither');
rollback;

-- ===== The roles that see prices ================================================================
begin;
set local role authenticated;
select t1122p.as_user(:'opal');
select t1122p.check((select price = 150 and price_note = 'Snow plow, 2in+ storm rate' from public.visit_prices(array[:'storm']::uuid[])), 'the office reads what a visit bills');
select t1122p.check((select count(*) = 2 and count(price) = 1 from public.visit_prices(array[:'storm', :'plain']::uuid[])), 'a visit with no price of its own comes back without one');
select t1122p.check((public.company_settings(:'co') ->> 'minimum_charge')::numeric = 75 and public.company_settings(:'co') #>> '{marketing,review_message}' = 'Thanks!',
  'and all of the settings');
update public.visits set price = 160 where id = :'storm';
select t1122p.check((select price = 160 from public.visit_prices(array[:'storm']::uuid[])), 'and still sets a visit''s price');
select t1122p.as_user(:'eve');
select t1122p.check((public.company_settings(:'co') ->> 'quote_valid_days')::int = 14, 'an estimator, who reads a job''s lines, reads the settings too');
select t1122p.check((select count(*) = 0 from public.visit_prices(array[:'storm']::uuid[])), 'but not what a visit bills, which is for invoicing');
select t1122p.as_user(:'olive');
select t1122p.check((select price = 160 from public.visit_prices(array[:'storm']::uuid[])) and public.company_settings(:'co') ? 'late_fee', 'so does the owner');
rollback;
-- The server reads everything.
set role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', false);
select t1122p.check((select price = 150 from public.visit_prices(array[:'storm']::uuid[])) and public.company_settings(:'co') ? 'minimum_charge', 'and so does the server');
select set_config('request.jwt.claims', '', false);
reset role;

\o
\echo 'What reads them as the person asking'
\o /dev/null

-- Autopay invoices a job's finished visits as the server: a priced visit at its price.
begin;
update public.visits set status = 'completed' where id in (:'storm', :'plain');
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select t1122p.server_invoice(:'job') as server_invoice \gset
select t1122p.check((select count(*) = 2 and bool_or(unit_price = 150) and bool_or(unit_price = 60) from public.invoice_line_items where invoice_id = :'server_invoice'),
  'an invoice the server makes bills a priced visit at its price too');
rollback;

-- An invoice for the finished visits bills the storm at its price, with the company's terms and tax.
begin;
set local role authenticated;
select t1122p.as_user(:'opal');
update public.visits set status = 'completed' where id in (:'storm', :'plain');
select public.create_invoice_for_job(:'job', 'visits') as invoice \gset
commit;
select t1122p.check((select count(*) = 2 and bool_or(unit_price = 150 and description like 'Visit on %: Snow plow, 2in+ storm rate')
    and bool_or(unit_price = 60 and unit = 'push') from public.invoice_line_items where invoice_id = :'invoice'),
  'the office''s invoice bills a priced visit at its price and an ordinary one at the job''s lines');
select t1122p.check((select due_on - issued_on = 15 and tax_rate = 0.1 from public.invoices where id = :'invoice'),
  'with the company''s payment terms and tax');

-- A quote made from a template is good for as long as the company says.
begin;
set local role authenticated;
select t1122p.as_user(:'eve');
select public.duplicate_quote(:'tpl', null, :'client', :'prop') as copy \gset
select t1122p.check((select valid_until = private.company_today(:'co') + 14 from public.quotes where id = :'copy'), 'a quote from a template is good for the company''s quote_valid_days');
rollback;

-- Saving a screen's own settings merges them, for owners and admins only.
begin;
set local role authenticated;
select t1122p.as_user(:'ada');
select public.merge_company_settings(:'co', '{"branding": {"logo_size": [96, 48]}, "payment_terms_days": 30}');
commit;
select t1122p.check((select settings #>> '{branding,color}' = '#225588' and settings -> 'branding' ? 'logo_size' and settings ->> 'payment_terms_days' = '30'
    and settings ? 'minimum_charge' from public.companies where id = :'co'),
  'an admin merges settings into the ones saved, as before');
begin;
set local role authenticated;
select t1122p.as_user(:'opal');
select t1122p.check(t1122p.error_of(format($q$select public.merge_company_settings(%L, '{"payment_terms_days": 1}')$q$, :'co')) = '42501: Only owners and admins can change the company''s settings.',
  'the office can''t');
select t1122p.as_user(:'cy');
select t1122p.check(t1122p.error_of(format($q$select public.merge_company_settings(%L, '{"payment_terms_days": 1}')$q$, :'co')) like '42501:%', 'nor field crew');
select t1122p.as_user(:'nora');
select t1122p.check(t1122p.error_of(format($q$select public.merge_company_settings(%L, '{"payment_terms_days": 1}')$q$, :'co')) like '42501:%', 'nor another business''s owner');
rollback;
select t1122p.check((select settings ->> 'payment_terms_days' = '30' from public.companies where id = :'co'), 'which changed nothing');

-- ===== What crews read of the settings ==========================================================
select t1122p.check(private.field_settings('{"minimum_charge": 5, "clock": {"mode": "day"}, "marketing": {"enabled": true, "review_message": "x"}, "drive": true, "roofing": {"range_pct": 15}}')
    = '{"clock": {"mode": "day"}, "marketing": {"enabled": true}, "drive": {"enabled": null}}'::jsonb,
  'field_settings keeps the settings crews use, and of an app only whether it''s on');
select t1122p.check(private.field_settings(null) = '{}'::jsonb and private.field_settings('[1]') = '{}'::jsonb, 'and nothing from settings that aren''t an object');
