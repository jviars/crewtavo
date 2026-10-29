-- Drive (Apps → Crewtavo - Drive): every file in one place. The office's own documents (forms, price
-- sheets, insurance papers) in company folders, the files on each client's properties, requests,
-- quotes and jobs, and a 30-day Trash for every file in Crewtavo, not only Drive's.
--
--   settings.drive       installed or not (drive_set_enabled). Installing makes the company's top
--                        folder, "Company files". Uninstalling keeps every folder and file.
--   drive_folders        the company's folders, under "Company files". Owners, admins, office staff
--                        and estimators make, rename and move them; a folder can't go inside itself,
--                        and two folders in one place can't share a name.
--   plan_files           Drive's files ARE plan files (20261019001700_plan_files.sql): a file is on a
--                        property, a request, a quote or a job as before, or in a company folder
--                        (folder_id), or both. A file's versions stay together: moving one, or putting
--                        it on a job, takes them all. Putting a file on a job by hand puts it at the
--                        job's property and tells the crew on upcoming visits, as adding one does.
--
-- The Trash. Nothing a signed-in person does deletes a file any more; it goes in the Trash, and the
-- server deletes what's been there for 30 days (apps/api/src/tasks.ts, "trash"), or sooner when an
-- owner empties it. TRASH_DAYS in packages/core/src/drive.ts says 30 too.
--
--   plan_files.deleted_at  a file (all its versions), one version, or a folder and all that's in it,
--   drive_folders.         moved to the Trash by the functions below, and back out by drive_restore.
--     deleted_at           Nobody signed in sees what's in the Trash except through drive_trash. A file
--                          whose client, property, request, quote or job is deleted goes in the Trash
--                          too, instead of being deleted by the nightly tidy-up as before.
--   trashed_files          the stored files of everything else: a visit or quote photo, a sub's
--                          paperwork, a receipt, a résumé, a guide's cover, an equipment or ticket
--                          photo, a measurement's picture, a chat photo. Taking one out or replacing it
--                          puts its file here (the triggers below), but only a file in the folder its
--                          kind is kept in, and only one nothing else uses (stored_path_in_use): a row
--                          can't hand over a file that isn't its own. A photo, paperwork, a résumé or
--                          a receipt can be put back as it was. Paperwork, résumés and receipts are
--                          only for some people, so they never go into Drive: when where they were is
--                          gone, they're downloaded from the Trash instead.
--   storage.objects        nobody signed in deletes a stored file now: files_delete and
--                          files_sub_delete are gone. Only the server does, and only the files the
--                          database hands it (trash_purge, trash_delete_forever, trash_copied_to_drive):
--                          it deletes the rows first, still in the Trash, then says which of their
--                          files nothing uses any more. A guide's cover or a quote's or a visit's photo
--                          uploaded for a save that failed has no row at all: the nightly tidy-up
--                          removes it a day later (unrecorded_files), as it does plan files.

-- ---------------------------------------------------------------------------------------------
-- Moving things in and out of the Trash
-- ---------------------------------------------------------------------------------------------

-- Whether the trash functions below are at work in this transaction. Only they move a file or folder
-- in or out of the Trash, put a version back in its place and put paperwork back as it was; they
-- set crewtavo.trash for the moment they do (nothing signed in can set it otherwise).
create function private.trashing() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('crewtavo.trash', true), '') = 'on'
$$;
revoke all on function private.trashing() from public;
grant execute on function private.trashing() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Company folders
-- ---------------------------------------------------------------------------------------------

create table public.drive_folders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Empty only for the company's top folder, "Company files".
  parent_id uuid,
  name text not null check (length(trim(name)) between 1 and 120 and name !~ '[/\\]'),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- In the Trash since, and who put it there (only the trash functions change these).
  deleted_at timestamptz,
  deleted_by uuid references auth.users (id) on delete set null,
  unique (company_id, id),
  foreign key (company_id, parent_id) references public.drive_folders (company_id, id) on delete cascade
);
create unique index drive_folders_root_idx on public.drive_folders (company_id) where parent_id is null;
create unique index drive_folders_name_idx on public.drive_folders
  (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'), lower(name)) where deleted_at is null;
create index drive_folders_parent_idx on public.drive_folders (company_id, parent_id) where parent_id is not null;
create index drive_folders_trash_idx on public.drive_folders (company_id, deleted_at) where deleted_at is not null;
select private.add_touch_triggers(array['drive_folders']);

comment on table public.drive_folders is 'Company folders in Drive (Apps → Crewtavo - Drive), under the company''s top folder, Company files.';
comment on column public.drive_folders.deleted_at is 'In the Trash since then (drive_trash_folder); deleted for good 30 days later.';

-- Company files stays where it is, as it is. A folder goes in one that's there (not in the Trash),
-- never inside itself or one of its own folders, at most 20 deep, and not next to one of the same
-- name. Who made it, and when, stay as they were; only the trash functions put it in the Trash.
create function private.drive_folders_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_at uuid;
  v_depth integer := 0;
  v_height integer := 1;
begin
  new.name := trim(new.name);
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
    new.deleted_at := null;
    new.deleted_by := null;
  else
    new.id := old.id;
    new.company_id := old.company_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if not private.trashing() then
      new.deleted_at := old.deleted_at;
      new.deleted_by := old.deleted_by;
    end if;
    if old.parent_id is null then
      if new.parent_id is not null or new.name is distinct from old.name then
        raise exception 'Company files can''t be renamed or moved.' using errcode = '22023';
      end if;
      if new.deleted_at is not null then
        raise exception 'Company files can''t go in the Trash.' using errcode = '22023';
      end if;
      return new;
    end if;
  end if;

  if new.parent_id is null then
    if tg_op = 'UPDATE' or exists (select 1 from public.drive_folders d where d.company_id = new.company_id and d.parent_id is null) then
      raise exception 'A folder goes inside Company files or another folder.' using errcode = '22023';
    end if;
    new.name := 'Company files';
    return new;
  end if;
  -- Going in the Trash: nothing else to check.
  if new.deleted_at is not null then
    return new;
  end if;

  -- New, moved, or back from the Trash: in a folder that's there, not inside itself, not too deep.
  if tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id or old.deleted_at is not null then
    if not exists (select 1 from public.drive_folders d where d.id = new.parent_id and d.company_id = new.company_id and d.deleted_at is null) then
      raise exception 'That folder wasn''t found. It may be in the Trash.' using errcode = '22023';
    end if;
    v_at := new.parent_id;
    while v_at is not null and v_depth <= 20 loop
      if v_at = new.id then
        raise exception 'A folder can''t go inside itself or one of its own folders.' using errcode = '22023';
      end if;
      v_depth := v_depth + 1;
      select d.parent_id into v_at from public.drive_folders d where d.id = v_at;
    end loop;
    -- How deep its own folders go (those coming back from the Trash with it count too).
    if tg_op = 'UPDATE' then
      with recursive below as (
        select d.id, 1 as level from public.drive_folders d where d.id = new.id
        union all
        select c.id, b.level + 1 from public.drive_folders c join below b on c.parent_id = b.id
        where (c.deleted_at is null or c.deleted_at = old.deleted_at) and b.level < 25
      )
      select max(b.level) into v_height from below b;
    end if;
    if v_depth + v_height > 20 then
      raise exception 'Folders go 20 deep at most. Put it somewhere higher up.' using errcode = '22023';
    end if;
  end if;

  if tg_op = 'INSERT' or new.name is distinct from old.name or new.parent_id is distinct from old.parent_id or old.deleted_at is not null then
    if exists (
      select 1 from public.drive_folders s
      where s.company_id = new.company_id and s.parent_id = new.parent_id and s.id <> new.id
        and s.deleted_at is null and lower(s.name) = lower(new.name)
    ) then
      raise exception 'There''s already a folder called % here.', new.name using errcode = '23505';
    end if;
  end if;
  return new;
end $$;
create trigger drive_folders_guard before insert or update on public.drive_folders
  for each row execute function private.drive_folders_guard();

-- The office keeps the folders. Nobody signed in deletes one (the server deletes them from the
-- Trash) or sees one in the Trash (drive_trash lists them).
alter table public.drive_folders enable row level security;
create policy drive_folders_read on public.drive_folders for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'));
create policy drive_folders_insert on public.drive_folders for insert to authenticated
  with check (private.has_role(company_id, '{owner,admin,office,estimator}'));
create policy drive_folders_update on public.drive_folders for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'))
  with check (private.has_role(company_id, '{owner,admin,office,estimator}'));
create policy drive_folders_live on public.drive_folders as restrictive for select to authenticated
  using (deleted_at is null);
create policy drive_folders_live_update on public.drive_folders as restrictive for update to authenticated
  using (deleted_at is null) with check (deleted_at is null);

-- The company's top folder, made the first time it's needed.
create function private.drive_root_folder(p_company uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select d.id into v_id from public.drive_folders d where d.company_id = p_company and d.parent_id is null;
  if v_id is null then
    insert into public.drive_folders (company_id, name) values (p_company, 'Company files')
    on conflict (company_id) where parent_id is null do nothing
    returning id into v_id;
    if v_id is null then
      select d.id into v_id from public.drive_folders d where d.company_id = p_company and d.parent_id is null;
    end if;
  end if;
  return v_id;
end $$;
revoke all on function private.drive_root_folder(uuid) from public;

-- Where a folder is, from the top: "Company files › Forms › Insurance".
create function private.drive_folder_path(p_folder uuid) returns text
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select d.parent_id, d.name, 1 as n from public.drive_folders d where d.id = p_folder
    union all
    select d.parent_id, d.name, u.n + 1 from public.drive_folders d join up u on d.id = u.parent_id where u.n < 25
  )
  select string_agg(up.name, ' › ' order by up.n desc) from up
$$;
revoke all on function private.drive_folder_path(uuid) from public;

-- The company's top folder, for the office (Drive's Company files).
create function public.drive_root(p_company uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_company, '{owner,admin,office,estimator}') then
    raise exception 'Only the office can open Company files.' using errcode = '42501';
  end if;
  return private.drive_root_folder(p_company);
end $$;

-- ---------------------------------------------------------------------------------------------
-- The app's switch
-- ---------------------------------------------------------------------------------------------

