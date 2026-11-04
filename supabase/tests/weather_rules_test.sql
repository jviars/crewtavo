-- Database tests for weather rules a business sets itself (20261105000200_weather_rules): the owner
-- and the office with the Settings area replace them all at once, checked and tidied, keeping the
-- rest of the settings; the estimator, the crew, an office role without Settings and another business
-- can't; and an AI assistant may set them only when it may change the price list.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_wr;
grant usage on schema t_wr to authenticated, service_role;
create function t_wr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_wr.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function t_wr.as_user(p_user uuid, p_client text default null) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true);
$$;
grant execute on all functions in schema t_wr to authenticated, service_role;

-- Wren owns Wren Pavers: Otto is office, Erin an estimator, Cole crew, and Gail office with a custom
-- role that leaves out Settings. Nora owns Nora Snow.
insert into auth.users (id, email, raw_user_meta_data) values
  ('e7a10000-0000-0000-0000-000000000001', 'wren@wren-pavers.test', '{"full_name": "Wren Pavers"}'),
  ('e7a10000-0000-0000-0000-000000000002', 'otto@wren-pavers.test', '{"full_name": "Otto Office"}'),
  ('e7a10000-0000-0000-0000-000000000003', 'erin@wren-pavers.test', '{"full_name": "Erin Estimator"}'),
  ('e7a10000-0000-0000-0000-000000000004', 'cole@wren-pavers.test', '{"full_name": "Cole Crew"}'),
  ('e7a10000-0000-0000-0000-000000000005', 'gail@wren-pavers.test', '{"full_name": "Gail Dispatch"}'),
  ('e7a10000-0000-0000-0000-000000000006', 'nora@nora-snow.test', '{"full_name": "Nora Snow"}');
\set wren 'e7a10000-0000-0000-0000-000000000001'
\set otto 'e7a10000-0000-0000-0000-000000000002'
\set erin 'e7a10000-0000-0000-0000-000000000003'
\set cole 'e7a10000-0000-0000-0000-000000000004'
\set gail 'e7a10000-0000-0000-0000-000000000005'
\set nora 'e7a10000-0000-0000-0000-000000000006'

begin;
set local role authenticated;
select t_wr.as_user(:'nora');
select public.create_company('Nora Snow', 'general') as other \gset
select t_wr.as_user(:'wren');
select public.create_company('Wren Pavers', 'general') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Wren dispatcher', 'office', '{schedule}') returning id as dispatcher \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'otto', 'office', null),
  (:'co', :'erin', 'estimator', null),
  (:'co', :'cole', 'field_crew', null),
  (:'co', :'gail', 'office', :'dispatcher');
update public.companies set settings = settings || '{"payment_terms_days": 15}' where id = :'co';

select public.set_weather_rules(:'co', '[{"applies_to": " Paver patio ", "max_rain_pct": 50, "requires_dry_hours": 24, "note": "drop me"},
  {"applies_to": "", "min_temp_f": 40, "max_temp_f": 90, "max_wind_mph": 20, "max_rain_pct": null}]') as saved \gset
select t_wr.check(:'saved'::jsonb = '[{"applies_to": "Paver patio", "max_rain_pct": 50, "requires_dry_hours": 24}, {"min_temp_f": 40, "max_temp_f": 90, "max_wind_mph": 20}]',
  'the owner sets the rules, tidied: names trimmed, a blank one for every job, unknown fields and empty limits dropped');
select t_wr.check((select settings -> 'weather_rules' = :'saved'::jsonb and (settings ->> 'payment_terms_days')::int = 15 from public.companies where id = :'co'),
  'they''re saved where the weather task reads them, and the other settings stay');
commit;

-- The office with Settings changes them too.
begin;
set local role authenticated;
select t_wr.as_user(:'otto');
select public.set_weather_rules(:'co', '[{"applies_to": "Sealcoat", "min_temp_f": 50, "requires_dry_hours": 24}]');
select t_wr.check((select settings -> 'weather_rules' = '[{"applies_to": "Sealcoat", "min_temp_f": 50, "requires_dry_hours": 24}]' from public.companies where id = :'co'),
  'the office replaces them all at once');
