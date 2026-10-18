-- Database tests for money and Stripe invoices: a draft isn't deleted while Stripe still has it open
-- (or a bank payment is on its way), payments on an invoice made in Stripe are recorded there, and
-- customers brought in from Stripe get their billing address in the app's shape.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tstripemoney;
grant usage on schema tstripemoney to authenticated, service_role;
create function tstripemoney.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tstripemoney.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function tstripemoney.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlerrm; end;
  return null;
end $$;
grant execute on all functions in schema tstripemoney to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('5b000000-0000-0000-0000-000000000001', 'owner@moneyline.test', '{"full_name": "Mo Owner"}'),
  ('5b000000-0000-0000-0000-000000000002', 'office@moneyline.test', '{"full_name": "Oli Office"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Moneyline Lawns', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', '5b000000-0000-0000-0000-000000000002', 'office');
insert into public.clients (company_id, display_name, email) values (:'co', 'Dee Client', 'dee@moneyline.test') returning id as client \gset
insert into public.clients (company_id, display_name) values (:'co', 'Gone Soon') returning id as gone \gset
commit;

reset role;
insert into public.integrations (company_id, provider, status) values (:'co', 'stripe', 'connected');

-- ===== A draft with a live Stripe invoice ======================================================

-- The office sends three invoices.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Mowing') returning id as open_inv \gset
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Edging') returning id as bank_inv \gset
insert into public.invoices (company_id, client_id, subject) values (:'co', :'gone', 'Cleanup') returning id as gone_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values
  (:'co', :'open_inv', 'Mowing', 100), (:'co', :'bank_inv', 'Edging', 60), (:'co', :'gone_inv', 'Cleanup', 80);
update public.invoices set status = 'sent' where id in (:'open_inv', :'bank_inv', :'gone_inv');
commit;

-- Stripe has them, as the API makes them when they're sent: two open, and one with a bank payment
-- on its way.
reset role;
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, hosted_url) values
  (:'co', :'open_inv', 'in_open', 'crewtavo', 'open', 100, 'https://invoice.stripe.test/open'),
  (:'co', :'bank_inv', 'in_bank', 'crewtavo', 'processing', 60, 'https://invoice.stripe.test/bank'),
  (:'co', :'gone_inv', 'in_gone', 'crewtavo', 'open', 80, 'https://invoice.stripe.test/gone');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.invoices set status = 'draft', sent_at = null where id in (:'open_inv', :'bank_inv', :'gone_inv');
select tstripemoney.check((select count(*) from public.invoices where id in (:'open_inv', :'bank_inv', :'gone_inv') and status = 'draft') = 3, 'a sent invoice can go back to draft');
select tstripemoney.expect_error(format('delete from public.invoices where id = %L', :'open_inv'), 'but isn''t deleted while Stripe still has it open for the client to pay');
select tstripemoney.expect_error(format('delete from public.invoices where id = %L', :'bank_inv'), 'or while a bank payment for it is on its way');
select tstripemoney.expect_error(format('delete from public.clients where id = %L', :'gone'), 'and its client isn''t deleted with it either');
commit;

-- The Stripe sync voids the open ones (the move back to draft queued it). Then they go.
reset role;
select tstripemoney.check((select count(*) from public.outbox where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'open_inv' and done_at is null) = 1, 'going back to draft queued the Stripe invoice to be voided');
update public.stripe_invoices set status = 'void' where stripe_id in ('in_open', 'in_gone');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
delete from public.invoices where id = :'open_inv';
delete from public.clients where id = :'gone';
select tstripemoney.check((select count(*) from public.invoices where id in (:'open_inv', :'gone_inv')) = 0, 'once Stripe''s invoice is voided, the draft can be deleted');
commit;

-- A bank payment clearing in a Stripe account Crewtavo has since left isn't followed any more.
reset role;
update public.stripe_invoices set detached_at = now() where stripe_id = 'in_bank';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
delete from public.invoices where id = :'bank_inv';
select tstripemoney.check((select count(*) from public.invoices where id = :'bank_inv') = 0, 'and one only a Stripe account Crewtavo left still has can be deleted');
commit;

-- When Stripe's isn't voided (Stripe stopped answering Crewtavo: its key was revoked there, say),
-- the draft says what to do instead.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Raking') returning id as stuck_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'stuck_inv', 'Raking', 45);
update public.invoices set status = 'sent' where id = :'stuck_inv';
commit;
reset role;
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due) values (:'co', :'stuck_inv', 'in_stuck', 'crewtavo', 'open', 45);
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.invoices set status = 'draft', sent_at = null where id = :'stuck_inv';
select tstripemoney.check(tstripemoney.error_of(format('delete from public.invoices where id = %L', :'stuck_inv')) like '%If it isn''t, void this invoice instead',
  'a draft Stripe still has open says to void it if it can''t be deleted');
update public.invoices set status = 'void' where id = :'stuck_inv';
select tstripemoney.check((select status from public.invoices where id = :'stuck_inv') = 'void', 'and it can be voided');
commit;

-- ===== Payments on an invoice made in Stripe ===================================================

