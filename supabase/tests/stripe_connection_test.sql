-- Database tests for switching the Stripe key: a Stripe invoice from the old account that Crewtavo
-- stopped following doesn't stop the new key from making the invoice's live one, and an invoice
-- still has only one live Stripe invoice among the ones it follows.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tstripeacct;
grant usage on schema tstripeacct to authenticated, service_role;
create function tstripeacct.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tstripeacct.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tstripeacct to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('5a000000-0000-0000-0000-000000000001', 'owner@switch.test', '{"full_name": "Sam Owner"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "5a000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Switchback Lawns', 'lawn_care') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Lee Client') returning id as client \gset
insert into public.invoices (company_id, client_id, subject) values (:'co', :'client', 'Mowing') returning id as inv \gset
commit;

-- The API writes Stripe invoices with the service key.
reset role;

-- Made with a test key: it says which account and mode it's in.
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, livemode, stripe_account)
values (:'co', :'inv', 'in_test_1', 'crewtavo', 'open', false, 'acct_A') returning id as old \gset
select tstripeacct.check((select detached_at is null from public.stripe_invoices where id = :'old'), 'a new Stripe invoice is followed');
select tstripeacct.expect_error(
  format('insert into public.stripe_invoices (company_id, invoice_id, origin, status) values (%L, %L, %L, %L)', :'co', :'inv', 'crewtavo', 'creating'),
  'while it''s live, the invoice can''t get another');

-- The key is switched to a live one: the test invoice is let go of, and the live key makes its own.
update public.stripe_invoices set detached_at = now() where id = :'old';
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, livemode, stripe_account)
values (:'co', :'inv', 'in_live_1', 'crewtavo', 'open', true, 'acct_A') returning id as new \gset
select tstripeacct.check((select count(*) = 2 from public.stripe_invoices where invoice_id = :'inv' and status = 'open'), 'one let go of stays as Stripe last had it, next to the new one');
select tstripeacct.expect_error(
  format('update public.stripe_invoices set detached_at = null where id = %L', :'old'),
  'and it can''t be followed again while the new one is live');
select tstripeacct.expect_error(
  format('insert into public.stripe_invoices (company_id, invoice_id, origin, status) values (%L, %L, %L, %L)', :'co', :'inv', 'crewtavo', 'processing'),
  'the new one is still the only live one');

-- A bank payment that was clearing in the old account is let go of too, and the invoice can still
-- be paid in the new one.
update public.stripe_invoices set status = 'void' where id = :'new';
update public.stripe_invoices set status = 'processing' where id = :'old';
insert into public.stripe_invoices (company_id, invoice_id, origin, status, livemode) values (:'co', :'inv', 'crewtavo', 'creating', true);
select tstripeacct.check((select count(*) = 2 from public.stripe_invoices where invoice_id = :'inv' and status in ('creating', 'processing')), 'a let-go bank payment doesn''t stop a new Stripe invoice');

\echo 'All Stripe connection tests passed.'
