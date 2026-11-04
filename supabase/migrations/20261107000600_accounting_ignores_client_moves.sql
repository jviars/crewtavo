-- A merge moves invoices to the kept client (20261106000100_client_merge.sql). Re-sending each one
-- to QuickBooks or Zoho under the kept client's customer can be refused (no customer linked there
-- yet, or payments already on it), so a change of client alone no longer queues an update: the books
-- keep the invoice where it is, as before invoices were updated there. Otherwise as in
-- 20261106000520_accounting_invoice_updates.sql.
create or replace function private.enqueue_accounting() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Quiet (crewtavo.quiet = on, see 20261018000300_stripe.sql) as before; otherwise queued while the
  -- app is connected or waiting to be reconnected.
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' or not exists (
    select 1 from public.integrations
    where company_id = new.company_id and provider in ('quickbooks', 'zoho_books') and status in ('connected', 'error')
  ) then
    return null;
  end if;

  if tg_table_name = 'invoices' then
    if new.status not in ('draft', 'void') and (tg_op = 'INSERT' or old.status = 'draft') then
      insert into public.outbox (company_id, topic, payload)
      values (new.company_id, 'accounting.invoice', jsonb_build_object('invoice_id', new.id));
    -- Sent before, and changed in what the books show (a late fee is in its subtotal).
    elsif tg_op = 'UPDATE' and old.status not in ('draft', 'void') and new.status <> 'void'
          and (new.number, new.issued_on, new.due_on, new.subtotal, new.discount_amount, new.credit_amount, new.tax_amount, new.total)
              is distinct from (old.number, old.issued_on, old.due_on, old.subtotal, old.discount_amount, old.credit_amount, old.tax_amount, old.total)
          and (exists (select 1 from public.sync_links l where l.company_id = new.company_id and l.entity = 'invoice' and l.local_id = new.id)
               or exists (select 1 from public.outbox o where o.topic = 'accounting.invoice' and o.payload ->> 'invoice_id' = new.id::text and o.company_id = new.company_id))
          and not exists (
            select 1 from public.outbox o
            where o.topic = 'accounting.invoice' and o.payload ->> 'invoice_id' = new.id::text and o.company_id = new.company_id
              and o.done_at is null and o.dead_at is null and (o.locked_until is null or o.locked_until < now())) then
      insert into public.outbox (company_id, topic, payload)
      values (new.company_id, 'accounting.invoice', jsonb_build_object('invoice_id', new.id));
    end if;
  elsif tg_table_name = 'payments' then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'accounting.payment', jsonb_build_object('payment_id', new.id));
  end if;
  return null;
end $$;

notify pgrst, 'reload schema';
