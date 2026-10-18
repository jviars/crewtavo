-- Database tests for Stripe and the office's payments (20261019001010_stripe_office.sql): a payment
-- that's only a tip (and the refund of one), when a bank payment on its way started and who sees
-- it, and what the office is told to do about a payment on an invoice made in Stripe, with the
-- credit note it issues there counted here once the invoice is paid.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tstripeoffice;
grant usage on schema tstripeoffice to authenticated, service_role;
create function tstripeoffice.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tstripeoffice.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function tstripeoffice.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlerrm; end;
  return null;
end $$;
grant execute on all functions in schema tstripeoffice to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('5c000000-0000-0000-0000-000000000001', 'owner@tipline.test', '{"full_name": "Tia Owner"}'),
  ('5c000000-0000-0000-0000-000000000002', 'office@tipline.test', '{"full_name": "Ollie Office"}'),
  ('5c000000-0000-0000-0000-000000000003', 'crew@tipline.test', '{"full_name": "Cal Crew"}'),
  ('5c000000-0000-0000-0000-000000000004', 'dispatch@tipline.test', '{"full_name": "Dot Dispatch"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5c000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Tipline Lawns', 'lawn_care') as co \gset
-- A dispatcher works in the office but doesn't see invoices.
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule}') returning id as dispatcher \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', '5c000000-0000-0000-0000-000000000002', 'office', null),
  (:'co', '5c000000-0000-0000-0000-000000000003', 'field_crew', null),
  (:'co', '5c000000-0000-0000-0000-000000000004', 'office', :'dispatcher');
insert into public.clients (company_id, display_name, email) values (:'co', 'Pat Client', 'pat@tipline.test') returning id as client \gset
commit;

-- The office sends three invoices.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5c000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Mowing') returning id as credited_inv \gset
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Edging') returning id as tipped_inv \gset
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Cleanup') returning id as void_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values
  (:'co', :'credited_inv', 'Mowing', 160), (:'co', :'tipped_inv', 'Edging', 80), (:'co', :'void_inv', 'Cleanup', 40);
update public.invoices set status = 'sent' where id in (:'credited_inv', :'tipped_inv', :'void_inv');
update public.invoices set status = 'void' where id = :'void_inv';
commit;

-- ===== A payment that's only a tip =============================================================

-- Pat's credit in Stripe pays all $160, and Stripe charges only the $15 tip added in the Client Hub:
-- the API records the credit, and the charge as a payment that's only a tip.
begin;
set local role service_role;
insert into public.payments (company_id, invoice_id, client_id, amount, method, processor, processor_ref, notes, recorded_by)
values (:'co', :'credited_inv', :'client', 160, 'other', null, 'in_tipline:credit', 'Account credit in Stripe', null);
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method, processor, processor_ref, fee_amount, recorded_by)
values (:'co', :'credited_inv', :'client', 0, 15, 'card', 'stripe', 'pi_tipline', 0.74, null);
commit;
select tstripeoffice.check((select amount || '/' || tip_amount || '/' || fee_amount from public.payments where processor_ref = 'pi_tipline') = '0.00/15.00/0.74',
  'Stripe''s charge of only the tip is a payment with no amount, the tip and its fee');
select tstripeoffice.check((select status || '/' || amount_paid || '/' || balance_due from public.invoices where id = :'credited_inv') = 'paid/160.00/0.00',
  'and the invoice is paid by the credit alone');

-- A tip on its own doesn't change what's owed.
begin;
set local role service_role;
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method, processor, processor_ref, recorded_by)
values (:'co', :'tipped_inv', :'client', 0, 10, 'card', 'stripe', 'pi_tipline_2', null);
commit;
select tstripeoffice.check((select status || '/' || amount_paid || '/' || balance_due from public.invoices where id = :'tipped_inv') = 'sent/0.00/80.00',
  'a payment that''s only a tip leaves the invoice owed as it was');
select tstripeoffice.check(not exists (select 1 from public.activity where verb = 'payment.received' and (data ->> 'amount')::numeric = 0),
  'and isn''t news as a $0.00 payment');

-- Refunded (or lost in a dispute), the tip goes back with no amount.
begin;
set local role service_role;
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method, processor, processor_ref, notes, recorded_by)
values (:'co', :'credited_inv', :'client', 0, -15, 'card', 'stripe', 'pi_tipline:refund:1500', 'Refunded in Stripe', null);
commit;
select tstripeoffice.check((select sum(tip_amount) from public.payments where invoice_id = :'credited_inv') = 0, 'a refund of a tip-only payment gives back the tip');
select tstripeoffice.check((select status || '/' || balance_due from public.invoices where id = :'credited_inv') = 'paid/0.00', 'and the invoice stays paid');

-- But a payment is still something, and a tip still goes the way of its payment.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5c000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tstripeoffice.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount) values (%L, %L, %L, 0, 0)', :'co', :'tipped_inv', :'client'), 'a payment of nothing isn''t one');
select tstripeoffice.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount) values (%L, %L, %L, 50, -5)', :'co', :'tipped_inv', :'client'), 'a payment still can''t carry a negative tip');
select tstripeoffice.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount) values (%L, %L, %L, -20, 5)', :'co', :'tipped_inv', :'client'), 'nor a refund add one');
-- And none goes on a void invoice, tip or not (payments_not_void).
select tstripeoffice.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount) values (%L, %L, %L, 0, 5)', :'co', :'void_inv', :'client'), 'a tip on its own isn''t added to a void invoice either');
commit;
select tstripeoffice.check((select bool_and(convalidated) from pg_constraint where conname in ('payments_amount_check', 'payments_tip_amount_check')) and
  (select count(*) from pg_constraint where conname in ('payments_amount_check', 'payments_tip_amount_check') and conrelid = 'public.payments'::regclass) = 2,
  'every payment on record follows the rules');

