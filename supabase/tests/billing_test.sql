-- Database tests for billing: discounts and tax, quote to job to invoice totals, final invoice and
-- progress limits, retainage, locked line items, voiding, and Stripe payments.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t4;
grant usage on schema t4 to authenticated, service_role;

create function t4.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

create function t4.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t4 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e0000000-0000-0000-0000-000000000001', 'owner@echo.test', '{"full_name": "Eve Owner"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e0000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Echo Exteriors', 'roofing') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Harbor View Condos') returning id as client \gset

-- ===== Discounts come off before tax, and follow the work to the invoice ======================
insert into public.quotes (company_id, client_id, title, tax_rate, discount_amount) values (:'co', :'client', 'Roof and gutters', 0.10, 300) returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values
  (:'co', :'quote', 'Shingles', 1, 1000, true),
  (:'co', :'quote', 'Labor', 1, 500, false);
-- 1,500 of work, 300 off: 200 of it comes off the 1,000 taxable, so tax is 10% of 800.
select t4.check((select subtotal || '/' || tax_amount || '/' || total from public.quotes where id = :'quote') = '1500.00/80.00/1280.00', 'a quote discount lowers the taxable amount');

select public.convert_quote_to_job(:'quote') as job \gset
select t4.check((select count(*) from public.job_line_items where job_id = :'job' and name = 'Discount') = 2, 'the discount comes along to the job');
select t4.check((select contract_total from public.job_financials where job_id = :'job') = 1200, 'the job total is what the client approved, before tax');

select public.create_invoice_for_job(:'job', 'progress', 600) as prog \gset
select t4.check((select tax_rate from public.invoices where id = :'prog') = 0.10, 'invoices use the quote''s tax rate');
select t4.expect_error(format('select public.create_invoice_for_job(%L, %L, 700)', :'job', 'progress'), 'progress billing can''t pass the contract');
select t4.expect_error(format('select public.create_invoice_for_job(%L, %L, 601)', :'job', 'deposit'), 'deposits count toward the contract too');

select public.create_invoice_for_job(:'job') as final \gset
select t4.check((select (select total from public.invoices where id = :'prog') + total from public.invoices where id = :'final') = 1280, 'progress plus final invoices add up to the approved quote');
select t4.expect_error(format('select public.create_invoice_for_job(%L)', :'job'), 'a job gets one final invoice');

-- ===== Line items lock once an invoice is sent ===============================================
update public.invoices set status = 'sent' where id = :'final';
select t4.expect_error(format('update public.invoice_line_items set unit_price = 1 where invoice_id = %L', :'final'), 'sent invoices'' line items can''t change');
select t4.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (%L, %L, %L, 5)', :'co', :'final', 'Extra'), 'or gain new ones');
update public.invoices set status = 'draft' where id = :'final';
update public.invoice_line_items set description = 'Architectural shingles' where invoice_id = :'final' and name = 'Shingles';
select t4.check(true, 'back in draft, line items can change again');

-- ===== Invoice discounts ===================================================================
insert into public.invoices (company_id, client_id, subject, tax_rate) values (:'co', :'client', 'Gutter cleaning', 0.10) returning id as inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable) values (:'co', :'inv', 'Gutter cleaning', 1, 200, true);
update public.invoices set discount_amount = 50 where id = :'inv';
select t4.check((select subtotal || '/' || discount_amount || '/' || tax_amount || '/' || total from public.invoices where id = :'inv') = '200.00/50.00/15.00/165.00', 'invoice discounts come off before tax');
update public.invoices set discount_amount = 900 where id = :'inv';
select t4.check((select total from public.invoices where id = :'inv') = 0, 'a discount can''t take an invoice below zero');
update public.invoices set discount_amount = 0, status = 'sent' where id = :'inv';

-- ===== Payments, voiding and Stripe =========================================================
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'client', :'inv', 100, 'check');
select t4.expect_error(format('update public.invoices set status = %L where id = %L', 'void', :'inv'), 'an invoice with payments can''t be voided');
select t4.expect_error(format('update public.invoices set status = %L where id = %L', 'draft', :'inv'), 'or moved back to draft');
insert into public.payments (company_id, client_id, invoice_id, amount, method, notes) values (:'co', :'client', :'inv', -100, 'check', 'Refund');
select t4.check((select amount_paid || '/' || status from public.invoices where id = :'inv') = '0.00/sent', 'a refund puts the balance back');
update public.invoices set status = 'void' where id = :'inv';
select t4.check((select status from public.invoices where id = :'inv') = 'void', 'once refunded, it can be voided');
select t4.expect_error(format('insert into public.payments (company_id, client_id, invoice_id, amount) values (%L, %L, %L, 10)', :'co', :'client', :'inv'), 'void invoices can''t take payments');
commit;

-- A Stripe payment, recorded by the webhook (no RLS), can't be edited or deleted by hand.
reset role;
insert into public.invoices (company_id, client_id, subject, status) values (:'co', :'client', 'Online', 'draft') returning id as online \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'online', 'Inspection', 150);
update public.invoices set status = 'sent' where id = :'online';
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'client', :'online', 150, 'card', 'stripe', 'pi_test_1');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e0000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t4.check((select status from public.invoices where id = :'online') = 'paid', 'a card payment pays the invoice');
with gone as (delete from public.payments where processor_ref = 'pi_test_1' returning 1)
select t4.check((select count(*) from gone) = 0, 'Stripe payments can''t be deleted by hand');
with changed as (update public.payments set amount = 1 where processor_ref = 'pi_test_1' returning 1)
select t4.check((select count(*) from changed) = 0, 'or edited');

-- ===== Credits that cover the whole invoice =================================================
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Covered') returning id as covered \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'covered', 'Repair', 100), (:'co', :'covered', 'Less deposit', -100);
update public.invoices set status = 'sent' where id = :'covered';
select t4.check((select status from public.invoices where id = :'covered') = 'paid', 'an invoice that credits cover is paid');

-- ===== Retainage ===========================================================================
insert into public.jobs (company_id, client_id, title, retainage_pct) values (:'co', :'client', 'Clubhouse roof', 10) returning id as rjob \gset
insert into public.job_line_items (company_id, job_id, name, unit_price, taxable) values (:'co', :'rjob', 'Re-roof', 10000, false);
select public.create_invoice_for_job(:'rjob') as rinv \gset
update public.invoices set status = 'sent' where id = :'rinv';
select t4.check((select retainage_amount || '/' || balance_due from public.invoices where id = :'rinv') = '1000.00/9000.00', '10% is held back');
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'client', :'rinv', 9000, 'ach');
select t4.check((select status from public.invoices where id = :'rinv') = 'paid', 'paying the rest marks it paid');
select public.create_invoice_for_job(:'rjob', 'retainage') as ret \gset
select t4.check((select total || '/' || kind from public.invoices where id = :'ret') = '1000.00/retainage', 'the held-back amount can be billed');
select t4.expect_error(format('select public.create_invoice_for_job(%L, %L)', :'rjob', 'retainage'), 'retainage is billed once');
commit;

\echo 'All billing tests passed.'
