-- A link to the books belongs to the books it was made in. sync_links said only which app a record
-- went to (QuickBooks, Zoho Books), not which company there, and nothing cleared them. So a business
-- that tried QuickBooks against a sandbox company and then connected its real one kept the sandbox's
-- ids: an edited invoice was written over whatever real invoice had that id, new invoices went to the
-- old customer ids, and payments linked before were never sent.
--
--   sync_links.account_id     The QuickBooks company (realm) or Zoho Books organization the link was
--                             made in: integrations.external_account_id at the time. The sync only
--                             uses links of the books connected now (integrations/accounting.ts).
--                             Null for Stripe's links, and for links nobody can say the books of.
--   sync_links_parked         Links to other books than the ones connected. Connecting other books
--                             moves the links here and brings back the ones made in those books
--                             before (private.park_accounting_links), so going back to the first
--                             company finds its records again and nothing is sent twice.
--   outbox.payload            Accounting rows say which books they were queued for (provider,
--                             account_id), so one queued for the old books isn't sent to the new.
--   requeue_accounting()      Changes for some books that the task gave up on, queued again: for
--                             when those books are connected again, or the owner asks.
--   backfill                 Links and waiting rows already here belong to the books the company
--                             has now, connected or not (private.backfill_accounting_books). Links
--                             with no books to name stay as they are, and are parked when books are
--                             connected.
--
-- The version before this one still runs for a few minutes during an update: it reads and writes
-- sync_links without account_id. Its key is unchanged, the column is filled in for it
-- (private.stamp_sync_link_books), and links to other books are out of the table, so it's right too.

alter table public.sync_links add column account_id text;
comment on column public.sync_links.account_id is 'QuickBooks realm ID or Zoho organization ID the link was made in. Null for Stripe, or when the books aren''t known.';

create table public.sync_links_parked (
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null,
  account_id text not null, -- '' when the books weren't known
  entity text not null,
  local_id uuid not null,
  external_id text not null,
  sync_token text,
  synced_at timestamptz not null,
  parked_at timestamptz not null default now(),
  primary key (company_id, provider, account_id, entity, local_id)
);
-- RLS on and no policies: only the service key and the functions here read or write.
alter table public.sync_links_parked enable row level security;
revoke all on public.sync_links_parked from authenticated, anon;

-- A link saved without its books (the version before this one, during an update) is the connected
-- books': that's where the record was just sent.
create function private.stamp_sync_link_books() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.account_id is null and new.provider in ('quickbooks', 'zoho_books') then
    select i.external_account_id into new.account_id
    from public.integrations i where i.company_id = new.company_id and i.provider = new.provider;
  end if;
  return new;
end $$;
create trigger stamp_books before insert on public.sync_links
  for each row execute function private.stamp_sync_link_books();

-- Other books connected (another QuickBooks company or Zoho organization): the links to the ones
-- before are set aside, kept in case they're connected again, and the ones made in these books
-- before come back. Records with no link here go to the books as new.
create function private.park_accounting_links() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.provider not in ('quickbooks', 'zoho_books') or new.external_account_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.external_account_id is not distinct from old.external_account_id then
      return null;
    end if;
  end if;

  with moved as (
    delete from public.sync_links l
    where l.company_id = new.company_id and l.provider = new.provider and l.account_id is distinct from new.external_account_id
    returning l.*
  )
  insert into public.sync_links_parked (company_id, provider, account_id, entity, local_id, external_id, sync_token, synced_at)
  select m.company_id, m.provider, coalesce(m.account_id, ''), m.entity, m.local_id, m.external_id, m.sync_token, m.synced_at from moved m
  on conflict (company_id, provider, account_id, entity, local_id)
    do update set external_id = excluded.external_id, sync_token = excluded.sync_token, synced_at = excluded.synced_at, parked_at = now();

  with back as (
    delete from public.sync_links_parked p
    where p.company_id = new.company_id and p.provider = new.provider and p.account_id = new.external_account_id
    returning p.*
  )
  insert into public.sync_links (company_id, provider, account_id, entity, local_id, external_id, sync_token, synced_at)
  select b.company_id, b.provider, b.account_id, b.entity, b.local_id, b.external_id, b.sync_token, b.synced_at from back b
  on conflict (company_id, provider, entity, local_id) do nothing;
  return null;
end $$;
create trigger park_accounting_links after insert or update of external_account_id on public.integrations
  for each row execute function private.park_accounting_links();

-- As in 20261107000600_accounting_ignores_client_moves.sql, and each row says which books it was
-- queued for: the connected app's, or the one waiting to be reconnected. The task sends it only
-- there (runAccountingJob). A row waiting for other books doesn't stand in for this change.
create or replace function private.enqueue_accounting() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_provider text;
  v_account text;
  v_books jsonb := '{}';
