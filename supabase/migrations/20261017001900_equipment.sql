-- Equipment: trucks, trailers, mowers, machines and tools, with hour or mile meters and
-- maintenance schedules.
--
--   equipment              what the company owns, which crew has it, and its latest meter reading
--   equipment_plans        maintenance schedules ("Oil change every 50 hours or 6 months")
--   equipment_logs         history: service done, repairs, meter readings, notes
--   equipment_financials   purchase price, readable with the job costs area (like job_financials)
--   expenses.equipment_id  what upkeep costs, under the existing expense privacy rules
--   equipment_due          view: every schedule with its next due date or reading and its state
--
-- Everyone on the team sees equipment and can log readings and service from the field. Adding,
-- changing or removing equipment and schedules needs the new "equipment" area.

-- ---------------------------------------------------------------------------------------------
-- The equipment area (mirrors LEVEL_PERMISSIONS in packages/core/src/roles.ts)
-- ---------------------------------------------------------------------------------------------

create or replace function private.level_permissions(p_level public.member_role) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select case p_level
    when 'owner' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps','equipment']
    when 'admin' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps','equipment']
    when 'office' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','equipment']
    when 'estimator' then array['sales','schedule','equipment']
    when 'crew_lead' then array['schedule','equipment']
    else array[]::text[]
  end
$$;

-- Roles that already manage company setup get equipment too, as does the starter Foreman role.
update public.company_roles set permissions = permissions || array['equipment']
where not ('equipment' = any (permissions))
  and ('settings' = any (permissions) or (base_role = 'crew_lead' and name = 'Foreman' and permissions = array['schedule']));

create or replace function private.install_default_roles(p_company uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.company_roles (company_id, name, description, base_role, permissions) values
    (p_company, 'General manager', 'Runs the business day to day.', 'admin',
     array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','equipment']),
    (p_company, 'Operations manager', 'Schedules crews and keeps jobs on track.', 'office',
     array['sales','job_costs','reports','schedule','timesheets','kb_edit','equipment']),
    (p_company, 'Foreman', 'Leads a crew in the field.', 'crew_lead', array['schedule','equipment']),
    (p_company, 'Employee', 'Works their own visits.', 'field_crew', array[]::text[])
  on conflict do nothing
$$;

-- Equipment managers: any level above field crew, with the area.
create function private.manages_equipment(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_company, '{owner,admin,office,estimator,crew_lead}') and private.has_perm(p_company, 'equipment')
$$;
grant execute on function private.manages_equipment(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.equipment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  kind text not null default 'other' check (kind in ('truck', 'trailer', 'mower', 'machine', 'tool', 'other')),
  make text check (length(make) <= 80),
  model text check (length(model) <= 80),
  year integer check (year between 1900 and 2100),
  serial text check (length(serial) <= 80), -- serial number or VIN
  plate text check (length(plate) <= 20),
  meter text not null default 'hours' check (meter in ('hours', 'miles', 'none')),
  meter_reading numeric(12, 1) check (meter_reading >= 0),
  meter_read_on date,
  status text not null default 'active' check (status in ('active', 'in_shop', 'retired')),
  crew_id uuid,
  purchased_on date,
  photo_path text, -- Storage object key
  notes text check (length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, crew_id) references public.crews (company_id, id) on delete set null (crew_id)
);
create index equipment_company_idx on public.equipment (company_id, status, name);
create index equipment_crew_idx on public.equipment (crew_id) where crew_id is not null;

create table public.equipment_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  equipment_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 120),
  -- Due every N days, weeks, months or years, every so many hours or miles, or whichever comes first.
  every_count integer check (every_count between 1 and 3650),
  every_unit text check (every_unit in ('day', 'week', 'month', 'year')),
  every_meter numeric(10, 1) check (every_meter > 0),
  -- When it was last done before it was tracked here (entered with the schedule).
  baseline_on date,
  baseline_meter numeric(12, 1) check (baseline_meter >= 0),
  -- Kept current by the triggers below: the latest service logged, or the baseline.
  last_done_on date,
  last_done_meter numeric(12, 1),
  notes text check (length(notes) <= 2000),
  active boolean not null default true,
  alerted_state text, -- the last state people were notified about (emit_equipment_alerts)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (equipment_id, id),
  check ((every_count is null) = (every_unit is null)),
  check (every_count is not null or every_meter is not null),
  foreign key (company_id, equipment_id) references public.equipment (company_id, id) on delete cascade
);
create index equipment_plans_equipment_idx on public.equipment_plans (equipment_id);

