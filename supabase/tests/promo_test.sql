-- Database tests for promo codes: discounts before tax, rules (dates, minimum, uses, once per
-- client, new clients), carrying to the job and invoice, invoice codes, and who can see codes.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t5;
grant usage on schema t5 to authenticated, service_role;

create function t5.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

create function t5.expect_error(p_sql text, p_what text, p_like text default null) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_like is not null and sqlerrm not ilike p_like then
      raise exception 'FAIL (wrong error "%"): %', sqlerrm, p_what;
    end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t5 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('f0000000-0000-0000-0000-000000000001', 'owner@fox.test', '{"full_name": "Fay Owner"}'),
  ('f0000000-0000-0000-0000-000000000002', 'crew@fox.test', '{"full_name": "Cal Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Fox Lawn & Paving', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'f0000000-0000-0000-0000-000000000002', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Maple Court') returning id as maple \gset
insert into public.clients (company_id, display_name) values (:'co', 'Birch Lane') returning id as birch \gset

insert into public.promo_codes (company_id, code, description, kind, value, min_subtotal) values (:'co', 'SPRING10', 'Spring special', 'percent', 10, 500) returning id as spring \gset
insert into public.promo_codes (company_id, code, kind, value, max_uses, once_per_client) values (:'co', 'FLAT50', 'amount', 50, 1, false) returning id as flat \gset
insert into public.promo_codes (company_id, code, kind, value, new_clients_only) values (:'co', 'WELCOME', 'amount', 25, true);
insert into public.promo_codes (company_id, code, kind, value, ends_on) values (:'co', 'OLD', 'percent', 20, current_date - 2);
insert into public.promo_codes (company_id, code, kind, value, active) values (:'co', 'PAUSED', 'percent', 20, false);
select t5.expect_error(format('insert into public.promo_codes (company_id, code, kind, value) values (%L, %L, %L, 150)', :'co', 'HALF', 'percent'), 'a percent code can''t be more than 100%');
select t5.expect_error(format('insert into public.promo_codes (company_id, code, kind, value) values (%L, %L, %L, 5)', :'co', 'bad code!', 'amount'), 'codes are letters, numbers and dashes');

-- ===== A code on a quote ===================================================================
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'maple', 'Spring cleanup', 0.10) returning id as q1 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'q1', 'Cleanup', 1, 1000, true);
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable, optional, selected) values (:'co', :'q1', 'Mulch', 1, 500, true, true, false) returning id as mulch \gset
select t5.check((public.apply_promo_code('quote', :'q1', ' spring10 ') ->> 'discount_amount')::numeric = 100, 'codes are matched without regard to case or spaces');
select t5.check((select discount_amount || '/' || tax_amount || '/' || total from public.quotes where id = :'q1') = '100.00/90.00/990.00', '10% off comes before tax');
update public.quote_line_items set selected = true where id = :'mulch';
select t5.check((select discount_amount || '/' || total from public.quotes where id = :'q1') = '150.00/1485.00', 'picking an option updates the discount');

select t5.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q1', 'NOPE'), 'unknown codes are refused', '%isn''t valid%');
select t5.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q1', 'PAUSED'), 'paused codes are refused', '%isn''t valid%');
select t5.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q1', 'OLD'), 'expired codes are refused', '%expired%');

insert into public.quotes (company_id, client_id, title) values (:'co', :'birch', 'Edging') returning id as q2 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (:'co', :'q2', 'Edging', 1, 200);
select t5.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q2', 'SPRING10'), 'a minimum order is enforced', '%at least $500.00%');
insert into public.quotes (company_id, client_id, title) values (:'co', :'maple', 'Hedges') returning id as q4 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (:'co', :'q4', 'Hedge trimming', 1, 600);
select t5.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q4', 'SPRING10'), 'a code works once per client', '%already been used for this account%');

