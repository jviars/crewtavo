-- Database tests for what field crew read of clients' contacts, files and news
-- (20261112000110_crew_contacts.sql): only their own work's, as with clients themselves, while crew
-- leads and the office read all of it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tcrc;
grant usage on schema tcrc to authenticated, service_role;
create function tcrc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tcrc to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('cc5e0000-0000-0000-0000-000000000001', 'olga@sierra.test', '{"full_name": "Olga Owner"}'),
  ('cc5e0000-0000-0000-0000-000000000002', 'lena@sierra.test', '{"full_name": "Lena Lead"}'),
  ('cc5e0000-0000-0000-0000-000000000003', 'cole@sierra.test', '{"full_name": "Cole Crew"}'),
  ('cc5e0000-0000-0000-0000-000000000004', 'nell@sierra.test', '{"full_name": "Nell New"}'),
  ('cc5e0000-0000-0000-0000-000000000005', 'tess@tango.test', '{"full_name": "Tess Tango"}');

-- ===== Sierra Sealcoat ==========================================================================
-- Olga owns it; Lena leads a crew; Cole is field crew on the two visits at Ann's (looking at the
-- drive for her request, then sealing it); Nell is field crew with no visits yet. Ann's job came
-- from a quote. Nobody in the field is on Bob's job, and Bob's quote is still a quote.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cc5e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Sierra Sealcoat', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'cc5e0000-0000-0000-0000-000000000002', 'crew_lead'),
  (:'co', 'cc5e0000-0000-0000-0000-000000000003', 'field_crew'),
  (:'co', 'cc5e0000-0000-0000-0000-000000000004', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as c1 \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bob Other') returning id as c2 \gset
insert into public.client_contacts (company_id, client_id, name, phone) values
  (:'co', :'c1', 'Ann''s husband', '+15405550121'), (:'co', :'c2', 'Bob''s bookkeeper', '+15405550122');
insert into public.properties (company_id, client_id, line1) values (:'co', :'c1', '1 Oak St') returning id as p1 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c2', '2 Elm St') returning id as p2 \gset
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'Driveway') returning id as r1 \gset
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'c2', :'p2', 'Parking lot') returning id as r2 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'c1', 'Driveway') returning id as q1 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'c2', 'Parking lot') returning id as q2 \gset
insert into public.jobs (company_id, client_id, property_id, quote_id, title) values (:'co', :'c1', :'p1', :'q1', 'Seal the drive') returning id as j1 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c2', :'p2', 'Patch the lot') returning id as j2 \gset
insert into public.invoices (company_id, client_id, job_id) values (:'co', :'c1', :'j1') returning id as i1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'p1', 'Seal', current_date) returning id as v1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j2', :'p2', 'Patch', current_date) returning id as v2 \gset
insert into public.visits (company_id, request_id, property_id, title, kind, scheduled_on) values (:'co', :'r1', :'p1', 'Look at the drive', 'assessment', current_date) returning id as va \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values
  (:'co', :'v1', 'cc5e0000-0000-0000-0000-000000000003'), (:'co', :'va', 'cc5e0000-0000-0000-0000-000000000003');
-- A file on everything a file can be on, at Ann's and at Bob's.
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type) values
  (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/a.jpg', 'ann visit.jpg', 'image/jpeg'),
  (:'co', 'visit', :'va', :'co' || '/visit/' || :'va' || '/a.jpg', 'ann assessment.jpg', 'image/jpeg'),
  (:'co', 'visit', :'v2', :'co' || '/visit/' || :'v2' || '/a.jpg', 'bob visit.jpg', 'image/jpeg'),
  (:'co', 'job', :'j1', :'co' || '/job/' || :'j1' || '/a.jpg', 'ann job.jpg', 'image/jpeg'),
  (:'co', 'job', :'j2', :'co' || '/job/' || :'j2' || '/a.jpg', 'bob job.jpg', 'image/jpeg'),
  (:'co', 'quote', :'q1', :'co' || '/quote/' || :'q1' || '/a.jpg', 'ann quote.jpg', 'image/jpeg'),
  (:'co', 'quote', :'q2', :'co' || '/quote/' || :'q2' || '/a.jpg', 'bob quote.jpg', 'image/jpeg'),
  (:'co', 'client', :'c1', :'co' || '/client/' || :'c1' || '/a.jpg', 'ann client.jpg', 'image/jpeg'),
  (:'co', 'client', :'c2', :'co' || '/client/' || :'c2' || '/a.jpg', 'bob client.jpg', 'image/jpeg'),
  (:'co', 'property', :'p1', :'co' || '/property/' || :'p1' || '/a.jpg', 'ann property.jpg', 'image/jpeg'),
  (:'co', 'property', :'p2', :'co' || '/property/' || :'p2' || '/a.jpg', 'bob property.jpg', 'image/jpeg'),
  (:'co', 'request', :'r1', :'co' || '/request/' || :'r1' || '/a.jpg', 'ann request.jpg', 'image/jpeg'),
  (:'co', 'request', :'r2', :'co' || '/request/' || :'r2' || '/a.jpg', 'bob request.jpg', 'image/jpeg'),
  (:'co', 'invoice', :'i1', :'co' || '/invoice/' || :'i1' || '/a.pdf', 'ann invoice.pdf', 'application/pdf');
-- News: both jobs were created above; both visits start.
update public.visits set status = 'in_progress' where id in (:'v1', :'v2');
commit;

-- A photo Nell added on a day she helped at Bob's.
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by)
  values (:'co', 'visit', :'v2', :'co' || '/visit/' || :'v2' || '/n.jpg', 'nell photo.jpg', 'image/jpeg', 'cc5e0000-0000-0000-0000-000000000004');

