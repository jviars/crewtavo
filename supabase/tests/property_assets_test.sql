-- Database tests for equipment at a property (20261106000200_property_equipment.sql): whoever sees
-- the property sees its equipment; the office adds, edits, retires and deletes it; a crew adds an
-- item and changes its notes where they have a visit, and ticks what their visit serviced; another
-- business sees and changes none of it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema pae;
grant usage on schema pae to authenticated, service_role;
create function pae.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function pae.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function pae.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on all functions in schema pae to authenticated, service_role;

-- Hana owns Heron Heating; Otto is in the office, Lena leads a crew, Finn is on a visit at the
-- Moss house, Gus is on no visit. Ed owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('e7a50000-0000-0000-0000-000000000001', 'hana@heron.test', '{"full_name": "Hana Heron"}'),
  ('e7a50000-0000-0000-0000-000000000002', 'otto@heron.test', '{"full_name": "Otto Office"}'),
  ('e7a50000-0000-0000-0000-000000000003', 'lena@heron.test', '{"full_name": "Lena Lead"}'),
  ('e7a50000-0000-0000-0000-000000000004', 'finn@heron.test', '{"full_name": "Finn Field"}'),
  ('e7a50000-0000-0000-0000-000000000005', 'gus@heron.test', '{"full_name": "Gus Idle"}'),
  ('e7a50000-0000-0000-0000-000000000009', 'ed@egret.test', '{"full_name": "Ed Egret"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a50000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Egret Air', 'hvac') as other \gset
select set_config('request.jwt.claims', '{"sub": "e7a50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Heron Heating', 'hvac') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'e7a50000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'e7a50000-0000-0000-0000-000000000003', 'crew_lead'),
  (:'co', 'e7a50000-0000-0000-0000-000000000004', 'field_crew'),
  (:'co', 'e7a50000-0000-0000-0000-000000000005', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Mia Moss') returning id as c1 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c1', '4 Moss Ln') returning id as p1 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c1', '9 Fern Ct') returning id as p2 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'Furnace tune-up') returning id as j1 \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j1', 'Tune-up', current_date) returning id as v1 \gset
insert into public.visits (company_id, property_id, title, scheduled_on) values (:'co', :'p2', 'Look at the AC', current_date) returning id as v2 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v1', 'e7a50000-0000-0000-0000-000000000004');
insert into public.checklist_templates (company_id, name, items) values (:'co', 'Furnace check', '[]') returning id as tmpl \gset
insert into public.checklist_responses (company_id, visit_id, template_id, completed_at) values (:'co', :'v1', :'tmpl', now());
commit;

-- The office adds, edits and retires equipment.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a50000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.property_assets (company_id, property_id, name, make, model, serial, installed_on, warranty_until, location)
  values (:'co', :'p1', 'Furnace', 'Lennox', 'EL296', 'SN-1', '2019-10-01', '2029-10-01', 'Basement') returning id as furnace \gset
insert into public.property_assets (company_id, property_id, name) values (:'co', :'p1', 'Old boiler') returning id as boiler \gset
insert into public.property_assets (company_id, property_id, name) values (:'co', :'p2', 'AC unit') returning id as ac \gset
select pae.check(pae.changed(format('update public.property_assets set model = %L, notes = %L where id = %L', 'EL296V', 'Filter 16x25', :'furnace')) = 1, 'the office edits an item');
select pae.check(pae.changed(format('update public.property_assets set status = %L where id = %L', 'retired', :'boiler')) = 1, 'and retires one');
select pae.expect_error(format('insert into public.property_assets (company_id, property_id, name) values (%L, %L, %L)', :'co', :'p1', '  '), 'an item needs a name');
select pae.expect_error(format('insert into public.property_assets (company_id, property_id, name, status) values (%L, %L, %L, %L)', :'co', :'p1', 'Heat pump', 'broken'), 'and is active or retired');
commit;

