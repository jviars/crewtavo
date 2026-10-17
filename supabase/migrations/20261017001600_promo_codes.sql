-- Promo codes: a percent or dollar amount off a quote or an invoice, with optional dates, a
-- minimum order, a limit on total uses, once per client, or new clients only. The office applies
-- them, and clients can enter one on a booking form or in the Client Hub. The discount comes off
-- before tax and follows an approved quote to its job and invoices (see carry_quote_discount).

create table public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{3,24}$'),
  description text check (char_length(description) <= 120), -- shown to clients, e.g. "Spring sealcoating special"
  kind text not null check (kind in ('percent', 'amount')),
  value numeric(12, 2) not null check (value > 0),
  min_subtotal numeric(12, 2) not null default 0 check (min_subtotal >= 0),
  starts_on date,
  ends_on date,
  max_uses integer check (max_uses > 0),
  once_per_client boolean not null default true,
  new_clients_only boolean not null default false,
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, code),
  check (kind <> 'percent' or value <= 100),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
select private.add_touch_triggers(array['promo_codes']);
-- Sales and the office read codes (to apply them); writing them is part of the marketing area.
select private.apply_policies('promo_codes', '{owner,admin,office}', '{owner,admin,office,estimator}');
select private.restrict_area('promo_codes', 'marketing', false);

alter table public.quotes add column promo_code_id uuid;
alter table public.quotes add constraint quotes_promo_fkey foreign key (company_id, promo_code_id)
  references public.promo_codes (company_id, id) on delete set null (promo_code_id);
alter table public.invoices add column promo_code_id uuid;
alter table public.invoices add constraint invoices_promo_fkey foreign key (company_id, promo_code_id)
  references public.promo_codes (company_id, id) on delete set null (promo_code_id);
create index quotes_promo_idx on public.quotes (promo_code_id) where promo_code_id is not null;
create index invoices_promo_idx on public.invoices (promo_code_id) where promo_code_id is not null;
-- A code typed on a booking form waits on the request until it's quoted.
alter table public.requests add column promo_code text check (char_length(promo_code) <= 24);

-- ---------------------------------------------------------------------------------------------
-- The discount a code gives on a base amount (the document's charges, before credits).
-- ---------------------------------------------------------------------------------------------
create function private.promo_discount(p_promo uuid, p_base numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_base <= 0 then 0
              when p.kind = 'percent' then round(p_base * p.value / 100, 2)
              else least(p.value, p_base) end
  from public.promo_codes p where p.id = p_promo
$$;

create or replace function private.quote_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_sub numeric; v_taxable numeric; v_base numeric; v_base_taxable numeric; v_discount numeric;
begin
  select coalesce(sum(round(quantity * unit_price, 2)) filter (where selected), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and taxable), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and unit_price > 0), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and taxable and unit_price > 0), 0)
    into v_sub, v_taxable, v_base, v_base_taxable
  from public.quote_line_items where quote_id = new.id;
  -- A promo code sets the discount (and keeps it right as options are picked).
  if new.promo_code_id is not null then
    new.discount_amount := coalesce(private.promo_discount(new.promo_code_id, v_base), 0);
  end if;
  v_discount := least(new.discount_amount, greatest(v_sub, 0));
  new.subtotal := v_sub;
  new.tax_amount := round(greatest(v_taxable - case when v_base > 0 then v_discount * v_base_taxable / v_base else 0 end, 0) * new.tax_rate, 2);
  new.total := greatest(v_sub - v_discount, 0) + new.tax_amount;
  return new;
end $$;

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

  if new.status not in ('draft', 'void') then
    new.status := case
      when v_lines > 0 and new.balance_due <= 0 then 'paid'
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

-- ---------------------------------------------------------------------------------------------
-- Applying a code. Runs as the caller: the office through RLS, the Client Hub and booking forms
-- through the server (which checks the link first). Messages are written for clients to read.
-- ---------------------------------------------------------------------------------------------

