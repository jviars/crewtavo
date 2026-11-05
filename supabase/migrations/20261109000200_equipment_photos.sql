-- Equipment photos: as many as people want of a machine (the machine itself, its VIN plate, the
-- registration card, a dent), kept in the company's equipment/ folder with its main photo
-- (equipment.photo_path). Anyone on the team adds them, as they log work; whoever added one, or an
-- equipment manager, takes it out, and the file goes to the Trash for 30 days like the main photo.
-- supabase/tests/equipment_photos_test.sql covers it.

create table public.equipment_photos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  equipment_id uuid not null,
  -- In this company's equipment folder, so a row can't name someone else's file.
  path text not null unique check (starts_with(path, company_id::text || '/equipment/') and path !~ '(^|/)\.\.?(/|$)'),
  file_name text check (length(file_name) <= 200),
  content_type text check (length(content_type) <= 150),
  size_bytes bigint check (size_bytes >= 0),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (company_id, equipment_id) references public.equipment (company_id, id) on delete cascade
);
create index equipment_photos_equipment_idx on public.equipment_photos (equipment_id, created_at);

alter table public.equipment_photos enable row level security;
create policy equipment_photos_read on public.equipment_photos for select to authenticated using (private.is_member(company_id));
create policy equipment_photos_insert on public.equipment_photos for insert to authenticated
  with check (private.is_member(company_id) and created_by = (select auth.uid()));
create policy equipment_photos_delete on public.equipment_photos for delete to authenticated
  using (created_by = (select auth.uid()) or private.manages_equipment(company_id));
-- A photo is added or taken out, never changed.
revoke update on public.equipment_photos from authenticated;
select private.fold_member_checks('public.equipment_photos');

-- Taken out, or with its machine: the file to the Trash, unless something else still shows it.
create function private.trash_equipment_photo() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_name text := (select name from public.equipment where id = old.equipment_id);
begin
  perform private.trash_stored_file(old.company_id, old.path, old.file_name, old.content_type, old.size_bytes,
    'equipment_photo', old.equipment_id, 'Equipment photo · ' || coalesce(v_name, 'deleted equipment'), null);
  return null;
end $$;
revoke all on function private.trash_equipment_photo() from public;
create trigger trash_files after delete on public.equipment_photos
  for each row execute function private.trash_equipment_photo();

-- As in 20261108000400_guide_pictures.sql, plus equipment_photos.
create or replace function private.stored_path_in_use(p_company uuid, p_path text) returns boolean
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
     or exists (select 1 from public.sop_categories c where c.cover_path = p_path)
     or exists (select 1 from private.sop_pictures g where g.path = p_path)
     or exists (select 1 from public.equipment e where e.photo_path = p_path)
     or exists (select 1 from public.equipment_photos p where p.path = p_path)
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

notify pgrst, 'reload schema';
