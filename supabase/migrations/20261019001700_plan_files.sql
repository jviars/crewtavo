-- Plans and files: the plan sets, specs, permits and addenda that come with a job (a general
-- contractor's drawings, a city's work order). Each file sits on a quote, a job or both, and on the
-- property, so next year's job at the same lot has the striping plan too. The file itself is in the
-- private files bucket at <company>/plans/<uuid>.<ext>.
--
-- New versions: uploading a new version of a file (replaces_id) marks the one it replaces as
-- superseded. Crews only ever see current versions; the office keeps the history. Deleting the
-- current version brings the one before it back.
--
-- Who sees what: the office (owner, admin, office, estimator) sees every file. Crew leads see the
-- current files marked for the crew; field crews see those for the jobs and properties they have
-- visits at. Office-only files (a bid form with prices on it) stay with the office.
--
-- A quote's files go on its job when the quote becomes one (or, for a change order, when it's
-- approved). People on upcoming visits for a job hear about new files for it.

create table public.plan_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid,
  quote_id uuid,
  job_id uuid,
  title text not null check (length(trim(title)) between 1 and 200),
  revision text check (length(revision) <= 60),
  notes text check (length(notes) <= 2000),
  path text not null unique,
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text check (length(content_type) <= 150),
  size_bytes bigint check (size_bytes >= 0),
  crew_visible boolean not null default true,
  archived boolean not null default false,
  replaces_id uuid,
  superseded_at timestamptz,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  -- A version is replaced at most once, so the history is a straight line. Checked at commit, so
  -- taking a version out of the middle can join its neighbours up first.
  constraint plan_files_replaced_once unique (replaces_id) deferrable initially deferred,
  foreign key (company_id, property_id) references public.properties (company_id, id) on delete set null (property_id),
  foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete set null (quote_id),
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id),
  -- Checked at commit too: taking out a version joins the next one to the one before (below).
  foreign key (company_id, replaces_id) references public.plan_files (company_id, id) deferrable initially deferred,
  -- One of this company's plan files, never a receipt or another company's file.
  check (path ~ '^[0-9a-f-]{36}/plans/[0-9a-f-]{36}\.[a-z0-9]{1,8}$' and split_part(path, '/', 1) = company_id::text),
  check (replaces_id is null or replaces_id <> id)
);
create index plan_files_property_idx on public.plan_files (company_id, property_id) where property_id is not null;
create index plan_files_quote_idx on public.plan_files (company_id, quote_id) where quote_id is not null;
create index plan_files_job_idx on public.plan_files (company_id, job_id) where job_id is not null;
select private.add_touch_triggers(array['plan_files']);

comment on table public.plan_files is 'Plans and files on quotes, jobs and properties (plan sets, specs, permits), with versions.';
comment on column public.plan_files.crew_visible is 'Crew leads and the crews on the work can open it. Off: the office only.';
comment on column public.plan_files.replaces_id is 'The version this one replaces; that one is superseded.';
comment on column public.plan_files.superseded_at is 'When a newer version replaced this one. Crews only see current versions.';

-- ---------------------------------------------------------------------------------------------
-- Who sees and changes them
-- ---------------------------------------------------------------------------------------------

alter table public.plan_files enable row level security;
create policy plan_files_read on public.plan_files for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator}')
  or (crew_visible and not archived and superseded_at is null and (
    private.has_role(company_id, '{crew_lead}')
    or (private.is_member(company_id) and (
      (job_id is not null and private.crew_sees_job(job_id))
      or (property_id is not null and private.crew_sees_property(property_id))
    ))
  ))
);
-- Crew leads can add files and new versions (the GC hands the foreman a revised sheet on site).
create policy plan_files_insert on public.plan_files for insert to authenticated
  with check (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}'));
create policy plan_files_update on public.plan_files for update to authenticated
  using (
    private.has_role(company_id, '{owner,admin,office,estimator}')
    or (private.has_role(company_id, '{crew_lead}') and crew_visible and not archived and superseded_at is null)
  )
  with check (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}'));
-- Removing one: the office, or the crew lead who added it.
create policy plan_files_delete on public.plan_files for delete to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator}')
  or (private.has_role(company_id, '{crew_lead}') and created_by = (select auth.uid()))
);

-- ---------------------------------------------------------------------------------------------
-- Where a file belongs, and its versions
-- ---------------------------------------------------------------------------------------------

