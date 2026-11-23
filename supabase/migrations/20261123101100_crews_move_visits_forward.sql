-- Field crew and subs move a visit forward through its steps, as the field app does: on the way,
-- started, done. 20261123100200_what_field_crews_change.sql and 20261105000210_on_my_way_eta.sql
-- already kept them from cancelling it, taking it off the schedule or reopening it once it's done,
-- but a status change could still take it back a step: a started visit back to scheduled or to on
-- the way. Now the office moves a visit back. A step sent again is no change, and goes through as
-- before (apps/api/src/services/schedule.ts skips a field app tap that arrives after later ones).
--
-- supabase/tests/crews_move_visits_forward_test.sql covers both.

-- As 20261123100200_what_field_crews_change.sql, with the status only ever moving forward.
create or replace function private.visit_field_crew_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  free constant text[] := array['status', 'notes', 'completed_at', 'completed_by', 'updated_at', 'eta_at'];
  steps constant text[] := array['en_route', 'in_progress', 'completed'];
begin
  if current_user <> 'authenticated' or not private.has_role(old.company_id, '{field_crew}') then
    return new;
  end if;
  if to_jsonb(new) - free is distinct from to_jsonb(old) - free then
    raise exception 'You can change a visit''s status and notes. Ask the office about anything else.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and (old.status in ('completed', 'cancelled') or new.status <> all (steps)) then
    raise exception 'Ask the office to cancel, move or reopen this visit.' using errcode = '42501';
  end if;
  -- Forward through the steps, never back one: from scheduled (or not yet scheduled) to any of them.
  if array_position(steps, new.status) < coalesce(array_position(steps, old.status), 0) then
    raise exception 'Ask the office to move this visit back a step.' using errcode = '42501';
  end if;
  -- Finished when it was tapped (a phone that was offline sends the tap's time), if that's believable,
  -- and by whoever finished it. A visit finished before keeps its time and who finished it.
  new.completed_at := case
    when new.status = 'completed' and old.completed_at is null
         and new.completed_at <= now() and new.completed_at >= now() - interval '3 days' then new.completed_at
    when new.status = 'completed' then coalesce(old.completed_at, now())
    else old.completed_at end;
  new.completed_by := case when new.status = 'completed' and old.completed_at is null then (select auth.uid()) else old.completed_by end;
  return new;
end $$;

-- As 20261105000210_on_my_way_eta.sql, the same for a sub.
create or replace function private.visit_sub_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  free constant text[] := array['status', 'notes', 'completed_at', 'completed_by', 'updated_at', 'eta_at'];
  steps constant text[] := array['en_route', 'in_progress', 'completed'];
begin
  if (select auth.uid()) is null or not (old.company_id = any (private.sub_companies())) then return new; end if;
  if to_jsonb(new) - free is distinct from to_jsonb(old) - free then
    raise exception 'You can change a visit''s status and notes. Ask the office about anything else.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and (old.status in ('completed', 'cancelled') or new.status <> all (steps)) then
    raise exception 'Ask the office to cancel, move or reopen this visit.' using errcode = '42501';
  end if;
  if array_position(steps, new.status) < coalesce(array_position(steps, old.status), 0) then
    raise exception 'Ask the office to move this visit back a step.' using errcode = '42501';
  end if;
  new.completed_at := case
    when new.status = 'completed' and old.completed_at is null
         and new.completed_at <= now() and new.completed_at >= now() - interval '3 days' then new.completed_at
    when new.status = 'completed' then coalesce(old.completed_at, now())
    else old.completed_at end;
  new.completed_by := case when new.status = 'completed' and old.completed_at is null then (select auth.uid()) else old.completed_by end;
  return new;
end $$;
