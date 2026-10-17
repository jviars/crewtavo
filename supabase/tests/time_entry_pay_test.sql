-- Database tests for pay rates on time entries (20261018000700_time_entry_pay_privacy.sql): crew
-- leads and field crew read the time they see but never the rate it's paid at, adding and editing
-- time still work, and approving still records the person's rate for the server to read.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t20;
grant usage on schema t20 to authenticated, service_role;
create function t20.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t20.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t20 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e7000000-0000-0000-0000-000000000001', 'owner@sierra.test', '{"full_name": "Sid Owner"}'),
  ('e7000000-0000-0000-0000-000000000002', 'lead@sierra.test', '{"full_name": "Fran Foreman"}'),
  ('e7000000-0000-0000-0000-000000000003', 'emma@sierra.test', '{"full_name": "Emma Employee"}');

-- An owner, a Foreman running the Mowing crew, and Emma on that crew, each with a pay rate.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Sierra Lawn', 'general') as co \gset
select id as foreman_role from public.company_roles where company_id = :'co' and name = 'Foreman' \gset
select id as employee_role from public.company_roles where company_id = :'co' and name = 'Employee' \gset
insert into public.memberships (company_id, user_id, role, role_id, labor_rate) values
  (:'co', 'e7000000-0000-0000-0000-000000000002', 'crew_lead', :'foreman_role', 34),
  (:'co', 'e7000000-0000-0000-0000-000000000003', 'field_crew', :'employee_role', 22);
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Mowing', 'e7000000-0000-0000-0000-000000000002') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'e7000000-0000-0000-0000-000000000003');
insert into public.time_entries (company_id, user_id, started_at, ended_at) values
  (:'co', 'e7000000-0000-0000-0000-000000000003', now() - interval '30 hours', now() - interval '22 hours') returning id as monday \gset
insert into public.time_entries (company_id, user_id, started_at, ended_at) values
  (:'co', 'e7000000-0000-0000-0000-000000000003', now() - interval '9 hours', now() - interval '1 hour') returning id as tuesday \gset
commit;

-- ===== The owner approves time at the person's rate ============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- As the Timesheets page does (with the rate from Settings → Team), and without a rate.
update public.time_entries set approved_at = now(), approved_by = 'e7000000-0000-0000-0000-000000000001', labor_rate = 22 where id = :'monday';
update public.time_entries set approved_at = now(), approved_by = 'e7000000-0000-0000-0000-000000000001' where id = :'tuesday';
select t20.check((select count(*) from public.time_entries where approved_at is not null and company_id = :'co') = 2, 'the owner approves Emma''s time');
select t20.expect_error('select labor_rate from public.time_entries', 'not even the owner reads pay rates on time entries directly');
commit;
begin;
set local role service_role;
select t20.check((select bool_and(labor_rate = 22) from public.time_entries where id in (:'monday', :'tuesday')), 'approved time records Emma''s rate, which the server reads');
commit;

-- ===== The Foreman sees their crew's time, not what it's paid ===================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t20.expect_error('select labor_rate from public.time_entries', 'a crew lead can''t read their crew''s pay rates on time entries');
select t20.expect_error('select * from public.time_entries', 'not even with select *');
select t20.check((select count(*) from (
  select id, company_id, user_id, visit_id, job_id, category, started_at, ended_at, notes, approved_by, approved_at,
         created_at, updated_at, reminded_at, auto_stopped_at
  from public.time_entries where user_id = 'e7000000-0000-0000-0000-000000000003' and approved_at is not null) t) = 2,
  'but reads everything else about their crew''s time');
insert into public.time_entries (company_id, user_id, started_at, ended_at) values
  (:'co', 'e7000000-0000-0000-0000-000000000003', now() - interval '50 hours', now() - interval '48 hours') returning id as added \gset
update public.time_entries set notes = 'Forgot to clock in' where id = :'added';
select t20.check((select notes from public.time_entries where id = :'added') = 'Forgot to clock in', 'and still adds and fixes it');
commit;

-- ===== Field crew don't read the rate on their own time either =================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t20.expect_error('select labor_rate from public.time_entries', 'field crew can''t read the pay rate on their own time');
select t20.check((select count(*) from public.time_entries where approved_at is not null and ended_at > started_at) = 2, 'but see their own time and whether it''s approved');
insert into public.time_entries (company_id, user_id, category, started_at) values
  (:'co', 'e7000000-0000-0000-0000-000000000003', 'drive', now() - interval '20 minutes') returning id as clock \gset
update public.time_entries set ended_at = now() where id = :'clock' and ended_at is null;
select t20.check((select ended_at is not null from public.time_entries where id = :'clock'), 'and clock in and out as before');
commit;

\echo 'All time entry pay rate tests passed.'
