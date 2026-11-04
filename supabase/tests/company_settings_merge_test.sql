-- Database tests for saving only a screen's own settings (20261106000410_company_settings_merge):
-- merge_company_settings merges the keys given into companies.settings and keeps the rest (an object
-- into the object saved, one level down), so a page open since before a newer change doesn't undo
-- it; only owners and admins can, as for any change to the company; and an AI assistant merges them
-- as a change to company details, held to the settings on Settings → Company.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_csm;
grant usage on schema t_csm to authenticated, service_role;
create function t_csm.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_csm.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function t_csm.as_user(p_user uuid, p_client text default null) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true);
$$;
grant execute on all functions in schema t_csm to authenticated, service_role;

-- Opal owns Opal Lawn, Abe is its admin and Oren is in its office. Nell owns Nell Snow.
insert into auth.users (id, email, raw_user_meta_data) values
  ('e7c30000-0000-0000-0000-000000000001', 'opal@opal-lawn.test', '{"full_name": "Opal Lawn"}'),
  ('e7c30000-0000-0000-0000-000000000002', 'abe@opal-lawn.test', '{"full_name": "Abe Admin"}'),
  ('e7c30000-0000-0000-0000-000000000003', 'oren@opal-lawn.test', '{"full_name": "Oren Office"}'),
  ('e7c30000-0000-0000-0000-000000000009', 'nell@nell-snow.test', '{"full_name": "Nell Snow"}');
\set opal 'e7c30000-0000-0000-0000-000000000001'
\set abe 'e7c30000-0000-0000-0000-000000000002'
\set oren 'e7c30000-0000-0000-0000-000000000003'
\set nell 'e7c30000-0000-0000-0000-000000000009'

begin;
set local role authenticated;
select t_csm.as_user(:'nell');
select public.create_company('Nell Snow', 'general') as other \gset
select t_csm.as_user(:'opal');
select public.create_company('Opal Lawn', 'general') as co \gset
select :'co' || '/logo/e7c30000-0000-0000-0000-0000000000aa.png' as logo \gset
update public.companies set settings = settings || '{"payment_terms_days": 30, "minimum_charge": 50,
  "clock": {"record_location": true, "breaks": "paid", "remind_after_hours": 10}, "weather_rules": [{"applies_to": "Mowing", "max_rain_pct": 70}]}'
  || jsonb_build_object('branding', jsonb_build_object('color', '#0f2a35', 'logo', :'logo'))
where id = :'co';
commit;
-- An admin is made on Settings → People; the server stands in for it.
begin;
set local role service_role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'abe', 'admin'), (:'co', :'oren', 'office');
commit;

\o
\echo 'Merging'
\o /dev/null

begin;
set local role authenticated;
select t_csm.as_user(:'opal');
create temp table before on commit drop as select settings from public.companies where id = :'co';
-- Settings → Company, open since before a weather rule was added, saves what it shows.
update public.companies set settings = jsonb_set(settings, '{weather_rules}', settings -> 'weather_rules' || '[{"applies_to": "Aeration", "max_rain_pct": 40}]') where id = :'co';
select public.merge_company_settings(:'co', '{"payment_terms_days": 15, "minimum_charge": null, "branding": {"color": "#3b7d23"},
  "clock": {"record_location": false, "breaks": "short_paid"}, "late_fee": {"type": "flat", "amount": 25, "grace_days": 7}}');
select t_csm.check((select settings -> 'weather_rules' = '[{"applies_to": "Mowing", "max_rain_pct": 70}, {"applies_to": "Aeration", "max_rain_pct": 40}]' from public.companies where id = :'co'),
  'a newer change to a key it doesn''t save stays');
select t_csm.check((select (settings ->> 'payment_terms_days')::int = 15 and settings -> 'minimum_charge' = 'null' and settings -> 'late_fee' = '{"type": "flat", "amount": 25, "grace_days": 7}'
  from public.companies where id = :'co'), 'the keys it gives replace the ones saved, null and new ones too');
