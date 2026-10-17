-- Multi-day work and equipment on visits.
--
-- Multi-day: a 3-day parking lot is booked once and becomes three linked visits, one per work
-- day (each with its own status, checklist, photos and time, like a daily log). series_id links
-- them, series_day/series_total say "Day 2 of 3". Moving one day can move the days after it.
--
-- Equipment: the machines and trucks a visit needs (paver, roller, dump trucks...). Booking the
-- same machine on two visits at the same time shows a warning; the crew sees what to bring.

alter table public.visits
  add column series_id uuid,
  add column series_day smallint check (series_day >= 1),
  add column series_total smallint check (series_total between 1 and 60),
  add constraint visits_series_check check ((series_id is null) = (series_day is null) and (series_id is null) = (series_total is null) and series_day <= series_total);
create index visits_series_idx on public.visits (series_id) where series_id is not null;

create table public.visit_equipment (
  company_id uuid not null,
  visit_id uuid not null,
  equipment_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (visit_id, equipment_id),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade,
  foreign key (company_id, equipment_id) references public.equipment (company_id, id) on delete cascade
);
create index visit_equipment_equipment_idx on public.visit_equipment (equipment_id);

alter table public.visit_equipment enable row level security;
-- Anyone who can see the visit sees what it needs; whoever can schedule the visit books machines.
create policy visit_equipment_read on public.visit_equipment for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.assigned_to_visit(visit_id))
);
create policy visit_equipment_write on public.visit_equipment for all to authenticated
  using (private.schedules_crew(company_id, private.visit_crew(visit_id)))
  with check (private.schedules_crew(company_id, private.visit_crew(visit_id)));

-- Other open visits that have this machine at an overlapping time (or on the same day, for
-- anytime visits). Runs with the caller's access.
create function public.equipment_conflicts(p_company uuid, p_equipment uuid[], p_day date, p_starts timestamptz, p_ends timestamptz, p_except uuid default null)
returns table (equipment_id uuid, visit_id uuid, title text, starts_at timestamptz, ends_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select ve.equipment_id, v.id, v.title, v.starts_at, v.ends_at
  from public.visit_equipment ve
  join public.visits v on v.id = ve.visit_id
  where ve.company_id = p_company
    and ve.equipment_id = any (p_equipment)
    and v.id is distinct from p_except
    and v.status not in ('completed', 'cancelled', 'unscheduled')
    and v.scheduled_on = p_day
    and (p_starts is null or v.starts_at is null or (v.starts_at < coalesce(p_ends, p_starts + interval '1 hour') and coalesce(v.ends_at, v.starts_at + interval '1 hour') > p_starts))
  order by v.starts_at nulls first
$$;
revoke execute on function public.equipment_conflicts(uuid, uuid[], date, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.equipment_conflicts(uuid, uuid[], date, timestamptz, timestamptz, uuid) to authenticated;

notify pgrst, 'reload schema';
