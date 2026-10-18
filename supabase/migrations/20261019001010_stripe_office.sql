-- Stripe and the office's payments (supabase/tests/stripe_office_test.sql covers each):
--   * a payment can be only a tip, as Stripe charges when a client's credit there pays the invoice
--     and they add a tip in the Client Hub, and the refund of one gives back only the tip;
--   * a Stripe invoice keeps when the bank payment on its way started, for the office;
--   * a payment refused on an invoice made in Stripe says how to record it there, and a credit
--     note issued there for part of it counts here once the invoice is paid.
-- (The API side, apps/api/src/integrations/stripe.ts, books the tip and notes when bank payments start.)

-- ---------------------------------------------------------------------------------------------
-- Payments that are only a tip
-- ---------------------------------------------------------------------------------------------

-- When a client's credit in Stripe pays all of an invoice and they add a tip in the Client Hub,
-- Stripe charges only the tip. A payment couldn't be nothing, so that charge wasn't recorded: not
-- the tip, its fee, the deposit it arrived in, or a refund of it. Now a payment can be only a tip
-- (no amount, a tip), and the refund of one gives back only the tip (no amount, a negative tip).
-- Neither changes what's owed. A payment with an amount still has a tip the same way round.
alter table public.payments
  drop constraint payments_amount_check,
  add constraint payments_amount_check check (amount <> 0 or tip_amount <> 0),
  drop constraint payments_tip_amount_check,
  add constraint payments_tip_amount_check check (tip_amount = 0 or amount = 0 or sign(tip_amount) = sign(amount));

-- ---------------------------------------------------------------------------------------------
-- When a bank payment started
-- ---------------------------------------------------------------------------------------------

-- While a bank payment is on its way, the office's invoice page says so next to Record payment,
-- with the day it started, so nobody records the same money again meanwhile. Only the people who
-- see invoices read it (stripe_invoices_read, and the invoices area). The API sets it when Stripe
-- says the payment started; ones already on their way started when they last changed, as near as
-- is known.
alter table public.stripe_invoices add column processing_at timestamptz;
update public.stripe_invoices set processing_at = updated_at where status = 'processing';

-- ---------------------------------------------------------------------------------------------
-- Payments on an invoice made in Stripe
-- ---------------------------------------------------------------------------------------------

-- As in 20261018000910_stripe_money_fixes.sql, saying how to record it in Stripe instead: in full
-- by marking it paid there, in part with a credit note there (which stripe_import_invoice below
-- counts once the invoice is paid). The office's invoice page says the same before anyone tries.
create or replace function private.stripe_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.invoice_id is not null and new.amount > 0
     and (tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id or new.amount > old.amount)
     and exists (
       select 1 from public.stripe_invoices
       where invoice_id = new.invoice_id and origin = 'stripe' and status in ('creating', 'open', 'processing') and detached_at is null
     ) then
    raise exception 'This invoice was made in Stripe, so record its payments there. If the client paid all of it, mark it paid in Stripe. If they paid part, issue a credit note in Stripe for what they paid, so Stripe asks for only the rest. Either way it shows up here once the invoice is paid there' using errcode = '22023';
  end if;
  return new;
end $$;

-- As in 20261018000910_stripe_money_fixes.sql, plus: a credit note issued in Stripe before the
-- invoice was paid took that much off what Stripe asked for (it's how the office records part of a
-- payment there, see stripe_payment_guard). Paid, the invoice here only had Stripe's payment, so it
-- still asked for the credit note's amount. That counts as paid now (payment.credited in p_data),
-- as far as the invoice here still asks for it: one brought in after the credit note was issued has
-- it among its lines already.
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
    -- Written off and then paid after all: a void invoice stays void, so the money is the client's,
    -- recorded without an invoice, with a note saying which one it was for.
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

  -- Voided or written off in Stripe: no longer owed here either (unless money came in).
  if v_status in ('void', 'uncollectible') then
    update public.invoices set status = 'void'
    where id = v_invoice and status <> 'void' and coalesce((select sum(amount) from public.payments where invoice_id = v_invoice), 0) = 0;
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
