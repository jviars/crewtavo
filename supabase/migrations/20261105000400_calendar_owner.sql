-- A calendar on the schedule can be one person's: their own Google, Outlook or iCloud calendar,
-- added on the Apps page. When the schedule shows People, its events sit on that person's row
-- instead of "Nobody assigned", and its busy time marks their visits double-booked. It's set by
-- the API like the rest of a calendar; people who see the whole schedule can read it.

alter table public.calendar_sources add column user_id uuid;
-- Someone on this company's team; if they're removed, the calendar stays, as nobody's in particular.
alter table public.calendar_sources add constraint calendar_sources_user_fk
  foreign key (company_id, user_id) references public.memberships (company_id, user_id) on delete set null (user_id);
comment on column public.calendar_sources.user_id is
  'Whose own calendar it is (one person on the team), or null for a crew''s or the whole team''s (crew_id).';

grant select (user_id) on public.calendar_sources to authenticated;
