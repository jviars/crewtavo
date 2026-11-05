-- Knowing whether guides work (apps/web/src/features/kb):
--   sop_feedback        "Was this helpful?" votes and suggested changes, the office marking each done
--   sop_search_misses   searches that found nothing, so the office knows which guides to write
--   sop_quizzes         a few questions to answer before confirming a guide is read
-- Readers send feedback and confirm guides through functions here, which check what they may see;
-- the office reads and handles it all. supabase/tests/guide_feedback_test.sql covers it.

-- The people who hear about a guide: its reviewer while they can still edit guides, otherwise
-- everyone who can. For review reminders (emit_guide_reviews) and suggested changes.
create function private.guide_editors(p_company uuid, p_owner uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  with editors as (
    select m.user_id from public.memberships m
    left join public.company_roles cr on cr.id = m.role_id
    where m.company_id = p_company and m.active and m.role in ('owner', 'admin', 'office')
      and (m.role = 'owner' or 'kb_edit' = any (coalesce(cr.permissions, private.level_permissions(m.role))))
  )
  select user_id from editors where user_id = p_owner
  union all
  select user_id from editors where not exists (select 1 from editors where user_id = p_owner)
$$;
revoke execute on function private.guide_editors(uuid, uuid) from public;

create or replace function public.emit_guide_reviews() returns integer
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
    select r.company_id, e, 'guide_review', left(format('Time to review “%s”', r.title), 300),
      'Check it''s still right, then choose Mark reviewed.', '/kb/' || r.id
    from private.guide_editors(r.company_id, r.owner_id) e;
    insert into private.sop_review_notices (page_id, reviewed_at, noticed_at) values (r.id, r.reviewed_at, now())
    on conflict (page_id) do update set reviewed_at = excluded.reviewed_at, noticed_at = excluded.noticed_at;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;

-- A guide the person signed in can read (published, or any for the office), or nothing.
create function private.readable_guide(p_page uuid) returns public.sop_pages
language sql stable security definer set search_path = '' as $$
  select p.* from public.sop_pages p
  where p.id = p_page and private.is_member(p.company_id)
    and (p.status = 'published' or private.has_role(p.company_id, '{owner,admin,office}'))
$$;
revoke execute on function private.readable_guide(uuid) from public;

-- ===== Feedback ================================================================================
-- A vote (helpful, no message: one a person a revision, the latest kept) or a suggested change
-- (a message, no vote), on the revision they read.
create table public.sop_feedback (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  page_id uuid not null,
  revision integer not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  helpful boolean,
  message text check (char_length(message) between 1 and 2000),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((helpful is null) <> (message is null)),
  foreign key (company_id, page_id) references public.sop_pages (company_id, id) on delete cascade
);
create index sop_feedback_page_idx on public.sop_feedback (page_id, created_at desc);
create index sop_feedback_open_idx on public.sop_feedback (company_id) where message is not null and resolved_at is null;
create unique index sop_feedback_vote_idx on public.sop_feedback (page_id, revision, user_id) where message is null;

alter table public.sop_feedback enable row level security;
-- People see their own; the office sees everyone's, and marks suggestions done (nothing else).
create policy sop_feedback_read on public.sop_feedback for select to authenticated
  using (user_id = (select auth.uid()) or (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'kb_edit')));
create policy sop_feedback_resolve on public.sop_feedback for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'kb_edit'))
  with check (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'kb_edit'));
revoke insert, update, delete on public.sop_feedback from anon, authenticated;
grant update (resolved_at, resolved_by) on public.sop_feedback to authenticated;

/**
 * Feedback on a guide's current revision: a vote (p_helpful) or a suggested change (p_message),
 * one or the other. A suggestion tells the guide's reviewer, or the office.
 */
create function public.guide_feedback(p_page uuid, p_helpful boolean default null, p_message text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_page public.sop_pages := private.readable_guide(p_page);
  v_message text := nullif(trim(p_message), '');
  v_name text;
begin
  if v_page.id is null then raise exception 'That guide wasn''t found.' using errcode = 'P0002'; end if;
  if (p_helpful is null) = (v_message is null) then raise exception 'Send a vote or a suggestion.' using errcode = '22023'; end if;
  if char_length(v_message) > 2000 then raise exception 'Keep it under 2,000 characters.' using errcode = '22023'; end if;
  if v_message is null then
    delete from public.sop_feedback where page_id = p_page and revision = v_page.revision and user_id = auth.uid() and message is null;
    insert into public.sop_feedback (company_id, page_id, revision, user_id, helpful) values (v_page.company_id, p_page, v_page.revision, auth.uid(), p_helpful);
    return;
  end if;
  insert into public.sop_feedback (company_id, page_id, revision, user_id, message) values (v_page.company_id, p_page, v_page.revision, auth.uid(), v_message);
  select full_name into v_name from public.profiles where user_id = auth.uid();
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select v_page.company_id, e, 'guide_feedback', left(format('%s suggested a change to “%s”', coalesce(nullif(v_name, ''), 'Someone'), v_page.title), 300), left(v_message, 300), '/kb/' || p_page
  from private.guide_editors(v_page.company_id, v_page.owner_id) e
  where e <> auth.uid();
end $$;
revoke execute on function public.guide_feedback(uuid, boolean, text) from public, anon;
grant execute on function public.guide_feedback(uuid, boolean, text) to authenticated;

-- ===== Searches that found nothing =============================================================
-- shortcut: never pruned; small (one row a search that finds nothing), prune if it grows.
create table public.sop_search_misses (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  query text not null check (char_length(query) between 2 and 200),
  created_at timestamptz not null default now()
);
create index sop_search_misses_company_idx on public.sop_search_misses (company_id, created_at desc);
alter table public.sop_search_misses enable row level security;
create policy sop_search_misses_add on public.sop_search_misses for insert to authenticated
  with check (private.is_member(company_id) and user_id = (select auth.uid()));
create policy sop_search_misses_office on public.sop_search_misses for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'kb_edit'));
create policy sop_search_misses_clear on public.sop_search_misses for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'kb_edit'));
revoke update on public.sop_search_misses from anon, authenticated;

