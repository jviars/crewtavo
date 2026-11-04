-- Database tests for custom fields (20261103000700_custom_fields): the team reads a business's
-- fields, the office with the Settings area changes them, another business sees none; a field's key
-- stays and is never source_id; values are an object on each record, changed under that record's own
-- rules; and a quote's values carry on to its job and invoice when the field is on both.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_cf;
grant usage on schema t_cf to authenticated, service_role;
create function t_cf.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_cf.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function t_cf.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on all functions in schema t_cf to authenticated, service_role;

-- Olive owns Fennel Pools; Otto is in her office, Bea bills without the Settings area, Finn is crew;
-- Nora owns Nutmeg Decks.
insert into auth.users (id, email, raw_user_meta_data) values
  ('cf1e0000-0000-0000-0000-000000000001', 'olive@fennel-pools.test', '{"full_name": "Olive Fennel"}'),
  ('cf1e0000-0000-0000-0000-000000000002', 'otto@fennel-pools.test', '{"full_name": "Otto Fennel"}'),
  ('cf1e0000-0000-0000-0000-000000000003', 'bea@fennel-pools.test', '{"full_name": "Bea Fennel"}'),
  ('cf1e0000-0000-0000-0000-000000000004', 'finn@fennel-pools.test', '{"full_name": "Finn Fennel"}'),
  ('cf1e0000-0000-0000-0000-000000000009', 'nora@nutmeg-decks.test', '{"full_name": "Nora Nutmeg"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf1e0000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Nutmeg Decks', 'general') as other \gset
insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (:'other', 'client', 'nutmeg_gate', 'Nutmeg gate', 'text');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf1e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Fennel Pools', 'general') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Fennel billing clerk', 'office', '{sales,invoices}') returning id as clerk \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'cf1e0000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'cf1e0000-0000-0000-0000-000000000004', 'field_crew');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', 'cf1e0000-0000-0000-0000-000000000003', 'office', :'clerk');

-- The fields: a permit on quotes, jobs and invoices; a unit on quotes and jobs; a quote-only note;
-- a volume that's a number on quotes but text on jobs; a gate code on properties.
insert into public.custom_field_definitions (company_id, record_type, key, label, type, choices, show_on_pdf, show_in_portal, sort) values
  (:'co', 'quote', 'permit', 'Permit number', 'text', '{}', true, true, 0),
  (:'co', 'job', 'permit', 'Permit number', 'text', '{}', false, false, 0),
  (:'co', 'invoice', 'permit', 'Permit number', 'text', '{}', true, false, 0),
  (:'co', 'quote', 'unit', 'Unit', 'choice', '{Heat pump,Furnace}', false, false, 1),
  (:'co', 'job', 'unit', 'Unit', 'choice', '{Heat pump,Furnace}', false, false, 1),
  (:'co', 'invoice', 'unit', 'Unit', 'choice', '{Heat pump,Furnace}', false, false, 1),
  (:'co', 'quote', 'quote_note', 'Quote note', 'text', '{}', false, false, 2),
  (:'co', 'invoice', 'quote_note', 'Quote note', 'text', '{}', false, false, 2),
  (:'co', 'quote', 'volume', 'Pool volume', 'number', '{}', false, false, 3),
  (:'co', 'job', 'volume', 'Pool volume', 'text', '{}', false, false, 3),
  (:'co', 'property', 'gate_code', 'Gate code', 'text', '{}', false, false, 0);
select t_cf.check((select count(*) = 11 from public.custom_field_definitions where company_id = :'co'), 'the owner adds fields to each kind of record');

select t_cf.expect_error(format('insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (%L, %L, %L, %L, %L)', :'co', 'client', 'source_id', 'Old ID', 'text'),
  'no field takes the import''s source_id');
select t_cf.expect_error(format('insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (%L, %L, %L, %L, %L)', :'co', 'client', 'Gate Code', 'Gate code', 'text'),
  'a key is lowercase letters, numbers and underscores');
select t_cf.expect_error(format('insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (%L, %L, %L, %L, %L)', :'co', 'quote', 'permit', 'Permit again', 'text'),
  'a key is used once on each kind of record');
select t_cf.expect_error(format('insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (%L, %L, %L, %L, %L)', :'co', 'job', 'size', 'Size', 'choice'),
  'a choice field needs its choices');
select t_cf.expect_error(format('insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (%L, %L, %L, %L, %L)', :'co', 'visit', 'crew_note', 'Crew note', 'text'),
  'only clients, properties, jobs, quotes and invoices have fields');
select t_cf.expect_error(format('update public.custom_field_definitions set key = %L where company_id = %L and record_type = %L and key = %L', 'permit_no', :'co', 'job', 'permit'),
  'a field''s key never changes');
select t_cf.expect_error(format('update public.custom_field_definitions set record_type = %L where company_id = %L and record_type = %L and key = %L', 'client', :'co', 'job', 'permit'),
  'nor what it''s on');
update public.custom_field_definitions set label = 'Permit #', sort = 5 where company_id = :'co' and record_type = 'job' and key = 'permit';
select t_cf.check((select label = 'Permit #' from public.custom_field_definitions where company_id = :'co' and record_type = 'job' and key = 'permit'), 'its label and order do');

insert into public.clients (company_id, display_name, custom_fields) values (:'co', 'Fennel client Ivy', '{"source_id": "J-77"}') returning id as client \gset
insert into public.properties (company_id, client_id, line1, custom_fields) values (:'co', :'client', '4 Fennel Way', '{"gate_code": "4821"}') returning id as home \gset
select t_cf.expect_error(format('update public.clients set custom_fields = %L where id = %L', '["x"]', :'client'), 'a record''s values are an object');
select t_cf.expect_error(format('update public.properties set custom_fields = %L where id = %L', '"x"', :'home'), 'on properties too');

