-- Database tests for links to the books belonging to the books they were made in
-- (20261112000470_accounting_links_per_books): what was here before the update is marked as the
-- books the company has now; connecting another QuickBooks company or Zoho organization sets the old
-- links aside and going back brings them out again; queued changes say which books they're for.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tlb;
grant usage on schema tlb to authenticated, service_role;
create function tlb.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tlb.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- A company's links for an app, each with its books ("?" for none), and the ones set aside for some books.
create function tlb.links(p_company uuid, p_provider text) returns text language sql as $$
  select coalesce(string_agg(entity || ' ' || external_id || ' @' || coalesce(account_id, '?'), ', ' order by entity, external_id), '')
  from public.sync_links where company_id = p_company and provider = p_provider
$$;
create function tlb.parked(p_company uuid, p_account text) returns text language sql as $$
  select coalesce(string_agg(entity || ' ' || external_id, ', ' order by entity, external_id), '')
  from public.sync_links_parked where company_id = p_company and account_id = p_account
$$;
grant execute on all functions in schema tlb to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('1b000000-0000-0000-0000-000000000001', 'owner@birch-fence.test', '{"full_name": "Bea Birch"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "1b000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Birch Fence', 'general') as co \gset
select public.create_company('Birch Fence North', 'general') as north \gset
select public.create_company('Birch Fence South', 'general') as south \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ada Alder') returning id as ada \gset
insert into public.clients (company_id, display_name) values (:'north', 'Ned North') returning id as ned \gset
insert into public.clients (company_id, display_name) values (:'south', 'Sal South') returning id as sal \gset
insert into public.invoices (company_id, client_id, subject, due_on) values (:'co', :'ada', 'Cedar fence', current_date + 30) returning id as inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, sort) values (:'co', :'inv', 'Fence', 1, 900, 0);
commit;

-- ===== What was here before the update ==========================================================
-- Birch Fence tried QuickBooks' sandbox company; its links and waiting rows had no books on them.
insert into public.integrations (company_id, provider, status, external_account_id) values (:'co', 'quickbooks', 'connected', 'sandbox-1');
insert into public.sync_links (company_id, provider, entity, local_id, external_id) values
  (:'co', 'quickbooks', 'client', :'ada', 'cust-7'),
  (:'co', 'quickbooks', 'invoice', :'inv', 'inv-12'),
  (:'co', 'stripe', 'client', :'ada', 'cus_ada');
insert into public.outbox (company_id, topic, payload) values (:'co', 'accounting.invoice', jsonb_build_object('invoice_id', :'inv')) returning id as waiting \gset
insert into public.outbox (company_id, topic, payload, dead_at) values (:'co', 'accounting.payment', '{"payment_id": "00000000-0000-0000-0000-000000000001"}', now()) returning id as gave_up \gset
insert into public.outbox (company_id, topic, payload, done_at) values (:'co', 'accounting.payment', '{"payment_id": "00000000-0000-0000-0000-000000000002"}', now()) returning id as went \gset
insert into public.outbox (company_id, topic, payload) values (:'co', 'calendar.visit', '{"visit_id": "00000000-0000-0000-0000-000000000000"}') returning id as visit \gset
-- North signed out of Zoho Books a while ago (the organization stays on its row); South has links
-- and no app at all.
insert into public.integrations (company_id, provider, status, external_account_id) values (:'north', 'zoho_books', 'disconnected', 'org-9');
insert into public.sync_links (company_id, provider, entity, local_id, external_id) values (:'north', 'zoho_books', 'client', :'ned', 'contact-3');
insert into public.sync_links (company_id, provider, entity, local_id, external_id) values (:'south', 'quickbooks', 'client', :'sal', 'cust-1');
update public.sync_links set account_id = null where company_id in (:'co', :'north', :'south');

