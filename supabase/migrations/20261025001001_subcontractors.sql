-- Subcontractors and their paperwork (docs/subcontractors-plan.md, phase A).
--
--   subcontractors   the businesses a company hires: who to call, their trade and the W-9's tax
--                    classification. A record the office keeps whether or not the sub ever signs in.
--   sub_documents    their W-9, liability and workers' comp certificates (or an exemption),
--                    licenses and anything else, with the policy's dates. A newer one of the same
--                    kind replaces the one before, which is kept for the record. What a sub sends
--                    waits for the office to check it before it replaces a checked one.
--   sub_paperwork    view: for each active sub, whether the W-9, liability insurance and workers'
--                    comp are OK, run out within 30 days, have run out, or aren't on file.
--   files            stored under <company>/subs/<sub>/..., out of the team's reach: W-9s carry
--                    tax ID numbers.
--
-- All of it is for owners, admins and office staff with the new "subs" area ("Subcontractors,
-- their paperwork and pay"). Subs can't sign in yet; when they can, each will read their own record
-- and paperwork, which adds a policy of its own next to the office's.
--
-- Lapsed or missing insurance only warns. Nothing here stops work going to a sub.

-- ---------------------------------------------------------------------------------------------
-- The subs area (mirrors LEVEL_PERMISSIONS in packages/core/src/roles.ts)
-- ---------------------------------------------------------------------------------------------

create or replace function private.level_permissions(p_level public.member_role) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select case p_level
    when 'owner' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps','equipment','subs']
    when 'admin' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps','equipment','subs']
    when 'office' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','equipment','subs']
    when 'estimator' then array['sales','schedule','equipment']
    when 'crew_lead' then array['schedule','timesheets','equipment']
    else array[]::text[]
  end
$$;

-- Custom roles keep what they have. Those that handle job costs handle subs too: they're who pays
-- them.
update public.company_roles set permissions = permissions || array['subs']
where base_role in ('admin', 'office') and 'job_costs' = any (permissions) and not ('subs' = any (permissions));

create or replace function private.install_default_roles(p_company uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.company_roles (company_id, name, description, base_role, permissions) values
    (p_company, 'General manager', 'Runs the business day to day.', 'admin',
     array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','equipment','subs']),
    (p_company, 'Office manager', 'Books work, schedules crews, sends quotes and invoices, and approves time.', 'office',
     array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','equipment','subs']),
    (p_company, 'Operations manager', 'Schedules crews and keeps jobs on track.', 'office',
     array['sales','job_costs','reports','schedule','timesheets','kb_edit','equipment','subs']),
    (p_company, 'Foreman', 'Runs their crew: schedules its visits, assigns its people and sees its time. No prices.', 'crew_lead', array['equipment']),
    (p_company, 'Employee', 'Works their own visits.', 'field_crew', array[]::text[])
  on conflict do nothing
$$;

-- The people who look after subs: owners, admins and office staff with the area.
create function private.subs_office(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id
  from public.memberships m
  left join public.company_roles cr on cr.id = m.role_id
  where m.company_id = p_company and m.active and m.role in ('owner', 'admin', 'office')
    and 'subs' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
$$;
revoke execute on function private.subs_office(uuid) from public;
grant execute on function private.subs_office(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.subcontractors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120), -- the business
  contact_name text check (length(contact_name) <= 120),
  phone text check (length(phone) <= 30),
  email text check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  trade text check (length(trade) <= 80),
  address jsonb not null default '{}' check (jsonb_typeof(address) = 'object' and length(address::text) <= 2000),
  -- From the W-9 (box 3). Corporations usually don't get a 1099.
  tax_classification text check (tax_classification in
    ('individual', 'c_corp', 's_corp', 'partnership', 'llc_c_corp', 'llc_s_corp', 'llc_partnership', 'other')),
  notes text check (length(notes) <= 4000),
  active boolean not null default true,
  -- For when subs sign in: whether they see the client's phone and email, and whether they clock.
  can_contact_clients boolean not null default false,
  uses_clock boolean not null default false,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index subcontractors_company_idx on public.subcontractors (company_id, active, name);

create table public.sub_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  subcontractor_id uuid not null,
  kind text not null check (kind in ('w9', 'liability', 'workers_comp', 'wc_exemption', 'license', 'other')),
  title text check (length(title) <= 200),
  -- Storage object key, always in the sub's own folder.
  path text not null unique check (length(path) <= 500 and starts_with(path, company_id::text || '/subs/' || subcontractor_id::text || '/')
    and length(path) > length(company_id::text || '/subs/' || subcontractor_id::text || '/') and path !~ '(^|/)\.\.?(/|$)'),
  file_name text check (length(file_name) <= 255),
  content_type text check (length(content_type) <= 150),
  size_bytes bigint check (size_bytes >= 0),
  carrier text check (length(carrier) <= 120),
  policy_number text check (length(policy_number) <= 80),
  starts_on date,
  expires_on date,
  -- Checked by the office. What the office adds counts as checked; what a sub sends waits for it.
  verified_at timestamptz,
  verified_by uuid references auth.users (id) on delete set null,
  -- Replaced by a newer document of the same kind (kept by the triggers below; a workers' comp
  -- certificate and an exemption replace each other).
  superseded_at timestamptz,
  superseded_by uuid,
  -- The last reminder sent about its end date (emit_sub_document_alerts).
  alerted_state text check (alerted_state in ('d30', 'd7', 'expired')),
  uploaded_by uuid references auth.users (id) on delete set null,
  uploaded_via text not null default 'office' check (uploaded_via in ('office', 'link', 'sub')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'w9' or expires_on is null), -- a W-9 never runs out
  -- A certificate a sub sends says when it ends: without it, it would read OK for good.
  check (uploaded_via = 'office' or kind not in ('liability', 'workers_comp') or expires_on is not null),
  check (starts_on is null or expires_on is null or expires_on >= starts_on),
  foreign key (company_id, subcontractor_id) references public.subcontractors (company_id, id) on delete cascade
);
create index sub_documents_sub_idx on public.sub_documents (subcontractor_id, kind, expires_on desc) where superseded_at is null;
create index sub_documents_expiring_idx on public.sub_documents (expires_on)
  where superseded_at is null and expires_on is not null and kind in ('liability', 'workers_comp', 'wc_exemption');

select private.add_touch_triggers(array['subcontractors', 'sub_documents']);

-- ---------------------------------------------------------------------------------------------
-- Access: the office with the subs area
-- ---------------------------------------------------------------------------------------------

alter table public.subcontractors enable row level security;
create policy subcontractors_office on public.subcontractors for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'subs'))
  with check (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'subs'));

alter table public.sub_documents enable row level security;
create policy sub_documents_office on public.sub_documents for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'subs'))
  with check (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'subs'));
