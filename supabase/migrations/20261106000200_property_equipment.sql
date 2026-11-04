-- Equipment at a property: the client's own water heater, AC unit, furnace, pool pump or electrical
-- panel, with what it is, where it is, its warranty and the visits that serviced it. Not the
-- business's own fleet (public.equipment, the Equipment page).
--
--   property_assets   each item at a property: name, make, model, serial number, install and
--                     warranty dates, where it is ("basement"), notes, a photo, active or retired
--   visit_assets      the items a visit worked on, ticked by the crew: an item's service history is
--                     its visits, with their crew and the checklists filled in on them
--
-- Read by whoever sees the property (the office and crew leads, a crew where they have a visit). The
-- office adds, edits, retires and deletes; from the field the team adds an item and changes its notes
-- (property_asset_field_guard). Visits are linked to items by whoever may fill in the visit's
-- checklist. Subs see none of it (is_member is the team's).

create table public.property_assets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  make text check (length(make) <= 80),
  model text check (length(model) <= 80),
  serial text check (length(serial) <= 80),
  installed_on date,
  warranty_until date,
  location text check (length(location) <= 120),
  notes text check (length(notes) <= 4000),
  photo_path text check (length(photo_path) <= 500), -- Storage object key
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, property_id) references public.properties (company_id, id) on delete cascade
);
create index property_assets_property_idx on public.property_assets (property_id, status, name);
select private.add_touch_triggers(array['property_assets']);

create table public.visit_assets (
  company_id uuid not null,
  visit_id uuid not null,
  asset_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (visit_id, asset_id),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade,
  foreign key (company_id, asset_id) references public.property_assets (company_id, id) on delete cascade
);
create index visit_assets_asset_idx on public.visit_assets (asset_id);

comment on table public.property_assets is 'A client''s own equipment at a property (water heater, AC unit, pool pump), not the business''s fleet (equipment).';
comment on table public.visit_assets is 'The property equipment a visit serviced: each item''s service history.';

-- ---------------------------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------------------------

-- Whoever sees the property sees and adds its equipment (as properties_read); the office deletes.
alter table public.property_assets enable row level security;
create policy property_assets_read on public.property_assets for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.crew_sees_property(property_id))
);
create policy property_assets_insert on public.property_assets for insert to authenticated with check (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.crew_sees_property(property_id))
);
create policy property_assets_update on public.property_assets for update to authenticated
  using (
    private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
    or (private.is_member(company_id) and private.crew_sees_property(property_id))
  )
  with check (
    private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
    or (private.is_member(company_id) and private.crew_sees_property(property_id))
  );
create policy property_assets_delete on public.property_assets for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'));

-- Below the office (who edit properties), a change is to the notes only: the rest is what the
-- office keeps on record.
create function private.property_asset_field_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  free constant text[] := array['notes', 'updated_at'];
begin
  if (select auth.uid()) is null or private.has_role(old.company_id, '{owner,admin,office,estimator}') then return new; end if;
  if to_jsonb(new) - free is distinct from to_jsonb(old) - free then
    raise exception 'From the field you can change an item''s notes. Ask the office to change the rest.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger property_asset_field_guard before update on public.property_assets
  for each row execute function private.property_asset_field_guard();
revoke all on function private.property_asset_field_guard() from public;

-- Read and ticked as the visit's checklist answers are (checklist_responses): the office, estimators
-- and crew leads read them; whoever works the visit, schedules its crew, or the office ticks them.
alter table public.visit_assets enable row level security;
create policy visit_assets_read on public.visit_assets for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.works_visit(visit_id))
);
create policy visit_assets_write on public.visit_assets for all to authenticated
  using (
    private.has_role(company_id, '{owner,admin,office}')
    or private.schedules_crew(company_id, private.visit_crew(visit_id))
    or (private.is_member(company_id) and private.works_visit(visit_id))
  )
  with check (
    private.has_role(company_id, '{owner,admin,office}')
    or private.schedules_crew(company_id, private.visit_crew(visit_id))
    or (private.is_member(company_id) and private.works_visit(visit_id))
  );

select private.fold_member_checks('public.property_assets');
select private.fold_member_checks('public.visit_assets');

-- ---------------------------------------------------------------------------------------------
-- AI assistants: a property's equipment is in the clients and properties area
-- ---------------------------------------------------------------------------------------------

-- As in 20261101000500_assistant_templates_and_marketing.sql, with property_assets added. Ticking a
-- visit's equipment (visit_assets) isn't an assistant's.
create or replace function private.assistant_table_area(p_table text) returns text
language sql immutable set search_path = '' as $$
  select case p_table
    when 'clients' then 'clients'
    when 'client_contacts' then 'clients'
    when 'properties' then 'clients'
    when 'property_access' then 'clients'
    when 'property_assets' then 'clients'
    when 'requests' then 'records'
    when 'messages' then 'records'
    when 'jobs' then 'jobs'
    when 'job_line_items' then 'jobs'
    when 'visits' then 'schedule'
    when 'visit_assignees' then 'schedule'
    when 'visit_equipment' then 'schedule'
    when 'routes' then 'schedule'
    when 'time_entries' then 'time'
    when 'quotes' then 'quotes'
    when 'quote_line_items' then 'quotes'
    when 'quote_options' then 'quotes'
    when 'invoices' then 'invoices'
    when 'invoice_line_items' then 'invoices'
    when 'payments' then 'invoices'
    when 'pay_periods' then 'pay'
    when 'pay_period_lines' then 'pay'
    when 'companies' then 'company'
    when 'services' then 'prices'
    when 'crews' then 'crews'
    when 'crew_members' then 'crews'
    when 'checklist_templates' then 'checklists'
    when 'intake_forms' then 'booking'
    when 'sop_pages' then 'guides'
    when 'sop_categories' then 'guides'
    when 'automation_rules' then 'automations'
    when 'memberships' then 'team'
    when 'company_roles' then 'team'
    when 'document_templates' then 'templates'
    when 'contract_sections' then 'templates'
    when 'campaigns' then 'marketing'
    when 'promo_codes' then 'promos'
  end
$$;

notify pgrst, 'reload schema';
