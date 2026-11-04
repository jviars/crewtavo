-- Billing per client, and late fees.
--
-- A tax-exempt client (clients.tax_exempt, with an optional note or certificate number) is charged
-- no tax: their quotes and invoices get a 0% rate when they're made, when they're moved to them,
-- and whenever someone gives one a rate; marking a client exempt takes the tax off their drafts.
-- Quotes and invoices already sent keep what they were sent with.
--
-- A client's own payment terms (clients.payment_terms_days) replace the business's when an invoice
-- is made with the business's due date (create_invoice_for_job, New invoice): a due date picked by
-- hand stays.
--
-- Late fees (settings.late_fee: {type: flat or percent, amount, grace_days}; off unless set): once
-- an invoice is more than grace_days past its due date with something owed, a "Late fee" line goes
-- on it, once (invoices.late_fee_at), never on a draft, paid, void or written-off invoice. A percent
-- is of the balance then. Late fees aren't taxed. The hourly upkeep adds them (add_late_fees).

alter table public.clients
  add column tax_exempt boolean not null default false,
  add column tax_exempt_note text check (length(tax_exempt_note) <= 200),
  add column payment_terms_days integer check (payment_terms_days between 0 and 365);
comment on column public.clients.tax_exempt is 'Charged no tax: their quotes and invoices get a 0% rate. The PDF says "Tax exempt".';
comment on column public.clients.tax_exempt_note is 'Their exemption certificate number or a note, printed with "Tax exempt".';
comment on column public.clients.payment_terms_days is 'Days until their invoices are due, in place of settings.payment_terms_days. Null: the business''s.';

alter table public.invoices add column late_fee_at timestamptz;
comment on column public.invoices.late_fee_at is 'When its late fee went on (add_late_fees): it never gets another.';

-- ---------------------------------------------------------------------------------------------
-- Tax exempt, and the client's payment terms
-- ---------------------------------------------------------------------------------------------

-- Named to run before quote_totals and invoice_totals, so the totals use the rate set here. On every
-- update, not "update of tax_rate", so the rate's column can still change type in a migration.
create function private.client_billing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c public.clients;
  v_terms integer;
begin
  if tg_op = 'UPDATE' then
    if new.client_id is not distinct from old.client_id and new.tax_rate is not distinct from old.tax_rate then return new; end if;
  end if;
  select * into c from public.clients where id = new.client_id;
  if not found then return new; end if;
  -- Due when the client's terms say, when it was given the business's due date (made in Crewtavo,
  -- not brought in from Stripe with Stripe's).
  if tg_op = 'INSERT' and tg_table_name = 'invoices' and c.payment_terms_days is not null then
    if new.job_id is not null or (select auth.uid()) is not null then
      select coalesce((settings ->> 'payment_terms_days')::integer, 30) into v_terms from public.companies where id = new.company_id;
      if new.due_on = new.issued_on + v_terms then
        new.due_on := new.issued_on + c.payment_terms_days;
      end if;
    end if;
  end if;
  if c.tax_exempt then
    new.tax_rate := 0;
  end if;
  return new;
end $$;
create trigger client_billing before insert or update on public.quotes
  for each row execute function private.client_billing();
create trigger client_billing before insert or update on public.invoices
  for each row execute function private.client_billing();

-- Marked exempt: their drafts lose their tax.
create function private.client_tax_exempt() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.quotes set tax_rate = 0 where client_id = new.id and status = 'draft' and tax_rate <> 0;
  update public.invoices set tax_rate = 0 where client_id = new.id and status = 'draft' and tax_rate <> 0;
  return null;
end $$;
create trigger tax_exempt after update of tax_exempt on public.clients
  for each row when (new.tax_exempt and not old.tax_exempt) execute function private.client_tax_exempt();

-- ---------------------------------------------------------------------------------------------
-- Late fees
-- ---------------------------------------------------------------------------------------------

-- As in 20261018000800_review_fixes.sql, except that add_late_fees puts its line on a sent invoice.
create or replace function private.invoice_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('crewtavo.late_fee', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and old.service_id is not null and new.service_id is null
     and to_jsonb(new) - 'service_id' = to_jsonb(old) - 'service_id' then
    return new;
  end if;
  if exists (
    select 1 from public.invoices i
    where i.id in (case when tg_op <> 'DELETE' then new.invoice_id end, case when tg_op <> 'INSERT' then old.invoice_id end)
      and i.status <> 'draft'
  ) then
    raise exception 'Move the invoice back to draft to change its line items' using errcode = '22023';
  end if;
  return coalesce(new, old);
end $$;

/**
 * Hourly (tasks.ts): a late fee on each invoice now more than its company's grace days past due with
 * something owed, once. Not on one made in Stripe (Stripe bills it), nor while autopay is charging
 * it or a bank payment for it is on its way (it may be paid; the next hour looks again). Each
 * invoice is marked as it's done and skipped while another run holds it, so running twice adds
 * nothing twice. Returns how many fees went on.
 */
create function public.add_late_fees() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_fee numeric;
  v_count integer := 0;
  v_was text := coalesce(current_setting('crewtavo.late_fee', true), '');
begin
  for r in
    select i.id, i.company_id, i.balance_due, i.due_on, c.settings -> 'late_fee' as fee
      from public.invoices i
      join public.companies c on c.id = i.company_id
     where jsonb_typeof(c.settings -> 'late_fee') = 'object'
       and c.settings -> 'late_fee' ->> 'type' in ('flat', 'percent')
       and jsonb_typeof(c.settings -> 'late_fee' -> 'amount') = 'number'
       and coalesce(jsonb_typeof(c.settings -> 'late_fee' -> 'grace_days'), 'number') = 'number'
       and i.status in ('sent', 'partially_paid', 'overdue')
       and i.balance_due > 0
       and i.late_fee_at is null
       and i.due_on + coalesce((c.settings -> 'late_fee' ->> 'grace_days')::numeric::integer, 0) < (now() at time zone c.timezone)::date
       and not exists (select 1 from public.stripe_invoices s where s.invoice_id = i.id and (s.origin = 'stripe' or s.status = 'processing'))
       and not exists (select 1 from public.autopay_charges a where a.invoice_id = i.id and a.status in ('charging', 'processing'))
     for update of i skip locked
  loop
    v_fee := case r.fee ->> 'type'
      when 'flat' then round((r.fee ->> 'amount')::numeric, 2)
      else round(r.balance_due * (r.fee ->> 'amount')::numeric / 100, 2) end;
    update public.invoices set late_fee_at = now() where id = r.id and late_fee_at is null;
    if found and v_fee > 0 then
      perform set_config('crewtavo.late_fee', 'on', true);
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort, kind)
      values (r.company_id, r.id, 'Late fee', 'The invoice was due ' || to_char(r.due_on, 'FMMonth FMDD, YYYY'), 1, 'ea', v_fee, false,
              coalesce((select max(sort) from public.invoice_line_items where invoice_id = r.id), 0) + 1, 'late_fee');
      perform set_config('crewtavo.late_fee', v_was, true);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;
revoke execute on function public.add_late_fees() from public, anon, authenticated;
grant execute on function public.add_late_fees() to service_role;

notify pgrst, 'reload schema';