select public.apply_promo_code('quote', :'q4', 'FLAT50');
select t5.check((select discount_amount from public.quotes where id = :'q4') = 50, 'a dollar-off code takes that amount off');
insert into public.quotes (company_id, client_id, title) values (:'co', :'birch', 'Aeration') returning id as q3 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (:'co', :'q3', 'Aeration', 1, 300);
select t5.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q3', 'FLAT50'), 'a code''s total uses are limited', '%used up%');
select public.remove_promo_code('quote', :'q4');
select t5.check((select coalesce(promo_code_id::text, 'none') || '/' || discount_amount from public.quotes where id = :'q4') = 'none/0.00', 'removing a code removes its discount');
select public.apply_promo_code('quote', :'q3', 'FLAT50');
select t5.check((select discount_amount from public.quotes where id = :'q3') = 50, 'a freed-up use can be used by someone else');

-- ===== The discount follows the work ======================================================
update public.quotes set status = 'approved' where id = :'q1';
select t5.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q1', 'FLAT50'), 'codes can''t change on an approved quote', '%approved%');
select public.convert_quote_to_job(:'q1') as job \gset
select t5.check((select count(*) from public.job_line_items where job_id = :'job' and name = 'Promo code SPRING10') = 1, 'the job shows the promo code as a credit');
select public.create_invoice_for_job(:'job') as inv \gset
select t5.check((select total from public.invoices where id = :'inv') = (select total from public.quotes where id = :'q1'), 'the invoice matches the discounted quote');
select t5.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q4', 'WELCOME'), 'new-customer codes skip existing customers', '%new customers%');
select t5.check((public.apply_promo_code('quote', :'q2', 'WELCOME') ->> 'discount_amount')::numeric = 25, 'and work for new ones');

-- ===== Codes on invoices ==================================================================
insert into public.promo_codes (company_id, code, kind, value, once_per_client) values (:'co', 'THANKS', 'percent', 5, false);
insert into public.invoices (company_id, client_id, subject, tax_rate) values (:'co', :'birch', 'Fall cleanup', 0.10) returning id as inv2 \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'inv2', 'Fall cleanup', 400);
select public.apply_promo_code('invoice', :'inv2', 'thanks');
select t5.check((select discount_amount || '/' || tax_amount || '/' || total from public.invoices where id = :'inv2') = '20.00/38.00/418.00', 'invoice codes come off before tax');
update public.invoices set status = 'sent' where id = :'inv2';
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'birch', :'inv2', 100, 'check');
select t5.expect_error(format('select public.remove_promo_code(%L, %L); select public.apply_promo_code(%L, %L, %L)', 'invoice', :'inv2', 'invoice', :'inv2', 'SPRING10'), 'codes can''t change once an invoice has payments', '%before an invoice is paid%');
select t5.check((select discount_amount from public.invoices where id = :'inv2') = 20, 'and the code already on it stays');

select t5.check((select uses from public.promo_code_usage(:'co') where promo_code_id = :'spring') = 1, 'usage counts each code''s uses');
select t5.check((select discounted from public.promo_code_usage(:'co') where promo_code_id = :'spring') = 150, 'and the dollars it took off');
select t5.expect_error(format('select public.check_promo_code(%L, %L)', :'co', 'SPRING10'), 'signed-in users can''t probe codes through the booking check');
commit;

-- ===== Crews don't see codes ==============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t5.check((select count(*) from public.promo_codes where company_id = :'co') = 0, 'field crew can''t see promo codes');
select t5.expect_error(format('insert into public.promo_codes (company_id, code, kind, value) values (%L, %L, %L, 5)', :'co', 'CREW5', 'amount'), 'or create them');
commit;

-- ===== Booking forms check codes through the server ========================================
set role service_role;
select t5.check(public.check_promo_code(:'co', 'spring10') = '10% off: Spring special', 'the booking check describes the offer');
insert into public.promo_codes (company_id, code, kind, value) values (:'co', 'FALL20', 'amount', 20);
select t5.check(public.check_promo_code(:'co', 'fall20') = '$20.00 off', 'dollar-off offers too');
select t5.expect_error(format('select public.check_promo_code(%L, %L)', :'co', 'FLAT50'), 'used-up codes are refused', '%used up%');
select t5.expect_error(format('select public.check_promo_code(%L, %L)', :'co', 'OLD'), 'and refuses expired codes', '%expired%');
reset role;

\echo 'All promo code tests passed.'
