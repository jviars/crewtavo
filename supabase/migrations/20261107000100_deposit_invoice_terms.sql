-- A deposit isn't a late bill. The deposit invoice the Client Hub makes as the client approves was
-- due that same day, so once its grace days passed it got a late fee, and the past-due email went
-- out, for work that hadn't started. Now it's due on the client's payment terms (else the
-- business's), as any invoice made in Crewtavo, and no deposit invoice ever gets a late fee.

-- As in 20261104000500_deposit_percent.sql, except the invoice is due on the payment terms.
create or replace function public.hub_deposit_invoice(p_company uuid, p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes;
  v_today date;
  v_terms integer;
  v_invoice uuid;
begin
  select * into q from public.quotes
   where company_id = p_company and id = p_quote and status in ('approved', 'converted')
   for update;
  if not found then
    return null;
  end if;
  if q.deposit_invoice_id is not null then
    return q.deposit_invoice_id;
  end if;
  if least(q.deposit_amount, q.total) <= 0 then
    return null;
  end if;
  select (now() at time zone coalesce(c.timezone, 'UTC'))::date,
         coalesce((select cl.payment_terms_days from public.clients cl where cl.id = q.client_id), (c.settings ->> 'payment_terms_days')::integer, 30)
    into v_today, v_terms
    from public.companies c where c.id = p_company;
  insert into public.invoices (company_id, client_id, job_id, kind, subject, issued_on, due_on, tax_rate)
  values (p_company, q.client_id,
          coalesce(q.change_order_for, (select j.id from public.jobs j where j.company_id = p_company and j.quote_id = q.id order by j.created_at limit 1)),
          'deposit', 'Deposit: ' || q.title, v_today, v_today + v_terms, 0)
  returning id into v_invoice;
  insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
  values (p_company, v_invoice, 'Deposit for ' || q.title, 1, 'ea', least(q.deposit_amount, q.total), false, 0);
  -- Sent once its line is on, so it goes out (and to Stripe) for what it asks.
  update public.invoices set status = 'sent' where id = v_invoice;
  update public.quotes set deposit_invoice_id = v_invoice where id = q.id;
  return v_invoice;
end $$;

-- As in 20261104000200_client_billing_late_fees.sql, except never on a deposit invoice: it's paid
-- before the work, so there's nothing late about it.
create or replace function public.add_late_fees() returns integer
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
       and i.kind <> 'deposit'
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

notify pgrst, 'reload schema';
