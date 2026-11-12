-- Database tests for the stored files crew leads and field crew read
-- (20261112000100_crew_files.sql): the files of their own work, by the same rules as the tables,
-- and the ones they stored or put in the Trash themselves, while the office reads what it always did.
--
-- One file is stored in every folder the app uses, and in one it doesn't. Signed in as each level,
-- the files read from storage.objects must be exactly the ones listed for it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tcrf;
grant usage on schema tcrf to authenticated, service_role;
create function tcrf.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The company's stored files the person asking reads, without the company's folder, in one fixed order.
create function tcrf.files(p_company uuid) returns text[] language sql stable as $$
  select coalesce(array_agg(substr(o.name, 38) order by o.name collate "C"), '{}')
  from storage.objects o where o.bucket_id = 'files' and starts_with(o.name, p_company::text || '/')
$$;
-- A list in that order, to compare with it.
create function tcrf.sorted(p text[]) returns text[] language sql immutable as $$
  select array(select x from unnest(p) x order by x collate "C")
$$;
-- The person asking reads exactly these files of the company's; a failed check says which differ.
create function tcrf.reads(p_company uuid, p_files text[], p_what text) returns void language plpgsql as $$
declare v_read text[] := tcrf.files(p_company);
begin
  if v_read is distinct from tcrf.sorted(p_files) then
    raise exception 'FAIL: % (also reads: %; doesn''t read: %)', p_what,
      coalesce((select string_agg(x, ', ') from unnest(v_read) x where x <> all (p_files)), 'nothing'),
      coalesce((select string_agg(x, ', ') from unnest(p_files) x where x <> all (v_read)), 'nothing');
  end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tcrf to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('cf5e0000-0000-0000-0000-000000000001', 'olga@quebec.test', '{"full_name": "Olga Owner"}'),
  ('cf5e0000-0000-0000-0000-000000000002', 'otto@quebec.test', '{"full_name": "Otto Office"}'),
  ('cf5e0000-0000-0000-0000-000000000003', 'esme@quebec.test', '{"full_name": "Esme Estimator"}'),
  ('cf5e0000-0000-0000-0000-000000000004', 'lena@quebec.test', '{"full_name": "Lena Lead"}'),
  ('cf5e0000-0000-0000-0000-000000000005', 'cole@quebec.test', '{"full_name": "Cole Crew"}'),
  ('cf5e0000-0000-0000-0000-000000000006', 'nell@quebec.test', '{"full_name": "Nell New"}'),
  ('cf5e0000-0000-0000-0000-000000000007', 'rosa@romeo.test', '{"full_name": "Rosa Romeo"}');

-- ===== Quebec Paving ============================================================================
-- Olga owns it; Otto in the office; Esme estimates; Lena leads a crew; Cole is field crew on the
-- two visits at Ann's (looking at the drive, then paving it); Nell is field crew with no visits yet. Ann's job came from a quote; Bob's quote
-- is still a quote, and nobody in the field is on Bob's job. Romeo Roofing is another business.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Quebec Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'cf5e0000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'cf5e0000-0000-0000-0000-000000000003', 'estimator'),
  (:'co', 'cf5e0000-0000-0000-0000-000000000004', 'crew_lead'),
  (:'co', 'cf5e0000-0000-0000-0000-000000000005', 'field_crew'),
  (:'co', 'cf5e0000-0000-0000-0000-000000000006', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as c1 \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bob Other') returning id as c2 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c1', '1 Oak St') returning id as p1 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c2', '2 Elm St') returning id as p2 \gset
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'Driveway') returning id as r1 \gset
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'c2', :'p2', 'Parking lot') returning id as r2 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'c1', 'Driveway') returning id as q1 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'c2', 'Parking lot') returning id as q2 \gset
insert into public.jobs (company_id, client_id, property_id, quote_id, title) values (:'co', :'c1', :'p1', :'q1', 'Driveway') returning id as j1 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c2', :'p2', 'Patching') returning id as j2 \gset
insert into public.invoices (company_id, client_id, job_id) values (:'co', :'c1', :'j1') returning id as i1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'p1', 'Pave the drive', current_date) returning id as v1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j2', :'p2', 'Patch the lot', current_date) returning id as v2 \gset
insert into public.visits (company_id, request_id, property_id, title, kind, scheduled_on) values (:'co', :'r1', :'p1', 'Look at the drive', 'assessment', current_date) returning id as va \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values
  (:'co', :'v1', 'cf5e0000-0000-0000-0000-000000000005'), (:'co', :'va', 'cf5e0000-0000-0000-0000-000000000005');
