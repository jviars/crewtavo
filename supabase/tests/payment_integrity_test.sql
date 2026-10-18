-- Database tests for payment integrity and edit rights (20261018000600_payment_integrity.sql):
-- payments and void invoices, a payment's client, tips on refunds, when material was logged, and
-- whose time an entry is. Run with scripts/test-db.sh (plain Postgres + prelude.sql).
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t27;
grant usage on schema t27 to authenticated, service_role;
create function t27.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t27.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t27 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c7000000-0000-0000-0000-000000000001', 'owner@kilo.test', '{"full_name": "Kit Owner"}'),
  ('c7000000-0000-0000-0000-000000000002', 'lead@kilo.test', '{"full_name": "Lou Lead"}'),
  ('c7000000-0000-0000-0000-000000000003', 'emp@kilo.test', '{"full_name": "Eli Employee"}'),
  ('c7000000-0000-0000-0000-000000000004', 'mate@kilo.test', '{"full_name": "Max Mate"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Kilo Paving', 'paving') as co \gset
select public.create_company('Kilo Sealing', 'paving') as co2 \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c7000000-0000-0000-0000-000000000002', 'crew_lead'),
  (:'co', 'c7000000-0000-0000-0000-000000000003', 'field_crew'),
  (:'co', 'c7000000-0000-0000-0000-000000000004', 'field_crew'),
  (:'co2', 'c7000000-0000-0000-0000-000000000003', 'field_crew');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Paving', 'c7000000-0000-0000-0000-000000000002') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values
  (:'co', :'crew', 'c7000000-0000-0000-0000-000000000003'), (:'co', :'crew', 'c7000000-0000-0000-0000-000000000004');
insert into public.clients (company_id, display_name) values (:'co', 'Pine Street Church') returning id as client_a \gset
insert into public.clients (company_id, display_name) values (:'co', 'Harbor Storage') returning id as client_b \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client_a', 'Lot overlay') returning id as job \gset
insert into public.visits (company_id, job_id, title, crew_id, scheduled_on) values (:'co', :'job', 'Pave', :'crew', current_date) returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'c7000000-0000-0000-0000-000000000003');
-- Sent invoices for each client, one that was voided before anything was paid, and one that was
-- paid, refunded in full, then voided.
insert into public.invoices (company_id, client_id) values (:'co', :'client_a') returning id as inv_a \gset
insert into public.invoices (company_id, client_id) values (:'co', :'client_b') returning id as inv_b \gset
insert into public.invoices (company_id, client_id) values (:'co', :'client_a') returning id as inv_void \gset
insert into public.invoices (company_id, client_id) values (:'co', :'client_a') returning id as inv_refunded \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values
  (:'co', :'inv_a', 'Overlay', 1, 'ea', 500), (:'co', :'inv_b', 'Sealcoat', 1, 'ea', 200),
  (:'co', :'inv_void', 'Patch', 1, 'ea', 50), (:'co', :'inv_refunded', 'Patch', 1, 'ea', 80);
update public.invoices set status = 'sent' where id in (:'inv_a', :'inv_b', :'inv_void', :'inv_refunded');
update public.invoices set status = 'void' where id = :'inv_void';
insert into public.payments (company_id, invoice_id, client_id, amount, method) values (:'co', :'inv_refunded', :'client_a', 80, 'check');
insert into public.payments (company_id, invoice_id, client_id, amount, method, notes) values (:'co', :'inv_refunded', :'client_a', -80, 'check', 'Refund') returning id as refunded \gset
update public.invoices set status = 'void' where id = :'inv_refunded';
commit;

