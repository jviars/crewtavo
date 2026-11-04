-- Database tests for time and materials (20261104000300_time_and_materials.sql): a job's finished
-- hours and logged materials go on its invoice once, not someone else's job's, not a running clock
-- or a break, not on a deposit; taking the line off or voiding the invoice frees them; another
-- business can't see or bill them; and a material logged without a unit is "ea".
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tam;
grant usage on schema tam to authenticated, service_role;
create function tam.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tam.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tam to authenticated, service_role;

-- Mo owns Maple Mechanical; Vi owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c4130000-0000-0000-0000-000000000001', 'mo@maple.test', '{"full_name": "Mo Maple"}'),
  ('c4130000-0000-0000-0000-000000000009', 'vi@vale.test', '{"full_name": "Vi Vale"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4130000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Vale Heating', 'general') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Val') returning id as val \gset
insert into public.jobs (company_id, client_id, title) values (:'other', :'val', 'Furnace') returning id as other_job \gset
insert into public.invoices (company_id, client_id, job_id) values (:'other', :'val', :'other_job') returning id as other_inv \gset
select set_config('request.jwt.claims', '{"sub": "c4130000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Maple Mechanical', 'general') as co \gset
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Copper pipe', 'ft', 4) returning id as pipe \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ray Reed') returning id as ray \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'ray', 'Boiler repair') returning id as job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'job', 'Diagnosis', 1, 'ea', 100);
insert into public.jobs (company_id, client_id, title) values (:'co', :'ray', 'Thermostat') returning id as job2 \gset
insert into public.time_entries (company_id, user_id, job_id, started_at, ended_at) values
  (:'co', 'c4130000-0000-0000-0000-000000000001', :'job', now() - interval '6 hours', now() - interval '3 hours') returning id as worked \gset
insert into public.time_entries (company_id, user_id, job_id, started_at, ended_at) values
  (:'co', 'c4130000-0000-0000-0000-000000000001', :'job', now() - interval '30 hours', now() - interval '28 hours') returning id as worked2 \gset
insert into public.time_entries (company_id, user_id, job_id, category, started_at, ended_at) values
  (:'co', 'c4130000-0000-0000-0000-000000000001', :'job', 'break', now() - interval '3 hours', now() - interval '150 minutes') returning id as lunch \gset
insert into public.time_entries (company_id, user_id, job_id, started_at, ended_at) values
  (:'co', 'c4130000-0000-0000-0000-000000000001', :'job2', now() - interval '50 hours', now() - interval '49 hours') returning id as elsewhere \gset
insert into public.time_entries (company_id, user_id, job_id, started_at) values
  (:'co', 'c4130000-0000-0000-0000-000000000001', :'job', now() - interval '1 hour') returning id as running \gset
insert into public.job_materials (company_id, job_id, service_id, name, quantity, logged_by) values
  (:'co', :'job', :'pipe', 'Copper pipe', 20, 'c4130000-0000-0000-0000-000000000001') returning id as copper \gset
insert into public.job_materials (company_id, job_id, name, quantity, logged_by) values
  (:'co', :'job', 'Gasket kit', 1, 'c4130000-0000-0000-0000-000000000001') returning id as gasket \gset
commit;

select tam.check((select unit = 'ea' from public.job_materials where id = :'gasket'), 'a material logged without a unit is "ea"');

-- ===== Billing them ============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4130000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_invoice_for_job(:'job') as inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, time_entry_ids) values
  (:'co', :'inv', 'Labor', 5, 'hr', 75, array[:'worked', :'worked2']::uuid[]);
insert into public.invoice_line_items (company_id, invoice_id, service_id, name, quantity, unit, unit_price, material_ids) values
  (:'co', :'inv', :'pipe', 'Copper pipe', 20, 'ft', 4, array[:'copper']::uuid[]);
select tam.check((select subtotal = 555 from public.invoices where id = :'inv'), 'the job''s hours and materials go on its invoice');
select tam.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, time_entry_ids) values (%L, %L, %L, 3, 75, array[%L]::uuid[])', :'co', :'inv', 'Labor', :'worked'),
  'the same hours can''t go on twice');
select tam.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, time_entry_ids) values (%L, %L, %L, 1, 75, array[%L]::uuid[])', :'co', :'inv', 'Labor', :'running'),
  'nor a clock that''s still running');
select tam.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, time_entry_ids) values (%L, %L, %L, 1, 75, array[%L]::uuid[])', :'co', :'inv', 'Labor', :'lunch'),
  'nor a break');
select tam.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, time_entry_ids) values (%L, %L, %L, 1, 75, array[%L]::uuid[])', :'co', :'inv', 'Labor', :'elsewhere'),
  'nor another job''s hours');
select public.create_invoice_for_job(:'job', 'deposit', 50) as deposit \gset
select tam.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, material_ids) values (%L, %L, %L, 1, 10, array[%L]::uuid[])', :'co', :'deposit', 'Gasket kit', :'gasket'),
  'nor on a deposit');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4130000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- The labor line taken off frees those hours; the invoice voided frees the pipe.
delete from public.invoice_line_items where invoice_id = :'inv' and name = 'Labor';
update public.invoices set status = 'void' where id = :'inv';
insert into public.invoices (company_id, client_id, job_id) values (:'co', :'ray', :'job') returning id as again \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, time_entry_ids) values (:'co', :'again', 'Labor', 3, 'hr', 75, array[:'worked']::uuid[]);
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, material_ids) values (:'co', :'again', 'Copper pipe', 20, 'ft', 4, array[:'copper']::uuid[]);
select tam.check((select count(*) = 2 from public.invoice_line_items where invoice_id = :'again' and (time_entry_ids is not null or material_ids is not null)),
  'hours whose line came off, and materials on a void invoice, can be billed again');
commit;

-- ===== Another business ========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4130000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select tam.check((select count(*) = 0 from public.invoice_line_items where invoice_id = :'again'), 'another business can''t see what was billed');
select tam.check((select count(*) = 0 from public.time_entries where id = :'worked2') and (select count(*) = 0 from public.job_materials where id = :'gasket'), 'or the hours and materials');
select tam.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, time_entry_ids) values (%L, %L, %L, 2, 75, array[%L]::uuid[])', :'other', :'other_inv', 'Labor', :'worked2'),
  'or bill Maple''s hours on its own invoice');
update public.invoice_line_items set time_entry_ids = null where invoice_id = :'again';
commit;
select tam.check((select count(*) = 1 from public.invoice_line_items where invoice_id = :'again' and time_entry_ids is not null), 'or change Maple''s lines');

\echo 'All time and materials tests passed.'
