-- Money and Stripe invoices (supabase/tests/stripe_money_test.sql covers each):
--   * a draft isn't deleted while Stripe still has its invoice open, or a bank payment on its way;
--   * payments on an invoice made in Stripe are recorded in Stripe, not here;
--   * customers brought in from Stripe get their billing address in the app's shape.
-- (The API side, apps/api/src/integrations/stripe.ts, books disputes and Stripe customer balances.)

-- ---------------------------------------------------------------------------------------------
-- Deleting a draft that Stripe still has
-- ---------------------------------------------------------------------------------------------

-- As before, plus: an invoice moved back to draft keeps its Stripe invoice open for a few minutes,
-- until the Stripe sync voids it. Deleted then, that Stripe invoice stayed open with nothing here
-- following it, so a payment on it never showed up. It waits for the sync now, and one with a bank
-- payment on its way waits for that to settle. (Stripe invoices Crewtavo stopped following, in an
-- account it left, don't hold it up.)
create or replace function private.invoice_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_live text;
begin
  if (select auth.uid()) is null then
    return old;
  end if;
  if old.status <> 'draft' or exists (select 1 from public.payments where invoice_id = old.id) then
    raise exception 'Only a draft invoice without payments can be deleted. Void it instead' using errcode = '22023';
  end if;
  select status into v_live from public.stripe_invoices
  where invoice_id = old.id and status in ('creating', 'open', 'processing') and detached_at is null
  limit 1;
  if v_live = 'processing' then
    raise exception 'A bank payment for this invoice is on its way through Stripe, so it can''t be deleted until that''s settled' using errcode = '22023';
  elsif v_live is not null then
    raise exception 'Stripe still has this invoice open. It''s voided there within a few minutes of going back to draft, and then it can be deleted' using errcode = '22023';
  end if;
  return old;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Payments on an invoice made in Stripe
-- ---------------------------------------------------------------------------------------------

-- Stripe asks the client for what an invoice made there billed, and only Stripe changes that. A
-- check recorded here left it asking for all of it, so the client could pay twice. While Crewtavo
-- follows its Stripe invoice, signed-in people don't add a payment to it (or move one onto it, or
-- raise one on it): it's marked paid in Stripe, and that comes in like Stripe's own payments, with
-- the service key. Refunds of payments already here still go through.
create function private.stripe_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.invoice_id is not null and new.amount > 0
     and (tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id or new.amount > old.amount)
     and exists (
       select 1 from public.stripe_invoices
       where invoice_id = new.invoice_id and origin = 'stripe' and status in ('creating', 'open', 'processing') and detached_at is null
     ) then
    raise exception 'This invoice was made in Stripe, so record payments there: mark it paid in Stripe and it shows up here' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger stripe_guard before insert or update of invoice_id, amount on public.payments
  for each row execute function private.stripe_payment_guard();

-- ---------------------------------------------------------------------------------------------
-- Billing addresses from Stripe
-- ---------------------------------------------------------------------------------------------

-- A Stripe address in the app's shape (ClientForm, the CSV import): Stripe's state is the region,
-- empty parts are left out, and anything that isn't an address (Stripe sends null when a customer
-- has none) is none. One already in the app's shape comes out the same.
create function private.stripe_billing_address(p_address jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_address) = 'object' then jsonb_strip_nulls(jsonb_build_object(
    'line1', nullif(p_address ->> 'line1', ''),
    'line2', nullif(p_address ->> 'line2', ''),
    'city', nullif(p_address ->> 'city', ''),
    'region', coalesce(nullif(p_address ->> 'region', ''), nullif(p_address ->> 'state', '')),
    'postal_code', nullif(p_address ->> 'postal_code', ''),
    'country', nullif(p_address ->> 'country', '')
  )) else '{}'::jsonb end
$$;
revoke execute on function private.stripe_billing_address(jsonb) from public;

-- Clients the import brought in before this have Stripe's shape (or a JSON null): their state
-- becomes the region, and whatever else is on the address stays.
update public.clients
set billing_address = case when jsonb_typeof(billing_address) = 'object'
  then (billing_address - 'state') || jsonb_strip_nulls(jsonb_build_object('region',
         coalesce(nullif(billing_address ->> 'region', ''), nullif(billing_address ->> 'state', ''))))
  else '{}'::jsonb end
where lead_source = 'Stripe' and (jsonb_typeof(billing_address) <> 'object' or billing_address ? 'state');

-- As in 20261018000300_stripe.sql, with the customer's address in the app's shape.
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
  if v_status = 'paid' and v_pay is not null and coalesce((v_pay ->> 'amount')::numeric, 0) > 0 then
    v_ref := coalesce(v_pay ->> 'processor_ref', (p_data ->> 'stripe_id') || ':paid');
    -- Written off and then paid after all: a void invoice stays void, so the money is the client's,
    -- recorded without an invoice, with a note saying which one it was for.
    select status = 'void', number into v_void, v_number from public.invoices where id = v_invoice;
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
