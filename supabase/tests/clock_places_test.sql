-- Database tests for where people clock in and out (20261024000100_clock_places.sql): the place goes
-- in with the clock as it starts or stops and can't be changed after; the owner and managers with
-- the timesheets area see everyone's, a crew lead their crew's, and nobody sees their own (or
-- reads them off time_entries at all). A company that switches it off keeps none.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1050;
grant usage on schema t1050 to authenticated, service_role;
create function t1050.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1050.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t1050 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c1050000-0000-0000-0000-000000000001', 'owner@tango.test', '{"full_name": "Olive Owner"}'),
  ('c1050000-0000-0000-0000-000000000002', 'fran@tango.test', '{"full_name": "Fran Foreman"}'),
  ('c1050000-0000-0000-0000-000000000003', 'emma@tango.test', '{"full_name": "Emma Employee"}'),
  ('c1050000-0000-0000-0000-000000000004', 'gus@tango.test', '{"full_name": "Gus Other Crew"}'),
  ('c1050000-0000-0000-0000-000000000005', 'dot@tango.test', '{"full_name": "Dot Dispatcher"}');

-- The owner; Fran, Foreman of the Mowing crew with Emma on it; Gus on no crew of hers; Dot in the
-- office without the timesheets area. One job at a property on the map, and the shop on the map too.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1050000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Tango Lawn', 'general') as co \gset
select id as foreman_role from public.company_roles where company_id = :'co' and name = 'Foreman' \gset
select id as employee_role from public.company_roles where company_id = :'co' and name = 'Employee' \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule}') returning id as dispatch_role \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'c1050000-0000-0000-0000-000000000002', 'crew_lead', :'foreman_role'),
  (:'co', 'c1050000-0000-0000-0000-000000000003', 'field_crew', :'employee_role'),
  (:'co', 'c1050000-0000-0000-0000-000000000004', 'field_crew', :'employee_role'),
  (:'co', 'c1050000-0000-0000-0000-000000000005', 'office', :'dispatch_role');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Mowing', 'c1050000-0000-0000-0000-000000000002') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'c1050000-0000-0000-0000-000000000003');
insert into public.clients (company_id, display_name) values (:'co', 'Maple HOA') returning id as client \gset
insert into public.properties (company_id, client_id, line1, lat, lng) values (:'co', :'client', '1 Maple Ct', 40.0, -75.0) returning id as prop \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Weekly mowing') returning id as job \gset
insert into public.visits (company_id, job_id, property_id, title, crew_id, scheduled_on) values (:'co', :'job', :'prop', 'Mow Maple Ct', :'crew', private.company_today(:'co')) returning id as visit \gset
update public.companies set settings = settings || '{"depot": {"lat": 40.1, "lng": -75.1}}' where id = :'co';
commit;

-- ===== Emma clocks in and out on her phone =====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1050000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
-- As clockVisit does: the clock and where the phone was, in one write.
insert into public.time_entries (company_id, user_id, visit_id, job_id, category, started_at, in_place) values
  (:'co', 'c1050000-0000-0000-0000-000000000003', :'visit', :'job', 'visit', now() - interval '2 hours', '{"lat": 40.0004, "lng": -75.0003, "accuracy": 12}')
returning id as emma_visit \gset
select t1050.expect_error('select in_place from public.time_entries', 'Emma can''t read where she clocked in');
select t1050.expect_error('select * from public.time_entries', 'not even with select *');
select t1050.check((select count(*) from public.time_entry_places(:'co', array[:'emma_visit']::uuid[])) = 0, 'and isn''t handed it either');
select t1050.expect_error(format('update public.time_entries set in_place = %L where id = %L', '{"lat": 1, "lng": 1}', :'emma_visit'), 'she can''t change where she clocked in');
select t1050.expect_error(format('update public.time_entries set out_place = %L where id = %L', '{"lat": 1, "lng": 1}', :'emma_visit'), 'or add a clock-out place without clocking out');
update public.time_entries set ended_at = now() - interval '1 hour', out_place = '{"lat": 40.03, "lng": -75.0, "accuracy": 8}' where id = :'emma_visit' and ended_at is null;
select t1050.check((select ended_at is not null from public.time_entries where id = :'emma_visit'), 'clocking out saves where she was then');
select t1050.expect_error(format('update public.time_entries set out_place = %L where id = %L', '{"lat": 40.0, "lng": -75.0}', :'emma_visit'), 'and it can''t be changed after');
update public.time_entries set notes = 'Gate was locked' where id = :'emma_visit';
select t1050.check((select notes from public.time_entries where id = :'emma_visit') = 'Gate was locked', 'she can still fix her own unapproved time');
select t1050.expect_error(format('insert into public.time_entries (company_id, user_id, started_at, ended_at, in_place) values (%L, %L, now() - interval %L, now(), %L)',
  :'co', 'c1050000-0000-0000-0000-000000000003', '3 hours', '{"lat": 40.0, "lng": -75.0}'), 'time typed in by hand can''t claim a clock-in place');
select t1050.expect_error(format('insert into public.time_entries (company_id, user_id, started_at, in_place) values (%L, %L, now(), %L)',
  :'co', 'c1050000-0000-0000-0000-000000000003', '{"lat": "here", "lng": -75.0}'), 'a place has to be a real point');
select t1050.expect_error(format('insert into public.time_entries (company_id, user_id, started_at, in_place) values (%L, %L, now(), %L)',
  :'co', 'c1050000-0000-0000-0000-000000000003', '{"lat": 91, "lng": -75.0}'), 'on the planet');
