-- Storage limits (Settings → Storage): how much room the company's stored files may take, and how
-- much each person's uploads may, so a Crewtavo doesn't fill its Railway volume or run up its bucket
-- bill. The server's storage gateway (apps/api/src/lib/storageLimits.ts) asks storage_snapshot before
-- a signed-in person's upload is stored, and refuses one that would go over. Photos from visits and
-- quotes, receipts, sub paperwork and the like are never refused, so crews can always finish a job;
-- they still count.
--
--   settings.storage     the company's limit. limit_bytes: left out, the default; null, no limit; a
--                        number, a limit of the company's own. Owners and admins who manage settings
--                        choose with storage_set_limit, which also notes when and by whom (changed_at,
--                        changed_by). default_bytes and default_basis: the default and why ("90% of
--                        your 50 GB volume", "Railway Hobby bucket"), from the server when it reads
--                        Railway (storage_set_default); null when it can't tell, and then there's no
--                        default limit. warned: when the server warned owners and admins at 80% and
--                        95% (apps/api/src/tasks.ts). Nobody signed in changes any of it except
--                        through storage_set_limit, and the server can't change the limit itself
--                        (storage_settings_guard): a page saving other settings keeps it as it is.
--   storage_allowances   limits for one person, or for everyone with a role (an access level other
--                        than Owner, or one of the company's custom roles), set by owners alone
--                        (storage_set_allowance). A person's own limit wins over their role's, and a
--                        custom role's over its access level's. Owners are never limited, and subs
--                        have nothing to limit. These refuse only Drive and plan files and guides'
--                        covers (packages/core/src/storage.ts says which folders).
--   storage_overview     what's used, for Settings → Storage and Drive: the company's total (with the
--                        Trash's share), its limit, and the person's own use and limit; owners and
--                        admins also see each person's, each area's (plans, visit photos...) and the
--                        limits set for roles.
--   storage_snapshot     the gateway's quick check, for the server alone.
--
-- What's used comes from the stored files themselves (storage.objects, the files bucket, under the
-- company's folder), so nothing has to be kept up to date. The company's total counts the Trash,
-- which takes up room until it's purged; a person's counts only what they uploaded that isn't in the
-- Trash, so moving files there frees their allowance. Who uploaded a file is who stored it, or for a
-- plan file the server stored (a Google Drive import) whoever added it.
--
-- storage.objects belongs to the Storage service (supabase_storage_admin), so no index of ours can go
-- on it. Its own index on (bucket_id, name collate "C") finds one company's files, which is why the
-- lookups below compare names in the "C" collation.

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- Whether the functions below are changing settings.storage in this transaction. They set
-- crewtavo.storage for the moment they do (nothing signed in can set it otherwise).
create function private.storage_setting() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('crewtavo.storage', true), '') = 'on'
$$;

-- settings.storage, always an object.
create function private.storage_of(p_settings jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_settings -> 'storage') = 'object' then p_settings -> 'storage' else '{}'::jsonb end
$$;

-- A size kept in settings, or null when it isn't a number.
create function private.storage_bytes(p_value jsonb) returns bigint
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_value) = 'number' then
    case when (p_value #>> '{}')::numeric > 0 then least((p_value #>> '{}')::numeric, 9223372036854775807)::bigint end
  end
$$;

-- The company's limit as chosen: 'default' (limit_bytes left out), 'none' (null) or 'custom'.
create function private.storage_limit_mode(p_storage jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when not coalesce(p_storage ? 'limit_bytes', false) then 'default'
    when private.storage_bytes(p_storage -> 'limit_bytes') is null then 'none'
    else 'custom' end
$$;

-- The company's limit in bytes: its own, the default, or null for none.
create function private.storage_company_limit(p_storage jsonb) returns bigint
language sql immutable set search_path = '' as $$
  select case private.storage_limit_mode(p_storage)
    when 'custom' then private.storage_bytes(p_storage -> 'limit_bytes')
    when 'default' then private.storage_bytes(p_storage -> 'default_bytes')
  end
$$;

-- How an access level reads (ROLE_LABELS in packages/core/src/roles.ts).
create function private.storage_level_label(p_level text) returns text
language sql immutable set search_path = '' as $$
  select case p_level
    when 'owner' then 'Owner' when 'admin' then 'Admin' when 'office' then 'Office' when 'estimator' then 'Estimator'
    when 'crew_lead' then 'Crew lead' when 'field_crew' then 'Field crew' when 'subcontractor' then 'Subcontractor'
  end
$$;

-- A stored file's size, from what Storage notes about it (0 until it has). Plain SQL with nothing to
-- look up, so the queries below take it in rather than calling it for each of many files.
create function private.storage_object_bytes(p_metadata jsonb) returns bigint
language sql immutable parallel safe as $$
  select case when jsonb_typeof(p_metadata -> 'size') = 'number' then (p_metadata -> 'size')::bigint else 0 end
$$;

-- ---------------------------------------------------------------------------------------------
-- The company's limit, in its settings
-- ---------------------------------------------------------------------------------------------

-- Nobody signed in changes settings.storage but through storage_set_limit: a page that saves the
-- company's other settings with what it read a while ago keeps it as it is. The server's own writes
-- (the default, the warnings) go through, but not to the limit itself.
create function private.storage_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_kept jsonb;
begin
  if private.storage_setting() or new.settings -> 'storage' is not distinct from old.settings -> 'storage' then
    return new;
  end if;
  if (select auth.uid()) is not null then
    v_kept := old.settings -> 'storage';
  else
    v_kept := (private.storage_of(new.settings) - array['limit_bytes', 'changed_at', 'changed_by'])
      || coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(private.storage_of(old.settings)) e
                   where e.key in ('limit_bytes', 'changed_at', 'changed_by')), '{}');
    if v_kept = '{}' and old.settings -> 'storage' is null then
      v_kept := null;
    end if;
  end if;
  new.settings := case when v_kept is null then coalesce(new.settings, '{}') - 'storage'
    else jsonb_set(coalesce(new.settings, '{}'), '{storage}', v_kept) end;
  return new;
end $$;
create trigger storage_settings_guard before update of settings on public.companies
  for each row execute function private.storage_settings_guard();

/**
 * Settings → Storage: the company's limit. p_mode 'default' goes back to the default (the server's,
 * from Railway), 'none' takes the limit off, and 'custom' sets p_limit_bytes. Owners and admins who
 * manage settings. Returns settings.storage as it is now.
 */
create function public.storage_set_limit(p_company uuid, p_mode text, p_limit_bytes bigint default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_limit jsonb;
  v_storage jsonb;
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'settings')) then
    raise exception 'Only owners and admins who manage settings can change the storage limit.' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('default', 'none', 'custom') then
    raise exception 'Choose the default limit, no limit, or a limit of your own.' using errcode = '22023';
  end if;
  if p_mode = 'custom' then
    if p_limit_bytes is null or p_limit_bytes <= 0 then
      raise exception 'A limit of your own needs a size of more than 0 GB.' using errcode = '22023';
    end if;
    if p_limit_bytes > 10000000000000000 then
      raise exception 'A limit can be 10,000,000 GB at most.' using errcode = '22023';
    end if;
  end if;
  v_limit := case p_mode when 'custom' then jsonb_build_object('limit_bytes', p_limit_bytes)
    when 'none' then jsonb_build_object('limit_bytes', null) else '{}'::jsonb end;

  perform set_config('crewtavo.storage', 'on', true);
  update public.companies c
  set settings = jsonb_set(c.settings, '{storage}', (private.storage_of(c.settings) - 'limit_bytes') || v_limit
    || jsonb_build_object('changed_at', now(), 'changed_by', (select auth.uid())))
  where c.id = p_company
  returning c.settings -> 'storage' into v_storage;
  perform set_config('crewtavo.storage', 'off', true);
  return v_storage;