reset role;
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_made', 'number', 'ML-0001', 'status', 'open', 'amount_due', 300, 'hosted_url', 'https://invoice.stripe.test/made',
  'customer', jsonb_build_object('id', 'cus_dee', 'email', 'dee@moneyline.test'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Spring cleanup', 'quantity', 1, 'unit_price', 300))
)) as made \gset
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_left', 'number', 'ML-0002', 'status', 'open', 'amount_due', 50,
  'customer', jsonb_build_object('id', 'cus_dee'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Edging', 'quantity', 1, 'unit_price', 50))
)) as left_behind \gset
-- One in a Stripe account Crewtavo has since left.
update public.stripe_invoices set detached_at = now() where stripe_id = 'in_left';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Hedges') returning id as own \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'own', 'Hedges', 120);
update public.invoices set status = 'sent' where id = :'own';
commit;
reset role;
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due) values (:'co', :'own', 'in_own', 'crewtavo', 'open', 120);
update public.outbox set done_at = now() where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'own';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5b000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
-- Stripe asks the client for all $300, so a check recorded here would have them pay twice.
select tstripemoney.expect_error(
  format('insert into public.payments (company_id, client_id, invoice_id, amount, method) values (%L, %L, %L, 100, %L)', :'co', :'client', :'made', 'check'),
  'a payment on an invoice made in Stripe is recorded there, not here');
insert into public.payments (company_id, client_id, amount, method, notes) values (:'co', :'client', 100, 'check', 'Not for any invoice yet') returning id as loose \gset
select tstripemoney.expect_error(format('update public.payments set invoice_id = %L where id = %L', :'made', :'loose'), 'nor moved onto one');
-- A Crewtavo invoice in Stripe takes it here, and its Stripe invoice is redone for what's left.
update public.payments set invoice_id = :'own' where id = :'loose';
select tstripemoney.check((select balance_due from public.invoices where id = :'own') = 20, 'a Crewtavo invoice in Stripe takes payments here as before');
-- So does one made in a Stripe account Crewtavo has left.
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'client', :'left_behind', 50, 'cash');
select tstripemoney.check((select status from public.invoices where id = :'left_behind') = 'paid', 'and one made in a Stripe account Crewtavo left');
commit;

reset role;
select tstripemoney.check((select count(*) from public.outbox where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'own' and done_at is null) = 1, 'a payment on a Crewtavo invoice queues its Stripe invoice to be replaced');

-- Stripe's own webhook still records the payment.
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_made', 'status', 'paid', 'amount_due', 300,
  'payment', jsonb_build_object('amount', 300, 'method', 'card', 'processor_ref', 'pi_made', 'received_at', now())
));
select tstripemoney.check((select status || '/' || amount_paid || '/' || balance_due from public.invoices where id = :'made') = 'paid/300.00/0.00', 'paid in Stripe, the invoice is paid once');

-- ===== Billing addresses of customers from Stripe ==============================================

select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_addr', 'status', 'open', 'amount_due', 40,
  'customer', jsonb_build_object('id', 'cus_rita', 'name', 'Rita Rivers', 'email', 'rita@rivers.test',
    'address', jsonb_build_object('line1', '12 River Rd', 'line2', null, 'city', 'Springfield', 'state', 'IL', 'postal_code', '62701', 'country', 'US')),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Mowing', 'quantity', 1, 'unit_price', 40))
)) as rita_inv \gset
select tstripemoney.check(
  (select c.billing_address from public.clients c join public.invoices i on i.client_id = c.id where i.id = :'rita_inv')
    = '{"line1": "12 River Rd", "city": "Springfield", "region": "IL", "postal_code": "62701", "country": "US"}'::jsonb,
  'a customer from Stripe gets their billing address the way the app keeps it (the state as its region)');
select tstripemoney.check((select region from public.properties p join public.invoices i on i.client_id = p.client_id where i.id = :'rita_inv') = 'IL', 'and the same address as their property');

select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_noaddr', 'status', 'open', 'amount_due', 40,
  'customer', jsonb_build_object('id', 'cus_new', 'email', 'new@person.test', 'address', null),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Mowing', 'quantity', 1, 'unit_price', 40))
)) as new_inv \gset
select tstripemoney.check((select c.billing_address from public.clients c join public.invoices i on i.client_id = c.id where i.id = :'new_inv') = '{}'::jsonb, 'one with no address in Stripe gets none, not a JSON null');

-- Clients brought in before this were repaired the same way, including one the office edited since.
select tstripemoney.check(private.stripe_billing_address('{"line1": "12 River Rd", "city": "Springfield", "region": "", "postal_code": "62701", "line2": null, "state": "IL", "country": "US"}')
  = '{"line1": "12 River Rd", "city": "Springfield", "region": "IL", "postal_code": "62701", "country": "US"}'::jsonb, 'an address brought in from Stripe before reads as the app''s');
select tstripemoney.check(private.stripe_billing_address('null') = '{}'::jsonb, 'and a JSON null as no address');
select tstripemoney.check(private.stripe_billing_address('{"line1": "1 Elm St", "city": "Dover", "region": "DE", "postal_code": "19901"}') = '{"line1": "1 Elm St", "city": "Dover", "region": "DE", "postal_code": "19901"}'::jsonb, 'while one already in the app''s shape stays as it was');

\echo 'All Stripe money tests passed.'
