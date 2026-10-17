-- Database tests for multi-day visits and equipment booked on visits.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t13;
grant usage on schema t13 to authenticated, service_role;
create function t13.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t13.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t13 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('ad000000-0000-0000-0000-000000000001', 'owner@mike.test', '{"full_name": "Mia Owner"}'),
  ('ad000000-0000-0000-0000-000000000002', 'lead@mike.test', '{"full_name": "Lev Lead"}'),
  ('ad000000-0000-0000-0000-000000000003', 'nia@mike.test', '{"full_name": "Nia Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ad000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Mike Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'ad000000-0000-0000-0000-000000000002', 'crew_lead'),
  (:'co', 'ad000000-0000-0000-0000-000000000003', 'field_crew');
update public.company_roles set permissions = '{equipment}' where company_id = :'co' and name = 'Foreman';
update public.memberships set role_id = (select id from public.company_roles where company_id = :'co' and name = 'Foreman') where user_id = 'ad000000-0000-0000-0000-000000000002';
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Paving', 'ad000000-0000-0000-0000-000000000002') returning id as crew_a \gset
insert into public.crews (company_id, name) values (:'co', 'Sealcoat') returning id as crew_b \gset
insert into public.equipment (company_id, name, kind) values (:'co', 'Paver', 'machine') returning id as paver \gset
insert into public.visits (company_id, title, kind, crew_id, starts_at, ends_at, series_id, series_day, series_total)
  values (:'co', 'Church lot', 'task', :'crew_a', '2030-05-06 11:00+00', '2030-05-06 20:00+00', 'ad100000-0000-0000-0000-000000000001', 1, 2),
         (:'co', 'Church lot', 'task', :'crew_a', '2030-05-07 11:00+00', '2030-05-07 20:00+00', 'ad100000-0000-0000-0000-000000000001', 2, 2);
select id as day1 from public.visits where series_id = 'ad100000-0000-0000-0000-000000000001' and series_day = 1 \gset
insert into public.visits (company_id, title, kind, crew_id, starts_at, ends_at) values (:'co', 'Sealcoat lot', 'task', :'crew_b', '2030-05-06 15:00+00', '2030-05-06 18:00+00') returning id as other \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'day1', 'ad000000-0000-0000-0000-000000000003');
select t13.expect_error(format('insert into public.visits (company_id, title, scheduled_on, series_id, series_day) values (%L, %L, current_date, gen_random_uuid(), 1)', :'co', 'Half a series'), 'a series visit says which day of how many');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ad000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.visit_equipment (company_id, visit_id, equipment_id) values (:'co', :'day1', :'paver');
select t13.check((select count(*) from public.visit_equipment where visit_id = :'day1') = 1, 'the foreman books the paver on their crew''s visit');
select t13.expect_error(format('insert into public.visit_equipment (company_id, visit_id, equipment_id) values (%L, %L, %L)', :'co', :'other', :'paver'), 'but not on another crew''s');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ad000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t13.check((select count(*) from public.equipment_conflicts(:'co', array[:'paver']::uuid[], '2030-05-06', '2030-05-06 14:00+00', '2030-05-06 16:00+00', :'other')) = 1, 'booking the paver over an overlapping visit finds the clash');
select t13.check((select count(*) from public.equipment_conflicts(:'co', array[:'paver']::uuid[], '2030-05-06', '2030-05-06 21:00+00', '2030-05-06 22:00+00', :'other')) = 0, 'a later slot that day is free');
select t13.check((select count(*) from public.equipment_conflicts(:'co', array[:'paver']::uuid[], '2030-05-06', '2030-05-06 14:00+00', '2030-05-06 16:00+00', :'day1')) = 0, 'a visit doesn''t clash with itself');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ad000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t13.check((select count(*) from public.visit_equipment) = 1, 'the crew on the visit sees what to bring');
delete from public.visit_equipment where visit_id = :'day1';
commit;
select t13.check((select count(*) from public.visit_equipment) = 1, 'and can''t take it off');

\echo 'All booking tests passed.'
