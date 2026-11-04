-- Deposits as a percent of the total, and paid as the client approves in the Client Hub.
--   quotes.deposit_percent      The percent of the total asked for (0 to 100), or null for an amount.
--                               With one, deposit_amount follows the total as lines, options and the
--                               client's choices change, so what reads the amount (the Client Hub,
--                               the contract's {Deposit}, the job's deposit invoice and the last
--                               invoice that takes it off) works as it did.
--   quotes.deposit_invoice_id   The invoice for the deposit the client was asked to pay as they
--                               approved (hub_deposit_invoice). It joins the job made from the quote.
-- The approval never waits for the payment: it's kept, signed, with the deposit owed on that
-- invoice, which they pay from the Client Hub then or later, as any invoice.

alter table public.quotes
  add column deposit_percent numeric(5, 2) constraint quotes_deposit_percent_check check (deposit_percent between 0 and 100),
  add column deposit_invoice_id uuid,
  add constraint quotes_deposit_invoice_fkey foreign key (company_id, deposit_invoice_id)
    references public.invoices (company_id, id) on delete set null (deposit_invoice_id);

comment on column public.quotes.deposit_percent is 'The deposit as a percent of the total; null when it''s an amount. deposit_amount always has the amount.';
comment on column public.quotes.deposit_invoice_id is 'The deposit invoice made as the client approved in the Client Hub (hub_deposit_invoice).';

-- The amount from the percent, on the total quote_totals just worked out: a row's triggers run in
-- the order of their names, and this one's comes after it.
create function private.quote_deposit_percent() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.deposit_percent is not null then
    new.deposit_amount := round(new.total * new.deposit_percent / 100, 2);
  end if;
  return new;
end $$;
create trigger set_deposit before insert or update on public.quotes
  for each row execute function private.quote_deposit_percent();

