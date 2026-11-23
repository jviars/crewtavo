-- Database tests for 20261123100200_what_field_crews_change.sql: field crew change what the field
-- app changes on their visits (the status forward, notes, the arrival time) and finish them as
-- themselves, while crew leads, the office and the database's own functions are as they were;
-- anyone but the office and sales adds only an internal note of their own to a client; and taking
-- back an equipment log entry, logged materials, a note or a chat reaction needs a sign-in the
-- company hasn't turned off.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1122f;
grant usage on schema t1122f to authenticated, service_role;
create function t1122f.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "code: message", or 'none'.
create function t1122f.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function t1122f.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
create function t1122f.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- One of the database's own functions changing a visit for whoever set it off (as finishing a job,
-- or a storm's price, does): it runs as the database, not as the person.
create function t1122f.database_renames(p_visit uuid, p_title text) returns void language sql security definer set search_path = '' as $$
  update public.visits set title = p_title where id = p_visit
$$;
grant execute on all functions in schema t1122f to authenticated, service_role;

\set olive '11220000-0000-4000-8000-000000000101'
\set opal '11220000-0000-4000-8000-000000000102'
\set eve '11220000-0000-4000-8000-000000000103'
\set lou '11220000-0000-4000-8000-000000000104'
\set cy '11220000-0000-4000-8000-000000000105'
\set gus '11220000-0000-4000-8000-000000000106'
\set sal '11220000-0000-4000-8000-000000000107'
\set salsub '11220000-0000-4000-8000-0000000001c1'

-- Olive owns Fern Lawns: Opal is office, Eve an estimator, Lou leads the Mow crew with Cy and Gus on
-- it, and Sal signs in for a sub.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@fern.test', '{"full_name": "Olive Owner"}'),
  (:'opal', 'opal@fern.test', '{"full_name": "Opal Office"}'),
  (:'eve', 'eve@fern.test', '{"full_name": "Eve Estimator"}'),
  (:'lou', 'lou@fern.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@fern.test', '{"full_name": "Cy Crew"}'),
  (:'gus', 'gus@fern.test', '{"full_name": "Gus Crew"}'),
  (:'sal', 'sal@sal.test', '{"full_name": "Sal Sub"}');

begin;
set local role authenticated;
select t1122f.as_user(:'olive');
select public.create_company('Fern Lawns', 'general') as co \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Ann Client', '+15405550101') returning id as client \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bo Elsewhere') returning id as other_client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '12 Oak St') returning id as prop \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Mowing') returning id as job \gset
insert into public.equipment (company_id, name, kind) values (:'co', 'Big mower', 'mower') returning id as mower \gset
commit;
insert into public.memberships (company_id, user_id, role) values
  (:'co', :'opal', 'office'), (:'co', :'eve', 'estimator'), (:'co', :'lou', 'crew_lead'), (:'co', :'cy', 'field_crew'), (:'co', :'gus', 'field_crew');
insert into public.subcontractors (id, company_id, name) values (:'salsub', :'co', 'Sal LLC');
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', :'salsub');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Mow', :'lou') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', :'cy'), (:'co', :'crew', :'gus');
insert into public.visits (company_id, job_id, property_id, title, scheduled_on, crew_id)
  values (:'co', :'job', :'prop', 'Mow', private.company_today(:'co'), :'crew') returning id as v1 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v1', :'cy'), (:'co', :'v1', :'gus');

\o
\echo 'Their visits'
\o /dev/null

-- ===== What field crew change on their visit ====================================================
begin;
set local role authenticated;
select t1122f.as_user(:'cy');
update public.visits set status = 'en_route', eta_at = now() + interval '20 minutes' where id = :'v1';
update public.visits set status = 'in_progress', notes = 'Gate was open' where id = :'v1';
select t1122f.check((select status = 'in_progress' and notes = 'Gate was open' and eta_at > now() from public.visits where id = :'v1'),
  'field crew move their visit along, with its arrival time, and take notes on it');
