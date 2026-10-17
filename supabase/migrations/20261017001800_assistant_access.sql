-- What AI assistants (Claude, ChatGPT over MCP) did, for the owner and admins to review. Written
-- by the server only; arguments are summarized (ids and field names, never note text).
-- Whether assistants are allowed, and whether they may change anything, lives in
-- companies.settings.assistants: { "enabled": true, "read_only": false }.

create table public.assistant_calls (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  oauth_client text,
  tool text not null,
  ok boolean not null,
  detail text,
  created_at timestamptz not null default now()
);
create index assistant_calls_company_idx on public.assistant_calls (company_id, created_at desc);
alter table public.assistant_calls enable row level security;
create policy assistant_calls_read on public.assistant_calls for select to authenticated using (private.has_role(company_id, '{owner,admin}'));
revoke insert, update, delete on public.assistant_calls from authenticated, anon;
