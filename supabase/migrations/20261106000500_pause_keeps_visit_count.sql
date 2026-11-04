-- Pausing doesn't shorten "ends after 12 visits". A recurring job whose rule has a COUNT counted the
-- dates that fell while it was paused (20261105000500_job_pause.sql) toward it, so it came back with
-- fewer visits left, and resumed after the last of them, none. Now the stretches it was paused are
-- kept (jobs.pauses), and the dates in them aren't visits and don't count (recurrence.ts
-- occurrenceDates, as tasks.ts materializeJob uses it and keeps ends_on at the last visit's day).
--
-- A stretch is in the company's days: from the day it was paused, to the day it resumed (that day's
-- visits are made again, so it isn't in it). A visit that stayed on the day it was paused (done that
-- morning, or with work logged, so pausing didn't take it off) is a visit, so that day isn't in it.

alter table public.jobs add column pauses jsonb not null default '[]';
comment on column public.jobs.pauses is 'The stretches a recurring job was paused before, [{from, until}] in the company''s days (until is the day it resumed, not in it): "ends after 12 visits" doesn''t count their dates. Set by the server.';

-- As in 20261105000500_job_pause.sql, plus pauses, which only the server writes: a resume adds the
-- stretch it ends. Security definer to see the job's visits whoever resumes it.
create or replace function private.job_pause() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_from date;
  v_until date;
begin
  if new.kind <> 'recurring' then new.paused_at := null; end if;
  if new.paused_at is null then
    new.resume_on := null;
  elsif tg_op = 'INSERT' or old.paused_at is null then
    new.paused_at := now();
  else
    new.paused_at := old.paused_at;
  end if;
  new.resumed_at := case
    when tg_op = 'INSERT' then null
    when old.paused_at is not null and new.paused_at is null then now()
    else old.resumed_at end;
  new.pauses := case when tg_op = 'INSERT' then '[]'::jsonb else old.pauses end;
  if tg_op = 'UPDATE' and old.paused_at is not null and new.paused_at is null then
    select coalesce(c.timezone, 'UTC') into v_tz from public.companies c where c.id = new.company_id;
    v_from := (old.paused_at at time zone coalesce(v_tz, 'UTC'))::date;
    v_until := (now() at time zone coalesce(v_tz, 'UTC'))::date;
    if exists (select 1 from public.visits v where v.job_id = new.id and v.recurrence_key = v_from::text) then
      v_from := v_from + 1;
    end if;
    -- Paused and resumed the same day: no date went without its visit.
    if v_from < v_until then
      new.pauses := new.pauses || jsonb_build_array(jsonb_build_object('from', v_from, 'until', v_until));
    end if;
  end if;
  return new;
end $$;
revoke all on function private.job_pause() from public;

notify pgrst, 'reload schema';
