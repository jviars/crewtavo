-- Merging clients doesn't mark an invoice overdue. Moving an invoice to the kept client (and its
-- payments, which touch it) is an update, and every update works the invoice's status out again: an
-- unpaid one past its due date that the hourly upkeep hadn't marked overdue yet became overdue in
-- the merge, and the invoice.overdue automation emailed the client. A merge now leaves each status
-- as it was (merge_clients already refuses one that would change an invoice's totals).

-- As in 20261031000640_void_draft_not_sent.sql, except an invoice a merge moves keeps its status.
create or replace function private.invoice_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sub numeric; v_taxable numeric; v_base numeric; v_base_taxable numeric; v_lines integer;
  v_discount numeric; v_credits numeric; v_off numeric; v_paid numeric; v_today date;
begin
  if tg_op = 'UPDATE' and old.status = 'void' and new.status = 'void' then
    new.subtotal := old.subtotal;
    new.discount_amount := old.discount_amount;
    new.credit_amount := old.credit_amount;
    new.tax_amount := old.tax_amount;
    new.total := old.total;
    new.retainage_amount := old.retainage_amount;
    new.amount_paid := coalesce((select sum(amount) from public.payments where invoice_id = new.id), 0);
    new.balance_due := new.total - new.retainage_amount - new.amount_paid;
    return new;
  end if;
  select coalesce(sum(round(quantity * unit_price, 2)), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable and unit_price > 0), 0),
         count(*)
    into v_sub, v_taxable, v_base, v_base_taxable, v_lines
  from public.invoice_line_items where invoice_id = new.id;
  select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = new.id;
  select (now() at time zone coalesce(c.timezone, 'UTC'))::date into v_today from public.companies c where c.id = new.company_id;

  if new.promo_code_id is not null then
    new.discount_amount := coalesce(private.promo_discount(new.promo_code_id, v_base), 0);
  end if;
  v_discount := least(new.discount_amount, greatest(v_sub, 0));
  select coalesce(sum(amount), 0) into v_credits from public.referral_credits where invoice_id = new.id;
  new.credit_amount := least(v_credits, greatest(v_sub - v_discount, 0));
  v_off := v_discount + new.credit_amount;
  new.subtotal := v_sub;
  new.tax_amount := round(greatest(v_taxable - case when v_base > 0 then v_off * v_base_taxable / v_base else 0 end, 0) * new.tax_rate, 2);
  new.total := v_sub - v_off + new.tax_amount;
  new.retainage_amount := round(greatest(new.total, 0) * new.retainage_pct / 100, 2);
  new.amount_paid := v_paid;
  new.balance_due := new.total - new.retainage_amount - v_paid;

  if tg_op = 'UPDATE' and private.merging_clients(null, new.client_id) then
    -- Moved by a merge (or its payments were): it keeps its status, which the hourly upkeep changes
    -- later as it would have without the merge, so a merge never marks one overdue (and emails).
    new.status := old.status;
  elsif new.status = 'written_off' and (tg_op = 'INSERT' or old.status <> 'written_off') then
    -- Being written off now: invoice_void_guard checks there's something owed to write off.
    if tg_op = 'INSERT' then
      raise exception 'Send an invoice before writing it off' using errcode = '22023';
    end if;
  elsif new.status = 'written_off' then
    -- Paid after all.
    if v_lines > 0 and new.balance_due <= 0 then
      new.status := 'paid';
    end if;
  elsif new.status not in ('draft', 'void') then
    new.status := case
      when v_lines > 0 and new.balance_due <= 0 then 'paid'
      when new.due_on is not null and new.due_on < coalesce(v_today, current_date) then 'overdue'
      when v_paid > 0 then 'partially_paid'
      else 'sent'
    end;
  end if;
  new.written_off_at := case when new.status = 'written_off' then coalesce(new.written_off_at, now()) end;
  if new.status not in ('draft', 'void') and new.sent_at is null then
    new.sent_at := now();
  end if;
  return new;
end $$;