select t1050.expect_error(format('insert into public.time_entries (company_id, user_id, started_at, in_place) values (%L, %L, now(), %L)',
  :'co', 'c1050000-0000-0000-0000-000000000003', '{"lat": 40, "lng": -75.0, "note": "trust me"}'), 'with nothing else in it');
-- Shop time with location turned off on her phone.
insert into public.time_entries (company_id, user_id, category, started_at, in_place) values
  (:'co', 'c1050000-0000-0000-0000-000000000003', 'shop', now() - interval '50 minutes', '{"missing": "denied", "by": "c1050000-0000-0000-0000-000000000001"}')
returning id as emma_shop \gset
commit;

-- ===== Fran clocks the crew in from her phone ==================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1050000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.time_entries set ended_at = now() - interval '40 minutes', out_place = '{"lat": 40.1001, "lng": -75.1001, "accuracy": 20}'
  where company_id = :'co' and user_id in ('c1050000-0000-0000-0000-000000000002', 'c1050000-0000-0000-0000-000000000003') and ended_at is null;
insert into public.time_entries (company_id, user_id, category, started_at, in_place) values
  (:'co', 'c1050000-0000-0000-0000-000000000003', 'drive', now() - interval '40 minutes', '{"lat": 40.1001, "lng": -75.1001, "accuracy": 20}')
returning id as emma_drive \gset
insert into public.time_entries (company_id, user_id, category, started_at, in_place) values
  (:'co', 'c1050000-0000-0000-0000-000000000002', 'drive', now() - interval '40 minutes', '{"lat": 40.1001, "lng": -75.1001, "accuracy": 20}')
returning id as fran_drive \gset
select t1050.check((select count(*) from public.time_entry_places(:'co', array[:'emma_visit', :'emma_shop', :'emma_drive']::uuid[])) = 3, 'Fran sees where Emma, on her crew, clocked in and out');
select t1050.check((select count(*) from public.time_entry_places(:'co', array[:'fran_drive']::uuid[])) = 0, 'but not her own');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1050000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.time_entries (company_id, user_id, category, started_at, in_place) values
  (:'co', 'c1050000-0000-0000-0000-000000000004', 'other', now() - interval '30 minutes', '{"missing": "timeout"}')
returning id as gus_other \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1050000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t1050.check((select count(*) from public.time_entry_places(:'co', array[:'gus_other']::uuid[])) = 0, 'nor Gus''s, who isn''t on her crew');
commit;

-- ===== The owner sees everyone's, with the place the work was at ==============================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1050000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
create temp table seen on commit drop as
  select * from public.time_entry_places(:'co', array[:'emma_visit', :'emma_shop', :'emma_drive', :'fran_drive', :'gus_other']::uuid[]);
select t1050.check((select count(*) from seen) = 5, 'the owner sees where everyone clocked in and out');
select t1050.check((select in_place ->> 'by' = 'c1050000-0000-0000-0000-000000000003' and (in_place ->> 'accuracy')::int = 12 and out_place ->> 'lat' = '40.03' from seen where id = :'emma_visit'), 'what Emma''s phone said, as hers');
select t1050.check((select site = '{"kind": "job", "lat": 40.0, "lng": -75.0}'::jsonb from seen where id = :'emma_visit'), 'next to where the visit is');
select t1050.check((select in_place = '{"missing": "denied", "by": "c1050000-0000-0000-0000-000000000003"}'::jsonb and site ->> 'kind' = 'shop' from seen where id = :'emma_shop'), 'why her phone didn''t say (whose phone isn''t up to the phone), and where the shop is');
select t1050.check((select in_place ->> 'by' = 'c1050000-0000-0000-0000-000000000002' and site is null from seen where id = :'emma_drive'), 'and that Fran''s phone clocked her in for the drive');
select t1050.expect_error('select in_place from public.time_entries', 'not even the owner reads them off time_entries');
-- Fixing the time and approving it keep the places.
update public.time_entries set started_at = started_at - interval '5 minutes' where id = :'emma_visit';
update public.time_entries set approved_at = now(), approved_by = 'c1050000-0000-0000-0000-000000000001' where id = :'emma_visit';
select t1050.check((select in_place is not null and out_place is not null from public.time_entry_places(:'co', array[:'emma_visit']::uuid[])), 'editing and approving the time keep where it was clocked');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1050000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1050.check((select count(*) from public.time_entry_places(:'co', array[:'emma_visit', :'gus_other']::uuid[])) = 0, 'the office without the timesheets area doesn''t see them');
commit;

-- ===== Switched off: no places are kept ========================================================
update public.companies set settings = jsonb_set(settings, '{clock}', '{"record_location": false}') where id = :'co';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1050000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
update public.time_entries set ended_at = now(), out_place = '{"lat": 40.0, "lng": -75.0}' where id = :'gus_other';
insert into public.time_entries (company_id, user_id, category, started_at, in_place) values
  (:'co', 'c1050000-0000-0000-0000-000000000004', 'shop', now(), '{"lat": 40.1, "lng": -75.1}') returning id as gus_off \gset
commit;
begin;
set local role service_role;
select t1050.check((select out_place is null from public.time_entries where id = :'gus_other') and (select in_place is null from public.time_entries where id = :'gus_off'),
  'a company that switched it off keeps none, whatever a phone sends');
commit;

\echo 'All clock place tests passed.'
