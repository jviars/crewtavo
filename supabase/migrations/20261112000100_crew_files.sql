-- Stored files for crew leads and field crew: the files of their own work, as the tables show them.
--
-- The files bucket let anyone on the team read every folder but receipts, chat, sub paperwork and
-- résumés. The tables say more than that: plans and Drive files are the office's unless they're
-- current and marked for the crew (20261019001700_plan_files.sql), field crew see only the visits
-- they're on and the jobs, clients, properties and requests behind them
-- (20261017001300_field_crew_scope.sql), and quotes and invoices are for sales and the office.
-- Stored files now follow the same lines.
--
--   The office (owners, admins, office staff, estimators)   every folder as before: all of them but
--                                                           the four with rules of their own.
--   Crew leads and field crew                               only the folders below.
--
--     avatars/, equipment/, kb/, logo/   the team's photos, the machines, guides' pictures, the logo
--     visit/<visit>/                     a visit they can open (its photos, and a checklist's)
--     job/<job>/, tickets/<job>/         a job they can open (its files, plant tickets' photos)
--     quote/<quote>/                     the quote behind a job they can open: the Photos card on a
--                                        job shows its quote's photos. No other quote's.
--     property/, request/, client/       one they can open
--     property-equipment/                the photo of a property's equipment they can see
--     plans/                             a plan file they can see: current, marked for the crew and,
--                                        for field crew, on their work (plan_files_read)
--     measurements/                      crew leads, who measure on site; not field crew
--     receipts/, chat/                   as before: their own receipts, the channels they can see
--     anywhere but plans/                a file they stored themselves (a photo they added stays
--                                        theirs to open), or put in the Trash themselves: the Trash
--                                        gives it back to download when where it was is gone
--
-- Each "they can open" is asked of the table itself, as the person asking (row-level security
-- applies inside a policy), so a file follows its record's rule whatever that becomes. Nothing here
-- lets anyone read a file they couldn't before. supabase/tests/crew_files_test.sql covers it.
--
-- Uploading is unchanged: Storage asks only whether the file may be added, and a plan's or a
-- photo's row is saved right after its file, before anything shows it.

-- The record a stored file's folder is named for: <company>/<kind>/<record>/..., or nothing when
-- that part of the path isn't an id.
create function private.path_record(p_name text) returns uuid
language sql immutable as $$
  select case when split_part(p_name, '/', 3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 3)::uuid end
$$;
revoke all on function private.path_record(text) from public;
grant execute on function private.path_record(text) to authenticated, service_role;

-- Whether the person asking put this stored file in the Trash themselves. The Trash lists it for
-- them, and has them download it when what it was on is gone (drive_trash, trashed_file_restore
-- in 20261028000300_drive.sql).
create function private.trashed_by_me(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.trashed_files t where t.path = p_path and t.deleted_by = (select auth.uid()))
$$;
revoke all on function private.trashed_by_me(text) from public;
grant execute on function private.trashed_by_me(text) to authenticated, service_role;

-- Looked up once for each file read: the job a quote became, and the equipment a photo is of.
create index if not exists jobs_quote_idx on public.jobs (quote_id) where quote_id is not null;
create index if not exists property_assets_photo_path_idx on public.property_assets (photo_path) where photo_path is not null;

drop policy files_read on storage.objects;
create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'files' and private.is_member(private.path_company(name)) and (
    -- The office, as before (20261028000100_careers.sql).
    (private.has_role(private.path_company(name), '{owner,admin,office,estimator}')
      and split_part(name, '/', 2) not in ('receipts', 'chat', 'subs', 'applicants'))
    -- Everyone on the team.
    or split_part(name, '/', 2) in ('avatars', 'equipment', 'kb', 'logo')
    or (split_part(name, '/', 2) = 'visit' and exists (
      select 1 from public.visits v where v.id = private.path_record(objects.name) and v.company_id = private.path_company(objects.name)))
    or (split_part(name, '/', 2) in ('job', 'tickets') and exists (
      select 1 from public.jobs j where j.id = private.path_record(objects.name) and j.company_id = private.path_company(objects.name)))
    or (split_part(name, '/', 2) = 'quote' and exists (
      select 1 from public.jobs j where j.quote_id = private.path_record(objects.name) and j.company_id = private.path_company(objects.name)))
    or (split_part(name, '/', 2) = 'property' and exists (
      select 1 from public.properties p where p.id = private.path_record(objects.name) and p.company_id = private.path_company(objects.name)))
    or (split_part(name, '/', 2) = 'request' and exists (
      select 1 from public.requests r where r.id = private.path_record(objects.name) and r.company_id = private.path_company(objects.name)))
    or (split_part(name, '/', 2) = 'client' and exists (
      select 1 from public.clients c where c.id = private.path_record(objects.name) and c.company_id = private.path_company(objects.name)))
    or (split_part(name, '/', 2) = 'property-equipment' and exists (select 1 from public.property_assets a where a.photo_path = objects.name))
    or (split_part(name, '/', 2) = 'plans' and exists (select 1 from public.plan_files f where f.path = objects.name))
    or (split_part(name, '/', 2) = 'measurements' and private.has_role(private.path_company(name), '{crew_lead}'))
    -- Their own: stored by them, or put in the Trash by them. A plan follows its row whoever stored it.
    or (split_part(name, '/', 2) not in ('plans', 'receipts', 'chat', 'subs', 'applicants')
      and (owner = (select auth.uid()) or private.trashed_by_me(name)))
    -- The four with rules of their own, as before.
    or (split_part(name, '/', 2) = 'receipts' and (owner = (select auth.uid()) or private.has_perm(private.path_company(name), 'job_costs')))
    or (split_part(name, '/', 2) = 'chat' and private.chat_can(private.chat_file_channel(name), 'see'))
    or (split_part(name, '/', 2) = 'subs' and private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs'))
    or (split_part(name, '/', 2) = 'applicants' and private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'hiring'))
  )
);

-- The policy above checks membership once per query (20261018000990_policy_lookups).
select private.fold_member_checks('storage.objects');

notify pgrst, 'reload schema';
