-- Database tests for deposits not being late bills (20261107000100_deposit_invoice_terms): the
-- deposit invoice the Client Hub makes as the client approves is due on the client's payment terms,
-- else the business's, and no deposit invoice ever gets a late fee, while any other invoice as late
-- still does.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema dit;
grant usage on schema dit to authenticated, service_role;
create function dit.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema dit to authenticated, service_role;

-- Tia owns Teak Terraces: 14-day terms and a $25 late fee from the day after the due date. Uma pays
-- in 7 days; Vic is on the business's terms.
insert into auth.users (id, email, raw_user_meta_data) values
  ('d1700000-0000-0000-0000-000000000001', 'tia@teak-terraces.test', '{"full_name": "Tia Teak"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1700000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Teak Terraces', 'general', 'America/Los_Angeles') as co \gset
insert into public.clients (company_id, display_name, payment_terms_days) values (:'co', 'Uma Upland', 7) returning id as uma \gset
insert into public.clients (company_id, display_name) values (:'co', 'Vic Vale') returning id as vic \gset
insert into public.quotes (company_id, client_id, title, deposit_amount) values (:'co', :'uma', 'Patio', 100) returning id as patio \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'patio', 'Pavers', 1000);
insert into public.quotes (company_id, client_id, title, deposit_amount) values (:'co', :'vic', 'Pergola', 200) returning id as pergola \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'pergola', 'Cedar', 2000);
update public.quotes set status = 'sent', sent_at = now() where id in (:'patio', :'pergola');
commit;
update public.companies set settings = settings || '{"payment_terms_days": 14, "late_fee": {"type": "flat", "amount": 25, "grace_days": 0}}' where id = :'co';

set role service_role;
select dit.check(public.approve_hub_quote(:'co', :'patio', null, '{"name": "Uma Upland"}'), 'Uma approves her patio');
select dit.check(public.approve_hub_quote(:'co', :'pergola', null, '{"name": "Vic Vale"}'), 'and Vic his pergola');
select public.hub_deposit_invoice(:'co', :'patio') as uma_deposit \gset
select public.hub_deposit_invoice(:'co', :'pergola') as vic_deposit \gset
reset role;

-- ===== Due on the payment terms ===============================================================
select dit.check((select kind = 'deposit' and status = 'sent' and issued_on = (now() at time zone 'America/Los_Angeles')::date
                    and due_on = issued_on + 7 from public.invoices where id = :'uma_deposit'), 'a deposit is due on the client''s own terms (7 days), not today');
select dit.check((select status = 'sent' and due_on = issued_on + 14 from public.invoices where id = :'vic_deposit'), 'else on the business''s (14 days)');

-- ===== Never a late fee ========================================================================
-- Weeks go by unpaid: the due dates are moved back as time would (without the triggers, which would
-- mark them overdue at once), next to an ordinary invoice of Vic's just as late.
insert into public.invoices (company_id, client_id, tax_rate, due_on) values (:'co', :'vic', 0, current_date + 14) returning id as vic_bill \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'vic_bill', 'Stain', 1, 'ea', 300);
update public.invoices set status = 'sent' where id = :'vic_bill';
set session_replication_role = replica;
update public.invoices set issued_on = issued_on - 60, due_on = due_on - 60 where id in (:'uma_deposit', :'vic_deposit', :'vic_bill');
set session_replication_role = default;

begin;
set local role service_role;
select public.add_late_fees() as added \gset
reset role;
select dit.check(exists (select 1 from public.invoice_line_items where invoice_id = :'vic_bill' and kind = 'late_fee'), 'an ordinary invoice as late gets its late fee');
select dit.check(not exists (select 1 from public.invoice_line_items where invoice_id in (:'uma_deposit', :'vic_deposit') and kind = 'late_fee')
  and (select bool_and(late_fee_at is null and total = balance_due and total in (100, 200)) from public.invoices where id in (:'uma_deposit', :'vic_deposit')),
  'a deposit never does, however late, and what it asks stays the same');
rollback;

\echo 'All deposit invoice terms tests passed.'