select t1122f.check(t1122f.error_of(format('update public.visits set title = %L where id = %L', 'Easy one', :'v1'))
    = '42501: You can change a visit''s status and notes. Ask the office about anything else.', 'but don''t rename it');
select t1122f.check(t1122f.error_of(format('update public.visits set address = %L where id = %L', '1 Elsewhere Rd', :'v1')) like '42501:%', 'or change where it is');
select t1122f.check(t1122f.error_of(format('update public.visits set kind = %L where id = %L', 'task', :'v1')) like '42501:%', 'or what kind of visit it is');
select t1122f.check(t1122f.error_of(format('update public.visits set series_id = gen_random_uuid(), series_day = 1, series_total = 2 where id = %L', :'v1')) like '42501:%',
  'or the series it''s in');
select t1122f.check(t1122f.error_of(format('update public.visits set hold_reason = %L where id = %L', 'Rain', :'v1')) like '42501:%', 'or put it on hold');
select t1122f.check(t1122f.error_of(format('update public.visits set status = %L where id = %L', 'cancelled', :'v1'))
    = '42501: Ask the office to cancel, move or reopen this visit.', 'or cancel it');
select t1122f.check(t1122f.error_of(format('update public.visits set status = %L where id = %L', 'unscheduled', :'v1')) like '42501:%', 'or take it off the schedule');
update public.visits set completed_by = :'olive' where id = :'v1';
select t1122f.check((select completed_by is null and completed_at is null from public.visits where id = :'v1'), 'or say someone finished it');
-- Finishing it: when it was tapped, if that's believable, and by them, whatever they send.
update public.visits set status = 'completed', completed_at = now() - interval '1 hour', completed_by = :'olive' where id = :'v1';
select t1122f.check((select completed_by = :'cy' and completed_at between now() - interval '61 minutes' and now() - interval '59 minutes' from public.visits where id = :'v1'),
  'a visit they finish is finished by them, when they tapped it');
select t1122f.check(t1122f.error_of(format('update public.visits set status = %L where id = %L', 'in_progress', :'v1')) like '42501:%', 'once it''s done, the office reopens it');
update public.visits set completed_at = now() - interval '2 days', completed_by = :'gus' where id = :'v1';
select t1122f.check((select completed_by = :'cy' and completed_at > now() - interval '2 hours' from public.visits where id = :'v1'), 'and when and who stay as they were');
update public.visits set notes = 'Gate was open. Bagged the clippings.' where id = :'v1';
select t1122f.check((select notes like '%clippings.' from public.visits where id = :'v1'), 'they still add to the notes');
rollback;

begin;
set local role authenticated;
select t1122f.as_user(:'cy');
update public.visits set status = 'completed', completed_at = now() - interval '5 days' where id = :'v1';
select t1122f.check((select completed_at > now() - interval '1 minute' and completed_by = :'cy' from public.visits where id = :'v1'),
  'a tap from too long ago is dated now');
rollback;

begin;
set local role authenticated;
select t1122f.as_user(:'cy');
update public.visits set status = 'completed', completed_at = now() + interval '1 hour' where id = :'v1';
select t1122f.check((select completed_at <= now() from public.visits where id = :'v1'), 'and so is one from the future');
rollback;

-- The database's own functions change a visit for whatever the crew did, as before.
begin;
set local role authenticated;
select t1122f.as_user(:'cy');
select t1122f.database_renames(:'v1', 'Mow (front only)');
select t1122f.check((select title = 'Mow (front only)' from public.visits where id = :'v1'), 'the database''s own functions change a visit when a crew member sets them off');
rollback;

