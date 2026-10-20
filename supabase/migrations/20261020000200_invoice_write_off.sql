-- Writing off an invoice: the client is never going to pay what's left, and the business takes the
-- loss. Unlike voiding (a bill that shouldn't have been sent), the work was done and billed:
--
--   * Only what's still owed on a sent invoice is written off, partly paid ones included. It stays
--     "invoiced" (the dashboard and reports still count it) and keeps its visits, so they don't
--     come back as needing an invoice.
--   * It's no longer owed: off Awaiting payment, Past due, receivables, the Client Hub's to-do
--     list and reminders. Reminders already waiting to go out for it are called off.
--   * If the client pays after all, the payment is recorded on it as usual and it's paid once
--     nothing's left. Undoing the write-off (status back to 'sent') makes it owed again, past due
--     or not by its due date as before.
--   * written_off_at says when, for the Money report's "Written off" total. Stripe's "uncollectible"
--     is the same thing (apps/api/src/integrations/stripe.ts keeps the two in step).

alter table public.invoices drop constraint invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void', 'written_off'));
alter table public.invoices add column written_off_at timestamptz;
comment on column public.invoices.written_off_at is 'When what was left on it was written off as a loss (status written_off).';

-- Totals and status (20261017001600_promo_codes.sql), with written-off invoices left written off
-- until they're paid.
create or replace function private.invoice_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sub numeric; v_taxable numeric; v_base numeric; v_base_taxable numeric; v_lines integer;
  v_discount numeric; v_paid numeric; v_today date;
begin
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
  new.subtotal := v_sub;
  new.tax_amount := round(greatest(v_taxable - case when v_base > 0 then v_discount * v_base_taxable / v_base else 0 end, 0) * new.tax_rate, 2);
  new.total := v_sub - v_discount + new.tax_amount;
  new.retainage_amount := round(greatest(new.total, 0) * new.retainage_pct / 100, 2);
  new.amount_paid := v_paid;
  new.balance_due := new.total - new.retainage_amount - v_paid;

  if new.status = 'written_off' and (tg_op = 'INSERT' or old.status <> 'written_off') then
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
  if new.status <> 'draft' and new.sent_at is null then
    new.sent_at := now();
  end if;
  return new;
end $$;

-- Status changes (20261018000100_audit_fixes.sql), plus what can be written off. Runs after
-- invoice_totals (triggers go in name order), so balance_due is up to date.
create or replace function private.invoice_void_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'A void invoice stays void. Make a new invoice instead' using errcode = '22023';
  end if;
  if new.status = 'void' and old.status <> 'void'
     and coalesce((select sum(amount) from public.payments where invoice_id = new.id), 0) <> 0 then
    raise exception 'This invoice has payments. Refund or remove them before voiding it' using errcode = '22023';
  end if;
  if new.status = 'draft' and old.status <> 'draft'
     and exists (select 1 from public.payments where invoice_id = new.id) then
    raise exception 'This invoice has payments, so it can''t go back to draft' using errcode = '22023';
  end if;
  if new.status = 'written_off' and old.status <> 'written_off' then
    if old.status not in ('sent', 'partially_paid', 'overdue') then
      raise exception 'Only an invoice that was sent and isn''t paid can be written off' using errcode = '22023';
    end if;
    if new.balance_due <= 0 then
      raise exception 'Nothing is owed on this invoice, so there''s nothing to write off' using errcode = '22023';
    end if;
  end if;
  if old.status = 'written_off' and new.status = 'draft' then
    raise exception 'Undo the write-off before moving this invoice back to draft' using errcode = '22023';
  end if;
  return new;
end $$;

-- Activity (20261017000100_activity_notifications_search.sql): a write-off is noted. Undoing one
-- isn't "just became past due", so it doesn't set off past-due reminders straight away.
create or replace function private.activity_invoices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_data jsonb := jsonb_build_object('number', new.number, 'total', new.total, 'balance_due', new.balance_due);
begin
  if (tg_op = 'INSERT' and new.status <> 'draft') or (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    case new.status
      when 'sent' then
        if tg_op = 'INSERT' or old.status = 'draft' then
          perform private.emit(new.company_id, 'invoice.sent', 'invoice', new.id, format('Invoice #%s sent to %s (%s)', new.number, v_client, private.money(new.total)), v_data);
        end if;
      when 'paid' then
        perform private.emit(new.company_id, 'invoice.paid', 'invoice', new.id, format('Invoice #%s paid by %s (%s)', new.number, v_client, private.money(new.total)), v_data);
      when 'overdue' then
        if tg_op = 'INSERT' or old.status <> 'written_off' then
          perform private.emit(new.company_id, 'invoice.overdue', 'invoice', new.id, format('Invoice #%s for %s is past due (%s owing)', new.number, v_client, private.money(new.balance_due)), v_data);
        end if;
      when 'written_off' then
        perform private.emit(new.company_id, 'invoice.written_off', 'invoice', new.id, format('Invoice #%s for %s written off (%s)', new.number, v_client, private.money(new.balance_due)), v_data);
      else null;
    end case;
  end if;
  return null;
end $$;

-- Reminders already waiting to go out for an invoice that's written off (a rule that follows up a
-- few days after it's sent or past due) are called off.
create function private.invoice_written_off() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'written_off' and old.status <> 'written_off' then
    update public.automation_runs r set status = 'cancelled', finished_at = now(), error = 'The invoice was written off'
    from public.automation_rules ru
    where ru.id = r.rule_id and r.company_id = new.company_id and r.subject_type = 'invoice' and r.subject_id = new.id
      and r.status = 'pending' and ru.trigger in ('invoice.sent', 'invoice.overdue');
  end if;
  return null;
end $$;
create trigger written_off after update on public.invoices
  for each row execute function private.invoice_written_off();

-- Written off in Stripe ("uncollectible", 20261019001010_stripe_office.sql): written off here too,
-- partly paid or not, once, when Stripe marks it so. (Before, it was voided unless money had come
-- in.) Paid after all, the payment goes on the invoice like any other.
create or replace function public.stripe_import_invoice(p_company uuid, p_data jsonb, p_quiet boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_link public.stripe_invoices;
  v_customer jsonb := coalesce(p_data -> 'customer', '{}');
  v_address jsonb := private.stripe_billing_address(p_data -> 'customer' -> 'address');
  v_email text := nullif(trim(p_data -> 'customer' ->> 'email'), '');
  v_name text := nullif(trim(p_data -> 'customer' ->> 'name'), '');
  v_status text := p_data ->> 'status';
  v_pay jsonb := nullif(p_data -> 'payment', 'null'::jsonb);
  v_client uuid;
  v_invoice uuid;
  v_line jsonb;
  v_sort integer := 0;
  v_ref text;
  v_void boolean;
  v_number bigint;
  v_credited numeric;
  v_was text;
begin
  if v_status not in ('open', 'paid', 'void', 'uncollectible') then
    raise exception 'Unknown Stripe invoice status %', v_status using errcode = '22023';
  end if;
  if p_quiet then
    perform set_config('crewtavo.quiet', 'on', true);
  end if;

  select * into v_link from public.stripe_invoices where stripe_id = p_data ->> 'stripe_id' for update;
  if found and v_link.company_id <> p_company then
    raise exception 'That Stripe invoice belongs to another company' using errcode = '22023';
  end if;
  v_invoice := v_link.invoice_id;
  -- What Stripe said last time (none for one new here).
  v_was := case when v_invoice is not null then v_link.status end;

  if v_invoice is null then
    -- The client: already linked to this Stripe customer, the same email, or the only client
    -- with that name (when one side has no email). Otherwise a new client.
    select l.local_id into v_client from public.sync_links l
    join public.clients c on c.id = l.local_id
    where l.company_id = p_company and l.provider = 'stripe' and l.entity = 'client' and l.external_id = v_customer ->> 'id'
    limit 1;
    if v_client is null and v_email is not null then
      select id into v_client from public.clients
      where company_id = p_company and lower(email) = lower(v_email)
      order by status = 'archived', created_at limit 1;
    end if;
    if v_client is null and v_name is not null then
      select (array_agg(id))[1] into v_client from public.clients
      where company_id = p_company and lower(trim(display_name)) = lower(v_name) and (email is null or v_email is null)
      having count(*) = 1;
    end if;
    if v_client is null then
      insert into public.clients (company_id, status, display_name, email, phone, billing_address, lead_source)
      values (p_company, 'active', left(coalesce(v_name, v_email, 'Stripe customer'), 200), v_email,
              nullif(trim(v_customer ->> 'phone'), ''), v_address, 'Stripe')
      returning id into v_client;
      if nullif(trim(v_address ->> 'line1'), '') is not null then
        insert into public.properties (company_id, client_id, line1, line2, city, region, postal_code, country)
        values (p_company, v_client, trim(v_address ->> 'line1'), nullif(v_address ->> 'line2', ''), nullif(v_address ->> 'city', ''),
                nullif(v_address ->> 'region', ''), nullif(v_address ->> 'postal_code', ''), coalesce(nullif(v_address ->> 'country', ''), 'US'));
      end if;
    end if;
    if v_customer ->> 'id' is not null then
      insert into public.sync_links (company_id, provider, entity, local_id, external_id)
      values (p_company, 'stripe', 'client', v_client, v_customer ->> 'id')
      on conflict (company_id, provider, entity, local_id) do nothing;
    end if;

    insert into public.invoices (company_id, client_id, subject, issued_on, due_on)
    values (p_company, v_client, left(p_data ->> 'subject', 200), coalesce((p_data ->> 'issued_on')::date, current_date), (p_data ->> 'due_on')::date)
    returning id into v_invoice;
    for v_line in select * from jsonb_array_elements(coalesce(p_data -> 'lines', '[]')) loop
      insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
      values (p_company, v_invoice, left(coalesce(nullif(v_line ->> 'name', ''), 'Item'), 300),
              (v_line ->> 'quantity')::numeric, 'ea', (v_line ->> 'unit_price')::numeric, false, v_sort);
      v_sort := v_sort + 1;
    end loop;
    update public.invoices set status = 'sent', sent_at = coalesce((p_data ->> 'sent_at')::timestamptz, now()) where id = v_invoice;

    if v_link.id is null then
      insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, number, hosted_url, livemode)
      values (p_company, v_invoice, p_data ->> 'stripe_id', 'stripe', 'open', (p_data ->> 'amount_due')::numeric,
              p_data ->> 'number', p_data ->> 'hosted_url', coalesce((p_data ->> 'livemode')::boolean, true))
      returning * into v_link;
    else
      update public.stripe_invoices set invoice_id = v_invoice where id = v_link.id;
    end if;
  else
    select client_id into v_client from public.invoices where id = v_invoice;
  end if;

  -- The payment (paid in Stripe, or marked paid there for money received some other way).
  if v_status = 'paid' and v_pay is not null then
    -- Voided and then paid after all (a bank payment already on its way): a void invoice stays
    -- void, so the money is the client's, recorded without an invoice, with a note saying which
    -- one it was for.
    select status = 'void', number into v_void, v_number from public.invoices where id = v_invoice;
    if coalesce((v_pay ->> 'amount')::numeric, 0) > 0 then
      v_ref := coalesce(v_pay ->> 'processor_ref', (p_data ->> 'stripe_id') || ':paid');
      insert into public.payments (company_id, invoice_id, client_id, amount, method, received_at, processor, processor_ref, fee_amount, notes, recorded_by)
      values (p_company, case when v_void then null else v_invoice end, v_client, (v_pay ->> 'amount')::numeric, coalesce(v_pay ->> 'method', 'card'),
              coalesce((v_pay ->> 'received_at')::timestamptz, now()),
              case when (v_pay ->> 'out_of_band')::boolean then null else 'stripe' end, v_ref,
              coalesce((v_pay ->> 'fee')::numeric, 0),
              concat_ws('. ', case when (v_pay ->> 'out_of_band')::boolean then 'Marked paid in Stripe' end,
                              case when v_void then format('For invoice #%s, which is void', v_number) end), null)
      on conflict (processor_ref) do nothing;
      -- Refunds use the same reference scheme as the charge.refunded webhook, so neither repeats the other.
      if coalesce((v_pay ->> 'refunded')::numeric, 0) > 0 and not exists (select 1 from public.payments where processor_ref like v_ref || ':refund:%') then
        insert into public.payments (company_id, invoice_id, client_id, amount, method, received_at, processor, processor_ref, notes, recorded_by)
        values (p_company, case when v_void then null else v_invoice end, v_client, -(v_pay ->> 'refunded')::numeric, coalesce(v_pay ->> 'method', 'card'),
                coalesce((v_pay ->> 'received_at')::timestamptz, now()), 'stripe',
                v_ref || ':refund:' || round((v_pay ->> 'refunded')::numeric * 100)::bigint, 'Refunded in Stripe', null)
        on conflict (processor_ref) do nothing;
      end if;
    end if;
    -- A credit note issued in Stripe before it was paid (a credit note for all of it has Stripe
    -- mark it paid with nothing charged), as far as the invoice here still asks for it. A void
    -- invoice isn't owed, so there's nothing to take it off.
    if coalesce((v_pay ->> 'credited')::numeric, 0) > 0 and not v_void then
      select least((v_pay ->> 'credited')::numeric, balance_due) into v_credited from public.invoices where id = v_invoice;
      if v_credited > 0 then
        insert into public.payments (company_id, invoice_id, client_id, amount, method, received_at, processor, processor_ref, notes, recorded_by)
        values (p_company, v_invoice, v_client, v_credited, 'other', coalesce((v_pay ->> 'received_at')::timestamptz, now()), null,
                (p_data ->> 'stripe_id') || ':credit_note', 'Credit note in Stripe', null)
        on conflict (processor_ref) do nothing;
      end if;
    end if;
  end if;

  -- Voided in Stripe: no longer owed here either (unless money came in).
  if v_status = 'void' then
    update public.invoices set status = 'void'
    where id = v_invoice and status <> 'void' and coalesce((select sum(amount) from public.payments where invoice_id = v_invoice), 0) = 0;
  end if;
  -- Written off in Stripe: written off here, when it was. Only when Stripe marks it so, so a
  -- write-off undone here stays undone when Stripe tells Crewtavo about the invoice again.
  if v_status = 'uncollectible' and v_was is distinct from 'uncollectible' then
    update public.invoices
    set status = 'written_off', written_off_at = coalesce((p_data ->> 'written_off_at')::timestamptz, now())
    where id = v_invoice and status in ('sent', 'partially_paid', 'overdue') and balance_due > 0;
  end if;

  update public.stripe_invoices
  set status = case when status = 'processing' and v_status = 'open' then 'processing' else v_status end,
      hosted_url = coalesce(p_data ->> 'hosted_url', hosted_url),
      number = coalesce(p_data ->> 'number', number)
  where id = v_link.id;
  return v_invoice;
end $$;

revoke execute on function public.stripe_import_invoice(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.stripe_import_invoice(uuid, jsonb, boolean) to service_role;

notify pgrst, 'reload schema';
