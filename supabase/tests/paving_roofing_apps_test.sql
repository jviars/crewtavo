-- Database tests for Paving and Roofing as apps (20261103000500_paving_roofing_apps): every paving
-- and roofing business has its app installed, other trades have neither, and one that uninstalled
-- keeps it off; Roofing's switch leaves the price ranges alone; only owners and admins who connect
-- apps install them; changing the trade leaves them as they are.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tpr;
grant usage on schema tpr to authenticated, service_role;
create function tpr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tpr.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tpr to authenticated, service_role;

\set pia 'c7a70000-0000-0000-0000-000000000001'
\set rex 'c7a70000-0000-0000-0000-000000000002'
\set lu 'c7a70000-0000-0000-0000-000000000003'
\set dee 'c7a70000-0000-0000-0000-000000000004'
\set oli 'c7a70000-0000-0000-0000-000000000005'

-- Pia owns Birch Paving, Rex owns Gable Roofing (Oli is its office), Lu owns Hollow Lawn and Dee owns
-- Dune Roofing, which uninstalled Roofing before.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'pia', 'pia@birch-paving.test', '{"full_name": "Pia Birch"}'),
  (:'rex', 'rex@gable-roofing.test', '{"full_name": "Rex Gable"}'),
  (:'lu', 'lu@hollow-lawn.test', '{"full_name": "Lu Hollow"}'),
  (:'dee', 'dee@dune-roofing.test', '{"full_name": "Dee Dune"}'),
  (:'oli', 'oli@gable-roofing.test', '{"full_name": "Oli Office"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated"}', :'pia'), true);
select public.create_company('Birch Paving', 'paving') as paver \gset
select set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated"}', :'rex'), true);
select public.create_company('Gable Roofing', 'roofing_exteriors') as roofer \gset
insert into public.memberships (company_id, user_id, role) values (:'roofer', :'oli', 'office');
select set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated"}', :'lu'), true);
select public.create_company('Hollow Lawn', 'lawn_exterior') as lawn \gset
select set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated"}', :'dee'), true);
select public.create_company('Dune Roofing', 'roofing_exteriors') as dune \gset
commit;

-- What these businesses had before the apps: Gable's price ranges, and Dune's switch turned off.
update public.companies set settings = settings || '{"roofing": {"range_pct": 15, "range_round": 50}}' where id = :'roofer';
update public.companies set settings = settings || '{"roofing_app": {"enabled": false}}' where id = :'dune';

-- ===== Installed for the businesses already in those trades ==================================
select private.install_trade_apps() as installed \gset
select tpr.check(:installed >= 2, 'the migration installs the apps for the businesses that never had the switch');
select tpr.check((select settings #>> '{paving_app,enabled}' = 'true' and settings -> 'roofing_app' is null from public.companies where id = :'paver'),
  'a paving business has Paving, and not Roofing');
select tpr.check((select settings #>> '{roofing_app,enabled}' = 'true' and settings -> 'paving_app' is null from public.companies where id = :'roofer'),
  'a roofing business has Roofing, and not Paving');
select tpr.check((select settings -> 'roofing' = '{"range_pct": 15, "range_round": 50}' and settings #>> '{marketing,enabled}' = 'true' from public.companies where id = :'roofer'),
  'and keeps its price ranges and the rest of its settings');
select tpr.check((select settings -> 'paving_app' is null and settings -> 'roofing_app' is null from public.companies where id = :'lawn'),
  'a business in another trade has neither');
select tpr.check((select settings #>> '{roofing_app,enabled}' = 'false' from public.companies where id = :'dune'),
  'a roofer that uninstalled Roofing keeps it off');
select tpr.check(private.install_trade_apps() = 0, 'run again, it changes nothing');

-- ===== The switch ============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated"}', :'rex'), true);
select tpr.check(public.trade_app_set_enabled(:'roofer', 'paving', true), 'the owner installs Paving too');
select tpr.check((select settings #>> '{paving_app,enabled}' = 'true' and settings #>> '{roofing_app,enabled}' = 'true' from public.companies where id = :'roofer'),
  'a business that does both has both');
select tpr.check(not public.trade_app_set_enabled(:'roofer', 'roofing', false), 'and can uninstall Roofing');
select tpr.check((select settings #>> '{roofing_app,enabled}' = 'false' and settings -> 'roofing' = '{"range_pct": 15, "range_round": 50}' from public.companies where id = :'roofer'),
  'which leaves the price ranges as they were');
select public.trade_app_set_enabled(:'roofer', 'roofing', true);
select tpr.expect_error(format($q$select public.trade_app_set_enabled(%L, 'gutters', true)$q$, :'roofer'), 'there are only the two apps');
select tpr.expect_error(format($q$select public.trade_app_set_enabled(%L, 'paving', true)$q$, :'lawn'), 'nobody installs an app for another business');

-- Changing the trade in Settings → Company leaves the apps installed.
update public.companies set trade_preset = 'general' where id = :'roofer';
select tpr.check((select trade_preset = 'general' and settings #>> '{roofing_app,enabled}' = 'true' and settings #>> '{paving_app,enabled}' = 'true' from public.companies where id = :'roofer'),
  'changing the trade turns neither app off');

select set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated"}', :'oli'), true);
select tpr.expect_error(format($q$select public.trade_app_set_enabled(%L, 'roofing', false)$q$, :'roofer'), 'office staff can''t uninstall Roofing');
commit;

\echo 'All paving and roofing app tests passed.'
