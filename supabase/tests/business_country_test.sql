-- Database tests for 20261124100100_business_country.sql: a business's country is guessed from its
-- time zone as sign-up guesses it (core countryFor), is a two-letter code, is read by everyone in the
-- business, and is changed by its owner or an admin only.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1124c;
grant usage on schema t1124c to authenticated, service_role;
create function t1124c.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1124c.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1124c.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1124c to authenticated, service_role;

-- ===== The guess from the time zone =============================================================
select t1124c.check(private.country_for_zone('America/New_York') = 'US' and private.country_for_zone('America/Los_Angeles') = 'US'
  and private.country_for_zone('America/Phoenix') = 'US' and private.country_for_zone('Pacific/Honolulu') = 'US', 'US zones are the US');
select t1124c.check(private.country_for_zone('America/Toronto') = 'CA' and private.country_for_zone('America/Vancouver') = 'CA'
  and private.country_for_zone('America/St_Johns') = 'CA' and private.country_for_zone('America/Halifax') = 'CA', 'Canada''s zones are Canada');
select t1124c.check(private.country_for_zone('Europe/London') = 'GB' and private.country_for_zone('Europe/Belfast') = 'GB'
  and private.country_for_zone('Europe/Dublin') = 'IE', 'London is the UK, Dublin Ireland');
select t1124c.check(private.country_for_zone('Australia/Sydney') = 'AU' and private.country_for_zone('Pacific/Auckland') = 'NZ'
  and private.country_for_zone('Africa/Johannesburg') = 'ZA' and private.country_for_zone('Europe/Berlin') = 'DE'
  and private.country_for_zone('Atlantic/Canary') = 'ES' and private.country_for_zone('Europe/Sofia') = 'BG', 'and the others the currencies are for');
select t1124c.check(private.country_for_zone('Asia/Tokyo') = 'US' and private.country_for_zone(null) = 'US' and private.country_for_zone('') = 'US', 'anything else stays the US');

\set olive '11240000-0000-4000-8000-000000000001'
\set ada '11240000-0000-4000-8000-000000000002'
\set cy '11240000-0000-4000-8000-000000000003'
\set nora '11240000-0000-4000-8000-000000000004'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@thames.test', '{"full_name": "Olive Owner"}'),
  (:'ada', 'ada@thames.test', '{"full_name": "Ada Admin"}'),
  (:'cy', 'cy@thames.test', '{"full_name": "Cy Crew"}'),
  (:'nora', 'nora@nora.test', '{"full_name": "Nora Other"}');

begin;
set local role authenticated;
select t1124c.as_user(:'nora');
select public.create_company('Nora Yards', 'general') as other \gset
select t1124c.as_user(:'olive');
select public.create_company('Thames Gardens', 'general', 'Europe/London') as co \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', :'ada', 'admin'), (:'co', :'cy', 'field_crew');

-- ===== A new business, and changing it ==========================================================
select t1124c.check((select country from public.companies where id = :'co') = 'US', 'a business made without a country is in the US until it says (the sign-up sets it)');

begin;
set local role authenticated;
select t1124c.as_user(:'olive');
update public.companies set country = 'GB' where id = :'co';
select t1124c.check((select country from public.companies where id = :'co') = 'GB', 'its owner sets it');
select t1124c.check(t1124c.error_of(format($q$update public.companies set country = 'gb' where id = %L$q$, :'co')) like '23514:%', 'as a two-letter code in capitals');
select t1124c.check(t1124c.error_of(format($q$update public.companies set country = 'GBR' where id = %L$q$, :'co')) like '23514:%', 'not three letters');
select t1124c.check(t1124c.error_of(format($q$update public.companies set country = 'UK' where id = %L$q$, :'co')) like '23514:%', 'and one Crewtavo knows (the UK is GB)');
select t1124c.as_user(:'ada');
update public.companies set country = 'CA' where id = :'co';
select t1124c.check((select country from public.companies where id = :'co') = 'CA', 'an admin sets it too');
select t1124c.as_user(:'cy');
select t1124c.check((select country from public.companies where id = :'co') = 'CA', 'the crew reads it');
update public.companies set country = 'US' where id = :'co';
select t1124c.as_user(:'olive');
select t1124c.check((select country from public.companies where id = :'co') = 'CA', 'and can''t change it');
select t1124c.as_user(:'nora');
select t1124c.check(not exists (select 1 from public.companies where id = :'co'), 'another business doesn''t see it');
rollback;

\echo 'All tests of the business country passed.'
