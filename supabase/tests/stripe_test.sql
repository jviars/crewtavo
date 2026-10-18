-- Database tests for Stripe: invoices made in Stripe coming in (client matching, totals, payments,
-- refunds, voids, repeats), quiet history imports, the sync queue, and who can see Stripe records.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tstripe;
grant usage on schema tstripe to authenticated, service_role;

create function tstripe.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

create function tstripe.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tstripe to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b3000000-0000-0000-0000-000000000001', 'owner@grass.test', '{"full_name": "Gus Owner"}'),
  ('b3000000-0000-0000-0000-000000000002', 'crew@grass.test', '{"full_name": "Cy Crew"}'),
  ('b3000000-0000-0000-0000-000000000003', 'office@grass.test', '{"full_name": "Ora Office"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b3000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Green Stripe Mowing', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'b3000000-0000-0000-0000-000000000002', 'field_crew'),
  (:'co', 'b3000000-0000-0000-0000-000000000003', 'office');
insert into public.clients (company_id, display_name, email) values (:'co', 'Oak Street HOA', 'Board@OakStreet.test') returning id as oak \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Jones') returning id as pat \gset
commit;

-- The API imports with the service key.
reset role;

-- ===== An open invoice from Stripe ===========================================================
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_open_1', 'number', 'GSM-0001', 'status', 'open', 'livemode', false, 'hosted_url', 'https://invoice.stripe.test/1',
  'amount_due', 107.50, 'issued_on', current_date - 3, 'due_on', current_date + 27, 'subject', 'Stripe invoice GSM-0001',
  'customer', jsonb_build_object('id', 'cus_oak', 'name', 'Oak St', 'email', 'board@oakstreet.test'),
  'lines', jsonb_build_array(
    jsonb_build_object('name', 'Weekly mowing', 'quantity', 4, 'unit_price', 25),
    jsonb_build_object('name', 'Tax', 'quantity', 1, 'unit_price', 7.50))
), false) as inv1 \gset

select tstripe.check((select client_id from public.invoices where id = :'inv1') = :'oak', 'a Stripe customer matches a client by email, whatever the case');
select tstripe.check((select total || '/' || balance_due || '/' || status from public.invoices where id = :'inv1') = '107.50/107.50/sent', 'the invoice owes what Stripe says is due');
select tstripe.check((select origin || '/' || status || '/' || number from public.stripe_invoices where stripe_id = 'in_open_1') = 'stripe/open/GSM-0001', 'it remembers the Stripe invoice');
select tstripe.check((select external_id from public.sync_links where provider = 'stripe' and local_id = :'oak') = 'cus_oak', 'and links the client to the Stripe customer');
select tstripe.check((select count(*) from public.activity where subject_id = :'inv1' and verb = 'invoice.sent') = 1, 'an invoice made in Stripe today shows up in the activity feed');

-- ===== Paid in Stripe: the payment and its fee =================================================
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_open_1', 'status', 'paid', 'amount_due', 107.50,
  'payment', jsonb_build_object('amount', 107.50, 'method', 'card', 'processor_ref', 'pi_oak_1', 'received_at', now(), 'fee', 3.42)
), false) as again \gset
select tstripe.check(:'again' = :'inv1', 'the same Stripe invoice updates the same invoice');
select tstripe.check((select status || '/' || amount_paid from public.invoices where id = :'inv1') = 'paid/107.50', 'paid in Stripe means paid here');
select tstripe.check((select fee_amount || '/' || processor from public.payments where processor_ref = 'pi_oak_1') = '3.42/stripe', 'with the fee Stripe kept');
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_open_1', 'status', 'paid', 'amount_due', 107.50,
  'payment', jsonb_build_object('amount', 107.50, 'method', 'card', 'processor_ref', 'pi_oak_1', 'received_at', now(), 'fee', 3.42)
), false);
select tstripe.check((select count(*) from public.payments where invoice_id = :'inv1') = 1, 'Stripe repeating itself doesn''t record a payment twice');
select tstripe.check((select status from public.stripe_invoices where stripe_id = 'in_open_1') = 'paid', 'the Stripe invoice is marked paid');

-- ===== History: quiet, with a new client, a refund and a void =================================
select count(*) as activity_before from public.activity where company_id = :'co' \gset
select count(*) as outbox_before from public.outbox where company_id = :'co' \gset
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_old_1', 'number', 'GSM-0002', 'status', 'paid', 'amount_due', 60, 'issued_on', current_date - 200, 'due_on', current_date - 170,
  'sent_at', now() - interval '200 days',
  'customer', jsonb_build_object('id', 'cus_new', 'name', 'Rita Rivers', 'email', 'rita@rivers.test', 'phone', '555-0101',
    'address', jsonb_build_object('line1', '12 River Rd', 'city', 'Springfield', 'state', 'IL', 'postal_code', '62701', 'country', 'US')),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Spring cleanup', 'quantity', 1, 'unit_price', 60)),
  'payment', jsonb_build_object('amount', 60, 'method', 'ach', 'processor_ref', 'pi_old_1', 'received_at', now() - interval '190 days', 'fee', 0.48, 'refunded', 20)
), true) as old1 \gset
select tstripe.check((select c.display_name || '/' || c.lead_source || '/' || c.status from public.clients c join public.invoices i on i.client_id = c.id where i.id = :'old1') = 'Rita Rivers/Stripe/active', 'an unknown customer becomes a client');
select tstripe.check((select line1 || ', ' || city from public.properties p join public.invoices i on i.client_id = p.client_id where i.id = :'old1') = '12 River Rd, Springfield', 'with their address as a property');
select tstripe.check((select amount_paid || '/' || balance_due || '/' || status from public.invoices where id = :'old1') = '40.00/20.00/overdue', 'a refund in Stripe puts that much back on the balance');
select tstripe.check((select processor_ref from public.payments where invoice_id = :'old1' and amount < 0) = 'pi_old_1:refund:2000', 'refunds use the same reference as the refund webhook');
select tstripe.check((select issued_on from public.invoices where id = :'old1') = current_date - 200, 'history keeps its own dates');

