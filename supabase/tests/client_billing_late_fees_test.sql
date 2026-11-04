-- Database tests for billing per client and late fees (20261104000200_client_billing_late_fees.sql):
-- a tax-exempt client's quotes and invoices charge no tax, a client's own payment terms set the due
-- date, and a late fee goes on an invoice past its grace days once, never on a draft, paid, void or
-- written-off one; another business sees and changes none of it, and only the server adds fees.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema cbl;
grant usage on schema cbl to authenticated, service_role;
create function cbl.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function cbl.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema cbl to authenticated, service_role;

-- Liv owns Linden Landscapes (8% tax, 30 days); Oz owns another business, with percent late fees.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c4120000-0000-0000-0000-000000000001', 'liv@linden.test', '{"full_name": "Liv Linden"}'),
  ('c4120000-0000-0000-0000-000000000009', 'oz@osage.test', '{"full_name": "Oz Osage"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4120000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Osage Outdoor', 'general', 'UTC') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Opal') returning id as opal \gset
select set_config('request.jwt.claims', '{"sub": "c4120000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Linden Landscapes', 'general', 'UTC') as co \gset
insert into public.clients (company_id, display_name, tax_exempt, tax_exempt_note, payment_terms_days)
values (:'co', 'Grace Church', true, 'Certificate E-4410', 15) returning id as church \gset
insert into public.clients (company_id, display_name) values (:'co', 'Hal Home') returning id as hal \gset
commit;
update public.companies set settings = settings || '{"default_tax_rate": 0.08, "payment_terms_days": 30}' where id in (:'co', :'other');

-- ===== Tax exempt ==============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4120000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'church', 'Lawn care', 0.08) returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price, taxable) values (:'co', :'quote', 'Mowing', 1, 'ea', 100, true);
select cbl.check((select tax_rate = 0 and tax_amount = 0 and total = 100 from public.quotes where id = :'quote'), 'a tax-exempt client''s quote charges no tax');
update public.quotes set tax_rate = 0.08 where id = :'quote';
select cbl.check((select tax_rate = 0 from public.quotes where id = :'quote'), 'and can''t be given a rate');
select public.convert_quote_to_job(:'quote') as job \gset
select public.create_invoice_for_job(:'job') as inv \gset
select cbl.check((select tax_rate = 0 and tax_amount = 0 and total = 100 from public.invoices where id = :'inv'), 'nor can the invoice from its job');
-- Hal's draft and sent invoices are taxed; then he's marked exempt.
insert into public.invoices (company_id, client_id, tax_rate) values (:'co', :'hal', 0.08) returning id as hal_draft \gset
insert into public.invoices (company_id, client_id, tax_rate) values (:'co', :'hal', 0.08) returning id as hal_sent \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'hal_draft', 'Mulch', 1, 'ea', 50), (:'co', :'hal_sent', 'Mulch', 1, 'ea', 50);
update public.invoices set status = 'sent' where id = :'hal_sent';
update public.clients set tax_exempt = true where id = :'hal';
select cbl.check((select tax_amount = 0 from public.invoices where id = :'hal_draft'), 'marked exempt, a client''s draft loses its tax');
select cbl.check((select tax_amount = 4 from public.invoices where id = :'hal_sent'), 'what was sent keeps what it was sent with');
-- Moving a taxed draft to an exempt client takes its tax off.
update public.clients set tax_exempt = false where id = :'hal';
update public.invoices set tax_rate = 0.08 where id = :'hal_draft';
select cbl.check((select tax_amount = 4 from public.invoices where id = :'hal_draft'), 'no longer exempt, a rate can go on again');
update public.invoices set client_id = :'church' where id = :'hal_draft';
select cbl.check((select tax_rate = 0 from public.invoices where id = :'hal_draft'), 'moved to an exempt client, it''s untaxed');
commit;

-- ===== Payment terms ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4120000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select cbl.check((select due_on = issued_on + 15 from public.invoices where id = :'inv'), 'an invoice from a job is due on the client''s 15 days, not the business''s 30');
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'church', current_date, current_date + 30) returning id as blank \gset
select cbl.check((select due_on = current_date + 15 from public.invoices where id = :'blank'), 'New invoice with the business''s terms gets the client''s');
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'church', current_date, current_date + 7) returning id as picked \gset
select cbl.check((select due_on = current_date + 7 from public.invoices where id = :'picked'), 'a due date picked by hand stays');
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'hal', current_date, current_date + 30) returning id as hal_terms \gset
select cbl.check((select due_on = current_date + 30 from public.invoices where id = :'hal_terms'), 'a client without terms has the business''s');
commit;

