-- An "Add to every job" line the office takes off a quote template stays off the quotes made from
-- it. The template remembers the items taken off it (quotes.every_job_items_left_off), its copies
-- (New from template, and a copy of the template) carry that, and add_every_job_items leaves those
-- off a copy's first lines. A template that never had the line still gives its quotes the item, and
-- quotes that aren't templates work as before: a line taken off one stays off that quote only.

alter table public.quotes add column every_job_items_left_off uuid[] not null default '{}';
comment on column public.quotes.every_job_items_left_off is 'The "Add to every job" items taken off this quote template, left off the quotes made from it.';

-- Taken off a template: remembered. Not the lines of a template being deleted.
create function private.every_job_item_left_off() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.quotes q set every_job_items_left_off = q.every_job_items_left_off || old.service_id
   where q.id = old.quote_id and q.is_template and old.service_id <> all (q.every_job_items_left_off)
     and exists (select 1 from public.services s where s.id = old.service_id and s.company_id = q.company_id and s.add_to_every_job);
  return null;
end $$;
create trigger every_job_item_left_off after delete on public.quote_line_items
  for each row when (old.service_id is not null) execute function private.every_job_item_left_off();
revoke all on function private.every_job_item_left_off() from public;

-- As in 20261104000100_trip_fee_minimum.sql, leaving off what the quote's template had taken off.
create or replace function private.add_every_job_items(p_quote uuid, p_job uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.quote_line_items (company_id, quote_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort)
  select q.company_id, q.id, s.id, s.name, s.description, 1, s.unit, s.unit_price, s.unit_cost, s.taxable,
         coalesce((select max(l.sort) from public.quote_line_items l where l.quote_id = q.id), 0) + row_number() over (order by s.sort, s.name)
    from public.quotes q
    join public.services s on s.company_id = q.company_id and s.active and s.add_to_every_job
   where q.id = p_quote and s.id <> all (q.every_job_items_left_off)
     and not exists (select 1 from public.quote_line_items l where l.quote_id = q.id and l.service_id = s.id);
  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort)
  select j.company_id, j.id, s.id, s.name, s.description, 1, s.unit, s.unit_price, s.unit_cost, s.taxable,
         coalesce((select max(l.sort) from public.job_line_items l where l.job_id = j.id), 0) + row_number() over (order by s.sort, s.name)
    from public.jobs j
    join public.services s on s.company_id = j.company_id and s.active and s.add_to_every_job
   where j.id = p_job
     and not exists (select 1 from public.job_line_items l where l.job_id = j.id and l.service_id = s.id);
$$;

-- As in 20261104000500_deposit_percent.sql, and a copy of a template keeps what was taken off it.
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
                             valid_until, roof_package_id, section_ids, recurrence_rule, active_months, starts_on, ends_on, custom_fields,
                             every_job_items_left_off)
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
              when v_template or q.is_template then q.custom_fields else '{}' end,
         case when q.is_template then q.every_job_items_left_off else '{}' end
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

notify pgrst, 'reload schema';
