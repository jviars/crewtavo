-- Database tests for a job's state (20261103000400_job_states): an active job is late, today, upcoming
-- or unscheduled from its visits on the company's own today; other jobs keep their status; and nobody
-- sees another company's jobs through it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tjs;
grant usage on schema tjs to authenticated, service_role;
create function tjs.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tjs to authenticated, service_role;

-- Everything below is rolled back at the end.
begin;
-- Kai's business is on Kiritimati (UTC+14), Nia's on Niue (UTC-11): 25 hours apart, so Kiritimati's
-- today is always after Niue's, whatever time the tests run. Cy is on Kai's crew.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ab4e0000-0000-0000-0000-000000000001', 'kai@kiri-lawn.test', '{"full_name": "Kai Kiri"}'),
  ('ab4e0000-0000-0000-0000-000000000002', 'nia@niue-lawn.test', '{"full_name": "Nia Niue"}'),
  ('ab4e0000-0000-0000-0000-000000000003', 'cy@kiri-lawn.test', '{"full_name": "Cy Crew"}');
select (now() at time zone 'Pacific/Kiritimati')::date as kday, (now() at time zone 'Pacific/Niue')::date as nday \gset

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab4e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Kiri Job States Lawn', 'general', 'Pacific/Kiritimati') as kiri \gset
select set_config('request.jwt.claims', '{"sub": "ab4e0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.create_company('Niue Job States Lawn', 'general', 'Pacific/Niue') as niue \gset

set local role service_role;
insert into public.memberships (company_id, user_id, role) values (:'kiri', 'ab4e0000-0000-0000-0000-000000000003', 'field_crew');
insert into public.clients (company_id, status, display_name) values (:'kiri', 'active', 'Kiri Job States Client') returning id as kc \gset
insert into public.clients (company_id, status, display_name) values (:'niue', 'active', 'Niue Job States Client') returning id as nc \gset
insert into public.jobs (company_id, client_id, title) values (:'kiri', :'kc', 'Late and today') returning id as late_today \gset
insert into public.jobs (company_id, client_id, title) values (:'kiri', :'kc', 'Started two days ago') returning id as late_started \gset
insert into public.jobs (company_id, client_id, title) values (:'kiri', :'kc', 'Today') returning id as today \gset
insert into public.jobs (company_id, client_id, title) values (:'kiri', :'kc', 'Just after midnight') returning id as midnight \gset
insert into public.jobs (company_id, client_id, title) values (:'kiri', :'kc', 'Upcoming') returning id as upcoming \gset
insert into public.jobs (company_id, client_id, title) values (:'kiri', :'kc', 'Done today') returning id as done_today \gset
insert into public.jobs (company_id, client_id, title) values (:'kiri', :'kc', 'Waiting on a date') returning id as undated \gset
insert into public.jobs (company_id, client_id, title) values (:'kiri', :'kc', 'No visits') returning id as bare \gset
insert into public.jobs (company_id, client_id, title, status) values (:'kiri', :'kc', 'To invoice', 'requires_invoicing') returning id as to_invoice \gset
insert into public.jobs (company_id, client_id, title, status) values (:'kiri', :'kc', 'Put away', 'archived') returning id as put_away \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on) values
  (:'kiri', :'kc', 'Weekly, missed one', 'recurring', 'FREQ=WEEKLY;INTERVAL=1', :'kday'::date - 7) returning id as weekly_late \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on) values
  (:'kiri', :'kc', 'Weekly, all done', 'recurring', 'FREQ=WEEKLY;INTERVAL=1', :'kday'::date - 7) returning id as weekly_ahead \gset
insert into public.jobs (company_id, client_id, title) values (:'niue', :'nc', 'Niue today') returning id as niue_today \gset
insert into public.jobs (company_id, client_id, title) values (:'niue', :'nc', 'Niue on Kiritimati''s today') returning id as niue_ahead \gset

insert into public.visits (company_id, job_id, title, status, scheduled_on) values
  (:'kiri', :'late_today', 'Missed', 'scheduled', :'kday'::date - 1),
  (:'kiri', :'late_today', 'Today', 'scheduled', :'kday'),
  (:'kiri', :'late_started', 'Never finished', 'in_progress', :'kday'::date - 2),
  (:'kiri', :'today', 'Yesterday', 'completed', :'kday'::date - 1),
  (:'kiri', :'today', 'Today', 'en_route', :'kday'),
  (:'kiri', :'today', 'Tomorrow', 'scheduled', :'kday'::date + 1),
  (:'kiri', :'upcoming', 'Called off', 'cancelled', :'kday'::date - 1),
  (:'kiri', :'upcoming', 'Next week', 'scheduled', :'kday'::date + 7),
  (:'kiri', :'done_today', 'Today', 'completed', :'kday'),
  (:'kiri', :'to_invoice', 'Missed', 'scheduled', :'kday'::date - 1),
  (:'kiri', :'put_away', 'Next week', 'scheduled', :'kday'::date + 7),
  (:'kiri', :'weekly_late', 'Last week', 'scheduled', :'kday'::date - 7),
  (:'kiri', :'weekly_late', 'Next week', 'scheduled', :'kday'::date + 7),
  (:'kiri', :'weekly_ahead', 'Last week', 'completed', :'kday'::date - 7),
  (:'kiri', :'weekly_ahead', 'Next week', 'scheduled', :'kday'::date + 7),
  (:'niue', :'niue_today', 'Today', 'scheduled', :'nday'),
  (:'niue', :'niue_ahead', 'Kiritimati''s today', 'scheduled', :'kday');
