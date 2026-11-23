-- Database tests for 20261123100400_service_pictures.sql: nobody signed in puts a file in the price
-- list's pictures folder (<company>/services/), which only the server writes; and marking a photo OK to
-- share takes someone who can see the photo (set_photo_shareable, 20261122000100_prices_and_own_pay_stay_with_their_roles.sql).
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1122s;
grant usage on schema t1122s to authenticated, service_role;
create function t1122s.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "code: message", or 'none'.
create function t1122s.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1122s.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1122s to authenticated, service_role;

\set olive '11220000-0000-4000-8000-000000000301'
\set opal '11220000-0000-4000-8000-000000000302'
\set lou '11220000-0000-4000-8000-000000000303'
\set cy '11220000-0000-4000-8000-000000000304'

-- Olive owns Hill Hardscapes: Opal is office, Lou a crew lead and Cy field crew. Cy works Ann's patio,
-- not Bo's wall.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@hill.test', '{"full_name": "Olive Owner"}'),
  (:'opal', 'opal@hill.test', '{"full_name": "Opal Office"}'),
  (:'lou', 'lou@hill.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@hill.test', '{"full_name": "Cy Crew"}');

begin;
set local role authenticated;
select t1122s.as_user(:'olive');
select public.create_company('Hill Hardscapes', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ann Patio') returning id as ann \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bo Wall') returning id as bo \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'ann', 'Patio') returning id as patio \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'bo', 'Retaining wall') returning id as wall \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'patio', 'Lay pavers', current_date) returning id as v_patio \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'wall', 'Set the base', current_date) returning id as v_wall \gset
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Pavers', 'sqft', 12) returning id as pavers \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', :'opal', 'office'), (:'co', :'lou', 'crew_lead'), (:'co', :'cy', 'field_crew');
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v_patio', :'cy');
-- Photos: one on each visit from the office, and one Cy added on Bo's visit himself.
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'visit', :'v_patio', :'co' || '/visit/' || :'v_patio' || '/patio.jpg', 'patio.jpg', 'image/jpeg', :'opal') returning id as patio_photo \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'visit', :'v_wall', :'co' || '/visit/' || :'v_wall' || '/wall.jpg', 'wall.jpg', 'image/jpeg', :'opal') returning id as wall_photo \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'visit', :'v_wall', :'co' || '/visit/' || :'v_wall' || '/cy.jpg', 'cy.jpg', 'image/jpeg', :'cy') returning id as cys_photo \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'job', :'wall', :'co' || '/job/' || :'wall' || '/plan.jpg', 'plan.jpg', 'image/jpeg', :'opal') returning id as wall_job_photo \gset

\o
\echo 'Pictures only the server writes'
\o /dev/null

-- ===== Price list pictures ======================================================================
-- The server keeps a price list item's picture (services/packagePictures.ts, with its own key).
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/services/1b2c3d4e-0000-4000-8000-000000000001.jpg', null);
select t1122s.check((select count(*) = 1 from storage.objects where name = :'co' || '/services/1b2c3d4e-0000-4000-8000-000000000001.jpg'), 'the server keeps a price list picture');

begin;
set local role authenticated;
select t1122s.as_user(:'cy');
select t1122s.check(t1122s.error_of(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/services/1b2c3d4e-0000-4000-8000-000000000002.jpg', :'cy'))
    like '42501:%', 'field crew can''t put a file where the price list''s pictures are kept');
select t1122s.as_user(:'olive');
select t1122s.check(t1122s.error_of(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/services/1b2c3d4e-0000-4000-8000-000000000003.jpg', :'olive'))
    like '42501:%', 'nor can the owner: only the server, which checks it''s a picture');
select t1122s.check((select count(*) = 0 from storage.objects where name like :'co' || '/services/%' and owner is not null), 'nothing went in');
update storage.objects set name = name || '.html' where name like :'co' || '/services/%';
delete from storage.objects where name like :'co' || '/services/%';
select t1122s.check((select count(*) = 1 from storage.objects where name = :'co' || '/services/1b2c3d4e-0000-4000-8000-000000000001.jpg'),
  'and the server''s picture can''t be replaced or deleted from the browser');
-- Other folders are as they were.
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/visit/' || :'v_patio' || '/1b2c3d4e-0000-4000-8000-000000000004.jpg', :'olive');
select t1122s.check((select count(*) = 1 from storage.objects where name like :'co' || '/visit/%1b2c3d4e-0000-4000-8000-000000000004.jpg'), 'a visit''s photo goes in as before');
rollback;

\o
\echo 'Marking a photo OK to share'
\o /dev/null

-- ===== Marking a photo OK to share ==============================================================
begin;
set local role authenticated;
select t1122s.as_user(:'cy');
select t1122s.check((select (public.set_photo_shareable(:'patio_photo', true) ->> 'shareable')::boolean), 'field crew mark a photo on their visit OK to share');
select t1122s.check((select (public.set_photo_shareable(:'cys_photo', true) ->> 'shareable')::boolean), 'and a photo they added themselves');
select t1122s.check(t1122s.error_of(format('select public.set_photo_shareable(%L, true)', :'wall_photo')) = '42501: You can''t change this photo',
  'but not a photo on a visit they''re not on');
select t1122s.check(t1122s.error_of(format('select public.set_photo_shareable(%L, true)', :'wall_job_photo')) = '42501: You can''t change this photo',
  'or on a job they don''t work');
select t1122s.check(t1122s.error_of(format('select public.set_photo_shareable(%L, false)', :'wall_photo')) like '42501:%', 'nor take one off');
select t1122s.check((select count(*) = 0 from public.attachments where id = :'wall_photo'), 'a photo they can''t see, as attachments_read says');
select t1122s.as_user(:'lou');
select t1122s.check((select (public.set_photo_shareable(:'wall_photo', true) ->> 'shareable')::boolean), 'a crew lead, who sees every visit''s photos, marks it');
select t1122s.as_user(:'opal');
select t1122s.check((select (public.set_photo_shareable(:'wall_job_photo', true) ->> 'shareable')::boolean), 'and so does the office');
commit;
select t1122s.check((select count(*) = 4 and bool_and(shareable) from public.attachments where id in (:'patio_photo', :'cys_photo', :'wall_photo', :'wall_job_photo')),
  'each marked by someone who can see it');