alter table public.expenses add constraint expenses_company_id_id_key unique (company_id, id);
alter table public.expenses add column equipment_id uuid;
alter table public.expenses add constraint expenses_equipment_fkey foreign key (company_id, equipment_id)
  references public.equipment (company_id, id) on delete set null (equipment_id);
create index expenses_equipment_idx on public.expenses (equipment_id) where equipment_id is not null;

create table public.equipment_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  equipment_id uuid not null,
  kind text not null check (kind in ('service', 'repair', 'reading', 'note')),
  plan_id uuid, -- the schedule a service completes
  title text check (length(title) <= 120),
  done_on date not null,
  meter_reading numeric(12, 1) check (meter_reading >= 0),
  notes text check (length(notes) <= 4000),
  expense_id uuid,
  user_id uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (kind = 'service' or plan_id is null),
  check (kind <> 'reading' or meter_reading is not null),
  foreign key (company_id, equipment_id) references public.equipment (company_id, id) on delete cascade,
  foreign key (equipment_id, plan_id) references public.equipment_plans (equipment_id, id) on delete set null (plan_id),
  foreign key (company_id, expense_id) references public.expenses (company_id, id) on delete set null (expense_id)
);
create index equipment_logs_equipment_idx on public.equipment_logs (equipment_id, done_on desc, created_at desc);
create index equipment_logs_plan_idx on public.equipment_logs (plan_id) where plan_id is not null;

create table public.equipment_financials (
  equipment_id uuid primary key,
  company_id uuid not null,
  purchase_price numeric(12, 2) check (purchase_price >= 0),
  updated_at timestamptz not null default now(),
  foreign key (company_id, equipment_id) references public.equipment (company_id, id) on delete cascade
);

select private.add_touch_triggers(array['equipment', 'equipment_plans', 'equipment_financials']);

-- ---------------------------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------------------------

-- Equipment and schedules: the whole team reads; managers write.
alter table public.equipment enable row level security;
create policy equipment_read on public.equipment for select to authenticated using (private.is_member(company_id));
create policy equipment_write on public.equipment for all to authenticated
  using (private.manages_equipment(company_id)) with check (private.manages_equipment(company_id));

alter table public.equipment_plans enable row level security;
create policy equipment_plans_read on public.equipment_plans for select to authenticated using (private.is_member(company_id));
create policy equipment_plans_write on public.equipment_plans for all to authenticated
  using (private.manages_equipment(company_id)) with check (private.manages_equipment(company_id));
-- The schedule's history and alert columns are kept by the database.
revoke insert, update on public.equipment_plans from authenticated;
grant insert (company_id, equipment_id, name, every_count, every_unit, every_meter, baseline_on, baseline_meter, notes, active)
  on public.equipment_plans to authenticated;
grant update (name, every_count, every_unit, every_meter, baseline_on, baseline_meter, notes, active)
  on public.equipment_plans to authenticated;

-- History: anyone on the team logs as themselves; they can fix their own entries, managers any.
alter table public.equipment_logs enable row level security;
create policy equipment_logs_read on public.equipment_logs for select to authenticated using (private.is_member(company_id));
create policy equipment_logs_insert on public.equipment_logs for insert to authenticated
  with check (private.is_member(company_id) and (user_id = (select auth.uid()) or private.manages_equipment(company_id)));
create policy equipment_logs_update on public.equipment_logs for update to authenticated
  using (user_id = (select auth.uid()) or private.manages_equipment(company_id))
  with check (private.is_member(company_id) and (user_id = (select auth.uid()) or private.manages_equipment(company_id)));
create policy equipment_logs_delete on public.equipment_logs for delete to authenticated
  using (user_id = (select auth.uid()) or private.manages_equipment(company_id));

-- What it cost: office staff with the job costs area.
alter table public.equipment_financials enable row level security;
create policy equipment_financials_all on public.equipment_financials for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'job_costs'))
  with check (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'job_costs'));

-- ---------------------------------------------------------------------------------------------
-- Keeping schedules and meters current
-- ---------------------------------------------------------------------------------------------

create function private.company_today(p_company uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone coalesce((select timezone from public.companies where id = p_company), 'UTC'))::date
$$;

