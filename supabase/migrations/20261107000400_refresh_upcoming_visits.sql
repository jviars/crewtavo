-- "Change the upcoming visits too" in one update. Saving a recurring job with it on gave each of its
-- waiting visits the job's title, crew and time with a request of its own, all at once (tasks.ts,
-- materializeJob): a daily job sent dozens. Now the server asks the database once.

-- zonedTimeToUtc (packages/core/src/time.ts) in SQL, so a visit gets the time the server would give
-- it: a time that happens twice as the clocks go back is the first one (Postgres alone takes the
-- second), and one that doesn't happen as they go forward moves on with them (as Postgres does).
create function private.zoned_time(p_date date, p_time time, p_tz text) returns timestamptz
language sql stable strict set search_path = '' as $$
  select case when f.first at time zone p_tz = p_date + p_time then f.first else (p_date + p_time) at time zone p_tz end
  from (
    -- The wall time read with the zone's offset a day before (the one before a change, if any).
    select (p_date + p_time) at time zone 'UTC'
           - (((p_date + p_time) at time zone 'UTC' - interval '1 day') at time zone p_tz - ((p_date + p_time) - interval '1 day')) as first
  ) f
$$;
revoke all on function private.zoned_time(date, time, text) from public;

/**
 * The server's (materializeJob, when someone saves a recurring job with "Change the upcoming visits
 * too"): the job's title, crew and time on each of its visits still waiting from the company's today
 * on. Done or started ones stay as they were, as do one-off visits on the job; one moved to another
 * day keeps that day, at the job's time there. An anytime job's have no times. Returns how many.
 */
create function public.refresh_upcoming_visits(p_job uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update public.visits v set
    title = j.title,
    crew_id = j.default_crew_id,
    starts_at = private.zoned_time(v.scheduled_on, j.visit_start_time, c.tz),
    ends_at = private.zoned_time(v.scheduled_on, j.visit_start_time, c.tz) + make_interval(mins => j.visit_duration_min),
    time_fixed = j.visit_start_time is not null and j.visit_time_fixed
  from public.jobs j
  cross join lateral (select coalesce(timezone, 'UTC') as tz from public.companies where id = j.company_id) c
  where j.id = p_job and v.job_id = j.id
    and v.status = 'scheduled' and v.recurrence_key is not null
    and v.scheduled_on >= private.company_today(j.company_id);
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.refresh_upcoming_visits(uuid) from public, anon, authenticated;
grant execute on function public.refresh_upcoming_visits(uuid) to service_role;

notify pgrst, 'reload schema';