-- ===== Late fees ===============================================================================
update public.companies set settings = settings || '{"late_fee": {"type": "flat", "amount": 25, "grace_days": 5}}' where id = :'co';
update public.companies set settings = settings || '{"late_fee": {"type": "percent", "amount": 1.5, "grace_days": 0}}' where id = :'other';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4120000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- Past the 5 grace days, within them, paid, void, written off, a draft, and one made in Stripe.
insert into public.invoices (company_id, client_id, issued_on, due_on) values
  (:'co', :'hal', current_date - 40, current_date - 10) returning id as late \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'hal', current_date - 33, current_date - 3) returning id as grace \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'hal', current_date - 40, current_date - 10) returning id as paid \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'hal', current_date - 40, current_date - 10) returning id as void \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'hal', current_date - 40, current_date - 10) returning id as off \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'hal', current_date - 40, current_date - 10) returning id as draft \gset
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'co', :'hal', current_date - 40, current_date - 10) returning id as made_in_stripe \gset
update public.invoices set tax_rate = 0.08 where id in (:'late', :'paid');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable)
select :'co', id, 'Cleanup', 1, 'ea', 200, true from public.invoices where id in (:'late', :'grace', :'paid', :'void', :'off', :'draft', :'made_in_stripe');
update public.invoices set status = 'sent' where id in (:'late', :'grace', :'paid', :'off', :'made_in_stripe');
insert into public.payments (company_id, invoice_id, client_id, amount, method) values (:'co', :'paid', :'hal', 216, 'check');
update public.invoices set status = 'void' where id = :'void';
update public.invoices set status = 'written_off' where id = :'off';
select set_config('request.jwt.claims', '{"sub": "c4120000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
insert into public.invoices (company_id, client_id, issued_on, due_on) values (:'other', :'opal', current_date - 31, current_date - 1) returning id as theirs \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable) values (:'other', :'theirs', 'Pruning', 1, 'ea', 1000, false);
update public.invoices set status = 'sent' where id = :'theirs';
select cbl.expect_error('select public.add_late_fees()', 'someone signed in can''t add late fees');
commit;
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due) values (:'co', :'made_in_stripe', 'in_cbl_1', 'stripe', 'open', 216);

begin;
set local role service_role;
select public.add_late_fees() as added \gset
select public.add_late_fees() as again \gset
commit;
select cbl.check(:'added'::integer >= 2 and :'again'::integer = 0, 'the hourly upkeep adds fees, and running it again adds none');
select cbl.check((select count(*) = 1 and min(unit_price) = 25 and not bool_or(taxable) and min(name) = 'Late fee' from public.invoice_line_items where invoice_id = :'late' and kind = 'late_fee'),
  'a $25 untaxed Late fee line, once, on the invoice 10 days past due');
select cbl.check((select total = 241 and balance_due = 241 and status = 'overdue' and late_fee_at is not null from public.invoices where id = :'late'), 'what''s owed goes up by it');
select cbl.check((select count(*) = 0 from public.invoice_line_items where kind = 'late_fee' and invoice_id in (:'grace', :'paid', :'void', :'off', :'draft', :'made_in_stripe')),
  'none within the grace days, nor on a paid, void, written-off, draft or Stripe-made invoice');
select cbl.check((select unit_price = 15 from public.invoice_line_items where invoice_id = :'theirs' and kind = 'late_fee'), 'a percent fee is of the balance (1.5% of $1,000)');

-- Taken off by hand (back to draft), it isn't added again.
update public.invoices set status = 'draft' where id = :'late';
delete from public.invoice_line_items where invoice_id = :'late' and kind = 'late_fee';
update public.invoices set status = 'sent' where id = :'late';
begin;
set local role service_role;
select public.add_late_fees() as third \gset
commit;
select cbl.check(not exists (select 1 from public.invoice_line_items where invoice_id = :'late' and kind = 'late_fee'), 'a fee taken off doesn''t come back');

-- ===== Another business ========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4120000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select cbl.check((select count(*) = 0 from public.clients where id = :'church'), 'another business can''t see a client''s exemption');
update public.clients set tax_exempt = false, payment_terms_days = 90 where id = :'church';
select cbl.check((select count(*) = 0 from public.invoice_line_items where invoice_id = :'late'), 'or the invoice''s lines');
commit;
select cbl.check((select tax_exempt and payment_terms_days = 15 and tax_exempt_note = 'Certificate E-4410' from public.clients where id = :'church'), 'or change it');

\echo 'All client billing and late fee tests passed.'