-- ===== Void invoices ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.payments (company_id, invoice_id, client_id, amount, method) values (:'co', :'inv_a', :'client_a', 100, 'check') returning id as pay \gset
select t27.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount) values (%L, %L, %L, 10)', :'co', :'inv_void', :'client_a'), 'a payment can''t be added to a void invoice');
select t27.expect_error(format('update public.payments set invoice_id = %L where id = %L', :'inv_void', :'pay'), 'or moved onto one');
select t27.check((select invoice_id from public.payments where id = :'pay') = :'inv_a', 'so it stays on its open invoice');
select t27.check((select amount_paid from public.invoices where id = :'inv_void') = 0, 'and the void invoice shows nothing paid');
update public.payments set invoice_id = :'inv_a' where id = :'refunded';
update public.payments set notes = 'Refund by check' where id = :'refunded';
select t27.check((select (invoice_id, notes) from public.payments where id = :'refunded') = (:'inv_refunded'::uuid, 'Refund'::text), 'payments on a void invoice stay as they are');
update public.payments set notes = 'Check 1042' where id = :'pay';
select t27.check((select notes from public.payments where id = :'pay') = 'Check 1042', 'payments on open invoices can still be fixed');
commit;

-- ===== A payment's client ======================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t27.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount) values (%L, %L, %L, 10)', :'co', :'inv_a', :'client_b'), 'a payment on an invoice is from that invoice''s client');
select t27.expect_error(format('update public.payments set client_id = %L where id = %L', :'client_b', :'pay'), 'and can''t be given to another client');
select t27.expect_error(format('update public.payments set invoice_id = %L where id = %L', :'inv_b', :'pay'), 'or moved to another client''s invoice');
select t27.check((select client_id from public.payments where id = :'pay') = :'client_a', 'so it stays with its client');
update public.payments set invoice_id = :'inv_b', client_id = :'client_b' where id = :'pay';
select t27.check((select amount_paid from public.invoices where id = :'inv_b') = 100, 'moving it to the other client''s invoice along with the client is fine');
update public.payments set invoice_id = :'inv_a', client_id = :'client_a' where id = :'pay';
insert into public.payments (company_id, client_id, amount, method, notes) values (:'co', :'client_b', 25, 'cash', 'Not applied yet');
select t27.check((select count(*) from public.payments where company_id = :'co' and invoice_id is null) = 1, 'a payment that isn''t on an invoice can be from anyone');
select t27.expect_error(format('update public.invoices set client_id = %L where id = %L', :'client_b', :'inv_a'), 'an invoice with payments keeps its client');
update public.invoices set client_id = :'client_a' where id = :'inv_b';
select t27.check((select client_id from public.invoices where id = :'inv_b') = :'client_a', 'one without payments can still change client');
update public.invoices set client_id = :'client_b' where id = :'inv_b';
commit;

-- ===== Tips ====================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method) values (:'co', :'inv_a', :'client_a', 50, 10, 'card') returning id as tipped \gset
select t27.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount) values (%L, %L, %L, 50, -5)', :'co', :'inv_a', :'client_a'), 'a payment can''t carry a negative tip');
select t27.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount) values (%L, %L, %L, -20, 5)', :'co', :'inv_a', :'client_a'), 'a refund can''t add a tip');
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method, notes) values (:'co', :'inv_a', :'client_a', -20, -4, 'card', 'Refund');
select t27.check((select sum(tip_amount) from public.payments where invoice_id = :'inv_a') = 6, 'a refund gives back part of the tip');
select t27.expect_error(format('update public.payments set tip_amount = -10 where id = %L', :'tipped'), 'and a tip can''t be turned around later');
commit;

-- The Stripe webhook records refunds as the service role, with the tip it gave back as a negative tip.
begin;
set local role service_role;
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method, processor, processor_ref, recorded_by)
values (:'co', :'inv_a', :'client_a', -10, -2, 'card', 'stripe', 'pi_t27:refund:1200', null);
select t27.check((select tip_amount from public.payments where processor_ref = 'pi_t27:refund:1200') = -2, 'a Stripe refund records the tip it gave back');
select t27.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, processor, processor_ref) values (%L, %L, %L, -10, 2, %L, %L)', :'co', :'inv_a', :'client_a', 'stripe', 'pi_t27:refund:1400'), 'but not as a tip added');
select t27.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, processor, processor_ref) values (%L, %L, %L, 10, %L, %L)', :'co', :'inv_a', :'client_b', 'stripe', 'pi_t27b'), 'and the server can''t record a payment from the wrong client either');
commit;
select t27.check((select convalidated from pg_constraint where conname = 'payments_tip_amount_check'), 'every payment on record follows the tip rule');