select t_csm.check((select settings -> 'branding' = jsonb_build_object('color', '#3b7d23', 'logo', :'logo')
  and settings -> 'clock' = '{"record_location": false, "breaks": "short_paid", "remind_after_hours": 10}' from public.companies where id = :'co'),
  'an object is merged into the one saved: the logo and the clock''s other settings stay');
select t_csm.check((select (c.settings - array['payment_terms_days', 'minimum_charge', 'branding', 'clock', 'late_fee', 'weather_rules'])
  = (b.settings - array['payment_terms_days', 'minimum_charge', 'branding', 'clock', 'late_fee', 'weather_rules']) from public.companies c, before b where c.id = :'co'),
  'and nothing else changes');
select public.merge_company_settings(:'co', '{"late_fee": null}');
select t_csm.check((select settings -> 'late_fee' = 'null' from public.companies where id = :'co'), 'an object can be turned off again');
select public.merge_company_settings(:'co', '{}');
select t_csm.check((select settings ->> 'payment_terms_days' = '15' and settings ? 'weather_rules' from public.companies where id = :'co'), 'nothing to merge changes nothing');
select t_csm.expect_error(format($q$select public.merge_company_settings(%L, '[{"payment_terms_days": 15}]')$q$, :'co'), 'settings are names and values');
select t_csm.expect_error(format($q$select public.merge_company_settings(%L, null)$q$, :'co'), 'and there are some');
select t_csm.as_user(:'abe');
select public.merge_company_settings(:'co', '{"quote_valid_days": 45}');
select t_csm.check((select settings ->> 'quote_valid_days' = '45' from public.companies where id = :'co'), 'an admin merges them too');
commit;

begin;
set local role authenticated;
select t_csm.as_user(:'oren');
select t_csm.expect_error(format($q$select public.merge_company_settings(%L, '{"payment_terms_days": 0}')$q$, :'co'), 'the office can''t, as it can''t change the company');
select t_csm.as_user(:'nell');
select t_csm.expect_error(format($q$select public.merge_company_settings(%L, '{"payment_terms_days": 0}')$q$, :'co'), 'nor another business');
select t_csm.check(not has_function_privilege('anon', 'public.merge_company_settings(uuid, jsonb)', 'execute'), 'nor anyone signed out');
rollback;
select t_csm.check((select settings ->> 'payment_terms_days' = '15' from public.companies where id = :'co'), 'and the settings are as they were');

\o
\echo 'AI assistants'
\o /dev/null

\set details 'e7c3c000-0000-0000-0000-00000000000a'
\set pricing 'e7c3c000-0000-0000-0000-00000000000b'
begin;
set local role authenticated;
select t_csm.as_user(:'opal');
insert into public.assistant_connections (client_id, level, areas) values (:'details', 'areas', '{company}'), (:'pricing', 'areas', '{prices}');
commit;

begin;
set local role authenticated;
select t_csm.as_user(:'opal', :'details');
select set_config('request.method', 'POST', true), set_config('request.path', '/rpc/merge_company_settings', true);
select hooks.before_request();
select t_csm.check(current_setting('transaction_read_only') = 'off', 'an assistant that may change company details can merge settings');
select public.merge_company_settings(:'co', '{"working_hours": {"start": "08:00", "end": "17:00", "days": [1, 2, 3, 4, 5, 6]}, "hub_tips": true}');
select t_csm.check((select settings -> 'working_hours' = '{"start": "08:00", "end": "17:00", "days": [1, 2, 3, 4, 5, 6]}' and settings -> 'hub_tips' = 'true'
  from public.companies where id = :'co'), 'the settings on Settings → Company');
select t_csm.expect_error(format($q$select public.merge_company_settings(%L, '{"assistants": {"read_only": false}}')$q$, :'co'), 'nothing else the guard keeps from assistants');
rollback;
begin;
set local role authenticated;
select t_csm.as_user(:'opal', :'pricing');
select set_config('request.method', 'POST', true), set_config('request.path', '/rpc/merge_company_settings', true);
select hooks.before_request();
select t_csm.check(current_setting('transaction_read_only') = 'on', 'one that may only change the price list can''t');
rollback;

\echo 'All company settings merge tests passed.'