-- ===== Everyone else, as before ================================================================
begin;
set local role authenticated;
select t1122f.as_user(:'lou');
update public.visits set title = 'Mow and trim' where id = :'v1';
update public.visits set status = 'cancelled' where id = :'v1';
select t1122f.check((select title = 'Mow and trim' and status = 'cancelled' from public.visits where id = :'v1'), 'a crew lead still renames and cancels their crew''s visit');
rollback;
begin;
set local role authenticated;
select t1122f.as_user(:'opal');
update public.visits set status = 'completed', completed_by = :'cy' where id = :'v1';
select t1122f.check((select status = 'completed' from public.visits where id = :'v1'), 'the office finishes a visit as before');
update public.visits set status = 'scheduled', completed_at = null, completed_by = null where id = :'v1';
select t1122f.check((select status = 'scheduled' from public.visits where id = :'v1'), 'and reopens it');
rollback;
update public.visits set title = 'Mow (server)' where id = :'v1';
select t1122f.check((select title = 'Mow (server)' from public.visits where id = :'v1'), 'and the server changes anything');
update public.visits set title = 'Mow' where id = :'v1';

\o
\echo 'Client messages'
\o /dev/null

-- ===== Who adds what to a client's messages =====================================================
begin;
set local role authenticated;
select t1122f.as_user(:'cy');
insert into public.messages (company_id, client_id, channel, direction, body) values (:'co', :'client', 'note', 'internal', 'Dog in the back yard') returning id as cy_note \gset
select t1122f.check((select sent_by = :'cy' and status = 'sent' from public.messages where id = :'cy_note'), 'field crew add a note on a client they work for, as themselves');
select t1122f.check(t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, body, sent_by) values (%L, %L, 'note', 'internal', 'Pay Cy double', %L)$q$,
    :'co', :'client', :'olive')) like '42501:%', 'but not one signed as someone else');
select t1122f.check(t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, status, body, from_phone) values (%L, %L, 'sms', 'in', 'received', 'Skip us this week', '+15405550101')$q$,
    :'co', :'client')) like '42501:%', 'nor a text made out to be from the client');
select t1122f.check(t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, status, body) values (%L, %L, 'note', 'in', 'received', 'The client asked for a refund')$q$,
    :'co', :'client')) like '42501:%', 'nor a note made out to be from the client');
select t1122f.check(t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, body, from_name) values (%L, %L, 'note', 'internal', 'Hi', 'Ann Client')$q$,
    :'co', :'client')) like '42501:%', 'nor one in someone else''s name');
select t1122f.check(t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, body) values (%L, %L, 'email', 'out', 'We''re late')$q$,
    :'co', :'client')) like '42501:%', 'nor an email that never went out');
select t1122f.check(t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, body) values (%L, %L, 'note', 'internal', 'Hi')$q$,
    :'co', :'other_client')) like '42501:%', 'nor a note on a client they don''t work for');
select t1122f.as_user(:'lou');
insert into public.messages (company_id, client_id, channel, direction, body) values (:'co', :'other_client', 'note', 'internal', 'Called about a quote') returning id as lou_note \gset
select t1122f.check((select sent_by = :'lou' from public.messages where id = :'lou_note'), 'a crew lead adds a note on any client, as themselves');
select t1122f.check(t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, body, sent_by) values (%L, %L, 'note', 'internal', 'x', %L)$q$,
    :'co', :'client', :'olive')) like '42501:%'
  and t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, body) values (%L, %L, 'sms', 'out', 'x')$q$, :'co', :'client')) like '42501:%',
  'and nothing else');
select t1122f.as_user(:'sal');
select t1122f.check(t1122f.error_of(format($q$insert into public.messages (company_id, client_id, channel, direction, body) values (%L, %L, 'note', 'internal', 'x')$q$,
    :'co', :'client')) like '42501:%', 'a sub adds none');
select t1122f.as_user(:'eve');
insert into public.messages (company_id, client_id, channel, direction, body, related_type) values (:'co', :'client', 'email', 'out', 'Your quote', 'quote') returning id as eve_email \gset
select t1122f.as_user(:'opal');
insert into public.messages (company_id, client_id, channel, direction, status, body, from_phone) values (:'co', :'client', 'sms', 'in', 'received', 'Running late', '+15405550101')
  returning id as opal_text \gset
select t1122f.check((select count(*) = 2 from public.messages where id in (:'eve_email', :'opal_text')), 'sales and the office log any message, as before');
rollback;