select tlb.check(private.backfill_accounting_books() >= 5, 'the backfill marks the links and the waiting rows');
select tlb.check(tlb.links(:'co', 'quickbooks') = 'client cust-7 @sandbox-1, invoice inv-12 @sandbox-1', 'links already here belong to the books connected now');
select tlb.check(tlb.links(:'co', 'stripe') = 'client cus_ada @?', 'Stripe''s links aren''t any books''');
select tlb.check((select payload ->> 'provider' = 'quickbooks' and payload ->> 'account_id' = 'sandbox-1' from public.outbox where id = :'waiting'), 'a change still waiting is for those books');
select tlb.check((select payload ->> 'account_id' = 'sandbox-1' from public.outbox where id = :'gave_up'), 'and one it gave up on');
select tlb.check((select not payload ? 'account_id' from public.outbox where id = :'went'), 'one that went is left alone');
select tlb.check((select not payload ? 'account_id' from public.outbox where id = :'visit'), 'and so is calendar work');
select tlb.check(tlb.links(:'north', 'zoho_books') = 'client contact-3 @org-9', 'signed out, the links are the last organization''s');
select tlb.check(tlb.links(:'south', 'quickbooks') = 'client cust-1 @?', 'with no app, the links stay as they are');
select tlb.check((select count(*) = 0 from public.sync_links_parked where company_id in (:'co', :'north', :'south')), 'nothing is set aside by the backfill');
select tlb.check(private.backfill_accounting_books() = 0, 'run again, it finds nothing more');
select tlb.check(not has_function_privilege('authenticated', 'private.backfill_accounting_books()', 'execute'), 'nobody signed in can run the backfill');

-- ===== The version before this one, during an update ============================================
-- It saves a link without saying which books: the connected ones, where it just sent the record.
delete from public.sync_links where company_id = :'co' and provider = 'quickbooks' and entity = 'invoice';
insert into public.sync_links (company_id, provider, entity, local_id, external_id) values (:'co', 'quickbooks', 'invoice', :'inv', 'inv-12');
select tlb.check(tlb.links(:'co', 'quickbooks') = 'client cust-7 @sandbox-1, invoice inv-12 @sandbox-1', 'a link saved without its books gets the connected ones');
-- Its upsert of a link it has (by the same key as before) still works.
insert into public.sync_links (company_id, provider, entity, local_id, external_id) values (:'co', 'quickbooks', 'invoice', :'inv', 'inv-12')
  on conflict (company_id, provider, entity, local_id) do update set synced_at = now();
select tlb.check((select count(*) = 2 from public.sync_links where company_id = :'co' and provider = 'quickbooks'), 'and saving it again changes nothing');

-- ===== Another company's books ==================================================================
-- Reconnecting the same books moves nothing.
update public.integrations set status = 'connected', external_account_id = 'sandbox-1', connected_at = now() where company_id = :'co' and provider = 'quickbooks';
select tlb.check(tlb.links(:'co', 'quickbooks') = 'client cust-7 @sandbox-1, invoice inv-12 @sandbox-1', 'connecting the same books again keeps the links');

-- Now the real QuickBooks company.
update public.integrations set external_account_id = 'real-1' where company_id = :'co' and provider = 'quickbooks';
select tlb.check(tlb.links(:'co', 'quickbooks') = '', 'another company connected: none of the old links are in use');
select tlb.check(tlb.parked(:'co', 'sandbox-1') = 'client cust-7, invoice inv-12', 'they''re set aside, not deleted');
select tlb.check(tlb.links(:'co', 'stripe') = 'client cus_ada @?', 'Stripe''s link stays where it is');

