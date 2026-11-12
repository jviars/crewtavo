-- Database tests for one promo code per job (20261112000440_one_promo_per_job): a deposit, progress
-- or retainage invoice of a job whose quote already took a promo code doesn't take another one on
-- top, from the Client Hub or the office, so the client isn't credited for a deposit they didn't
-- pay in full. A job without a code still takes one on any of its invoices, as before.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema opj;
grant usage on schema opj to authenticated, service_role;
create function opj.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function opj.expect_error(p_sql text, p_what text, p_like text default null) returns void language plpgsql as $$
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
-- A sent $2,000 patio quote that asks a $500 deposit, with p_code on it when given.
create function opj.quote(p_company uuid, p_client uuid, p_title text, p_code text) returns uuid language plpgsql as $$
declare v_quote uuid;
begin
  insert into public.quotes (company_id, client_id, title, tax_rate, deposit_amount) values (p_company, p_client, p_title, 0, 500) returning id into v_quote;
  insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (p_company, v_quote, 'Pavers', 1, 2000);
  if p_code is not null then
    perform public.apply_promo_code('quote', v_quote, p_code);
  end if;
  update public.quotes set status = 'sent', sent_at = now() where id = v_quote;
  return v_quote;
end $$;
grant execute on all functions in schema opj to authenticated, service_role;

-- Hal owns Hazel Hardscapes; Ivy and Jon are his clients.
insert into auth.users (id, email, raw_user_meta_data) values
  ('d4440000-0000-0000-0000-000000000001', 'hal@hazel-hardscapes.test', '{"full_name": "Hal Hazel"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d4440000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Hazel Hardscapes', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ivy Inlet') returning id as ivy \gset
insert into public.clients (company_id, display_name) values (:'co', 'Jon Jetty') returning id as jon \gset
insert into public.promo_codes (company_id, code, kind, value, once_per_client) values
  (:'co', 'SPRING15', 'amount', 15, false), (:'co', 'TENOFF', 'percent', 10, false);

-- ===== A job whose quote took SPRING15 ==========================================================
select opj.quote(:'co', :'ivy', 'Patio', 'SPRING15') as patio_quote \gset
update public.quotes set status = 'approved', approved_at = now() where id = :'patio_quote';
select public.convert_quote_to_job(:'patio_quote') as patio \gset
update public.jobs set retainage_pct = 10 where id = :'patio';
select public.create_invoice_for_job(:'patio', 'deposit') as deposit \gset
select public.create_invoice_for_job(:'patio', 'progress', 400) as progress \gset
update public.invoices set status = 'sent' where id in (:'deposit', :'progress');
select opj.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'deposit', 'TENOFF'),
  'the office can''t put a second code on the deposit invoice', 'This job already has a promo code''s discount, so another code can''t go on this invoice.');
commit;

-- The Client Hub, where a client types a code on an unpaid invoice (the API calls with the service key).
set role service_role;
select opj.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'deposit', 'TENOFF'),
  'a client can''t put a second code on the deposit invoice', 'This job already has a promo code%');
select opj.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'progress', 'TENOFF'),
  'nor on a progress invoice', 'This job already has a promo code%');
select opj.check((select bool_and(promo_code_id is null and discount_amount = 0 and total = subtotal) from public.invoices where id in (:'deposit', :'progress')),
  'both still ask what they asked');
reset role;

-- The deposit is paid in full, so the final invoice credits what was paid.
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'ivy', :'deposit', 500, 'check');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d4440000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_invoice_for_job(:'patio') as final \gset
select opj.check((select amount_paid = 500 and status = 'paid' from public.invoices where id = :'deposit')
  and exists (select 1 from public.invoice_line_items where invoice_id = :'final' and name like 'Less deposit%' and unit_price = -500),
  'the final invoice credits the $500.00 deposit, which is what the client paid');
-- 2,000 less SPRING15, the deposit and the progress billing.
select opj.check((select subtotal = 1085 from public.invoices where id = :'final'), 'and takes the quote''s code off once');
update public.invoices set status = 'sent' where id = :'final';
select public.create_invoice_for_job(:'patio', 'retainage') as retainage \gset
update public.invoices set status = 'sent' where id = :'retainage';
select opj.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'retainage', 'TENOFF'),
  'a retainage invoice doesn''t take a second code either', 'This job already has a promo code%');

-- ===== The deposit the Client Hub asks as the client approves, before there's a job ==============
select opj.quote(:'co', :'ivy', 'Walkway', 'SPRING15') as walkway_quote \gset
commit;
set role service_role;
select opj.check(public.approve_hub_quote(:'co', :'walkway_quote', null, '{"name": "Ivy Inlet"}'), 'Ivy approves a quote with SPRING15 on it');
select public.hub_deposit_invoice(:'co', :'walkway_quote') as walkway_deposit \gset
select opj.check((select job_id is null and status = 'sent' and total = 500 from public.invoices where id = :'walkway_deposit'), 'its deposit invoice has no job yet');
select opj.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'walkway_deposit', 'TENOFF'),
  'and doesn''t take a second code', 'This job already has a promo code%');

-- ===== A job without a code takes one on any invoice, as before ================================
reset role;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d4440000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select opj.quote(:'co', :'jon', 'Steps', null) as steps_quote \gset
update public.quotes set status = 'approved', approved_at = now() where id = :'steps_quote';
select public.convert_quote_to_job(:'steps_quote') as steps \gset
select public.create_invoice_for_job(:'steps', 'deposit') as steps_deposit \gset
update public.invoices set status = 'sent' where id = :'steps_deposit';
commit;
set role service_role;
select opj.check((public.apply_promo_code('invoice', :'steps_deposit', 'TENOFF') ->> 'total')::numeric = 450, 'a deposit invoice of a job with no code takes one');
reset role;

\echo 'All one promo per job tests passed.'
