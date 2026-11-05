-- Pictures in guides (the guide editor's Picture button, or pasting or dropping one in): stored in
-- the company's kb/ folder like guide covers, and named in a guide's HTML by their path
-- (<img data-path="…">), each shown with a short-lived link when the guide is read. Every saved
-- version's pictures are recorded here, so the daily sweep (unrecorded_files) never takes one a
-- version still shows, and restoring an old version brings its pictures back. Deleting the guide
-- puts the pictures nothing else uses in the Trash for 30 days, as it does its cover.
-- supabase/tests/guide_pictures_test.sql covers it.

create table private.sop_pictures (
  revision_id bigint not null references public.sop_revisions (id) on delete cascade,
  company_id uuid not null,
  page_id uuid not null,
  path text not null,
  primary key (revision_id, path)
);
create index sop_pictures_path_idx on private.sop_pictures (path);
create index sop_pictures_page_idx on private.sop_pictures (page_id);

-- The pictures a guide's HTML names: files in its own company's kb/ folder, nothing else.
create function private.guide_picture_paths(p_company uuid, p_html text) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct m[1]), '{}')
  from regexp_matches(coalesce(p_html, ''), 'data-path="([^"]+)"', 'g') m
  where m[1] ~ ('^' || p_company::text || '/kb/[0-9A-Za-z_-]+\.[0-9a-z]+$')
$$;

create function private.record_guide_pictures() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.sop_pictures (revision_id, company_id, page_id, path)
  select new.id, new.company_id, new.page_id, unnest(private.guide_picture_paths(new.company_id, new.body_html))
  on conflict do nothing;
  return null;
end $$;
create trigger record_guide_pictures after insert on public.sop_revisions
  for each row execute function private.record_guide_pictures();

-- Versions saved before this.
insert into private.sop_pictures (revision_id, company_id, page_id, path)
select r.id, r.company_id, r.page_id, unnest(private.guide_picture_paths(r.company_id, r.body_html)) from public.sop_revisions r
on conflict do nothing;

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


-- Before the guide (and its versions) go: its pictures stop counting as its, and those no other
-- guide shows go to the Trash.
create function private.trash_guide_pictures() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
  if not exists (select 1 from public.companies c where c.id = old.company_id) then return old; end if;
  for v_path in with gone as (delete from private.sop_pictures where page_id = old.id returning path) select distinct path from gone loop
    perform private.trash_stored_file(old.company_id, v_path, left(old.title, 200) || ' picture' || private.file_ext(v_path), null, null,
      'kb_cover', old.id, 'Guide picture · ' || old.title, null);
  end loop;
  return old;
end $$;
create trigger trash_guide_pictures before delete on public.sop_pages
  for each row execute function private.trash_guide_pictures();
