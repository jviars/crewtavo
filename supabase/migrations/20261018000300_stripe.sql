-- Stripe as the place money moves:
--   * a Crewtavo invoice becomes a Stripe invoice when it's sent (or when the client goes to pay),
--     so the client pays it once, in Stripe, and it shows in the Stripe dashboard;
--   * invoices made in Stripe come into Crewtavo, with their customer and payment;
--   * each Stripe payment records the fee Stripe kept and the bank deposit (payout) it arrived in.
-- Stripe objects are written by the API with the service key; people read them.

-- ---------------------------------------------------------------------------------------------
-- Deposits (payouts) and fees
-- ---------------------------------------------------------------------------------------------

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  processor text not null default 'stripe',
  processor_ref text not null unique,   -- po_...
  amount numeric(12, 2) not null,       -- what reached the bank
  gross_amount numeric(12, 2),          -- payments in it before fees (null until itemized)
  fee_amount numeric(12, 2),            -- fees Stripe kept (null until itemized)
  currency text not null default 'usd',
  status text not null check (status in ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
  arrival_on date not null,
  failure_message text,
  itemized_at timestamptz,              -- when its transactions were matched to payments
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index payouts_company_arrival_idx on public.payouts (company_id, arrival_on desc);
select private.add_touch_triggers(array['payouts']);
alter table public.payouts enable row level security;
create policy payouts_read on public.payouts for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('payouts', 'invoices', true);

-- Fees are what Stripe kept from the payment; the payment amount stays what the client paid.
alter table public.payments add column fee_amount numeric(12, 2) not null default 0;
alter table public.payments add column payout_id uuid;
alter table public.payments add constraint payments_payout_fkey foreign key (company_id, payout_id)
  references public.payouts (company_id, id) on delete set null (payout_id);
create index payments_payout_idx on public.payments (payout_id) where payout_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Stripe invoices
-- ---------------------------------------------------------------------------------------------

-- A Crewtavo invoice can have several over time: when its balance changes (a check, a promo
-- code, a tip), the open one is voided and a new one takes its place. At most one is live.
create table public.stripe_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  invoice_id uuid,
  stripe_id text unique,         -- in_...; null while it's being created
  origin text not null check (origin in ('crewtavo', 'stripe')),
  status text not null default 'creating'
    check (status in ('creating', 'open', 'processing', 'paid', 'void', 'uncollectible')),
  amount_due numeric(12, 2) not null default 0,   -- what was billed in Stripe, tip included
  tip_amount numeric(12, 2) not null default 0,
  number text,                   -- Stripe's invoice number
  hosted_url text,               -- the page where the client pays
  livemode boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete set null (invoice_id)
);
create unique index stripe_invoices_live_idx on public.stripe_invoices (invoice_id)
  where status in ('creating', 'open', 'processing');
create index stripe_invoices_invoice_idx on public.stripe_invoices (company_id, invoice_id);
select private.add_touch_triggers(array['stripe_invoices']);
alter table public.stripe_invoices enable row level security;
create policy stripe_invoices_read on public.stripe_invoices for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('stripe_invoices', 'invoices', true);

-- Invoices made in Stripe are paid as Stripe billed them: no promo codes or discounts here, and no
-- going back to draft to change them.
create function private.stripe_invoice_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.discount_amount is distinct from old.discount_amount or new.promo_code_id is distinct from old.promo_code_id
      or (new.status = 'draft' and old.status <> 'draft'))
     and exists (select 1 from public.stripe_invoices where invoice_id = new.id and origin = 'stripe') then
    raise exception 'This invoice was made in Stripe. Make changes there' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger stripe_guard before update on public.invoices
  for each row execute function private.stripe_invoice_guard();

-- Stripe customers are found by their ID when invoices come in.
create index sync_links_external_idx on public.sync_links (company_id, provider, entity, external_id);

-- ---------------------------------------------------------------------------------------------
-- Quiet imports: history brought in from Stripe isn't news. No activity (so no automations,
-- reminders or notifications) and no accounting or Stripe sync while crewtavo.quiet is on.
-- ---------------------------------------------------------------------------------------------

create or replace function private.emit(p_company uuid, p_verb text, p_type text, p_id uuid, p_summary text, p_data jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.activity (company_id, actor_id, verb, subject_type, subject_id, summary, data)
  select p_company, (select auth.uid()), p_verb, p_type, p_id, left(p_summary, 500), coalesce(p_data, '{}')
  where coalesce(current_setting('crewtavo.quiet', true), '') <> 'on';
$$;

create or replace function private.enqueue_accounting() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' or not exists (
    select 1 from public.integrations
    where company_id = new.company_id and provider in ('quickbooks', 'zoho_books') and status = 'connected'
  ) then
    return null;
  end if;

  if tg_table_name = 'invoices' then
    if new.status not in ('draft', 'void') and (tg_op = 'INSERT' or old.status = 'draft') then
      insert into public.outbox (company_id, topic, payload)
      values (new.company_id, 'accounting.invoice', jsonb_build_object('invoice_id', new.id));
    end if;
  elsif tg_table_name = 'payments' then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'accounting.payment', jsonb_build_object('payment_id', new.id));
  end if;
  return null;
end $$;

-- Keep the Stripe invoice in step when an invoice is sent, paid some other way, voided, moved
-- back to draft or its balance changes. One waiting sync per invoice is enough: it reads the
-- invoice as it is when it runs.
create function private.enqueue_stripe() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' then
    return null;
  end if;
  -- Drafts being edited, and void invoices, have nothing in Stripe to keep in step.
  if new.status in ('draft', 'void') and (tg_op = 'INSERT' or old.status = new.status) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.balance_due is not distinct from old.balance_due then
    return null;
  end if;
  if not exists (select 1 from public.integrations where company_id = new.company_id and provider = 'stripe' and status = 'connected')
     and not exists (select 1 from public.stripe_invoices where invoice_id = new.id) then
    return null;
  end if;
  if exists (
    select 1 from public.outbox
    where topic = 'stripe.invoice' and payload ->> 'invoice_id' = new.id::text
      and done_at is null and dead_at is null and locked_until is null
  ) then
    return null;
  end if;
  insert into public.outbox (company_id, topic, payload)
  values (new.company_id, 'stripe.invoice', jsonb_build_object('invoice_id', new.id));
  return null;
end $$;
create trigger enqueue_stripe after insert or update on public.invoices
  for each row execute function private.enqueue_stripe();

-- ---------------------------------------------------------------------------------------------
-- An invoice made in Stripe, brought in (or brought up to date). Service key only.
--
-- p_data: { stripe_id, number, status (open|paid|void|uncollectible), livemode, hosted_url,
--   amount_due, issued_on, due_on, sent_at, subject,
--   customer: { id, name, email, phone, address: { line1, line2, city, state, postal_code, country } },
--   lines: [{ name, quantity, unit_price }],   -- add up to amount_due
--   payment: { amount, method, processor_ref, received_at, fee, out_of_band, refunded } | null }
-- ---------------------------------------------------------------------------------------------

create function public.stripe_import_invoice(p_company uuid, p_data jsonb, p_quiet boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_link public.stripe_invoices;
  v_customer jsonb := coalesce(p_data -> 'customer', '{}');
  v_address jsonb := coalesce(p_data -> 'customer' -> 'address', '{}');
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
                nullif(v_address ->> 'state', ''), nullif(v_address ->> 'postal_code', ''), coalesce(nullif(v_address ->> 'country', ''), 'US'));
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
