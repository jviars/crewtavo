-- Foundation: companies, people, roles, numbering and the helpers every other table uses.
--
-- Tenancy model: every business row carries company_id. Row-level security (RLS) lets a signed-in
-- user see a row only if they're an active member of that company, with role checks for writes.

create extension if not exists pg_trgm with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create type public.member_role as enum ('owner', 'admin', 'office', 'estimator', 'crew_lead', 'field_crew');

-- Tables created by later migrations get these grants automatically; RLS decides which rows.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public revoke all on tables from anon;

create function private.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Companies and people
-- ---------------------------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  trade_preset text not null default 'general',
  timezone text not null default 'America/New_York',
  currency text not null default 'USD',
  phone text,
  email text,
  website text,
  address jsonb not null default '{}',
  -- payment_terms_days, default_tax_rate, maps keys override, branding, working hours, etc.
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text not null default '',
  phone text,
  avatar_url text,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_email_idx on public.profiles (lower(email));

create table public.memberships (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'field_crew',
  labor_rate numeric(10, 2), -- cost per hour, for job costing
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- ---------------------------------------------------------------------------------------------
-- RLS helpers. security definer so policies can read memberships without recursing into its RLS.
-- ---------------------------------------------------------------------------------------------

create function private.is_member(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active
  )
$$;

create function private.has_role(p_company uuid, p_roles public.member_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active and m.role = any (p_roles)
  )
$$;

create function private.shares_company(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships mine
    join public.memberships theirs on theirs.company_id = mine.company_id
    where mine.user_id = (select auth.uid()) and mine.active and theirs.user_id = p_user
  )
$$;

revoke all on all functions in schema private from public;
grant execute on function private.is_member(uuid), private.has_role(uuid, public.member_role[]),
  private.shares_company(uuid) to authenticated, service_role;

-- Standard policies: any member reads (or only p_read roles), p_write roles insert/update/delete.
create function private.apply_policies(p_table text, p_write public.member_role[], p_read public.member_role[] default null)
returns void language plpgsql as $$
declare
  read_check text := case
    when p_read is null then 'private.is_member(company_id)'
    else format('private.has_role(company_id, %L::public.member_role[])', p_read)
  end;
  write_check text := format('private.has_role(company_id, %L::public.member_role[])', p_write);
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (%s)', p_table || '_read', p_table, read_check);
  execute format('create policy %I on public.%I for insert to authenticated with check (%s)', p_table || '_insert', p_table, write_check);
  execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', p_table || '_update', p_table, write_check, write_check);
  execute format('create policy %I on public.%I for delete to authenticated using (%s)', p_table || '_delete', p_table, write_check);
end $$;

create function private.add_touch_triggers(p_tables text[]) returns void
language plpgsql as $$
declare t text;
begin
  foreach t in array p_tables loop
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Policies for tenancy tables
-- ---------------------------------------------------------------------------------------------

alter table public.companies enable row level security;
create policy companies_read on public.companies for select to authenticated using (private.is_member(id));
create policy companies_update on public.companies for update to authenticated
  using (private.has_role(id, '{owner,admin}')) with check (private.has_role(id, '{owner,admin}'));
-- Companies are created through public.create_company(), never by direct insert.

alter table public.profiles enable row level security;
create policy profiles_read on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or private.shares_company(user_id));
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter table public.memberships enable row level security;
create policy memberships_read on public.memberships for select to authenticated using (private.is_member(company_id));
-- Admins manage the team; only owners can create or edit owners.
create policy memberships_insert on public.memberships for insert to authenticated
  with check (private.has_role(company_id, '{owner,admin}') and (role <> 'owner' or private.has_role(company_id, '{owner}')));
create policy memberships_update on public.memberships for update to authenticated
  using (private.has_role(company_id, '{owner,admin}') and (role <> 'owner' or private.has_role(company_id, '{owner}')))
  with check (private.has_role(company_id, '{owner,admin}') and (role <> 'owner' or private.has_role(company_id, '{owner}')));
create policy memberships_delete on public.memberships for delete to authenticated
  using (private.has_role(company_id, '{owner,admin}') and (role <> 'owner' or private.has_role(company_id, '{owner}')));

-- A company always keeps at least one active owner.
create function private.keep_an_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Deleting the whole company cascades here after the company row is gone; allow that.
  if not exists (select 1 from public.companies where id = old.company_id) then
    return coalesce(new, old);
  end if;
  if old.role = 'owner' and old.active and (tg_op = 'DELETE' or new.role <> 'owner' or not new.active) then
    if not exists (
      select 1 from public.memberships
      where company_id = old.company_id and role = 'owner' and active and user_id <> old.user_id
    ) then
      raise exception 'A company needs at least one owner' using errcode = '23514';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger keep_an_owner before update or delete on public.memberships
  for each row execute function private.keep_an_owner();

select private.add_touch_triggers(array['companies', 'profiles', 'memberships']);

-- New sign-ups get a profile.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (user_id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------------------------
-- Document numbers (quotes, jobs, invoices, requests), per company, gap-free under concurrency.
-- ---------------------------------------------------------------------------------------------

create table public.number_sequences (
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null,
  next_value bigint not null default 1,
  primary key (company_id, kind)
);
alter table public.number_sequences enable row level security; -- no policies: only the function below

create function private.next_number(p_company uuid, p_kind text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  insert into public.number_sequences as s (company_id, kind, next_value)
  values (p_company, p_kind, 2)
  on conflict (company_id, kind) do update set next_value = s.next_value + 1
  returning s.next_value - 1 into v;
  return v;
end $$;

create function private.assign_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := private.next_number(new.company_id, tg_table_name);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Onboarding: create a company and make the caller its owner.
-- ---------------------------------------------------------------------------------------------

create function public.create_company(p_name text, p_trade_preset text default 'general', p_timezone text default 'America/New_York')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_base text := trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'));
  v_slug text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if length(v_base) < 2 then
    v_base := 'company';
  end if;
  v_slug := left(v_base, 50);
  while exists (select 1 from public.companies where slug = v_slug) loop
    v_slug := left(v_base, 50) || '-' || substr(md5(random()::text), 1, 5);
  end loop;

  insert into public.companies (name, slug, trade_preset, timezone)
  values (p_name, v_slug, coalesce(p_trade_preset, 'general'), coalesce(p_timezone, 'America/New_York'))
  returning id into v_id;

  insert into public.memberships (company_id, user_id, role) values (v_id, v_user, 'owner');
  return v_id;
end $$;

revoke execute on function public.create_company(text, text, text) from public, anon;
grant execute on function public.create_company(text, text, text) to authenticated;
