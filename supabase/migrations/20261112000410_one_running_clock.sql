-- One running clock per person. Starting a clock stops the one the person was on, but the app did
-- that itself, by reading their running clocks and then writing (apps/web/src/features/field/
-- fieldData.ts, the crew lead's card, assistants' clock_in). Two phones, or a phone sending what it
-- queued while offline next to a tap made since, could each read "nothing running" and both start
-- one: two running clocks, and hours counted twice once both were stopped.
--
-- Now the database keeps it to one, and without turning a clock-in away: a phone sending queued
-- taps drops one that's refused, and the person's time with it.
--
--   * A clock that starts while an earlier one is still running stops the earlier one at the new
--     clock's start, as the app means to.
--   * A clock that arrives late, with a start before the one now running (a queued tap sent after a
--     newer one), is saved as ending when the running one began.
--   * Two starts for the same person are taken one at a time, so each sees the other.
--   * A unique index holds the line underneath: one row per person and company with no end.
--
-- Existing rows first. Someone with two or more running clocks keeps the newest one running. Each
-- earlier one ends when their next clock began, which is where the app would have ended it had it
-- seen it, so the time between is all still counted, once. If the next one began more than 16 hours
-- later (the longest one entry can be), the earlier clock was forgotten rather than doubled: it
-- ends 16 hours in, the most it could have been stopped at, so no hours are dropped. Every clock
-- ended here is marked as stopped for them (auto_stopped_at), so Timesheets shows "check the end
-- time" on it until the office does, before approving. Nothing is deleted, and clocks that were
-- already stopped aren't touched (two that overlap stay as they are, for the office to settle).

-- The repair is a function so the tests run the very same statement (one_running_clock_test.sql).
-- It gives how many clocks it stopped.
create function private.stop_doubled_clocks() returns integer
language sql security definer set search_path = '' as $$
  with running as (
    select id, started_at,
           lead(started_at) over (partition by company_id, user_id order by started_at, created_at, id) as next_start
    from public.time_entries
    where ended_at is null
  ), stopped as (
    update public.time_entries t
    -- At least a second long: two that started at the same instant can't end the moment they began.
    set ended_at = greatest(least(r.next_start, t.started_at + interval '16 hours'), t.started_at + interval '1 second'),
        auto_stopped_at = now()
    from running r
    where r.id = t.id and r.next_start is not null
    returning t.id
  )
  select count(*)::integer from stopped
$$;
revoke all on function private.stop_doubled_clocks() from public;

-- No clock starts between the repair and the index.
do $$ begin lock table public.time_entries in share row exclusive mode; end $$;
select private.stop_doubled_clocks();

create unique index time_entries_one_running on public.time_entries (company_id, user_id) where ended_at is null;

create function private.one_running_clock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_next timestamptz;
begin
  if new.ended_at is not null then return new; end if;
  -- Only as a clock starts (or a stopped one is set running again, or moved to someone else).
  if tg_op = 'UPDATE' and old.ended_at is null and new.user_id = old.user_id and new.company_id = old.company_id then return new; end if;
  -- One start at a time for a person, so two at once see each other.
  perform pg_advisory_xact_lock(hashtextextended('clock:' || new.company_id::text || ':' || new.user_id::text, 0));
  select min(t.started_at) into v_next from public.time_entries t
  where t.company_id = new.company_id and t.user_id = new.user_id and t.ended_at is null and t.id <> new.id and t.started_at >= new.started_at;
  if v_next is not null then
    -- This one arrived late: the clock running now started after it, so this one ended there.
    new.ended_at := greatest(v_next, new.started_at + interval '1 second');
    return new;
  end if;
  update public.time_entries t set ended_at = new.started_at
  where t.company_id = new.company_id and t.user_id = new.user_id and t.ended_at is null and t.id <> new.id;
  return new;
end $$;
-- Named to run after place_guard, which reads a new clock as running, the way it was sent.
create trigger running_clock before insert or update on public.time_entries
  for each row execute function private.one_running_clock();

notify pgrst, 'reload schema';