begin
  -- Quiet (crewtavo.quiet = on, see 20261018000300_stripe.sql) as before; otherwise queued while the
  -- app is connected or waiting to be reconnected.
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' then
    return null;
  end if;
  select i.provider, i.external_account_id into v_provider, v_account
  from public.integrations i
  where i.company_id = new.company_id and i.provider in ('quickbooks', 'zoho_books') and i.status in ('connected', 'error')
  order by (i.status = 'connected') desc, i.provider
  limit 1;
  if not found then
    return null;
  end if;
  if v_account is not null then
    v_books := jsonb_build_object('provider', v_provider, 'account_id', v_account);
  end if;

  if tg_table_name = 'invoices' then
    if new.status not in ('draft', 'void') and (tg_op = 'INSERT' or old.status = 'draft') then
      insert into public.outbox (company_id, topic, payload)
      values (new.company_id, 'accounting.invoice', jsonb_build_object('invoice_id', new.id) || v_books);
    -- Sent before, and changed in what the books show (a late fee is in its subtotal).
    elsif tg_op = 'UPDATE' and old.status not in ('draft', 'void') and new.status <> 'void'
          and (new.number, new.issued_on, new.due_on, new.subtotal, new.discount_amount, new.credit_amount, new.tax_amount, new.total)
              is distinct from (old.number, old.issued_on, old.due_on, old.subtotal, old.discount_amount, old.credit_amount, old.tax_amount, old.total)
          and (exists (select 1 from public.sync_links l where l.company_id = new.company_id and l.entity = 'invoice' and l.local_id = new.id)
               or exists (select 1 from public.outbox o where o.topic = 'accounting.invoice' and o.payload ->> 'invoice_id' = new.id::text and o.company_id = new.company_id))
          and not exists (
            select 1 from public.outbox o
            where o.topic = 'accounting.invoice' and o.payload ->> 'invoice_id' = new.id::text and o.company_id = new.company_id
              and o.done_at is null and o.dead_at is null and (o.locked_until is null or o.locked_until < now())
              and (o.payload ->> 'account_id' is null or v_account is null
                   or (o.payload ->> 'provider', o.payload ->> 'account_id') = (v_provider, v_account))) then
      insert into public.outbox (company_id, topic, payload)
      values (new.company_id, 'accounting.invoice', jsonb_build_object('invoice_id', new.id) || v_books);
    end if;
  elsif tg_table_name = 'payments' then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'accounting.payment', jsonb_build_object('payment_id', new.id) || v_books);
  end if;
  return null;
end $$;

-- What's here already belongs to the books the company has now: its links to QuickBooks or Zoho
-- Books, and the accounting rows still waiting or given up on (the app connected, else the one
-- waiting to be reconnected, else the one signed out of last). Says how many it marked. Run again,
-- it finds nothing more.
create function private.backfill_accounting_books() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_links integer;
  v_rows integer;
begin
  update public.sync_links l
     set account_id = i.external_account_id
    from public.integrations i
   where i.company_id = l.company_id and i.provider = l.provider and i.external_account_id is not null
     and l.provider in ('quickbooks', 'zoho_books') and l.account_id is null;
  get diagnostics v_links = row_count;

  update public.outbox o
     set payload = o.payload || jsonb_build_object('provider', b.provider, 'account_id', b.external_account_id)
    from (
      select distinct on (i.company_id) i.company_id, i.provider, i.external_account_id
      from public.integrations i
      where i.provider in ('quickbooks', 'zoho_books') and i.external_account_id is not null
      order by i.company_id, case i.status when 'connected' then 0 when 'error' then 1 else 2 end, i.connected_at desc nulls last, i.provider
    ) b
   where b.company_id = o.company_id and o.topic like 'accounting.%' and o.done_at is null and not o.payload ? 'account_id';
  get diagnostics v_rows = row_count;
  return v_links + v_rows;
end $$;
select private.backfill_accounting_books();

-- Accounting changes the task gave up on (after its tries, or because other books were connected),
-- queued again for the books they were for, with their tries back. Never one the books took but
-- whose link couldn't be saved (SentButUnrecorded in integrations/accounting.ts, by how its error
-- reads): sent again, it would be in the books twice. Says how many it queued. Service key only.
create function public.requeue_accounting(p_company uuid, p_provider text, p_account text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.outbox o
     set dead_at = null, attempts = 0, run_after = now(), locked_until = null
   where o.company_id = p_company and o.topic like 'accounting.%' and o.done_at is null and o.dead_at is not null
     and o.payload ->> 'provider' = p_provider and o.payload ->> 'account_id' = p_account
     and o.last_error not like 'Sent % but couldn''t record it:%';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.requeue_accounting(uuid, text, text) from public, anon, authenticated;
grant execute on function public.requeue_accounting(uuid, text, text) to service_role;

revoke all on function private.stamp_sync_link_books(), private.park_accounting_links(), private.backfill_accounting_books() from public;

notify pgrst, 'reload schema';
