-- Upload links the server makes for people without an account: a booking form's files and photos
-- (apps/api/src/routes/public.ts) and a sub's paperwork through their link (routes/subs.ts).
--
--   upload_links           one row for each link: whose it is, how big its file may be (the size its
--                          visitor gave for it) and when it runs out. The gateway holds an upload
--                          through the link to that size, and doesn't take one through a link with
--                          no row (apps/api/src/lib/publicUploads.ts, lib/storageLimits.ts). Only the
--                          server reads or writes it.
--   expired_upload_links   the links that have run out, forgotten, with the files nobody recorded
--                          (not on a request, not on a sub's paperwork, not in the Trash), for the
--                          server to remove (the hourly upkeep, services/planFiles.ts), so files a
--                          stranger sends and never records don't stay a day.
--
-- Also: an AI assistant's token doesn't read guides' share links (sop_shares, 20261117000200): a
-- link opens its guide without a sign-in, and would keep working after the assistant is
-- disconnected. People signed in read them as before.
--
-- supabase/tests/public_upload_links_test.sql covers both.

create table public.upload_links (
  path text primary key check (char_length(path) <= 1024 and path !~ '(^|/)\.\.?(/|$)'),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null check (kind in ('form', 'paperwork')),
  max_bytes bigint not null check (max_bytes > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (starts_with(path, company_id::text || '/'))
);
comment on table public.upload_links is 'Upload links the server made for people without an account (booking forms, subs'' paperwork): how big each one''s file may be, and when it runs out. The server''s alone.';
create index upload_links_expires_idx on public.upload_links (expires_at);
create index upload_links_company_idx on public.upload_links (company_id);
-- RLS on and no policies: only the service key reads or writes it.
alter table public.upload_links enable row level security;
revoke all on public.upload_links from anon, authenticated;

/**
 * Forgets up to p_limit upload links that ran out, the longest gone first, and hands over, for each
 * company, how many went and the files of theirs nobody recorded: none on a request's or a job's
 * Plans and files (plan_files, the Trash included), none on a sub's paperwork (sub_documents), none
 * in the Trash (trashed_files). The server removes those. Safe to run twice at once: a link is
 * claimed by one run only. The server's alone.
 */
create function public.expired_upload_links(p_limit integer default 1000)
returns table (company_id uuid, links integer, paths text[])
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'A limit is 1 to 1000.' using errcode = '22023';
  end if;
  return query
  with ran_out as (
    select u.path from public.upload_links u
    where u.expires_at < now()
    order by u.expires_at
    limit p_limit
    for update skip locked
  ), gone as (
    delete from public.upload_links u using ran_out r
    where u.path = r.path
    returning u.company_id as company, u.path as file
  ), looked as (
    select g.company, g.file,
      exists (select 1 from public.plan_files f where f.path = g.file)
        or exists (select 1 from public.sub_documents d where d.path = g.file)
        or exists (select 1 from public.trashed_files t where t.path = g.file) as recorded
    from gone g
  )
  select l.company, count(*)::integer, coalesce(array_agg(l.file order by l.file) filter (where not l.recorded), '{}'::text[])
  from looked l
  group by l.company;
end $$;
revoke execute on function public.expired_upload_links(integer) from public, anon, authenticated;
grant execute on function public.expired_upload_links(integer) to service_role;

-- A guide's share link (its token) for people, not for an AI assistant: the permissive policies
-- still decide who on the team reads which, and this one keeps an assistant's token from reading
-- any. The server reads them with its own key, as before.
create policy sop_shares_people_only on public.sop_shares as restrictive for select to authenticated
  using ((select private.assistant_client()) is null);

notify pgrst, 'reload schema';
