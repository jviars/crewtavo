-- Database tests for 20261112000500_settings_and_removed_members.sql: saving the company doesn't
-- change the settings an area decides for someone without that area (and still saves the rest), and
-- only someone who still signs in takes back a photo, a time entry or an equipment photo they added.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tsrm;
grant usage on schema tsrm to authenticated, service_role;
create function tsrm.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function tsrm.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
create function tsrm.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tsrm to authenticated, service_role;

\set una '5e770000-0000-0000-0000-000000000001'
\set ada '5e770000-0000-0000-0000-000000000002'
\set bea '5e770000-0000-0000-0000-000000000003'
\set otis '5e770000-0000-0000-0000-000000000004'
\set cy '5e770000-0000-0000-0000-000000000005'
\set gus '5e770000-0000-0000-0000-000000000006'
\set sal '5e770000-0000-0000-0000-000000000007'
\set sid '5e770000-0000-0000-0000-000000000008'

-- Una owns Uniform Paving; Ada is an admin; Bea is an admin as a Bookkeeper, with the invoices and
-- reports areas only; Otis is office; Cy is field crew; Gus was field crew and has been turned off.
-- Sal and Sid are subs on the clock who sign in; Sid's sign-in has been turned off.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'una', 'una@uniform.test', '{"full_name": "Una Owner"}'),
  (:'ada', 'ada@uniform.test', '{"full_name": "Ada Admin"}'),
  (:'bea', 'bea@uniform.test', '{"full_name": "Bea Books"}'),
  (:'otis', 'otis@uniform.test', '{"full_name": "Otis Office"}'),
  (:'cy', 'cy@uniform.test', '{"full_name": "Cy Crew"}'),
  (:'gus', 'gus@uniform.test', '{"full_name": "Gus Gone"}'),
  (:'sal', 'sal@siding.test', '{"full_name": "Sal Sub"}'),
  (:'sid', 'sid@stucco.test', '{"full_name": "Sid Sub"}');

begin;
set local role authenticated;
select tsrm.as_user(:'una');
select public.create_company('Uniform Paving', 'paving') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as books \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as c1 \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'c1', 'Driveway') returning id as j1 \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j1', 'Pave', current_date) returning id as v1 \gset
insert into public.equipment (company_id, name, kind) values (:'co', 'Roller', 'other') returning id as roller \gset
insert into public.subcontractors (company_id, name, uses_clock) values (:'co', 'Sal''s Siding', true) returning id as sal_sub \gset
insert into public.subcontractors (company_id, name, uses_clock) values (:'co', 'Sid''s Stucco', true) returning id as sid_sub \gset
commit;
-- Sign-ins, as the server makes them (admins and subs aren't added from the browser).
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'ada', 'admin', null), (:'co', :'bea', 'admin', :'books'), (:'co', :'otis', 'office', null),
  (:'co', :'cy', 'field_crew', null), (:'co', :'gus', 'field_crew', null);
insert into public.memberships (company_id, user_id, role, subcontractor_id) values
  (:'co', :'sal', 'subcontractor', :'sal_sub'), (:'co', :'sid', 'subcontractor', :'sid_sub');
insert into public.visit_assignees (company_id, visit_id, user_id) values
  (:'co', :'v1', :'cy'), (:'co', :'v1', :'gus'), (:'co', :'v1', :'sal'), (:'co', :'v1', :'sid');

\o
\echo 'Settings an area decides'
\o /dev/null

-- ===== Settings an area decides =================================================================
-- Una installs Drive and sets a weather rule; Otis, in the office, turns sub reminders off.
begin;
set local role authenticated;
select tsrm.as_user(:'una');
select public.drive_set_enabled(:'co', true);
select public.set_weather_rules(:'co', '[{"max_wind_mph": 20}]');
select tsrm.as_user(:'otis');
select public.set_sub_reminders(:'co', false);
select public.set_weather_rules(:'co', '[{"max_wind_mph": 25}]');
commit;
select tsrm.check((select settings #>> '{drive,enabled}' = 'true' and settings #>> '{subs,remind_subs}' = 'false' and settings #>> '{weather_rules,0,max_wind_mph}' = '25'
  from public.companies where id = :'co'), 'the functions still save them for people with the area: the owner installs Drive, the office sets weather rules and sub reminders');
select settings as before from public.companies where id = :'co' \gset

-- Bea saves the company with every one of them changed, along with the name and the map settings.
begin;
set local role authenticated;
select tsrm.as_user(:'bea');
update public.companies set name = 'Uniform Paving LLC', settings = settings
  || '{"drive": {"enabled": false}, "team_chat": {"enabled": true}, "careers": {"enabled": true}, "paving_app": {"enabled": false}, "roofing_app": {"enabled": true},
       "website_forms": {"enabled": true}, "website_analytics": {"enabled": true, "site": "evil.test"}, "weather_rules": [], "subs": {"remind_subs": true},
       "maps": {"default": "esri"}, "revenue_goal": 500000}'
