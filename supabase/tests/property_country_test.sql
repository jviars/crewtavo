-- Database tests for 20261124100200_property_country.sql: a new property is in its business's
-- country unless it names another (or its client's billing address names one, as a Stripe
-- customer's does); a business's properties that were in its old country by default move when its
-- country changes, except one the Census found in the US; the moved ones with no spot wait for the
-- pins task, which only the server can list and answer.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1124p;
grant usage on schema t1124p to authenticated, service_role;
-- A sequence counts the checks: it keeps counting through the rollback at the end.
create sequence t1124p.passed;
grant usage on sequence t1124p.passed to authenticated, service_role;
create function t1124p.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  perform nextval('t1124p.passed');
  raise notice 'ok - %', p_what;
end $$;
create function t1124p.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
create function t1124p.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function t1124p.country(p_property uuid) returns text language sql security definer as $$
  select country from public.properties where id = p_property
$$;
create function t1124p.waiting() returns text language sql security definer as $$
  select coalesce(string_agg(p.line1, ', ' order by p.line1), '') from private.properties_to_find q join public.properties p on p.id = q.property_id
$$;
grant execute on all functions in schema t1124p to authenticated, service_role;

\set olive '11240000-0000-4000-8000-000000000011'
\set ulla '11240000-0000-4000-8000-000000000012'

-- Everything below is rolled back at the end.
begin;
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@thames.test', '{"full_name": "Olive Owner"}'),
  (:'ulla', 'ulla@valley.test', '{"full_name": "Ulla Owner"}');
set local role authenticated;
select t1124p.as_user(:'ulla');
select public.create_company('Valley Lawn', 'general') as us_co \gset
insert into public.clients (company_id, display_name) values (:'us_co', 'Vic Client') returning id as us_client \gset
select t1124p.as_user(:'olive');
select public.create_company('Thames Gardens', 'general', 'Europe/London') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Cora Client') returning id as client \gset
-- A Stripe customer: the import gives the client the billing address Stripe has, country and all.
insert into public.clients (company_id, display_name, billing_address) values (:'co', 'Sam Stripe', '{"line1": "1 Elm St", "country": "US"}') returning id as stripe_client \gset

\o
\echo 'A new property'
\o /dev/null
-- Made in the US (as create_company makes every business), the business's properties are too.
insert into public.properties (company_id, client_id, line1, city) values (:'co', :'client', '1 Bank St', 'Leeds') returning id as before \gset
select t1124p.check(t1124p.country(:'before') = 'US', 'a business in the US makes its properties there');
update public.companies set country = 'GB' where id = :'co';
insert into public.properties (company_id, client_id, line1, city) values (:'co', :'client', '2 Bank St', 'Leeds') returning id as plain \gset
select t1124p.check(t1124p.country(:'plain') = 'GB', 'one made without a country is in the business''s');
insert into public.properties (company_id, client_id, line1, country) values (:'co', :'client', '3 Bank St', 'US') returning id as said_us \gset
select t1124p.check(t1124p.country(:'said_us') = 'GB', 'as is one that says the US, the default, which no form asks about');
insert into public.properties (company_id, client_id, line1, country) values (:'co', :'client', '4 Rue Haute', 'FR') returning id as france \gset
select t1124p.check(t1124p.country(:'france') = 'FR', 'one that names another country keeps it');
insert into public.properties (company_id, client_id, line1, country) values (:'co', :'stripe_client', '1 Elm St', 'US') returning id as stripe_us \gset
select t1124p.check(t1124p.country(:'stripe_us') = 'US', 'one whose client''s billing address names a country keeps the one it came with (the Stripe import)');
select t1124p.as_user(:'ulla');
insert into public.properties (company_id, client_id, line1) values (:'us_co', :'us_client', '418 Pell Ave') returning id as us_plain \gset
insert into public.properties (company_id, client_id, line1, country) values (:'us_co', :'us_client', '9 King St', 'CA') returning id as us_canada \gset
select t1124p.check(t1124p.country(:'us_plain') = 'US' and t1124p.country(:'us_canada') = 'CA', 'a business in the US: the US unless it says otherwise, as before');

\o
\echo 'A business''s country changes'
\o /dev/null
-- Thames Gardens was in the US by default when '1 Bank St' was made; the change above moved it.
select t1124p.check(t1124p.country(:'before') = 'GB', 'its properties in the US by default move with it');
select t1124p.check(t1124p.waiting() = '1 Bank St', 'and the one with no spot waits to be looked up there');
select t1124p.as_user(:'olive');
insert into public.properties (company_id, client_id, line1, lat, lng) values (:'co', :'client', '5 Bank St', 53.8, -1.55) returning id as spotted \gset
insert into public.properties (company_id, client_id, line1, lat, lng) values (:'co', :'client', '6 Bank St', 53.8, -1.55) returning id as census \gset
update public.properties set located_by = 'census' where id = :'census';
update public.companies set country = 'IE' where id = :'co';
select t1124p.check(t1124p.country(:'plain') = 'IE' and t1124p.country(:'said_us') = 'IE' and t1124p.country(:'before') = 'IE' and t1124p.country(:'spotted') = 'IE',
  'a business that moves takes its properties in its old country with it');
select t1124p.check(t1124p.country(:'france') = 'FR' and t1124p.country(:'stripe_us') = 'US', 'but not one in another country, or one whose client''s billing address names one');
select t1124p.check(t1124p.country(:'census') = 'GB', 'nor one the Census found on the map: the Census only knows the US');
select t1124p.check(t1124p.waiting() = '1 Bank St, 2 Bank St, 3 Bank St', 'the ones with no spot wait, once each');
update public.companies set name = 'Liffey Gardens' where id = :'co';
select t1124p.check(t1124p.country(:'plain') = 'IE', 'saving the business without changing its country moves nothing');
update public.properties set country = 'US' where id in (:'plain', :'census');
select t1124p.check(t1124p.country(:'plain') = 'US', 'a property can be put in the US by hand: only a new one is moved');

-- The release before this one: businesses outside the US had every property there by default.
reset role;
select t1124p.check(private.move_properties_to_business_country(:'us_co', 'US') = 0, 'a business in the US has nothing to move');
select t1124p.check(private.move_properties_to_business_country(:'co', 'US') = 1, 'moving the business''s properties in the US says how many moved');
select t1124p.check(t1124p.country(:'plain') = 'IE' and t1124p.country(:'census') = 'US' and t1124p.country(:'stripe_us') = 'US', 'and leaves the one the Census found in the US, and the Stripe customer''s');
select t1124p.check(t1124p.error_of('select private.move_properties_to_business_country(null, ''US'')') = 'none', 'no business moves nothing');

\o
\echo 'Finding the ones with no spot'
\o /dev/null
set local role authenticated;
select t1124p.as_user(:'olive');
select t1124p.check(t1124p.error_of('select * from public.properties_to_find()') like '42501:%', 'the office can''t list the properties to look up');
select t1124p.check(t1124p.error_of(format('select public.property_found(%L, 1, 2, %L)', :'plain', 'openstreetmap')) like '42501:%', 'or save a spot that way');
select t1124p.check(t1124p.error_of('select * from private.properties_to_find') like '42501:%', 'or read the list');
reset role;
set local role service_role;
select t1124p.check((select count(*) = 3 and bool_and(country = 'IE') and bool_and(company_id = :'co') and min(line1) = '1 Bank St' and max(city) = 'Leeds'
  from public.properties_to_find(null, 100)), 'the server lists them with their address and country as they are now');
select t1124p.check((select count(*) = 1 from public.properties_to_find(null, 1)), 'a few at a time');
select id as first from public.properties_to_find(null, 1) \gset
select t1124p.check((select count(*) = 2 and bool_and(id > :'first') from public.properties_to_find(:'first', 100)), 'after the last one it read');
select t1124p.check(t1124p.error_of(format('select public.property_found(%L, 1, null, %L)', :'plain', 'openstreetmap')) like '22023:%', 'a spot has both coordinates');
select t1124p.check(t1124p.error_of(format('select public.property_found(%L, 1, 2, %L)', :'plain', 'google')) like '22023:%', 'and a geocoder whose spots can be kept');
select t1124p.check(public.property_found(:'plain', 53.79, -1.54, 'openstreetmap'), 'a spot found is saved');
select t1124p.check((select concat_ws(' ', lat, lng, located_by) = '53.79 -1.54 openstreetmap' from public.properties where id = :'plain'), 'with the geocoder that found it');
select t1124p.check(not public.property_found(:'said_us'), 'one the geocoder doesn''t know saves nothing');
select t1124p.check(t1124p.waiting() = '1 Bank St', 'and both leave the list');
reset role;
update public.properties set lat = 53.7, lng = -1.5 where id = :'before';
set local role service_role;
select t1124p.check(not public.property_found(:'before', 53.79, -1.54, 'openstreetmap'), 'a spot saved meanwhile isn''t replaced');
select t1124p.check((select lat = 53.7 from public.properties where id = :'before'), 'it stays as the office saved it');
select t1124p.check(t1124p.waiting() = '', 'and it leaves the list too');
reset role;
insert into private.properties_to_find (property_id) values (:'said_us');
update public.properties set lat = 53.6, lng = -1.4 where id = :'said_us';
set local role service_role;
select t1124p.check((select count(*) = 0 from public.properties_to_find(null, 100)), 'one that got a spot some other way isn''t listed');
select t1124p.check(t1124p.waiting() = '', 'and leaves the list when it''s read');
reset role;
insert into private.properties_to_find (property_id) values (:'france');
delete from public.properties where id = :'france';
select t1124p.check(t1124p.waiting() = '', 'a property deleted leaves it');

rollback;

select last_value as passed from t1124p.passed \gset
set client_min_messages = warning;
drop schema t1124p cascade;
reset client_min_messages;

\o
\echo All :passed property country checks passed.