insert into public.visits (company_id, job_id, title, status) values (:'kiri', :'undated', 'Some time', 'unscheduled');
-- 00:30 on Kiritimati is still the day before in UTC: the visit's day is the company's.
insert into public.visits (company_id, job_id, title, status, starts_at) values
  (:'kiri', :'midnight', 'Early start', 'scheduled', (:'kday'::date + time '00:30') at time zone 'Pacific/Kiritimati');

-- ===== Each state, as Kai sees it ===============================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab4e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
create temp table tjs_states on commit drop as select j.title, public.job_state(j) as state from public.jobs j where j.company_id = :'kiri';
select tjs.check((select state from tjs_states where title = 'Late and today') = 'late', 'a visit before today that isn''t done makes the job late, even with one today');
select tjs.check((select state from tjs_states where title = 'Started two days ago') = 'late', 'a visit started and never finished is late');
select tjs.check((select state from tjs_states where title = 'Today') = 'today', 'a visit today that isn''t done: today (a done one before it doesn''t count)');
select tjs.check((select state from tjs_states where title = 'Upcoming') = 'upcoming', 'a visit after today: upcoming (a cancelled one before it doesn''t count)');
select tjs.check((select state from tjs_states where title = 'Done today') = 'unscheduled', 'today''s visit done and nothing ahead: unscheduled');
select tjs.check((select state from tjs_states where title = 'Waiting on a date') = 'unscheduled', 'a visit with no date yet: unscheduled');
select tjs.check((select state from tjs_states where title = 'No visits') = 'unscheduled', 'no visits at all: unscheduled');
select tjs.check((select state from tjs_states where title = 'To invoice') = 'requires_invoicing', 'a job to invoice keeps its status, late visit or not');
select tjs.check((select state from tjs_states where title = 'Put away') = 'archived', 'an archived job keeps its status');
select tjs.check((select state from tjs_states where title = 'Weekly, missed one') = 'late', 'a recurring job with a missed visit is late');
select tjs.check((select state from tjs_states where title = 'Weekly, all done') = 'upcoming', 'a recurring job caught up is upcoming');
select tjs.check((select count(*) from public.jobs j where j.company_id = :'kiri' and public.job_state(j) = 'late') = 3, 'lists can count jobs by their state');
select tjs.check((select jobs from public.job_state_counts(:'kiri') where state = 'late') = 3
  and (select sum(jobs) from public.job_state_counts(:'kiri')) = (select count(*) from public.jobs where company_id = :'kiri'),
  'the Jobs list''s tab counts come in one go, the same (20261107000700)');

-- ===== The company's today, not UTC's ===========================================================
select tjs.check((select state from tjs_states where title = 'Just after midnight') = 'today', 'a visit at 00:30 today is today, though UTC is still on yesterday');
select set_config('request.jwt.claims', '{"sub": "ab4e0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tjs.check((select public.job_state(j) from public.jobs j where j.id = :'niue_today') = 'today', 'Niue''s today is today on Niue');
select tjs.check((select public.job_state(j) from public.jobs j where j.id = :'niue_ahead') = 'upcoming', 'and Kiritimati''s today is still ahead there');

-- ===== Nobody else's jobs =======================================================================
select tjs.check(not exists (select 1 from public.jobs j where j.company_id = :'kiri' or public.job_state(j) = 'late'), 'Nia sees none of Kai''s jobs, by company or by state');
select tjs.check((select count(*) from public.jobs j where public.job_state(j) is not null) = 2, 'only her own two');
select tjs.check(not exists (select 1 from public.job_state_counts(:'kiri')), 'and none of Kai''s jobs are counted for her');
select set_config('request.jwt.claims', '{"sub": "ab4e0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tjs.check(not exists (select 1 from public.jobs j where public.job_state(j) is not null), 'crew on no visits see no jobs, as with jobs themselves');
rollback;

\echo 'All job state tests passed.'
