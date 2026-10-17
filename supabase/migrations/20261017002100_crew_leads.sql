-- Crew leads ("Foreman") run their own crew.
--
-- A crew lead schedules, reassigns and rain-shifts the visits of the crews they lead or belong to,
-- assigning only people on those crews, and sees (and with the "timesheets" area approves) those
-- people's time. The "schedule" area ("Schedule the whole team") still extends scheduling to every
-- crew, as before. Crew leads keep reading the whole schedule so they can see where the other
-- crews are; they still never see prices, invoices or pay rates.
--
-- Everyone who can see a job also sees its scope of work: line item names, descriptions and
-- quantities, never prices (public.job_scope).
--
-- Starter roles: a new "Office manager" (the person who books work and sends invoices), and the
-- starter "Foreman" moves from whole-team scheduling to their own crew.

-- ---------------------------------------------------------------------------------------------
-- Who's on my crew
-- ---------------------------------------------------------------------------------------------

-- Crews the signed-in person leads or is on.
create function private.my_crews(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.crews c where c.company_id = p_company and c.lead_user_id = (select auth.uid())
  union
  select m.crew_id from public.crew_members m where m.company_id = p_company and m.user_id = (select auth.uid())
$$;

-- Is p_user me, or on one of my crews (as a member or its lead)?
create function private.on_my_crew(p_company uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user = (select auth.uid()) or exists (
    select 1 from private.my_crews(p_company) as mine(crew_id)
    where exists (select 1 from public.crew_members m where m.crew_id = mine.crew_id and m.user_id = p_user)
       or exists (select 1 from public.crews c where c.id = mine.crew_id and c.lead_user_id = p_user)
  )
$$;

-- May I change this crew's schedule? Every crew with the "schedule" area; my own crews as a crew lead.
create function private.schedules_crew(p_company uuid, p_crew uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (private.has_role(p_company, '{owner,admin,office,estimator,crew_lead}') and private.has_perm(p_company, 'schedule'))
      or (private.has_role(p_company, '{crew_lead}') and p_crew is not null
          and exists (select 1 from private.my_crews(p_company) as mine(crew_id) where mine.crew_id = p_crew))
$$;

create function private.visit_crew(p_visit uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select crew_id from public.visits where id = p_visit
$$;

revoke execute on function private.my_crews(uuid) from public;
grant execute on function private.my_crews(uuid), private.on_my_crew(uuid, uuid), private.schedules_crew(uuid, uuid), private.visit_crew(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Visits: creating, moving, reassigning and deleting follow schedules_crew()
-- ---------------------------------------------------------------------------------------------

create or replace function private.visit_crew_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
          or new.scheduled_on is distinct from old.scheduled_on or new.crew_id is distinct from old.crew_id
          or new.job_id is distinct from old.job_id or new.property_id is distinct from old.property_id)
     and not (private.schedules_crew(new.company_id, old.crew_id) and private.schedules_crew(new.company_id, new.crew_id)) then
    if private.has_role(new.company_id, '{crew_lead}') then
      raise exception 'You can change your own crew''s visits. Ask the office to move this one.' using errcode = '22023';
    end if;
    raise exception 'Your role can''t reschedule visits' using errcode = '42501';
  end if;
  return new;
end $$;

create policy visits_area_insert on public.visits as restrictive for insert to authenticated
  with check (private.schedules_crew(company_id, crew_id));
create policy visits_area_delete on public.visits as restrictive for delete to authenticated
  using (private.schedules_crew(company_id, crew_id));

-- People on a visit: anyone, with the area; otherwise people on my crew, on my crew's visits.
drop policy visit_assignees_area_insert on public.visit_assignees;
drop policy visit_assignees_area_delete on public.visit_assignees;
create policy visit_assignees_area_insert on public.visit_assignees as restrictive for insert to authenticated
  with check (
    private.schedules_crew(company_id, private.visit_crew(visit_id))
    and (private.has_perm(company_id, 'schedule') or private.on_my_crew(company_id, user_id))
  );
create policy visit_assignees_area_delete on public.visit_assignees as restrictive for delete to authenticated
  using (private.schedules_crew(company_id, private.visit_crew(visit_id)));

-- ---------------------------------------------------------------------------------------------
-- Time: crew leads see and enter their crew's time; approving needs the "timesheets" area
-- ---------------------------------------------------------------------------------------------

drop policy time_entries_read on public.time_entries;
create policy time_entries_read on public.time_entries for select to authenticated using (
  (user_id = (select auth.uid()) and private.is_member(company_id))
  or private.has_role(company_id, '{owner,admin,office}')
  or (private.has_role(company_id, '{crew_lead}') and private.on_my_crew(company_id, user_id))
);
drop policy time_entries_insert on public.time_entries;
create policy time_entries_insert on public.time_entries for insert to authenticated with check (
  (user_id = (select auth.uid()) and private.is_member(company_id))
  or private.has_role(company_id, '{owner,admin,office}')
  or (private.has_role(company_id, '{crew_lead}') and private.on_my_crew(company_id, user_id))
);
drop policy time_entries_update on public.time_entries;
create policy time_entries_update on public.time_entries for update to authenticated
  using (
    (user_id = (select auth.uid()) and approved_at is null)
    or private.has_role(company_id, '{owner,admin,office}')
    or (private.has_role(company_id, '{crew_lead}') and private.on_my_crew(company_id, user_id) and (approved_at is null or private.has_perm(company_id, 'timesheets')))
  )
  with check (
    private.is_member(company_id)
    and (approved_at is null or private.has_role(company_id, '{owner,admin,office}')
         or (private.has_role(company_id, '{crew_lead}') and private.on_my_crew(company_id, user_id)))
  );
drop policy time_entries_delete on public.time_entries;
create policy time_entries_delete on public.time_entries for delete to authenticated using (
  (user_id = (select auth.uid()) and approved_at is null)
  or private.has_role(company_id, '{owner,admin,office}')
  or (private.has_role(company_id, '{crew_lead}') and private.on_my_crew(company_id, user_id) and approved_at is null)
);

-- Approving needs the area, a crew lead can't approve their own time, and the person's pay rate is
-- copied onto the entry when it's approved (crew leads can't read pay rates, job costing needs them).
create or replace function private.time_approval_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.approved_at is distinct from old.approved_at then
    if not private.has_perm(new.company_id, 'timesheets') then
      raise exception 'Your role can''t approve time' using errcode = '42501';
    end if;
    if new.approved_at is not null and new.user_id = (select auth.uid()) and private.has_role(new.company_id, '{crew_lead}') then
      raise exception 'The office approves your own time.' using errcode = '22023';
    end if;
  end if;
  if new.approved_at is not null and old.approved_at is null and new.labor_rate is null then
    select m.labor_rate into new.labor_rate from public.memberships m where m.company_id = new.company_id and m.user_id = new.user_id;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Scope of work without prices
-- ---------------------------------------------------------------------------------------------

create function public.job_scope(p_job uuid)
returns table (id uuid, name text, description text, quantity numeric, unit text, sort integer)
language sql stable security definer set search_path = '' as $$
  select li.id, li.name, li.description, li.quantity, li.unit, li.sort
  from public.job_line_items li
  join public.jobs j on j.id = li.job_id
  where li.job_id = p_job
    and li.unit_price >= 0 -- discount lines are about money, not work
    and (private.has_role(j.company_id, '{owner,admin,office,estimator,crew_lead}')
         or (private.is_member(j.company_id) and private.crew_sees_job(j.id)))
  order by li.sort, li.name
$$;
revoke execute on function public.job_scope(uuid) from public, anon;
grant execute on function public.job_scope(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Areas and starter roles (mirrors LEVEL_PERMISSIONS in packages/core/src/roles.ts)
-- ---------------------------------------------------------------------------------------------

create or replace function private.level_permissions(p_level public.member_role) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select case p_level
    when 'owner' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps','equipment']
    when 'admin' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps','equipment']
    when 'office' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','equipment']
    when 'estimator' then array['sales','schedule','equipment']
    when 'crew_lead' then array['schedule','timesheets','equipment']
    else array[]::text[]
  end
$$;

create or replace function private.install_default_roles(p_company uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.company_roles (company_id, name, description, base_role, permissions) values
    (p_company, 'General manager', 'Runs the business day to day.', 'admin',
     array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','equipment']),
    (p_company, 'Office manager', 'Books work, schedules crews, sends quotes and invoices, and approves time.', 'office',
     array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','equipment']),
    (p_company, 'Operations manager', 'Schedules crews and keeps jobs on track.', 'office',
     array['sales','job_costs','reports','schedule','timesheets','kb_edit','equipment']),
    (p_company, 'Foreman', 'Runs their crew: schedules its visits, assigns its people and sees its time. No prices.', 'crew_lead', array['equipment']),
    (p_company, 'Employee', 'Works their own visits.', 'field_crew', array[]::text[])
  on conflict do nothing
$$;

-- Existing companies get the Office manager role; starter Foremen nobody changed move to their own crew.
select private.install_default_roles(id) from public.companies;
update public.company_roles
set permissions = array['equipment'], description = 'Runs their crew: schedules its visits, assigns its people and sees its time. No prices.'
where base_role = 'crew_lead' and name = 'Foreman' and description = 'Leads a crew in the field.'
  and permissions @> array['schedule','equipment'] and permissions <@ array['schedule','equipment'];

notify pgrst, 'reload schema';
