-- Database tests for 20261123101100_crews_move_visits_forward.sql: field crew and subs move a visit
-- forward through its steps (on the way, started, done) and never back one, a step sent again goes
-- through as no change, and crew leads and the office move a visit back as before.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1123f;
grant usage on schema t1123f to authenticated, service_role;
create function t1123f.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "code: message", or 'none'.
create function t1123f.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1123f.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function t1123f.status_of(p_visit uuid) returns text language sql as $$
  select status from public.visits where id = p_visit
$$;
grant execute on all functions in schema t1123f to authenticated, service_role;

\set olive '11230000-0000-4000-8000-000000000101'
\set opal '11230000-0000-4000-8000-000000000102'
\set lou '11230000-0000-4000-8000-000000000104'
\set cy '11230000-0000-4000-8000-000000000105'
\set sal '11230000-0000-4000-8000-000000000107'
\set salsub '11230000-0000-4000-8000-0000000001c1'

-- Olive owns Fern Lawns: Opal is office, Lou leads the Mow crew with Cy on it, and Sal signs in for
-- a sub.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@fern.test', '{"full_name": "Olive Owner"}'),
  (:'opal', 'opal@fern.test', '{"full_name": "Opal Office"}'),
  (:'lou', 'lou@fern.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@fern.test', '{"full_name": "Cy Crew"}'),
  (:'sal', 'sal@sal.test', '{"full_name": "Sal Sub"}');

begin;
set local role authenticated;
select t1123f.as_user(:'olive');
select public.create_company('Fern Lawns', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '12 Oak St') returning id as prop \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Mowing') returning id as job \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', :'opal', 'office'), (:'co', :'lou', 'crew_lead'), (:'co', :'cy', 'field_crew');
insert into public.subcontractors (id, company_id, name) values (:'salsub', :'co', 'Sal LLC');
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', :'salsub');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Mow', :'lou') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', :'cy');
-- The crew's visit today, the sub's, and one of the crew's that isn't on the schedule yet.
insert into public.visits (company_id, job_id, property_id, title, scheduled_on, crew_id)
  values (:'co', :'job', :'prop', 'Mow', private.company_today(:'co'), :'crew') returning id as v1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on)
  values (:'co', :'job', :'prop', 'Trim the hedges', private.company_today(:'co')) returning id as v2 \gset
insert into public.visits (company_id, job_id, property_id, title, status, crew_id)
  values (:'co', :'job', :'prop', 'Aerate', 'unscheduled', :'crew') returning id as v3 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v1', :'cy'), (:'co', :'v2', :'sal'), (:'co', :'v3', :'cy');

\o
\echo 'Field crew'
\o /dev/null

-- ===== Field crew move their visit forward, and never back a step ================================
begin;
set local role authenticated;
select t1123f.as_user(:'cy');
update public.visits set status = 'en_route' where id = :'v1';
update public.visits set status = 'in_progress' where id = :'v1';
select t1123f.check(t1123f.status_of(:'v1') = 'in_progress', 'field crew move their visit forward');
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'scheduled', :'v1'))
    = '42501: Ask the office to cancel, move or reopen this visit.', 'but not back to scheduled');
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'en_route', :'v1'))
    = '42501: Ask the office to move this visit back a step.', 'or back to on the way');
select t1123f.check(t1123f.status_of(:'v1') = 'in_progress', 'so it stays started');
update public.visits set status = 'in_progress', notes = 'Started on the back' where id = :'v1';
select t1123f.check((select status = 'in_progress' and notes = 'Started on the back' from public.visits where id = :'v1'),
  'a step sent again is no change, and the notes with it go in');
update public.visits set status = 'completed' where id = :'v1';
select t1123f.check((select status = 'completed' and completed_by = :'cy' from public.visits where id = :'v1'), 'and they finish it');
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'en_route', :'v1')) like '42501:%',
  'and it stays finished, as before');
