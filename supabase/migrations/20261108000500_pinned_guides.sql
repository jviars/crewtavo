-- Pinned guides (apps/web/src/features/kb): the office pins a guide, like a "Start here", and it
-- shows above the categories on the knowledge base home, first pinned first. Null: not pinned.
-- Pinning is changing the guide, so the same people can (sop_pages_write).
alter table public.sop_pages add column pinned_at timestamptz;

-- When what a guide says last changed (its title or body: a new revision). The knowledge base's
-- "Updated" shows this, not updated_at, which pinning, publishing or marking it reviewed also moves.
alter table public.sop_pages add column revised_at timestamptz;
alter table public.sop_pages disable trigger user;
update public.sop_pages p set revised_at = coalesce((select max(r.created_at) from public.sop_revisions r where r.page_id = p.id), p.updated_at);
alter table public.sop_pages enable trigger user;
alter table public.sop_pages alter column revised_at set default now(), alter column revised_at set not null;

create or replace function private.sop_bump_revision() returns trigger
language plpgsql as $$
begin
  if new.title is distinct from old.title or new.body is distinct from old.body then
    new.revision := old.revision + 1;
    new.revised_at := now();
    new.updated_by := coalesce((select auth.uid()), new.updated_by);
  else
    new.revision := old.revision;
    new.revised_at := old.revised_at;
  end if;
  return new;
end $$;