-- A schedule's "last done" is its latest logged service, or the baseline entered with it.
create function private.equipment_plan_last_done() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_on date; v_meter numeric;
begin
  if tg_op = 'INSERT' then
    new.baseline_on := coalesce(new.baseline_on, private.company_today(new.company_id));
    if new.every_meter is not null and new.baseline_meter is null then
      new.baseline_meter := (select meter_reading from public.equipment where id = new.equipment_id);
    end if;
  end if;
  select l.done_on, l.meter_reading into v_on, v_meter
  from public.equipment_logs l
  where l.plan_id = new.id and l.kind = 'service'
  order by l.done_on desc, l.created_at desc
  limit 1;
  if v_on is not null and (new.baseline_on is null or v_on >= new.baseline_on) then
    new.last_done_on := v_on;
    new.last_done_meter := coalesce(v_meter, new.baseline_meter);
  else
    new.last_done_on := new.baseline_on;
    new.last_done_meter := new.baseline_meter;
  end if;
  -- Done again (or rescheduled): alert afresh next time it comes due.
  if tg_op = 'UPDATE' and (new.last_done_on is distinct from old.last_done_on or new.last_done_meter is distinct from old.last_done_meter
      or new.every_count is distinct from old.every_count or new.every_unit is distinct from old.every_unit or new.every_meter is distinct from old.every_meter) then
    new.alerted_state := null;
  end if;
  return new;
end $$;
create trigger last_done before insert or update on public.equipment_plans
  for each row execute function private.equipment_plan_last_done();

-- Logs: default the date and, for a service, the machine's current reading.
create function private.equipment_log_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.done_on := coalesce(new.done_on, private.company_today(new.company_id));
  if new.kind = 'service' and new.meter_reading is null then
    new.meter_reading := (select meter_reading from public.equipment where id = new.equipment_id and meter <> 'none');
  end if;
  return new;
end $$;
create trigger defaults before insert on public.equipment_logs
  for each row execute function private.equipment_log_defaults();

-- After a log changes: refresh the schedules it completes and the machine's latest reading.
create function private.equipment_log_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_equipment uuid := coalesce(new.equipment_id, old.equipment_id);
  v_latest record;
begin
  update public.equipment_plans set updated_at = now()
  where id in (new.plan_id, old.plan_id);

  -- The newest log with a reading sets the meter. If none are left, keep what was entered.
  select l.meter_reading, l.done_on into v_latest
  from public.equipment_logs l
  where l.equipment_id = v_equipment and l.meter_reading is not null
  order by l.done_on desc, l.created_at desc
  limit 1;
  -- A reading typed in by hand later than every log stays, unless the log that set it changed.
  if v_latest.meter_reading is not null then
    update public.equipment e set meter_reading = v_latest.meter_reading, meter_read_on = v_latest.done_on
    where e.id = v_equipment and e.meter <> 'none'
      and (e.meter_reading is distinct from v_latest.meter_reading or e.meter_read_on is distinct from v_latest.done_on)
      and (e.meter_read_on is null or v_latest.done_on >= e.meter_read_on
           or (tg_op <> 'INSERT' and old.meter_reading is not distinct from e.meter_reading and old.done_on = e.meter_read_on));
  end if;

  if tg_op = 'INSERT' and new.kind in ('service', 'repair') then
    perform private.emit(new.company_id, 'equipment.' || case new.kind when 'service' then 'serviced' else 'repaired' end, 'equipment', new.equipment_id,
      format('%s on %s', coalesce(nullif(trim(new.title), ''), case new.kind when 'service' then 'Maintenance' else 'Repair' end),
             (select name from public.equipment where id = new.equipment_id)),
      jsonb_build_object('log_id', new.id, 'plan_id', new.plan_id));
  end if;
  return null;
end $$;
create trigger sync after insert or update or delete on public.equipment_logs
  for each row execute function private.equipment_log_sync();

