-- Database tests for the books keeping up with an invoice (20261106000520_accounting_invoice_updates):
-- a sent invoice that went to the books is queued again when what they show changes (a line added,
-- edited or taken off, a due date, a discount), once while it waits; a payment, a touch with nothing
-- changed, a draft's edits and voiding aren't; and one brought in quietly (from Jobber, say) isn't.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tau;
grant usage on schema tau to authenticated, service_role;
create function tau.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The invoice's rows in the queue, those waiting and all.
create function tau.queued(p_invoice uuid, p_waiting boolean default false) returns bigint language sql security definer as $$
  select count(*) from public.outbox
  where topic = 'accounting.invoice' and payload ->> 'invoice_id' = p_invoice::text and (not p_waiting or done_at is null)
$$;
-- The queue's run of it: done, and in the books.
create function tau.synced(p_invoice uuid) returns void language sql as $$
  update public.outbox set done_at = now() where topic = 'accounting.invoice' and payload ->> 'invoice_id' = p_invoice::text and done_at is null;
  insert into public.sync_links (company_id, provider, entity, local_id, external_id)
  select company_id, 'quickbooks', 'invoice', id, 'qbo-' || number from public.invoices where id = p_invoice
  on conflict do nothing;
$$;
grant execute on all functions in schema tau to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c7a30000-0000-0000-0000-000000000001', 'gil@gale-gutters.test', '{"full_name": "Gil Gale"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a30000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Gale Gutters', 'general', 'America/Chicago') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Hal Gale') returning id as hal \gset
commit;
insert into public.integrations (company_id, provider, status) values (:'co', 'quickbooks', 'connected');

-- ===== Sent, then changed ======================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a30000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.invoices (company_id, client_id, subject, due_on) values (:'co', :'hal', 'Gutter clean', current_date + 30) returning id as inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, sort) values (:'co', :'inv', 'Gutters', 1, 150, 0);
update public.invoice_line_items set name = 'Gutters, front' where invoice_id = :'inv';
select tau.check(tau.queued(:'inv') = 0, 'a draft''s edits aren''t queued');
update public.invoices set status = 'sent' where id = :'inv';
select tau.check(tau.queued(:'inv') = 1, 'sent: queued for the books');
update public.invoices set due_on = current_date + 20 where id = :'inv';
select tau.check(tau.queued(:'inv') = 1, 'a change while it waits adds nothing: it goes as it is then');
commit;

-- The hourly run's late fee (add_late_fees puts its line on the sent invoice).
select tau.synced(:'inv');
begin;
set local crewtavo.late_fee = 'on';
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable, sort) values (:'co', :'inv', 'Late fee', 1, 25, false, 1);
commit;
select tau.check(tau.queued(:'inv', true) = 1 and (select total = 175 from public.invoices where id = :'inv'), 'in the books: a late fee queues it again');

-- Edited: back to draft for its lines, then sent again.
select tau.synced(:'inv');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a30000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.invoices set status = 'draft' where id = :'inv';
update public.invoice_line_items set unit_price = 160 where invoice_id = :'inv' and sort = 0;
select tau.check(tau.queued(:'inv', true) = 0, 'back in draft, its edits wait');
update public.invoices set status = 'sent' where id = :'inv';
select tau.check(tau.queued(:'inv', true) = 1, 'sent again, it''s queued (and the books'' copy updated)');
commit;

select tau.synced(:'inv');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a30000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'hal', :'inv', 50, 'check');
update public.invoices set updated_at = now() where id = :'inv';
select tau.check(tau.queued(:'inv', true) = 0 and (select status from public.invoices where id = :'inv') = 'partially_paid',
  'a payment, or a touch that changes nothing, doesn''t');
update public.invoices set due_on = current_date + 10 where id = :'inv';
select tau.check(tau.queued(:'inv', true) = 1, 'a new due date does');
commit;

-- Being worked on now: it may have read the invoice before this change, so the change is queued too.
update public.outbox set locked_until = now() + interval '5 minutes' where topic = 'accounting.invoice' and payload ->> 'invoice_id' = :'inv' and done_at is null;
update public.invoices set discount_amount = 10 where id = :'inv';
select tau.check(tau.queued(:'inv', true) = 2, 'a change while it''s being sent is queued after it');

-- ===== Brought in quietly ======================================================================
begin;
set local crewtavo.quiet = 'on';
insert into public.invoices (company_id, client_id, subject, due_on) values (:'co', :'hal', 'From Jobber', current_date + 30) returning id as quiet \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, sort) values (:'co', :'quiet', 'Old work', 1, 75, 0);
update public.invoices set status = 'sent' where id = :'quiet';
commit;
begin;
set local crewtavo.late_fee = 'on';
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable, sort) values (:'co', :'quiet', 'Late fee', 1, 25, false, 1);
commit;
update public.invoices set due_on = current_date + 5 where id = :'quiet';
select tau.check(tau.queued(:'quiet') = 0, 'an invoice brought in quietly never went to the books, so its changes aren''t sent either');

-- ===== Voided ==================================================================================
insert into public.invoices (company_id, client_id, subject, due_on) values (:'co', :'hal', 'Mistake', current_date + 30) returning id as oops \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, sort) values (:'co', :'oops', 'Wrong job', 1, 60, 0);
update public.invoices set status = 'sent' where id = :'oops';
select tau.synced(:'oops');
update public.invoices set status = 'void' where id = :'oops';
select tau.check(tau.queued(:'oops', true) = 0, 'voiding isn''t sent');

-- ===== Moved to another client by a merge ======================================================
-- The books keep it under its customer there (20261107000600_accounting_ignores_client_moves).
insert into public.clients (company_id, display_name) values (:'co', 'Hal G. (kept)') returning id as kept \gset
select tau.synced(:'inv');
begin;
select set_config('crewtavo.merge', :'hal' || '>' || :'kept', true);
update public.invoices set client_id = :'kept' where id = :'inv';
commit;
select tau.check((select client_id = :'kept' from public.invoices where id = :'inv') and tau.queued(:'inv', true) = 0,
  'moved to another client alone, it isn''t sent to the books again');

-- Nothing left for other tests' workers to claim.
delete from public.outbox where company_id = :'co';
delete from public.integrations where company_id = :'co';

\echo 'All accounting invoice update tests passed.'
