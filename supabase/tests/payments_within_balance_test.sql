-- Database tests for payments recorded by hand staying within the balance
-- (20261112000450_payments_within_balance): someone signed in can't record more than an invoice
-- still owes, so the same check recorded by two people doesn't take it below $0, and a payment
-- sent twice with the id its form made is recorded once. Tips, refunds, and everything Stripe
-- records (with the service key) go in as before.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema pwb;
grant usage on schema pwb to authenticated, service_role;
create function pwb.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- Expects p_sql to fail with SQLSTATE p_state (and a message like p_like, when given).
create function pwb.expect_error(p_sql text, p_what text, p_state text, p_like text default null) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_state or (p_like is not null and sqlerrm not ilike p_like) then
      raise exception 'FAIL (wrong error % "%"): %', sqlstate, sqlerrm, p_what;
    end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- A sent invoice for p_amount.
create function pwb.invoice(p_company uuid, p_client uuid, p_amount numeric) returns uuid language plpgsql as $$
declare v_invoice uuid;
begin
  insert into public.invoices (company_id, client_id, tax_rate) values (p_company, p_client, 0) returning id into v_invoice;
  insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (p_company, v_invoice, 'Mulch', 1, 'ea', p_amount);
  update public.invoices set status = 'sent' where id = v_invoice;
  return v_invoice;
end $$;
create function pwb.figures(p_invoice uuid) returns text language sql stable as $$
  select amount_paid || '/' || balance_due || '/' || status from public.invoices where id = p_invoice
$$;
grant execute on all functions in schema pwb to authenticated, service_role;

-- Kay owns Kelp Gardens and Lee works in her office; Moe is their client.
insert into auth.users (id, email, raw_user_meta_data) values
  ('d5450000-0000-0000-0000-000000000001', 'kay@kelp-gardens.test', '{"full_name": "Kay Kelp"}'),
  ('d5450000-0000-0000-0000-000000000002', 'lee@kelp-gardens.test', '{"full_name": "Lee Office"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d5450000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Kelp Gardens', 'general') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'd5450000-0000-0000-0000-000000000002', 'office');
insert into public.clients (company_id, display_name) values (:'co', 'Moe Marsh') returning id as moe \gset
select pwb.invoice(:'co', :'moe', 200) as bill \gset
select pwb.invoice(:'co', :'moe', 200) as twice \gset
select pwb.invoice(:'co', :'moe', 200) as tipped \gset
select pwb.invoice(:'co', :'moe', 200) as online \gset
commit;

-- ===== No more than what's owed =================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d5450000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select pwb.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, method) values (%L, %L, %L, 250, %L)', :'co', :'bill', :'moe', 'check'),
  'a payment recorded by hand can''t be more than the invoice owes', '22023', 'That''s more than the 200.00 still owed on this invoice%');
insert into public.payments (company_id, invoice_id, client_id, amount, method, notes) values (:'co', :'bill', :'moe', 200, 'check', '1042');
select pwb.check(pwb.figures(:'bill') = '200.00/0.00/paid', 'one for all of it pays the invoice');
commit;

-- Lee records the same check a moment later.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d5450000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select pwb.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, method, notes) values (%L, %L, %L, 200, %L, %L)', :'co', :'bill', :'moe', 'check', '1042'),
  'the same check recorded again by someone else is turned down', '22023', 'Nothing is left to pay on this invoice%');
select pwb.check(pwb.figures(:'bill') = '200.00/0.00/paid' and (select count(*) = 1 from public.payments where invoice_id = :'bill'), 'and the invoice stays paid once');

-- ===== A payment sent twice is recorded once ===================================================
-- The form makes the payment's id, so a second tap (or a retry after the answer was lost) is the
-- same row: it's turned down as a duplicate, which the app takes as already recorded.
insert into public.payments (id, company_id, invoice_id, client_id, amount, method) values ('d5450000-0000-0000-0000-0000000000a1', :'co', :'twice', :'moe', 50, 'cash');
select pwb.expect_error(format('insert into public.payments (id, company_id, invoice_id, client_id, amount, method) values (%L, %L, %L, %L, 50, %L)', 'd5450000-0000-0000-0000-0000000000a1', :'co', :'twice', :'moe', 'cash'),
  'a part payment sent twice is the same payment', '23505');