-- A machine added with a reading was read today (the app sets meter_read_on when it's edited).
create function private.equipment_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.meter_reading is not null and new.meter_read_on is null then
    new.meter_read_on := private.company_today(new.company_id);
  end if;
  return new;
end $$;
create trigger defaults before insert on public.equipment for each row execute function private.equipment_defaults();

create function private.equipment_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.emit(new.company_id, 'equipment.added', 'equipment', new.id, 'New equipment: ' || new.name, jsonb_build_object('kind', new.kind));
  return null;
end $$;
create trigger activity after insert on public.equipment for each row execute function private.equipment_activity();

-- ---------------------------------------------------------------------------------------------
-- What's due
-- ---------------------------------------------------------------------------------------------

-- Every active schedule on equipment still in use. "due_soon" is the last quarter of the time (at
-- most 14 days) or the last 10% of the hours or miles; "overdue" is past the date or at the reading.
-- Runs with the caller's access.
create view public.equipment_due with (security_invoker = true) as
select
  p.id as plan_id, p.company_id, p.equipment_id, p.name, p.every_count, p.every_unit, p.every_meter,
  p.last_done_on, p.last_done_meter, p.notes,
  e.name as equipment_name, e.kind, e.meter, e.meter_reading, e.crew_id, e.status as equipment_status,
  d.next_due_on, d.next_due_meter,
  d.next_due_on - d.today as days_left,
  case when d.next_due_meter is not null and e.meter_reading is not null then d.next_due_meter - e.meter_reading end as meter_left,
  case
    when d.next_due_on < d.today or (d.next_due_meter is not null and e.meter_reading >= d.next_due_meter) then 'overdue'
    when d.next_due_on <= d.today + least(14, greatest(1, (d.next_due_on - coalesce(p.last_done_on, p.created_at::date)) / 4))
      or (d.next_due_meter is not null and e.meter_reading >= d.next_due_meter - greatest(p.every_meter * 0.1, 1)) then 'due_soon'
    else 'ok'
  end as state
from public.equipment_plans p
join public.equipment e on e.id = p.equipment_id
join public.companies c on c.id = p.company_id
cross join lateral (
  select
    (now() at time zone coalesce(c.timezone, 'UTC'))::date as today,
    case when p.every_count is not null then (coalesce(p.last_done_on, p.created_at::date) + case p.every_unit
      when 'day' then make_interval(days => p.every_count)
      when 'week' then make_interval(weeks => p.every_count)
      when 'month' then make_interval(months => p.every_count)
      else make_interval(years => p.every_count) end)::date end as next_due_on,
    case when p.every_meter is not null and e.meter <> 'none' then coalesce(p.last_done_meter, 0) + p.every_meter end as next_due_meter
) d
where p.active and e.status <> 'retired';

revoke all on public.equipment_due from anon, public;
grant select on public.equipment_due to authenticated, service_role;

-- Notify equipment managers (and the lead of the crew that has the machine) once when a schedule
-- comes due and again if it goes overdue. Run hourly by the server; safe to run twice.
create function public.emit_equipment_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; v_sent integer := 0; v_title text; v_body text; v_at text;
begin
  -- Schedules back to "ok" without service (say the interval changed) can alert again later.
  update public.equipment_plans p set alerted_state = null
  where p.alerted_state is not null
    and not exists (select 1 from public.equipment_due d where d.plan_id = p.id and d.state <> 'ok');

  for r in
    select d.*, p.alerted_state
    from public.equipment_due d
    join public.equipment_plans p on p.id = d.plan_id
    where d.equipment_status = 'active' and d.state <> 'ok'
      and (p.alerted_state is null or (d.state = 'overdue' and p.alerted_state <> 'overdue'))
    for update of p skip locked
  loop
    v_title := format('%s is %s on %s', r.name, case r.state when 'overdue' then 'overdue' else 'coming due' end, r.equipment_name);
    -- "Due Oct 20 or at 1,250 hours (now 1,262)"
    v_at := case when r.next_due_meter is not null then format('at %s %s', rtrim(to_char(r.next_due_meter, 'FM999,999,990.9'), '.'), r.meter) end;
    v_body := 'Due ' || concat_ws(' or ', to_char(r.next_due_on, 'Mon FMDD'), v_at)
      || case when v_at is not null and r.meter_reading is not null then format(' (now %s)', rtrim(to_char(r.meter_reading, 'FM999,999,990.9'), '.')) else '' end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select r.company_id, m.user_id, 'equipment', v_title, v_body, '/equipment/' || r.equipment_id
    from public.memberships m
    left join public.company_roles cr on cr.id = m.role_id
    where m.company_id = r.company_id and m.active
      and 'equipment' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
      and (m.role in ('owner', 'admin', 'office', 'estimator')
           or (m.role = 'crew_lead' and r.crew_id is not null
               and exists (select 1 from public.crew_members cm where cm.crew_id = r.crew_id and cm.user_id = m.user_id)));
    update public.equipment_plans set alerted_state = r.state where id = r.plan_id;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;
revoke execute on function public.emit_equipment_alerts() from public, anon, authenticated;
grant execute on function public.emit_equipment_alerts() to service_role;
