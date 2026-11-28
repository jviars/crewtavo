-- Team chat status: what someone on the team is doing, for the member list, their card and the
-- mention suggestions. One of on_job, driving, break, off (off today), office (in the office) and
-- busy, or their own words (custom, up to 60 characters), until a time they chose or until they
-- clear it. Each person sets only their own; everyone on the team reads them (never a sub, who has
-- no Team chat).
--
-- While someone's clock runs, chat says what it says (public.chat_statuses): a drive is Driving, a
-- break On a break, a visit or an assessment On a job, and nothing once they've clocked out. One
-- set by hand comes first until it clears. Nobody reads anyone else's time entries for it: only
-- the status they come to.

create table public.chat_statuses (
  company_id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('on_job', 'driving', 'break', 'off', 'office', 'busy', 'custom')),
  words text check (words is null or length(trim(words)) between 1 and 60),
  -- When it clears by itself; null: when they clear it.
  until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id),
  check (kind <> 'custom' or words is not null),
  foreign key (company_id, user_id) references public.memberships (company_id, user_id) on delete cascade
);

alter table public.chat_statuses enable row level security;
create policy chat_statuses_read on public.chat_statuses for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}'));
create policy chat_statuses_insert on public.chat_statuses for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}'));
create policy chat_statuses_update on public.chat_statuses for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}'));
create policy chat_statuses_delete on public.chat_statuses for delete to authenticated
  using (user_id = (select auth.uid()));

-- A status ends in the future, within a year, and its words are trimmed.
create function private.chat_status_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.words := case when new.kind = 'custom' then nullif(trim(new.words), '') end;
  if new.until is not null and (new.until <= now() or new.until > now() + interval '366 days') then
    raise exception 'A status clears at a time in the next year' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger chat_status_guard before insert or update on public.chat_statuses
  for each row execute function private.chat_status_guard();

-- Everyone's status now, for someone on the team: theirs by hand while it lasts, else what their
-- running clock says. by_clock: it's the clock's.
create function public.chat_statuses(p_company uuid)
returns table (user_id uuid, kind text, words text, until timestamptz, by_clock boolean)
language sql stable security definer set search_path = '' as $$
  select m.user_id, coalesce(s.kind, c.kind), s.words, s.until, s.kind is null
  from public.memberships m
  left join public.chat_statuses s on s.company_id = m.company_id and s.user_id = m.user_id and (s.until is null or s.until > now())
  left join lateral (
    select case e.category when 'drive' then 'driving' when 'break' then 'break' when 'visit' then 'on_job' when 'assessment' then 'on_job' end as kind
    from public.time_entries e
    where e.company_id = m.company_id and e.user_id = m.user_id and e.ended_at is null
    order by e.started_at desc
    limit 1
  ) c on true
  where m.company_id = p_company and m.active and m.role <> 'subcontractor'
    and private.has_role(p_company, '{owner,admin,office,estimator,crew_lead,field_crew}')
    and coalesce(s.kind, c.kind) is not null
$$;

revoke all on function private.chat_status_guard() from public;
revoke execute on function public.chat_statuses(uuid) from public, anon;
grant execute on function public.chat_statuses(uuid) to authenticated, service_role;

select private.fold_member_checks('public.chat_statuses');