insert into public.property_assets (company_id, property_id, name, photo_path) values
  (:'co', :'p1', 'Sump pump', :'co' || '/property-equipment/cf5e0000-0000-0000-0000-0000000000e1.jpg'),
  (:'co', :'p2', 'Lot lights', :'co' || '/property-equipment/cf5e0000-0000-0000-0000-0000000000e2.jpg');
-- Ann's job: a sheet for the crew, the signed contract for the office only, and an old sheet put
-- away. Bob's job: a sheet for the crew.
insert into public.plan_files (company_id, job_id, title, path, file_name, crew_visible, archived) values
  (:'co', :'j1', 'Grading plan', :'co' || '/plans/cf5e0000-0000-0000-0000-0000000000b1.pdf', 'grading.pdf', true, false),
  (:'co', :'j1', 'Signed contract', :'co' || '/plans/cf5e0000-0000-0000-0000-0000000000b2.pdf', 'contract.pdf', false, false),
  (:'co', :'j1', 'Old grading plan', :'co' || '/plans/cf5e0000-0000-0000-0000-0000000000b3.pdf', 'old.pdf', true, true),
  (:'co', :'j2', 'Striping plan', :'co' || '/plans/cf5e0000-0000-0000-0000-0000000000b4.pdf', 'striping.pdf', true, false);
commit;

-- Romeo Roofing, with a visit of its own. Rosa also works in the field for Quebec, with no visits there.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select public.create_company('Romeo Roofing', 'roofing') as other \gset
insert into public.visits (company_id, title, scheduled_on) values (:'other', 'Reroof', current_date) returning id as rv \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', 'cf5e0000-0000-0000-0000-000000000007', 'field_crew');

-- A file in every folder (Storage writes these rows itself, whoever uploads).
create table tcrf.stored (name text primary key, owner uuid);
grant select on tcrf.stored to authenticated;
insert into tcrf.stored (name, owner) values
  ('visit/' || :'v1' || '/before.jpg', 'cf5e0000-0000-0000-0000-000000000005'),
  ('visit/' || :'v2' || '/before.jpg', 'cf5e0000-0000-0000-0000-000000000004'),
  ('visit/' || :'va' || '/crack.jpg', 'cf5e0000-0000-0000-0000-000000000005'),
  -- Cole's own photo, from a day he helped at Bob's.
  ('visit/' || :'v2' || '/cole.jpg', 'cf5e0000-0000-0000-0000-000000000005'),
  -- In Quebec's folders, named for Romeo's visit: nobody's.
  ('visit/' || :'rv' || '/stray.jpg', null),
  ('job/' || :'j1' || '/permit.pdf', null),
  ('job/' || :'j2' || '/permit.pdf', null),
  ('tickets/' || :'j1' || '/ticket.jpg', 'cf5e0000-0000-0000-0000-000000000005'),
  ('tickets/' || :'j2' || '/ticket.jpg', null),
  -- A ticket photo Nell took out, in the Trash (below).
  ('tickets/' || :'j2' || '/slip.jpg', null),
  ('quote/' || :'q1' || '/site.jpg', null),
  ('quote/' || :'q2' || '/site.jpg', null),
  ('invoice/' || :'i1' || '/statement.pdf', null),
  ('client/' || :'c1' || '/porch.jpg', null),
  ('client/' || :'c2' || '/porch.jpg', null),
  ('property/' || :'p1' || '/gate.jpg', null),
  ('property/' || :'p2' || '/gate.jpg', null),
  ('request/' || :'r1' || '/crack.jpg', null),
  ('request/' || :'r2' || '/crack.jpg', null),
  ('property-equipment/cf5e0000-0000-0000-0000-0000000000e1.jpg', null),
  ('property-equipment/cf5e0000-0000-0000-0000-0000000000e2.jpg', null),
  ('plans/cf5e0000-0000-0000-0000-0000000000b1.pdf', null),
  ('plans/cf5e0000-0000-0000-0000-0000000000b2.pdf', null),
  ('plans/cf5e0000-0000-0000-0000-0000000000b3.pdf', null),
  ('plans/cf5e0000-0000-0000-0000-0000000000b4.pdf', null),
  -- Stored for a save that failed: no plan file names it.
  ('plans/cf5e0000-0000-0000-0000-0000000000b9.pdf', 'cf5e0000-0000-0000-0000-000000000004'),
  ('measurements/cf5e0000-0000-0000-0000-0000000000d1.jpg', null),
  ('kb/cover.jpg', null),
  ('equipment/paver.jpg', null),
  ('avatars/cf5e0000-0000-0000-0000-000000000002/me.jpg', null),
  ('logo/logo.png', null),
  ('letterhead/paper.png', null),
  ('packages/gold.jpg', null),
  ('services/sealcoat.jpg', null),
  ('social/cf5e0000-0000-0000-0000-0000000000f1/1-square.jpg', null),
  ('receipts/fuel.jpg', 'cf5e0000-0000-0000-0000-000000000005'),
  ('receipts/gravel.jpg', 'cf5e0000-0000-0000-0000-000000000002'),
  ('subs/cf5e0000-0000-0000-0000-0000000000c1/w9.pdf', null),
  ('applicants/cf5e0000-0000-0000-0000-0000000000a1/1.pdf', null),
  ('notes/minutes.txt', null);
