-- Database tests for material prices: a service's materials from a supplier (service_materials)
-- are read by the people who price work (owner, admin, office, estimator) and changed by those who
-- change the price list (the Settings area), never by crews or another company; services.labor_cost and a quote line's priced materials keep their
-- shape. Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_materials;
grant usage on schema t_materials to authenticated, service_role;
create function t_materials.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_materials.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t_materials to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('ab5c0000-0000-0000-0000-000000000001', 'owner@materials.test', '{"full_name": "Rory Roofer"}'),
  ('ab5c0000-0000-0000-0000-000000000002', 'estimator@materials.test', '{"full_name": "Eddie Estimator"}'),
  ('ab5c0000-0000-0000-0000-000000000003', 'crew@materials.test', '{"full_name": "Cam Crew"}'),
  ('ab5c0000-0000-0000-0000-000000000004', 'other@materials.test', '{"full_name": "Olive Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab5c0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Rory Roofing', 'roofing_exteriors') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'ab5c0000-0000-0000-0000-000000000002', 'estimator'),
  (:'co', 'ab5c0000-0000-0000-0000-000000000003', 'field_crew');
insert into public.services (company_id, name, unit, unit_price, unit_cost, formula) values (:'co', 'Architectural shingle roof', 'square', 560, 330, 'squares') returning id as roof \gset
insert into public.service_materials (company_id, service_id, item_number, name, uom, uom_name, per_unit, unit_price, priced_at)
  values (:'co', :'roof', '02GATZ3CH', 'GAF Timberline HDZ Charcoal', 'BD', 'Bundle', 3, 45.12, now()) returning id as shingles \gset
update public.services set labor_cost = 180, unit_cost = 315.36 where id = :'roof';
select t_materials.check((select per_unit = 3 and supplier = 'abc_supply' from public.service_materials where id = :'shingles'), 'the owner adds ABC shingles to the roof, 3 bundles a square');
select t_materials.expect_error(format('update public.services set labor_cost = -1 where id = %L', :'roof'), 'labor can''t cost less than nothing');
select t_materials.expect_error(format('insert into public.service_materials (company_id, service_id, item_number, name, uom, per_unit) values (%L, %L, %L, %L, %L, 0)', :'co', :'roof', 'X', 'Nothing', 'EA'), 'a material goes into a service at least a little');
select t_materials.expect_error(format('insert into public.service_materials (company_id, service_id, item_number, name, uom, per_unit, supplier) values (%L, %L, %L, %L, %L, 1, %L)', :'co', :'roof', 'X', 'Elsewhere', 'EA', 'lowes'), 'and comes from a supplier Crewtavo prices from');
insert into public.clients (company_id, display_name) values (:'co', 'Pat Homeowner') returning id as client \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'New roof') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, service_id, name, quantity, unit, unit_price, unit_cost, materials, material_cost)
  values (:'co', :'quote', :'roof', 'Architectural shingle roof', 28.4, 'square', 560, 326.09, '{"supplier": "abc_supply", "items": []}', 4148.82) returning id as line \gset
select t_materials.check((select material_cost = 4148.82 from public.quote_line_items where id = :'line'), 'a quote line keeps what its materials came to');
select t_materials.expect_error(format('update public.quote_line_items set materials = %L where id = %L', '[]', :'line'), 'as one record of them');
commit;

-- ===== The estimator prices with them, like the rest of the price list ========================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab5c0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t_materials.check((select count(*) from public.service_materials where company_id = :'co') = 1, 'the estimator sees the roof''s materials');
update public.service_materials set per_unit = 4 where id = :'shingles';
select t_materials.check((select per_unit = 3 from public.service_materials where id = :'shingles'), 'but without Settings doesn''t change the price list''s materials');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab5c0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.service_materials set per_unit = 3.333 where id = :'shingles';
select t_materials.check((select per_unit = 3.333 from public.service_materials where id = :'shingles'), 'the owner changes how many go into a square');
commit;

-- ===== Crews and other companies don't see them ================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab5c0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t_materials.check((select count(*) from public.service_materials) = 0, 'field crew don''t see material prices');
select t_materials.expect_error(format('insert into public.service_materials (company_id, service_id, item_number, name, uom, per_unit) values (%L, %L, %L, %L, %L, 1)', :'co', :'roof', 'X', 'Nails', 'BX'), 'or add materials');
update public.service_materials set per_unit = 99 where id = :'shingles';
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab5c0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select public.create_company('Olive Exteriors', 'roofing_exteriors') as other \gset
select t_materials.check((select count(*) from public.service_materials) = 0, 'another company sees none of them');
select t_materials.expect_error(format('insert into public.service_materials (company_id, service_id, item_number, name, uom, per_unit) values (%L, %L, %L, %L, %L, 1)', :'other', :'roof', 'X', 'Theirs', 'BD'), 'or puts its own on someone else''s service');
commit;

-- ===== A service takes its materials with it ===================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab5c0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t_materials.check((select per_unit = 3.333 from public.service_materials where id = :'shingles'), 'the crew''s change didn''t land');
delete from public.quote_line_items where id = :'line';
delete from public.services where id = :'roof';
select t_materials.check((select count(*) from public.service_materials where company_id = :'co') = 0, 'deleting the service deletes its materials');
commit;

\o
\echo 'All material price tests passed.'
