-- Database tests for 20261113001850_where_map_spots_came_from.sql: a property's spot on the map is
-- kept with the geocoder that found it; a spot with no coordinates has no source; a spot moved by
-- something that doesn't say where from (an older server) loses its source, and one the same
-- geocoder moved takes it back in a second write; an address change clears both; the shops whose
-- spot has no source are listed for the server, which saves a looked-up spot only while the spot
-- and the company's address are what it read; and only the server reaches those two functions.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmss;
grant usage on schema tmss to authenticated, service_role;
-- A sequence counts the checks: it keeps counting through the rollback at the end.
create sequence tmss.passed;
grant usage on sequence tmss.passed to authenticated, service_role;
create function tmss.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  perform nextval('tmss.passed');
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tmss.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
create function tmss.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function tmss.spot(p_property uuid) returns text language sql as $$
  select concat_ws(' ', lat, lng, coalesce(located_by, '-')) from public.properties where id = p_property
$$;
grant execute on all functions in schema tmss to authenticated, service_role;

\set ada 'a5500000-0000-0000-0000-000000000001'
\set ben 'a5500000-0000-0000-0000-000000000002'

-- Everything below is rolled back at the end.
begin;
-- Ada owns Spot Lawn, with its shop on Main St; Ben owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ada', 'ada@spot.test', '{"full_name": "Ada Owner"}'),
  (:'ben', 'ben@other.test', '{"full_name": "Ben Other"}');
set local role authenticated;
select tmss.as_user(:'ben');
select public.create_company('Other Lawn', 'general') as other \gset
select tmss.as_user(:'ada');
select public.create_company('Spot Lawn', 'general') as co \gset
update public.companies set address = '{"line1": "1 Main St", "city": "Rocky Mount", "region": "VA", "postal_code": "24151"}' where id = :'co';
insert into public.clients (company_id, display_name) values (:'co', 'Cora Client') returning id as client \gset
insert into public.properties (company_id, client_id, line1, city) values (:'co', :'client', '418 Pell Ave', 'Rocky Mount') returning id as pell \gset
insert into public.properties (company_id, client_id, line1, city, lat, lng) values (:'co', :'client', '9 Old Rd', 'Rocky Mount', 36.9, -79.8) returning id as old \gset

\o
\echo 'A spot is kept with where it came from'
\o /dev/null
select tmss.check(tmss.spot(:'pell') = '-', 'a new property has no spot and no source');
select tmss.check(tmss.spot(:'old') = '36.9 -79.8 -', 'a spot saved without a source has none');
update public.properties set lat = 36.99, lng = -79.88, located_by = 'census' where id = :'pell';
select tmss.check(tmss.spot(:'pell') = '36.99 -79.88 census', 'the server saves a spot with the geocoder that found it');
update public.properties set notes = 'Gate on the left' where id = :'pell';
select tmss.check(tmss.spot(:'pell') = '36.99 -79.88 census', 'changing anything else leaves it');
select tmss.check(tmss.error_of(format('update public.properties set located_by = %L where id = %L', 'google', :'pell')) like '23514:%', 'only the free geocoders, or unknown, can be named');

\o
\echo 'A spot saved by something that doesn''t say where from'
\o /dev/null
-- An older server, still running while the update goes in, writes only the coordinates.
update public.properties set lat = 37.01, lng = -79.91 where id = :'pell';
select tmss.check(tmss.spot(:'pell') = '37.01 -79.91 -', 'a spot moved without a source loses the one it had');
update public.properties set lat = 37.01, lng = -79.91, located_by = 'census' where id = :'pell';
select tmss.check(tmss.spot(:'pell') = '37.01 -79.91 census', 'saying the source for the spot as it is keeps it');
-- The same geocoder moves it: the first write can't be told from an older server's, the second says it again.
update public.properties set lat = 37.02, lng = -79.92, located_by = 'census' where id = :'pell';
select tmss.check(tmss.spot(:'pell') = '37.02 -79.92 -', 'a spot the same geocoder moves loses its source in that write');
update public.properties set located_by = 'census' where id = :'pell';
select tmss.check(tmss.spot(:'pell') = '37.02 -79.92 census', 'and takes it back in the server''s second');
update public.properties set lat = 51.5, lng = -0.12, located_by = 'openstreetmap' where id = :'pell';
select tmss.check(tmss.spot(:'pell') = '51.5 -0.12 openstreetmap', 'another geocoder moving it says so in one write');