-- Installing makes Company files (once). Uninstalling keeps every folder and file: they come back if
-- Drive is installed again, and files on clients and jobs stay there either way.
create function public.drive_set_enabled(p_company uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can install Drive' using errcode = '42501';
  end if;
  update public.companies
  set settings = jsonb_set(coalesce(settings, '{}'), '{drive}', coalesce(settings -> 'drive', '{}') || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
  where id = p_company;
  if p_enabled then
    perform private.drive_root_folder(p_company);
  end if;
  return p_enabled;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Files in folders, and in the Trash
-- ---------------------------------------------------------------------------------------------

alter table public.plan_files
  add column folder_id uuid,
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id) on delete set null,
  add column trashed_from uuid,
  add constraint plan_files_folder_fk foreign key (company_id, folder_id)
    references public.drive_folders (company_id, id) on delete set null (folder_id);
create index plan_files_folder_idx on public.plan_files (company_id, folder_id) where folder_id is not null;
create index plan_files_trash_idx on public.plan_files (company_id, deleted_at) where deleted_at is not null;

comment on column public.plan_files.folder_id is 'The company folder it''s in (Drive). A file on no property, request, quote or job is in one.';
comment on column public.plan_files.deleted_at is 'In the Trash since then; every version moved together shares it. Deleted for good 30 days later.';
comment on column public.plan_files.trashed_from is 'For a newest version moved to the Trash on its own: the version it replaced (current again since).';

-- The versions of a file: every row joined to it through replaces_id that's in the same state (in
-- use, or moved to the Trash at the same moment).
create function private.drive_chain(p_file uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  with recursive start as (
    select f.id, f.company_id, f.replaces_id, f.deleted_at from public.plan_files f where f.id = p_file
  ), chain as (
    select s.id, s.replaces_id from start s
    union
    select f.id, f.replaces_id
    from public.plan_files f join chain c on f.replaces_id = c.id or f.id = c.replaces_id
    where f.company_id = (select s.company_id from start s)
      and f.deleted_at is not distinct from (select s.deleted_at from start s)
  )
  select chain.id from chain
$$;
revoke all on function private.drive_chain(uuid) from public;

-- A new file takes the property from its job, quote or request; a new version takes everything it
-- doesn't say from the one it replaces (its folder too, and being archived), which must still be the
-- current one and not in the Trash. A file on none of those is a company file, in a folder that's there, added by the
-- office (or the server). Nothing is added straight into the Trash. As 20261019001800_request_files.sql
-- otherwise.
create or replace function private.plan_files_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.plan_files;
  -- The folder asked for, not one an older version was in.
  v_folder uuid := new.folder_id;
begin
  new.deleted_at := null;
  new.deleted_by := null;
  new.trashed_from := null;
  if new.replaces_id is not null then
    select * into v_prev from public.plan_files where id = new.replaces_id and company_id = new.company_id for update;
    if not found then
      raise exception 'That file wasn''t found' using errcode = '23503';
    end if;
    -- A crew lead can only add a version of a file they can see.
    if not private.has_role(new.company_id, '{owner,admin,office,estimator}') and (not v_prev.crew_visible or v_prev.archived) then
      raise exception 'That file wasn''t found' using errcode = '23503';
    end if;
    if v_prev.deleted_at is not null then
      raise exception 'That file is in the Trash. Restore it first.' using errcode = '22023';
    end if;
    if v_prev.superseded_at is not null then
      raise exception 'A newer version of % was already added. Refresh and try again.', v_prev.title using errcode = '23505';
    end if;
    new.property_id := coalesce(new.property_id, v_prev.property_id);
    new.request_id := coalesce(new.request_id, v_prev.request_id);
    new.quote_id := coalesce(new.quote_id, v_prev.quote_id);
    new.job_id := coalesce(new.job_id, v_prev.job_id);
    new.folder_id := coalesce(new.folder_id, v_prev.folder_id);
    if v_folder = v_prev.folder_id then
      v_folder := null; -- the one it was already in, not a new choice
    end if;
    -- A new version of an archived file is archived too: one saved or uploaded by someone who had it
    -- open before it was archived doesn't bring it back (or tell the crew about it).
    new.archived := new.archived or v_prev.archived;
  end if;
  if new.property_id is null and new.job_id is not null then
    select property_id into new.property_id from public.jobs where id = new.job_id and company_id = new.company_id;
  end if;
  if new.property_id is null and new.quote_id is not null then
    select property_id into new.property_id from public.quotes where id = new.quote_id and company_id = new.company_id;
  end if;
  if new.property_id is null and new.request_id is not null then
    select property_id into new.property_id from public.requests where id = new.request_id and company_id = new.company_id;
  end if;
  if new.property_id is null and new.request_id is null and new.quote_id is null and new.job_id is null
     and (new.folder_id is null or not ((select auth.uid()) is null or private.has_role(new.company_id, '{owner,admin,office,estimator}'))) then
    raise exception 'A file goes on a property, a request, a quote or a job' using errcode = '23514';
  end if;
  if new.folder_id is not null then
    -- Held while this is added, so the folder can't go in the Trash without it.
    perform 1 from public.drive_folders d where d.id = new.folder_id and d.company_id = new.company_id and d.deleted_at is null for share;
    if not found then
      if v_folder is null and (new.property_id is not null or new.request_id is not null or new.quote_id is not null or new.job_id is not null) then
        -- The older version's folder went in the Trash; the new one stays on its job.
        new.folder_id := null;
      else
        raise exception 'That folder wasn''t found. It may be in the Trash.' using errcode = '22023';
      end if;
    end if;
  end if;
  new.superseded_at := null;
  return new;
end $$;

-- What a file is and where its history goes don't change by hand: a different file is a new version.
-- Only the triggers here (one level down) and the trash functions mark a version superseded or
-- current again, or move a file in or out of the Trash. As 20261019001700_plan_files.sql otherwise.
create or replace function private.plan_files_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.company_id := old.company_id;
  new.path := old.path;
  new.file_name := old.file_name;
  new.content_type := old.content_type;
  new.size_bytes := old.size_bytes;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if pg_trigger_depth() <= 1 and not private.trashing() then
    new.replaces_id := old.replaces_id;
    new.superseded_at := old.superseded_at;
    new.deleted_at := old.deleted_at;
    new.deleted_by := old.deleted_by;
    new.trashed_from := old.trashed_from;
  end if;
  return new;
end $$;

-- Where a file is, as it changes (after plan_files_guard, by name):
--   - Put on a job, quote or request by hand (Drive's "Attach to…"), it's at that property too, as a
--     new file there would be.
--   - Moved between folders: by the office, into a folder that's there.
--   - Left on nothing at all: when what it was on is deleted (a client, property, request, quote or
--     job: "on delete set null"), it goes in the Trash; anyone doing it by hand is told to move it to
--     the Trash instead.
create function private.plan_files_place() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null then
    return new;
  end if;
  if not private.trashing() then
    if new.property_id is null and new.job_id is not null and new.job_id is distinct from old.job_id then
      select property_id into new.property_id from public.jobs where id = new.job_id and company_id = new.company_id;
    end if;
    if new.property_id is null and new.quote_id is not null and new.quote_id is distinct from old.quote_id then
      select property_id into new.property_id from public.quotes where id = new.quote_id and company_id = new.company_id;
    end if;
    if new.property_id is null and new.request_id is not null and new.request_id is distinct from old.request_id then
      select property_id into new.property_id from public.requests where id = new.request_id and company_id = new.company_id;
    end if;
    if new.folder_id is distinct from old.folder_id and pg_trigger_depth() <= 1 then
      if (select auth.uid()) is not null and not private.has_role(new.company_id, '{owner,admin,office,estimator}') then
        raise exception 'Only the office moves files between folders.' using errcode = '42501';
      end if;
      if new.folder_id is not null
         and not exists (select 1 from public.drive_folders d where d.id = new.folder_id and d.company_id = new.company_id and d.deleted_at is null) then
        raise exception 'That folder wasn''t found. It may be in the Trash.' using errcode = '22023';
      end if;
    end if;
  end if;
  if new.property_id is null and new.request_id is null and new.quote_id is null and new.job_id is null and new.folder_id is null then
    if pg_trigger_depth() <= 1 and not private.trashing() then
      raise exception 'A file goes on a property, a request, a quote or a job, or in a folder. Move it to the Trash instead.' using errcode = '23514';
    end if;
    new.deleted_at := now();
    new.deleted_by := (select auth.uid());
  end if;
  return new;
end $$;
create trigger plan_files_place before update on public.plan_files
  for each row execute function private.plan_files_place();

-- A file's versions stay together: moving one to a folder, or putting it on (or taking it off) a
-- property, request, quote or job by hand, does the same to the rest of its versions. (The database's
-- own changes, a level down, already change every version they reach.)
--
-- It goes by where the file is now, not by the change that called it: what a deletion sets to null
-- ("on delete set null") is followed up here only once that's done, with the file as it was part way
-- through, and while something it points at is being deleted there's nothing to carry yet.
create function private.plan_files_carry() returns trigger
language plpgsql security definer set search_path = '' as $$
declare f public.plan_files;
begin
  if pg_trigger_depth() > 1 or private.trashing() then
    return null;
  end if;
  select * into f from public.plan_files x where x.id = new.id;
  if not found or f.deleted_at is not null
     or (f.property_id is not null and not exists (select 1 from public.properties p where p.id = f.property_id))
     or (f.request_id is not null and not exists (select 1 from public.requests r where r.id = f.request_id))
     or (f.quote_id is not null and not exists (select 1 from public.quotes q where q.id = f.quote_id))
     or (f.job_id is not null and not exists (select 1 from public.jobs j where j.id = f.job_id))
     or (f.folder_id is not null and not exists (select 1 from public.drive_folders d where d.id = f.folder_id)) then
    return null;
  end if;
  update public.plan_files x
  set property_id = f.property_id, request_id = f.request_id, quote_id = f.quote_id, job_id = f.job_id, folder_id = f.folder_id
  where x.id in (select private.drive_chain(f.id)) and x.id <> f.id
    and (x.property_id, x.request_id, x.quote_id, x.job_id, x.folder_id)
      is distinct from (f.property_id, f.request_id, f.quote_id, f.job_id, f.folder_id);
  return null;
end $$;
create trigger plan_files_carry after update of property_id, request_id, quote_id, job_id, folder_id on public.plan_files
  for each row when ((old.property_id, old.request_id, old.quote_id, old.job_id, old.folder_id)
    is distinct from (new.property_id, new.request_id, new.quote_id, new.job_id, new.folder_id))
  execute function private.plan_files_carry();

-- The people on upcoming visits for the job hear about a new file or version the crew can see, and
-- now also about a file put on the job afterwards (Drive's "Attach to…", a quote becoming the job). A
-- file in the Trash tells no one. As 20261019001700_plan_files.sql otherwise.
create or replace function private.plan_files_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_job record; v_line text; r record;
begin
  if new.job_id is null or not new.crew_visible or new.archived or new.deleted_at is not null then
    return null;
  end if;
  if tg_op = 'UPDATE' and (new.superseded_at is not null or new.job_id is not distinct from old.job_id) then
    return null;
  end if;
  select timezone into v_tz from public.companies where id = new.company_id;
  select number, title into v_job from public.jobs where id = new.job_id;
  v_line := case
    when tg_op = 'INSERT' and new.replaces_id is not null then format('New version of %s for job #%s (%s)%s', new.title, v_job.number, v_job.title, coalesce(': ' || nullif(trim(new.revision), ''), ''))
    else format('%s added to job #%s (%s)', new.title, v_job.number, v_job.title)
  end;
  for r in
    select distinct on (a.user_id) a.user_id, v.id as visit_id
    from public.visits v join public.visit_assignees a on a.visit_id = v.id
    where v.company_id = new.company_id and v.job_id = new.job_id and private.visit_is_upcoming(v, v_tz)
    order by a.user_id, coalesce(v.starts_at, v.scheduled_on::timestamptz) nulls last
  loop
    perform private.notify_schedule(new.company_id, r.user_id, r.visit_id, v_line);
  end loop;
  return null;
end $$;
create trigger plan_files_notify_attach after update of job_id on public.plan_files
  for each row when (new.job_id is distinct from old.job_id) execute function private.plan_files_notify();

-- Nobody signed in sees a file in the Trash (drive_trash lists them) or changes one, and nobody
-- signed in deletes a file: it goes in the Trash (drive_trash_file below) and the server deletes it
-- from there.
drop policy plan_files_delete on public.plan_files;
create policy plan_files_live on public.plan_files as restrictive for select to authenticated
  using (deleted_at is null);
create policy plan_files_live_update on public.plan_files as restrictive for update to authenticated
  using (deleted_at is null) with check (deleted_at is null);

-- Files on nothing at all, which the nightly tidy-up used to delete: in the Trash now, for 30 days.
do $$
begin
  perform set_config('crewtavo.trash', 'on', true);
  update public.plan_files set deleted_at = now()
  where property_id is null and request_id is null and quote_id is null and job_id is null and folder_id is null and deleted_at is null;
  perform set_config('crewtavo.trash', 'off', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Stored files of everything else, in the Trash
-- ---------------------------------------------------------------------------------------------

create table public.trashed_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- The stored file, in the files bucket.
  path text not null unique check (starts_with(path, company_id::text || '/') and path !~ '(^|/)\.\.?(/|$)'),
  file_name text check (length(file_name) <= 255),
  content_type text check (length(content_type) <= 150),
  size_bytes bigint check (size_bytes >= 0),
  source text not null check (source in ('visit_photo', 'quote_photo', 'sub_document', 'receipt', 'applicant_file', 'kb_cover',
    'equipment_photo', 'ticket_photo', 'measurement_snapshot', 'chat_file')),
  -- What it was on: the visit, quote, sub, expense, guide, applicant, equipment, material ticket,
  -- measurement or chat message.
  source_id uuid,
  -- Where it was, for the Trash: "Visit photo · Job #12".
  label text check (length(label) <= 300),
  -- The row it came out of, when it can be put back (a photo, paperwork, a résumé).
  restore jsonb,
  deleted_by uuid references auth.users (id) on delete set null default auth.uid(),
  deleted_at timestamptz not null default now()
);
create index trashed_files_company_idx on public.trashed_files (company_id, deleted_at desc);
create index trashed_files_purge_idx on public.trashed_files (deleted_at);

comment on table public.trashed_files is 'Stored files taken out of Crewtavo (a visit photo, a receipt, a sub''s paperwork...), kept 30 days before the server deletes them.';

-- Read through drive_trash and written by the triggers below, never directly.
alter table public.trashed_files enable row level security;
revoke all on public.trashed_files from authenticated, anon;

-- Every place a stored file is recorded, looked up by its path (stored_path_in_use, below). Plan
-- files and sub paperwork have theirs already (their paths are unique).
create index attachments_path_idx on public.attachments (path);
create index expenses_receipt_path_idx on public.expenses (receipt_path) where receipt_path is not null;
create index sop_pages_cover_path_idx on public.sop_pages (cover_path) where cover_path is not null;
create index equipment_photo_path_idx on public.equipment (photo_path) where photo_path is not null;
create index job_materials_photo_path_idx on public.job_materials (photo_path) where photo_path is not null;
create index measurements_snapshot_path_idx on public.measurements (snapshot_path) where snapshot_path is not null;
create index roof_packages_picture_idx on public.roof_packages (picture) where picture is not null;
create index quote_options_picture_idx on public.quote_options (picture) where picture is not null;
create index services_picture_idx on public.services (picture) where picture is not null;

-- An applicant's files are stored in their own folder, <company>/applicants/<applicant>/..., as the
-- careers form and the office store them: so a row can't name a file that isn't its own, and the one
-- row that can list a file is found by its id. Files listed from before stay as they are.
create function private.applicant_files_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from jsonb_array_elements(new.files) e
    where (tg_op = 'INSERT' or not old.files @> jsonb_build_array(e))
      and (jsonb_typeof(e) <> 'object'
        or coalesce(e ->> 'path', '') !~ ('^' || new.company_id::text || '/applicants/' || new.id::text || '/[^/]+$')
        or e ->> 'path' ~ '(^|/)\.\.?(/|$)')
  ) then
    raise exception 'That file isn''t stored with this applicant. Add it again.' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function private.applicant_files_guard() from public;
create trigger applicant_files_guard before insert or update of files on public.job_applicants
  for each row execute function private.applicant_files_guard();

-- Whether a stored file is still used: any row anywhere that records it. A plan file owns its path
-- for good, in the Trash or not. The Trash never takes a file in use, and the server never deletes
-- one (trash_purge, trash_delete_forever, trash_copied_to_drive and unrecorded_files ask this after
-- the rows are gone). Each look is by the path's own index, or by the one row a file in an
-- applicant's or a chat channel's folder can be on (applicant_files_guard, chat_message_guard), so
-- asking about a thousand files is quick however many applicants or messages there are. Letterheads
-- are kept in templates and quotes, but no kind of file in the Trash is stored there.
create function private.stored_path_in_use(p_company uuid, p_path text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_folder text := split_part(p_path, '/', 2);
  -- The applicant, channel or person whose folder it's in.
  v_owner uuid := case when split_part(p_path, '/', 3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then split_part(p_path, '/', 3)::uuid end;
  v_file jsonb := jsonb_build_array(jsonb_build_object('path', p_path));
begin
  if exists (select 1 from public.plan_files f where f.path = p_path)
     or exists (select 1 from public.attachments a where a.path = p_path)
     or exists (select 1 from public.sub_documents d where d.path = p_path)
     or exists (select 1 from public.expenses e where e.receipt_path = p_path)
     or exists (select 1 from public.sop_pages s where s.cover_path = p_path)
     or exists (select 1 from public.equipment e where e.photo_path = p_path)
     or exists (select 1 from public.job_materials m where m.photo_path = p_path)
     or exists (select 1 from public.measurements m where m.snapshot_path = p_path) then
    return true;
  end if;
  return case v_folder
    -- An applicant's file is only ever on that applicant (applicant_files_guard).
    when 'applicants' then v_owner is not null
      and exists (select 1 from public.job_applicants a where a.id = v_owner and a.files @> v_file)
    -- A chat photo is only ever in its own channel's messages (chat_message_guard).
    when 'chat' then v_owner is not null
      and exists (select 1 from public.chat_messages m where m.channel_id = v_owner and m.attachments @> v_file)
    -- Pictures only the server stores, each in its own folder.
    when 'avatars' then v_owner is not null and exists (select 1 from public.profiles p where p.user_id = v_owner and p.avatar_url = p_path)
    when 'logo' then exists (select 1 from public.companies c where c.id = p_company and c.settings -> 'branding' ->> 'logo' = p_path)
    when 'packages' then exists (select 1 from public.roof_packages r where r.picture = p_path)
      or exists (select 1 from public.quote_options o where o.picture = p_path)
    when 'services' then exists (select 1 from public.services s where s.picture = p_path)
    else false
  end;
end $$;
revoke all on function private.stored_path_in_use(uuid, text) from public;

-- A photo on a visit or a quote (or a file on a client, property, request, job or invoice) is stored
-- in that record's own folder, <company>/<kind>/<id>/..., as the app stores them, and a plant
-- ticket's photo in its job's, <company>/tickets/<job>/...: so a row can't name someone else's file,
-- which would then go in the Trash with the row. Rows from before stay as they are until their file
-- changes.
create function private.stored_path_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'attachments' then
    if tg_op = 'UPDATE' and new.path is not distinct from old.path then
      return new;
    end if;
    if new.owner_type is null or new.owner_type not in ('visit', 'quote', 'client', 'property', 'request', 'job', 'invoice') then
      raise exception 'A file goes on a visit, a quote, a client, a property, a request, a job or an invoice.' using errcode = '22023';
    end if;
    if not starts_with(new.path, new.company_id::text || '/' || new.owner_type || '/' || new.owner_id::text || '/') or new.path ~ '(^|/)\.\.?(/|$)' then
      raise exception 'That file isn''t stored with what it''s on. Upload it again.' using errcode = '22023';
    end if;
  else
    if new.photo_path is null or (tg_op = 'UPDATE' and new.photo_path is not distinct from old.photo_path) then
      return new;
    end if;
    if not starts_with(new.photo_path, new.company_id::text || '/tickets/' || new.job_id::text || '/') or new.photo_path ~ '(^|/)\.\.?(/|$)' then
      raise exception 'That ticket photo isn''t stored with its job. Add the photo again.' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.stored_path_guard() from public;
create trigger stored_path_guard before insert or update of path on public.attachments
  for each row execute function private.stored_path_guard();
create trigger stored_path_guard before insert or update of photo_path on public.job_materials
  for each row execute function private.stored_path_guard();

-- A stored file into the Trash. Only this company's, in the folder its kind is kept in (a visit photo
-- under visit/, a receipt under receipts/, a résumé in its applicant's...; a file on a client,
-- property, request, job or invoice under that kind's folder, p_owner_type), and only one nothing
-- else uses: a row pointing at someone else's file doesn't take it. Nothing when the whole company
-- is going (its files go with it). One already in the Trash (put back in use some other way, then
-- taken out again) starts its 30 days again, as what it is now.
create function private.trash_stored_file(
  p_company uuid, p_path text, p_name text, p_type text, p_size bigint, p_source text, p_source_id uuid, p_label text, p_restore jsonb,
  p_owner_type text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_folder text := case p_source
    when 'visit_photo' then case when p_owner_type in ('visit', 'client', 'property', 'request', 'job', 'invoice') then p_owner_type end
    when 'quote_photo' then 'quote'
    when 'sub_document' then 'subs'
    when 'receipt' then 'receipts'
    when 'applicant_file' then 'applicants'
    when 'kb_cover' then 'kb'
    when 'equipment_photo' then 'equipment'
    when 'ticket_photo' then 'tickets'
    when 'measurement_snapshot' then 'measurements'
    when 'chat_file' then 'chat'
  end;
begin
  if coalesce(trim(p_path), '') = '' or not starts_with(p_path, p_company::text || '/') or p_path ~ '(^|/)\.\.?(/|$)'
     or v_folder is null or split_part(p_path, '/', 2) <> v_folder
     -- An applicant's own folder, so it can go back on them (applicant_files_guard).
     or (p_source = 'applicant_file' and split_part(p_path, '/', 3) is distinct from p_source_id::text)
     or not exists (select 1 from public.companies c where c.id = p_company)
     or private.stored_path_in_use(p_company, p_path) then
    return;
  end if;
  insert into public.trashed_files (company_id, path, file_name, content_type, size_bytes, source, source_id, label, restore)
  values (p_company, p_path,
    left(coalesce(nullif(trim(p_name), ''), regexp_replace(p_path, '^.*/', '')), 255),
    left(p_type, 150), case when p_size >= 0 then p_size end, p_source, p_source_id, left(p_label, 300), p_restore)
  on conflict (path) do update
  set file_name = excluded.file_name, content_type = excluded.content_type, size_bytes = excluded.size_bytes, source = excluded.source,
    source_id = excluded.source_id, label = excluded.label, restore = excluded.restore, deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at
  where trashed_files.company_id = excluded.company_id;
end $$;
revoke all on function private.trash_stored_file(uuid, text, text, text, bigint, text, uuid, text, jsonb, text) from public;

-- The name of a sub, or the number of a job, deleted in this transaction, for its paperwork or ticket
-- photos going in the Trash after it ("on delete cascade" deletes them once it's gone, so their
-- label can't look it up): kept by trash_parent_gone just before.
create function private.trash_gone_name(p_id uuid) returns text
language sql stable set search_path = '' as $$
  select nullif(current_setting('crewtavo.gone_' || replace(p_id::text, '-', ''), true), '')
$$;
revoke all on function private.trash_gone_name(uuid) from public;

create function private.trash_parent_gone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.companies c where c.id = old.company_id) then
    return old;
  end if;
  if tg_table_name = 'subcontractors' then
    if exists (select 1 from public.sub_documents d where d.subcontractor_id = old.id) then
      perform set_config('crewtavo.gone_' || replace(old.id::text, '-', ''), left(old.name, 200), true);
    end if;
  elsif exists (select 1 from public.job_materials m where m.job_id = old.id and m.photo_path is not null) then
    perform set_config('crewtavo.gone_' || replace(old.id::text, '-', ''), 'Job #' || old.number, true);
  end if;
  return old;
end $$;
revoke all on function private.trash_parent_gone() from public;
create trigger trash_parent_gone before delete on public.subcontractors
  for each row execute function private.trash_parent_gone();
create trigger trash_parent_gone before delete on public.jobs
  for each row execute function private.trash_parent_gone();

-- A file's extension, with its dot: ".jpg" ("" when it has none).
create function private.file_ext(p_path text) returns text
language sql immutable set search_path = '' as $$
  select coalesce('.' || lower((regexp_match(p_path, '\.([A-Za-z0-9]{1,8})$'))[1]), '')
$$;
revoke all on function private.file_ext(text) from public;

-- A row's stored file taken out or replaced: into the Trash (trash_stored_file says which files it
-- takes). One function for each table, by name.
create function private.trash_removed_files() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_label text;
  v_file jsonb;
begin
  -- The whole company going: its files go with it, and nothing is kept.
  if not exists (select 1 from public.companies c where c.id = old.company_id) then
    return null;
  end if;
  case tg_table_name
  -- Photos on a visit (FieldVisitPage) or a quote (the roofing estimate), put back as they were.
  when 'attachments' then
    if tg_op = 'UPDATE' and new.path is not distinct from old.path then
      return null;
    end if;
    -- Only a file stored with what it was on (stored_path_guard), so it can go back there.
    if not starts_with(old.path, old.company_id::text || '/' || old.owner_type || '/' || old.owner_id::text || '/') then
      return null;
    end if;
    if old.owner_type = 'quote' then
      select 'Quote photo · Quote #' || q.number into v_label from public.quotes q where q.id = old.owner_id;
      perform private.trash_stored_file(old.company_id, old.path, old.file_name, old.content_type, old.size_bytes, 'quote_photo', old.owner_id,
        coalesce(v_label, 'Quote photo'), case when tg_op = 'DELETE' then to_jsonb(old) end);
    else
      if old.owner_type = 'visit' then
        select 'Visit photo · ' || coalesce('Job #' || j.number, nullif(trim(v.title), ''), 'Visit') into v_label
        from public.visits v left join public.jobs j on j.id = v.job_id where v.id = old.owner_id;
      end if;
      perform private.trash_stored_file(old.company_id, old.path, old.file_name, old.content_type, old.size_bytes, 'visit_photo', old.owner_id,
        coalesce(v_label, case when old.owner_type = 'visit' then 'Visit photo' else initcap(old.owner_type) || ' file' end),
        case when tg_op = 'DELETE' then to_jsonb(old) end, old.owner_type);
    end if;

  -- A sub's paperwork (removed by the office, or with the sub), put back as it was.
  when 'sub_documents' then
    select 'Paperwork · ' || s.name into v_label from public.subcontractors s where s.id = old.subcontractor_id;
    perform private.trash_stored_file(old.company_id, old.path, old.file_name, old.content_type, old.size_bytes, 'sub_document', old.subcontractor_id,
      coalesce(v_label, 'Paperwork · ' || private.trash_gone_name(old.subcontractor_id) || ' (deleted)', 'Paperwork'), to_jsonb(old));

  -- A receipt (an expense's, or an equipment repair's), taken out or replaced.
  when 'expenses' then
    if old.receipt_path is null or (tg_op = 'UPDATE' and new.receipt_path is not distinct from old.receipt_path) then
      return null;
    end if;
    select concat_ws(' · ', 'Receipt', nullif(trim(old.vendor), ''), 'Job #' || j.number, eq.name) into v_label
    from (select 1) x left join public.jobs j on j.id = old.job_id left join public.equipment eq on eq.id = old.equipment_id;
    perform private.trash_stored_file(old.company_id, old.receipt_path,
      coalesce('Receipt from ' || nullif(trim(old.vendor), ''), 'Receipt') || private.file_ext(old.receipt_path), null, null, 'receipt', old.id, v_label, null);

  -- A guide's cover photo, replaced or with the guide.
  when 'sop_pages' then
    if old.cover_path is null or (tg_op = 'UPDATE' and new.cover_path is not distinct from old.cover_path) then
      return null;
    end if;
    perform private.trash_stored_file(old.company_id, old.cover_path, left(old.title, 200) || ' cover' || private.file_ext(old.cover_path), null, null,
      'kb_cover', old.id, 'Guide cover · ' || old.title, null);

  -- An applicant's résumé and other files: one taken off, or all of them with the applicant. Each
  -- can go back on the applicant.
  when 'job_applicants' then
    for v_file in
      select e from jsonb_array_elements(old.files) e
      where jsonb_typeof(e) = 'object'
        and (tg_op = 'DELETE' or not exists (select 1 from jsonb_array_elements(new.files) n where n ->> 'path' = e ->> 'path'))
    loop
      perform private.trash_stored_file(old.company_id, v_file ->> 'path', v_file ->> 'name', v_file ->> 'type',
        case when v_file ->> 'size' ~ '^[0-9]{1,15}$' then (v_file ->> 'size')::bigint end,
        'applicant_file', old.id, 'Applicant · ' || old.name, jsonb_build_object('applicant_id', old.id, 'file', v_file));
    end loop;

  -- A machine's photo, replaced or with the machine.
  when 'equipment' then
    if old.photo_path is null or (tg_op = 'UPDATE' and new.photo_path is not distinct from old.photo_path) then
      return null;
    end if;
    perform private.trash_stored_file(old.company_id, old.photo_path, left(old.name, 200) || private.file_ext(old.photo_path), null, null,
      'equipment_photo', old.id, 'Equipment photo · ' || old.name, null);

  -- A plant ticket's photo on a job's materials.
  when 'job_materials' then
    if old.photo_path is null or (tg_op = 'UPDATE' and new.photo_path is not distinct from old.photo_path) then
      return null;
    end if;
    -- With its job: the job is gone by now, so its number comes from trash_parent_gone.
    select concat_ws(' · ', 'Ticket photo', coalesce('Job #' || j.number, private.trash_gone_name(old.job_id) || ' (deleted)')) into v_label
    from (select 1) x left join public.jobs j on j.id = old.job_id;
    perform private.trash_stored_file(old.company_id, old.photo_path,
      coalesce('Ticket ' || nullif(trim(old.ticket), ''), 'Ticket') || private.file_ext(old.photo_path), null, null, 'ticket_photo', old.id, v_label, null);

  -- A measurement's picture, replaced or with the drawing (not listed in the Trash, only kept).
  when 'measurements' then
    if old.snapshot_path is null or (tg_op = 'UPDATE' and new.snapshot_path is not distinct from old.snapshot_path) then
      return null;
    end if;
    perform private.trash_stored_file(old.company_id, old.snapshot_path, left(old.title, 200) || private.file_ext(old.snapshot_path), null, null,
      'measurement_snapshot', old.id, concat_ws(' · ', 'Measurement', nullif(old.title, 'Measurement')), null);

  -- Photos in a chat message that's deleted, or with its channel (not listed in the Trash either).
  when 'chat_messages' then
    for v_file in
      select e from jsonb_array_elements(old.attachments) e
      where jsonb_typeof(e) = 'object'
        and (tg_op = 'DELETE' or not exists (select 1 from jsonb_array_elements(new.attachments) n where n ->> 'path' = e ->> 'path'))
    loop
      perform private.trash_stored_file(old.company_id, v_file ->> 'path', v_file ->> 'name', v_file ->> 'type',
        case when v_file ->> 'size' ~ '^[0-9]{1,15}$' then (v_file ->> 'size')::bigint end, 'chat_file', old.id, 'Chat photo', null);
    end loop;
  else
    null;
  end case;
  return null;
end $$;
revoke all on function private.trash_removed_files() from public;

-- Taken out (with the row), or replaced: by what the row ends up as, so a change made by another
-- trigger counts too (deleting a chat message empties its photos in chat_message_guard).
create trigger trash_files after delete on public.attachments
  for each row execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.attachments
  for each row when (old.path is distinct from new.path) execute function private.trash_removed_files();
create trigger trash_files after delete on public.sub_documents
  for each row execute function private.trash_removed_files();
create trigger trash_files after delete on public.expenses
  for each row when (old.receipt_path is not null) execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.expenses
  for each row when (old.receipt_path is distinct from new.receipt_path) execute function private.trash_removed_files();
create trigger trash_files after delete on public.sop_pages
  for each row when (old.cover_path is not null) execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.sop_pages
  for each row when (old.cover_path is distinct from new.cover_path) execute function private.trash_removed_files();
create trigger trash_files after delete on public.job_applicants
  for each row execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.job_applicants
  for each row when (old.files is distinct from new.files) execute function private.trash_removed_files();
create trigger trash_files after delete on public.equipment
  for each row when (old.photo_path is not null) execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.equipment
  for each row when (old.photo_path is distinct from new.photo_path) execute function private.trash_removed_files();
create trigger trash_files after delete on public.job_materials
  for each row when (old.photo_path is not null) execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.job_materials
  for each row when (old.photo_path is distinct from new.photo_path) execute function private.trash_removed_files();
create trigger trash_files after delete on public.measurements
  for each row when (old.snapshot_path is not null) execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.measurements
  for each row when (old.snapshot_path is distinct from new.snapshot_path) execute function private.trash_removed_files();
create trigger trash_files after delete on public.chat_messages
  for each row execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.chat_messages
  for each row when (old.attachments is distinct from new.attachments) execute function private.trash_removed_files();

-- Paperwork put back from the Trash (drive_restore) is as it was: who sent it, whether the office
-- checked it, and what replaced it (if that's still there); no "sent us their..." notice either.
-- As 20261025002004_sub_paperwork_sign_ins.sql and 20261025001002_sub_paperwork_reminders.sql
-- otherwise.
create or replace function private.sub_document_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_today date;
  v_file record;
begin
  perform 1 from public.subcontractors where id = new.subcontractor_id for no key update;
  if private.trashing() then
    if new.superseded_by is null or not exists (select 1 from public.sub_documents d where d.id = new.superseded_by) then
      new.superseded_at := null;
      new.superseded_by := null;
    end if;
    return new;
  end if;
  if (select auth.uid()) is not null then
    new.uploaded_by := (select auth.uid());
    if private.has_role(new.company_id, '{owner,admin,office}') and private.has_perm(new.company_id, 'subs') then
      new.uploaded_via := 'office';
      new.verified_at := now();
      new.verified_by := (select auth.uid());
    else
      -- The sub themselves (sub_documents_sub_insert lets them add only their own; anyone else is
      -- refused by it, so these checks are for their own).
      new.uploaded_via := 'sub';
      new.verified_at := null;
      new.verified_by := null;
      if (new.company_id, new.subcontractor_id) not in (select m.company_id, m.subcontractor_id from private.my_subs() m) then
        return new;
      end if;
      v_today := private.company_today(new.company_id);
      if new.expires_on < v_today then
        raise exception 'That date has already passed. Check it, or send the newer one.' using errcode = '22023';
      end if;
      if new.kind not in ('license', 'other') and new.expires_on > v_today + 5 * 366 then
        raise exception 'Check the date it ends. It''s more than five years away.' using errcode = '22023';
      end if;
      select o.metadata ->> 'mimetype' as type, o.metadata ->> 'size' as size into v_file
      from storage.objects o
      where o.bucket_id = 'files' and o.name = new.path and o.owner = (select auth.uid());
      if not found then
        raise exception 'Send the file first, then try again.' using errcode = '22023';
      end if;
      if lower(split_part(coalesce(v_file.type, ''), ';', 1)) not in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp') then
        raise exception 'Send a PDF or a photo (JPG, PNG or HEIC).' using errcode = '22023';
      end if;
      new.content_type := lower(split_part(v_file.type, ';', 1));
      new.size_bytes := case when v_file.size ~ '^[0-9]{1,15}$' then v_file.size::bigint end;
      if (select count(*) from public.sub_documents d
          where d.subcontractor_id = new.subcontractor_id and d.uploaded_via = 'sub' and d.created_at > now() - interval '1 day') >= 20 then
        raise exception 'That''s a lot sent today. Try again tomorrow, or call the office.' using errcode = '22023';
      end if;
    end if;
  end if;
  new.alerted_state := null;
  new.superseded_at := null;
  new.superseded_by := null;
  return new;
end $$;

create or replace function private.sub_document_received() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_sub text := (select name from public.subcontractors where id = new.subcontractor_id);
begin
  if private.trashing() then
    return null;
  end if;
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, o.user_id, 'subs',
    format('%s sent %s %s', v_sub, case when new.kind in ('w9', 'license', 'other') then 'a' else 'their' end,
      case when new.kind = 'other' then 'document' else private.sub_document_words(new.kind) end),
    'Have a look and verify it.', '/subs/' || new.subcontractor_id
  from private.subs_office(new.company_id) as o(user_id);
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Stored files: nobody signed in deletes one
-- ---------------------------------------------------------------------------------------------

-- Taking a photo, a document or a file out moves it to the Trash (above); the server deletes it 30
-- days later. The restrictive rules on deleting stay, and say no to everyone signed in anyway.
drop policy files_delete on storage.objects;
drop policy files_sub_delete on storage.objects;

-- ---------------------------------------------------------------------------------------------
-- Moving files and folders to the Trash, and back
-- ---------------------------------------------------------------------------------------------

-- A whole file, every version of it, with one moment (now()) so drive_restore finds them together.
-- The office, or a crew lead who added every version (as removing one used to be). Returns how many
-- versions went.
create function public.drive_trash_file(p_file uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  f public.plan_files;
  v_ids uuid[];
  v_count integer;
begin
  select * into f from public.plan_files where id = p_file;
  if not found or f.deleted_at is not null or not private.is_member(f.company_id) then
    raise exception 'That file wasn''t found. It may already be in the Trash.' using errcode = '22023';
  end if;
  -- Held, so no new version slips in meanwhile.
  perform 1 from public.plan_files x where x.id in (select private.drive_chain(f.id)) for update;
  v_ids := array(select private.drive_chain(f.id));
  if not private.has_role(f.company_id, '{owner,admin,office,estimator}')
     and not (private.has_role(f.company_id, '{crew_lead}')
              and not exists (select 1 from public.plan_files x where x.id = any (v_ids) and x.created_by is distinct from (select auth.uid()))) then
    raise exception 'Only the office, or the crew lead who added every version of it, can move this file to the Trash.' using errcode = '42501';
  end if;
  perform set_config('crewtavo.trash', 'on', true);
  update public.plan_files set deleted_at = now(), deleted_by = (select auth.uid())
  where id = any (v_ids) and deleted_at is null;
  get diagnostics v_count = row_count;
  perform set_config('crewtavo.trash', 'off', true);
  return v_count;
end $$;

-- Only the newest version, when there's an older one: it goes in the Trash on its own, and the one
-- before is the current version again. The office, or the crew lead who added that version. Returns
-- the version that's current now.
create function public.drive_trash_version(p_file uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  f public.plan_files;
begin
  select * into f from public.plan_files where id = p_file for update;
  if not found or f.deleted_at is not null or not private.is_member(f.company_id) then
    raise exception 'That file wasn''t found. It may already be in the Trash.' using errcode = '22023';
  end if;
  if not private.has_role(f.company_id, '{owner,admin,office,estimator}')
     and not (private.has_role(f.company_id, '{crew_lead}') and f.created_by = (select auth.uid())) then
    raise exception 'Only the office, or the crew lead who added this version, can move it to the Trash.' using errcode = '42501';
  end if;
  if f.superseded_at is not null then
    raise exception 'Only the newest version can go in the Trash on its own.' using errcode = '22023';
  end if;
  if f.replaces_id is null then
    raise exception 'This is the only version. Move the whole file to the Trash instead.' using errcode = '22023';
  end if;
  perform 1 from public.plan_files where id = f.replaces_id for update;
  perform set_config('crewtavo.trash', 'on', true);
  update public.plan_files
  set deleted_at = now(), deleted_by = (select auth.uid()), trashed_from = replaces_id, replaces_id = null
  where id = f.id;
  update public.plan_files set superseded_at = null where id = f.replaces_id;
  perform set_config('crewtavo.trash', 'off', true);
  return f.replaces_id;
end $$;

-- A folder, with every folder in it and every file in those (all their versions), with one moment.
-- The office. Company files stays. Returns how many file versions went with it.
create function public.drive_trash_folder(p_folder uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  d public.drive_folders;
  v_tree uuid[];
  v_count integer;
begin
  select * into d from public.drive_folders where id = p_folder for update;
  if not found or d.deleted_at is not null or not private.is_member(d.company_id) then
    raise exception 'That folder wasn''t found. It may already be in the Trash.' using errcode = '22023';
  end if;
  if not private.has_role(d.company_id, '{owner,admin,office,estimator}') then
    raise exception 'Only the office can move folders to the Trash.' using errcode = '42501';
  end if;
  if d.parent_id is null then
    raise exception 'Company files can''t go in the Trash.' using errcode = '22023';
  end if;
  v_tree := array(
    with recursive tree as (
      select d.id
      union
      select c.id from public.drive_folders c join tree t on c.parent_id = t.id where c.deleted_at is null
    )
    select tree.id from tree
  );
  perform set_config('crewtavo.trash', 'on', true);
  update public.drive_folders set deleted_at = now(), deleted_by = (select auth.uid())
  where id = any (v_tree) and deleted_at is null;
  update public.plan_files x set deleted_at = now(), deleted_by = (select auth.uid())
  where x.deleted_at is null and x.id in (
    with recursive chain as (
      select f.id, f.replaces_id from public.plan_files f
      where f.company_id = d.company_id and f.folder_id = any (v_tree) and f.deleted_at is null
      union
      select f.id, f.replaces_id from public.plan_files f join chain c on f.replaces_id = c.id or f.id = c.replaces_id
      where f.company_id = d.company_id and f.deleted_at is null
    )
    select chain.id from chain
  );
  get diagnostics v_count = row_count;
  perform set_config('crewtavo.trash', 'off', true);
  return v_count;
end $$;

-- Who may see (and restore) a stored file in the Trash: as who could see it where it was. Receipts:
-- the job costs area or whoever took it out. Paperwork and résumés: the office with the subs or
-- hiring area. Everything else: the office, or whoever took it out. A measurement's picture and chat
-- photos aren't listed; they're only kept.
create function private.trashed_file_visible(t public.trashed_files) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_member(t.company_id) and case t.source
    when 'measurement_snapshot' then false
    when 'chat_file' then false
    when 'receipt' then private.has_perm(t.company_id, 'job_costs') or t.deleted_by = (select auth.uid())
    when 'sub_document' then private.has_role(t.company_id, '{owner,admin,office}') and private.has_perm(t.company_id, 'subs')
    when 'applicant_file' then private.has_role(t.company_id, '{owner,admin,office}') and private.has_perm(t.company_id, 'hiring')
    else private.has_role(t.company_id, '{owner,admin,office,estimator}') or t.deleted_by = (select auth.uid())
  end
$$;
revoke all on function private.trashed_file_visible(public.trashed_files) from public;

-- Whether a stored file from elsewhere can go back where it was now (drive_restore puts its row
-- back): a photo on its visit or quote, paperwork with its sub, a résumé on its applicant (who has
-- room for it, or lists it already), a receipt on its expense (which has no other receipt).
create function private.trashed_file_goes_back(t public.trashed_files) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when t.restore is null and t.source <> 'receipt' then false
    when t.source in ('visit_photo', 'quote_photo') then
      (t.restore ->> 'owner_type' = 'visit' and exists (select 1 from public.visits v where v.id = (t.restore ->> 'owner_id')::uuid and v.company_id = t.company_id))
      or (t.restore ->> 'owner_type' = 'quote' and exists (select 1 from public.quotes q where q.id = (t.restore ->> 'owner_id')::uuid and q.company_id = t.company_id))
    when t.source = 'sub_document' then
      exists (select 1 from public.subcontractors s where s.id = (t.restore ->> 'subcontractor_id')::uuid and s.company_id = t.company_id)
    when t.source = 'applicant_file' then
      exists (select 1 from public.job_applicants a where a.id = (t.restore ->> 'applicant_id')::uuid and a.company_id = t.company_id
        and (jsonb_array_length(a.files) < 5 or a.files @> jsonb_build_array(jsonb_build_object('path', t.path))))
    when t.source = 'receipt' then
      exists (select 1 from public.expenses e where e.id = t.source_id and e.company_id = t.company_id and (e.receipt_path is null or e.receipt_path = t.path))
    else false
  end
$$;
revoke all on function private.trashed_file_goes_back(public.trashed_files) from public;

/**
 * What Restore does with a stored file from elsewhere, for the person asking (drive_trash's restore;
 * drive_restore does the same):
 *   'back'      it goes back where it was
 *   'drive'     where it was is gone, so it's copied into Company files (POST /api/drive/trash/:id/
 *               to-drive): for the office, and never paperwork, résumés or receipts, which only some
 *               people may see while Company files are for the whole office
 *   'download'  where it was is gone, and it can't go into Drive for them: they download it instead
 *   'none'      nothing they can do (a receipt they took out but may not open)
 */
create function private.trashed_file_restore(t public.trashed_files) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when private.trashed_file_goes_back(t) then 'back'
    when t.source not in ('sub_document', 'applicant_file', 'receipt') and private.has_role(t.company_id, '{owner,admin,office,estimator}') then 'drive'
    -- As storage's files_read lets them open it: a receipt is the job costs area's, or its uploader's.
    when t.source <> 'receipt' or private.has_perm(t.company_id, 'job_costs')
      or exists (select 1 from storage.objects o where o.bucket_id = 'files' and o.name = t.path and o.owner = (select auth.uid())) then 'download'
    else 'none'
  end
$$;
revoke all on function private.trashed_file_restore(public.trashed_files) from public;

-- Where a file is, in a few words: "Job #12 · 14 Oak St", "Company files › Forms".
create function private.drive_where(f public.plan_files) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_place text;
  v_line text;
begin
  select nullif(trim(p.line1), '') into v_line from public.properties p where p.id = f.property_id;
  select 'Job #' || j.number into v_place from public.jobs j where j.id = f.job_id;
  if v_place is null then
    select 'Quote #' || q.number into v_place from public.quotes q where q.id = f.quote_id;
  end if;
  if v_place is null then
    select 'Request #' || r.number into v_place from public.requests r where r.id = f.request_id;
  end if;
  if v_place is not null or v_line is not null then
    return concat_ws(' · ', v_place, v_line);
  end if;
  return coalesce(private.drive_folder_path(f.folder_id), 'What it was on was deleted');
end $$;
revoke all on function private.drive_where(public.plan_files) from public;

/**
 * What's in the Trash, newest first (at most 500): files (one row for each, with its newest version's
 * name and how many versions went with it), single versions, folders moved there themselves (what was
 * in them comes back with them), and stored files from elsewhere ("other"). The office sees Drive's;
 * everyone else what they moved there themselves; stored files from elsewhere as trashed_file_visible
 * says. purge_at is when the server deletes it for good. restore is what Restore does for the person
 * asking: 'back' where it was (always, for Drive's own), or for a stored file from elsewhere whose
 * place is gone, 'drive' (copied into Company files), 'download' (they download it instead) or
 * 'none' (trashed_file_restore).
 */
create function public.drive_trash(p_company uuid)
returns table (kind text, id uuid, name text, detail text, content_type text, size_bytes bigint, path text, versions integer,
  deleted_at timestamptz, deleted_by uuid, deleted_by_name text, purge_at timestamptz, restore text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_office boolean := private.has_role(p_company, '{owner,admin,office,estimator}');
  v_me uuid := (select auth.uid());
begin
  if not private.is_member(p_company) then
    return;
  end if;
  return query
  select y.kind, y.id, y.name, y.detail, y.content_type, y.size_bytes, y.path, y.versions, y.deleted_at, y.deleted_by,
    (select nullif(trim(pr.full_name), '') from public.profiles pr where pr.user_id = y.deleted_by),
    y.deleted_at + interval '30 days',
    case when y.kind = 'other' then (select private.trashed_file_restore(t) from public.trashed_files t where t.id = y.id) else 'back' end
  from (
  select x.* from (
    select 'file'::text as kind, f.id, f.title as name, private.drive_where(f) as detail, f.content_type, f.size_bytes, f.path,
      (select count(*)::integer from private.drive_chain(f.id)) as versions, f.deleted_at, f.deleted_by
    from public.plan_files f
    where f.company_id = p_company and f.deleted_at is not null and f.trashed_from is null
      and (v_office or f.deleted_by = v_me)
      -- The newest of what went together, and not what went with a folder.
      and not exists (select 1 from public.plan_files n where n.replaces_id = f.id and n.deleted_at = f.deleted_at)
      and not exists (select 1 from public.drive_folders d where d.id = f.folder_id and d.deleted_at = f.deleted_at)
    union all
    select 'version', f.id, f.title, concat_ws(' · ', 'Newest version', private.drive_where(f)), f.content_type, f.size_bytes, f.path,
      1, f.deleted_at, f.deleted_by
    from public.plan_files f
    where f.company_id = p_company and f.deleted_at is not null and f.trashed_from is not null
      and (v_office or f.deleted_by = v_me)
    union all
    select 'folder', d.id, d.name, private.drive_folder_path(d.parent_id), null, null, null,
      (select count(*)::integer from public.plan_files f
       where f.company_id = p_company and f.deleted_at = d.deleted_at and f.superseded_at is null
         and f.folder_id in (select s.id from public.drive_folders s where s.company_id = p_company and s.deleted_at = d.deleted_at)),
      d.deleted_at, d.deleted_by
    from public.drive_folders d
    where d.company_id = p_company and d.deleted_at is not null
      and (v_office or d.deleted_by = v_me)
      and not exists (select 1 from public.drive_folders p where p.id = d.parent_id and p.deleted_at = d.deleted_at)
    union all
    select 'other', t.id, t.file_name, t.label, t.content_type, t.size_bytes, t.path, 1, t.deleted_at, t.deleted_by
    from public.trashed_files t
    where t.company_id = p_company and private.trashed_file_visible(t)
  ) x
  order by x.deleted_at desc, x.name
  limit 500
  ) y
  order by y.deleted_at desc, y.name;
end $$;

/**
 * Back out of the Trash: 'file' (every version that went with it), 'version' (back as the newest
 * version when the one it replaced is still the newest, else as a file of its own), 'folder' (with
 * everything that went with it; in Company files when where it was is gone, and "Name (restored)"
 * next to a folder of the same name), or 'other' (a stored file from elsewhere: a photo or paperwork
 * back on its visit, quote or sub, a résumé back on the applicant, a receipt back on its expense;
 * one already back in use some other way just leaves the Trash). A file on nothing, or in a folder
 * that's gone, comes back in Company files. The office, or whoever moved it there.
 *
 * Returns 'restored', or 'needs_copy' for a stored file from elsewhere that has nowhere to go back to
 * and that the office may copy into Drive (POST /api/drive/trash/:id/to-drive; trashed_file_restore
 * says 'drive'). Paperwork, résumés and receipts never go into Drive, and nobody else copies into it:
 * for those it says to download the file from the Trash instead (22023). It refuses what the person
 * can't see, so 'needs_copy' also says they may.
 */
create function public.drive_restore(p_kind text, p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  f public.plan_files;
  p public.plan_files;
  d public.drive_folders;
  t public.trashed_files;
  v_me uuid := (select auth.uid());
  v_root uuid;
  v_ids uuid[];
  v_level uuid[];
  v_tree uuid[];
  v_parent uuid;
  v_name text;
  v_n integer := 1;
  v_count integer := 0;
  v_how text;
begin
  if p_kind in ('file', 'version') then
    select * into f from public.plan_files where id = p_id for update;
    if not found or f.deleted_at is null or not private.is_member(f.company_id) then
      raise exception 'That file isn''t in the Trash.' using errcode = '22023';
    end if;
    if not (private.has_role(f.company_id, '{owner,admin,office,estimator}') or f.deleted_by = v_me) then
      raise exception 'Only the office, or whoever moved it to the Trash, can restore it.' using errcode = '42501';
    end if;
    perform set_config('crewtavo.trash', 'on', true);
    v_root := private.drive_root_folder(f.company_id);
    if f.trashed_from is not null then
      select * into p from public.plan_files where id = f.trashed_from and company_id = f.company_id for update;
      if found and p.deleted_at is null and p.superseded_at is null then
        -- Back as the newest version, wherever the file is now.
        update public.plan_files set superseded_at = now() where id = p.id;
        update public.plan_files
        set deleted_at = null, deleted_by = null, replaces_id = p.id, trashed_from = null,
          property_id = p.property_id, request_id = p.request_id, quote_id = p.quote_id, job_id = p.job_id, folder_id = p.folder_id
        where id = f.id;
        perform set_config('crewtavo.trash', 'off', true);
        return 'restored';
      end if;
      v_ids := array[f.id];
    else
      v_ids := array(select private.drive_chain(f.id));
    end if;
    update public.plan_files x
    set deleted_at = null, deleted_by = null, trashed_from = null,
      folder_id = case
        when x.property_id is null and x.request_id is null and x.quote_id is null and x.job_id is null
         and not exists (select 1 from public.drive_folders o where o.id = x.folder_id and o.deleted_at is null) then v_root
        else x.folder_id
      end
    where x.id = any (v_ids);
    perform set_config('crewtavo.trash', 'off', true);
    return 'restored';

  elsif p_kind = 'folder' then
    select * into d from public.drive_folders where id = p_id for update;
    if not found or d.deleted_at is null or not private.is_member(d.company_id) then
      raise exception 'That folder isn''t in the Trash.' using errcode = '22023';
    end if;
    if not (private.has_role(d.company_id, '{owner,admin,office,estimator}') or d.deleted_by = v_me) then
      raise exception 'Only the office can restore folders.' using errcode = '42501';
    end if;
    perform set_config('crewtavo.trash', 'on', true);
    v_root := private.drive_root_folder(d.company_id);
    v_parent := case when exists (select 1 from public.drive_folders o where o.id = d.parent_id and o.deleted_at is null) then d.parent_id else v_root end;
    v_name := d.name;
    while exists (
      select 1 from public.drive_folders s
      where s.company_id = d.company_id and s.parent_id = v_parent and s.id <> d.id and s.deleted_at is null and lower(s.name) = lower(v_name)
    ) loop
      v_name := left(d.name, 100) || case when v_n = 1 then ' (restored)' else ' (restored ' || v_n || ')' end;
      v_n := v_n + 1;
    end loop;
    update public.drive_folders set deleted_at = null, deleted_by = null, parent_id = v_parent, name = v_name where id = d.id;
    -- Its folders, a level at a time, so each comes back into one that's back.
    v_tree := array[d.id];
    v_level := array[d.id];
    loop
      with back as (
        update public.drive_folders c set deleted_at = null, deleted_by = null
        where c.parent_id = any (v_level) and c.deleted_at = d.deleted_at
        returning c.id
      )
      select array_agg(back.id) into v_level from back;
      exit when v_level is null;
      v_tree := v_tree || v_level;
    end loop;
    update public.plan_files x set deleted_at = null, deleted_by = null
    where x.id in (
      with recursive chain as (
        select pf.id, pf.replaces_id from public.plan_files pf
        where pf.company_id = d.company_id and pf.deleted_at = d.deleted_at and pf.folder_id = any (v_tree)
        union
        select pf.id, pf.replaces_id from public.plan_files pf join chain c on pf.replaces_id = c.id or pf.id = c.replaces_id
        where pf.company_id = d.company_id and pf.deleted_at = d.deleted_at
      )
      select chain.id from chain
    );
    perform set_config('crewtavo.trash', 'off', true);
    return 'restored';

  elsif p_kind = 'other' then
    select * into t from public.trashed_files where id = p_id for update;
    if not found or not private.trashed_file_visible(t) then
      raise exception 'That file isn''t in the Trash.' using errcode = '22023';
    end if;
    perform set_config('crewtavo.trash', 'on', true);
    if t.source in ('visit_photo', 'quote_photo') and t.restore is not null then
      -- Back on its visit or quote, while that's there.
      if (t.restore ->> 'owner_type' = 'visit' and exists (select 1 from public.visits v where v.id = (t.restore ->> 'owner_id')::uuid and v.company_id = t.company_id))
         or (t.restore ->> 'owner_type' = 'quote' and exists (select 1 from public.quotes q where q.id = (t.restore ->> 'owner_id')::uuid and q.company_id = t.company_id)) then
        insert into public.attachments (id, company_id, owner_type, owner_id, path, file_name, content_type, size_bytes, caption, created_by, created_at)
        select a.id, t.company_id, a.owner_type, a.owner_id, t.path, a.file_name, a.content_type, a.size_bytes, a.caption, a.created_by, a.created_at
        from jsonb_populate_record(null::public.attachments, t.restore) a
        on conflict do nothing;
        get diagnostics v_count = row_count;
      end if;
    elsif t.source = 'sub_document' and t.restore is not null then
      -- Back with the sub, while the sub is there, as it was (sub_document_defaults).
      if exists (select 1 from public.subcontractors s where s.id = (t.restore ->> 'subcontractor_id')::uuid and s.company_id = t.company_id) then
        insert into public.sub_documents (id, company_id, subcontractor_id, kind, title, path, file_name, content_type, size_bytes, carrier, policy_number,
          starts_on, expires_on, verified_at, verified_by, superseded_at, superseded_by, alerted_state, uploaded_by, uploaded_via, created_at)
        select x.id, t.company_id, x.subcontractor_id, x.kind, x.title, t.path, x.file_name, x.content_type, x.size_bytes, x.carrier, x.policy_number,
          x.starts_on, x.expires_on, x.verified_at, x.verified_by, x.superseded_at, x.superseded_by, x.alerted_state, x.uploaded_by, x.uploaded_via, x.created_at
        from jsonb_populate_record(null::public.sub_documents, t.restore) x
        on conflict do nothing;
        get diagnostics v_count = row_count;
      end if;
    elsif t.source = 'applicant_file' and t.restore is not null then
      -- Back on the applicant, while they're there and have room for it (five files at most).
      update public.job_applicants a set files = a.files || jsonb_build_array(t.restore -> 'file')
      where a.id = (t.restore ->> 'applicant_id')::uuid and a.company_id = t.company_id
        and jsonb_array_length(a.files) < 5
        and not exists (select 1 from jsonb_array_elements(a.files) e where e ->> 'path' = t.path);
      get diagnostics v_count = row_count;
    elsif t.source = 'receipt' then
      -- Back on its expense, while that's there with no receipt of its own.
      update public.expenses e set receipt_path = t.path
      where e.id = t.source_id and e.company_id = t.company_id and e.receipt_path is null;
      get diagnostics v_count = row_count;
    end if;
    -- Already back in use some other way (an older copy of a page saved it again): it just leaves
    -- the Trash.
    if v_count = 0 and private.stored_path_in_use(t.company_id, t.path) then
      v_count := 1;
    end if;
    perform set_config('crewtavo.trash', 'off', true);
    if v_count > 0 then
      delete from public.trashed_files where id = t.id;
      return 'restored';
    end if;
    -- Nowhere to go back to: into Drive, by the office, or downloaded from the Trash instead.
    v_how := private.trashed_file_restore(t);
    if v_how = 'drive' then
      return 'needs_copy';
    elsif v_how = 'none' then
      raise exception 'This file can''t go back where it was. Ask someone who sees job costs to download it from the Trash.' using errcode = '22023';
    elsif t.source = 'applicant_file' and exists (select 1 from public.job_applicants a where a.id = (t.restore ->> 'applicant_id')::uuid and a.company_id = t.company_id) then
      raise exception 'The applicant already has 5 files. Take one off and restore this again, or download it from the Trash.' using errcode = '22023';
    elsif t.source = 'receipt' and exists (select 1 from public.expenses e where e.id = t.source_id and e.company_id = t.company_id) then
      raise exception 'Its expense has another receipt now. Download this one from the Trash instead.' using errcode = '22023';
    end if;
    raise exception 'This file can''t go back where it was, because that was deleted. Download it from the Trash instead.' using errcode = '22023';
  end if;
  raise exception 'Choose a file, a version, a folder or another file to restore.' using errcode = '22023';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Deleting for good (the server, or an owner through it)
-- ---------------------------------------------------------------------------------------------
-- The database decides what goes: each function deletes rows still in the Trash, checking that in
-- the same statement (so one restored meanwhile stays, and one deleted first can't be restored), then
-- returns the stored files nothing uses any more. The server removes exactly those afterwards; one
-- Storage won't remove is left behind, never a row pointing at a file that's gone.

-- Whether a folder holds one in use, at any depth (deleting a folder deletes the folders in it).
create function private.drive_folder_holds_live(p_folder uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive below as (
    select c.id, c.deleted_at, 1 as n from public.drive_folders c where c.parent_id = p_folder
    union all
    select c.id, c.deleted_at, b.n + 1 from public.drive_folders c join below b on c.parent_id = b.id where b.n < 25
  )
  select exists (select 1 from below where below.deleted_at is null)
$$;
revoke all on function private.drive_folder_holds_live(uuid) from public;

/**
 * The nightly purge (apps/api/src/services/planFiles.ts, purgeTrash): what went in the Trash before
 * p_cutoff (30 days ago at the latest), deleted for good, about p_limit of each at a time: plan files
 * (everything that went at one moment together, every version, so no file is left half there), then
 * folders (not one holding a folder in use), then the stored files of everything else. Returns a row
 * for each of those (source) and company: how many rows went, and the stored files for the server to
 * remove, only those nothing else uses (none for a folder). A row a company, from 300 companies at
 * most each time, so the answer is never cut short by PostgREST (1000 rows at most): every file the
 * rows deleted had comes back, however many there were. The server's alone; it calls again until
 * nothing comes back.
 */
create function public.trash_purge(p_cutoff timestamptz, p_limit integer default 1000)
returns table (source text, company_id uuid, deleted integer, paths text[])
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_cutoff timestamptz := least(coalesce(p_cutoff, '-infinity'), now() - interval '30 days');
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  -- Companies at a time (a row each from each of the three).
  v_firms constant integer := 300;
  v_companies uuid[];
  v_paths text[];
begin
  with due as (
    select distinct f.company_id, f.deleted_at from public.plan_files f
    where f.deleted_at < v_cutoff
    order by f.deleted_at
    limit v_limit
  ), firms as (
    select d.company_id from due d group by d.company_id order by min(d.deleted_at) limit v_firms
  ), gone as (
    delete from public.plan_files f using due m
    where f.company_id = m.company_id and f.deleted_at = m.deleted_at and f.deleted_at < v_cutoff
      and m.company_id in (select firms.company_id from firms)
    returning f.company_id, f.path
  )
  select coalesce(array_agg(gone.company_id), '{}'), coalesce(array_agg(gone.path), '{}') into v_companies, v_paths from gone;
  return query
  select 'plan_files'::text, x.c, count(*)::integer, coalesce(array_agg(x.p) filter (where not private.stored_path_in_use(x.c, x.p)), '{}')
  from unnest(v_companies, v_paths) as x(c, p)
  group by x.c;

  with picked as (
    select d.id, d.company_id, d.deleted_at from public.drive_folders d
    where d.deleted_at < v_cutoff and not private.drive_folder_holds_live(d.id)
    order by d.deleted_at
    limit v_limit
  ), firms as (
    select p.company_id from picked p group by p.company_id order by min(p.deleted_at) limit v_firms
  ), gone as (
    delete from public.drive_folders d using picked p
    where d.id = p.id and d.deleted_at < v_cutoff and p.company_id in (select firms.company_id from firms)
    returning d.company_id
  )
  select coalesce(array_agg(gone.company_id), '{}') into v_companies from gone;
  return query
  select 'drive_folders'::text, x.c, count(*)::integer, '{}'::text[]
  from unnest(v_companies) as x(c)
  group by x.c;

  with picked as (
    select t.id, t.company_id, t.deleted_at from public.trashed_files t
    where t.deleted_at < v_cutoff
    order by t.deleted_at
    limit v_limit
  ), firms as (
    select p.company_id from picked p group by p.company_id order by min(p.deleted_at) limit v_firms
  ), gone as (
    delete from public.trashed_files t using picked p
    where t.id = p.id and t.deleted_at < v_cutoff and p.company_id in (select firms.company_id from firms)
    returning t.company_id, t.path
  )
  select coalesce(array_agg(gone.company_id), '{}'), coalesce(array_agg(gone.path), '{}') into v_companies, v_paths from gone;
  return query
  select 'trashed_files'::text, x.c, count(*)::integer, coalesce(array_agg(x.p) filter (where not private.stored_path_in_use(x.c, x.p)), '{}')
  from unnest(v_companies, v_paths) as x(c, p)
  group by x.c;
end $$;

/**
 * Delete forever, before the 30 days are up: an owner's "Delete forever" or "Empty Trash", through
 * POST /api/drive/trash/delete-forever. p_items are drive_trash's items ([{kind, id}], 200 at most):
 * a file with every version that went with it, a single version, a folder with the folders and files
 * that went with it, or a stored file from elsewhere. Only what's in the Trash, never anything in use;
 * several files moved there at the same moment (a client deleted) stay separate items. Returns a row
 * for each item deleted (kind, id), so 200 at most, with its stored files for the server to remove:
 * only those nothing else uses (none for a folder that had no files, or a file still in use). One row
 * an item, so the answer is never cut short by PostgREST (1000 rows at most), however many files a
 * folder held. Owners only.
 */
create function public.trash_delete_forever(p_company uuid, p_items jsonb)
returns table (kind text, id uuid, paths text[])
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_item record;
  v_at timestamptz;
  v_tree uuid[];
  v_paths text[];
  v_count integer;
  t public.trashed_files;
begin
  if not private.has_role(p_company, '{owner}') then
    raise exception 'Only owners can delete things for good.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'Choose up to 200 things to delete at a time.' using errcode = '22023';
  end if;
  for v_item in
    select distinct e ->> 'kind' as kind, (e ->> 'id')::uuid as id
    from jsonb_array_elements(p_items) e
    where jsonb_typeof(e) = 'object' and e ->> 'kind' in ('file', 'version', 'folder', 'other')
      and e ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  loop
    v_paths := null;
    v_count := 0;
    if v_item.kind in ('file', 'version') then
      -- Held, as drive_restore holds it, so the two go one after the other.
      select f.deleted_at into v_at from public.plan_files f
      where f.id = v_item.id and f.company_id = p_company and f.deleted_at is not null
      for update;
      continue when not found;
      with gone as (
        delete from public.plan_files f
        where f.id in (select private.drive_chain(v_item.id)) and f.company_id = p_company and f.deleted_at = v_at
        returning f.path
      )
      select array_agg(gone.path) into v_paths from gone;
      continue when v_paths is null;
    elsif v_item.kind = 'folder' then
      select d.deleted_at into v_at from public.drive_folders d
      where d.id = v_item.id and d.company_id = p_company and d.deleted_at is not null
      for update;
      continue when not found;
      v_tree := array(
        with recursive tree as (
          select v_item.id as id
          union
          select c.id from public.drive_folders c join tree x on c.parent_id = x.id where c.deleted_at = v_at
        )
        select tree.id from tree
      );
      if private.drive_folder_holds_live(v_item.id) then
        raise exception 'A folder in the Trash still has a folder in use inside it. Restore it and move that folder out first.' using errcode = '22023';
      end if;
      with gone as (
        delete from public.plan_files f
        where f.company_id = p_company and f.deleted_at = v_at and f.id in (
          with recursive chain as (
            select x.id, x.replaces_id from public.plan_files x where x.company_id = p_company and x.deleted_at = v_at and x.folder_id = any (v_tree)
            union
            select x.id, x.replaces_id from public.plan_files x join chain c on x.replaces_id = c.id or x.id = c.replaces_id
            where x.company_id = p_company and x.deleted_at = v_at
          )
          select chain.id from chain
        )
        returning f.path
      )
      select array_agg(gone.path) into v_paths from gone;
      delete from public.drive_folders d where d.id = any (v_tree) and d.company_id = p_company and d.deleted_at = v_at;
      get diagnostics v_count = row_count;
      continue when v_count = 0;
    else
      select * into t from public.trashed_files x where x.id = v_item.id and x.company_id = p_company for update;
      continue when not found or not private.trashed_file_visible(t);
      delete from public.trashed_files x where x.id = t.id;
      v_paths := array[t.path];
    end if;
    return query
    select v_item.kind, v_item.id, coalesce(array_agg(x.p) filter (where x.p is not null and not private.stored_path_in_use(p_company, x.p)), '{}')
    from unnest(coalesce(v_paths, '{}')) as x(p);
  end loop;
end $$;

/**
 * A stored file from elsewhere, copied into Drive (POST /api/drive/trash/:id/to-drive): out of the
 * Trash. Returns its path for the server to remove the original, or null when something else still
 * uses it (it stays) or it was no longer in the Trash. The server's alone.
 */
create function public.trash_copied_to_drive(p_company uuid, p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_path text;
begin
  delete from public.trashed_files t where t.id = p_id and t.company_id = p_company returning t.path into v_path;
  if v_path is null or private.stored_path_in_use(p_company, v_path) then
    return null;
  end if;
  return v_path;
end $$;

/**
 * Stored files nobody recorded, for the nightly tidy-up (apps/api/src/services/planFiles.ts,
 * tidyUnrecordedFiles): a guide's cover (kb/), or a photo for a quote or a visit (quote/, visit/),
 * uploaded for a save that then failed. Only in those three folders, only stored over a day ago (an
 * upload may still be on its way to its row), only ones nothing uses (stored_path_in_use) and not in
 * the Trash (it deletes its own after 30 days). Returns them for the server to remove, a row a
 * company, p_limit at a time (1000 at most, so never more rows than PostgREST hands back). The
 * server's alone; it calls again while a full p_limit comes back.
 */
create function public.unrecorded_files(p_limit integer default 1000)
returns table (company_id uuid, paths text[])
language sql stable security definer set search_path = '' as $$
  -- What no photo, cover or file in the Trash names, first (a quick look each), and only those asked
  -- about everywhere else.
  with unnamed as materialized (
    select private.path_company(o.name) as company_id, o.name
    from storage.objects o
    where o.bucket_id = 'files'
      and split_part(o.name, '/', 2) in ('kb', 'quote', 'visit')
      and o.created_at < now() - interval '1 day'
      and o.name !~ '(^|/)\.\.?(/|$)'
      and not exists (select 1 from public.attachments a where a.path = o.name)
      and not exists (select 1 from public.sop_pages s where s.cover_path = o.name)
      and not exists (select 1 from public.trashed_files t where t.path = o.name)
  )
  select x.company_id, array_agg(x.name order by x.name)
  from (
    select u.company_id, u.name from unnamed u
    where exists (select 1 from public.companies c where c.id = u.company_id)
      and not private.stored_path_in_use(u.company_id, u.name)
    limit least(greatest(coalesce(p_limit, 1000), 1), 1000)
  ) x
  group by x.company_id
$$;

revoke execute on function public.trash_purge(timestamptz, integer), public.trash_copied_to_drive(uuid, uuid), public.unrecorded_files(integer) from public, anon, authenticated;
grant execute on function public.trash_purge(timestamptz, integer), public.trash_copied_to_drive(uuid, uuid), public.unrecorded_files(integer) to service_role;
revoke execute on function public.trash_delete_forever(uuid, jsonb) from public, anon;
grant execute on function public.trash_delete_forever(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Lists for Drive's Files page (as the person reading them: row-level security decides)
-- ---------------------------------------------------------------------------------------------

-- How many versions of a file the person can see, from it back.
create function private.drive_version_count(p_file uuid) returns integer
language sql stable set search_path = '' as $$
  with recursive back as (
    select f.id, f.replaces_id from public.plan_files f where f.id = p_file
    union
    select o.id, o.replaces_id from public.plan_files o join back b on o.id = b.replaces_id
  )
  select count(*)::integer from back
$$;
revoke all on function private.drive_version_count(uuid) from public;
grant execute on function private.drive_version_count(uuid) to authenticated, service_role;

-- Each file the person can see, with where it is in words. Not in the Trash.
create view private.drive_files with (security_invoker = true) as
select
  f.company_id, f.id, f.title, f.file_name, f.content_type, f.size_bytes, f.path, f.revision, f.notes,
  f.crew_visible, f.archived, f.replaces_id, f.superseded_at, private.drive_version_count(f.id) as versions,
  f.folder_id, fo.name as folder_name,
  f.property_id, coalesce(nullif(trim(p.line1), ''), nullif(trim(p.label), '')) as property_label,
  cl.id as client_id, cl.display_name as client_name,
  f.request_id, r.title as request_title,
  f.quote_id, q.number as quote_number, q.title as quote_title,
  f.job_id, j.number as job_number, j.title as job_title,
  f.created_by, nullif(trim(pr.full_name), '') as created_by_name, f.created_at, f.updated_at
from public.plan_files f
left join public.drive_folders fo on fo.id = f.folder_id
left join public.properties p on p.id = f.property_id
left join public.requests r on r.id = f.request_id
left join public.quotes q on q.id = f.quote_id
left join public.jobs j on j.id = f.job_id
left join public.clients cl on cl.id = coalesce(j.client_id, q.client_id, r.client_id, p.client_id)
left join public.profiles pr on pr.user_id = f.created_by
where f.deleted_at is null;
revoke all on private.drive_files from public;
grant select on private.drive_files to authenticated, service_role;

/**
 * The current version of each file in a list, for the team:
 *   'folder'  in a company folder (p_id; Company files when it's empty), by name
 *   'client'  on a client's properties, requests, quotes and jobs (p_id is the client), by name
 *   'recent'  everything, newest first
 *   'search'  by name, file name, revision, notes, client, or job title or number (p_query), newest first
 */
create function public.drive_list(p_company uuid, p_scope text, p_id uuid default null, p_query text default null, p_limit integer default 200)
returns table (id uuid, title text, file_name text, content_type text, size_bytes bigint, path text, revision text, notes text,
  crew_visible boolean, archived boolean, replaces_id uuid, versions integer, folder_id uuid, folder_name text,
  property_id uuid, property_label text, client_id uuid, client_name text, request_id uuid, request_title text,
  quote_id uuid, quote_number bigint, quote_title text, job_id uuid, job_number bigint, job_title text,
  created_by uuid, created_by_name text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_q text := trim(coalesce(p_query, ''));
  v_like text;
  v_num bigint;
  v_folder uuid := p_id;
begin
  if p_scope is null or p_scope not in ('folder', 'client', 'recent', 'search') then
    raise exception 'Choose the folder, client, recent or search list.' using errcode = '22023';
  end if;
  if not private.is_member(p_company) or (p_scope = 'client' and p_id is null) or (p_scope = 'search' and length(v_q) = 0) then
    return;
  end if;
  if p_scope = 'folder' and v_folder is null then
    select d.id into v_folder from public.drive_folders d where d.company_id = p_company and d.parent_id is null;
  end if;
  if p_scope = 'search' then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_q ~ '^#?[0-9]{1,12}$' then
      v_num := ltrim(v_q, '#')::bigint;
    end if;
  end if;
  return query
  select r.id, r.title, r.file_name, r.content_type, r.size_bytes, r.path, r.revision, r.notes,
    r.crew_visible, r.archived, r.replaces_id, r.versions, r.folder_id, r.folder_name,
    r.property_id, r.property_label, r.client_id, r.client_name, r.request_id, r.request_title,
    r.quote_id, r.quote_number, r.quote_title, r.job_id, r.job_number, r.job_title,
    r.created_by, r.created_by_name, r.created_at, r.updated_at
  from private.drive_files r
  where r.company_id = p_company and r.superseded_at is null
    and case p_scope
      when 'folder' then r.folder_id = v_folder
      when 'client' then r.client_id = p_id
      when 'recent' then true
      else r.title ilike v_like or r.file_name ilike v_like or r.revision ilike v_like or r.notes ilike v_like
        or r.client_name ilike v_like or r.job_title ilike v_like or r.job_number = v_num or r.quote_number = v_num
    end
  order by case when p_scope in ('folder', 'client') then lower(r.title) end, r.created_at desc, r.id
  limit v_limit;
end $$;

-- Clients with files (current, not in the Trash), the most recently changed first; by name with
-- p_query.
create function public.drive_clients(p_company uuid, p_query text default null, p_limit integer default 100)
returns table (client_id uuid, client_name text, files integer, updated_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  v_q text := trim(coalesce(p_query, ''));
  v_like text;
begin
  if not private.is_member(p_company) then
    return;
  end if;
  if length(v_q) > 0 then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
  select r.client_id, max(r.client_name), count(*)::integer, max(r.updated_at)
  from private.drive_files r
  where r.company_id = p_company and r.superseded_at is null and r.client_id is not null
    and (v_like is null or r.client_name ilike v_like)
  group by r.client_id
  order by max(r.updated_at) desc, r.client_id
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- Every version of a file the person can see (not in the Trash), newest first.
create function public.drive_versions(p_file uuid)
returns table (id uuid, title text, file_name text, content_type text, size_bytes bigint, path text, revision text, notes text,
  crew_visible boolean, archived boolean, replaces_id uuid, versions integer, folder_id uuid, folder_name text,
  property_id uuid, property_label text, client_id uuid, client_name text, request_id uuid, request_title text,
  quote_id uuid, quote_number bigint, quote_title text, job_id uuid, job_number bigint, job_title text,
  created_by uuid, created_by_name text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  with recursive chain as (
    select f.id, f.replaces_id from public.plan_files f where f.id = p_file
    union
    select f.id, f.replaces_id from public.plan_files f join chain c on f.replaces_id = c.id or f.id = c.replaces_id
  )
  select r.id, r.title, r.file_name, r.content_type, r.size_bytes, r.path, r.revision, r.notes,
    r.crew_visible, r.archived, r.replaces_id, r.versions, r.folder_id, r.folder_name,
    r.property_id, r.property_label, r.client_id, r.client_name, r.request_id, r.request_title,
    r.quote_id, r.quote_number, r.quote_title, r.job_id, r.job_number, r.job_title,
    r.created_by, r.created_by_name, r.created_at, r.updated_at
  from private.drive_files r
  where r.id in (select chain.id from chain) and r.company_id = any ((select private.member_companies())::uuid[])
  order by r.created_at desc, r.id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Search finds files too
-- ---------------------------------------------------------------------------------------------

-- Search finds files by name (the current version, not in the Trash), said where they are, for the
-- team. As 20261019001500_search_everything.sql otherwise.
create or replace function public.global_search(p_company_id uuid, p_query text, p_limit integer default 5)
returns table (kind text, id uuid, title text, subtitle text, number bigint, status text, client_id uuid)
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_q text := trim(coalesce(p_query, ''));
  v_like text;
  v_num bigint;
  v_words tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
begin
  if length(v_q) = 0 then
    return;
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if v_q ~ '^#?[0-9]{1,12}$' then
    v_num := ltrim(v_q, '#')::bigint;
  end if;
  v_words := websearch_to_tsquery('english', v_q);

  return query
  (select 'client'::text, c.id, c.display_name, concat_ws(' · ', nullif(c.company_name, ''), c.email, c.phone), null::bigint, c.status, c.id
     from public.clients c
    where c.company_id = p_company_id
      and (c.display_name ilike v_like or c.company_name ilike v_like or c.email ilike v_like or c.phone ilike v_like)
    order by (c.status = 'archived'), (c.display_name ilike v_q || '%') desc, c.display_name
    limit v_limit)
  union all
  (select 'property'::text, p.id, p.line1, concat_ws(' · ', concat_ws(', ', p.city, p.region), cl.display_name), null::bigint, null::text, p.client_id
     from public.properties p join public.clients cl on cl.id = p.client_id
    where p.company_id = p_company_id and (p.line1 ilike v_like or p.label ilike v_like)
    order by p.line1
    limit v_limit)
  union all
  (select 'request'::text, r.id, r.title, cl.display_name, r.number, r.status, r.client_id
     from public.requests r join public.clients cl on cl.id = r.client_id
    where r.company_id = p_company_id and (r.number = v_num or r.title ilike v_like or cl.display_name ilike v_like)
    order by (r.number = v_num) desc nulls last, r.created_at desc
    limit v_limit)
  union all
  (select 'quote'::text, q.id, q.title, cl.display_name, q.number, q.status, q.client_id
     from public.quotes q join public.clients cl on cl.id = q.client_id
    where q.company_id = p_company_id and (q.number = v_num or q.title ilike v_like or cl.display_name ilike v_like)
    order by (q.number = v_num) desc nulls last, q.created_at desc
    limit v_limit)
  union all
  (select 'job'::text, j.id, j.title, cl.display_name, j.number, j.status, j.client_id
     from public.jobs j join public.clients cl on cl.id = j.client_id
    where j.company_id = p_company_id and (j.number = v_num or j.title ilike v_like or cl.display_name ilike v_like)
    order by (j.number = v_num) desc nulls last, j.created_at desc
    limit v_limit)
  union all
  (select 'invoice'::text, i.id, coalesce(nullif(i.subject, ''), 'Invoice #' || i.number), cl.display_name, i.number, i.status, i.client_id
     from public.invoices i join public.clients cl on cl.id = i.client_id
    where i.company_id = p_company_id and (i.number = v_num or i.subject ilike v_like or cl.display_name ilike v_like)
    order by (i.number = v_num) desc nulls last, i.created_at desc
    limit v_limit)
  union all
  -- "Measurement" is the name every drawing starts with, so it only matches a name someone gave it.
  (select 'measurement'::text, m.id, m.title, concat_ws(' · ', p.line1, cl.display_name), null::bigint, null::text, cl.id
     from public.measurements m
     left join public.properties p on p.id = m.property_id
     left join public.quotes q on q.id = m.quote_id
     left join public.requests r on r.id = m.request_id
     left join public.invoices i on i.id = m.invoice_id
     left join public.clients cl on cl.id = coalesce(p.client_id, q.client_id, r.client_id, i.client_id)
    where m.company_id = p_company_id
      and ((m.title <> 'Measurement' and m.title ilike v_like) or p.line1 ilike v_like or cl.display_name ilike v_like
        or q.title ilike v_like or q.number = v_num)
    order by m.updated_at desc
    limit v_limit)
  union all
  (select 'kb'::text, s.id, s.title, concat_ws(' · ', sc.name, case when s.status = 'draft' then 'Draft' end), null::bigint, s.status, null::uuid
     from public.sop_pages s left join public.sop_categories sc on sc.id = s.category_id
    where s.company_id = p_company_id and (s.title ilike v_like or s.body_text ilike v_like or s.search @@ v_words)
    order by (s.title ilike v_like) desc, ts_rank(s.search, v_words) desc, s.title
    limit v_limit)
  union all
  (select 'campaign'::text, cp.id, cp.name, nullif(cp.subject, ''), null::bigint, cp.status, null::uuid
     from public.campaigns cp
    where cp.company_id = p_company_id and (cp.name ilike v_like or cp.subject ilike v_like)
    order by cp.created_at desc
    limit v_limit)
  union all
  (select 'rule'::text, ar.id, ar.name, case when ar.enabled then 'On' else 'Off' end, null::bigint, null::text, null::uuid
     from public.automation_rules ar
    where ar.company_id = p_company_id and (ar.name ilike v_like or ar.description ilike v_like)
    order by (ar.name ilike v_like) desc, ar.name
    limit v_limit)
  union all
  (select 'service'::text, sv.id, sv.name, nullif(sv.category, ''), null::bigint, null::text, null::uuid
     from public.services sv
    where sv.company_id = p_company_id and sv.active and (sv.name ilike v_like or sv.category ilike v_like)
    order by (sv.name ilike v_q || '%') desc, sv.sort, sv.name
    limit v_limit)
  union all
  (select 'file'::text, f.id, f.title,
      concat_ws(' · ', case
        when f.job_id is not null then 'Job #' || f.job_number
        when f.quote_id is not null then 'Quote #' || f.quote_number
        when f.request_id is not null then f.request_title
        when f.property_id is not null then f.property_label
        else coalesce(f.folder_name, 'Company files')
      end, f.client_name),
      null::bigint, case when f.archived then 'archived' end, f.client_id
     from private.drive_files f
    where f.company_id = p_company_id and f.company_id = any ((select private.member_companies())::uuid[])
      and f.superseded_at is null and (f.title ilike v_like or f.file_name ilike v_like)
    order by (f.title ilike v_q || '%') desc, f.updated_at desc
    limit v_limit);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Who calls what
-- ---------------------------------------------------------------------------------------------

revoke execute on function public.drive_set_enabled(uuid, boolean), public.drive_root(uuid), public.drive_trash_file(uuid),
  public.drive_trash_version(uuid), public.drive_trash_folder(uuid), public.drive_restore(text, uuid), public.drive_trash(uuid),
  public.drive_list(uuid, text, uuid, text, integer), public.drive_clients(uuid, text, integer), public.drive_versions(uuid)
  from public, anon;
grant execute on function public.drive_set_enabled(uuid, boolean), public.drive_root(uuid), public.drive_trash_file(uuid),
  public.drive_trash_version(uuid), public.drive_trash_folder(uuid), public.drive_restore(text, uuid), public.drive_trash(uuid),
  public.drive_list(uuid, text, uuid, text, integer), public.drive_clients(uuid, text, integer), public.drive_versions(uuid)
  to authenticated;
revoke all on function private.trashed_file_visible(public.trashed_files), private.drive_where(public.plan_files),
  private.plan_files_place(), private.plan_files_carry(), private.drive_folders_guard() from public;
revoke execute on function public.global_search(uuid, text, integer) from public, anon;
grant execute on function public.global_search(uuid, text, integer) to authenticated;

-- The policies above check the company the per-row way; rewrite them like the others (see
-- 20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
