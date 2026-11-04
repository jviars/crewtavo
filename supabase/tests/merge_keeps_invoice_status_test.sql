-- Database tests for merges leaving invoice statuses alone (20261107000200_merge_keeps_invoice_status):
-- merging a client whose unpaid invoices are past due, but not yet marked overdue by the hourly
-- upkeep, moves them (and their payments) as they are, with no past-due notice; the upkeep marks
-- them overdue later, as it would have without the merge.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema mks;
grant usage on schema mks to authenticated, service_role;
create function mks.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema mks to authenticated, service_role;

-- Max owns Myrtle Mowing. Nell is on file twice: Nell Keep, and Nell N. with two unpaid invoices,
-- one with a payment on it.
insert into auth.users (id, email, raw_user_meta_data) values
  ('d1800000-0000-0000-0000-000000000001', 'max@myrtle-mowing.test', '{"full_name": "Max Myrtle"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1800000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Myrtle Mowing', 'general', 'UTC') as co \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Nell Keep', 'nell@myrtle-mowing.test') returning id as keep \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Nell N.', 'nell@myrtle-mowing.test') returning id as dupe \gset
insert into public.invoices (company_id, client_id, tax_rate) values (:'co', :'dupe', 0) returning id as unpaid \gset
insert into public.invoices (company_id, client_id, tax_rate) values (:'co', :'dupe', 0) returning id as part_paid \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values
  (:'co', :'unpaid', 'Mowing', 1, 'ea', 120), (:'co', :'part_paid', 'Edging', 1, 'ea', 90);
update public.invoices set status = 'sent', due_on = current_date where id in (:'unpaid', :'part_paid');
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'dupe', :'part_paid', 40, 'check');
commit;

-- Both fall due overnight, before the hourly upkeep has looked: moved back as time would move them,
-- without the triggers (which would mark them overdue at once).
set session_replication_role = replica;
update public.invoices set issued_on = current_date - 20, due_on = current_date - 3 where id in (:'unpaid', :'part_paid');
set session_replication_role = default;
select mks.check((select array_agg(status order by total desc) = '{sent,partially_paid}' from public.invoices where id in (:'unpaid', :'part_paid')),
  'two invoices past due, not marked overdue yet');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1800000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.merge_clients(:'co', :'keep', :'dupe') as merged \gset
commit;

select mks.check((select bool_and(client_id = :'keep') and array_agg(status order by total desc) = '{sent,partially_paid}'
  from public.invoices where id in (:'unpaid', :'part_paid')), 'merged, they''re the kept client''s with the status each had');
select mks.check((select client_id = :'keep' from public.payments where invoice_id = :'part_paid'), 'the payment moved with its invoice');
select mks.check(not exists (select 1 from public.activity where subject_id in (:'unpaid', :'part_paid') and verb = 'invoice.overdue'),
  'and nothing says they''re past due, so no automation emails the client');

-- The hourly upkeep marks them overdue, as it would have without the merge.
begin;
set local role service_role;
select public.mark_overdue_invoices() as marked \gset
reset role;
select mks.check((select bool_and(status = 'overdue') from public.invoices where id in (:'unpaid', :'part_paid')), 'the hourly upkeep marks both overdue later');
select mks.check((select count(*) = 2 from public.activity where subject_id in (:'unpaid', :'part_paid') and verb = 'invoice.overdue'), 'and says so then, once each');
rollback;

\echo 'All merge keeps invoice status tests passed.'
