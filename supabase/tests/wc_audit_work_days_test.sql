-- Database tests for the workers' comp audit's work days (20261025008001_wc_audit_work_days.sql): a
-- completed visit counts on the earlier of the day it was scheduled for and the day it was completed,
-- in company time. Work finished early counts on the day it was done; Complete tapped the next morning
-- still counts on the day worked; a timed visit with only a start time counts on its start's day.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1130;
grant usage on schema t1130 to authenticated, service_role;
create function t1130.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema t1130 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d1130000-0000-0000-0000-000000000001', 'owner@workdays.test', '{"full_name": "Wanda Owner"}');

-- Wanda's business keeps New York time. Her sub, Elm Roofing, did three visits on one job:
-- "Done early" was booked for June 10 and finished June 8; "Tapped late" was worked June 1 and
-- marked complete the next morning; "Timed" has only a start time (9 AM June 15) and was finished
-- that day.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1130000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Work Days Roofing', 'general', 'America/New_York') as co \gset
insert into public.subcontractors (company_id, name) values (:'co', 'Elm Roofing') returning id as elm \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Client') returning id as client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '2 Elm St') returning id as prop \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Elm roof') returning id as job \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'job', :'prop', 'Done early', '2026-06-10') returning id as early \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'job', :'prop', 'Tapped late', '2026-06-01') returning id as late \gset
insert into public.visits (company_id, job_id, property_id, title, starts_at) values (:'co', :'job', :'prop', 'Timed', '2026-06-15T13:00:00Z') returning id as timed \gset
select public.job_pay_start(:'job', :'elm', null, array[:'early', :'late', :'timed']::uuid[]) as pay \gset
delete from public.job_pay_lines where job_pay_id = :'pay';
insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) values (:'co', :'pay', 'Agreed price', 1, 3000);
select public.job_pay_accept(:'pay');
-- 15:00 UTC on June 8 is 11 AM in New York; 03:30 UTC on June 2 is 11:30 PM on June 1 there, and
-- 13:00 UTC is 9 AM on June 2; 16:00 UTC on June 15 is noon.
update public.visits set status = 'completed', completed_at = '2026-06-08T15:00:00Z' where id = :'early';
update public.visits set status = 'completed', completed_at = '2026-06-02T13:00:00Z' where id = :'late';
update public.visits set status = 'completed', completed_at = '2026-06-15T16:00:00Z' where id = :'timed';
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1130000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t1130.check((select work_dates from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31') where job_title = 'Elm roof')
    = '{2026-06-01,2026-06-08,2026-06-15}'::date[],
  'each visit counts on the earlier of its scheduled day and the day it was completed, and a timed visit on its start''s day');
select t1130.check((select work_dates from public.sub_wc_audit(:'co', '2026-01-01', '2026-06-09') where job_title = 'Elm roof')
    = '{2026-06-01,2026-06-08}'::date[],
  'a report ending before the booked day still shows work finished early');
select t1130.check(not exists (select 1 from public.sub_wc_audit(:'co', '2026-06-02', '2026-06-07')),
  'Complete tapped the next morning doesn''t move the work to that morning');
commit;

-- Complete tapped late at night counts on the company's day, not UTC's.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1130000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.visits set starts_at = '2026-06-16T02:00:00Z', completed_at = '2026-06-16T03:30:00Z' where id = :'timed';
select t1130.check((select work_dates from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31') where job_title = 'Elm roof')
    = '{2026-06-01,2026-06-08,2026-06-15}'::date[],
  'a visit started at 10 PM and completed at 11:30 PM company time (already the next day in UTC) stays on that day');
rollback;

\o
\echo 'All workers'' comp work day tests passed.'