insert into storage.objects (bucket_id, name, owner) select 'files', :'co' || '/' || name, owner from tcrf.stored;
insert into public.trashed_files (company_id, path, file_name, source, deleted_by)
  values (:'co', :'co' || '/tickets/' || :'j2' || '/slip.jpg', 'slip.jpg', 'ticket_photo', 'cf5e0000-0000-0000-0000-000000000006');

-- The folders everyone on the team reads.
select array['avatars/cf5e0000-0000-0000-0000-000000000002/me.jpg', 'equipment/paver.jpg', 'kb/cover.jpg', 'logo/logo.png'] as team \gset
-- What the office read before this (20261028000100_careers.sql): every folder but the four with
-- rules of their own.
select coalesce(array_agg(name), '{}') as office from tcrf.stored where split_part(name, '/', 1) not in ('receipts', 'chat', 'subs', 'applicants') \gset

\o
\echo 'Stored files for the crew'
\o /dev/null

-- ===== Field crew ===============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tcrf.reads(:'co', :'team'::text[] || array[
  'visit/' || :'v1' || '/before.jpg', 'visit/' || :'va' || '/crack.jpg', 'job/' || :'j1' || '/permit.pdf', 'tickets/' || :'j1' || '/ticket.jpg',
  'quote/' || :'q1' || '/site.jpg', 'client/' || :'c1' || '/porch.jpg', 'property/' || :'p1' || '/gate.jpg', 'request/' || :'r1' || '/crack.jpg',
  'property-equipment/cf5e0000-0000-0000-0000-0000000000e1.jpg', 'plans/cf5e0000-0000-0000-0000-0000000000b1.pdf', 'receipts/fuel.jpg',
  'visit/' || :'v2' || '/cole.jpg'],
  'field crew read the files of the visits they''re on, their job, client, property and request, the job''s quote''s photos, '
  || 'the plan marked for the crew, their own receipt and photo and the team''s folders, and nothing else');
select tcrf.check(not exists (select 1 from storage.objects where name like '%/plans/%b2.pdf'), 'not the signed contract, which is the office''s');
select tcrf.check((select array_agg(title order by title) from public.plan_files) = '{"Grading plan"}', 'the same plan files as the table shows them');

-- Someone with no visits yet reads only the team's folders, and what they put in the Trash themselves.
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select tcrf.reads(:'co', :'team'::text[] || array['tickets/' || :'j2' || '/slip.jpg'],
  'field crew with no visits read only the team''s photos, equipment, guides and logo, and a file they put in the Trash, to download it');

-- Rosa can open Romeo's visit, but a file under Quebec named for it isn't Romeo's.
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select tcrf.check(exists (select 1 from public.visits where id = :'rv') and tcrf.files(:'co') = tcrf.sorted(:'team'::text[]),
  'a file named for another company''s visit isn''t read through that visit');
rollback;

