-- Personal calendar feeds: a private link (webcal/ICS) each person adds to Google, Apple or Outlook
-- Calendar to see their visits. Only a hash of the link's token is kept for lookups; the token
-- itself is stored encrypted so the person can see their link again. Written only by the server.

create table public.calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null default 'mine' check (scope in ('mine', 'all')),
  token_hash text not null unique,
  token_sealed text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (company_id, user_id)
);
alter table public.calendar_feeds enable row level security;
create policy calendar_feeds_read on public.calendar_feeds for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.calendar_feeds from authenticated;
-- People can see that they have a feed, never its token.
revoke select on public.calendar_feeds from authenticated, anon;
grant select (id, company_id, user_id, scope, created_at, last_used_at) on public.calendar_feeds to authenticated;