-- Finn, on a visit at the Moss house: sees and adds equipment there, changes notes, ticks his visit.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a50000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select pae.check((select array_agg(name order by name) from public.property_assets) = '{Furnace,"Old boiler"}', 'a crew sees the equipment where they have a visit, and nowhere else');
insert into public.property_assets (company_id, property_id, name, location) values (:'co', :'p1', 'Humidifier', 'On the furnace') returning id as humidifier \gset
select pae.check(:'humidifier' is not null, 'and adds an item there from the field');
select pae.expect_error(format('insert into public.property_assets (company_id, property_id, name) values (%L, %L, %L)', :'co', :'p2', 'Mine'), 'but not at a property they have no visit at');
select pae.check(pae.changed(format('update public.property_assets set notes = %L where id = %L', 'Burner cleaned', :'furnace')) = 1, 'a crew changes an item''s notes');
select pae.expect_error(format('update public.property_assets set model = %L where id = %L', 'Other', :'furnace'), 'but not the rest of it');
select pae.expect_error(format('update public.property_assets set status = %L where id = %L', 'retired', :'furnace'), 'or retire it');
select pae.check(pae.changed(format('update public.property_assets set notes = %L where id = %L', 'Mine', :'ac')) = 0, 'nor anything where they have no visit');
select pae.check(pae.changed(format('delete from public.property_assets where id = %L', :'humidifier')) = 0, 'a crew can''t delete equipment, even an item they added');
insert into public.visit_assets (company_id, visit_id, asset_id) values (:'co', :'v1', :'furnace');
select pae.check((select count(*) = 1 from public.visit_assets where visit_id = :'v1'), 'a crew ticks what their visit serviced');
select pae.expect_error(format('insert into public.visit_assets (company_id, visit_id, asset_id) values (%L, %L, %L)', :'co', :'v2', :'furnace'), 'but not on a visit they aren''t on');
select pae.check(pae.changed(format('delete from public.visit_assets where visit_id = %L and asset_id = %L', :'v1', :'furnace')) = 1, 'and unticks it');
insert into public.visit_assets (company_id, visit_id, asset_id) values (:'co', :'v1', :'furnace');
commit;

-- Gus has no visits: nothing to see or add.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a50000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select pae.check(not exists (select 1 from public.property_assets) and not exists (select 1 from public.visit_assets), 'a crew with no visit there sees no equipment and no service history');
select pae.expect_error(format('insert into public.property_assets (company_id, property_id, name) values (%L, %L, %L)', :'co', :'p1', 'Mine'), 'and adds none');
commit;

-- Lena leads a crew: sees every property's equipment, adds and keeps notes, as the field does.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a50000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select pae.check((select count(*) = 4 from public.property_assets), 'a crew lead sees the equipment at every property, as they see every property');
select pae.check(pae.changed(format('update public.property_assets set notes = %L where id = %L', 'Noisy fan', :'ac')) = 1, 'and changes its notes');
select pae.expect_error(format('update public.property_assets set serial = %L where id = %L', 'X', :'ac'), 'but leaves the rest to the office');
commit;

-- The office: the service history, deleting, and what the server may do.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a50000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select pae.check((select v.title = 'Tune-up' and r.completed_at is not null and a.notes = 'Burner cleaned'
  from public.visit_assets va join public.visits v on v.id = va.visit_id join public.property_assets a on a.id = va.asset_id
  left join public.checklist_responses r on r.visit_id = v.id where va.asset_id = :'furnace'),
  'an item''s history is its visits, with the checklist filled in on each');
select pae.check(pae.changed(format('delete from public.property_assets where id = %L', :'humidifier')) = 1, 'the office deletes an item');
commit;
reset role;
select pae.check(pae.changed(format('update public.property_assets set model = %L where id = %L', 'EL296E', :'furnace')) = 1, 'the server changes any of it');

-- Ed's business sees and changes none of it.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a50000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select pae.check(not exists (select 1 from public.property_assets) and not exists (select 1 from public.visit_assets), 'another business sees none of the equipment or its history');
select pae.expect_error(format('insert into public.property_assets (company_id, property_id, name) values (%L, %L, %L)', :'co', :'p1', 'Mine'), 'and adds none there');
select pae.expect_error(format('insert into public.property_assets (company_id, property_id, name) values (%L, %L, %L)', :'other', :'p1', 'Mine'), 'nor under its own name at the other''s property');
select pae.check(pae.changed(format('update public.property_assets set notes = %L', 'Mine')) = 0
  and pae.changed('delete from public.property_assets') = 0 and pae.changed('delete from public.visit_assets') = 0, 'and changes or deletes none of it');
commit;

-- A property's equipment goes with it, and an item's history with the item.
begin;
delete from public.property_assets where id = :'furnace';
select pae.check(not exists (select 1 from public.visit_assets where asset_id = :'furnace'), 'deleting an item deletes its history');
delete from public.properties where id = :'p2';
select pae.check(not exists (select 1 from public.property_assets where id = :'ac'), 'deleting a property deletes its equipment');
rollback;

\echo 'All property equipment tests passed.'
