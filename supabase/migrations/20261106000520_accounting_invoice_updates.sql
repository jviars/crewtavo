-- QuickBooks and Zoho Books keep up with an invoice. It was queued for the books when it left draft,
-- and the outbox task only ever made it there, so what changed after never reached them: a late fee
-- the hourly run added, an edit (a sent invoice goes back to draft for its lines to change, with its
-- minimum charge, and is sent again), a promo code or referral credit, a new due date. Now the task
-- updates the copy the books have (integrations/accounting.ts, each one's update API) whenever it's
-- queued, and a sent invoice is queued again ('accounting.invoice', as before) when what the books
-- show of it changes, with the queue's usual retries. A payment recorded, or the invoice falling past
-- due, isn't a change to it there. Voiding still isn't sent: that's done in the books by hand.
--
-- Only an invoice that went to the books (or is on its way) is sent again: one brought in quietly,
-- from Jobber or Stripe, never went, and the books may have it from there already. And one change
-- queues it once: while it's queued and not yet started, it reads the invoice as it is when it
-- runs, so more changes add nothing.

-- Finding an invoice's place in the queue.
create index outbox_invoice_idx on public.outbox ((payload ->> 'invoice_id')) where topic = 'accounting.invoice';

-- As in 20261018000500_recurrence_skips_and_runs.sql, plus a sent invoice's changes.
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
          and (new.client_id, new.number, new.issued_on, new.due_on, new.subtotal, new.discount_amount, new.credit_amount, new.tax_amount, new.total)
              is distinct from (old.client_id, old.number, old.issued_on, old.due_on, old.subtotal, old.discount_amount, old.credit_amount, old.tax_amount, old.total)
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