commit;

begin;
set local role authenticated;
select t_wr.as_user(:'erin');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[]')$q$, :'co'), 'an estimator can''t change them');
select t_wr.as_user(:'cole');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[]')$q$, :'co'), 'nor the crew');
select t_wr.as_user(:'gail');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[]')$q$, :'co'), 'nor the office without the Settings area');
select t_wr.as_user(:'nora');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[]')$q$, :'co'), 'nor another business');
select t_wr.as_user(:'wren');
select t_wr.check((select jsonb_array_length(settings -> 'weather_rules') = 1 from public.companies where id = :'co'), 'and the rules are as they were');
commit;

-- Only rules that make sense are saved; one that doesn't saves nothing.
begin;
set local role authenticated;
select t_wr.as_user(:'wren');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '{"max_rain_pct": 50}')$q$, :'co'), 'the rules are a list');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[{"applies_to": "Paver patio"}]')$q$, :'co'), 'each needs a limit');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[{"max_rain_pct": 120}]')$q$, :'co'), 'rain chance is a percent');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[{"max_wind_mph": "20"}]')$q$, :'co'), 'limits are numbers');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[{"min_temp_f": 80, "max_temp_f": 60}]')$q$, :'co'), 'the lowest temperature is below the highest');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, '[{"requires_dry_hours": 0}]')$q$, :'co'), 'dry hours are at least one');
select t_wr.expect_error(format($q$select public.set_weather_rules(%L, %L)$q$, :'co', (select jsonb_agg('{"max_rain_pct": 50}'::jsonb) from generate_series(1, 51))), 'up to 50 rules');
select t_wr.check((select settings -> 'weather_rules' = '[{"applies_to": "Sealcoat", "min_temp_f": 50, "requires_dry_hours": 24}]' from public.companies where id = :'co'),
  'and none of those changed what was saved');
select public.set_weather_rules(:'co', '[]');
select t_wr.check((select settings -> 'weather_rules' = '[]' from public.companies where id = :'co'), 'an empty list clears them');
rollback;

-- An AI assistant sets them through the function, when it may change the price list.
\set pricing 'e7a1c000-0000-0000-0000-00000000000a'
\set crewing 'e7a1c000-0000-0000-0000-00000000000b'
begin;
set local role authenticated;
select t_wr.as_user(:'wren');
insert into public.assistant_connections (client_id, level, areas) values (:'pricing', 'areas', '{prices}'), (:'crewing', 'areas', '{crews}');
commit;

begin;
set local role authenticated;
select t_wr.as_user(:'wren', :'pricing');
select set_config('request.method', 'POST', true), set_config('request.path', '/rpc/set_weather_rules', true);
select hooks.before_request();
select t_wr.check(current_setting('transaction_read_only') = 'off', 'an assistant that may change the price list can write with it');
select public.set_weather_rules(:'co', '[{"applies_to": "Paver patio", "max_rain_pct": 40}]');
select t_wr.check((select settings -> 'weather_rules' = '[{"applies_to": "Paver patio", "max_rain_pct": 40}]' from public.companies where id = :'co'), 'and the company guard lets the rules through');
select t_wr.expect_error(format($q$update public.companies set settings = settings || '{"formulas": []}' where id = %L$q$, :'co'), 'but nothing else the guard keeps from assistants');
rollback;
begin;
set local role authenticated;
select t_wr.as_user(:'wren', :'crewing');
select set_config('request.method', 'POST', true), set_config('request.path', '/rpc/set_weather_rules', true);
select hooks.before_request();
select t_wr.check(current_setting('transaction_read_only') = 'on', 'one that may only change crews can''t');
rollback;

\echo 'All weather rules tests passed.'
