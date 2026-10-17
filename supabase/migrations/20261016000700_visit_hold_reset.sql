-- A visit moved to another day drops its weather hold; the weather task re-checks the new date.
create or replace function private.visit_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tz text;
begin
  if new.starts_at is not null then
    select timezone into tz from public.companies where id = new.company_id;
    new.scheduled_on := (new.starts_at at time zone coalesce(tz, 'UTC'))::date;
  end if;
  if tg_op = 'UPDATE' and new.scheduled_on is distinct from old.scheduled_on and new.hold_reason is not distinct from old.hold_reason then
    new.hold_reason := null;
  end if;
  if new.status = 'completed' and new.completed_at is null then
    new.completed_at := now();
    new.completed_by := (select auth.uid());
  end if;
  return new;
end $$;
