-- Database tests for equipment photos: anyone on the team adds them, only the person who added one
-- or an equipment manager takes it out, files stay in the company's equipment folder, and a photo
-- taken out (or with its machine) goes to the Trash.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema teph;
grant usage on schema teph to authenticated, service_role;
create function teph.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function teph.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema teph to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e8e80000-0000-0000-0000-000000000001', 'owner@lima.test', '{"full_name": "Lou Owner"}'),
  ('e8e80000-0000-0000-0000-000000000002', 'crew@lima.test', '{"full_name": "Cam Crew"}'),
  ('e8e80000-0000-0000-0000-000000000003', 'crew2@lima.test', '{"full_name": "Cy Crew"}'),
  ('e8e80000-0000-0000-0000-000000000004', 'other@mike.test', '{"full_name": "Mo Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e8e80000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Lima Lawn', 'landscaping') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'e8e80000-0000-0000-0000-000000000002', 'field_crew'),
  (:'co', 'e8e80000-0000-0000-0000-000000000003', 'field_crew');
insert into public.equipment (company_id, name, kind, meter) values (:'co', 'Mower 3', 'mower', 'hours') returning id as mower \gset
insert into public.equipment (company_id, name, kind, meter) values (:'co', 'Old trimmer', 'tool', 'none') returning id as trimmer \gset
commit;

-- Field crew add photos and see them.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e8e80000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.equipment_photos (company_id, equipment_id, path, file_name, content_type, size_bytes)
  values (:'co', :'mower', :'co' || '/equipment/' || :'mower' || '/deck.jpg', 'deck.jpg', 'image/jpeg', 1200) returning id as deck \gset
insert into public.equipment_photos (company_id, equipment_id, path, file_name)
  values (:'co', :'mower', :'co' || '/equipment/' || :'mower' || '/plate.jpg', 'plate.jpg') returning id as plate \gset
select teph.check((select count(*) from public.equipment_photos where equipment_id = :'mower') = 2, 'crew add photos and see them');
select teph.expect_error(format('insert into public.equipment_photos (company_id, equipment_id, path) values (%L, %L, %L)', :'co', :'mower', :'co' || '/visit/x/deck.jpg'),
  'a photo has to be in the equipment folder');
select teph.expect_error(format('insert into public.equipment_photos (company_id, equipment_id, path, created_by) values (%L, %L, %L, %L)', :'co', :'mower', :'co' || '/equipment/y.jpg', 'e8e80000-0000-0000-0000-000000000001'),
  'or added as someone else');
select teph.expect_error(format('update public.equipment_photos set path = %L where id = %L', :'co' || '/equipment/z.jpg', :'deck'), 'photos aren''t changed, only added and taken out');
commit;

select teph.check(private.stored_path_in_use(:'co', :'co' || '/equipment/' || :'mower' || '/deck.jpg'), 'a photo''s file counts as in use');

-- Someone else on the crew can't take them out; the person who added one can, and it goes to the Trash.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e8e80000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
delete from public.equipment_photos where id = :'deck';
select teph.check((select count(*) from public.equipment_photos where id = :'deck') = 1, 'another crew member can''t take someone''s photo out');
select set_config('request.jwt.claims', '{"sub": "e8e80000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
delete from public.equipment_photos where id = :'deck';
select teph.check((select count(*) from public.equipment_photos where id = :'deck') = 0, 'the person who added it can');
commit;
select teph.check((select source = 'equipment_photo' and label = 'Equipment photo · Mower 3' and file_name = 'deck.jpg' and size_bytes = 1200
  from public.trashed_files where path = :'co' || '/equipment/' || :'mower' || '/deck.jpg'), 'and its file goes to the Trash');

-- An equipment manager takes out anyone's; deleting the machine takes its photos to the Trash too.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e8e80000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.equipment_photos (company_id, equipment_id, path) values (:'co', :'trimmer', :'co' || '/equipment/' || :'trimmer' || '/old.jpg');
delete from public.equipment_photos where id = :'plate';
select teph.check((select count(*) from public.equipment_photos where id = :'plate') = 0, 'an equipment manager takes out anyone''s photo');
delete from public.equipment where id = :'trimmer';
commit;
select teph.check((select count(*) from public.trashed_files where path = :'co' || '/equipment/' || :'trimmer' || '/old.jpg') = 1, 'a deleted machine''s photos go to the Trash');

-- Another company sees nothing and can't add to the machine.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e8e80000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select public.create_company('Mike Mowing', 'landscaping') as other \gset
select teph.check((select count(*) from public.equipment_photos) = 0, 'other companies see no photos');
select teph.expect_error(format('insert into public.equipment_photos (company_id, equipment_id, path) values (%L, %L, %L)', :'co', :'mower', :'co' || '/equipment/sneaky.jpg'), 'or add one');
select teph.expect_error(format('insert into public.equipment_photos (company_id, equipment_id, path) values (%L, %L, %L)', :'other', :'mower', :'other' || '/equipment/sneaky.jpg'), 'even from their own company');
commit;

\echo 'All equipment photos tests passed.'
