-- Clients ask to move or cancel a visit from the Client Hub, and the office approves in one click.
--
-- A request is the visit, what's asked (reschedule or cancel), the time asked for (a start and end,
-- or a whole day for an anytime visit) or the client's own words, their reason, and the office's
-- answer. Nothing on the schedule changes until the office approves: the API then moves or cancels
-- the visit the way the schedule does (services/visitChanges.ts), and emails the client.
--
--   * The Hub's route writes requests as the server, after checking the link is the visit's client's.
--     One waits per visit; a new one takes the old one's place.
--   * Whoever may move the visit (private.schedules_crew: the office, a crew lead for their crew's)
--     reads and answers them. Answering sets who and when; nothing else can be changed.
--   * Asking tells the office (a notification) and starts automations: visit.reschedule_requested
--     and visit.cancel_requested. The client's words stay off the activity feed, which crews read.
--   * visit_busy_times: when the people on a visit are busy, as times only, for the Hub's open slots.

create table public.visit_change_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  visit_id uuid not null,
  client_id uuid not null,
  kind text not null check (kind in ('reschedule', 'cancel')),
  -- The time asked for: a start and end, or a whole day (starts_at null). None: the client wrote
  -- what suits them (message).
  starts_at timestamptz,
  ends_at timestamptz,
  scheduled_on date,
  message text check (length(message) <= 2000),
  reason text check (length(reason) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  -- The office's note to the client, when it declines.
  note text check (length(note) <= 2000),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade,
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  check ((starts_at is null) = (ends_at is null) and (ends_at is null or ends_at > starts_at)),
  check (starts_at is null or scheduled_on is not null),
  -- A reschedule has a time or the client's words; a cancel has no time.
  check (case kind when 'reschedule' then scheduled_on is not null or message is not null else scheduled_on is null and starts_at is null end)
);
create unique index visit_change_requests_pending_idx on public.visit_change_requests (visit_id) where status = 'pending';
create index visit_change_requests_company_idx on public.visit_change_requests (company_id, created_at desc) where status = 'pending';

alter table public.visit_change_requests enable row level security;
create policy visit_change_requests_read on public.visit_change_requests for select to authenticated
  using (private.schedules_crew(company_id, private.visit_crew(visit_id)));
create policy visit_change_requests_answer on public.visit_change_requests for update to authenticated
  using (status = 'pending' and private.schedules_crew(company_id, private.visit_crew(visit_id)))
  with check (status in ('approved', 'declined') and private.schedules_crew(company_id, private.visit_crew(visit_id)));
-- Only the server writes requests; the office answers them (status and note, nothing else).
revoke all on public.visit_change_requests from anon, authenticated;
grant select on public.visit_change_requests to authenticated;
grant update (status, note) on public.visit_change_requests to authenticated;

-- Who answered, and when.
create function private.visit_change_answered() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    new.decided_at := now();
    new.decided_by := (select auth.uid());
  end if;
  return new;
end $$;
create trigger answered before update on public.visit_change_requests
  for each row execute function private.visit_change_answered();

-- The people who schedule the whole team: owners, admins and office staff with the schedule area.
create function private.schedule_office(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id
  from public.memberships m
  left join public.company_roles cr on cr.id = m.role_id
  where m.company_id = p_company and m.active and m.role in ('owner', 'admin', 'office')
    and 'schedule' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
$$;

-- A request in: the event for automations (only which request, so crews reading the feed don't get
-- the client's words), and a notification to the office that opens the visit.
create function private.visit_change_requested() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v public.visits;
  v_tz text;
  v_title text;
  v_body text;
begin
  select * into v from public.visits where id = new.visit_id;
  select timezone into v_tz from public.companies where id = new.company_id;
  v_title := format('%s asked to %s %s', private.client_name(new.client_id), case new.kind when 'cancel' then 'cancel' else 'move' end, v.title);
  v_body := 'Booked ' || private.visit_when(v.starts_at, v.scheduled_on, v_tz) || '. ' || case
    when new.kind = 'cancel' then coalesce('Reason: ' || new.reason, 'No reason given.')
    when new.scheduled_on is not null then 'Asked for ' || private.visit_when(new.starts_at, new.scheduled_on, v_tz) || '.'
    else '"' || left(new.message, 200) || '"'
  end;
  perform private.emit(new.company_id, 'visit.' || new.kind || '_requested', 'visit', new.visit_id, v_title, jsonb_build_object('request_id', new.id));
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, u, 'client', left(v_title, 300), v_body, '/schedule?date=' || coalesce(v.scheduled_on::text, '') || '&visit=' || v.id
  from private.schedule_office(new.company_id) u;
  return null;
end $$;
create trigger requested after insert on public.visit_change_requests
  for each row execute function private.visit_change_requested();

revoke all on function private.visit_change_answered(), private.schedule_office(uuid), private.visit_change_requested() from public;

-- When the people on a visit are busy between two times, for the Client Hub's open slots: the other
-- visits of its crew and of the people on it (not cancelled ones), and busy events on calendars that
-- block time (the whole team's, its crew's and those people's). Times only, never whose or what.
create function public.visit_busy_times(p_company uuid, p_visit uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with v as (select id, crew_id from public.visits where company_id = p_company and id = p_visit),
  people as (select a.user_id from public.visit_assignees a join v on a.visit_id = v.id),
  tz as (select coalesce(timezone, 'UTC') as name from public.companies where id = p_company)
  select o.starts_at, coalesce(o.ends_at, o.starts_at)
  from public.visits o, v
  where o.company_id = p_company and o.id <> v.id and o.status <> 'cancelled' and o.starts_at is not null
    and o.starts_at < p_to and coalesce(o.ends_at, o.starts_at) > p_from
    and ((v.crew_id is not null and o.crew_id = v.crew_id)
         or exists (select 1 from public.visit_assignees a where a.visit_id = o.id and a.user_id in (select user_id from people)))
  union all
  select b.starts_at, b.ends_at
  from public.calendar_events e
  join public.calendar_sources s on s.id = e.source_id
  cross join v cross join tz
  -- An all-day event takes its whole days, where the company is.
  cross join lateral (select case when e.all_day or e.starts_at is null then e.starts_on::timestamp at time zone tz.name else e.starts_at end as starts_at,
                             case when e.all_day or e.ends_at is null then (e.ends_on + 1)::timestamp at time zone tz.name else e.ends_at end as ends_at) b
  where e.company_id = p_company and e.busy and s.enabled and s.blocks_time
    and b.starts_at < p_to and b.ends_at > p_from
    and ((s.crew_id is null and s.user_id is null) or s.crew_id = v.crew_id or s.user_id in (select user_id from people))
$$;
revoke execute on function public.visit_busy_times(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.visit_busy_times(uuid, uuid, timestamptz, timestamptz) to service_role;

select private.fold_member_checks();