-- ===== When material was logged ================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.job_materials (company_id, job_id, visit_id, name, quantity, unit, ticket) values (:'co', :'job', :'visit', 'Surface mix', 18, 'ton', 'T-501') returning id as mat \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.job_materials set ticket = 'T-510' where id = :'mat';
select t27.check((select ticket from public.job_materials where id = :'mat') = 'T-510', 'the crew fixes their own entry the same day');
select t27.expect_error(format('update public.job_materials set logged_at = now() + interval ''30 days'' where id = %L', :'mat'), 'but can''t move when it was logged to keep it open');
select t27.check((select logged_at from public.job_materials where id = :'mat') > now() - interval '1 minute', 'so it''s open for the day it was logged, no longer');
select t27.expect_error(format('insert into public.job_materials (company_id, job_id, name, quantity, logged_at) values (%L, %L, %L, 3, now() + interval ''1 day'')', :'co', :'job', 'Tack coat'), 'nor log an entry ahead of time');
insert into public.job_materials (company_id, job_id, name, quantity, logged_at) values (:'co', :'job', 'Tack coat', 3, now() - interval '3 hours');
select t27.check((select count(*) from public.job_materials where job_id = :'job') = 2, 'material can still be logged for earlier in the day');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.job_materials set logged_at = now() - interval '2 days' where id = :'mat';
select t27.check((select logged_at from public.job_materials where id = :'mat') = now() - interval '2 days', 'the office can change when material was logged');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.job_materials set ticket = 'T-999' where id = :'mat';
select t27.check((select ticket from public.job_materials where id = :'mat') = 'T-510', 'and past the day, its author can''t edit it any more');
commit;

-- ===== Whose time an entry is ==================================================================
-- Two unapproved entries for the employee, from the office.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.time_entries (company_id, user_id, category, started_at, ended_at)
values (:'co', 'c7000000-0000-0000-0000-000000000003', 'shop', now() - interval '3 hours', now() - interval '1 hour') returning id as te \gset
insert into public.time_entries (company_id, user_id, category, started_at, ended_at)
values (:'co', 'c7000000-0000-0000-0000-000000000003', 'drive', now() - interval '5 hours', now() - interval '4 hours') returning id as te2 \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.time_entries set notes = 'Loaded the trailer' where id = :'te';
select t27.check((select notes from public.time_entries where id = :'te') = 'Loaded the trailer', 'people fix their own unapproved time');
-- An update that reads no columns (a PATCH without filters) isn't held to what its author can see
-- afterwards, so the policies alone would let this hand every unapproved entry to someone else.
select t27.expect_error(format('update public.time_entries set user_id = %L', 'c7000000-0000-0000-0000-000000000004'), 'but can''t hand it to someone else');
select t27.expect_error(format('update public.time_entries set company_id = %L where id = %L', :'co2', :'te'), 'or move it to another company they work for');
select t27.check((select count(*) from public.time_entries where id in (:'te', :'te2') and user_id = 'c7000000-0000-0000-0000-000000000003' and company_id = :'co') = 2, 'so it stays theirs, where it was');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.time_entries set ended_at = now() - interval '3 hours 30 minutes' where id = :'te2';
select t27.check((select ended_at from public.time_entries where id = :'te2') = now() - interval '3 hours 30 minutes', 'a crew lead fixes a crew member''s time');
select t27.expect_error(format('update public.time_entries set user_id = %L where id = %L', 'c7000000-0000-0000-0000-000000000004', :'te2'), 'but can''t move it to someone else either');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.time_entries set user_id = 'c7000000-0000-0000-0000-000000000004' where id = :'te2';
select t27.check((select user_id from public.time_entries where id = :'te2') = 'c7000000-0000-0000-0000-000000000004', 'the office moves time entered for the wrong person');
commit;

\echo 'All payment integrity tests passed.'