select tcrc.check((select count(*) from public.activity where company_id = :'co' and verb = 'job.created') = 2
  and (select count(*) from public.activity where company_id = :'co' and verb = 'visit.started') = 2
  and (select bool_and(summary ~ '(Ann Client|Bob Other)') from public.activity where company_id = :'co' and verb = 'job.created'),
  'the fixture has news of both jobs and both visits, naming the clients');

\o
\echo 'Contacts, files and news for the crew'
\o /dev/null

-- ===== Field crew ===============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cc5e0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tcrc.check((select array_agg(name) from public.client_contacts) = '{"Ann''s husband"}', 'field crew read the contacts of the client they work for, not another client''s');
select tcrc.check((select array_agg(file_name order by file_name) from public.attachments)
  = '{"ann assessment.jpg","ann client.jpg","ann job.jpg","ann property.jpg","ann quote.jpg","ann request.jpg","ann visit.jpg"}',
  'and the files on their visits, and on the job, quote, client, property and request behind them: '
  || coalesce((select string_agg(file_name, ', ' order by file_name) from public.attachments), 'none'));
select tcrc.check((select array_agg(file_name order by file_name) from public.attachments where owner_type = 'visit' and owner_id = :'v1') = '{"ann visit.jpg"}',
  'My day lists their visit''s photos');
select tcrc.check((select array_agg(file_name order by file_name) from public.record_photos(:'co', :'j1')) = '{"ann job.jpg","ann quote.jpg","ann visit.jpg"}',
  'the job''s Photos card shows its own, its quote''s and their visit''s');
select tcrc.check(not exists (select 1 from public.record_photos(:'co', :'j2')) and not exists (select 1 from public.record_photos(:'co', p_client => :'c2')),
  'and nothing of a job or a client they don''t work for');
select tcrc.check((select array_agg(verb || ' ' || subject_id order by verb) from public.activity) = array['job.created ' || :'j1', 'visit.started ' || :'v1'],
  'they read the news of their own visit and its job, not another client''s');
-- Adding a photo to their visit, and taking it back, as before.
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type)
  values (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/b.jpg', 'after.jpg', 'image/jpeg');
with gone as (delete from public.attachments where file_name = 'after.jpg' returning 1)
select tcrc.check((select count(*) from gone) = 1, 'they add a photo to their visit and take it back');

-- With no visits, none of it but the photo they added themselves.
select set_config('request.jwt.claims', '{"sub": "cc5e0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tcrc.check(not exists (select 1 from public.client_contacts) and not exists (select 1 from public.activity)
  and (select array_agg(file_name) from public.attachments) = '{"nell photo.jpg"}',
  'field crew with no visits read no contacts or news, and no files but one they added themselves');
with gone as (delete from public.attachments where file_name = 'nell photo.jpg' returning 1)
select tcrc.check((select count(*) from gone) = 1, 'which they can still take back');
rollback;

-- Taken off the visits, they stop reading what came with them.
begin;
delete from public.visit_assignees where company_id = :'co' and user_id = 'cc5e0000-0000-0000-0000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cc5e0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tcrc.check(not exists (select 1 from public.client_contacts) and not exists (select 1 from public.attachments) and not exists (select 1 from public.activity),
  'taken off their visits, they read none of it any more');
rollback;

-- ===== Crew leads and the office keep what they had =============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cc5e0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tcrc.check((select count(*) from public.client_contacts) = 2 and (select count(*) from public.attachments) = 15,
  'crew leads read every client''s contacts and every file''s row, as they do clients');
select tcrc.check((select count(*) from public.activity where verb in ('job.created', 'visit.started')) = 4 and not exists (select 1 from public.activity where verb !~ '^(visit\.|job\.created$)'),
  'and the news of every visit and new job, and no other news, as before');
select set_config('request.jwt.claims', '{"sub": "cc5e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tcrc.check((select count(*) from public.client_contacts) = 2 and (select count(*) from public.attachments) = 15
  and (select count(*) from public.activity where verb in ('job.created', 'visit.started')) = 4 and exists (select 1 from public.activity where verb !~ '^(visit\.|job\.created$)'),
  'the office reads all of it, and the rest of the news');
select set_config('request.jwt.claims', '{"sub": "cc5e0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tcrc.check(not exists (select 1 from public.client_contacts) and not exists (select 1 from public.attachments) and not exists (select 1 from public.activity where company_id = :'co'),
  'someone from another company reads none of it');
rollback;

-- Left as it was found, for the tests after this one.
delete from public.companies where id = :'co';
set client_min_messages = warning;
drop schema tcrc cascade;
reset client_min_messages;

\o
\echo 'All crew contacts tests passed.'
