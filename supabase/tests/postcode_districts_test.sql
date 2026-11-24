-- Database tests for 20261124100210_postcode_districts.sql: a sales area takes the postal codes that
-- start with it, US ZIPs and Canada's codes as before, and a UK postcode only when the area ends
-- where a part of its outward code does (core forms.ts postalInArea is the same, and its tests
-- have the same cases); a lead goes to the person whose area matches the most of it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1124d;
grant usage on schema t1124d to authenticated, service_role;
-- A sequence counts the checks: it keeps counting through the rollback at the end.
create sequence t1124d.passed;
grant usage on sequence t1124d.passed to authenticated, service_role;
create function t1124d.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  perform nextval('t1124d.passed');
  raise notice 'ok - %', p_what;
end $$;
-- Each postal code as typed, against each area as typed, both as the database keeps them: which match.
create function t1124d.matches(p_code text, p_areas text[]) returns text language sql as $$
  select coalesce(string_agg(a, ' ' order by o), '-') from unnest(p_areas) with ordinality as x (a, o)
  where private.postal_in_area(private.postal_key(p_code), private.postal_key(a))
$$;
create function t1124d.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1124d to authenticated, service_role;

\o
\echo 'Which areas a postal code is in'
\o /dev/null
-- US ZIPs: by their start, as before.
select t1124d.check(t1124d.matches('22001', array['220', '2200', '22001', '221']) = '220 2200 22001', 'a ZIP is in every area its start is');
select t1124d.check(t1124d.matches('22001', array['', '221']) = '', 'and in everywhere else');
select t1124d.check(t1124d.matches('46201-1234', array['462', '46201', '4620']) = '462 46201 4620', 'with or without its +4');
-- Canada: by their start, as before.
select t1124d.check(t1124d.matches('K1A 0B6', array['K', 'K1', 'K1A', 'K1A0', 'K1A 0B6', 'K1B', 'M5V']) = 'K K1 K1A K1A0 K1A 0B6', 'a Canadian code is in every area its start is');
select t1124d.check(t1124d.matches('K1A', array['K', 'K1', 'K1A', 'K1B']) = 'K K1 K1A', 'and its first three alone');
-- The UK: a district is whole.
select t1124d.check(t1124d.matches('SW1A 1AA', array['S', 'SW', 'SW1', 'SW1A', 'SW1A 1', 'SW1A 1AA', 'SW10', 'SW1B']) = 'SW SW1 SW1A SW1A 1 SW1A 1AA', 'SW1 takes SW1A 1AA, and S (Sheffield) doesn''t');
select t1124d.check(t1124d.matches('SW10 1AA', array['S', 'SW', 'SW1', 'SW10', 'SW10 1']) = 'SW SW10 SW10 1', 'SW1 doesn''t take SW10 1AA');
select t1124d.check(t1124d.matches('SW19 2AB', array['SW1', 'SW19']) = 'SW19', 'nor SW19');
select t1124d.check(t1124d.matches('M1 1AE', array['M', 'M1', 'M11', 'M2']) = 'M M1 M11', 'M1 takes M1 1AE (and M11, written as the sector M1 1, does too)');
select t1124d.check(t1124d.matches('M11 1AE', array['M', 'M1', 'M11']) = 'M M11', 'M1 doesn''t take M11 1AE');
select t1124d.check(t1124d.matches('S1 1AA', array['S', 'S1', 'SW', 'S11']) = 'S S1 S11', 'S takes S1 1AA');
select t1124d.check(t1124d.matches('EC1A 1BB', array['E', 'EC', 'EC1', 'EC1A', 'EC2']) = 'EC EC1 EC1A', 'E (east London) doesn''t take EC1A 1BB');
select t1124d.check(t1124d.matches('W1A 0AX', array['W', 'W1', 'W1A', 'W10', 'WC']) = 'W W1 W1A', 'W takes W1A 0AX, and W1 does');
select t1124d.check(t1124d.matches('SW10', array['SW1', 'SW10', 'SW']) = 'SW10 SW', 'an outward code alone is matched the same way');
select t1124d.check(t1124d.matches('sw1a1aa', array['sw1']) = 'sw1', 'whatever its case and spacing');
select t1124d.check(t1124d.matches('', array['SW1', '', 'K1A']) = '', 'no postal code is only in everywhere else');
select t1124d.check(t1124d.matches(null, array['SW1', '']) = '', 'nor is none at all');

\set olive '11240000-0000-4000-8000-000000000021'
\set sam '11240000-0000-4000-8000-000000000022'
\set tess '11240000-0000-4000-8000-000000000023'

-- Everything below is rolled back at the end.
begin;
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@thames.test', '{"full_name": "Olive Owner"}'),
  (:'sam', 'sam@thames.test', '{"full_name": "Sam Sales"}'),
  (:'tess', 'tess@thames.test', '{"full_name": "Tess Sales"}');
set local role authenticated;
select t1124d.as_user(:'olive');
select public.create_company('Thames Gardens', 'general', 'Europe/London') as co \gset
reset role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'sam', 'estimator'), (:'co', :'tess', 'estimator');
-- Sam has SW1 (Westminster), Tess SW10 (Chelsea) and S (Sheffield); Olive everywhere else.
insert into public.sales_areas (company_id, zip, user_id) values (:'co', 'SW1', :'sam'), (:'co', 'SW10', :'tess'), (:'co', 'S', :'tess'), (:'co', '', :'olive');
insert into public.clients (company_id, display_name) values (:'co', 'Cora Client') returning id as client \gset
insert into public.properties (company_id, client_id, line1, postal_code) values
  (:'co', :'client', '10 Downing Street', 'SW1A 2AA'), (:'co', :'client', '1 King''s Road', 'SW10 0AA'),
  (:'co', :'client', '1 Fargate', 'S1 2HE'), (:'co', :'client', '1 Wimbledon Hill', 'SW19 7NB');

\o
\echo 'Who a lead goes to'
\o /dev/null
select t1124d.check((select private.area_salesperson(:'co', id) from public.properties where line1 = '10 Downing Street') = :'sam'::uuid, 'SW1A 2AA goes to the one with SW1');
select t1124d.check((select private.area_salesperson(:'co', id) from public.properties where line1 = '1 King''s Road') = :'tess'::uuid, 'SW10 0AA to the one with SW10, not SW1');
select t1124d.check((select private.area_salesperson(:'co', id) from public.properties where line1 = '1 Fargate') = :'tess'::uuid, 'S1 2HE to the one with S');
select t1124d.check((select private.area_salesperson(:'co', id) from public.properties where line1 = '1 Wimbledon Hill') = :'olive'::uuid, 'SW19 7NB, which nobody has, to everywhere else: not SW1, and not S');
set local role authenticated;
select t1124d.as_user(:'olive');
insert into public.requests (company_id, client_id, property_id, title, source)
  select :'co', :'client', id, 'Hedges', 'phone' from public.properties where line1 = '1 King''s Road' returning assigned_to as assigned \gset
select t1124d.check(:'assigned' = :'tess', 'a new request there is Tess''s');
rollback;

select last_value as passed from t1124d.passed \gset
set client_min_messages = warning;
drop schema t1124d cascade;
reset client_min_messages;

\o
\echo All :passed postcode district checks passed.
