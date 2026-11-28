-- Database tests for voiding an invoice reaching the books (20261128100100_books_void): a sent
-- invoice the books have, or are about to get, queues its void for those books when it's voided,
-- once; one the books never got, a draft and one voided quietly don't; one with a payment can't be
-- voided until the payment is refunded, and then its void is queued; and a void the task gave up on
-- goes again with the rest.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tbv;
grant usage on schema tbv to authenticated, service_role;
create function tbv.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tbv.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- A sent invoice for $60.
create function tbv.sent(p_company uuid, p_client uuid, p_subject text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.invoices (company_id, client_id, subject, due_on) values (p_company, p_client, p_subject, current_date + 30) returning id into v_id;
  insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, sort) values (p_company, v_id, 'Work', 1, 60, 0);
  update public.invoices set status = 'sent' where id = v_id;
  return v_id;
end $$;
-- The queue's run of its sending: done, and in QuickBooks.
create function tbv.synced(p_invoice uuid) returns void language sql as $$
  update public.outbox set done_at = now() where topic = 'accounting.invoice' and payload ->> 'invoice_id' = p_invoice::text and done_at is null;
  insert into public.sync_links (company_id, provider, entity, local_id, external_id)
  select company_id, 'quickbooks', 'invoice', id, 'qbo-' || number from public.invoices where id = p_invoice
  on conflict do nothing;
$$;
-- The invoice's voids in the queue, and its other rows still waiting.
create function tbv.voids(p_invoice uuid) returns bigint language sql as $$
  select count(*) from public.outbox where topic = 'accounting.void' and payload ->> 'invoice_id' = p_invoice::text
$$;
create function tbv.updates_waiting(p_invoice uuid) returns bigint language sql as $$
  select count(*) from public.outbox where topic = 'accounting.invoice' and payload ->> 'invoice_id' = p_invoice::text and done_at is null
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b0050000-0000-0000-0000-000000000001', 'vi@vale-paving.test', '{"full_name": "Vi Vale"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b0050000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Vale Paving', 'paving') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Otto Oak') returning id as otto \gset
commit;

-- Sent before QuickBooks was connected: the books never got it.
select tbv.sent(:'co', :'otto', 'Before the books') as before \gset
insert into public.integrations (company_id, provider, status, external_account_id) values (:'co', 'quickbooks', 'connected', 'realm-1');

-- ===== In the books, then voided ===============================================================
select tbv.sent(:'co', :'otto', 'Wrong job') as oops \gset
select tbv.synced(:'oops');
update public.invoices set status = 'void' where id = :'oops';
select tbv.check(tbv.voids(:'oops') = 1, 'voiding an invoice the books have queues its void');
select tbv.check((select payload ->> 'provider' = 'quickbooks' and payload ->> 'account_id' = 'realm-1' and done_at is null and dead_at is null
                  from public.outbox where topic = 'accounting.void' and payload ->> 'invoice_id' = :'oops'), 'for the books connected now, to be tried like the rest');
select tbv.check(tbv.updates_waiting(:'oops') = 0, 'and no update of it');
update public.invoices set updated_at = now() where id = :'oops';
select tbv.check(tbv.voids(:'oops') = 1, 'once: a void invoice touched again queues nothing');

-- ===== Never in the books ======================================================================
update public.invoices set status = 'void' where id = :'before';
select tbv.check(tbv.voids(:'before') = 0, 'one the books never got queues nothing');

insert into public.invoices (company_id, client_id, subject) values (:'co', :'otto', 'Never sent') returning id as draft \gset
update public.invoices set status = 'void' where id = :'draft';
select tbv.check(tbv.voids(:'draft') = 0, 'nor does a draft');

-- ===== Still on its way to the books ===========================================================
select tbv.sent(:'co', :'otto', 'Sent a minute ago') as fresh \gset
select tbv.check(tbv.updates_waiting(:'fresh') = 1, 'a sent invoice waits to go to the books');
update public.invoices set status = 'void' where id = :'fresh';
select tbv.check(tbv.voids(:'fresh') = 1, 'voided while it waits, its void is queued behind it');
select tbv.check((select max(id) filter (where topic = 'accounting.void') > max(id) filter (where topic = 'accounting.invoice')
                  from public.outbox where payload ->> 'invoice_id' = :'fresh'), 'after its sending');

-- ===== Paid ====================================================================================
select tbv.sent(:'co', :'otto', 'Paid, then refunded') as paid \gset
select tbv.synced(:'paid');
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'otto', :'paid', 60, 'check');
select tbv.expect_error(format('update public.invoices set status = ''void'' where id = %L', :'paid'), 'an invoice with a payment can''t be voided');
select tbv.check(tbv.voids(:'paid') = 0, 'so nothing is queued for it');
insert into public.payments (company_id, client_id, invoice_id, amount, method, notes) values (:'co', :'otto', :'paid', -60, 'check', 'Refund');
update public.invoices set status = 'void' where id = :'paid';
select tbv.check(tbv.voids(:'paid') = 1, 'refunded and voided, its void is queued');

-- ===== Quietly =================================================================================
select tbv.sent(:'co', :'otto', 'Tidied by an import') as quiet \gset
select tbv.synced(:'quiet');
begin;
set local crewtavo.quiet = 'on';
update public.invoices set status = 'void' where id = :'quiet';
commit;
select tbv.check(tbv.voids(:'quiet') = 0, 'voided quietly, nothing goes to the books');

-- ===== Waiting to be reconnected, and given up on ==============================================
update public.integrations set status = 'error' where company_id = :'co' and provider = 'quickbooks';
select tbv.sent(:'co', :'otto', 'While signed out') as later \gset
select tbv.synced(:'later');
update public.invoices set status = 'void' where id = :'later';
select tbv.check(tbv.voids(:'later') = 1, 'with the app waiting to be reconnected, the void is kept for it');
update public.integrations set status = 'connected' where company_id = :'co' and provider = 'quickbooks';

update public.outbox set dead_at = now(), attempts = 9, last_error = 'QuickBooks invoice?operation=void: 400 Stale Object Error'
 where topic = 'accounting.void' and payload ->> 'invoice_id' = :'oops';
select tbv.check(public.requeue_accounting(:'co', 'quickbooks', 'realm-1') = 1, 'a void the task gave up on is queued again with the rest');
select tbv.check((select dead_at is null and attempts = 0 from public.outbox where topic = 'accounting.void' and payload ->> 'invoice_id' = :'oops'), 'with its tries back');

-- ===== No accounting app =======================================================================
delete from public.integrations where company_id = :'co';
select tbv.sent(:'co', :'otto', 'No books') as nobooks \gset
insert into public.sync_links (company_id, provider, entity, local_id, external_id, account_id) values (:'co', 'quickbooks', 'invoice', :'nobooks', 'qbo-old', 'realm-1');
update public.invoices set status = 'void' where id = :'nobooks';
select tbv.check(tbv.voids(:'nobooks') = 0, 'with no accounting app, nothing is queued');

-- Nothing left for other tests' workers to claim.
delete from public.outbox where company_id = :'co';

\echo 'All books void tests passed.'
