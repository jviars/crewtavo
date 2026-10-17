-- Database tests for recurring jobs: a generated visit a person deletes is remembered so the
-- recurrence task doesn't put it back, the API's own clean-up isn't, and only the business sees it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t24;
grant usage on schema t24 to authenticated, service_role;
create function t24.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t24.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t24 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b7000000-0000-0000-0000-000000000001', 'owner@quebec.test', '{"full_name": "Quinn Owner"}'),
  ('b7000000-0000-0000-0000-000000000002', 'crew@quebec.test', '{"full_name": "Cal Crew"}'),
  ('b7000000-0000-0000-0000-000000000003', 'owner@romeo.test', '{"full_name": "Rae Romeo"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Quebec Lawn', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'b7000000-0000-0000-0000-000000000002', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Maple Court HOA') returning id as client \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, status)
values (:'co', :'client', 'Weekly mowing', 'recurring', 'FREQ=WEEKLY;BYDAY=TU', current_date, 'active') returning id as job \gset
commit;

-- What the recurrence task makes (it writes with the service key).
begin;
set local role service_role;
insert into public.visits (company_id, job_id, title, recurrence_key, scheduled_on) values
  (:'co', :'job', 'Weekly mowing', '2030-06-04', '2030-06-04'),
  (:'co', :'job', 'Weekly mowing', '2030-06-11', '2030-06-11'),
  (:'co', :'job', 'Weekly mowing', '2030-06-18', '2030-06-18'),
  (:'co', :'job', 'Weekly mowing', '2030-06-25', '2030-06-25');
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'job', 'Extra cleanup', '2030-06-05');
-- The API's own clean-up, when the schedule no longer has a date.
delete from public.visits where job_id = :'job' and recurrence_key = '2030-06-25';
select t24.check((select count(*) from public.recurrence_skips where job_id = :'job') = 0, 'the API removing dates the schedule dropped isn''t remembered');
commit;

-- ===== The office deletes one occurrence =====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.visits where job_id = :'job' and recurrence_key = '2030-06-11';
select t24.check((select count(*) = 1 and bool_and(company_id = :'co' and recurrence_key = '2030-06-11' and deleted_by = 'b7000000-0000-0000-0000-000000000001')
  from public.recurrence_skips where job_id = :'job'), 'deleting a generated visit remembers its date, and who deleted it');
delete from public.visits where job_id = :'job' and recurrence_key is null;
select t24.check((select count(*) from public.recurrence_skips where job_id = :'job') = 1, 'deleting a visit added by hand remembers nothing');
select t24.expect_error(format('insert into public.recurrence_skips (company_id, job_id, recurrence_key) values (%L, %L, %L)', :'co', :'job', '2030-06-18'),
  'people can''t add remembered dates directly');
select t24.expect_error(format('delete from public.recurrence_skips where job_id = %L', :'job'), 'or remove them');
commit;

-- ===== Only the business's schedulers see them ===============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t24.check((select count(*) from public.recurrence_skips) = 0, 'field crew don''t see remembered dates');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.create_company('Romeo Paving', 'paving') as other \gset
select t24.check((select count(*) from public.recurrence_skips) = 0, 'another business doesn''t see them');
commit;

-- ===== Deleting the job takes its visits and remembered dates with it ========================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.jobs where id = :'job';
select t24.check((select count(*) from public.jobs where id = :'job') = 0, 'a recurring job with generated visits can still be deleted');
commit;
select t24.check((select count(*) from public.recurrence_skips where job_id = :'job') = 0, 'and its remembered dates go with it');
select t24.check((select count(*) from public.visits where job_id = :'job') = 0, 'as do its visits');

\echo 'All recurring visit tests passed.'
