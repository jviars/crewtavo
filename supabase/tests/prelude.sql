-- Minimal stand-ins for the Supabase pieces our migrations use, so the schema can be tested in a
-- plain Postgres container (scripts/test-db.sh). Never run this against a Supabase project.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema extensions;
create schema auth;
create schema storage;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}',
  raw_app_meta_data jsonb not null default '{}'
);

-- A signed-in device: its refresh tokens go with it (the real tables have more columns).
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade);
create table auth.refresh_tokens (id bigserial primary key, session_id uuid references auth.sessions (id) on delete cascade, user_id text, token text);

-- Same contract as Supabase's auth.uid(): the "sub" claim of the request's JWT.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Same contract as Supabase's auth.role(): the "role" claim of the request's JWT.
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;
grant execute on function auth.role() to anon, authenticated, service_role;

create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  metadata jsonb -- Storage fills it in once the file is stored: mimetype, size and so on
);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;

create publication supabase_realtime;
