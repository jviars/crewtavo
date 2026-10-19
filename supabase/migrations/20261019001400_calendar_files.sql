-- Calendars from a file. Someone uploads a calendar export (Google Calendar's Import & export,
-- Apple Calendar, Outlook...) and its events show on the schedule like a linked calendar's. A file
-- is never read again: uploading it again replaces its events. The file itself isn't kept, only
-- its events (as Busy when details are off), so there's no link and nothing to keep secret.

alter table public.calendar_sources drop constraint calendar_sources_kind_check;
alter table public.calendar_sources add constraint calendar_sources_kind_check check (kind in ('ics', 'google', 'file'));
comment on column public.calendar_sources.kind is
  '''ics'': a link we fetch. ''google'': a calendar in the connected Google account. ''file'': an uploaded file, kept until it''s uploaded again.';
