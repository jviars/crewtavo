-- Change orders, materials used on the job, and the price list kept from crews.
--
-- Price list: unit prices and costs were readable by every member through the API (the screens
-- never showed them to crews). Now only owners, admins, office and estimators read it. Crews pick
-- materials by name and unit from public.material_choices(), which has no prices.
--
-- Change orders: a quote that changes an existing job (quotes.change_order_for). It's priced,
-- sent and approved in the Client Hub like any quote; once approved, its lines join the job
-- (job_line_items.source_quote_id) and the job's total goes up. Nothing to convert by hand.
--
-- Materials: what went into the job (tons of asphalt, gallons of sealer, loads of stone) with
-- the plant ticket number and a photo, logged from the field. Job costing values it at the price
-- list's cost for that material.

-- ---------------------------------------------------------------------------------------------
-- Price list
-- ---------------------------------------------------------------------------------------------

drop policy services_read on public.services;
create policy services_read on public.services for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'));

create function public.material_choices(p_company uuid)
returns table (id uuid, name text, unit text, category text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.name, s.unit, s.category from public.services s
  where s.company_id = p_company and s.active and private.is_member(p_company)
  order by s.sort, s.name
$$;
revoke execute on function public.material_choices(uuid) from public, anon;
grant execute on function public.material_choices(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Change orders
-- ---------------------------------------------------------------------------------------------

alter table public.quotes add column change_order_for uuid;
alter table public.quotes add constraint quotes_change_order_fkey foreign key (company_id, change_order_for)
  references public.jobs (company_id, id) on delete set null (change_order_for);
create index quotes_change_order_idx on public.quotes (change_order_for) where change_order_for is not null;

alter table public.job_line_items add column source_quote_id uuid;
alter table public.job_line_items add constraint job_line_items_source_quote_fkey foreign key (company_id, source_quote_id)
  references public.quotes (company_id, id) on delete set null (source_quote_id);

-- Add an approved change order's chosen lines (and its discount) to its job, once.
create function private.apply_change_order(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_sort integer;
begin
  select * into q from public.quotes where id = p_quote for update;
  if not found or q.change_order_for is null or q.status = 'converted' then
    return q.change_order_for;
  end if;
  select coalesce(max(sort), 0) into v_sort from public.job_line_items where job_id = q.change_order_for;
  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort, source_quote_id)
  select company_id, q.change_order_for, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, v_sort + sort + 1, q.id
  from public.quote_line_items where quote_id = q.id and selected;
  perform private.carry_quote_discount(q.id, q.change_order_for, 'Change order discount');
  update public.job_line_items set source_quote_id = q.id
  where job_id = q.change_order_for and source_quote_id is null and name = 'Change order discount';
  -- The job's total (job_financials) follows its line items.
  update public.jobs set updated_at = now() where id = q.change_order_for;
  update public.quotes set status = 'converted', converted_at = now() where id = q.id;
  return q.change_order_for;
end $$;

create function private.change_order_approved() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.change_order_for is not null and new.status = 'approved' and old.status is distinct from 'approved' then
    perform private.apply_change_order(new.id);
  end if;
  return null;
end $$;
create trigger change_order_approved after update of status on public.quotes
  for each row execute function private.change_order_approved();

-- "Convert" on a change order adds it to its job instead of making a new one.
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
  if q.change_order_for is not null then
    return private.apply_change_order(q.id);
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
grant execute on function private.apply_change_order(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Materials used
-- ---------------------------------------------------------------------------------------------

create table public.job_materials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  job_id uuid not null,
  visit_id uuid,
  service_id uuid,
  name text not null check (length(trim(name)) between 1 and 200),
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'ton' check (length(unit) between 1 and 20),
  ticket text check (length(ticket) <= 60),     -- plant ticket or load number
  supplier text check (length(supplier) <= 120),
  photo_path text,                              -- the ticket, in Storage
  notes text check (length(notes) <= 1000),
  logged_by uuid references auth.users (id) on delete set null default auth.uid(),
  logged_at timestamptz not null default now(),
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete cascade,
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete set null (visit_id),
  foreign key (company_id, service_id) references public.services (company_id, id) on delete set null (service_id)
);
create index job_materials_job_idx on public.job_materials (job_id, logged_at);

alter table public.job_materials enable row level security;
create policy job_materials_read on public.job_materials for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.crew_sees_job(job_id))
);
create policy job_materials_insert on public.job_materials for insert to authenticated with check (
  logged_by = (select auth.uid())
  and (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}') or (private.is_member(company_id) and private.crew_sees_job(job_id)))
);
-- Fix your own entry the same day; the office and crew leads fix any.
create policy job_materials_update on public.job_materials for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office,crew_lead}') or (logged_by = (select auth.uid()) and logged_at > now() - interval '1 day'))
  with check (private.is_member(company_id));
create policy job_materials_delete on public.job_materials for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office,crew_lead}') or (logged_by = (select auth.uid()) and logged_at > now() - interval '1 day'));

-- What each job's logged materials cost at price-list cost, for job costing (job costs area).
create function public.job_material_costs(p_job uuid)
returns table (name text, unit text, quantity numeric, unit_cost numeric, cost numeric)
language sql stable security definer set search_path = '' as $$
  select m.name, m.unit, sum(m.quantity), s.unit_cost, round(sum(m.quantity) * coalesce(s.unit_cost, 0), 2)
  from public.job_materials m
  join public.jobs j on j.id = m.job_id
  left join public.services s on s.id = m.service_id
  where m.job_id = p_job
    and private.has_role(j.company_id, '{owner,admin,office}') and private.has_perm(j.company_id, 'job_costs')
  group by m.name, m.unit, s.unit_cost
  order by m.name
$$;
revoke execute on function public.job_material_costs(uuid) from public, anon;
grant execute on function public.job_material_costs(uuid) to authenticated;

notify pgrst, 'reload schema';
