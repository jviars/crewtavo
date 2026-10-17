-- Database tests for equipment: who can change what, readings and service keeping schedules
-- current, costs staying private, and maintenance alerts going out once.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t7;
grant usage on schema t7 to authenticated, service_role;
create function t7.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t7.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t7 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a7000000-0000-0000-0000-000000000001', 'owner@hotel.test', '{"full_name": "Hal Owner"}'),
  ('a7000000-0000-0000-0000-000000000002', 'crew@hotel.test', '{"full_name": "Cora Crew"}'),
  ('a7000000-0000-0000-0000-000000000003', 'lead@hotel.test', '{"full_name": "Lee Lead"}'),
  ('a7000000-0000-0000-0000-000000000004', 'lite@hotel.test', '{"full_name": "Lita Lead"}'),
  ('a7000000-0000-0000-0000-000000000005', 'other@india.test', '{"full_name": "Ida Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Hotel Hardscapes', 'landscaping') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'a7000000-0000-0000-0000-000000000002', 'field_crew'),
  (:'co', 'a7000000-0000-0000-0000-000000000003', 'crew_lead');
-- A crew lead whose role leaves equipment off.
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Lead, no equipment', 'crew_lead', '{schedule}') returning id as lite_role \gset
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', 'a7000000-0000-0000-0000-000000000004', 'crew_lead', :'lite_role');
insert into public.crews (company_id, name) values (:'co', 'Crew A') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'a7000000-0000-0000-0000-000000000003');
insert into public.equipment (company_id, name, kind, meter, meter_reading, crew_id) values (:'co', 'Mower 1', 'mower', 'hours', 100, :'crew') returning id as mower \gset
insert into public.equipment_plans (company_id, equipment_id, name, every_meter) values (:'co', :'mower', 'Oil change', 50) returning id as oil \gset
insert into public.equipment_financials (company_id, equipment_id, purchase_price) values (:'co', :'mower', 12000);
select t7.check((select baseline_meter from public.equipment_plans where id = :'oil') = 100, 'a new schedule counts from the current reading');
select t7.check((select next_due_meter = 150 and state = 'ok' from public.equipment_due where plan_id = :'oil'), 'and comes due 50 hours later');
select t7.check((select meter_read_on is not null from public.equipment where id = :'mower'), 'the starting reading is dated');
select t7.check((select count(*) from public.company_roles where company_id = :'co' and 'equipment' = any (permissions)) = 4, 'starter roles that manage things include equipment');
commit;

-- Field crew: see equipment and log work, but can't change the list or see what it cost.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a7000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t7.check((select count(*) from public.equipment where company_id = :'co') = 1, 'crew see the equipment');
select t7.expect_error(format('insert into public.equipment (company_id, name) values (%L, %L)', :'co', 'Sneaky truck'), 'crew can''t add equipment');
update public.equipment set name = 'Renamed' where id = :'mower';
select t7.check((select name from public.equipment where id = :'mower') = 'Mower 1', 'or rename it');
select t7.check((select count(*) from public.equipment_financials) = 0, 'or see what it cost');
select t7.expect_error(format('update public.equipment_plans set last_done_meter = 999 where id = %L', :'oil'), 'or fake when it was serviced');
insert into public.equipment_logs (company_id, equipment_id, kind, meter_reading) values (:'co', :'mower', 'reading', 160);
select t7.check((select meter_reading from public.equipment where id = :'mower') = 160, 'a logged reading updates the meter');
select t7.check((select state from public.equipment_due where plan_id = :'oil') = 'overdue', 'which makes the oil change overdue');
insert into public.equipment_logs (company_id, equipment_id, kind, plan_id, title) values (:'co', :'mower', 'service', :'oil', 'Oil change') returning id as service \gset
select t7.check((select last_done_meter from public.equipment_plans where id = :'oil') = 160, 'marking it done uses the current reading');
select t7.check((select next_due_meter = 210 and state = 'ok' from public.equipment_due where plan_id = :'oil'), 'and the next one is 50 hours on');
select t7.expect_error(format('insert into public.equipment_logs (company_id, equipment_id, kind, user_id) values (%L, %L, %L, %L)', :'co', :'mower', 'note', 'a7000000-0000-0000-0000-000000000001'), 'crew can''t log as someone else');
commit;