end $$;

/**
 * The default limit, and why it's that: the server's, when it reads where the files are kept on
 * Railway (apps/api/src/services/hosting.ts). p_bytes null when it can't tell (no default limit then).
 * Changes nothing when it's the same as before. The server's alone.
 */
create function public.storage_set_default(p_company uuid, p_bytes bigint, p_basis text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_basis text := left(nullif(trim(p_basis), ''), 200);
begin
  if p_bytes is not null and p_bytes <= 0 then
    raise exception 'A default limit is more than 0 bytes, or null when there isn''t one.' using errcode = '22023';
  end if;
  perform set_config('crewtavo.storage', 'on', true);
  update public.companies c
  set settings = jsonb_set(c.settings, '{storage}', private.storage_of(c.settings)
    || jsonb_build_object('default_bytes', p_bytes, 'default_basis', v_basis))
  where c.id = p_company
    and jsonb_build_object('default_bytes', private.storage_of(c.settings) -> 'default_bytes', 'default_basis', private.storage_of(c.settings) -> 'default_basis')
      is distinct from jsonb_build_object('default_bytes', p_bytes, 'default_basis', v_basis);
  perform set_config('crewtavo.storage', 'off', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Limits for a person, or for a role
-- ---------------------------------------------------------------------------------------------

create table public.storage_allowances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- One person (on the team; their limit goes when they leave it)...
  user_id uuid references auth.users (id) on delete cascade,
  -- ...or everyone with a role: an access level other than Owner, or a custom role's id.
  role_key text check (role_key ~ '^(admin|office|estimator|crew_lead|field_crew|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  limit_bytes bigint not null check (limit_bytes > 0),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((user_id is null) <> (role_key is null)),
  unique (company_id, user_id),
  unique (company_id, role_key),
  foreign key (company_id, user_id) references public.memberships (company_id, user_id) on delete cascade
);
select private.add_touch_triggers(array['storage_allowances']);

comment on table public.storage_allowances is 'How much one person, or everyone with a role, may upload (Settings → Storage). Owners set them; owners are never limited.';
comment on column public.storage_allowances.role_key is 'An access level (admin, office, estimator, crew_lead, field_crew) or a custom role''s id.';

-- Owners and admins see them; only owners change them, through storage_set_allowance.
alter table public.storage_allowances enable row level security;
revoke insert, update, delete on public.storage_allowances from authenticated;
create policy storage_allowances_read on public.storage_allowances for select to authenticated
  using (private.has_role(company_id, '{owner,admin}'));

-- A custom role's limit goes with it.
create function private.storage_role_gone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.storage_allowances a where a.company_id = old.company_id and a.role_key = old.id::text;
  return null;
end $$;
create trigger storage_allowances_role_gone after delete on public.company_roles
  for each row execute function private.storage_role_gone();

-- Everyone in the company (subs and those no longer active too) with the limit they're held to and
-- where it comes from: 'person' or 'role'. None for owners or subs.
create function private.storage_member_limits(p_company uuid)
returns table (user_id uuid, role public.member_role, role_id uuid, active boolean, limit_bytes bigint, limit_source text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.role, m.role_id, m.active,
    case when m.role not in ('owner', 'subcontractor') then coalesce(pa.limit_bytes, ra.limit_bytes, ba.limit_bytes) end,
    case when m.role in ('owner', 'subcontractor') then null
      when pa.id is not null then 'person'
      when ra.id is not null or ba.id is not null then 'role' end
  from public.memberships m
  left join public.storage_allowances pa on pa.company_id = m.company_id and pa.user_id = m.user_id
  left join public.storage_allowances ra on ra.company_id = m.company_id and ra.role_key = m.role_id::text
  left join public.storage_allowances ba on ba.company_id = m.company_id and ba.role_key = m.role::text
  where m.company_id = p_company
$$;

/**
 * A limit for one person (p_user) or for everyone with a role (p_role: an access level other than
 * owner, or a custom role's id). p_limit_bytes null takes it off. Owners alone, and owners are never
 * limited.
 */
create function public.storage_set_allowance(p_company uuid, p_user uuid, p_role text, p_limit_bytes bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := nullif(trim(p_role), '');
  v_level public.member_role;
begin
  if not private.has_role(p_company, '{owner}') then
    raise exception 'Only owners can set storage limits for people and roles.' using errcode = '42501';
  end if;
  if (p_user is null) = (v_role is null) then
    raise exception 'Choose one person or one role.' using errcode = '22023';
  end if;
  if p_limit_bytes is not null and p_limit_bytes <= 0 then
    raise exception 'A limit needs a size of more than 0 GB. To take one off, choose No limit.' using errcode = '22023';
  end if;
  if p_limit_bytes > 10000000000000000 then
    raise exception 'A limit can be 10,000,000 GB at most.' using errcode = '22023';
  end if;
  -- A custom role's id, written the one way.
  if v_role ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_role := v_role::uuid::text;
  end if;

  if p_limit_bytes is null then
    delete from public.storage_allowances a
    where a.company_id = p_company and (a.user_id = p_user or a.role_key = v_role);
    return;
  end if;

  if p_user is not null then
    select m.role into v_level from public.memberships m where m.company_id = p_company and m.user_id = p_user;
    if v_level is null then
      raise exception 'That person isn''t on your team.' using errcode = '22023';
    elsif v_level = 'owner' then
      raise exception 'Owners aren''t limited.' using errcode = '22023';
    elsif v_level = 'subcontractor' then
      raise exception 'Subcontractors aren''t limited: they only add visit photos and paperwork, which are never refused.' using errcode = '22023';
    end if;
    insert into public.storage_allowances (company_id, user_id, limit_bytes) values (p_company, p_user, p_limit_bytes)
    on conflict (company_id, user_id) do update set limit_bytes = excluded.limit_bytes;
  else
    if v_role = 'owner' then
      raise exception 'Owners aren''t limited.' using errcode = '22023';
    end if;
    if not (v_role in ('admin', 'office', 'estimator', 'crew_lead', 'field_crew')
            or exists (select 1 from public.company_roles r where r.company_id = p_company and r.id::text = v_role)) then
      raise exception 'That role wasn''t found.' using errcode = '22023';
    end if;
    insert into public.storage_allowances (company_id, role_key, limit_bytes) values (p_company, v_role, p_limit_bytes)
    on conflict (company_id, role_key) do update set limit_bytes = excluded.limit_bytes;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- What's used
-- ---------------------------------------------------------------------------------------------

/**
 * Settings → Storage and Drive, for anyone on the team (not subs):
 *   { used_bytes, trash_bytes, files, limit_bytes, limit_mode, default_bytes, default_basis,
 *     me: { used_bytes, limit_bytes, limit_source } }
 * used_bytes is every stored file, the Trash's (trash_bytes) included; limit_bytes the limit as it
 * stands (the company's own, the default, or null for none); me the person's own uploads still in
 * use, and their limit ('person' or 'role', null for none). Owners and admins also get
 *   by_person: [{ user_id, name, role, role_name, used_bytes, limit_bytes, limit_source }]
 * (everyone active on the team or a sub; then anyone no longer on it who still has files, with no
 * role; then "Uploaded by Crewtavo", user_id null, for what the server stored for nobody),
 *   by_area: [{ area, bytes }] (the folder: plans, visit, quote, subs, receipts, applicants, kb,
 * equipment, tickets, chat, measurements..., and 'trash' for everything in the Trash), and
 *   roles: [{ role_key, name, limit_bytes }] (the limits set for roles).
 * Planned for the company asked about each time (a generic plan can't tell one company's files from
 * all of them), never compiled (JIT takes longer than the look itself), and added up by hashing, not
 * sorting: there are only a handful of groups, which the planner can't foresee.
 */
create function public.storage_overview(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
set plan_cache_mode = force_custom_plan set jit = off set enable_sort = off as $$
declare
  v_me uuid := (select auth.uid());
  v_office boolean;
  v_storage jsonb;
  v_used bigint;
  v_trash bigint;
  v_files bigint;
  v_mine bigint;
  v_people jsonb;
  v_areas jsonb;
  v_out jsonb;
begin
  if not private.is_member(p_company) then
    raise exception 'Only the team can see how much storage is used.' using errcode = '42501';
  end if;
  v_office := private.has_role(p_company, '{owner,admin}');
  select private.storage_of(c.settings) into v_storage from public.companies c where c.id = p_company;

  -- One look through the company's files, each with who added it (a plan file the server stored: who
  -- added it) and whether it's in the Trash, added up by area, person and Trash: a handful of rows,
  -- however many files there are. The Trash is joined on the path (a path is in it once at most), so
  -- its paths are hashed however many there are, a big Trash in batches on disk. (Asking "o.name in
  -- (the Trash's paths)" for each file hashes them only while they fit in memory, and past that
  -- compares every file with every path in the Trash, which takes minutes for a big company.)
  with marked as materialized (
    select x.area, x.uploader, x.trashed, sum(x.bytes)::bigint as bytes, count(*) as files
    from (
      select case when split_part(o.name, '/', 3) = '' then 'other' else split_part(o.name, '/', 2) end as area,
        coalesce(o.owner, case when split_part(o.name, '/', 2) = 'plans' then (select f.created_by from public.plan_files f where f.path = o.name) end) as uploader,
        t.id is not null or d.id is not null as trashed,
        private.storage_object_bytes(o.metadata) as bytes
      from storage.objects o
      left join public.trashed_files t on t.path = o.name and t.company_id = p_company
      left join public.plan_files d on d.path = o.name and d.company_id = p_company and d.deleted_at is not null
      where o.bucket_id = 'files' and o.name collate "C" >= p_company::text || '/' and o.name collate "C" < p_company::text || '0'
    ) x
    group by x.area, x.uploader, x.trashed
  ), people as materialized (
    select m.uploader, sum(m.bytes)::bigint as bytes from marked m where not m.trashed group by m.uploader
  )
  select
    coalesce((select sum(m.bytes) from marked m), 0)::bigint,
    coalesce((select sum(m.bytes) from marked m where m.trashed), 0)::bigint,
    coalesce((select sum(m.files) from marked m), 0)::bigint,
    coalesce((select p.bytes from people p where p.uploader = v_me), 0)::bigint,
    case when v_office then (
      select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'name', x.name, 'role', x.role, 'role_name', x.role_name,
          'used_bytes', x.used, 'limit_bytes', x.limit_bytes, 'limit_source', x.limit_source) order by x.kind, x.used desc, lower(x.name)), '[]')
      from (
        select 1 as kind, l.user_id, coalesce(nullif(pr.full_name, ''), pr.email, 'Someone') as name, l.role::text as role,
          coalesce(cr.name, private.storage_level_label(l.role::text)) as role_name, coalesce(u.bytes, 0) as used, l.limit_bytes, l.limit_source
        from private.storage_member_limits(p_company) l
        left join public.profiles pr on pr.user_id = l.user_id
        left join public.company_roles cr on cr.id = l.role_id
        left join people u on u.uploader = l.user_id
        where l.active
        union all
        select 2, u.uploader, coalesce(nullif(pr.full_name, ''), pr.email, 'Someone no longer on the team'), null::text, null::text, u.bytes, null::bigint, null::text
        from people u
        left join public.profiles pr on pr.user_id = u.uploader
        where u.uploader is not null and u.bytes > 0
          and not exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = u.uploader and m.active)
        union all
        select 3, null::uuid, 'Uploaded by Crewtavo', null::text, null::text, u.bytes, null::bigint, null::text
        from people u where u.uploader is null and u.bytes > 0
      ) x)
    end,
    case when v_office then (
      select coalesce(jsonb_agg(jsonb_build_object('area', a.area, 'bytes', a.bytes) order by a.bytes desc, a.area), '[]')
      from (
        select m.area, sum(m.bytes)::bigint as bytes from marked m where not m.trashed group by m.area
        union all
        select 'trash', sum(m.bytes)::bigint from marked m where m.trashed having count(*) > 0
      ) a)
    end
  into v_used, v_trash, v_files, v_mine, v_people, v_areas;

  select jsonb_build_object(
    'used_bytes', v_used, 'trash_bytes', v_trash, 'files', v_files,
    'limit_bytes', private.storage_company_limit(v_storage), 'limit_mode', private.storage_limit_mode(v_storage),
    'default_bytes', private.storage_bytes(v_storage -> 'default_bytes'),
    'default_basis', case when jsonb_typeof(v_storage -> 'default_basis') = 'string' then v_storage ->> 'default_basis' end,
    'me', jsonb_build_object('used_bytes', v_mine, 'limit_bytes', l.limit_bytes, 'limit_source', l.limit_source))
  into v_out
  from (select 1) one
  left join private.storage_member_limits(p_company) l on l.user_id = v_me;

  if v_office then
    v_out := v_out || jsonb_build_object('by_person', v_people, 'by_area', v_areas, 'roles', (
      select coalesce(jsonb_agg(jsonb_build_object('role_key', a.role_key, 'name', coalesce(cr.name, private.storage_level_label(a.role_key)), 'limit_bytes', a.limit_bytes)
          order by cr.id is not null, array_position(array['admin', 'office', 'estimator', 'crew_lead', 'field_crew'], a.role_key), lower(cr.name)), '[]')
      from public.storage_allowances a
      left join public.company_roles cr on cr.company_id = a.company_id and cr.id::text = a.role_key
      where a.company_id = p_company and a.role_key is not null));
  end if;
  return v_out;
end $$;

/**
 * The storage gateway's check before an upload (apps/api/src/lib/storageLimits.ts): what the company
 * has stored (the Trash's too) and its limit as it stands (null for none); what p_user uploaded that's
 * still in use, and the limit they're held to (null for none, and always for owners). One row, also
 * for a company or person it doesn't know. The server's alone. One look through the company's files;
 * only the person's own are looked up in the Trash. Planned for the company asked about each time,
 * and never compiled, as storage_overview.
 */
create function public.storage_snapshot(p_company uuid, p_user uuid)
returns table (company_used bigint, company_limit bigint, user_used bigint, user_limit bigint, user_is_owner boolean)
language plpgsql stable security definer set search_path = '' set plan_cache_mode = force_custom_plan set jit = off as $$
declare
  v_storage jsonb;
  v_used bigint;
  v_theirs bigint;
  v_limit bigint;
  v_owner boolean;
begin
  select private.storage_of(c.settings) into v_storage from public.companies c where c.id = p_company;
  -- The person's own: what they stored, or a plan file the server stored that they added, and in
  -- neither case in the Trash.
  select coalesce(sum(x.bytes), 0), coalesce(sum(case when x.maybe_theirs then
      case when not exists (select 1 from public.trashed_files t where t.path = x.name)
        and not exists (select 1 from public.plan_files f where f.path = x.name
                        and (f.deleted_at is not null or (x.owner is null and f.created_by is distinct from p_user)))
        and (x.owner is not null or exists (select 1 from public.plan_files f where f.path = x.name))
      then x.bytes end
    end), 0)
  into v_used, v_theirs
  from (
    select o.name, o.owner, private.storage_object_bytes(o.metadata) as bytes,
      coalesce(p_user is not null and (o.owner = p_user or (o.owner is null and split_part(o.name, '/', 2) = 'plans')), false) as maybe_theirs
    from storage.objects o
    where o.bucket_id = 'files' and o.name collate "C" >= p_company::text || '/' and o.name collate "C" < p_company::text || '0'
  ) x;
  select l.limit_bytes, l.role = 'owner' and l.active into v_limit, v_owner
  from private.storage_member_limits(p_company) l where l.user_id = p_user;
  return query select v_used, private.storage_company_limit(v_storage), v_theirs, v_limit, coalesce(v_owner, false);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Who calls what
-- ---------------------------------------------------------------------------------------------

revoke all on function private.storage_setting(), private.storage_of(jsonb), private.storage_bytes(jsonb),
  private.storage_limit_mode(jsonb), private.storage_company_limit(jsonb), private.storage_level_label(text),
  private.storage_object_bytes(jsonb), private.storage_settings_guard(), private.storage_role_gone(),
  private.storage_member_limits(uuid) from public;
revoke execute on function public.storage_set_limit(uuid, text, bigint), public.storage_set_allowance(uuid, uuid, text, bigint),
  public.storage_overview(uuid) from public, anon;
grant execute on function public.storage_set_limit(uuid, text, bigint), public.storage_set_allowance(uuid, uuid, text, bigint),
  public.storage_overview(uuid) to authenticated;
revoke execute on function public.storage_snapshot(uuid, uuid), public.storage_set_default(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.storage_snapshot(uuid, uuid), public.storage_set_default(uuid, bigint, text) to service_role;

-- The policy above checks the company the per-row way; rewrite it like the others (see
-- 20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