\o
\echo 'Taking back what you wrote'
\o /dev/null

-- ===== Taking back what you wrote ===============================================================
-- Cy and Gus each log a mower note, materials on the job, a note on the client and a chat reaction.
begin;
set local role authenticated;
select t1122f.as_user(:'cy');
insert into public.equipment_logs (company_id, equipment_id, kind, done_on, notes) values (:'co', :'mower', 'note', current_date, 'Blade dull') returning id as cy_log \gset
insert into public.job_materials (company_id, job_id, name, quantity, unit) values (:'co', :'job', 'Mulch', 2, 'yd') returning id as cy_mat \gset
insert into public.messages (company_id, client_id, channel, direction, body) values (:'co', :'client', 'note', 'internal', 'Cy''s note') returning id as cy_note \gset
select t1122f.as_user(:'gus');
insert into public.equipment_logs (company_id, equipment_id, kind, done_on, notes) values (:'co', :'mower', 'note', current_date, 'Belt squeaks') returning id as gus_log \gset
insert into public.job_materials (company_id, job_id, name, quantity, unit) values (:'co', :'job', 'Seed', 1, 'bag') returning id as gus_mat \gset
insert into public.messages (company_id, client_id, channel, direction, body) values (:'co', :'client', 'note', 'internal', 'Gus''s note') returning id as gus_note \gset
commit;
-- Chat on (the owner turns it on, as in Apps), and the Mow crew's own channel, which its crew sees.
begin;
set local role authenticated;
select t1122f.as_user(:'olive');
select public.chat_set_enabled(:'co', true);
commit;
select id as channel from public.chat_channels where company_id = :'co' and crew_id = :'crew' \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'channel', :'olive', 'Rain tomorrow') returning id as post \gset
insert into public.chat_reactions (company_id, channel_id, message_id, user_id, kind) values (:'co', :'channel', :'post', :'cy', 'seen'), (:'co', :'channel', :'post', :'gus', 'seen');
-- Gus leaves the team.
update public.memberships set active = false where company_id = :'co' and user_id = :'gus';

begin;
set local role authenticated;
select t1122f.as_user(:'gus');
select t1122f.check(t1122f.changed(format('delete from public.equipment_logs where id = %L', :'gus_log')) = 0
    and t1122f.changed(format('delete from public.job_materials where id = %L', :'gus_mat')) = 0
    and t1122f.changed(format('delete from public.messages where id = %L', :'gus_note')) = 0
    and t1122f.changed(format('delete from public.chat_reactions where message_id = %L and user_id = %L', :'post', :'gus')) = 0,
  'someone whose sign-in was turned off takes back none of what they wrote');
select t1122f.as_user(:'cy');
select t1122f.check(t1122f.changed(format('delete from public.equipment_logs where id = %L', :'cy_log')) = 1
    and t1122f.changed(format('delete from public.job_materials where id = %L', :'cy_mat')) = 1
    and t1122f.changed(format('delete from public.messages where id = %L', :'cy_note')) = 1
    and t1122f.changed(format('delete from public.chat_reactions where message_id = %L and user_id = %L', :'post', :'cy')) = 1,
  'someone still on the team takes back what they wrote, as before');
select t1122f.check(t1122f.changed(format('delete from public.equipment_logs where id = %L', :'gus_log')) = 0
    and t1122f.changed(format('delete from public.messages where id = %L', :'gus_note')) = 0,
  'and not what a teammate wrote');
select t1122f.as_user(:'opal');
select t1122f.check(t1122f.changed(format('delete from public.job_materials where id = %L', :'gus_mat')) = 1
    and t1122f.changed(format('delete from public.messages where id = %L', :'gus_note')) = 1,
  'the office takes anyone''s back, as before');
rollback;
select t1122f.check((select count(*) = 2 from public.equipment_logs where id in (:'cy_log', :'gus_log'))
    and (select count(*) = 2 from public.chat_reactions where message_id = :'post'), 'and nothing was taken back by the turned-off sign-in');