insert into public.payments (id, company_id, invoice_id, client_id, amount, method) values ('d5450000-0000-0000-0000-0000000000a2', :'co', :'twice', :'moe', 150, 'cash');
select pwb.expect_error(format('insert into public.payments (id, company_id, invoice_id, client_id, amount, method) values (%L, %L, %L, %L, 150, %L)', 'd5450000-0000-0000-0000-0000000000a2', :'co', :'twice', :'moe', 'cash'),
  'and so is the one that paid it off (a duplicate, not "nothing is left to pay")', '23505');
select pwb.check(pwb.figures(:'twice') = '200.00/0.00/paid' and (select count(*) = 2 from public.payments where invoice_id = :'twice'), 'each is on the invoice once');

-- ===== Tips, refunds and changes ================================================================
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method) values (:'co', :'tipped', :'moe', 200, 30, 'cash') returning id as tip_payment \gset
select pwb.check(pwb.figures(:'tipped') = '200.00/0.00/paid', 'a tip on top of the balance isn''t counted against it');
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method, notes) values (:'co', :'tipped', :'moe', -80, 0, 'cash', 'Refund');
select pwb.check(pwb.figures(:'tipped') = '120.00/80.00/partially_paid', 'a refund is recorded as before');
select pwb.expect_error(format('insert into public.payments (company_id, invoice_id, client_id, amount, method) values (%L, %L, %L, 80.01, %L)', :'co', :'tipped', :'moe', 'cash'),
  'after it, a cent more than what''s owed again is turned down', '22023', 'That''s more than the 80.00 still owed%');
insert into public.payments (company_id, invoice_id, client_id, amount, method) values (:'co', :'tipped', :'moe', 50, 'cash') returning id as part \gset
select pwb.expect_error(format('update public.payments set amount = 90 where id = %L', :'part'), 'a payment can''t be raised past the balance', '22023', 'That''s more than the 30.00 still owed%');
update public.payments set amount = 80 where id = :'part';
update public.payments set amount = 20, notes = 'Recounted' where id = :'part';
select pwb.check(pwb.figures(:'tipped') = '140.00/60.00/partially_paid', 'but raised to it, lowered, or given a note');
commit;

-- ===== What Stripe records goes in as before ===================================================
-- The API records these with the service key: a card payment, and an invoice marked paid in
-- Stripe. They mirror money that has already moved, so they're never turned down.
set role service_role;
insert into public.payments (company_id, invoice_id, client_id, amount, tip_amount, method, processor, processor_ref) values (:'co', :'online', :'moe', 200, 20, 'card', 'stripe', 'pi_pwb_1');
insert into public.payments (company_id, invoice_id, client_id, amount, method, processor, processor_ref) values (:'co', :'online', :'moe', 200, 'card', 'stripe', 'pi_pwb_2');
insert into public.payments (company_id, invoice_id, client_id, amount, method, processor_ref, notes) values (:'co', :'bill', :'moe', 200, 'other', 'in_pwb_1:paid', 'Marked paid in Stripe');
reset role;
select pwb.check(pwb.figures(:'online') = '400.00/-200.00/paid' and pwb.figures(:'bill') = '400.00/-200.00/paid', 'a payment Stripe took is recorded even when the invoice was already paid');

-- An invoice that was overpaid before stays as it is, and the office can still record the refund.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d5450000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.payments (company_id, invoice_id, client_id, amount, method, notes) values (:'co', :'bill', :'moe', -200, 'check', 'Refund');
select pwb.check(pwb.figures(:'bill') = '200.00/0.00/paid', 'an overpaid invoice takes its refund');
commit;

\echo 'All payments within balance tests passed.'