-- A payment now is queued for the real books; the invoice goes there as new (the task's part), and
-- its link is the real books'.
insert into public.payments (company_id, client_id, amount, method) values (:'co', :'ada', 100, 'check') returning id as pay \gset
select tlb.check((select payload ->> 'provider' = 'quickbooks' and payload ->> 'account_id' = 'real-1' from public.outbox where payload ->> 'payment_id' = :'pay'), 'a payment is queued for the books connected now');
insert into public.sync_links (company_id, provider, entity, local_id, external_id, account_id) values (:'co', 'quickbooks', 'invoice', :'inv', 'inv-4001', 'real-1');

-- The change queued for the sandbox is still waiting. It doesn't stand in for a change now.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "1b000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.invoices set status = 'sent' where id = :'inv';
commit;
update public.outbox set done_at = now() where company_id = :'co' and topic = 'accounting.invoice' and payload ->> 'account_id' = 'real-1';
update public.invoices set due_on = current_date + 10 where id = :'inv';
select tlb.check((select count(*) = 1 from public.outbox where company_id = :'co' and topic = 'accounting.invoice' and done_at is null and payload ->> 'account_id' = 'real-1'),
  'a changed invoice is queued for the new books though a row for the old ones still waits');
update public.invoices set due_on = current_date + 11 where id = :'inv';
select tlb.check((select count(*) = 1 from public.outbox where company_id = :'co' and topic = 'accounting.invoice' and done_at is null and payload ->> 'account_id' = 'real-1'),
  'and once while that one waits');

-- Back to the sandbox: its links come out again, and the real company's are set aside.
update public.integrations set external_account_id = 'sandbox-1' where company_id = :'co' and provider = 'quickbooks';
select tlb.check(tlb.links(:'co', 'quickbooks') = 'client cust-7 @sandbox-1, invoice inv-12 @sandbox-1', 'the first company connected again: its links are back');
select tlb.check(tlb.parked(:'co', 'real-1') = 'invoice inv-4001' and tlb.parked(:'co', 'sandbox-1') = '', 'and the other company''s are set aside');
update public.integrations set external_account_id = 'real-1' where company_id = :'co' and provider = 'quickbooks';
select tlb.check(tlb.links(:'co', 'quickbooks') = 'invoice inv-4001 @real-1', 'and the other way round');

-- Zoho Books instead of QuickBooks: QuickBooks' links are QuickBooks' still.
insert into public.integrations (company_id, provider, status, external_account_id) values (:'co', 'zoho_books', 'connected', 'org-1');
select tlb.check(tlb.links(:'co', 'quickbooks') = 'invoice inv-4001 @real-1', 'connecting another app leaves this one''s links');

-- ===== Links nobody can say the books of ========================================================
-- South connects QuickBooks for the first time since: the old link isn't taken for these books'.
insert into public.integrations (company_id, provider, status, external_account_id) values (:'south', 'quickbooks', 'connected', 'real-2');
select tlb.check(tlb.links(:'south', 'quickbooks') = '' and tlb.parked(:'south', '') = 'client cust-1', 'links with no books to name are set aside when books are connected');

-- ===== Tried again ==============================================================================
-- The task gave up on these for the sandbox: one after its tries, one because other books were
-- connected, and one the sandbox took but whose link couldn't be saved. And one for the real books.
update public.outbox set attempts = 9, last_error = 'QuickBooks invoice: 400 Stale Object Error' where id = :'gave_up';
update public.outbox set dead_at = now(), attempts = 2, locked_until = now() + interval '5 minutes', run_after = now() + interval '1 hour',
  last_error = 'Queued for other books than the ones connected now. It goes when those are connected again.' where id = :'waiting';
insert into public.outbox (company_id, topic, payload, dead_at, attempts, last_error)
values (:'co', 'accounting.invoice', jsonb_build_object('invoice_id', :'inv', 'provider', 'quickbooks', 'account_id', 'sandbox-1'), now(), 1, 'Sent invoice 12 but couldn''t record it: connection reset')
returning id as unrecorded \gset
insert into public.outbox (company_id, topic, payload, dead_at, attempts, last_error)
values (:'co', 'accounting.invoice', jsonb_build_object('invoice_id', :'inv', 'provider', 'quickbooks', 'account_id', 'real-1'), now(), 9, 'QuickBooks invoice: 400 Stale Object Error')
returning id as real_gave_up \gset
insert into public.outbox (company_id, topic, payload, dead_at, attempts, last_error)
values (:'north', 'accounting.invoice', '{"invoice_id": "00000000-0000-0000-0000-000000000003", "provider": "quickbooks", "account_id": "sandbox-1"}', now(), 9, 'Invoice not found')
returning id as norths \gset

set role service_role;
select tlb.check(public.requeue_accounting(:'co', 'quickbooks', 'sandbox-1') = 2, 'what the task gave up on for those books is queued again');
reset role;
select tlb.check((select bool_and(dead_at is null and attempts = 0 and locked_until is null and run_after <= now()) from public.outbox where id in (:'gave_up', :'waiting')),
  'with its tries back, to go now');
select tlb.check((select dead_at is not null from public.outbox where id = :'unrecorded'), 'not one the books took already: it would be there twice');
select tlb.check((select dead_at is not null from public.outbox where id = :'real_gave_up'), 'nor one for other books');
select tlb.check((select dead_at is not null from public.outbox where id = :'norths'), 'nor another business''s');
select tlb.check((select done_at is not null from public.outbox where id = :'went'), 'and what went stays done');
set role service_role;
select tlb.check(public.requeue_accounting(:'co', 'quickbooks', 'sandbox-1') = 0, 'asked again, there''s nothing more');
reset role;

-- ===== Who can see them =========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "1b000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tlb.expect_error(format('select public.requeue_accounting(%L, %L, %L)', :'co', 'quickbooks', 'sandbox-1'), 'only the engine queues changes again');
select tlb.expect_error('select * from public.sync_links_parked', 'links set aside are the engine''s only');
select tlb.check((select count(*) = 2 from public.sync_links where company_id = :'co'), 'the owner still reads the links in use');
commit;

-- Nothing left for other tests' workers to claim.
delete from public.outbox where company_id in (:'co', :'north', :'south');
delete from public.integrations where company_id in (:'co', :'north', :'south');

\echo 'All accounting links per books tests passed.'
