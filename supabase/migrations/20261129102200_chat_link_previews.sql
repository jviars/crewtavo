-- Link previews in team chat: what a public web page linked in a message says about itself (its
-- title, description, site name and a small picture), read by the server (apps/api/src/lib/
-- linkPreview.ts) and kept here for a week, a page with nothing to show for a day, so a busy
-- channel doesn't ask the same site again and again. Kept for each business on its own.
--
-- Only the server reads and writes it: a preview anyone could write would let someone dress a link
-- up as something it isn't. Who may see one is decided before it's read (the link has to be in a
-- message the person can read, GET /api/chat/preview).

create table public.chat_link_previews (
  company_id uuid not null references public.companies (id) on delete cascade,
  url text not null check (length(url) <= 2048),
  -- Nothing to show (not a page, an error, no title): asked again a day later.
  ok boolean not null,
  -- Where it ended up, after redirects.
  final_url text check (length(final_url) <= 2048),
  title text check (length(title) <= 200),
  description text check (length(description) <= 300),
  site_name text check (length(site_name) <= 80),
  -- A small JPEG, as a data: address (a few kilobytes).
  image text check (length(image) <= 200000 and image like 'data:image/jpeg;base64,%'),
  fetched_at timestamptz not null default now(),
  primary key (company_id, url)
);
create index chat_link_previews_fetched_idx on public.chat_link_previews (company_id, fetched_at);

comment on table public.chat_link_previews is 'Previews of public web pages linked in team chat, kept a week (a day for a page with nothing to show). Read and written by the server only.';

alter table public.chat_link_previews enable row level security;
revoke all on public.chat_link_previews from anon, authenticated;
