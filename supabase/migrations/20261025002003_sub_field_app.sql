-- The field app for a sub (docs/subcontractors-plan.md, phase B). The last migration shut subs out of
-- everything; this lets them back in to the short list the plan names, each with a rule of its own:
--
--   visits                the ones they're on, to read, and to move through their steps and leave
--                         notes on (nothing else: visit_sub_guard below)
--   jobs, properties,     the ones behind their visits (the crew's lists), and the gate and lockbox
--   requests              codes by the crew's rule, which property_access_read already applies to
--                         anyone on an open visit there today or tomorrow
--   checklists            their visits' answers, and the company's checklists to fill in
--   photos, plans         their visits' photos (files at <company>/visit/<visit>/...), the plans of
--                         their jobs marked for the crew, and the equipment to bring
--   their own             notifications and notification settings, membership, profile and photo,
--                         paperwork (sub_documents, sub_paperwork and files at
--                         <company>/subs/<their sub>/...), and their time on their own visits, only
--                         while the company has them on the clock (a clock left running stops when
--                         that's turned off, the sub is turned off or their sign-in removed)
--   notices               about their visits, only while their sign-in and the sub are turned on
--   job_scope()           what to do on their jobs, without prices
--   visit_contact()       the client's name, and their phone and email if the office allows it
--   company_basics()      the company's name, logo, time zone, currency and phone, and the settings
--                         the field app reads, in place of the companies row
--
-- A sub doesn't read their own subcontractors row: the office's notes about them are on it ("Only
-- the office sees these"). The server hands the field app what it needs from it (GET /api/me), and
-- sub_paperwork reads the sub through my_subs() for them.
--
-- Everything else stays closed: clients and their contacts, messages, quotes, invoices, the price
-- list, job line items, expenses, chat, guides, the team, crews, other people on their visits, the
-- equipment list, routes, measurements and the companies row.

-- ---------------------------------------------------------------------------------------------
-- Lists for the rules below
-- ---------------------------------------------------------------------------------------------

-- Checklists already filled in on the person's visits as a sub (one turned off since still shows).
create function private.my_sub_templates() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select r.template_id from public.checklist_responses r
  join private.my_sub_visits() v on v.company_id = r.company_id and v.visit_id = r.visit_id
  where r.template_id is not null
$$;

-- The equipment to bring to the person's visits as a sub.
create function private.my_sub_equipment() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select ve.equipment_id from public.visit_equipment ve
  join private.my_sub_visits() v on v.company_id = ve.company_id and v.visit_id = ve.visit_id
$$;

revoke all on function private.my_sub_templates(), private.my_sub_equipment() from public;
grant execute on function private.my_sub_templates(), private.my_sub_equipment() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Their visits, and what's behind them
-- ---------------------------------------------------------------------------------------------

create policy visits_sub_read on public.visits for select to authenticated
  using ((company_id, id) in (select v.company_id, v.visit_id from private.my_sub_visits() v));
create policy visits_sub_update on public.visits for update to authenticated
  using ((company_id, id) in (select v.company_id, v.visit_id from private.my_sub_visits() v))
  with check ((company_id, id) in (select v.company_id, v.visit_id from private.my_sub_visits() v));

-- What a sub changes on their visit: its status as they work through it, and the notes for the
-- office. Not cancelling it or taking it off the schedule, and nothing after it's done or cancelled;
-- when it was finished, and by whom, is the database's to say. (The crew's limits, visit_crew_guard,
-- hold too.) Named to run after visit_defaults.
create function private.visit_sub_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  free constant text[] := array['status', 'notes', 'completed_at', 'completed_by', 'updated_at'];
begin
  if (select auth.uid()) is null or not (old.company_id = any (private.sub_companies())) then return new; end if;
  if to_jsonb(new) - free is distinct from to_jsonb(old) - free then
    raise exception 'You can change a visit''s status and notes. Ask the office about anything else.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and (old.status in ('completed', 'cancelled') or new.status not in ('scheduled', 'en_route', 'in_progress', 'completed')) then
    raise exception 'Ask the office to cancel, move or reopen this visit.' using errcode = '42501';
  end if;
  new.completed_at := case when new.status = 'completed' then coalesce(old.completed_at, now()) else old.completed_at end;
  new.completed_by := case when new.status = 'completed' and old.completed_at is null then (select auth.uid()) else old.completed_by end;
  return new;
end $$;
create trigger visit_sub_guard before update on public.visits for each row execute function private.visit_sub_guard();

-- Their own place on their visits (not who else is on them).
create policy visit_assignees_sub_read on public.visit_assignees for select to authenticated
  using (user_id = (select auth.uid()) and company_id = any ((select private.sub_companies())::uuid[]));

create policy jobs_sub_read on public.jobs for select to authenticated
  using (company_id = any ((select private.sub_companies())::uuid[]) and id in (select private.crew_jobs()));
create policy properties_sub_read on public.properties for select to authenticated
  using (company_id = any ((select private.sub_companies())::uuid[]) and id in (select private.crew_properties()));
create policy requests_sub_read on public.requests for select to authenticated
  using (company_id = any ((select private.sub_companies())::uuid[]) and id in (select private.crew_requests()));

-- ---------------------------------------------------------------------------------------------
-- Checklists, photos, plans and equipment on their visits
-- ---------------------------------------------------------------------------------------------

-- The company's checklists to pick from on a visit, and any already filled in on theirs.
create policy checklist_templates_sub_read on public.checklist_templates for select to authenticated
  using (company_id = any ((select private.sub_companies())::uuid[]) and (active or id in (select private.my_sub_templates())));

-- Filled in on their visits, as the crew does (and not deleted: the office does that).
create policy checklist_responses_sub_read on public.checklist_responses for select to authenticated
  using ((company_id, visit_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v));
create policy checklist_responses_sub_insert on public.checklist_responses for insert to authenticated
  with check ((company_id, visit_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v));
create policy checklist_responses_sub_update on public.checklist_responses for update to authenticated
  using ((company_id, visit_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v))
  with check ((company_id, visit_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v));

-- Their visits' photos, and adding their own, in the visit's folder. They can take back one they
-- added (attachments_delete), as the crew can.
create policy attachments_sub_read on public.attachments for select to authenticated
  using (owner_type = 'visit' and (company_id, owner_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v));
create policy attachments_sub_insert on public.attachments for insert to authenticated
  with check (owner_type = 'visit' and created_by = (select auth.uid())
    and (company_id, owner_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v)
    and starts_with(path, company_id::text || '/visit/' || owner_id::text || '/'));

create policy visit_equipment_sub_read on public.visit_equipment for select to authenticated
  using ((company_id, visit_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v));
-- The machines to bring, by name, for "Bring" on the visit: not the equipment list.
create policy equipment_sub_read on public.equipment for select to authenticated
  using (company_id = any ((select private.sub_companies())::uuid[]) and id in (select private.my_sub_equipment()));

-- The current plans of their jobs that the office marked for the crew.
create policy plan_files_sub_read on public.plan_files for select to authenticated
  using (crew_visible and not archived and superseded_at is null
    and company_id = any ((select private.sub_companies())::uuid[]) and job_id in (select private.crew_jobs()));

-- ---------------------------------------------------------------------------------------------
-- Their own
-- ---------------------------------------------------------------------------------------------

-- Notices about their visits (put on one, a change to it, a plan for the crew) reach a sub only
-- while they can open them: their sign-in and the sub both turned on. Otherwise as
-- 20261017002200_notification_delivery.sql.
create or replace function private.notify_schedule(p_company uuid, p_user uuid, p_visit uuid, p_line text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev public.notifications; v_lines text[];
begin
  if p_user is null or p_user = (select auth.uid()) then
    return; -- you made the change yourself
  end if;
  -- Gone from the team, a sub the office turned off, or the whole company is being deleted.
  if not exists (
    select 1 from public.memberships m join public.companies c on c.id = m.company_id
    where m.company_id = p_company and m.user_id = p_user and m.active
      and (m.role <> 'subcontractor'
           or exists (select 1 from public.subcontractors s where s.company_id = m.company_id and s.id = m.subcontractor_id and s.active))
  ) then
    return;
  end if;
  select * into v_prev from public.notifications
  where company_id = p_company and user_id = p_user and kind = 'schedule'
    and read_at is null and delivered_at is null and created_at > now() - interval '10 minutes'
  order by created_at desc limit 1
  for update;
  if found then
    v_lines := string_to_array(v_prev.body, E'\n');
    if p_line = any (v_lines) then
      return;
    end if;
    v_lines := (v_lines || p_line)[greatest(1, array_length(v_lines, 1) - 18):];
    delete from public.notifications where id = v_prev.id;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    values (p_company, p_user, 'schedule', format('%s changes to your schedule', array_length(v_lines, 1)), array_to_string(v_lines, E'\n'), '/field');
  else
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    values (p_company, p_user, 'schedule', left(p_line, 300), p_line, coalesce('/field/visits/' || p_visit, '/field'));
  end if;
end $$;

create policy notifications_sub_read on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and company_id = any ((select private.sub_companies())::uuid[]));
create policy notification_prefs_sub on public.notification_prefs for all to authenticated
  using (user_id = (select auth.uid()) and company_id = any ((select private.sub_companies())::uuid[]))
  with check (user_id = (select auth.uid()) and company_id = any ((select private.sub_companies())::uuid[]));
create policy memberships_sub_read on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) and company_id = any ((select private.sub_companies())::uuid[]));

