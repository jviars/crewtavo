-- Database tests for crew leads: a Foreman schedules and staffs their own crew's visits, sees their
-- crew's time, approves it only with the timesheets area, and crews see the scope of work without
-- prices. Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t10;
grant usage on schema t10 to authenticated, service_role;
create function t10.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t10.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t10 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a8000000-0000-0000-0000-000000000001', 'owner@india.test', '{"full_name": "Ida Owner"}'),
  ('a8000000-0000-0000-0000-000000000002', 'lead@india.test', '{"full_name": "Lou Lead"}'),
  ('a8000000-0000-0000-0000-000000000003', 'mo@india.test', '{"full_name": "Mo Member"}'),
  ('a8000000-0000-0000-0000-000000000004', 'xi@india.test', '{"full_name": "Xi Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('India Paving', 'paving') as co \gset
select t10.check((select count(*) from public.company_roles where company_id = :'co' and name = 'Office manager' and 'invoices' = any (permissions)) = 1, 'new companies get an Office manager role that sends invoices');
select id as foreman_role from public.company_roles where company_id = :'co' and name = 'Foreman' \gset
select t10.check((select permissions = array['equipment'] from public.company_roles where id = :'foreman_role'), 'the starter Foreman schedules only their own crew');
select id as employee_role from public.company_roles where company_id = :'co' and name = 'Employee' \gset
insert into public.memberships (company_id, user_id, role, role_id, labor_rate) values
  (:'co', 'a8000000-0000-0000-0000-000000000002', 'crew_lead', :'foreman_role', 34),
  (:'co', 'a8000000-0000-0000-0000-000000000003', 'field_crew', :'employee_role', 22),
  (:'co', 'a8000000-0000-0000-0000-000000000004', 'field_crew', :'employee_role', 23);
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Paving', 'a8000000-0000-0000-0000-000000000002') returning id as crew_a \gset
insert into public.crews (company_id, name) values (:'co', 'Sealcoat') returning id as crew_b \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew_a', 'a8000000-0000-0000-0000-000000000003'), (:'co', :'crew_b', 'a8000000-0000-0000-0000-000000000004');
insert into public.clients (company_id, display_name) values (:'co', 'Elm St Church') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Church lot') returning id as job \gset
insert into public.job_line_items (company_id, job_id, name, description, quantity, unit, unit_price) values
  (:'co', :'job', 'Mill and overlay', '2" surface course', 1800, 'sq yd', 14),
  (:'co', :'job', 'Discount', null, 1, 'ea', -500);
insert into public.visits (company_id, job_id, title, crew_id, starts_at, ends_at) values (:'co', :'job', 'Paving day', :'crew_a', now() + interval '1 day', now() + interval '1 day 8 hours') returning id as visit_a \gset
insert into public.visits (company_id, job_id, title, crew_id, starts_at, ends_at) values (:'co', :'job', 'Sealcoat day', :'crew_b', now() + interval '2 days', now() + interval '2 days 6 hours') returning id as visit_b \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit_a', 'a8000000-0000-0000-0000-000000000003'), (:'co', :'visit_b', 'a8000000-0000-0000-0000-000000000004');
insert into public.time_entries (company_id, user_id, started_at, ended_at) values
  (:'co', 'a8000000-0000-0000-0000-000000000003', now() - interval '9 hours', now() - interval '1 hour'),
  (:'co', 'a8000000-0000-0000-0000-000000000004', now() - interval '9 hours', now() - interval '1 hour'),
  (:'co', 'a8000000-0000-0000-0000-000000000002', now() - interval '9 hours', now() - interval '1 hour');
commit;

-- ===== The foreman runs their own crew ========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t10.check((select count(*) from public.visits where company_id = :'co') = 2, 'the foreman still sees the whole schedule');
update public.visits set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = :'visit_a';
select t10.check((select starts_at > now() + interval '1 day 12 hours' from public.visits where id = :'visit_a'), 'the foreman moves their crew''s visit');
select t10.expect_error(format('update public.visits set starts_at = starts_at + interval ''1 day'' where id = %L', :'visit_b'), 'but not another crew''s');
select t10.expect_error(format('update public.visits set crew_id = %L where id = %L', :'crew_b', :'visit_a'), 'or hand their visit to another crew');
insert into public.visits (company_id, title, kind, crew_id, scheduled_on) values (:'co', 'Pick up cones', 'task', :'crew_a', current_date + 1) returning id as task \gset
select t10.check(:'task' is not null, 'the foreman adds a task for their crew');
select t10.expect_error(format('insert into public.visits (company_id, title, kind, crew_id, scheduled_on) values (%L, %L, %L, %L, current_date)', :'co', 'Nope', 'task', :'crew_b'), 'but not for another crew');
select t10.expect_error(format('insert into public.visits (company_id, title, kind, scheduled_on) values (%L, %L, %L, current_date)', :'co', 'No crew', 'task'), 'or a task with no crew');
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'task', 'a8000000-0000-0000-0000-000000000003');
select t10.check((select count(*) from public.visit_assignees where visit_id = :'task') = 1, 'the foreman assigns someone on their crew');
select t10.expect_error(format('insert into public.visit_assignees (company_id, visit_id, user_id) values (%L, %L, %L)', :'co', :'task', 'a8000000-0000-0000-0000-000000000004'), 'but not someone from another crew');
select t10.expect_error(format('insert into public.visit_assignees (company_id, visit_id, user_id) values (%L, %L, %L)', :'co', :'task', 'a8000000-0000-0000-0000-000000000001'), 'or the owner');
delete from public.visit_assignees where visit_id = :'visit_b';
select t10.check((select count(*) from public.visit_assignees where visit_id = :'visit_b') = 1, 'and can''t take people off another crew''s visit');
delete from public.visits where id = :'visit_b';
select t10.check((select count(*) from public.visits where id = :'visit_b') = 1, 'or delete it');

