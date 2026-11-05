-- Tags and inspection: the paperwork on a truck or trailer and when it runs out.
--
--   equipment_documents               registration, safety inspection, emissions, insurance, DOT
--                                     inspection or anything else with an end date; one row each,
--                                     kept current by renewing it
--   equipment_paperwork               view: each with its days left and state, like equipment_due
--   renew_equipment_document()        the new end date, logged in the equipment's history (with any cost)
--   emit_equipment_document_alerts()  30 days before, 7 days before and on the day, once each
--
-- Maintenance counts from when it was done; paperwork runs to the date on the decal, sticker or
-- card. Rules differ by state (Virginia registers for 1 to 3 years and counts a renewal from the old
-- date, its inspection runs to the end of the month a year on, Texas dropped inspections), so the
-- app suggests the arithmetic (packages/core/src/equipment.ts renewalChoices) and people confirm it.

create table public.equipment_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  equipment_id uuid not null,
  kind text not null check (kind in ('registration', 'inspection', 'emissions', 'insurance', 'dot_inspection', 'other')),
  name text check (length(trim(name)) between 1 and 80), -- what an "other" is: "Fire extinguisher tag"
  expires_on date, -- null: it doesn't run out (Virginia's permanent trailer plates)
  notes text check (length(notes) <= 2000),
  alerted_state text, -- the last reminder sent for this end date (private.sub_alert_due)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (kind <> 'other' or name is not null),
  foreign key (company_id, equipment_id) references public.equipment (company_id, id) on delete cascade
);
create index equipment_documents_equipment_idx on public.equipment_documents (equipment_id);
-- One registration, inspection... per machine; any number of other things.
create unique index equipment_documents_one_each on public.equipment_documents (equipment_id, kind) where kind <> 'other';
select private.add_touch_triggers(array['equipment_documents']);