-- ===== Carried forward ==========================================================================
insert into public.quotes (company_id, client_id, property_id, title, custom_fields)
values (:'co', :'client', :'home', 'Fennel heater swap', '{"permit": "P-100", "unit": "Furnace", "quote_note": "Side gate", "volume": 18000, "gone": "not a field"}') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (:'co', :'quote', 'Fennel heater', 1, 2400);
select public.convert_quote_to_job(:'quote') as job \gset
select t_cf.check((select custom_fields = '{"permit": "P-100", "unit": "Furnace"}' from public.jobs where id = :'job'),
  'a quote''s values go to its job when the field is on both, as the same type: ' || (select custom_fields::text from public.jobs where id = :'job'));
update public.jobs set custom_fields = custom_fields || '{"permit": "P-101"}' where id = :'job';
update public.custom_field_definitions set archived_at = now() where company_id = :'co' and record_type = 'invoice' and key = 'unit';
select public.create_invoice_for_job(:'job') as invoice \gset
select t_cf.check((select custom_fields = '{"permit": "P-101", "quote_note": "Side gate"}' from public.invoices where id = :'invoice'),
  'an invoice gets its job''s values, and its quote''s for a field the job hasn''t, but not an archived field''s: ' || (select custom_fields::text from public.invoices where id = :'invoice'));
insert into public.jobs (company_id, client_id, title, custom_fields) values (:'co', :'client', 'Fennel opening', '{"permit": "P-200"}') returning id as own_job \gset
select t_cf.check((select custom_fields = '{"permit": "P-200"}' from public.jobs where id = :'own_job'), 'a job made by hand keeps the values it was given');
insert into public.invoices (company_id, client_id, job_id, issued_on, custom_fields) values (:'co', :'client', :'job', current_date, '{"permit": "Mine"}') returning id as own_invoice \gset
select t_cf.check((select custom_fields ->> 'permit' = 'Mine' from public.invoices where id = :'own_invoice'), 'a value the new record is given wins over the carried one');
commit;

-- ===== The office, with and without Settings, and the crew =====================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf1e0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (:'co', 'client', 'pets', 'Pets on site', 'yes_no');
update public.custom_field_definitions set show_in_portal = true where company_id = :'co' and record_type = 'client' and key = 'pets';
select t_cf.check((select show_in_portal from public.custom_field_definitions where company_id = :'co' and record_type = 'client' and key = 'pets'), 'the office with Settings adds and changes fields');
update public.clients set custom_fields = custom_fields || '{"pets": true}' where id = :'client';
select t_cf.check((select custom_fields = '{"source_id": "J-77", "pets": true}' from public.clients where id = :'client'), 'and sets a client''s values, keeping its source_id');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf1e0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t_cf.check((select count(*) = 12 from public.custom_field_definitions), 'Bea, without the Settings area, reads the fields');
select t_cf.expect_error(format('insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (%L, %L, %L, %L, %L)', :'co', 'client', 'bea_field', 'Bea field', 'text'),
  'but can''t add one');
select t_cf.check(t_cf.changed(format('update public.custom_field_definitions set label = %L where company_id = %L', 'Changed', :'co')) = 0, 'or change one');
select t_cf.check(t_cf.changed(format('delete from public.custom_field_definitions where company_id = %L', :'co')) = 0, 'or delete one');
update public.invoices set custom_fields = custom_fields || '{"permit": "P-102"}' where id = :'invoice';
select t_cf.check((select custom_fields ->> 'permit' = 'P-102' from public.invoices where id = :'invoice'), 'she sets an invoice''s values, as she can change the invoice');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf1e0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_cf.check((select count(*) = 12 from public.custom_field_definitions), 'Finn on the crew reads the fields too');
select t_cf.expect_error(format('insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (%L, %L, %L, %L, %L)', :'co', 'job', 'finn_field', 'Finn field', 'text'),
  'but can''t add one');
select t_cf.check(t_cf.changed(format('update public.jobs set custom_fields = %L where company_id = %L', '{"permit": "crew"}', :'co')) = 0, 'and can''t change a job''s values (crews don''t change jobs)');
select t_cf.check(t_cf.changed(format('update public.properties set custom_fields = %L where id = %L', '{"gate_code": "0000"}', :'home')) = 0, 'or a property''s');
commit;
select t_cf.check((select custom_fields ->> 'permit' = 'P-101' from public.jobs where id = :'job') and (select custom_fields ->> 'gate_code' = '4821' from public.properties where id = :'home'),
  'so they''re as the office left them');

-- ===== Another business =========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "cf1e0000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select t_cf.check((select array_agg(key) from public.custom_field_definitions) = '{nutmeg_gate}', 'Nora sees only her own business''s fields');
select t_cf.expect_error(format('insert into public.custom_field_definitions (company_id, record_type, key, label, type) values (%L, %L, %L, %L, %L)', :'co', 'client', 'nora_field', 'Nora field', 'text'),
  'and can''t add one to another business');
select t_cf.check(t_cf.changed(format('update public.custom_field_definitions set label = %L where company_id = %L', 'Nora was here', :'co')) = 0, 'or change one');
commit;
select t_cf.check((select count(*) = 0 from public.custom_field_definitions where company_id = :'co' and label = 'Nora was here'), 'so another business''s fields are as they were');

\echo 'All custom field tests passed.'