select t10.check((select count(*) from public.time_entries where company_id = :'co') = 2, 'the foreman sees their own and their crew''s time, not other crews''');
insert into public.time_entries (company_id, user_id, started_at, ended_at) values (:'co', 'a8000000-0000-0000-0000-000000000003', now() - interval '20 hours', now() - interval '19 hours');
select t10.expect_error(format('insert into public.time_entries (company_id, user_id, started_at) values (%L, %L, now())', :'co', 'a8000000-0000-0000-0000-000000000004'), 'the foreman can''t log time for another crew');
select t10.expect_error(format('update public.time_entries set approved_at = now() where user_id = %L', 'a8000000-0000-0000-0000-000000000003'), 'without the timesheets area, the foreman can''t approve time');
select t10.check((select count(*) from public.job_line_items where job_id = :'job') = 0, 'the foreman sees no line item prices');
select t10.check((select count(*) from public.job_scope(:'job')) = 1, 'but sees the scope of work, without the discount line');
commit;

-- ===== With the timesheets area, the foreman approves their crew's time (not their own) ========
update public.company_roles set permissions = array['timesheets', 'equipment'] where id = :'foreman_role';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.time_entries set approved_at = now(), labor_rate = null where user_id = 'a8000000-0000-0000-0000-000000000003';
commit;
select t10.check((select bool_and(approved_at is not null and labor_rate = 22) from public.time_entries where user_id = 'a8000000-0000-0000-0000-000000000003'), 'the foreman approves crew time and the pay rate is filled in');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t10.expect_error(format('update public.time_entries set approved_at = now() where user_id = %L', 'a8000000-0000-0000-0000-000000000002'), 'the foreman can''t approve their own time');
commit;

-- ===== With "Schedule the whole team", any crew ===============================================
update public.company_roles set permissions = array['schedule', 'equipment'] where id = :'foreman_role';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.visits set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = :'visit_b';
select t10.check((select starts_at > now() + interval '2 days 12 hours' from public.visits where id = :'visit_b'), 'with the whole-team area, the foreman moves any crew''s visit');
commit;

-- ===== Crew members see what to do, not what it costs ========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t10.check((select string_agg(name || ' ' || quantity::text || ' ' || unit, ', ') from public.job_scope(:'job')) = 'Mill and overlay 1800.000 sq yd', 'crew on the job see its scope of work');
select t10.expect_error(format('insert into public.visits (company_id, title, crew_id, scheduled_on) values (%L, %L, %L, current_date)', :'co', 'Self-scheduled', :'crew_a'), 'crew members can''t add visits');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
delete from public.visit_assignees where visit_id = :'visit_b';
commit;
-- (Xi can't remove assignments; the row is still there for the owner's check below.)
select t10.check((select count(*) from public.visit_assignees where visit_id = :'visit_b') = 1, 'crew members can''t unassign people');

\echo 'All crew lead tests passed.'
