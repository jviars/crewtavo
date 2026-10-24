-- Where people were when they clocked in and out, for the people who check their time.
--
-- The phone that starts or stops a clock sends where it is (or why it couldn't say) in the same write
-- as the clock itself, so a tap sent later from the offline queue still carries the place it was
-- made. Like the pay rate, the places can't be read from time_entries (the column grant leaves them
-- out): time_entry_places() hands them to the owner and managers with the timesheets area, and to a
-- crew lead for their crew. Nobody else sees them, the person whose time it is included.
-- A company can switch it off: settings.clock.record_location = false.

alter table public.time_entries
  add column in_place jsonb,
  add column out_place jsonb;

-- {"lat", "lng", "accuracy" (metres)} from the phone, or {"missing"} when it had none: the person said
-- no, it couldn't find one in time, or the phone can't tell. "by" is whose phone it was.
create function private.valid_clock_place(p jsonb) returns boolean
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' or p - array['lat', 'lng', 'accuracy', 'missing', 'by'] <> '{}'::jsonb then return false; end if;
  if p ? 'missing' then
    return p ->> 'missing' in ('denied', 'unavailable', 'timeout', 'unsupported') and not (p ? 'lat' or p ? 'lng' or p ? 'accuracy');
  end if;
  if jsonb_typeof(p -> 'lat') <> 'number' or jsonb_typeof(p -> 'lng') <> 'number'
     or (p ? 'accuracy' and jsonb_typeof(p -> 'accuracy') <> 'number') then
    return false;
  end if;
  return (p ->> 'lat')::float8 between -90 and 90 and (p ->> 'lng')::float8 between -180 and 180
     and coalesce((p ->> 'accuracy')::float8 >= 0, true);
end $$;

alter table public.time_entries
  add constraint time_entries_in_place_check check (private.valid_clock_place(in_place)),
  add constraint time_entries_out_place_check check (private.valid_clock_place(out_place));

-- A place comes with the clock: the start's as it's added running, the stop's with the update that
-- stops it. Neither can be added later or changed (fixing an entry's times keeps the places it
-- had), each records whose phone sent it (a crew lead clocking in the crew sends their own), and a
-- company that switched it off keeps none.
create function private.time_entry_place_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_off boolean;
  v_stops boolean := tg_op = 'UPDATE' and old.ended_at is null and new.ended_at is not null and old.out_place is null;
begin
  if (select auth.uid()) is null then return new; end if;
  if tg_op = 'INSERT' and (new.out_place is not null or (new.in_place is not null and new.ended_at is not null))
     or tg_op = 'UPDATE' and (new.in_place is distinct from old.in_place or (new.out_place is distinct from old.out_place and not v_stops)) then
    raise exception 'Where someone clocked in or out is saved by the clock as it starts or stops' using errcode = '42501';
  end if;
  select c.settings -> 'clock' ->> 'record_location' = 'false' into v_off from public.companies c where c.id = new.company_id;
  if new.in_place is not null and (tg_op = 'INSERT' or new.in_place is distinct from old.in_place) then
    new.in_place := case when v_off then null else new.in_place || jsonb_build_object('by', (select auth.uid())) end;
  end if;
  if new.out_place is not null and v_stops then
    new.out_place := case when v_off then null else new.out_place || jsonb_build_object('by', (select auth.uid())) end;
  end if;
  return new;
end $$;
create trigger place_guard before insert or update on public.time_entries
  for each row execute function private.time_entry_place_guard();

-- Where these entries were clocked in and out, with the place the work was at (the visit's or job's
-- property, or the shop for shop time), for whoever checks the time: the owner and managers with the
-- timesheets area see everyone's, a crew lead their crew's but not their own. Entries the caller
-- can't see that for are left out.
create function public.time_entry_places(p_company uuid, p_entries uuid[])
returns table (id uuid, in_place jsonb, out_place jsonb, site jsonb)
language sql stable security definer set search_path = '' as $$
  select te.id, te.in_place, te.out_place,
         case
           when vp.lat is not null and vp.lng is not null then jsonb_build_object('kind', 'job', 'lat', vp.lat, 'lng', vp.lng)
           when jp.lat is not null and jp.lng is not null then jsonb_build_object('kind', 'job', 'lat', jp.lat, 'lng', jp.lng)
           when te.category = 'shop' and jsonb_typeof(c.settings -> 'depot' -> 'lat') = 'number' and jsonb_typeof(c.settings -> 'depot' -> 'lng') = 'number'
             then jsonb_build_object('kind', 'shop', 'lat', c.settings -> 'depot' -> 'lat', 'lng', c.settings -> 'depot' -> 'lng')
         end
  from public.time_entries te
  join public.companies c on c.id = te.company_id
  left join public.visits v on v.id = te.visit_id
  left join public.properties vp on vp.id = v.property_id
  left join public.jobs j on j.id = te.job_id
  left join public.properties jp on jp.id = j.property_id
  where te.company_id = p_company
    and te.id = any (p_entries)
    and (te.in_place is not null or te.out_place is not null)
    and ((select private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'timesheets'))
         or (te.user_id <> (select auth.uid()) and (select private.has_role(p_company, '{crew_lead}')) and private.on_my_crew(p_company, te.user_id)))
$$;
revoke execute on function public.time_entry_places(uuid, uuid[]) from public, anon;
grant execute on function public.time_entry_places(uuid, uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
