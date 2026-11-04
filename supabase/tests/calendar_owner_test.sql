-- Database tests for a calendar being one person's (20261105000400_calendar_owner): it can be
-- someone on the team and nobody else, people who schedule can see whose it is, and when that
-- person is removed the calendar stays.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tco;
grant usage on schema tco to authenticated, service_role;
create function tco.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tco.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tco to authenticated, service_role;

-- Ola owns Oak Gutters, with Pia in the office and Cam on a crew; Ed owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0a10000-0000-0000-0000-000000000001', 'ola@oak.test', '{"full_name": "Ola Oak"}'),
  ('c0a10000-0000-0000-0000-000000000002', 'pia@oak.test', '{"full_name": "Pia Office"}'),
  ('c0a10000-0000-0000-0000-000000000003', 'cam@oak.test', '{"full_name": "Cam Crew"}'),
  ('c0a10000-0000-0000-0000-000000000009', 'ed@elm.test', '{"full_name": "Ed Elm"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0a10000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Elm Snow', 'general') as other \gset
select set_config('request.jwt.claims', '{"sub": "c0a10000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Oak Gutters', 'gutters') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c0a10000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'c0a10000-0000-0000-0000-000000000003', 'field_crew');
commit;

-- The server adds Cam's own calendar, and the team's.
insert into public.calendar_sources (company_id, kind, app, name, user_id) values (:'co', 'file', 'google_calendar', 'Cam (personal)', 'c0a10000-0000-0000-0000-000000000003')
returning id as cams \gset
insert into public.calendar_sources (company_id, kind, app, name) values (:'co', 'file', 'ics_calendar', 'Holidays') returning id as team \gset
select tco.check((select user_id is null from public.calendar_sources where id = :'team'), 'a calendar is nobody''s in particular unless it''s set');
select tco.expect_error(format('update public.calendar_sources set user_id = %L where id = %L', 'c0a10000-0000-0000-0000-000000000009', :'team'),
  'it can''t be someone on another business''s team');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0a10000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tco.check((select user_id from public.calendar_sources where id = :'cams') = 'c0a10000-0000-0000-0000-000000000003', 'the office sees whose calendar it is');
select tco.expect_error(format('update public.calendar_sources set user_id = %L where id = %L', 'c0a10000-0000-0000-0000-000000000002', :'cams'), 'only the server changes it');
commit;

delete from public.memberships where company_id = :'co' and user_id = 'c0a10000-0000-0000-0000-000000000003';
select tco.check((select user_id is null from public.calendar_sources where id = :'cams'), 'when they''re removed from the team, their calendar stays, as nobody''s');

delete from public.companies where id in (:'co', :'other');

\echo 'All calendar owner tests passed.'