-- Their paperwork: reading it, and sending in a new document (sub_document_defaults marks it as
-- theirs and waiting for the office to check it). Changing or removing one is the office's.
create policy sub_documents_sub_read on public.sub_documents for select to authenticated
  using ((company_id, subcontractor_id) in (select s.company_id, s.subcontractor_id from private.my_subs() s));
create policy sub_documents_sub_insert on public.sub_documents for insert to authenticated
  with check ((company_id, subcontractor_id) in (select s.company_id, s.subcontractor_id from private.my_subs() s));

-- Their time, only while the company has them on the clock (subcontractors.uses_clock), as the crew
-- keeps theirs: clocking in and out, and fixing it until it's approved; on their own visits and the
-- jobs behind them, not on work they aren't on. Turning the clock off for a sub closes their time
-- to them (and stops a clock left running, below); the office keeps it.
create policy time_entries_sub_read on public.time_entries for select to authenticated
  using (user_id = (select auth.uid()) and company_id = any ((select private.sub_clock_companies())::uuid[]));
create policy time_entries_sub_insert on public.time_entries for insert to authenticated
  with check (user_id = (select auth.uid()) and company_id = any ((select private.sub_clock_companies())::uuid[])
    and (visit_id is null or (company_id, visit_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v))
    and (job_id is null or job_id in (select private.crew_jobs())));
