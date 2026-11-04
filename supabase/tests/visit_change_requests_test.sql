-- Database tests for clients' requests to move or cancel a visit (20261105000600_visit_change_requests):
-- only the server writes them, one waits per visit, asking tells the office and starts automations,
-- whoever may move the visit reads and answers them (status and note only), and visit_busy_times
-- gives the server times only, for the visit's crew and people.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema vcr;
grant usage on schema vcr to authenticated, service_role;
create function vcr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function vcr.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- How many rows a statement reached (an update row-level security stops reaches none).
create function vcr.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on all functions in schema vcr to authenticated, service_role;

-- Vera owns Vale Lawn, Otto is in its office, Lena leads the Front crew (with Finn on it), and Gus
-- leads the Back crew; neither lead schedules the whole team. Ed owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ac600000-0000-0000-0000-000000000001', 'vera@vale.test', '{"full_name": "Vera Vale"}'),
  ('ac600000-0000-0000-0000-000000000002', 'otto@vale.test', '{"full_name": "Otto Office"}'),
  ('ac600000-0000-0000-0000-000000000003', 'lena@vale.test', '{"full_name": "Lena Lead"}'),
  ('ac600000-0000-0000-0000-000000000004', 'finn@vale.test', '{"full_name": "Finn Field"}'),
  ('ac600000-0000-0000-0000-000000000005', 'gus@vale.test', '{"full_name": "Gus Back"}'),
  ('ac600000-0000-0000-0000-000000000009', 'ed@elsewhere.test', '{"full_name": "Ed Else"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Else Snow', 'general') as other \gset
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Vale Lawn', 'general', 'America/Chicago') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Own crew lead', 'crew_lead', '{timesheets}') returning id as own_crew \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'ac600000-0000-0000-0000-000000000002', 'office', null),
  (:'co', 'ac600000-0000-0000-0000-000000000003', 'crew_lead', :'own_crew'),
  (:'co', 'ac600000-0000-0000-0000-000000000004', 'field_crew', null),
  (:'co', 'ac600000-0000-0000-0000-000000000005', 'crew_lead', :'own_crew');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Front', 'ac600000-0000-0000-0000-000000000003') returning id as front \gset
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Back', 'ac600000-0000-0000-0000-000000000005') returning id as back \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'front', 'ac600000-0000-0000-0000-000000000004');
insert into public.clients (company_id, display_name, email) values (:'co', 'Ann Vcr', 'ann@vcr.test') returning id as ann \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bob Vcr') returning id as bob \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'ann', 'Weekly mowing') returning id as ann_job \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'bob', 'Hedges') returning id as bob_job \gset
select private.company_today(:'co') + 1 as tomorrow \gset
-- Ann's visit, on the Front crew with Finn; Bob's on the same crew; Finn on a Back crew visit; a Back
-- crew visit nobody of hers is on; and a cancelled one on the Front crew.
insert into public.visits (company_id, job_id, title, crew_id, starts_at, ends_at) values
  (:'co', :'ann_job', 'Mow', :'front', (:'tomorrow'::date + time '09:00') at time zone 'America/Chicago', (:'tomorrow'::date + time '10:00') at time zone 'America/Chicago')
  returning id as v_ann \gset
insert into public.visits (company_id, job_id, title, crew_id, starts_at, ends_at) values
  (:'co', :'bob_job', 'Trim hedges', :'front', (:'tomorrow'::date + time '13:00') at time zone 'America/Chicago', (:'tomorrow'::date + time '14:00') at time zone 'America/Chicago')
  returning id as v_bob \gset
insert into public.visits (company_id, job_id, title, crew_id, starts_at, ends_at) values
  (:'co', :'bob_job', 'Haul brush', :'back', (:'tomorrow'::date + time '11:00') at time zone 'America/Chicago', (:'tomorrow'::date + time '12:00') at time zone 'America/Chicago')
  returning id as v_finn \gset
insert into public.visits (company_id, job_id, title, crew_id, starts_at, ends_at) values
  (:'co', :'bob_job', 'Back crew only', :'back', (:'tomorrow'::date + time '15:00') at time zone 'America/Chicago', (:'tomorrow'::date + time '16:00') at time zone 'America/Chicago');
insert into public.visits (company_id, job_id, title, crew_id, status, starts_at, ends_at) values
  (:'co', :'bob_job', 'Called off', :'front', 'cancelled', (:'tomorrow'::date + time '16:00') at time zone 'America/Chicago', (:'tomorrow'::date + time '17:00') at time zone 'America/Chicago');
