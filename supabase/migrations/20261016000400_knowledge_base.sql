-- SOP knowledge base: categories, pages with revisions, and read acknowledgements.
-- Pages store TipTap JSON (editing), HTML (reading) and plain text (search).

create table public.sop_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  icon text,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

-- array_to_string is only STABLE in general; for text[] it's safe to treat as IMMUTABLE in an index.
create function private.tags_text(p_tags text[]) returns text
language sql immutable parallel safe as $$ select array_to_string(p_tags, ' ') $$;

create table public.sop_pages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  category_id uuid,
  title text not null check (length(title) between 1 and 200),
  body jsonb not null default '{"type": "doc", "content": []}',
  body_html text not null default '',
  body_text text not null default '',
  status text not null default 'published' check (status in ('draft', 'published')),
  required boolean not null default false,
  audience public.member_role[], -- who must read it when required; null = everyone
  tags text[] not null default '{}',
  revision integer not null default 1,
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(private.tags_text(tags), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'C')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, category_id) references public.sop_categories (company_id, id) on delete set null (category_id)
);
create index sop_pages_search_idx on public.sop_pages using gin (search);
create index sop_pages_company_idx on public.sop_pages (company_id, category_id);

create table public.sop_revisions (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  page_id uuid not null,
  revision integer not null,
  title text not null,
  body jsonb not null,
  body_html text not null,
  edited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (page_id, revision),
  foreign key (company_id, page_id) references public.sop_pages (company_id, id) on delete cascade
);

create table public.sop_acknowledgements (
  company_id uuid not null,
  page_id uuid not null,
  revision integer not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (page_id, user_id, revision),
  foreign key (company_id, page_id) references public.sop_pages (company_id, id) on delete cascade
);

select private.add_touch_triggers(array['sop_categories', 'sop_pages']);

-- Content edits bump the revision; every revision is kept.
create function private.sop_bump_revision() returns trigger
language plpgsql as $$
begin
  if new.title is distinct from old.title or new.body is distinct from old.body then
    new.revision := old.revision + 1;
    new.updated_by := coalesce((select auth.uid()), new.updated_by);
  else
    new.revision := old.revision;
  end if;
  return new;
end $$;
create trigger sop_bump_revision before update on public.sop_pages
  for each row execute function private.sop_bump_revision();

create function private.sop_save_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.revision <> old.revision then
    insert into public.sop_revisions (company_id, page_id, revision, title, body, body_html, edited_by)
    values (new.company_id, new.id, new.revision, new.title, new.body, new.body_html, new.updated_by);
  end if;
  return null;
end $$;
create trigger sop_save_revision after insert or update on public.sop_pages
  for each row execute function private.sop_save_revision();

-- Acknowledgements must be for the page's current revision.
create function private.sop_ack_current() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.sop_pages where id = new.page_id and revision = new.revision) then
    raise exception 'That revision is no longer current; reload the page' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger sop_ack_current before insert on public.sop_acknowledgements
  for each row execute function private.sop_ack_current();

-- RLS: members read published pages (editors also see drafts); office and up edit.
select private.apply_policies('sop_categories', '{owner,admin,office}');

alter table public.sop_pages enable row level security;
create policy sop_pages_read on public.sop_pages for select to authenticated
  using (private.is_member(company_id) and (status = 'published' or private.has_role(company_id, '{owner,admin,office}')));
create policy sop_pages_write on public.sop_pages for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'))
  with check (private.has_role(company_id, '{owner,admin,office}'));

alter table public.sop_revisions enable row level security;
create policy sop_revisions_read on public.sop_revisions for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));

alter table public.sop_acknowledgements enable row level security;
create policy sop_acks_read on public.sop_acknowledgements for select to authenticated
  using (private.is_member(company_id));
create policy sop_acks_insert on public.sop_acknowledgements for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_member(company_id));

-- Search for the UI and for AI answers. Runs as the caller, so drafts stay hidden from crews.
create function public.search_sops(p_company uuid, p_query text, p_limit integer default 10)
returns table (
  id uuid, title text, category text, snippet text, body_text text,
  required boolean, revision integer, acknowledged boolean, rank real
)
language sql stable security invoker set search_path = '' as $$
  with q as (select websearch_to_tsquery('english', p_query) as tsq)
  select p.id, p.title, c.name,
    ts_headline('english', p.body_text, q.tsq, 'StartSel="",StopSel="",MaxWords=30,MinWords=12,MaxFragments=1'),
    p.body_text, p.required, p.revision,
    exists (select 1 from public.sop_acknowledgements a
            where a.page_id = p.id and a.revision = p.revision and a.user_id = (select auth.uid())),
    ts_rank(p.search, q.tsq)
  from public.sop_pages p
  cross join q
  left join public.sop_categories c on c.id = p.category_id
  where p.company_id = p_company and p.search @@ q.tsq
  order by ts_rank(p.search, q.tsq) desc
  limit least(greatest(p_limit, 1), 50)
$$;
revoke execute on function public.search_sops(uuid, text, integer) from public, anon;
grant execute on function public.search_sops(uuid, text, integer) to authenticated;