-- Uses: quotes that are still live, and invoices that aren't void (an invoice made from a quote
-- that used the code carries the discount as a line, so it isn't counted twice).
create function private.promo_uses(p_promo uuid, p_client uuid default null, p_except uuid default null) returns integer
language sql stable security definer set search_path = '' as $$
  select (
    (select count(*) from public.quotes q where q.promo_code_id = p_promo and q.status not in ('lost', 'archived')
       and (p_client is null or q.client_id = p_client) and q.id is distinct from p_except)
  + (select count(*) from public.invoices i where i.promo_code_id = p_promo and i.status <> 'void'
       and (p_client is null or i.client_id = p_client) and i.id is distinct from p_except)
  )::integer
$$;

-- Finds a usable code for a client, or raises a message saying why not.
create function private.find_promo(p_company uuid, p_client uuid, p_code text, p_base numeric, p_except uuid default null)
returns public.promo_codes
language plpgsql stable security definer set search_path = '' as $$
declare p public.promo_codes; v_today date;
begin
  -- Signed-in callers only see their own company's codes (the server calls with no user).
  if auth.uid() is not null and not private.is_member(p_company) then
    raise exception 'That code isn''t valid. Check the spelling and try again.' using errcode = '22023';
  end if;
  select * into p from public.promo_codes
  where company_id = p_company and code = upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  if not found or not p.active then
    raise exception 'That code isn''t valid. Check the spelling and try again.' using errcode = '22023';
  end if;
  select (now() at time zone coalesce(timezone, 'UTC'))::date into v_today from public.companies where id = p_company;
  if p.starts_on is not null and v_today < p.starts_on then
    raise exception 'That code starts on %.', to_char(p.starts_on, 'FMMonth FMDD') using errcode = '22023';
  end if;
  if p.ends_on is not null and v_today > p.ends_on then
    raise exception 'That code expired on %.', to_char(p.ends_on, 'FMMonth FMDD') using errcode = '22023';
  end if;
  if p.max_uses is not null and private.promo_uses(p.id, null, p_except) >= p.max_uses then
    raise exception 'That code has already been used up.' using errcode = '22023';
  end if;
  if p_client is not null and p.once_per_client and private.promo_uses(p.id, p_client, p_except) > 0 then
    raise exception 'That code has already been used for this account.' using errcode = '22023';
  end if;
  if p_client is not null and p.new_clients_only and (
    exists (select 1 from public.invoices i where i.client_id = p_client and i.status = 'paid')
    or exists (select 1 from public.jobs j where j.client_id = p_client)
  ) then
    raise exception 'That code is for new customers.' using errcode = '22023';
  end if;
  if p_base is not null and p_base < p.min_subtotal then
    raise exception 'That code needs an order of at least %.', to_char(p.min_subtotal, 'FM$999,999,990.00') using errcode = '22023';
  end if;
  return p;
end $$;

-- p_kind: 'quote' or 'invoice'. Returns the code, its description and the new discount and total.
create function public.apply_promo_code(p_kind text, p_id uuid, p_code text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes; i public.invoices; p public.promo_codes; v_base numeric;
begin
  if p_kind = 'quote' then
    select * into q from public.quotes where id = p_id for update;
    if not found then raise exception 'Quote not found' using errcode = 'P0002'; end if;
    if q.status not in ('draft', 'sent', 'changes_requested') then
      raise exception 'Promo codes can''t be added once a quote is approved.' using errcode = '22023';
    end if;
    select coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and unit_price > 0), 0) into v_base
    from public.quote_line_items where quote_id = q.id;
    p := private.find_promo(q.company_id, q.client_id, p_code, v_base, q.id);
    update public.quotes set promo_code_id = p.id where id = q.id returning * into q;
    return jsonb_build_object('code', p.code, 'description', p.description, 'discount_amount', q.discount_amount, 'total', q.total);
  elsif p_kind = 'invoice' then
    select * into i from public.invoices where id = p_id for update;
    if not found then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
    if i.status not in ('draft', 'sent', 'overdue') or exists (select 1 from public.payments where invoice_id = i.id) then
      raise exception 'Promo codes can only be added before an invoice is paid.' using errcode = '22023';
    end if;
    select coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0) into v_base
    from public.invoice_line_items where invoice_id = i.id;
    p := private.find_promo(i.company_id, i.client_id, p_code, v_base, i.id);
    update public.invoices set promo_code_id = p.id where id = i.id returning * into i;
    return jsonb_build_object('code', p.code, 'description', p.description, 'discount_amount', i.discount_amount, 'total', i.total);
  end if;
  raise exception 'Unknown document type' using errcode = '22023';
