-- Rescheduling or reassigning a visit also needs the role's "schedule" area, not just the access level.
create or replace function private.visit_crew_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
          or new.scheduled_on is distinct from old.scheduled_on or new.crew_id is distinct from old.crew_id
          or new.job_id is distinct from old.job_id or new.property_id is distinct from old.property_id)
     and not (private.has_role(new.company_id, '{owner,admin,office,estimator,crew_lead}') and private.has_perm(new.company_id, 'schedule')) then
    raise exception 'Your role can''t reschedule visits' using errcode = '42501';
  end if;
  return new;
end $$;

-- Assigning people to visits follows the same rule.
create policy visit_assignees_area_insert on public.visit_assignees as restrictive for insert to authenticated with check (private.has_perm(company_id, 'schedule'));
create policy visit_assignees_area_delete on public.visit_assignees as restrictive for delete to authenticated using (private.has_perm(company_id, 'schedule'));