insert into public.visit_assignees (company_id, visit_id, user_id) values
  (:'co', :'v_ann', 'ac600000-0000-0000-0000-000000000004'), (:'co', :'v_finn', 'ac600000-0000-0000-0000-000000000004');
commit;

-- Calendars: a whole-team holiday the day after tomorrow, an event on the Back crew's calendar, and a
-- team calendar that doesn't block time.
begin;
set local role service_role;
insert into public.calendar_sources (company_id, kind, app, name, url_sealed, host) values (:'co', 'ics', 'ics_calendar', 'Holidays', 'sealed', 'example.test') returning id as holidays \gset
insert into public.calendar_sources (company_id, kind, app, name, url_sealed, host, crew_id) values (:'co', 'ics', 'ics_calendar', 'Back crew', 'sealed', 'example.test', :'back') returning id as back_cal \gset
insert into public.calendar_sources (company_id, kind, app, name, url_sealed, host, blocks_time) values (:'co', 'ics', 'ics_calendar', 'Birthdays', 'sealed', 'example.test', false) returning id as birthdays \gset
insert into public.calendar_events (company_id, source_id, key, title, all_day, starts_on, ends_on) values
  (:'co', :'holidays', 'h1', 'Closed', true, :'tomorrow'::date + 1, :'tomorrow'::date + 1),
  (:'co', :'birthdays', 'b1', 'Vera''s birthday', true, :'tomorrow'::date, :'tomorrow'::date);
insert into public.calendar_events (company_id, source_id, key, title, starts_at, ends_at, starts_on, ends_on) values
  (:'co', :'back_cal', 'k1', 'Truck service', (:'tomorrow'::date + time '07:00') at time zone 'America/Chicago', (:'tomorrow'::date + time '08:00') at time zone 'America/Chicago', :'tomorrow', :'tomorrow');
commit;

\o
\echo 'Busy times for a visit'
\o /dev/null

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select vcr.expect_error(format('select * from public.visit_busy_times(%L, %L, now(), now() + interval ''30 days'')', :'co', :'v_ann'),
  'someone signed in can''t ask for busy times, not even the owner');
rollback;
begin;
set local role service_role;
create temp table busy on commit drop as
  select * from public.visit_busy_times(:'co', :'v_ann', now(), now() + interval '30 days');
select vcr.check((select count(*) = 3 from busy), 'three busy times: the crew''s other visit, Finn''s other visit and the holiday');
select vcr.check(exists (select 1 from busy where starts_at = (:'tomorrow'::date + time '13:00') at time zone 'America/Chicago'), 'Bob''s visit on the same crew is busy, as a time only');
select vcr.check(exists (select 1 from busy where starts_at = (:'tomorrow'::date + time '11:00') at time zone 'America/Chicago'), 'Finn''s visit on another crew is busy');
select vcr.check(exists (select 1 from busy where starts_at = (:'tomorrow'::date + 1)::timestamp at time zone 'America/Chicago'
  and ends_at = (:'tomorrow'::date + 2)::timestamp at time zone 'America/Chicago'), 'the team''s holiday takes the whole day, where the company is');
select vcr.check(not exists (select 1 from busy where starts_at = (:'tomorrow'::date + time '09:00') at time zone 'America/Chicago'), 'not the visit''s own time');
commit;

\o
\echo 'Asking'
\o /dev/null

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select vcr.expect_error(format($q$insert into public.visit_change_requests (company_id, visit_id, client_id, kind) values (%L, %L, %L, 'cancel')$q$, :'co', :'v_ann', :'ann'),
  'not even the owner can write a request: only the server does');
rollback;

begin;
set local role service_role;
insert into public.visit_change_requests (company_id, visit_id, client_id, kind, starts_at, ends_at, scheduled_on)
values (:'co', :'v_ann', :'ann', 'reschedule', (:'tomorrow'::date + time '15:00') at time zone 'America/Chicago', (:'tomorrow'::date + time '16:00') at time zone 'America/Chicago', :'tomorrow')
returning id as first_ask \gset
select vcr.check((select count(*) = 1 from public.activity where company_id = :'co' and verb = 'visit.reschedule_requested' and subject_id = :'v_ann'
  and data = jsonb_build_object('request_id', :'first_ask'::uuid)), 'asking starts automations on the visit, with only which request it is');
select vcr.check((select array_agg(user_id order by user_id) from public.notifications where company_id = :'co' and kind = 'client' and title = 'Ann Vcr asked to move Mow')
  = array['ac600000-0000-0000-0000-000000000001', 'ac600000-0000-0000-0000-000000000002', 'ac600000-0000-0000-0000-000000000003']::uuid[],
  'the owner, the office and the crew''s lead are told (20261106000420), not the crew');
