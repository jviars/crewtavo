-- Custom roles.
--
-- Every member has an access level (memberships.role: owner, admin, office, estimator, crew_lead,
-- field_crew) that decides which records they can reach. A company can also define named roles
-- ("General manager", "Foreman"...) that pick an access level and switch individual areas on or
-- off. A member given a custom role gets its access level automatically, and restrictive
-- policies below enforce its switched-off areas in the database, not just in the app.
-- Members without a custom role keep every area their access level allows.

-- Areas each access level can be given. Mirrors LEVEL_PERMISSIONS in packages/core/src/roles.ts.
create function private.level_permissions(p_level public.member_role) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select case p_level
    when 'owner' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps']
    when 'admin' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps']
    when 'office' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit']
    when 'estimator' then array['sales','schedule']
    when 'crew_lead' then array['schedule']
    else array[]::text[]
  end
$$;

create table public.company_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  description text check (length(description) <= 200),
  base_role public.member_role not null check (base_role <> 'owner'),
  permissions text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (permissions <@ private.level_permissions(base_role))
);
create unique index company_roles_name_idx on public.company_roles (company_id, lower(trim(name)));
select private.add_touch_triggers(array['company_roles']);

alter table public.memberships add column role_id uuid;
alter table public.memberships add constraint memberships_role_fkey foreign key (company_id, role_id)
  references public.company_roles (company_id, id) on delete set null (role_id);
grant select (role_id) on public.memberships to authenticated;

-- A custom role sets the member's access level.
create function private.membership_role_level() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role_id is not null then
    select base_role into new.role from public.company_roles where id = new.role_id and company_id = new.company_id;
  end if;
  return new;
end $$;
create trigger role_level before insert or update of role_id, role on public.memberships
  for each row execute function private.membership_role_level();

-- Changing a role's access level moves everyone who has it; deleting a role keeps their level.
create function private.sync_role_level() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.base_role is distinct from old.base_role then
    update public.memberships set role = new.base_role where role_id = new.id;
  end if;
  return null;
end $$;
create trigger sync_level after update of base_role on public.company_roles
  for each row execute function private.sync_role_level();

-- Can the signed-in person use this area? Built-in roles: everything their level allows.
create function private.has_perm(p_company uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when r.id is null then p_perm = any (private.level_permissions(m.role)) else p_perm = any (r.permissions) end
    from public.memberships m left join public.company_roles r on r.id = m.role_id
    where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active
  ), false)
$$;
grant execute on function private.has_perm(uuid, text) to authenticated, service_role;
grant execute on function private.level_permissions(public.member_role) to authenticated, service_role;

alter table public.company_roles enable row level security;
create policy company_roles_read on public.company_roles for select to authenticated using (private.is_member(company_id));
create policy company_roles_write on public.company_roles for all to authenticated
  using (private.has_role(company_id, '{owner,admin}') and private.has_perm(company_id, 'team'))
  with check (private.has_role(company_id, '{owner,admin}') and private.has_perm(company_id, 'team'));

-- Restrictive policies: these AND with the existing ones, so a switched-off area is closed even
-- to an access level that would otherwise reach it.
create function private.restrict_area(p_table text, p_perm text, p_reads boolean) returns void
language plpgsql as $$
declare check_sql text := format('private.has_perm(company_id, %L)', p_perm);
begin
  if p_reads then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', p_table || '_area', p_table, check_sql, check_sql);
  else
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (%s)', p_table || '_area_insert', p_table, check_sql);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (%s) with check (%s)', p_table || '_area_update', p_table, check_sql, check_sql);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (%s)', p_table || '_area_delete', p_table, check_sql);
  end if;
end $$;

-- Money: invoices and payments are hidden entirely without the area.
select private.restrict_area('invoices', 'invoices', true);
select private.restrict_area('invoice_line_items', 'invoices', true);
select private.restrict_area('payments', 'invoices', true);
-- Marketing and automations.
select private.restrict_area('campaigns', 'marketing', true);
select private.restrict_area('campaign_recipients', 'marketing', true);
select private.restrict_area('review_requests', 'marketing', true);
select private.restrict_area('referrals', 'marketing', true);
select private.restrict_area('automation_rules', 'automations', true);
select private.restrict_area('automation_runs', 'automations', true);
-- Sales: anyone at the level can read quotes; only the sales area writes them.
select private.restrict_area('quotes', 'sales', false);
select private.restrict_area('quote_line_items', 'sales', false);
-- Settings-type records: readable by the team (crews use checklists), written with the area.
select private.restrict_area('services', 'settings', false);
select private.restrict_area('intake_forms', 'settings', false);
select private.restrict_area('checklist_templates', 'settings', false);
select private.restrict_area('crews', 'settings', false);
select private.restrict_area('crew_members', 'settings', false);
-- Knowledge base editing.
select private.restrict_area('sop_pages', 'kb_edit', false);
select private.restrict_area('sop_categories', 'kb_edit', false);
-- Team management.
create policy memberships_area_insert on public.memberships as restrictive for insert to authenticated with check (private.has_perm(company_id, 'team'));
create policy memberships_area_update on public.memberships as restrictive for update to authenticated using (private.has_perm(company_id, 'team')) with check (private.has_perm(company_id, 'team'));
create policy memberships_area_delete on public.memberships as restrictive for delete to authenticated using (private.has_perm(company_id, 'team'));
-- Job costs: people always see expenses they logged; everyone else's need the area.
create policy expenses_area_read on public.expenses as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or private.has_perm(company_id, 'job_costs'));

-- Approving time needs the timesheets area.
create function private.time_approval_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.approved_at is distinct from old.approved_at and not private.has_perm(new.company_id, 'timesheets') then
    raise exception 'Your role can''t approve time' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger approval_guard before update of approved_at on public.time_entries
  for each row execute function private.time_approval_guard();

-- Starter roles for every company (they can be renamed, changed or deleted).
create function private.install_default_roles(p_company uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.company_roles (company_id, name, description, base_role, permissions) values
    (p_company, 'General manager', 'Runs the business day to day.', 'admin',
     array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team']),
    (p_company, 'Operations manager', 'Schedules crews and keeps jobs on track.', 'office',
     array['sales','job_costs','reports','schedule','timesheets','kb_edit']),
    (p_company, 'Foreman', 'Leads a crew in the field.', 'crew_lead', array['schedule']),
    (p_company, 'Employee', 'Works their own visits.', 'field_crew', array[]::text[])
  on conflict do nothing
$$;

create function private.company_roles_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.install_default_roles(new.id);
  return null;
end $$;
create trigger install_roles after insert on public.companies
  for each row execute function private.company_roles_defaults();

select private.install_default_roles(id) from public.companies;
