-- Database tests for other calendars on the schedule and visits on Google Calendar: who sees them,
-- that links stay secret and only the server writes, and when visit changes are queued for Google.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tcal;
grant usage on schema tcal to authenticated, service_role;
create function tcal.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tcal.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function tcal.pushes(p_company uuid) returns bigint language sql as $$
  select count(*) from public.outbox where company_id = p_company and topic = 'calendar.visit'
$$;
grant execute on all functions in schema tcal to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b2000000-0000-0000-0000-000000000001', 'owner@quebec.test', '{"full_name": "Quinn Owner"}'),
  ('b2000000-0000-0000-0000-000000000002', 'office@quebec.test', '{"full_name": "Odie Office"}'),
  ('b2000000-0000-0000-0000-000000000003', 'lead@quebec.test', '{"full_name": "Lee Lead"}'),
  ('b2000000-0000-0000-0000-000000000004', 'crew@quebec.test', '{"full_name": "Cy Crew"}'),
  ('b2000000-0000-0000-0000-000000000005', 'owner@romeo.test', '{"full_name": "Rae Romeo"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b2000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Quebec Gutters', 'gutters') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'b2000000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'b2000000-0000-0000-0000-000000000003', 'crew_lead'),
  (:'co', 'b2000000-0000-0000-0000-000000000004', 'field_crew');
insert into public.crews (company_id, name) values (:'co', 'North') returning id as crew \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b2000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select public.create_company('Romeo Roofing', 'roofing') as other \gset
commit;

-- ===== The server adds a Zoho calendar and a Google one =========================================
insert into public.calendar_sources (company_id, kind, app, name, color, crew_id, url_sealed, host)
values (:'co', 'ics', 'zoho_calendar', 'Office calendar', '#2563eb', :'crew', 'v1.sealed-secret', 'calendar.zoho.com')
returning id as zoho \gset
insert into public.calendar_sources (company_id, kind, app, name, external_id, show_details)
values (:'co', 'google', 'google_calendar', 'Quinn (personal)', 'quinn@example.com', false)
returning id as google \gset
insert into public.calendar_events (company_id, source_id, key, title, starts_at, ends_at, starts_on, ends_on)
values (:'co', :'zoho', 'abc@zoho', 'Supplier visit', now(), now() + interval '1 hour', current_date, current_date);
insert into public.calendar_events (company_id, source_id, key, title, all_day, starts_on, ends_on, busy)
values (:'co', :'google', 'g1', 'Busy', true, current_date, current_date + 2, false);

select tcal.expect_error(format('insert into public.calendar_sources (company_id, kind, app, name) values (%L, %L, %L, %L)', :'co', 'ics', 'ics_calendar', 'No link'),
  'a link calendar needs its (encrypted) link');
select tcal.expect_error(format('insert into public.calendar_sources (company_id, kind, app, name, external_id) values (%L, %L, %L, %L, %L)', :'co', 'google', 'google_calendar', 'Again', 'quinn@example.com'),
  'a Google calendar is added once');
select tcal.expect_error(format('insert into public.calendar_events (company_id, source_id, key, title, starts_on, ends_on) values (%L, %L, %L, %L, current_date, current_date)', :'co', :'zoho', 'timed', 'No times'),
  'a timed event needs its times');

-- ===== People who schedule see them; field crew and other companies don't ======================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b2000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tcal.check((select count(*) from public.calendar_events where company_id = :'co') = 2, 'the office sees other calendars on the schedule');
select tcal.check((select name from public.calendar_sources where id = :'zoho') = 'Office calendar', 'and which calendar each event is from');
select tcal.expect_error('select url_sealed from public.calendar_sources', 'but never the link itself');
select tcal.expect_error(format('update public.calendar_sources set name = %L where id = %L', 'Mine now', :'zoho'), 'only the server changes calendars');
select tcal.expect_error(format('delete from public.calendar_events where source_id = %L', :'zoho'), 'or their events');
select tcal.expect_error(format('insert into public.calendar_events (company_id, source_id, key, title, all_day, starts_on, ends_on) values (%L, %L, %L, %L, true, current_date, current_date)', :'co', :'zoho', 'x', 'Fake'),
  'or adds events');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b2000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tcal.check((select count(*) from public.calendar_events) = 2, 'crew leads see them too (they see the whole schedule)');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b2000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tcal.check((select count(*) from public.calendar_events) = 0 and (select count(*) from public.calendar_sources) = 0, 'field crew see only their own visits, not other calendars');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b2000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tcal.check((select count(*) from public.calendar_events) = 0 and (select count(*) from public.calendar_sources) = 0, 'another company sees none of them');
commit;

-- ===== A removed crew leaves the calendar for the whole team; removing a calendar removes its events
delete from public.crews where id = :'crew';
select tcal.check((select crew_id is null from public.calendar_sources where id = :'zoho'), 'when its crew is removed, the calendar becomes the whole team''s');
delete from public.calendar_sources where id = :'google';
select tcal.check((select count(*) from public.calendar_events where source_id = :'google') = 0, 'removing a calendar removes its events');

-- ===== Visits queue for Google Calendar only when the company puts them there ===================
insert into public.visits (company_id, title, scheduled_on) values (:'co', 'Clean gutters', current_date + 1) returning id as v1 \gset
select tcal.check(tcal.pushes(:'co') = 0, 'nothing is queued without Google Calendar');

insert into public.integrations (company_id, provider, status) values (:'co', 'google_calendar', 'connected');
update public.visits set title = 'Clean gutters (front)' where id = :'v1';
select tcal.check(tcal.pushes(:'co') = 0, 'or when it''s connected but visits don''t go to Google');

update public.integrations set settings = '{"push_calendar_id": "abc@group.calendar.google.com"}' where company_id = :'co' and provider = 'google_calendar';
insert into public.visits (company_id, title, scheduled_on) values (:'co', 'Gutter guards', current_date + 2) returning id as v2 \gset
select tcal.check(tcal.pushes(:'co') = 1, 'a new visit is queued for Google Calendar');
update public.visits set starts_at = (current_date + 2) + time '09:00', ends_at = (current_date + 2) + time '11:00' where id = :'v2';
select tcal.check(tcal.pushes(:'co') = 1, 'changes while it waits share the same queued push');
update public.visits set route_order = 3 where id = :'v2';
update public.outbox set locked_until = now() + interval '5 minutes' where company_id = :'co' and topic = 'calendar.visit';
update public.visits set route_order = 4 where id = :'v2';
select tcal.check(tcal.pushes(:'co') = 1, 'changes nobody sees on Google (route order) queue nothing');
update public.visits set status = 'cancelled' where id = :'v2';
select tcal.check(tcal.pushes(:'co') = 2, 'a change while a push is underway queues another');
update public.outbox set done_at = now(), locked_until = null where company_id = :'co' and topic = 'calendar.visit';
delete from public.visits where id = :'v1';
select tcal.check((select count(*) from public.outbox where company_id = :'co' and topic = 'calendar.visit' and payload ->> 'visit_id' = :'v1' and done_at is null) = 1,
  'a deleted visit is queued so it comes off Google Calendar');

update public.integrations set status = 'error' where company_id = :'co' and provider = 'google_calendar';
insert into public.visits (company_id, title, scheduled_on) values (:'co', 'While disconnected', current_date + 3);
select tcal.check(tcal.pushes(:'co') = 3, 'nothing is queued while Google needs reconnecting');

delete from public.companies where id = :'co';
select tcal.check(not exists (select 1 from public.outbox where company_id = :'co'), 'deleting the company takes its calendars and queue with it');

\echo 'All calendar sync tests passed.'
