-- Notifications that reach people who aren't looking at the app.
--
--   1. Schedule changes notify the people on the visit: added to it, taken off it, moved, or
--      cancelled. Changes made within a few minutes fold into one notification per person (a
--      rain-day shift is one message, not ten), and nobody is told about a change they made.
--   2. notification_prefs: each person picks, per kind of notification, whether it also comes by
--      email, text or a push to their phone. Defaults: schedule changes by email and push.
--   3. push_subscriptions: phones and browsers that accept push notifications (Web Push).
--   4. The API's "notify" task delivers each notification once (delivered_at), shortly after it's
--      created, by the channels the person chose. Anything already read in the app is skipped.

-- ---------------------------------------------------------------------------------------------
-- Delivery bookkeeping on notifications
-- ---------------------------------------------------------------------------------------------

alter table public.notifications add column delivered_at timestamptz;
-- Everything that exists now has been seen in the app already; don't email it.
update public.notifications set delivered_at = coalesce(read_at, created_at);
create index notifications_undelivered_idx on public.notifications (created_at) where delivered_at is null;

-- Claim notifications to deliver (oldest first). Each is claimed once, even with several servers.
create function public.claim_notifications(p_min_age_seconds integer default 45, p_limit integer default 200)
returns setof public.notifications
language sql security definer set search_path = '' as $$
  update public.notifications n set delivered_at = now()
  where n.id in (
    select id from public.notifications
    where delivered_at is null and created_at < now() - make_interval(secs => p_min_age_seconds)
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning n.*
$$;
revoke execute on function public.claim_notifications(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_notifications(integer, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------------------------

-- Kinds: schedule (my visits), client (messages from clients), equipment, time (clock reminders),
-- alerts (everything automations send).
create table public.notification_prefs (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text[] not null default '{schedule}',
  sms text[] not null default '{}',
  push text[] not null default '{schedule,client,equipment,time,alerts}',
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id),
  check (email <@ array['schedule','client','equipment','time','alerts']
     and sms <@ array['schedule','client','equipment','time','alerts']
     and push <@ array['schedule','client','equipment','time','alerts'])
);
select private.add_touch_triggers(array['notification_prefs']);
alter table public.notification_prefs enable row level security;
create policy notification_prefs_own on public.notification_prefs for all to authenticated
  using (user_id = (select auth.uid()) and private.is_member(company_id))
  with check (user_id = (select auth.uid()) and private.is_member(company_id));

-- ---------------------------------------------------------------------------------------------
-- Push subscriptions (one per browser or phone)
-- ---------------------------------------------------------------------------------------------

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  device text check (length(device) <= 200),
  created_at timestamptz not null default now(),
  last_sent_at timestamptz
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
create policy push_subscriptions_own on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Server keys (the Web Push signing key), encrypted by the API. Only the service key reads them.
create table public.app_secrets (
  name text primary key,
  ciphertext text not null,
  created_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Schedule changes -> notifications for the people on the visit
-- ---------------------------------------------------------------------------------------------

-- "Mon Oct 19, 7:00 AM", or "Mon Oct 19" for an anytime visit.
create function private.visit_when(p_starts timestamptz, p_day date, p_tz text) returns text
language sql stable set search_path = '' as $$
  select case
    when p_starts is not null then to_char(p_starts at time zone coalesce(p_tz, 'UTC'), 'Dy Mon FMDD, FMHH12:MI AM')
    when p_day is not null then to_char(p_day, 'Dy Mon FMDD')
    else 'no date yet'
  end
$$;

-- Add one line to the person's schedule notification. A change within 10 minutes of an unread,
-- not-yet-delivered one joins it (the old row is replaced, so the app's live feed sees one new
-- notification with every change in it).
create function private.notify_schedule(p_company uuid, p_user uuid, p_visit uuid, p_line text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev public.notifications; v_lines text[];
begin
  if p_user is null or p_user = (select auth.uid()) then
    return; -- you made the change yourself
  end if;
  -- Gone from the team, or the whole company is being deleted.
  if not exists (select 1 from public.memberships m join public.companies c on c.id = m.company_id where m.company_id = p_company and m.user_id = p_user and m.active) then
    return;
  end if;
  select * into v_prev from public.notifications
  where company_id = p_company and user_id = p_user and kind = 'schedule'
    and read_at is null and delivered_at is null and created_at > now() - interval '10 minutes'
  order by created_at desc limit 1
  for update;
  if found then
    v_lines := string_to_array(v_prev.body, E'\n');
    if p_line = any (v_lines) then
      return;
    end if;
    v_lines := (v_lines || p_line)[greatest(1, array_length(v_lines, 1) - 18):];
    delete from public.notifications where id = v_prev.id;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    values (p_company, p_user, 'schedule', format('%s changes to your schedule', array_length(v_lines, 1)), array_to_string(v_lines, E'\n'), '/field');
  else
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    values (p_company, p_user, 'schedule', left(p_line, 300), p_line, coalesce('/field/visits/' || p_visit, '/field'));
  end if;
end $$;

-- Only upcoming work: nobody needs to hear about last week's visits being tidied up.
create function private.visit_is_upcoming(v public.visits, p_tz text) returns boolean
language sql stable set search_path = '' as $$
  select v.status not in ('completed', 'cancelled')
    and coalesce((v.starts_at at time zone coalesce(p_tz, 'UTC'))::date, v.scheduled_on, (now() at time zone coalesce(p_tz, 'UTC'))::date)
        >= (now() at time zone coalesce(p_tz, 'UTC'))::date
$$;

create function private.assignee_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.visits; v_tz text;
begin
  select * into v from public.visits where id = coalesce(new.visit_id, old.visit_id);
  if not found then
    return null; -- the visit itself was deleted; visit_delete_notify told everyone
  end if;
  select timezone into v_tz from public.companies where id = v.company_id;
  if not private.visit_is_upcoming(v, v_tz) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.notify_schedule(v.company_id, new.user_id, v.id, format('You''re on %s: %s', v.title, private.visit_when(v.starts_at, v.scheduled_on, v_tz)));
  else
    perform private.notify_schedule(v.company_id, old.user_id, v.id, format('You''re off %s (%s)', v.title, private.visit_when(v.starts_at, v.scheduled_on, v_tz)));
  end if;
  return null;
end $$;
create trigger notify_people after insert or delete on public.visit_assignees
  for each row execute function private.assignee_notify();

create function private.visit_change_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_line text; r record;
begin
  select timezone into v_tz from public.companies where id = new.company_id;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if not private.visit_is_upcoming(old, v_tz) then return null; end if;
    v_line := format('%s on %s was cancelled', new.title, private.visit_when(old.starts_at, old.scheduled_on, v_tz));
  elsif (new.starts_at is distinct from old.starts_at or new.scheduled_on is distinct from old.scheduled_on)
        and (private.visit_is_upcoming(new, v_tz) or private.visit_is_upcoming(old, v_tz)) and new.status <> 'cancelled' then
    v_line := case
      when new.status = 'unscheduled' or (new.starts_at is null and new.scheduled_on is null)
        then format('%s is off the schedule for now (was %s)', new.title, private.visit_when(old.starts_at, old.scheduled_on, v_tz))
      when coalesce(new.scheduled_on, '-infinity') = coalesce(old.scheduled_on, '-infinity')
        then format('%s now starts %s', new.title, private.visit_when(new.starts_at, new.scheduled_on, v_tz))
      else format('%s moved to %s (was %s)', new.title, private.visit_when(new.starts_at, new.scheduled_on, v_tz), private.visit_when(old.starts_at, old.scheduled_on, v_tz))
    end;
  else
    return null;
  end if;
  for r in select user_id from public.visit_assignees where visit_id = new.id loop
    perform private.notify_schedule(new.company_id, r.user_id, new.id, v_line);
  end loop;
  return null;
end $$;
create trigger notify_people_on_change after update of starts_at, scheduled_on, status on public.visits
  for each row execute function private.visit_change_notify();

create function private.visit_delete_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; r record;
begin
  select timezone into v_tz from public.companies where id = old.company_id;
  if not found or not private.visit_is_upcoming(old, v_tz) then
    return old; -- the company is being deleted, or it's old work
  end if;
  -- No link to the visit: it's about to be gone.
  for r in select user_id from public.visit_assignees where visit_id = old.id loop
    perform private.notify_schedule(old.company_id, r.user_id, null,
      format('%s on %s was cancelled', old.title, private.visit_when(old.starts_at, old.scheduled_on, v_tz)));
  end loop;
  return old;
end $$;
create trigger notify_people_on_delete before delete on public.visits
  for each row execute function private.visit_delete_notify();

notify pgrst, 'reload schema';
