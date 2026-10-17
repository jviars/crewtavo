-- Status changes made by BEFORE triggers (an invoice paid off by a payment, or past its due date)
-- don't list "status" in the UPDATE statement, so "after update of status" triggers never saw them:
-- no invoice.paid / invoice.overdue activity, automations or accounting sync. Fire on every update
-- instead; each function already compares the old and new status.

drop trigger activity on public.invoices;
create trigger activity after insert or update on public.invoices for each row execute function private.activity_invoices();
drop trigger enqueue_accounting on public.invoices;
create trigger enqueue_accounting after insert or update on public.invoices for each row execute function private.enqueue_accounting();
drop trigger release_visits on public.invoices;
create trigger release_visits after update on public.invoices for each row execute function private.release_visits();

drop trigger activity on public.quotes;
create trigger activity after update on public.quotes for each row execute function private.activity_quotes();
drop trigger referral_progress on public.quotes;
create trigger referral_progress after update on public.quotes for each row execute function private.referral_progress();
drop trigger activity on public.jobs;
create trigger activity after insert or update on public.jobs for each row execute function private.activity_jobs();
drop trigger activity on public.visits;
create trigger activity after update on public.visits for each row execute function private.activity_visits();

-- "Today" for due dates is the company's local date, not the database's UTC date. A past-due
-- balance shows as overdue even when part of it has been paid.
create or replace function private.invoice_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_sub numeric; v_taxable numeric; v_paid numeric; v_today date;
begin
  select coalesce(sum(round(quantity * unit_price, 2)), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable), 0)
    into v_sub, v_taxable
  from public.invoice_line_items where invoice_id = new.id;
  select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = new.id;
  select (now() at time zone coalesce(c.timezone, 'UTC'))::date into v_today from public.companies c where c.id = new.company_id;

  new.subtotal := v_sub;
  new.tax_amount := round(v_taxable * new.tax_rate, 2);
  new.total := v_sub + new.tax_amount;
  new.retainage_amount := round(new.total * new.retainage_pct / 100, 2);
  new.amount_paid := v_paid;
  new.balance_due := new.total - new.retainage_amount - v_paid;

  if new.status not in ('draft', 'void') then
    new.status := case
      when new.total > 0 and new.balance_due <= 0 then 'paid'
      when new.due_on is not null and new.due_on < coalesce(v_today, current_date) then 'overdue'
      when v_paid > 0 then 'partially_paid'
      else 'sent'
    end;
  end if;
  if new.status <> 'draft' and new.sent_at is null then
    new.sent_at := now();
  end if;
  return new;
end $$;

-- Hourly upkeep: flag invoices whose due date has passed in their company's time zone.
create function public.mark_overdue_invoices() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.invoices i set status = 'overdue'
    from public.companies c
   where c.id = i.company_id
     and i.status in ('sent', 'partially_paid')
     and i.balance_due > 0
     and i.due_on < (now() at time zone c.timezone)::date;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.mark_overdue_invoices() from public, anon, authenticated;
grant execute on function public.mark_overdue_invoices() to service_role;