-- ===== When a bank payment on its way started ==================================================

reset role;
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, processing_at)
values (:'co', :'tipped_inv', 'in_tipline_bank', 'crewtavo', 'processing', 80, '2026-10-03 15:00+00');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5c000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tstripeoffice.check((select processing_at from public.stripe_invoices where invoice_id = :'tipped_inv') = '2026-10-03 15:00+00',
  'the office sees when a bank payment for an invoice started');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5c000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tstripeoffice.check((select count(*) from public.stripe_invoices) = 0, 'the crew doesn''t');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5c000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tstripeoffice.check((select count(*) from public.stripe_invoices) = 0, 'nor does someone in the office whose role doesn''t see invoices');
commit;

-- ===== Payments on an invoice made in Stripe ===================================================

reset role;
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_made', 'number', 'TL-0001', 'status', 'open', 'amount_due', 160,
  'customer', jsonb_build_object('id', 'cus_pat', 'email', 'pat@tipline.test'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Spring cleanup', 'quantity', 1, 'unit_price', 160))
)) as made \gset

-- Pat pays $50 of it by check. Recorded here, Stripe would still ask for all $160.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5c000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tstripeoffice.check(tstripeoffice.error_of(format('insert into public.payments (company_id, client_id, invoice_id, amount, method) values (%L, %L, %L, 50, %L)', :'co', :'client', :'made', 'check'))
  = 'This invoice was made in Stripe, so record its payments there. If the client paid all of it, mark it paid in Stripe. If they paid part, issue a credit note in Stripe for what they paid, so Stripe asks for only the rest. Either way it shows up here once the invoice is paid there',
  'a payment on an invoice made in Stripe is refused with what to do in Stripe instead');
commit;

-- So the office takes the $50 off in Stripe with a credit note, and Pat pays the other $110 there.
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_made', 'status', 'paid', 'amount_due', 110,
  'payment', jsonb_build_object('amount', 110, 'method', 'card', 'processor_ref', 'pi_tl_made', 'received_at', now(), 'credited', 50)
));
select tstripeoffice.check((select status || '/' || amount_paid || '/' || balance_due from public.invoices where id = :'made') = 'paid/160.00/0.00',
  'paid in Stripe after a credit note, the invoice is paid here too');
select tstripeoffice.check((select string_agg(amount || ' ' || method || ' ' || coalesce(nullif(notes, ''), '-'), ', ' order by amount desc) from public.payments where invoice_id = :'made')
  = '110.00 card -, 50.00 other Credit note in Stripe', 'with Stripe''s payment and the credit note');
-- Stripe repeating itself changes nothing.
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_made', 'status', 'paid', 'amount_due', 110,
  'payment', jsonb_build_object('amount', 110, 'method', 'card', 'processor_ref', 'pi_tl_made', 'received_at', now(), 'credited', 50)
));
select tstripeoffice.check((select count(*) from public.payments where invoice_id = :'made') = 2, 'and it''s counted once');

-- One brought in after its credit note has it among its lines already, so it isn't counted twice.
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_late', 'status', 'open', 'amount_due', 110,
  'customer', jsonb_build_object('id', 'cus_pat'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Hedges', 'quantity', 1, 'unit_price', 160), jsonb_build_object('name', 'Account credit applied', 'quantity', 1, 'unit_price', -50))
)) as late \gset
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_late', 'status', 'paid', 'amount_due', 110,
  'payment', jsonb_build_object('amount', 110, 'method', 'card', 'processor_ref', 'pi_tl_late', 'received_at', now(), 'credited', 50)
));
select tstripeoffice.check((select i.status || '/' || i.amount_paid || '/' || i.balance_due || '/' || (select count(*) from public.payments p where p.invoice_id = i.id) from public.invoices i where i.id = :'late') = 'paid/110.00/0.00/1',
  'one brought in after its credit note isn''t paid twice');

-- A credit note for all of it has Stripe mark it paid with nothing charged; marked paid there for a
-- check after a credit note for part, it comes in as both.
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_free', 'status', 'open', 'amount_due', 90, 'customer', jsonb_build_object('id', 'cus_pat'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Raking', 'quantity', 1, 'unit_price', 90))
)) as free \gset
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_free', 'status', 'paid', 'amount_due', 0,
  'payment', jsonb_build_object('amount', 0, 'method', 'card', 'processor_ref', 'pi_tl_free', 'received_at', now(), 'credited', 90)
));
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_check', 'status', 'open', 'amount_due', 120, 'customer', jsonb_build_object('id', 'cus_pat'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Aeration', 'quantity', 1, 'unit_price', 120))
)) as by_check \gset
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_tl_check', 'status', 'paid', 'amount_due', 80,
  'payment', jsonb_build_object('amount', 80, 'method', 'other', 'processor_ref', 'in_tl_check:paid', 'received_at', now(), 'out_of_band', true, 'credited', 40)
));
select tstripeoffice.check((select string_agg(status || '/' || balance_due, ', ' order by number) from public.invoices where id in (:'free', :'by_check')) = 'paid/0.00, paid/0.00',
  'a credit note for all of it, or one with the rest marked paid in Stripe, pays it here');
select tstripeoffice.check((select string_agg(amount || ' ' || coalesce(nullif(notes, ''), '-'), ', ' order by amount desc) from public.payments where invoice_id = :'by_check')
  = '80.00 Marked paid in Stripe, 40.00 Credit note in Stripe', 'as what was marked paid and the credit note');

\echo 'All Stripe office tests passed.'
