-- A sub taken off a visit has their clock on it stopped.
--
-- A sub the office keeps the hours of (Uses the clock) clocks in on their own visits, and stops the
-- clock from the field app by changing their own time entry, which row-level security allows only on
-- a visit they're on (time_entries_sub_update, 20261025002003_sub_field_app.sql). Taken off the visit
-- while clocked in (the office took them off, their pay was cancelled, or the visit came out of their
-- agreed pay), they couldn't stop it any more, and it ran until the hourly upkeep stopped it.
--
-- Now taking a sub's sign-in off a visit stops their running clock on that visit, then and there.
-- (The policy itself stays as it is: it can't see the entry as it was, so loosening it would let a
-- sub move a finished entry onto any visit.)

create function private.sub_clock_off_visit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.memberships m
    where m.company_id = old.company_id and m.user_id = old.user_id and m.role = 'subcontractor'
  ) then
    update public.time_entries set ended_at = greatest(now(), started_at)
    where company_id = old.company_id and user_id = old.user_id and visit_id = old.visit_id and ended_at is null;
  end if;
  return null;
end $$;
revoke all on function private.sub_clock_off_visit() from public;

create trigger sub_clock_off after delete on public.visit_assignees
  for each row execute function private.sub_clock_off_visit();