create policy time_entries_sub_update on public.time_entries for update to authenticated
  using (user_id = (select auth.uid()) and approved_at is null and company_id = any ((select private.sub_clock_companies())::uuid[]))
  with check (user_id = (select auth.uid()) and approved_at is null and company_id = any ((select private.sub_clock_companies())::uuid[])
    and (visit_id is null or (company_id, visit_id) in (select v.company_id, v.visit_id from private.my_sub_visits() v))
    and (job_id is null or job_id in (select private.crew_jobs())));
create policy time_entries_sub_clock on public.time_entries as restrictive for all to authenticated
  using (company_id <> all ((select private.sub_companies())::uuid[]) or company_id = any ((select private.sub_clock_companies())::uuid[]))
  with check (company_id <> all ((select private.sub_companies())::uuid[]) or company_id = any ((select private.sub_clock_companies())::uuid[]));

-- A clock a sub left running when the office takes them off the clock, turns them off or removes
-- their sign-in: stopped now, as they can no longer see it to stop it themselves (and their hours
-- would keep counting until the forgotten-clock upkeep caught it). Whoever flips the switch may not
-- have the timesheets area, so the database stops it.
create function private.end_sub_clocks(p_company uuid, p_user uuid) returns void
language sql security definer set search_path = '' as $$
  update public.time_entries set ended_at = greatest(now(), started_at)
  where company_id = p_company and user_id = p_user and ended_at is null
$$;
revoke all on function private.end_sub_clocks(uuid, uuid) from public;

create function private.sub_clock_off() returns trigger
language plpgsql security definer set search_path = '' as $$
declare m record;
begin
  if tg_table_name = 'subcontractors' then
    if (old.uses_clock and not new.uses_clock) or (old.active and not new.active) then
      for m in select x.user_id from public.memberships x where x.company_id = new.company_id and x.subcontractor_id = new.id loop
        perform private.end_sub_clocks(new.company_id, m.user_id);
      end loop;
    end if;
  elsif old.active and not new.active and old.role = 'subcontractor' then
    perform private.end_sub_clocks(old.company_id, old.user_id);
  end if;
  return null;
end $$;
create trigger sub_clock_off after update of uses_clock, active on public.subcontractors for each row execute function private.sub_clock_off();
create trigger sub_clock_off after update of active on public.memberships for each row execute function private.sub_clock_off();