-- Where a file is, who sent it and what replaced it are kept by the database.
revoke insert, update on public.sub_documents from authenticated;
grant insert (company_id, subcontractor_id, kind, title, path, file_name, content_type, size_bytes, carrier, policy_number, starts_on, expires_on)
  on public.sub_documents to authenticated;
grant update (title, carrier, policy_number, starts_on, expires_on, verified_at) on public.sub_documents to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Keeping documents straight
-- ---------------------------------------------------------------------------------------------

-- Kinds where a newer document replaces the one before. A sub can hold several licenses at once.
create function private.sub_document_replaces(p_kind text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select p_kind in ('w9', 'liability', 'workers_comp', 'wc_exemption')
$$;

-- The paperwork a kind counts toward. A workers' comp certificate and an exemption both cover
-- workers' comp, so either replaces the other.
create function private.sub_document_group(p_kind text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case when p_kind = 'wc_exemption' then 'workers_comp' else p_kind end
$$;

-- Reminders go out 30 days before, 7 days before and on the day a certificate ends
-- (packages/core/src/subs.ts paperworkAlert). Null while none is due.
create function private.sub_alert_due(p_days_left integer) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case when p_days_left is null then null when p_days_left <= 0 then 'expired' when p_days_left <= 7 then 'd7' when p_days_left <= 30 then 'd30' end
$$;
create function private.sub_alert_rank(p_alert text) returns integer
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(array_position(array['d30', 'd7', 'expired'], p_alert), 0)
$$;

-- The reminders already sent that still hold for an end date: the same date (or a day's fix) stays
-- quiet, and a later one takes back the reminders it hasn't reached yet.
create function private.sub_alert_carry(p_sent text, p_company uuid, p_expires date) returns text
language sql stable set search_path = '' as $$
  select case
    when private.sub_alert_rank(private.sub_alert_due(p_expires - private.company_today(p_company))) < private.sub_alert_rank(p_sent)
      then private.sub_alert_due(p_expires - private.company_today(p_company))
    else p_sent
  end
$$;

-- A signed-in person adding a document: it's theirs, from the office, and checked. The server
-- records what a sub sends by link as it comes (unchecked). Documents for one sub are added one at
-- a time, so two sent at once can't both stay current.
create function private.sub_document_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.subcontractors where id = new.subcontractor_id for no key update;
  if (select auth.uid()) is not null then
    new.uploaded_by := (select auth.uid());
    new.uploaded_via := 'office';
    new.verified_at := now();
    new.verified_by := (select auth.uid());
  end if;
  new.alerted_state := null;
  new.superseded_at := null;
  new.superseded_by := null;
  return new;
end $$;
create trigger defaults before insert on public.sub_documents for each row execute function private.sub_document_defaults();

-- A document taking its place among the sub's current paperwork of the same kind (workers' comp
-- certificates and exemptions together), as it's added or checked:
--   - A checked one replaces the others, except something the sub sent that ends later (it waits
--     to be checked). One that ends before a checked one on file is an older one (found in a
--     drawer, say): kept for the record, replaced from the start.
--   - One the sub sent, unchecked, replaces only what else they sent that's waiting. The office's
--     checked certificate keeps counting, and reminding, until the new one is checked.
-- It carries the reminders already sent about the one it replaces, so the same certificate sent
-- again doesn't remind again. A replaced document stops counting and stops reminding.
create function private.sub_document_take_place(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d public.sub_documents;
  v_newer uuid;
  v_sent text;
begin
  select * into d from public.sub_documents where id = p_id;
  if d.id is null or d.superseded_at is not null or not private.sub_document_replaces(d.kind) then return; end if;
  if d.verified_at is not null and d.expires_on is not null then
    select o.id into v_newer from public.sub_documents o
    where o.subcontractor_id = d.subcontractor_id and o.id <> d.id and o.superseded_at is null and o.verified_at is not null
      and private.sub_document_group(o.kind) = private.sub_document_group(d.kind) and o.expires_on > d.expires_on
    order by o.expires_on desc, o.created_at desc
    limit 1;
    if v_newer is not null then
      update public.sub_documents set superseded_at = now(), superseded_by = v_newer where id = d.id;
      return;
    end if;
  end if;
  with replaced as (
    update public.sub_documents o set superseded_at = now(), superseded_by = d.id
    where o.subcontractor_id = d.subcontractor_id and o.id <> d.id and o.superseded_at is null
      and private.sub_document_group(o.kind) = private.sub_document_group(d.kind)
      and case
        when d.verified_at is null then o.verified_at is null
        else o.verified_at is not null or o.expires_on is null or d.expires_on is null or o.expires_on <= d.expires_on
      end
    returning o.alerted_state
  )
  select alerted_state into v_sent from replaced order by private.sub_alert_rank(alerted_state) desc limit 1;
  v_sent := private.sub_alert_carry(v_sent, d.company_id, d.expires_on);
  if private.sub_alert_rank(v_sent) > private.sub_alert_rank(d.alerted_state) then
    update public.sub_documents set alerted_state = v_sent where id = d.id;
  end if;
end $$;
revoke execute on function private.sub_document_take_place(uuid) from public;

create function private.sub_document_replace() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.sub_document_take_place(new.id);
  return null;
end $$;
create trigger replace_older after insert on public.sub_documents for each row execute function private.sub_document_replace();
create trigger replace_when_checked after update of verified_at on public.sub_documents
  for each row when (old.verified_at is null and new.verified_at is not null and new.superseded_at is null)
  execute function private.sub_document_replace();

-- Removing the current document (say one a sub sent by mistake) puts back the best of those it
-- replaced; the rest are now replaced by that one. Those an older document had replaced pass to
-- the one that replaced it.
create function private.sub_document_restore() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_back uuid;
begin
  if old.superseded_by is null then
    select d.id into v_back from public.sub_documents d where d.superseded_by = old.id
    order by (d.verified_at is not null) desc, d.expires_on desc nulls first, d.created_at desc
    limit 1;
  end if;
  update public.sub_documents
  set superseded_by = case when id = v_back then null else coalesce(old.superseded_by, v_back) end,
      superseded_at = case when id = v_back then null else superseded_at end
  where superseded_by = old.id;
  return null;
end $$;
create trigger restore_replaced after delete on public.sub_documents for each row execute function private.sub_document_restore();

-- Checking a document stamps who and when (one sub's documents are checked one at a time, like
-- they're added). A new end date only reminds again for what's still to come.
create function private.sub_document_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.verified_at is distinct from old.verified_at then
    new.verified_at := case when new.verified_at is not null then now() end;
    new.verified_by := case when new.verified_at is not null then (select auth.uid()) end;
  end if;
  if old.verified_at is null and new.verified_at is not null then
    perform 1 from public.subcontractors where id = new.subcontractor_id for no key update;
  end if;
  if new.expires_on is distinct from old.expires_on and new.alerted_state is not null then
    new.alerted_state := private.sub_alert_carry(new.alerted_state, new.company_id, new.expires_on);
  end if;
  return new;
end $$;
create trigger guard before update on public.sub_documents for each row execute function private.sub_document_guard();

-- ---------------------------------------------------------------------------------------------
-- Paperwork status
-- ---------------------------------------------------------------------------------------------

-- One row for each active sub and each required piece of paperwork, on the company's today: "ok",
-- "expiring" (ends within 30 days, the day it ends included), "expired" or "missing". A replaced
-- document doesn't count. Of the rest, a checked one counts before one the sub sent that the office
-- hasn't checked, then the one that runs longest (no end date first), then the newest; "verified"
-- is false when the one that counts is unchecked. "waiting" says the sub sent one that's waiting to
-- be checked (and hasn't run out), whichever counts. Workers' comp is covered by a certificate or an
-- exemption. Runs with the caller's access. Mirrors paperworkStatus() in packages/core/src/subs.ts.
create view public.sub_paperwork with (security_invoker = true) as
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
from public.subcontractors s
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

revoke all on public.sub_paperwork from anon, public;
grant select on public.sub_paperwork to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Stored files: <company>/subs/<sub>/... only for the office with the subs area
-- ---------------------------------------------------------------------------------------------

-- Receipts and chat photos keep their rules (20261019001600_team_chat.sql); everything else stays
-- readable by the team as before.
drop policy files_read on storage.objects;
create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'files' and private.is_member(private.path_company(name)) and (
    split_part(name, '/', 2) not in ('receipts', 'chat', 'subs')
    or (split_part(name, '/', 2) = 'receipts' and (owner = (select auth.uid()) or private.has_perm(private.path_company(name), 'job_costs')))
    or (split_part(name, '/', 2) = 'chat' and private.chat_can(private.chat_file_channel(name), 'see'))
    or (split_part(name, '/', 2) = 'subs' and private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs'))
  )
);
-- Adding, replacing or removing one needs the same, whoever uploaded it.
create policy files_subs_insert on storage.objects as restrictive for insert to authenticated with check (
  bucket_id <> 'files' or split_part(name, '/', 2) <> 'subs'
  or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs'))
);
create policy files_subs_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'files' or split_part(name, '/', 2) <> 'subs'
    or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs')))
  with check (bucket_id <> 'files' or split_part(name, '/', 2) <> 'subs'
    or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs')));
create policy files_subs_delete on storage.objects as restrictive for delete to authenticated using (
  bucket_id <> 'files' or split_part(name, '/', 2) <> 'subs'
  or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs'))
);

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
-- One quick try (half a second at most) while this migration holds its own locks: if a table is
-- busy, nothing is changed, and scripts/migrate.mjs folds the rest a table at a time right after.
select private.fold_member_checks(null, interval '0');

notify pgrst, 'reload schema';
