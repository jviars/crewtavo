-- AI assistants (Claude, ChatGPT and other MCP clients) connect through Supabase Auth's OAuth
-- server, and the access token an assistant gets is the person's own. So far that let it do
-- anything the person could: every MCP tool, and the Data API and Storage directly, with the
-- token. Now each connection only reads until the person who made it turns on "Allow changes" for
-- it (Settings → Apps → AI assistants). Connections made before this have no row here, so they
-- only read too.
--
-- An assistant's token says which connection it is: Supabase Auth adds the OAuth client's id as
-- the client_id claim, which an ordinary sign-in doesn't have. The server checks the switch for
-- the MCP tools, its own API and the gateway in an instance (apps/api/src/lib/assistants.ts); the
-- database checks it again before every Data API request (hooks.before_request, PostgREST's
-- pre-request) and for files (storage.objects), so it holds without the gateway too.

create table public.assistant_connections (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The OAuth client the person approved (auth.oauth_clients.id, the token's client_id claim).
  client_id text not null check (char_length(client_id) between 1 and 200),
  allow_changes boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
select private.add_touch_triggers(array['assistant_connections']);
alter table public.assistant_connections enable row level security;

/** The OAuth client the request's token was issued to, or null for an ordinary sign-in. */
create or replace function private.assistant_client() returns text
language sql stable set search_path = '' as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claim.client_id', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'client_id'
  ), '')
$$;

/** True unless the request comes from an assistant that hasn't been allowed to change things. */
create or replace function private.assistant_may_change() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.assistant_client() is null or exists (
    select 1 from public.assistant_connections a
    where a.user_id = (select auth.uid()) and a.client_id = private.assistant_client() and a.allow_changes
  )
$$;

revoke all on function private.assistant_client(), private.assistant_may_change() from public;
grant execute on function private.assistant_client(), private.assistant_may_change() to authenticated, service_role;

-- People see and set their own connections. An assistant sees only its own, and can't turn its
-- own switch on (or anyone else's).
create policy assistant_connections_read on public.assistant_connections for select to authenticated
  using (user_id = (select auth.uid()) and coalesce(client_id = (select private.assistant_client()), true));
create policy assistant_connections_insert on public.assistant_connections for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.assistant_client()) is null);
create policy assistant_connections_update on public.assistant_connections for update to authenticated
  using (user_id = (select auth.uid()) and (select private.assistant_client()) is null)
  with check (user_id = (select auth.uid()) and (select private.assistant_client()) is null);
create policy assistant_connections_delete on public.assistant_connections for delete to authenticated
  using (user_id = (select auth.uid()) and (select private.assistant_client()) is null);
revoke all on public.assistant_connections from anon;

-- ---------------------------------------------------------------------------------------------
-- The Data API: PostgREST calls hooks.before_request() at the start of every request, as whoever
-- is asking (signed in or not), so it lives in a schema of its own that everyone can use (private
-- isn't open to visitors). For an assistant that only reads, nothing in the request can change
-- anything: writing to a table is refused with a message saying how to allow it, and a function
-- still answers, in a transaction that can't write.
-- ---------------------------------------------------------------------------------------------

create schema if not exists hooks;
grant usage on schema hooks to anon, authenticated, service_role;

create or replace function hooks.before_request() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_may_change() then return; end if;
  perform set_config('transaction_read_only', 'on', true);
  if current_setting('request.method', true) in ('GET', 'HEAD') or current_setting('request.path', true) like '/rpc/%' then
    return;
  end if;
  raise exception using errcode = 'PT403',
    message = 'This assistant can only read. To let it make changes, turn on "Allow changes" for it in Crewtavo, under Settings → Apps → AI assistants.';
end $$;

revoke all on function hooks.before_request() from public;
grant execute on function hooks.before_request() to anon, authenticated, service_role;

-- Supabase's Data API (and an instance's) runs as the authenticator role and reads its settings
-- from it. Plain Postgres (the database tests) has no such role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    alter role authenticator set pgrst.db_pre_request = 'hooks.before_request';
  end if;
exception when insufficient_privilege then
  raise warning 'Couldn''t point the Data API at hooks.before_request (%). Assistants are still held to reading by the Crewtavo server, but not by the database. Run: alter role authenticator set pgrst.db_pre_request = ''hooks.before_request'';', sqlerrm;
end $$;
notify pgrst, 'reload config';

-- ---------------------------------------------------------------------------------------------
-- Files: Storage writes through these policies with the person's token, so an assistant that
-- only reads can't upload, replace or delete one.
-- ---------------------------------------------------------------------------------------------

create policy files_assistant_insert on storage.objects as restrictive for insert to authenticated
  with check ((select private.assistant_may_change()));
create policy files_assistant_update on storage.objects as restrictive for update to authenticated
  using ((select private.assistant_may_change())) with check ((select private.assistant_may_change()));
create policy files_assistant_delete on storage.objects as restrictive for delete to authenticated
  using ((select private.assistant_may_change()));

notify pgrst, 'reload schema';