-- The paperwork status of each sub the person may see: the office's (as row-level security on
-- subcontractors shows them) and, for a sub, their own. Otherwise as 20261025001001_subcontractors.sql.
create or replace view public.sub_paperwork with (security_invoker = true) as
select
  s.company_id, s.id as subcontractor_id, r.requirement,
  case
    when d.id is null then 'missing'
    when d.expires_on is null then 'ok'
    when d.expires_on < t.today then 'expired'
    when d.expires_on <= t.today + 30 then 'expiring'
    else 'ok'
  end as state,
  d.id as document_id, d.kind, d.expires_on, d.expires_on - t.today as days_left,
  case when d.id is not null then d.verified_at is not null end as verified,
  exists (
    select 1 from public.sub_documents w
    where w.subcontractor_id = s.id and w.superseded_at is null and w.verified_at is null
      and private.sub_document_group(w.kind) = r.requirement and (w.expires_on is null or w.expires_on >= t.today)
  ) as waiting
from (
  select x.company_id, x.id, x.active from public.subcontractors x
  union all
  select m.company_id, m.subcontractor_id, true from private.my_subs() m
) s
cross join (values (1, 'w9'), (2, 'liability'), (3, 'workers_comp')) as r(position, requirement)
cross join lateral (select private.company_today(s.company_id) as today) t
left join lateral (
  select doc.id, doc.kind, doc.expires_on, doc.verified_at
  from public.sub_documents doc
  where doc.subcontractor_id = s.id and doc.superseded_at is null and private.sub_document_group(doc.kind) = r.requirement
  order by (doc.verified_at is not null) desc, doc.expires_on desc nulls first, doc.created_at desc, doc.id desc
  limit 1
) d on true
where s.active;

-- ---------------------------------------------------------------------------------------------
-- Stored files
-- ---------------------------------------------------------------------------------------------

-- Whether a paperwork file is a document's (read past row-level security: the office's, or one the
-- sub can't see).
create function private.sub_file_filed(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sub_documents d where d.path = p_path)
$$;
revoke all on function private.sub_file_filed(text) from public;
grant execute on function private.sub_file_filed(text) to authenticated, service_role;

-- Their visits' photos, their own paperwork and photo, and the plans they can see (by their row).
create policy files_sub_read on storage.objects for select to authenticated using (
  bucket_id = 'files' and private.path_company(name) = any ((select private.sub_companies())::uuid[]) and (
    (split_part(name, '/', 2) = 'visit'
      and (private.path_company(name), split_part(name, '/', 3)) in (select v.company_id, v.visit_id::text from private.my_sub_visits() v))
    or (split_part(name, '/', 2) = 'subs'
      and (private.path_company(name), split_part(name, '/', 3)) in (select s.company_id, s.subcontractor_id::text from private.my_subs() s))
    or (split_part(name, '/', 2) = 'avatars' and split_part(name, '/', 3) = (select auth.uid())::text)
    or (split_part(name, '/', 2) = 'plans' and exists (select 1 from public.plan_files f where f.path = objects.name))
  )
);
-- Photos for their visits, and paperwork into their own folder.
create policy files_sub_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'files' and private.path_company(name) = any ((select private.sub_companies())::uuid[]) and split_part(name, '/', 4) <> '' and (
    (split_part(name, '/', 2) = 'visit'
      and (private.path_company(name), split_part(name, '/', 3)) in (select v.company_id, v.visit_id::text from private.my_sub_visits() v))
    or (split_part(name, '/', 2) = 'subs'
      and (private.path_company(name), split_part(name, '/', 3)) in (select s.company_id, s.subcontractor_id::text from private.my_subs() s))
  )
);
-- A photo they added to their visit, taken back; and a paperwork file they stored that never became
-- a document (the database turned the document down), tidied away. Once it's a document, it's the
-- office's.
create policy files_sub_delete on storage.objects for delete to authenticated using (
  bucket_id = 'files' and owner = (select auth.uid()) and (
    (split_part(name, '/', 2) = 'visit'
      and (private.path_company(name), split_part(name, '/', 3)) in (select v.company_id, v.visit_id::text from private.my_sub_visits() v))
    or (split_part(name, '/', 2) = 'subs'
      and (private.path_company(name), split_part(name, '/', 3)) in (select s.company_id, s.subcontractor_id::text from private.my_subs() s)
      and not private.sub_file_filed(name))
  )
);
-- Paperwork files: the office with the subs area, or the sub into their own folder. Replacing one
-- stays the office's (files_subs_update), and so does removing one, except a sub's own file that
-- isn't a document (files_sub_delete).
drop policy files_subs_insert on storage.objects;
create policy files_subs_insert on storage.objects as restrictive for insert to authenticated with check (
  bucket_id <> 'files' or split_part(name, '/', 2) <> 'subs'
  or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs'))
  or (private.path_company(name), split_part(name, '/', 3)) in (select s.company_id, s.subcontractor_id::text from private.my_subs() s)
);
drop policy files_subs_delete on storage.objects;
create policy files_subs_delete on storage.objects as restrictive for delete to authenticated using (
  bucket_id <> 'files' or split_part(name, '/', 2) <> 'subs'
  or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs'))
  or (owner = (select auth.uid()) and not private.sub_file_filed(name)
      and (private.path_company(name), split_part(name, '/', 3)) in (select s.company_id, s.subcontractor_id::text from private.my_subs() s))
);