-- As in 20261104000400_quote_templates.sql, and the copy asks for its deposit the same way.
create or replace function public.duplicate_quote(p_quote uuid, p_template_name text default null, p_client uuid default null,
  p_property uuid default null, p_title text default null, p_custom_fields jsonb default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes;
  o public.quote_options;
  v_template boolean;
  v_new uuid;
  v_id uuid;
  v_map jsonb := '{}';
begin
  select * into q from public.quotes where id = p_quote;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if p_template_name is not null and p_client is not null then
    raise exception 'A quote template has no client.' using errcode = '22023';
  end if;
  if p_template_name is not null and btrim(p_template_name) = '' then
    raise exception 'Give the template a name.' using errcode = '22023';
  end if;
  v_template := p_template_name is not null or (q.is_template and p_client is null);

  insert into public.quotes (company_id, client_id, property_id, is_template, title, message, discount_amount, tax_rate, deposit_amount, deposit_percent,
                             valid_until, roof_package_id, section_ids, recurrence_rule, active_months, starts_on, ends_on, custom_fields)
  select q.company_id,
         case when not v_template then coalesce(p_client, q.client_id) end,
         case when v_template then null when p_client is not null then p_property else q.property_id end,
         v_template,
         left(coalesce(nullif(btrim(p_template_name), ''), nullif(btrim(p_title), ''),
                       case when q.is_template and not v_template then q.title else q.title || ' (copy)' end), 200),
         q.message, q.discount_amount, q.tax_rate, q.deposit_amount, q.deposit_percent,
         case when v_template then null
              when q.is_template then (now() at time zone coalesce(c.timezone, 'UTC'))::date
                                      + coalesce((c.settings ->> 'quote_valid_days')::numeric::integer, 30)
              when q.valid_until > (now() at time zone coalesce(c.timezone, 'UTC'))::date then q.valid_until end,
         q.roof_package_id, q.section_ids, q.recurrence_rule, q.active_months, q.starts_on, q.ends_on,
         case when p_client is not null and p_custom_fields is not null then p_custom_fields
              when v_template or q.is_template then q.custom_fields else '{}' end
    from public.companies c where c.id = q.company_id
  returning id into v_new;

  for o in select * from public.quote_options where quote_id = p_quote order by sort, id loop
    insert into public.quote_options (company_id, quote_id, package_id, name, tier, picture, picture_width, picture_height,
                                      style, highlights, warranty, section_ids, sort)
    values (o.company_id, v_new, o.package_id, o.name, o.tier, o.picture, o.picture_width, o.picture_height,
            o.style, o.highlights, o.warranty, o.section_ids, o.sort)
    returning id into v_id;
    v_map := v_map || jsonb_build_object(o.id::text, v_id);
  end loop;
  if q.option_id is not null then
    update public.quotes set option_id = (v_map ->> q.option_id::text)::uuid
     where id = v_new and option_id is distinct from (v_map ->> q.option_id::text)::uuid;
  end if;

  insert into public.quote_line_items (company_id, quote_id, option_id, service_id, name, description, quantity, unit, unit_price,
                                       unit_cost, taxable, optional, selected, option_group, formula, sort, materials, material_cost)
  select l.company_id, v_new, (v_map ->> l.option_id::text)::uuid, l.service_id, l.name, l.description, l.quantity, l.unit, l.unit_price,
         l.unit_cost, l.taxable, l.optional, not l.optional, l.option_group, l.formula, l.sort, l.materials, l.material_cost
    from public.quote_line_items l where l.quote_id = p_quote
   order by l.sort;
  return v_new;
end $$;


-- ---------------------------------------------------------------------------------------------
-- Paid as the client approves
-- ---------------------------------------------------------------------------------------------

-- The deposit the client pays as they approve in the Client Hub (POST /hub/:token/approve, when the
-- business takes payments online): an invoice for it, sent and due today, which Stripe's page pays
-- as it pays any invoice. Made once: asked again (the client back to pay later), it's the same
-- invoice, whatever became of it. Its job is the quote's when there is one (a change order's, or
-- one made from it already), else the job made from it later (deposit_joins_job), so the job's last
-- invoice takes it off as it takes off any deposit. Null when nothing is owed: no deposit, or the
-- quote isn't approved.
create function public.hub_deposit_invoice(p_company uuid, p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes;
  v_today date;
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
  select (now() at time zone coalesce(timezone, 'UTC'))::date into v_today from public.companies where id = p_company;
  insert into public.invoices (company_id, client_id, job_id, kind, subject, issued_on, due_on, tax_rate)
  values (p_company, q.client_id,
          coalesce(q.change_order_for, (select j.id from public.jobs j where j.company_id = p_company and j.quote_id = q.id order by j.created_at limit 1)),
          'deposit', 'Deposit: ' || q.title, v_today, v_today, 0)
  returning id into v_invoice;
  insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
  values (p_company, v_invoice, 'Deposit for ' || q.title, 1, 'ea', least(q.deposit_amount, q.total), false, 0);
  -- Sent once its line is on, so it goes out (and to Stripe) for what it asks.
  update public.invoices set status = 'sent' where id = v_invoice;
  update public.quotes set deposit_invoice_id = v_invoice where id = q.id;
  return v_invoice;
end $$;
revoke execute on function public.hub_deposit_invoice(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hub_deposit_invoice(uuid, uuid) to service_role;

-- The deposit paid as the client approved goes on the job made from the quote, so the job's last
-- invoice takes it off ("Less deposit").
create function private.deposit_joins_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.invoices i set job_id = new.id
    from public.quotes q
   where q.id = new.quote_id and q.company_id = new.company_id and i.id = q.deposit_invoice_id and i.job_id is null;
  return null;
end $$;
create trigger deposit_joins_job after insert or update of quote_id on public.jobs
  for each row when (new.quote_id is not null) execute function private.deposit_joins_job();
revoke all on function private.quote_deposit_percent(), private.deposit_joins_job() from public;