rollback;

-- A step can be skipped (Complete with no On my way first), and not undone from there.
begin;
set local role authenticated;
select t1123f.as_user(:'cy');
update public.visits set status = 'in_progress' where id = :'v1';
select t1123f.check(t1123f.status_of(:'v1') = 'in_progress', 'field crew start a visit without saying they''re on the way');
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'en_route', :'v1')) like '42501:%',
  'and don''t go back to on the way after');
rollback;
begin;
set local role authenticated;
select t1123f.as_user(:'cy');
update public.visits set status = 'completed' where id = :'v1';
select t1123f.check(t1123f.status_of(:'v1') = 'completed', 'or finish one they never started');
rollback;

-- On the way, and back to scheduled.
begin;
set local role authenticated;
select t1123f.as_user(:'cy');
update public.visits set status = 'en_route' where id = :'v1';
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'scheduled', :'v1')) like '42501:%',
  'field crew don''t take back On my way');
rollback;

-- Putting a visit on the schedule is the office's.
begin;
set local role authenticated;
select t1123f.as_user(:'cy');
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'scheduled', :'v3')) like '42501:%',
  'field crew don''t mark a visit scheduled that isn''t');
select t1123f.check(t1123f.status_of(:'v3') = 'unscheduled', 'so it stays off the schedule');
rollback;

\o
\echo 'Subs'
\o /dev/null

-- ===== Subs, the same ============================================================================
begin;
set local role authenticated;
select t1123f.as_user(:'sal');
update public.visits set status = 'en_route' where id = :'v2';
update public.visits set status = 'in_progress' where id = :'v2';
select t1123f.check(t1123f.status_of(:'v2') = 'in_progress', 'a sub moves their visit forward');
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'scheduled', :'v2'))
    = '42501: Ask the office to cancel, move or reopen this visit.', 'but not back to scheduled');
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'en_route', :'v2'))
    = '42501: Ask the office to move this visit back a step.', 'or back to on the way');
update public.visits set status = 'in_progress', notes = 'Bagged the clippings' where id = :'v2';
select t1123f.check((select status = 'in_progress' and notes = 'Bagged the clippings' from public.visits where id = :'v2'), 'a step sent again is no change');
update public.visits set status = 'completed' where id = :'v2';
select t1123f.check((select status = 'completed' and completed_by = :'sal' from public.visits where id = :'v2'), 'and they finish it');
rollback;

begin;
set local role authenticated;
select t1123f.as_user(:'sal');
update public.visits set status = 'en_route' where id = :'v2';
select t1123f.check(t1123f.error_of(format('update public.visits set status = %L where id = %L', 'scheduled', :'v2')) like '42501:%',
  'a sub doesn''t take back On my way');
rollback;

\o
\echo 'Everyone else, as before'
\o /dev/null

-- ===== Crew leads and the office move a visit back ===============================================
begin;
update public.visits set status = 'in_progress' where id in (:'v1', :'v2');
set local role authenticated;
select t1123f.as_user(:'lou');
update public.visits set status = 'en_route' where id = :'v1';
select t1123f.check(t1123f.status_of(:'v1') = 'en_route', 'a crew lead moves their crew''s visit back a step');
update public.visits set status = 'scheduled' where id = :'v1';
select t1123f.check(t1123f.status_of(:'v1') = 'scheduled', 'and back to scheduled');
select t1123f.as_user(:'opal');
update public.visits set status = 'scheduled' where id = :'v2';
select t1123f.check(t1123f.status_of(:'v2') = 'scheduled', 'and so does the office, on a sub''s visit too');
rollback;

-- The database's own changes go through, whoever set them off.
begin;
update public.visits set status = 'in_progress' where id = :'v1';
update public.visits set status = 'scheduled' where id = :'v1';
select t1123f.check(t1123f.status_of(:'v1') = 'scheduled', 'and the server moves a visit back, as before');
rollback;
