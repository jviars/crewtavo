-- Forgotten clocks: a clock still running after 10 hours reminds its owner (and their crew lead),
-- and one still running after 16 hours is stopped at the end of that working day, marked so the
-- office checks it before approving. Both limits can be changed per company in
-- settings.clock = {"remind_after_hours": 10, "stop_after_hours": 16}. Run hourly by the server.

alter table public.time_entries
  add column reminded_at timestamptz,
  add column auto_stopped_at timestamptz;

create function public.clock_upkeep() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_reminded integer := 0; v_stopped integer := 0; v_end timestamptz; v_local text;
begin
  for r in
    select te.id, te.company_id, te.user_id, te.started_at, c.timezone,
           coalesce((c.settings -> 'clock' ->> 'remind_after_hours')::numeric, 10) as remind_after,
           coalesce((c.settings -> 'clock' ->> 'stop_after_hours')::numeric, 16) as stop_after,
           coalesce(c.settings -> 'working_hours' ->> 'end', '18:00') as day_end
    from public.time_entries te
    join public.companies c on c.id = te.company_id
    where te.ended_at is null and te.started_at < now() - interval '1 hour'
    for update of te skip locked
  loop
    v_local := to_char(r.started_at at time zone coalesce(r.timezone, 'UTC'), 'FMHH12:MI AM');
    if r.started_at < now() - make_interval(secs => (r.stop_after * 3600)::int) then
      -- Stop it at the end of the working day it started on (or 8 hours in, if it started after that).
      v_end := ((r.started_at at time zone coalesce(r.timezone, 'UTC'))::date + r.day_end::time) at time zone coalesce(r.timezone, 'UTC');
      if v_end <= r.started_at then
        v_end := r.started_at + interval '8 hours';
      end if;
      update public.time_entries set ended_at = v_end, auto_stopped_at = now() where id = r.id;
      insert into public.notifications (company_id, user_id, kind, title, body, link)
      values (r.company_id, r.user_id, 'time', 'Your clock was stopped for you',
              format('It started at %s and was still running, so it was stopped at %s. Fix the end time on Timesheets if that''s wrong.',
                     v_local, to_char(v_end at time zone coalesce(r.timezone, 'UTC'), 'FMHH12:MI AM Dy')),
              '/timesheets');
      v_stopped := v_stopped + 1;
    elsif r.started_at < now() - make_interval(secs => (r.remind_after * 3600)::int)
          and not exists (select 1 from public.time_entries t2 where t2.id = r.id and t2.reminded_at is not null) then
      update public.time_entries set reminded_at = now() where id = r.id;
      insert into public.notifications (company_id, user_id, kind, title, body, link)
      select r.company_id, who.user_id, 'time',
             case when who.user_id = r.user_id then 'Your clock is still running' else format('%s''s clock is still running', coalesce(nullif(p.full_name, ''), 'A crew member')) end,
             format('Started at %s, %s hours ago. Stop it if the day is done.', v_local, floor(extract(epoch from now() - r.started_at) / 3600)),
             case when who.user_id = r.user_id then '/field' else '/timesheets' end
      from (
        select r.user_id
        union
        -- Their crew lead, who can stop it for them.
        select c.lead_user_id from public.crews c
        join public.crew_members cm on cm.crew_id = c.id
        where cm.user_id = r.user_id and c.company_id = r.company_id and c.active and c.lead_user_id is not null and c.lead_user_id <> r.user_id
      ) who
      left join public.profiles p on p.user_id = r.user_id;
      v_reminded := v_reminded + 1;
    end if;
  end loop;
  return jsonb_build_object('reminded', v_reminded, 'stopped', v_stopped);
end $$;
revoke execute on function public.clock_upkeep() from public, anon, authenticated;
grant execute on function public.clock_upkeep() to service_role;

notify pgrst, 'reload schema';