-- ---------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------

-- What to do on a job, without prices: for crew leads and up, the crew on its visits and a sub on them.
create or replace function public.job_scope(p_job uuid)
returns table (id uuid, name text, description text, quantity numeric, unit text, sort integer)
language sql stable security definer set search_path = '' as $$
  select li.id, li.name, li.description, li.quantity, li.unit, li.sort
  from public.job_line_items li
  join public.jobs j on j.id = li.job_id
  where li.job_id = p_job
    and li.unit_price >= 0 -- discount lines are about money, not work
    and (private.has_role(j.company_id, '{owner,admin,office,estimator,crew_lead}')
         or (private.is_member(j.company_id) and private.crew_sees_job(j.id))
         or (j.company_id = any (private.sub_companies()) and private.crew_sees_job(j.id)))
  order by li.sort, li.name
$$;

/**
 * Who a visit is for: the client's name to anyone who can see the visit, and their phone and email
 * to those who'd read the client anyway (crew leads and up, and the crew on the visit), or to a sub
 * on the visit whose office lets them contact clients (subcontractors.can_contact_clients). The
 * field app asks this for a sub, who can't read clients. No row when the visit isn't theirs to see,
 * or isn't for a client.
 */
create function public.visit_contact(p_visit uuid) returns table (name text, phone text, email text)
language sql stable security definer set search_path = '' as $$
  with seen as (
    select v.company_id, private.visit_client(v) as client_id,
      case
        when private.has_role(v.company_id, '{owner,admin,office,estimator,crew_lead}')
          or (private.is_member(v.company_id) and v.id in (select private.my_assigned_visits())) then true
        else (select s.can_contact_clients from private.my_subs() s
              where s.company_id = v.company_id and v.id in (select x.visit_id from private.my_sub_visits() x where x.company_id = v.company_id))
      end as contact
    from public.visits v
    where v.id = p_visit
  )
  select c.display_name, case when s.contact then c.phone end, case when s.contact then c.email end
  from seen s join public.clients c on c.id = s.client_id and c.company_id = s.company_id
  where s.contact is not null
$$;

/**
 * The company as the field app needs it, for anyone with a sign-in for it (the team and subs): its
 * name, logo, time zone, currency and phone, and of its settings only the time clock's, its branding
 * and its working hours. The companies row also holds the AI assistant, maps, tax and review
 * settings, and a sub can't read it.
 */
create function public.company_basics(p_company uuid)
returns table (id uuid, name text, timezone text, currency text, phone text, logo text, settings jsonb)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.timezone, c.currency, c.phone,
    case when c.settings -> 'branding' ->> 'logo' ~ ('^' || c.id::text || '/logo/[0-9a-f-]{36}\.png$') then c.settings -> 'branding' ->> 'logo' end,
    (select coalesce(jsonb_object_agg(e.key, e.value), '{}') from jsonb_each(coalesce(c.settings, '{}')) e
     where e.key in ('clock', 'branding', 'working_hours'))
  from public.companies c
  where c.id = p_company and p_company = any (private.worker_companies())
$$;

revoke execute on function public.visit_contact(uuid), public.company_basics(uuid) from public, anon;
grant execute on function public.visit_contact(uuid), public.company_basics(uuid) to authenticated, service_role;

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
-- One quick try (half a second at most) while this migration holds its own locks: if a table is
-- busy, nothing is changed, and scripts/migrate.mjs folds the rest a table at a time right after.
select private.fold_member_checks(null, interval '0');

notify pgrst, 'reload schema';
