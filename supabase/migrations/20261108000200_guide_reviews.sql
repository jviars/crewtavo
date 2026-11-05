-- Guides looked over on a schedule (apps/web/src/features/kb): a guide can say how often it's
-- reviewed and who reviews it. It's due that many months after its last review; saving a change to
-- it counts as one, and so does Mark reviewed. When it comes due its reviewer hears (everyone who
-- edits guides when it has none, or theirs can't any more), and again each week it stays due.

alter table public.sop_pages
  add column owner_id uuid references auth.users (id) on delete set null,
  add column review_months smallint check (review_months between 1 and 36),
  add column reviewed_at timestamptz;

-- A guide put on a schedule, or changed while on one, was reviewed just now.
create function private.sop_review_clock() returns trigger
language plpgsql as $$
begin
  if new.review_months is not null and (new.reviewed_at is null
     or (tg_op = 'UPDATE' and (new.title is distinct from old.title or new.body is distinct from old.body))) then
    new.reviewed_at := now();
  end if;
  return new;
end $$;
create trigger sop_review_clock before insert or update on public.sop_pages
  for each row execute function private.sop_review_clock();

-- When each guide's reviewer last heard, kept apart so telling them doesn't change the guide.
create table private.sop_review_notices (
  page_id uuid primary key references public.sop_pages (id) on delete cascade,
  reviewed_at timestamptz not null,
  noticed_at timestamptz not null default now()
);

-- Guides due for review whose reviewer hasn't heard since that review, or not this week: one
-- notification each. Hourly (apps/api/src/tasks.ts), on the server's key.
create function public.emit_guide_reviews() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_sent integer := 0; r record;
begin
  for r in
    select p.id, p.company_id, p.title, p.owner_id, p.reviewed_at
    from public.sop_pages p
    left join private.sop_review_notices n on n.page_id = p.id
    where p.status = 'published' and p.review_months is not null
      and p.reviewed_at + make_interval(months => p.review_months) <= now()
      and (n.page_id is null or n.reviewed_at <> p.reviewed_at or n.noticed_at <= now() - interval '7 days')
    for update of p skip locked
  loop
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select r.company_id, m.user_id, 'guide_review', left(format('Time to review “%s”', r.title), 300),
      'Check it''s still right, then choose Mark reviewed.', '/kb/' || r.id
    from public.memberships m
    left join public.company_roles cr on cr.id = m.role_id
    where m.company_id = r.company_id and m.active and m.role in ('owner', 'admin', 'office')
      and (m.role = 'owner' or 'kb_edit' = any (coalesce(cr.permissions, private.level_permissions(m.role))))
      -- Its reviewer, while they can edit guides; otherwise everyone who can.
      and (m.user_id = r.owner_id or not exists (
        select 1 from public.memberships o left join public.company_roles ocr on ocr.id = o.role_id
        where o.company_id = r.company_id and o.user_id = r.owner_id and o.active and o.role in ('owner', 'admin', 'office')
          and (o.role = 'owner' or 'kb_edit' = any (coalesce(ocr.permissions, private.level_permissions(o.role))))));
    insert into private.sop_review_notices (page_id, reviewed_at, noticed_at) values (r.id, r.reviewed_at, now())
    on conflict (page_id) do update set reviewed_at = excluded.reviewed_at, noticed_at = excluded.noticed_at;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;
revoke execute on function public.emit_guide_reviews() from public, anon, authenticated;
grant execute on function public.emit_guide_reviews() to service_role;