select vcr.check((select bool_and(link = '/schedule?date=' || :'tomorrow' || '&visit=' || :'v_ann' and body like 'Booked % Asked for %') from public.notifications
  where company_id = :'co' and kind = 'client'), 'the notice says what was asked and opens the visit');
select vcr.expect_error(format($q$insert into public.visit_change_requests (company_id, visit_id, client_id, kind, message) values (%L, %L, %L, 'reschedule', 'Any Friday')$q$, :'co', :'v_ann', :'ann'),
  'one request waits per visit');
-- A new one takes the old one's place, in the same row (routes/public.ts), so nothing waiting is lost
-- if the save fails; the office hears about it as about a new one (20261107000500).
update public.visit_change_requests set kind = 'cancel', reason = 'Moving away', starts_at = null, ends_at = null, scheduled_on = null, message = null
where visit_id = :'v_ann' and status = 'pending' returning id as ask \gset
select vcr.check((select count(*) = 1 from public.visit_change_requests where visit_id = :'v_ann') and :'ask'::uuid = :'first_ask'::uuid, 'and a new one takes its place');
select vcr.check(exists (select 1 from public.activity where verb = 'visit.cancel_requested' and subject_id = :'v_ann'), 'a cancel starts its own automations');
select vcr.check(exists (select 1 from public.notifications where company_id = :'co' and title = 'Ann Vcr asked to cancel Mow'), 'and the office is told about the new ask');
select vcr.expect_error(format($q$insert into public.visit_change_requests (company_id, visit_id, client_id, kind) values (%L, %L, %L, 'reschedule')$q$, :'co', :'v_bob', :'bob'),
  'a reschedule needs a time or the client''s words');
select vcr.expect_error(format($q$insert into public.visit_change_requests (company_id, visit_id, client_id, kind, scheduled_on) values (%L, %L, %L, 'cancel', %L)$q$, :'co', :'v_bob', :'bob', :'tomorrow'),
  'a cancel has no time');
select vcr.expect_error(format($q$insert into public.visit_change_requests (company_id, visit_id, client_id, kind) values (%L, %L, %L, 'cancel')$q$, :'other', :'v_bob', :'bob'),
  'a request is for a visit of the same business');
commit;

\o
\echo 'Reading and answering'
\o /dev/null

-- Who reads it: whoever may move the visit.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select vcr.check((select count(*) = 1 from public.visit_change_requests), 'the office reads it');
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select vcr.check((select count(*) = 1 from public.visit_change_requests), 'so does the lead of the visit''s crew, who runs only her own');
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select vcr.check((select count(*) = 0 from public.visit_change_requests), 'not another crew''s lead');
select vcr.check(vcr.changed(format($q$update public.visit_change_requests set status = 'approved' where id = %L$q$, :'ask')) = 0, 'who can''t read it can''t answer it');
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select vcr.check((select count(*) = 0 from public.visit_change_requests), 'nor the field crew on it');
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select vcr.check((select count(*) = 0 from public.visit_change_requests), 'nor another business');
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select vcr.expect_error(format('update public.visit_change_requests set visit_id = %L where id = %L', :'v_bob', :'ask'), 'answering changes nothing but the answer');
select vcr.expect_error(format('delete from public.visit_change_requests where id = %L', :'ask'), 'and nobody signed in deletes one');
select vcr.expect_error(format($q$update public.visit_change_requests set note = 'x' where id = %L$q$, :'ask'), 'a note alone isn''t an answer: it''s approved or declined');
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ac600000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select vcr.check(vcr.changed(format($q$update public.visit_change_requests set status = 'declined', note = 'We''re booked that week.' where id = %L$q$, :'ask')) = 1, 'the office declines it');
select vcr.check((select decided_by = 'ac600000-0000-0000-0000-000000000002' and decided_at is not null and note = 'We''re booked that week.' from public.visit_change_requests where id = :'ask'),
  'with who and when kept');
select vcr.check(vcr.changed(format($q$update public.visit_change_requests set status = 'approved' where id = %L$q$, :'ask')) = 0, 'and an answer stays given');
commit;

begin;
set local role service_role;
delete from public.visits where id = :'v_ann';
select vcr.check(not exists (select 1 from public.visit_change_requests where visit_id = :'v_ann'), 'a deleted visit takes its requests with it');
rollback;

\echo 'All visit change request tests passed.'