-- The whole team sees it (a crew should know the truck's tags ran out); equipment managers keep it.
alter table public.equipment_documents enable row level security;
create policy equipment_documents_read on public.equipment_documents for select to authenticated using (private.is_member(company_id));
create policy equipment_documents_write on public.equipment_documents for all to authenticated
  using (private.manages_equipment(company_id)) with check (private.manages_equipment(company_id));
-- Which reminders went out is the database's.
revoke insert, update on public.equipment_documents from authenticated;
grant insert (company_id, equipment_id, kind, name, expires_on, notes) on public.equipment_documents to authenticated;
grant update (kind, name, expires_on, notes) on public.equipment_documents to authenticated;
select private.fold_member_checks('public.equipment_documents');

-- A new end date: reminders it hasn't reached yet go out again; a day's fix stays quiet.
create function private.equipment_document_alerted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.expires_on is distinct from old.expires_on then
    new.alerted_state := case when new.expires_on is not null then private.sub_alert_carry(old.alerted_state, new.company_id, new.expires_on) end;
  end if;
  return new;
end $$;
create trigger alerted before update on public.equipment_documents
  for each row execute function private.equipment_document_alerted();

-- "registration", "safety inspection", or what an "other" is called.
create function private.equipment_document_words(p_kind text, p_name text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case p_kind
    when 'registration' then 'registration'
    when 'inspection' then 'safety inspection'
    when 'emissions' then 'emissions inspection'
    when 'insurance' then 'insurance'
    when 'dot_inspection' then 'DOT inspection'
    else coalesce(nullif(trim(p_name), ''), 'paperwork')
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- When it runs out
-- ---------------------------------------------------------------------------------------------

-- Paperwork on equipment still in use, with days left in the company's time zone. "overdue" is past
-- its last day, "due_soon" within 30 days (when the first reminder goes out). Runs with the caller's
-- access.
create view public.equipment_paperwork with (security_invoker = true) as
select
  d.id, d.company_id, d.equipment_id, d.kind, d.name, d.expires_on, d.notes,
  e.name as equipment_name, e.kind as equipment_kind, e.crew_id, e.status as equipment_status,
  x.days_left,
  case when x.days_left < 0 then 'overdue' when x.days_left <= 30 then 'due_soon' else 'ok' end as state
from public.equipment_documents d
join public.equipment e on e.id = d.equipment_id
join public.companies c on c.id = d.company_id
cross join lateral (select d.expires_on - (now() at time zone coalesce(c.timezone, 'UTC'))::date as days_left) x
where e.status <> 'retired';

revoke all on public.equipment_paperwork from anon, public;
grant select on public.equipment_paperwork to authenticated, service_role;

-- Renewed: the new end date (null when it no longer runs out), and a line in the equipment's
-- history saying so, with the cost the app recorded (an expense) if there was one. One transaction,
-- so the history can't say it was renewed when the date didn't change. Runs with the caller's
-- access: equipment managers renew; the history entry is theirs.
create function public.renew_equipment_document(p_document uuid, p_expires_on date, p_notes text default null, p_expense uuid default null)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  d public.equipment_documents;
  v_what text;
  v_log uuid;
begin
  update public.equipment_documents set expires_on = p_expires_on where id = p_document returning * into d;
  if d.id is null then
    raise exception 'That paperwork is gone, or your role can''t renew it' using errcode = '42501';
  end if;
  v_what := private.equipment_document_words(d.kind, d.name);
  insert into public.equipment_logs (company_id, equipment_id, kind, title, notes, expense_id)
  values (d.company_id, d.equipment_id, 'service',
    left(upper(left(v_what, 1)) || substr(v_what, 2) || case when p_expires_on is null then ' renewed, doesn''t expire'
      else ' renewed, good through ' || to_char(p_expires_on, 'Mon FMDD, YYYY') end, 120),
    nullif(trim(p_notes), ''), p_expense)
  returning id into v_log;
  return v_log;
end $$;
revoke execute on function public.renew_equipment_document(uuid, date, text, uuid) from public, anon;
grant execute on function public.renew_equipment_document(uuid, date, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Reminders
-- ---------------------------------------------------------------------------------------------

-- Who hears about a machine: people with the equipment area above field crew, and the leads of the
-- crew that has it (as emit_equipment_alerts picks them).
create function private.equipment_watchers(p_company uuid, p_crew uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id
  from public.memberships m
  left join public.company_roles cr on cr.id = m.role_id
  where m.company_id = p_company and m.active
    and 'equipment' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
    and (m.role in ('owner', 'admin', 'office', 'estimator')
         or (m.role = 'crew_lead' and p_crew is not null
             and exists (select 1 from public.crew_members cm where cm.crew_id = p_crew and cm.user_id = m.user_id)))
$$;
revoke execute on function private.equipment_watchers(uuid, uuid) from public, anon, authenticated;

-- Tells them 30 days before, 7 days before and on the day paperwork runs out (or when it's added
-- already late), once each per end date, from 8 in the morning in the company's time zone. Run
-- hourly by the server (apps/api/src/tasks.ts); safe to run twice, at the same time too.
create function public.emit_equipment_document_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_sent integer := 0;
  v_when text;
begin
  for r in
    select d.id, d.company_id, d.equipment_id, d.kind, d.name, d.expires_on, x.days_left, private.sub_alert_due(x.days_left) as due,
           e.name as equipment_name, e.crew_id
    from public.equipment_documents d
    join public.equipment e on e.id = d.equipment_id
    join public.companies c on c.id = d.company_id
    cross join lateral (select d.expires_on - (now() at time zone coalesce(c.timezone, 'UTC'))::date as days_left) x
    where e.status <> 'retired' and d.expires_on is not null
      and d.expires_on <= current_date + 32 -- every time zone's today is within a day of the server's
      and extract(hour from now() at time zone coalesce(c.timezone, 'UTC')) >= 8
      and private.sub_alert_rank(private.sub_alert_due(x.days_left)) > private.sub_alert_rank(d.alerted_state)
    for update of d skip locked
  loop
    v_when := case
      when r.days_left < 0 then 'ran out'
      when r.days_left = 0 then 'runs out today'
      when r.days_left = 1 then 'runs out tomorrow'
      else format('runs out in %s days', r.days_left)
    end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select r.company_id, w, 'equipment',
      format('%s''s %s %s', r.equipment_name, private.equipment_document_words(r.kind, r.name), v_when),
      format('%s %s.', case when r.days_left < 0 then 'It was good through' else 'It''s good through' end, to_char(r.expires_on, 'Mon FMDD, YYYY')),
      '/equipment/' || r.equipment_id
    from private.equipment_watchers(r.company_id, r.crew_id) as w;
    update public.equipment_documents set alerted_state = r.due where id = r.id;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;
revoke execute on function public.emit_equipment_document_alerts() from public, anon, authenticated;
grant execute on function public.emit_equipment_document_alerts() to service_role;

notify pgrst, 'reload schema';