-- Undo: deleting the service puts the schedule back.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a7000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
delete from public.equipment_logs where id = :'service';
select t7.check((select last_done_meter from public.equipment_plans where id = :'oil') = 100, 'deleting the service log restores the last time it was done');
select t7.check((select state from public.equipment_due where plan_id = :'oil') = 'overdue', 'so it''s overdue again');
commit;

-- A typo'd reading fixed by deleting it puts the meter back.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.equipment_logs (company_id, equipment_id, kind, meter_reading) values (:'co', :'mower', 'reading', 1600) returning id as typo \gset
select t7.check((select meter_reading from public.equipment where id = :'mower') = 1600, 'a mistyped reading shows');
delete from public.equipment_logs where id = :'typo';
select t7.check((select meter_reading from public.equipment where id = :'mower') = 160, 'and deleting it brings back the last good one');
commit;

-- Crew leads manage equipment unless their role leaves it off.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.equipment (company_id, name, kind, meter) values (:'co', 'Trailer', 'trailer', 'none');
select t7.check((select count(*) from public.equipment where company_id = :'co') = 2, 'a crew lead can add equipment');
select set_config('request.jwt.claims', '{"sub": "a7000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t7.expect_error(format('insert into public.equipment (company_id, name) values (%L, %L)', :'co', 'Nope'), 'a crew lead whose role leaves equipment off can''t');
select t7.expect_error(format('insert into public.equipment_logs (company_id, equipment_id, kind, plan_id) values (%L, (select id from public.equipment where name = %L), %L, %L)', :'co', 'Trailer', 'service', :'oil'), 'a service can''t complete another machine''s schedule');
commit;

-- Another company sees nothing.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a7000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select public.create_company('India Irrigation', 'landscaping') as other \gset
select t7.check((select count(*) from public.equipment) = 0 and (select count(*) from public.equipment_due) = 0, 'other companies can''t see the equipment');
select t7.expect_error(format('insert into public.equipment_logs (company_id, equipment_id, kind, meter_reading) values (%L, %L, %L, 1)', :'other', :'mower', 'reading'), 'or log against it');
commit;

-- Alerts: once per change, to the people who look after equipment.
select public.emit_equipment_alerts() as sent \gset
select t7.check(:'sent'::int = 1, 'an overdue schedule sends one alert');
select t7.check((select count(*) from public.notifications where kind = 'equipment' and user_id = 'a7000000-0000-0000-0000-000000000001') = 1, 'the owner is told');
select t7.check((select count(*) from public.notifications where kind = 'equipment' and user_id = 'a7000000-0000-0000-0000-000000000003') = 1, 'so is the lead of the crew that has it');
select t7.check((select count(*) from public.notifications where kind = 'equipment' and user_id in ('a7000000-0000-0000-0000-000000000002', 'a7000000-0000-0000-0000-000000000004')) = 0, 'but not people who don''t manage equipment');
select t7.check((select body from public.notifications where kind = 'equipment' limit 1) = 'Due at 150 hours (now 160)', 'the alert says when it was due');
select public.emit_equipment_alerts() as again \gset
select t7.check(:'again'::int = 0, 'running again sends nothing new');
set role authenticated;
select set_config('request.jwt.claims', '{"sub": "a7000000-0000-0000-0000-000000000001", "role": "authenticated"}', false);
select t7.expect_error('select public.emit_equipment_alerts()', 'people can''t trigger alerts themselves');
reset role;

\echo 'All equipment tests passed.'