-- A new file takes the property from its quote or job; a new version takes everything it doesn't
-- say from the one it replaces, which must still be the current one.
create function private.plan_files_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev public.plan_files;
begin
  if new.replaces_id is not null then
    select * into v_prev from public.plan_files where id = new.replaces_id and company_id = new.company_id for update;
    if not found then
      raise exception 'That file wasn''t found' using errcode = '23503';
    end if;
    -- A crew lead can only add a version of a file they can see.
    if not private.has_role(new.company_id, '{owner,admin,office,estimator}') and (not v_prev.crew_visible or v_prev.archived) then
      raise exception 'That file wasn''t found' using errcode = '23503';
    end if;
    if v_prev.superseded_at is not null then
      raise exception 'A newer version of % was already added. Refresh and try again.', v_prev.title using errcode = '23505';
    end if;
    new.property_id := coalesce(new.property_id, v_prev.property_id);
    new.quote_id := coalesce(new.quote_id, v_prev.quote_id);
    new.job_id := coalesce(new.job_id, v_prev.job_id);
  end if;
  if new.property_id is null and new.job_id is not null then
    select property_id into new.property_id from public.jobs where id = new.job_id and company_id = new.company_id;
  end if;
  if new.property_id is null and new.quote_id is not null then
    select property_id into new.property_id from public.quotes where id = new.quote_id and company_id = new.company_id;
  end if;
  if new.property_id is null and new.quote_id is null and new.job_id is null then
    raise exception 'A file goes on a property, a quote or a job' using errcode = '23514';
  end if;
  new.superseded_at := null;
  return new;
end $$;
create trigger plan_files_fill before insert on public.plan_files
  for each row execute function private.plan_files_fill();

-- The new version supersedes the old one.
create function private.plan_files_supersede() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.plan_files set superseded_at = now() where id = new.replaces_id;
  return null;
end $$;
create trigger plan_files_supersede after insert on public.plan_files
  for each row when (new.replaces_id is not null) execute function private.plan_files_supersede();

-- What a file is and where its history goes don't change by hand: a different file is a new version.
-- Only the triggers here (one level down) mark a version superseded or current again.
create function private.plan_files_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.company_id := old.company_id;
  new.path := old.path;
  new.file_name := old.file_name;
  new.content_type := old.content_type;
  new.size_bytes := old.size_bytes;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if pg_trigger_depth() <= 1 then
    new.replaces_id := old.replaces_id;
    new.superseded_at := old.superseded_at;
  end if;
  return new;
end $$;
create trigger plan_files_guard before update on public.plan_files
  for each row execute function private.plan_files_guard();

-- Taking out a version: the next one now replaces the one before, and when it was the current
-- version, the one before is current again. After the delete, so a company being deleted (every
-- file going at once) has nothing left to join up.
create function private.plan_files_unlink() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.plan_files set replaces_id = old.replaces_id where replaces_id = old.id;
  if old.replaces_id is not null and old.superseded_at is null then
    update public.plan_files set superseded_at = null where id = old.replaces_id;
  end if;
  return null;
end $$;
create trigger plan_files_unlink after delete on public.plan_files
  for each row execute function private.plan_files_unlink();

-- ---------------------------------------------------------------------------------------------
-- Quote to job
-- ---------------------------------------------------------------------------------------------

create function private.plan_files_follow_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.quote_id is not null then
    update public.plan_files set job_id = new.id
    where company_id = new.company_id and quote_id = new.quote_id and job_id is null;
  end if;
  return null;
end $$;
create trigger plan_files_follow_job after insert or update of quote_id on public.jobs
  for each row execute function private.plan_files_follow_job();

create function private.plan_files_follow_change_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.plan_files set job_id = new.change_order_for
  where company_id = new.company_id and quote_id = new.id and job_id is null;
  return null;
end $$;
create trigger plan_files_follow_change_order after update of status on public.quotes
  for each row when (new.change_order_for is not null and new.status in ('approved', 'converted') and old.status is distinct from new.status)
  execute function private.plan_files_follow_change_order();

-- ---------------------------------------------------------------------------------------------
-- Telling the crew
-- ---------------------------------------------------------------------------------------------

-- The people on upcoming visits for the job hear about a new file or version the crew can see, in
-- their schedule notifications (several within a few minutes come as one).
create function private.plan_files_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_job record; v_line text; r record;
begin
  if new.job_id is null or not new.crew_visible or new.archived then
    return null;
  end if;
  select timezone into v_tz from public.companies where id = new.company_id;
  select number, title into v_job from public.jobs where id = new.job_id;
  v_line := case
    when new.replaces_id is not null then format('New version of %s for job #%s (%s)%s', new.title, v_job.number, v_job.title, coalesce(': ' || nullif(trim(new.revision), ''), ''))
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
create trigger plan_files_notify after insert on public.plan_files
  for each row execute function private.plan_files_notify();

-- The policies above check the company and the crew's work the per-row way; rewrite them like the
-- others (see 20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