select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_old_2', 'status', 'void', 'amount_due', 45, 'issued_on', current_date - 100,
  'customer', jsonb_build_object('id', 'cus_pat', 'name', 'pat jones'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Edging', 'quantity', 1, 'unit_price', 45))
), true) as old2 \gset
select tstripe.check((select client_id from public.invoices where id = :'old2') = :'pat', 'a customer without an email matches the one client with that name');
select tstripe.check((select status from public.invoices where id = :'old2') = 'void', 'a voided Stripe invoice is void here');
select tstripe.check((select count(*) from public.activity where company_id = :'co') = :activity_before, 'history comes in quietly: no activity, so no automations or reminders');
select tstripe.check((select count(*) from public.outbox where company_id = :'co') = :outbox_before, 'and nothing is queued for sync');

-- Written off in Stripe, then paid after all.
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_bad_1', 'status', 'uncollectible', 'amount_due', 80,
  'customer', jsonb_build_object('id', 'cus_oak'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Leaf removal', 'quantity', 2, 'unit_price', 40))
), false) as bad \gset
select tstripe.check((select status from public.invoices where id = :'bad') = 'void', 'an invoice written off in Stripe isn''t counted as owed');
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_bad_1', 'status', 'paid', 'amount_due', 80,
  'payment', jsonb_build_object('amount', 80, 'method', 'other', 'processor_ref', 'in_bad_1:paid', 'out_of_band', true)
), false);
select tstripe.check((select status from public.invoices where id = :'bad') = 'void', 'paid after all, a void invoice stays void');
select tstripe.check((select coalesce(processor, 'none') || '/' || coalesce(invoice_id::text, 'no invoice') || '/' || notes from public.payments where processor_ref = 'in_bad_1:paid')
  = format('none/no invoice/Marked paid in Stripe. For invoice #%s, which is void', (select number from public.invoices where id = :'bad')),
  'so the money is the client''s, noted with the invoice, and stays editable since it came outside Stripe');

select tstripe.expect_error(format('select public.stripe_import_invoice(%L, %L::jsonb)', :'co', '{"stripe_id": "in_x", "status": "draft"}'), 'drafts in Stripe aren''t imported');
select tstripe.expect_error(format('update public.invoices set discount_amount = 10 where id = %L', :'inv1'), 'an invoice made in Stripe can''t be discounted here');
select tstripe.expect_error(format('update public.invoices set status = %L where id = %L', 'draft', :'old2'), 'or moved back to draft');

-- ===== The sync queue =========================================================================
insert into public.integrations (company_id, provider, status) values (:'co', 'stripe', 'connected');
insert into public.invoices (company_id, client_id, subject) values (:'co', :'pat', 'Mowing') returning id as own \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'own', 'Mowing', 40);
select tstripe.check((select count(*) from public.outbox where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'own') = 0, 'drafts aren''t sent to Stripe');
update public.invoices set status = 'sent' where id = :'own';
select tstripe.check((select count(*) from public.outbox where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'own') = 1, 'sending an invoice queues it for Stripe');
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'pat', :'own', 10, 'check');
select tstripe.check((select count(*) from public.outbox where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'own') = 1, 'a change while it waits doesn''t queue it twice');
update public.outbox set done_at = now() where topic = 'stripe.invoice';
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'pat', :'own', 30, 'cash');
select tstripe.check((select count(*) from public.outbox where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'own' and done_at is null) = 1, 'a later payment queues it again');

-- One live Stripe invoice per invoice.
insert into public.stripe_invoices (company_id, invoice_id, origin, status) values (:'co', :'own', 'crewtavo', 'open');
select tstripe.expect_error(format('insert into public.stripe_invoices (company_id, invoice_id, origin) values (%L, %L, %L)', :'co', :'own', 'crewtavo'), 'an invoice has one live Stripe invoice at a time');
insert into public.payouts (company_id, processor_ref, amount, status, arrival_on) values (:'co', 'po_1', 103.60, 'paid', current_date) returning id as po \gset
update public.payments set payout_id = :'po' where processor_ref = 'pi_oak_1';

-- ===== Who sees what ==========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b3000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tstripe.check((select count(*) from public.stripe_invoices where company_id = :'co') = 5, 'the office sees Stripe invoices');
select tstripe.check((select count(*) from public.payouts where company_id = :'co') = 1, 'and deposits');
with changed as (update public.payouts set amount = 1 returning 1) select tstripe.check((select count(*) from changed) = 0, 'but can''t change deposits');
with changed as (update public.stripe_invoices set status = 'paid' returning 1) select tstripe.check((select count(*) from changed) = 0, 'or Stripe invoices');
select tstripe.expect_error(format('select public.stripe_import_invoice(%L, %L::jsonb)', :'co', '{"stripe_id": "in_y", "status": "open"}'), 'only the server imports from Stripe');
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b3000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tstripe.check((select count(*) from public.stripe_invoices) = 0, 'crews don''t see Stripe invoices');
select tstripe.check((select count(*) from public.payouts) = 0, 'or deposits');
rollback;


\echo 'All Stripe tests passed.'