end $$;

create function public.remove_promo_code(p_kind text, p_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_kind = 'quote' then
    update public.quotes set promo_code_id = null, discount_amount = 0
    where id = p_id and promo_code_id is not null and status in ('draft', 'sent', 'changes_requested');
  elsif p_kind = 'invoice' then
    update public.invoices set promo_code_id = null, discount_amount = 0
    where id = p_id and promo_code_id is not null and status in ('draft', 'sent', 'overdue')
      and not exists (select 1 from public.payments where invoice_id = p_id);
  end if;
end $$;

-- A booking form checks a code before the client sends it (no client yet, so only the code's
-- own rules apply). Returns what the client sees, e.g. "10% off: Spring sealcoating special".
create function public.check_promo_code(p_company uuid, p_code text) returns text
language plpgsql stable security invoker set search_path = '' as $$
declare p public.promo_codes;
begin
  p := private.find_promo(p_company, null, p_code, null);
  return case when p.kind = 'percent' then trim(trailing '.' from trim(trailing '0' from p.value::text)) || '% off'
              else to_char(p.value, 'FM$999,999,990.00') || ' off' end
         || coalesce(': ' || p.description, '');
end $$;

-- Uses and dollars given per code, for the promo code list.
create function public.promo_code_usage(p_company uuid)
returns table (promo_code_id uuid, uses integer, discounted numeric)
language sql stable security invoker set search_path = '' as $$
  select p.id,
         private.promo_uses(p.id),
         coalesce((select sum(q.discount_amount) from public.quotes q where q.promo_code_id = p.id and q.status in ('approved', 'converted')), 0)
       + coalesce((select sum(i.discount_amount) from public.invoices i where i.promo_code_id = p.id and i.status <> 'void'), 0)
  from public.promo_codes p where p.company_id = p_company
$$;

revoke execute on function public.apply_promo_code(text, uuid, text), public.remove_promo_code(text, uuid),
  public.check_promo_code(uuid, text), public.promo_code_usage(uuid) from public, anon;
grant execute on function public.apply_promo_code(text, uuid, text), public.remove_promo_code(text, uuid),
  public.promo_code_usage(uuid) to authenticated, service_role;
-- Booking forms check codes through the server only.
grant execute on function public.check_promo_code(uuid, text) to service_role;
grant execute on function private.promo_discount(uuid, numeric), private.promo_uses(uuid, uuid, uuid),
  private.find_promo(uuid, uuid, text, numeric, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Quote to job: name the credit line after the code, so the invoice shows it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.convert_quote_to_job(p_quote uuid) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare q public.quotes; v_job uuid; v_label text;
begin
  select * into q from public.quotes where id = p_quote for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if q.status in ('converted', 'lost', 'archived') then
    raise exception 'This quote is already %', q.status using errcode = '22023';
  end if;

  insert into public.jobs (company_id, client_id, property_id, quote_id, title, instructions)
  values (q.company_id, q.client_id, q.property_id, q.id, q.title, q.message)
  returning id into v_job;

  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort)
  select company_id, v_job, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort
  from public.quote_line_items where quote_id = q.id and selected;
  select coalesce('Promo code ' || p.code, 'Discount') into v_label from public.promo_codes p where p.id = q.promo_code_id;
  perform private.carry_quote_discount(q.id, v_job, coalesce(v_label, 'Discount'));

  update public.quotes set status = 'converted', converted_at = now() where id = q.id;
  if q.request_id is not null then
    update public.requests set status = 'converted' where id = q.request_id;
  end if;
  update public.clients set status = 'active' where id = q.client_id and status = 'lead';
  return v_job;
end $$;

notify pgrst, 'reload schema';