where id = :'co';
commit;
select tsrm.check((select name = 'Uniform Paving LLC' and settings #>> '{maps,default}' = 'esri' and settings ->> 'revenue_goal' = '500000' from public.companies where id = :'co'),
  'an admin without the apps, settings or subs areas still saves the company''s details and the settings every admin has');
select tsrm.check((select settings - array['maps', 'revenue_goal'] = :'before'::jsonb - array['maps', 'revenue_goal'] from public.companies where id = :'co'),
  'but the apps installed, the weather rules and how subs are reminded stay as they were');

-- A page Bea has had open since before Una installed Team chat saves all of settings as it read them.
select settings as stale from public.companies where id = :'co' \gset
begin;
set local role authenticated;
select tsrm.as_user(:'una');
select public.chat_set_enabled(:'co', true);
select tsrm.as_user(:'bea');
update public.companies set settings = :'stale'::jsonb || '{"revenue_goal": 600000}' where id = :'co';
commit;
select tsrm.check((select settings #>> '{team_chat,enabled}' = 'true' and settings ->> 'revenue_goal' = '600000' from public.companies where id = :'co'),
  'a page open since before an app was installed doesn''t uninstall it when it saves');

-- With the area, saving the company changes them as before; so does the server.
begin;
set local role authenticated;
select tsrm.as_user(:'ada');
update public.companies set settings = settings || '{"weather_rules": [{"max_rain_pct": 40}], "careers": {"enabled": true}}' where id = :'co';
commit;
select tsrm.check((select settings #>> '{weather_rules,0,max_rain_pct}' = '40' and settings #>> '{careers,enabled}' = 'true' from public.companies where id = :'co'),
  'an admin with the areas changes them by saving the company, as before');
update public.companies set settings = settings || '{"paving_app": {"enabled": true}}' where id = :'co';
select tsrm.check((select settings #>> '{paving_app,enabled}' = 'true' from public.companies where id = :'co'), 'and the server changes them');

\o
\echo 'Taking back what you added'
\o /dev/null

-- ===== Taking back what you added ===============================================================
-- A photo, a time entry and an equipment photo each from Cy and from Gus; a photo and a time entry
-- each from Sal and from Sid.
begin;
set local role authenticated;
select tsrm.as_user(:'cy');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/cy.jpg', 'cy.jpg');
insert into public.time_entries (company_id, user_id, started_at, ended_at, notes) values (:'co', :'cy', now() - interval '3 hours', now() - interval '2 hours', 'cy');
insert into public.equipment_photos (company_id, equipment_id, path, file_name) values (:'co', :'roller', :'co' || '/equipment/' || :'roller' || '/cy.jpg', 'cy.jpg');
select tsrm.as_user(:'gus');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/gus.jpg', 'gus.jpg');
insert into public.time_entries (company_id, user_id, started_at, ended_at, notes) values (:'co', :'gus', now() - interval '3 hours', now() - interval '2 hours', 'gus');
insert into public.equipment_photos (company_id, equipment_id, path, file_name) values (:'co', :'roller', :'co' || '/equipment/' || :'roller' || '/gus.jpg', 'gus.jpg');
select tsrm.as_user(:'sal');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/sal.jpg', 'sal.jpg');
insert into public.time_entries (company_id, user_id, visit_id, started_at, ended_at, notes) values (:'co', :'sal', :'v1', now() - interval '3 hours', now() - interval '2 hours', 'sal');
select tsrm.as_user(:'sid');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/sid.jpg', 'sid.jpg');
insert into public.time_entries (company_id, user_id, visit_id, started_at, ended_at, notes) values (:'co', :'sid', :'v1', now() - interval '3 hours', now() - interval '2 hours', 'sid');
commit;

-- Gus and Sid are turned off. Signed in still (a session lasts a while), neither removes anything:
-- not by asking for everything of theirs, with no row named.
update public.memberships set active = false where company_id = :'co' and user_id in (:'gus', :'sid');
begin;
set local role authenticated;
select tsrm.as_user(:'gus');
select tsrm.check(tsrm.changed('delete from public.attachments') = 0 and tsrm.changed('delete from public.time_entries') = 0
  and tsrm.changed('delete from public.equipment_photos') = 0, 'someone turned off removes none of the photos, time or equipment photos they added');
select tsrm.as_user(:'sid');
select tsrm.check(tsrm.changed('delete from public.attachments') = 0 and tsrm.changed('delete from public.time_entries') = 0, 'nor does a sub whose sign-in is turned off');
commit;
select tsrm.check((select count(*) from public.attachments where company_id = :'co') = 4 and (select count(*) from public.time_entries where company_id = :'co') = 4
  and (select count(*) from public.equipment_photos where company_id = :'co') = 2, 'everything is still there');

-- People who still sign in take back their own, and only their own.
begin;
set local role authenticated;
select tsrm.as_user(:'cy');
select tsrm.check(tsrm.changed('delete from public.attachments') = 1 and tsrm.changed('delete from public.time_entries') = 1
  and tsrm.changed('delete from public.equipment_photos') = 1, 'field crew take back the photo, the time and the equipment photo they added, as before');
select tsrm.as_user(:'sal');
select tsrm.check(tsrm.changed('delete from public.attachments') = 1 and tsrm.changed('delete from public.time_entries') = 1,
  'a sub on the clock takes back the photo and the time they added, as before');
commit;
select tsrm.check((select array_agg(file_name order by file_name) from public.attachments where company_id = :'co') = '{gus.jpg,sid.jpg}'
  and (select array_agg(notes order by notes) from public.time_entries where company_id = :'co') = '{gus,sid}'
  and (select array_agg(file_name) from public.equipment_photos where company_id = :'co') = '{gus.jpg}', 'and nobody else''s went with them');

-- The office and an equipment manager still remove anyone's.
begin;
set local role authenticated;
select tsrm.as_user(:'otis');
select tsrm.check(tsrm.changed(format('delete from public.attachments where company_id = %L', :'co')) = 2
  and tsrm.changed(format('delete from public.time_entries where company_id = %L', :'co')) = 2
  and tsrm.changed(format('delete from public.equipment_photos where company_id = %L', :'co')) = 1, 'the office still removes anyone''s');
commit;

-- Left as it was found, for the tests after this one.
delete from public.companies where id = :'co';
set client_min_messages = warning;
drop schema tsrm cascade;
reset client_min_messages;

\o
\echo 'All settings and removed members tests passed.'