\o
\echo 'An address neither geocoder knows, and an address changed'
\o /dev/null
update public.properties set located_by = 'unknown' where id = :'old' and lat = 36.9 and lng = -79.8 and located_by is null;
select tmss.check(tmss.spot(:'old') = '36.9 -79.8 unknown', 'a spot from before can be kept, marked unknown');
-- The property form clears the spot when the address changes, before the server looks the new one up.
update public.properties set line1 = '10 New Rd', lat = null, lng = null where id = :'old';
select tmss.check(tmss.spot(:'old') = '-', 'clearing the spot clears its source');
insert into public.properties (company_id, client_id, line1, located_by) values (:'co', :'client', '11 New Rd', 'census') returning id as bare \gset
select tmss.check(tmss.spot(:'bare') = '-', 'a source with no spot isn''t kept');
update public.properties set lat = 36.5, located_by = 'census' where id = :'bare';
select tmss.check(tmss.spot(:'bare') = '36.5 -', 'nor with half of one');

\o
\echo 'The shop'
\o /dev/null
select tmss.check(tmss.error_of('select * from public.depots_to_relocate()') like '42501:%', 'the office can''t list the shops to look up');
select tmss.check(tmss.error_of(format('select public.relocate_depot(%L, %L, %L, %L)', :'co', '{}', '{}', '{"lat": 1, "lng": 2, "source": "census"}')) like '42501:%', 'or save a shop''s spot that way');
reset role;
set local role service_role;
select tmss.check((select count(*) = 0 from public.depots_to_relocate(100) where company_id in (:'co', :'other')), 'a company with no shop spot isn''t listed');
update public.companies set settings = settings || '{"depot": {"lat": 36.9, "lng": -79.8}}' where id = :'co';
update public.companies set settings = settings || '{"depot": {"lat": 40.1, "lng": -75.2, "source": "census"}}' where id = :'other';
select tmss.check((select count(*) = 1 and min(company_id::text) = :'co' and min(address ->> 'line1') = '1 Main St' and min(depot ->> 'lat') = '36.9'
  from public.depots_to_relocate(100) where company_id in (:'co', :'other')), 'a shop spot with no source is listed with the company''s address, and one with a source isn''t');
select tmss.check(tmss.error_of(format('select public.relocate_depot(%L, %L, %L, %L)', :'co', '{}', '{}', '{"lat": 1, "lng": 2, "source": "google"}')) like '22023:%', 'a spot is saved with a source that can be kept');
select tmss.check(tmss.error_of(format('select public.relocate_depot(%L, %L, %L, %L)', :'co', '{}', '{}', '{"lat": 1, "source": "census"}')) like '22023:%', 'and with both coordinates');
select address as shop_address, settings -> 'depot' as shop_was from public.companies where id = :'co' \gset
-- The office changes the address while the lookup is under way.
update public.companies set address = address || '{"line1": "2 Main St"}' where id = :'co';
select tmss.check(not public.relocate_depot(:'co', :'shop_address', :'shop_was', '{"lat": 36.99, "lng": -79.88, "source": "census"}'), 'a spot looked up for an address that has changed since isn''t saved');
update public.companies set address = :'shop_address' where id = :'co';
select tmss.check(not public.relocate_depot(:'co', :'shop_address', '{"lat": 1, "lng": 2}', '{"lat": 36.99, "lng": -79.88, "source": "census"}'), 'nor over a spot that isn''t the one that was read');
select tmss.check(public.relocate_depot(:'co', :'shop_address', :'shop_was', '{"lat": 36.99, "lng": -79.88, "source": "census"}'), 'the spot as read, at the address as read, is replaced');
select tmss.check((select settings -> 'depot' = '{"lat": 36.99, "lng": -79.88, "source": "census"}' from public.companies where id = :'co'), 'with its source beside it');
select tmss.check((select count(*) = 0 from public.depots_to_relocate(100) where company_id in (:'co', :'other')), 'and it isn''t listed again');
-- Settings → Company on a phone that hasn't updated saves a new spot without a source: merged into the one saved.
reset role;
set local role authenticated;
select tmss.as_user(:'ada');
select public.merge_company_settings(:'co', '{"depot": {"lat": 37.5, "lng": -80.1}}');
select tmss.check((select public.company_settings(id) -> 'depot' = '{"lat": 37.5, "lng": -80.1, "source": "census"}' from public.companies where id = :'co'), 'a spot saved by an older page keeps a source (the server only asks the free geocoders now)');
select public.merge_company_settings(:'co', '{"depot": null}');
select tmss.check((select public.company_settings(id) -> 'depot' = 'null' from public.companies where id = :'co'), 'and a shop that isn''t found has no spot');
reset role;
set local role service_role;
select tmss.check((select count(*) = 0 from public.depots_to_relocate(100) where company_id in (:'co', :'other')), 'which leaves nothing to look up');

rollback;

select last_value as passed from tmss.passed \gset
set client_min_messages = warning;
drop schema tmss cascade;
reset client_min_messages;

\o
\echo All :passed map spot checks passed.