-- ===== Quizzes =================================================================================
-- [{question, options: [2 to 5], answer: the right option's index}], 1 to 10 of them.
create function private.valid_quiz(p_questions jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(p_questions) = 'array'
    and jsonb_array_length(p_questions) between 1 and 10
    and not exists (
      select 1 from jsonb_array_elements(p_questions) q
      where jsonb_typeof(q) <> 'object'
        or char_length(coalesce(q ->> 'question', '')) not between 1 and 300
        or jsonb_typeof(q -> 'options') <> 'array'
        or jsonb_array_length(q -> 'options') not between 2 and 5
        or exists (select 1 from jsonb_array_elements(q -> 'options') o where jsonb_typeof(o) <> 'string' or char_length(o #>> '{}') not between 1 and 200)
        or jsonb_typeof(q -> 'answer') <> 'number'
        or (q ->> 'answer')::numeric not in (select generate_series(0, jsonb_array_length(q -> 'options') - 1))
    )
$$;

create table public.sop_quizzes (
  page_id uuid primary key,
  company_id uuid not null,
  questions jsonb not null check (private.valid_quiz(questions)),
  updated_at timestamptz not null default now(),
  foreign key (company_id, page_id) references public.sop_pages (company_id, id) on delete cascade
);
select private.add_touch_triggers(array['sop_quizzes']);
-- Only the office reads them as saved (with the answers); readers get the questions from guide_quiz.
alter table public.sop_quizzes enable row level security;
create policy sop_quizzes_office on public.sop_quizzes for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'kb_edit'))
  with check (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'kb_edit'));

/** A guide's quiz for whoever's reading it: the questions and options, not the answers. Null: none. */
create function public.guide_quiz(p_page uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('question', q -> 'question', 'options', q -> 'options') order by i)
  from public.sop_quizzes z, jsonb_array_elements(z.questions) with ordinality as x(q, i)
  where z.page_id = (private.readable_guide(p_page)).id
$$;
revoke execute on function public.guide_quiz(uuid) from public, anon;
grant execute on function public.guide_quiz(uuid) to authenticated;

/**
 * "I've read this" for the guide's current revision. With a quiz, every answer (an option's index,
 * in order) has to be right first: the questions answered wrong come back, by index, and nothing is
 * saved. Empty when it's saved.
 */
create function public.acknowledge_guide(p_page uuid, p_answers integer[] default null) returns integer[]
language plpgsql security definer set search_path = '' as $$
declare
  v_page public.sop_pages := private.readable_guide(p_page);
  v_wrong integer[];
begin
  if v_page.id is null or v_page.status <> 'published' then raise exception 'That guide wasn''t found.' using errcode = 'P0002'; end if;
  select coalesce(array_agg(i - 1 order by i), '{}') into v_wrong
  from public.sop_quizzes z, jsonb_array_elements(z.questions) with ordinality as x(q, i)
  where z.page_id = p_page and (p_answers is null or p_answers[i::integer] is null or p_answers[i::integer] <> (q ->> 'answer')::integer);
  if cardinality(v_wrong) > 0 then return v_wrong; end if;
  perform set_config('crewtavo.quiz_passed', p_page::text, true);
  insert into public.sop_acknowledgements (company_id, page_id, revision, user_id)
  values (v_page.company_id, p_page, v_page.revision, auth.uid())
  on conflict do nothing;
  perform set_config('crewtavo.quiz_passed', '', true);
  return '{}';
end $$;
revoke execute on function public.acknowledge_guide(uuid, integer[]) from public, anon;
grant execute on function public.acknowledge_guide(uuid, integer[]) to authenticated;

-- A guide with a quiz is only confirmed through acknowledge_guide, once its questions are answered.
create or replace function private.sop_ack_current() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.sop_pages where id = new.page_id and revision = new.revision) then
    raise exception 'That revision is no longer current; reload the page' using errcode = '22023';
  end if;
  -- Someone signed in (inside this function current_user is its owner, so ask who's signed in).
  if (select auth.uid()) is not null and exists (select 1 from public.sop_quizzes where page_id = new.page_id)
     and coalesce(current_setting('crewtavo.quiz_passed', true), '') <> new.page_id::text then
    raise exception 'Answer the guide''s questions first' using errcode = '42501';
  end if;
  return new;
end $$;

-- The new tables' rules check membership once a statement, like every other table's (20261018000990_policy_lookups.sql).
select private.fold_member_checks();
