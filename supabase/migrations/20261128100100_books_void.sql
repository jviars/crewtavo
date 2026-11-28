-- Voiding an invoice reaches the books. A sent invoice that went to QuickBooks or Zoho Books and was
-- then voided here stayed open there at its full balance: private.enqueue_accounting
-- (20261112000470_accounting_links_per_books.sql) leaves voids out, and the sync had no void call.
--
--   accounting.void   A new outbox topic, queued when a sent invoice is voided and the books have it
--                     (its link) or are about to (its accounting.invoice row is still waiting). The
--                     task voids the books' copy (voidInBooks in integrations/accounting.ts); an
--                     invoice the books never got does nothing there. It names the books it's for,
--                     as the other accounting rows do, so requeue_accounting() covers it too.
--
-- An invoice with payments can't be voided until they're refunded or removed
-- (private.invoice_void_guard), so this changes nothing about what a client owes or has paid here.
--
-- The version before this one still runs for a few minutes during an update. It doesn't know the
-- topic and fails the row ("Unknown topic accounting.void"), which the outbox tries again a few
-- minutes later, when this version runs it. That's why a void isn't queued as accounting.invoice:
-- the old version would send that as an update and call it done. private.enqueue_accounting is left
-- exactly as it was.

create function private.enqueue_accounting_void() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_provider text;
  v_account text;
  v_books jsonb := '{}';
begin
  -- Quiet, and the books it goes to, as in private.enqueue_accounting.
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

  if exists (select 1 from public.sync_links l
             where l.company_id = new.company_id and l.provider = v_provider and l.entity = 'invoice' and l.local_id = new.id)
     or exists (select 1 from public.outbox o
                where o.company_id = new.company_id and o.topic = 'accounting.invoice' and o.payload ->> 'invoice_id' = new.id::text
                  and o.done_at is null and o.dead_at is null) then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'accounting.void', jsonb_build_object('invoice_id', new.id) || v_books);
  end if;
  return null;
end $$;
revoke all on function private.enqueue_accounting_void() from public;

-- A draft never went to the books, and a void invoice stays void, so this runs once for an invoice.
create trigger enqueue_accounting_void after update on public.invoices
  for each row when (new.status = 'void' and old.status not in ('draft', 'void'))
  execute function private.enqueue_accounting_void();
