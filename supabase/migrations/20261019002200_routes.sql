-- Routes: the order a crew visits its stops in on a day, by distance, with each stop's time
-- (packages/core/src/routing.ts plans it; apps/api/src/services/routes.ts saves it).
--
--   * A visit can have a fixed time: the customer expects 9:00, so organizing a route keeps that
--     time and plans the other stops around it. A recurring job can say the same for its visits.
--   * public.routes remembers which crew-days have been organized, and whether someone set the
--     order by hand. Automatic routes (settings.schedule.auto_routes) organize each day once and
--     never redo a day someone ordered by hand; new anytime visits are fitted into it.
--   * Only people who schedule a crew change its order or fixed times (visit_crew_guard), so a
--     field crew member sees the route the office or their crew lead set.

alter table public.visits add column time_fixed boolean not null default false;
alter table public.jobs add column visit_time_fixed boolean not null default false;

comment on column public.visits.time_fixed is 'Keep this start time when the route is organized (the customer expects it).';
comment on column public.jobs.visit_time_fixed is 'The recurring visits keep visit_start_time when routes are organized.';

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- null: the visits with no crew.
  crew_id uuid,
  route_date date not null,
  -- Someone set the order by hand (or undid an organized route): automatic routes leave it alone.
  by_hand boolean not null default false,
  miles numeric(8, 1),
  organized_at timestamptz not null default now(),
  organized_by uuid references auth.users (id) on delete set null,
  unique nulls not distinct (company_id, crew_id, route_date),
  foreign key (company_id, crew_id) references public.crews (company_id, id) on delete cascade
);
create index routes_company_day_idx on public.routes (company_id, route_date);

alter table public.routes enable row level security;
create policy routes_read on public.routes for select to authenticated using (private.is_member(company_id));
create policy routes_insert on public.routes for insert to authenticated with check (private.schedules_crew(company_id, crew_id));
create policy routes_update on public.routes for update to authenticated
  using (private.schedules_crew(company_id, crew_id)) with check (private.schedules_crew(company_id, crew_id));
create policy routes_delete on public.routes for delete to authenticated using (private.schedules_crew(company_id, crew_id));

-- As before (audit_fixes), with the stop order and fixed times added to what only the people who
-- schedule a crew may change.
create or replace function private.visit_crew_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
          or new.scheduled_on is distinct from old.scheduled_on or new.crew_id is distinct from old.crew_id
          or new.job_id is distinct from old.job_id or new.property_id is distinct from old.property_id
          or new.request_id is distinct from old.request_id
          or new.route_order is distinct from old.route_order or new.time_fixed is distinct from old.time_fixed)
     and not (private.schedules_crew(new.company_id, old.crew_id) and private.schedules_crew(new.company_id, new.crew_id)) then
    if private.has_role(new.company_id, '{crew_lead}') then
      raise exception 'You can change your own crew''s visits. Ask the office to move this one.' using errcode = '22023';
    end if;
    raise exception 'Your role can''t reschedule visits' using errcode = '42501';
  end if;
  if (select auth.uid()) is not null and private.has_role(new.company_id, '{crew_lead}')
     and not private.schedules_crew(new.company_id, old.crew_id) and not private.assigned_to_visit(old.id) then
    raise exception 'You can change your own crew''s visits. Ask the office to change this one.' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and new.invoice_id is distinct from old.invoice_id
     and not (private.has_role(new.company_id, '{owner,admin,office}') and private.has_perm(new.company_id, 'invoices')) then
    raise exception 'Only the office changes which invoice billed a visit' using errcode = '42501';
  end if;
  return new;
end $$;

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();

notify pgrst, 'reload schema';
