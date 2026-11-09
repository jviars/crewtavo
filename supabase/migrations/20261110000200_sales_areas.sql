-- Sales areas: each lead goes to the salesperson who covers its zip code, by itself.
--
--   sales_areas              The zip codes each salesperson covers (Settings → Sales areas). A zip
--                            can be just its first digits (or a postal code's first letters) for a
--                            wider area; the longest match wins, and the empty zip ('') is
--                            everywhere else. A zip is one person's.
--   requests.assigned_to     A request that comes in with nobody on it, from anywhere (the office, a
--                            booking or website form, the Client Hub, the assistant), goes to its
--                            property's salesperson; also when its property is set later and still
--                            nobody has it.
--   quotes.salesperson_id    A new quote with nobody on it takes its request's person, else the
--                            area's. Not a template, and not one brought in from another app.
--   quotes.measure_on_site_* Roofing: a roof that can't be measured from the air, so the
--                            salesperson measures it on site. Flagged with nobody on it, it goes to
--                            the area's salesperson too.
-- Whoever a request or a quote is handed to hears about it (the bell, and their "Other alerts"),
-- unless they took it themselves.

create table public.sales_areas (
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Kept the way private.postal_key writes it: "46201", "462", "K1A".
  zip text not null check (zip ~ '^[A-Z0-9]{0,10}$'),
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (company_id, zip),
  foreign key (company_id, user_id) references public.memberships (company_id, user_id) on delete cascade
);
create index sales_areas_user_idx on public.sales_areas (company_id, user_id);
comment on table public.sales_areas is 'The zip codes (or their first digits) each salesperson covers. The empty zip is everywhere else.';
select private.apply_policies('sales_areas', '{owner,admin,office}');
select private.fold_member_checks('public.sales_areas');

alter table public.quotes
  add column measure_on_site_at timestamptz,
  add column measure_on_site_reason text check (char_length(measure_on_site_reason) <= 500);
comment on column public.quotes.measure_on_site_at is 'Roofing: when the roof was found not measurable from the air, so the salesperson measures it on site.';
comment on column public.quotes.measure_on_site_reason is 'Why the roof can''t be measured from the air (trees, an old aerial...).';

-- "46201-1234" -> "46201", "k1a 0b6" -> "K1A0B6", nothing -> "". The same as zipKey in the app.
create function private.postal_key(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p ~ '^\s*\d{5}' then substring(p from '\d{5}') else upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) end
$$;

-- Who a lead at this property goes to: the person still on the team whose zip matches the most of
-- its postal code, else everywhere else's. Nobody when nobody covers it.
create function private.area_salesperson(p_company uuid, p_property uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.user_id
  from public.sales_areas a
  join public.memberships m on m.company_id = a.company_id and m.user_id = a.user_id and m.active
  where a.company_id = p_company
    and private.postal_key((select p.postal_code from public.properties p where p.id = p_property and p.company_id = p_company)) like a.zip || '%'
  order by length(a.zip) desc
  limit 1
$$;

create function private.assign_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_to is null and (tg_op = 'INSERT' or new.property_id is distinct from old.property_id) then
    new.assigned_to := private.area_salesperson(new.company_id, new.property_id);
  end if;
  return new;
end $$;
create trigger assign_salesperson before insert or update of property_id on public.requests
  for each row execute function private.assign_request();

create function private.assign_quote() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.salesperson_id := coalesce(
    (select r.assigned_to from public.requests r where r.id = new.request_id and r.company_id = new.company_id),
    private.area_salesperson(new.company_id, new.property_id));
  return new;
end $$;
create trigger assign_salesperson before insert on public.quotes
  for each row when (new.salesperson_id is null and new.client_id is not null and new.source_id is null)
  execute function private.assign_quote();
create trigger assign_measurer before update of measure_on_site_at on public.quotes
  for each row when (new.measure_on_site_at is not null and old.measure_on_site_at is null and new.salesperson_id is null)
  execute function private.assign_quote();

-- One line to the person a lead was handed to, while they're on the team and didn't take it themselves.
create function private.tell_assignee(p_company uuid, p_user uuid, p_kind text, p_title text, p_body text, p_link text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or p_user = (select auth.uid()) then
    return;
  end if;
  if not exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = p_user and m.active) then
    return;
  end if;
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  values (p_company, p_user, p_kind, left(p_title, 300), nullif(p_body, ''), p_link);
end $$;

-- "Sam Lee · 12 Oak St, Carmel"
create function private.lead_where(p_client uuid, p_property uuid) returns text
language sql stable security definer set search_path = '' as $$
  select concat_ws(' · ', (select c.display_name from public.clients c where c.id = p_client),
    (select nullif(concat_ws(', ', p.line1, p.city), '') from public.properties p where p.id = p_property))
$$;

create function private.request_handed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then
    return null;
  end if;
  perform private.tell_assignee(new.company_id, new.assigned_to, 'request',
    format('Request #%s is yours: %s', new.number, new.title), private.lead_where(new.client_id, new.property_id), '/requests/' || new.id);
  return null;
end $$;
create trigger handed after insert or update of assigned_to on public.requests
  for each row execute function private.request_handed();

create function private.quote_handed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- Still to be measured on site (nothing drawn on the map yet), and just flagged so.
  v_on_site boolean := new.measure_on_site_at is not null and not exists (select 1 from public.measurements m where m.quote_id = new.id);
  v_flagged boolean := v_on_site and (tg_op = 'INSERT' or old.measure_on_site_at is null);
begin
  if new.client_id is null or new.source_id is not null then
    return null;
  end if;
  if not v_flagged then
    if tg_op = 'UPDATE' and new.salesperson_id is not distinct from old.salesperson_id then
      return null;
    end if;
    -- Made from a request they already have: they heard about it then.
    if tg_op = 'INSERT' and exists (select 1 from public.requests r where r.id = new.request_id and r.assigned_to = new.salesperson_id) then
      return null;
    end if;
  end if;
  perform private.tell_assignee(new.company_id, new.salesperson_id, 'quote',
    case when v_on_site then format('Measure the roof on site: %s', new.title) else format('Estimate #%s is yours: %s', new.number, new.title) end,
    concat_ws(E'\n', private.lead_where(new.client_id, new.property_id), case when v_on_site then new.measure_on_site_reason end),
    case when v_on_site or new.work_kind = 'roofing' then '/roofing/' else '/quotes/' end || new.id);
  return null;
end $$;
create trigger handed after insert or update of salesperson_id, measure_on_site_at on public.quotes
  for each row execute function private.quote_handed();

-- Only the triggers above use these: they read any company's areas and write notifications.
revoke execute on function private.area_salesperson(uuid, uuid), private.tell_assignee(uuid, uuid, text, text, text, text), private.lead_where(uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