-- ===== Crew leads ===============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tcrf.reads(:'co', :'team'::text[] || array[
  'visit/' || :'v1' || '/before.jpg', 'visit/' || :'v2' || '/before.jpg', 'visit/' || :'v2' || '/cole.jpg', 'visit/' || :'va' || '/crack.jpg',
  'job/' || :'j1' || '/permit.pdf', 'job/' || :'j2' || '/permit.pdf',
  'tickets/' || :'j1' || '/ticket.jpg', 'tickets/' || :'j2' || '/ticket.jpg', 'tickets/' || :'j2' || '/slip.jpg', 'quote/' || :'q1' || '/site.jpg',
  'client/' || :'c1' || '/porch.jpg', 'client/' || :'c2' || '/porch.jpg', 'property/' || :'p1' || '/gate.jpg', 'property/' || :'p2' || '/gate.jpg',
  'request/' || :'r1' || '/crack.jpg', 'request/' || :'r2' || '/crack.jpg',
  'property-equipment/cf5e0000-0000-0000-0000-0000000000e1.jpg', 'property-equipment/cf5e0000-0000-0000-0000-0000000000e2.jpg',
  'plans/cf5e0000-0000-0000-0000-0000000000b1.pdf', 'plans/cf5e0000-0000-0000-0000-0000000000b4.pdf',
  'measurements/cf5e0000-0000-0000-0000-0000000000d1.jpg'],
  'crew leads read every visit''s, job''s, client''s, property''s and request''s files, the photos of quotes that became jobs, '
  || 'the current plans marked for the crew and measurements, and nothing else');
select tcrf.check(not exists (select 1 from storage.objects where name ~ '/plans/.*b[239]\.pdf$'),
  'not the signed contract, the sheet put away, or a stored file no plan names, though they stored it');
select tcrf.check(not exists (select 1 from storage.objects where name ~ '/(invoice|social|letterhead|packages|services|notes|subs|applicants)/')
  and not exists (select 1 from storage.objects where name like '%/quote/' || :'q2' || '/%'), 'nor invoices'' files, a quote that''s still a quote, or the office''s other folders');
rollback;

-- Marked for the crew, the contract is theirs to open too; put away, the grading plan no longer is.
update public.plan_files set crew_visible = true where path like '%b2.pdf';
update public.plan_files set archived = true where path like '%b1.pdf';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tcrf.check((select array_agg(substr(name, 38) order by name) from storage.objects where name like '%/plans/%') = '{plans/cf5e0000-0000-0000-0000-0000000000b2.pdf}',
  'a plan''s stored file follows its row: marked for the crew it opens, put away it doesn''t');
rollback;
update public.plan_files set crew_visible = false where path like '%b2.pdf';
update public.plan_files set archived = false where path like '%b1.pdf';

-- ===== The office keeps what it had =============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tcrf.reads(:'co', :'office'::text[], 'an estimator reads every folder but receipts, chat, sub paperwork and résumés, as before');
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tcrf.reads(:'co', :'office'::text[] || array['receipts/fuel.jpg', 'receipts/gravel.jpg',
  'subs/cf5e0000-0000-0000-0000-0000000000c1/w9.pdf', 'applicants/cf5e0000-0000-0000-0000-0000000000a1/1.pdf'],
  'office staff read those and, with their areas, receipts, sub paperwork and résumés, as before');
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tcrf.reads(:'co', array(select name from tcrf.stored), 'the owner reads every file');
rollback;

-- ===== Nobody else ==============================================================================
delete from public.memberships where company_id = :'co' and user_id = 'cf5e0000-0000-0000-0000-000000000007';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select tcrf.reads(:'co', '{}', 'another company''s owner reads none of it');
rollback;
-- Someone turned off reads nothing, the team's folders included.
update public.memberships set active = false where company_id = :'co' and user_id = 'cf5e0000-0000-0000-0000-000000000005';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf5e0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tcrf.reads(:'co', '{}', 'and someone turned off reads none either, their own receipt included');
rollback;

-- Left as it was found, for the tests after this one.
delete from storage.objects where name like :'co' || '/%';
delete from public.companies where id in (:'co', :'other');
set client_min_messages = warning;
drop schema tcrf cascade;
reset client_min_messages;

\o
\echo 'All crew files tests passed.'
