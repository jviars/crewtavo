-- Other calendars on the schedule, and visits on Google Calendar.
--
-- A company can show calendars from elsewhere on its schedule: any calendar's private ICS link
-- (Zoho Calendar, Outlook, iCloud, Google's secret address...) or calendars from a connected
-- Google account. The API reads them every 15 minutes and keeps their events here, so dispatchers
-- see them next to visits and "Find a time" can avoid them. A calendar can belong to one crew.
-- Rows are written only by the API with the service key: links are secrets (they're stored
-- encrypted), and every link is checked before the server fetches it.
--
-- With Google Calendar connected, visits can also go onto a Google calendar Crewtavo makes for the
-- company; changes are queued in the outbox like accounting pushes.

create table public.calendar_sources (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- 'ics': a link we fetch. 'google': a calendar in the connected Google account.
  kind text not null check (kind in ('ics', 'google')),
  -- The app it was added from on the Apps page.
  app text not null check (app in ('google_calendar', 'zoho_calendar', 'outlook_calendar', 'apple_calendar', 'ics_calendar')),
  name text not null check (length(trim(name)) between 1 and 80),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  -- Whose time it is: one crew's (its events sit in that crew's lane and block its time), or null
  -- for the whole team.
  crew_id uuid,
  -- Off: events are kept as "Busy" with no names, places or notes (someone's personal calendar).
  show_details boolean not null default true,
  -- On: busy events count as taken time in "Find a time".
  blocks_time boolean not null default true,
  enabled boolean not null default true,
  url_sealed text,   -- ics: the link, encrypted by the API
  host text,         -- ics: the link's host, shown instead of the secret link
  external_id text,  -- google: the calendar's ID
  event_count integer not null default 0,
  last_synced_at timestamptz,
  last_error text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, crew_id) references public.crews (company_id, id) on delete set null (crew_id),
  check (kind <> 'ics' or (url_sealed is not null and host is not null)),
  check (kind <> 'google' or external_id is not null)
);
create unique index calendar_sources_google_idx on public.calendar_sources (company_id, external_id) where kind = 'google';
create index calendar_sources_due_idx on public.calendar_sources (last_synced_at nulls first) where enabled;
select private.add_touch_triggers(array['calendar_sources']);

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  source_id uuid not null,
  key text not null,          -- the event's UID (plus the original start, for a repeat)
  title text not null,
  location text,
  description text,
  url text,
  all_day boolean not null default false,
  starts_at timestamptz,      -- timed events
  ends_at timestamptz,
  starts_on date not null,    -- local days it covers (inclusive), in the company's zone
  ends_on date not null,
  busy boolean not null default true,
  synced_at timestamptz not null default now(),
  unique (source_id, key),
  foreign key (company_id, source_id) references public.calendar_sources (company_id, id) on delete cascade,
  check (ends_on >= starts_on),
  check (all_day or (starts_at is not null and ends_at is not null and ends_at >= starts_at))
);
create index calendar_events_days_idx on public.calendar_events (company_id, starts_on, ends_on);

-- People who see the whole schedule see other calendars on it. Field crew see only their visits.
alter table public.calendar_sources enable row level security;
create policy calendar_sources_read on public.calendar_sources for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}'));
revoke all on public.calendar_sources from anon, authenticated;
grant select (id, company_id, kind, app, name, color, crew_id, show_details, blocks_time, enabled, host, event_count,
  last_synced_at, last_error, created_at, updated_at) on public.calendar_sources to authenticated;

alter table public.calendar_events enable row level security;
create policy calendar_events_read on public.calendar_events for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}'));
revoke all on public.calendar_events from anon, authenticated;
grant select on public.calendar_events to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Visits -> Google Calendar
-- ---------------------------------------------------------------------------------------------

comment on column public.outbox.topic is '''accounting.invoice'' | ''accounting.payment'' | ''calendar.visit''';

-- Queue a visit for Google Calendar when something people would see there changes, if the company
-- puts visits on Google Calendar. One waiting row per visit is enough: it pushes the latest.
create function private.enqueue_calendar_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := coalesce(new.company_id, old.company_id);
  v_visit uuid := coalesce(new.id, old.id);
begin
  if tg_op = 'UPDATE' and (new.title, new.kind, new.scheduled_on, new.starts_at, new.ends_at, new.status, new.crew_id, new.notes, new.property_id, new.job_id)
    is not distinct from (old.title, old.kind, old.scheduled_on, old.starts_at, old.ends_at, old.status, old.crew_id, old.notes, old.property_id, old.job_id) then
    return null;
  end if;
  -- A company being deleted takes its visits with it; nothing to tell Google.
  if tg_op = 'DELETE' and not exists (select 1 from public.companies where id = v_company) then
    return null;
  end if;
  if not exists (
    select 1 from public.integrations
    where company_id = v_company and provider = 'google_calendar' and status = 'connected' and settings ? 'push_calendar_id'
  ) then
    return null;
  end if;
  if exists (
    select 1 from public.outbox
    where company_id = v_company and topic = 'calendar.visit' and payload ->> 'visit_id' = v_visit::text
      and done_at is null and dead_at is null and (locked_until is null or locked_until < now())
  ) then
    return null;
  end if;
  insert into public.outbox (company_id, topic, payload) values (v_company, 'calendar.visit', jsonb_build_object('visit_id', v_visit));
  return null;
end $$;
create trigger enqueue_calendar_push after insert or update or delete on public.visits
  for each row execute function private.enqueue_calendar_push();
