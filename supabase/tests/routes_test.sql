-- Database tests for routes: the office and a crew lead set their crew's stop order and fixed
-- times; a field crew member sees the route but can't change it; public.routes follows the same
-- rules. Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_routes;
grant usage on schema t_routes to authenticated, service_role;
create function t_routes.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_routes.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t_routes to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c7a00000-0000-0000-0000-000000000001', 'owner@routes.test', '{"full_name": "Rae Owner"}'),
  ('c7a00000-0000-0000-0000-000000000002', 'lead@routes.test', '{"full_name": "Lee Lead"}'),
  ('c7a00000-0000-0000-0000-000000000003', 'mower@routes.test', '{"full_name": "Moe Mower"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a00000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Green Routes Lawn', 'lawn_care') as co \gset
select id as foreman_role from public.company_roles where company_id = :'co' and name = 'Foreman' \gset
select id as employee_role from public.company_roles where company_id = :'co' and name = 'Employee' \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'c7a00000-0000-0000-0000-000000000002', 'crew_lead', :'foreman_role'),
  (:'co', 'c7a00000-0000-0000-0000-000000000003', 'field_crew', :'employee_role');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Mowing A', 'c7a00000-0000-0000-0000-000000000002') returning id as crew_a \gset
insert into public.crews (company_id, name) values (:'co', 'Mowing B') returning id as crew_b \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew_a', 'c7a00000-0000-0000-0000-000000000003');
insert into public.visits (company_id, title, kind, crew_id, scheduled_on) values (:'co', 'Mow 12 Oak', 'task', :'crew_a', current_date + 1) returning id as stop_a \gset
insert into public.visits (company_id, title, kind, crew_id, scheduled_on) values (:'co', 'Mow 4 Elm', 'task', :'crew_b', current_date + 1) returning id as stop_b \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'stop_a', 'c7a00000-0000-0000-0000-000000000003');
update public.visits set route_order = 2, time_fixed = true where id = :'stop_a';
select t_routes.check((select route_order = 2 and time_fixed from public.visits where id = :'stop_a'), 'the office sets a stop number and a fixed time');
insert into public.routes (company_id, crew_id, route_date, by_hand) values (:'co', :'crew_b', current_date + 1, true);
insert into public.routes (company_id, crew_id, route_date) values (:'co', null, current_date + 1);
select t_routes.expect_error(format('insert into public.routes (company_id, crew_id, route_date) values (%L, null, current_date + 1)', :'co'), 'one route per crew and day, including the visits with no crew');
select t_routes.check((select count(*) from public.jobs where company_id = :'co' and visit_time_fixed) = 0, 'recurring jobs don''t fix their visits'' times unless asked');
commit;

-- ===== A crew lead runs their own crew's route ================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a00000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.visits set route_order = 1 where id = :'stop_a';
select t_routes.check((select route_order = 1 from public.visits where id = :'stop_a'), 'the crew lead reorders their crew''s route');
insert into public.routes (company_id, crew_id, route_date) values (:'co', :'crew_a', current_date + 1);
select t_routes.check((select count(*) from public.routes where crew_id = :'crew_a') = 1, 'and marks their crew''s day organized');
select t_routes.expect_error(format('update public.visits set route_order = 5 where id = %L', :'stop_b'), 'but not another crew''s stops');
select t_routes.expect_error(format('insert into public.routes (company_id, crew_id, route_date) values (%L, %L, current_date + 2)', :'co', :'crew_b'), 'or another crew''s route');
update public.routes set by_hand = false where crew_id = :'crew_b';
select t_routes.check((select by_hand from public.routes where crew_id = :'crew_b'), 'and can''t change another crew''s route');
commit;

-- ===== A field crew member sees the route but doesn't change it ===============================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a00000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t_routes.check((select route_order = 1 from public.visits where id = :'stop_a'), 'the mower sees their stop number');
select t_routes.expect_error(format('update public.visits set route_order = 3 where id = %L', :'stop_a'), 'the mower can''t reorder the route');
select t_routes.expect_error(format('update public.visits set time_fixed = false where id = %L', :'stop_a'), 'or unfix a time');
update public.visits set status = 'en_route' where id = :'stop_a';
select t_routes.check((select status = 'en_route' from public.visits where id = :'stop_a'), 'but still taps On my way');
select t_routes.check((select count(*) from public.routes where company_id = :'co') = 3, 'and sees which days are organized');
select t_routes.expect_error(format('insert into public.routes (company_id, crew_id, route_date) values (%L, %L, current_date + 3)', :'co', :'crew_a'), 'but doesn''t organize days');
commit;

\o
\echo 'All route tests passed.'
