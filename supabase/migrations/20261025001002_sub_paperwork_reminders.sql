-- Reminders before a sub's insurance runs out, modeled on equipment maintenance alerts
-- (emit_equipment_alerts, 20261017001900_equipment.sql).
--
-- The hourly upkeep (apps/api/src/tasks.ts) runs emit_sub_document_alerts(). For the liability
-- insurance and workers' comp (a certificate or an exemption) that counts for each sub, with an end
-- date, the office (owners, admins and office staff with the subs area) hears 30 days before, 7 days
-- before and on the day it ends, once each, from 8 in the morning in the company's time zone. A
-- replaced document stops reminding. The function hands the server the ones the sub should hear
-- about too, by email or text with a link to send a new one, unless the company has turned that off
-- (settings.subs.remind_subs = false, on by default), the server has no way to reach them, or
-- they've already sent a new one that's waiting to be checked. Each reminder is claimed as it's
-- recorded, so two runs at once don't send it twice.
--
-- The office also hears when a sub sends paperwork in by link, to check it.
--
-- Notifications about subs are a topic of their own, "subs", by push unless someone turns it off.

do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.notification_prefs'::regclass and contype = 'c' loop
    execute format('alter table public.notification_prefs drop constraint %I', c);
  end loop;
end $$;
alter table public.notification_prefs add constraint notification_prefs_topics_check check (
  email <@ array['schedule','client','equipment','subs','time','alerts','chat','hosting']
  and sms <@ array['schedule','client','equipment','subs','time','alerts','chat','hosting']
  and push <@ array['schedule','client','equipment','subs','time','alerts','chat','hosting']
);
alter table public.notification_prefs alter column push set default '{schedule,client,equipment,subs,time,alerts,chat,hosting}';
update public.notification_prefs set push = array_append(push, 'subs') where not ('subs' = any (push));

-- "liability insurance", "workers' comp certificate"...: a kind as a sentence reads it.
create function private.sub_document_words(p_kind text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case p_kind
    when 'w9' then 'W-9'
    when 'liability' then 'liability insurance'
    when 'workers_comp' then 'workers'' comp certificate'
    when 'wc_exemption' then 'workers'' comp exemption'
    when 'license' then 'license'
    else 'document'
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- Before a certificate runs out
-- ---------------------------------------------------------------------------------------------

/**
 * Notifies the office about every certificate that counts (as public.sub_paperwork picks it) and
 * has reached a reminder it hasn't had (30 days, 7 days, the day it ends), from 8 am the company's
 * time, records it, and returns those documents. remind_sub says the server should also remind the
 * sub: the company keeps that on, and the sub has an email (p_can_email: the server sends email, or
 * the company has its own mailbox) or a phone (p_can_text: the server sends texts), and hasn't
 * already sent a new one. Run hourly by the server; safe to run twice, at the same time too.
 */
create function public.emit_sub_document_alerts(p_can_text boolean default false, p_can_email boolean default false)
returns table (company_id uuid, subcontractor_id uuid, document_id uuid, kind text, expires_on date, days_left integer, alert text, remind_sub boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r record;
  v_when text;
  v_title text;
  v_body text;
begin
  for r in
    select d.id, d.company_id, d.subcontractor_id, d.kind, d.expires_on, x.days_left, private.sub_alert_due(x.days_left) as due,
           s.name, w.waiting,
           (c.settings -> 'subs' -> 'remind_subs') is distinct from 'false'::jsonb and not w.waiting
             and ((s.email is not null and (coalesce(p_can_email, false)
                   or exists (select 1 from public.integrations i where i.company_id = d.company_id and i.provider = 'email' and i.status <> 'disconnected')))
               or (s.phone is not null and coalesce(p_can_text, false))) as remind
    from public.sub_documents d
    join public.subcontractors s on s.id = d.subcontractor_id
    join public.companies c on c.id = d.company_id
    cross join lateral (select d.expires_on - private.company_today(d.company_id) as days_left) x
    -- Something newer they sent, waiting for the office to check it.
    cross join lateral (
      select exists (
        select 1 from public.sub_documents n
        where n.subcontractor_id = d.subcontractor_id and n.id <> d.id and n.superseded_at is null and n.verified_at is null
          and private.sub_document_group(n.kind) = private.sub_document_group(d.kind) and (n.expires_on is null or n.expires_on >= d.expires_on)
      ) as waiting
    ) w
    where d.kind in ('liability', 'workers_comp', 'wc_exemption') and d.superseded_at is null and d.expires_on is not null
      and s.active
      and d.expires_on <= current_date + 32 -- every time zone's today is within a day of the server's
      and extract(hour from now() at time zone c.timezone) >= 8 -- sent in the morning, not at midnight
      and private.sub_alert_rank(private.sub_alert_due(x.days_left)) > private.sub_alert_rank(d.alerted_state)
      -- Only the one that counts: checked first, then the one that runs longest, then the newest.
      and not exists (
        select 1 from public.sub_documents e
        where e.subcontractor_id = d.subcontractor_id and e.id <> d.id and e.superseded_at is null
          and private.sub_document_group(e.kind) = private.sub_document_group(d.kind)
          and ((e.verified_at is not null), coalesce(e.expires_on, 'infinity'::date), e.created_at, e.id)
            > ((d.verified_at is not null), coalesce(d.expires_on, 'infinity'::date), d.created_at, d.id)
      )
    for update of d skip locked
  loop
    v_when := case
      when r.days_left < 0 then 'has run out'
      when r.days_left = 0 then 'ends today'
      when r.days_left = 1 then 'ends tomorrow'
      else format('ends in %s days', r.days_left)
    end;
    v_title := format('%s''s %s %s', r.name, private.sub_document_words(r.kind), v_when);
    v_body := format('%s %s.', case when r.days_left < 0 then 'It ended' else 'It ends' end, to_char(r.expires_on, 'Mon FMDD, YYYY'))
      || case
        when r.waiting then ' They''ve sent a new one. Have a look and verify it.'
        when r.remind then ' We''re sending them a link to send in a new one.'
        else ''
      end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select r.company_id, o.user_id, 'subs', v_title, v_body, '/subs/' || r.subcontractor_id
    from private.subs_office(r.company_id) as o(user_id);
    update public.sub_documents set alerted_state = r.due where id = r.id;

    company_id := r.company_id;
    subcontractor_id := r.subcontractor_id;
    document_id := r.id;
    kind := r.kind;
    expires_on := r.expires_on;
    days_left := r.days_left;
    alert := r.due;
    remind_sub := r.remind;
    return next;
  end loop;
end $$;
revoke execute on function public.emit_sub_document_alerts(boolean, boolean) from public, anon, authenticated;
grant execute on function public.emit_sub_document_alerts(boolean, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Paperwork a sub sends in
-- ---------------------------------------------------------------------------------------------

create function private.sub_document_received() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_sub text := (select name from public.subcontractors where id = new.subcontractor_id);
begin
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, o.user_id, 'subs',
    format('%s sent %s %s', v_sub, case when new.kind in ('w9', 'license', 'other') then 'a' else 'their' end,
      case when new.kind = 'other' then 'document' else private.sub_document_words(new.kind) end),
    'Have a look and verify it.', '/subs/' || new.subcontractor_id
  from private.subs_office(new.company_id) as o(user_id);
  return null;
end $$;
create trigger received after insert on public.sub_documents
  for each row when (new.uploaded_via <> 'office') execute function private.sub_document_received();

-- ---------------------------------------------------------------------------------------------
-- The company's setting: remind subs themselves (on unless turned off)
-- ---------------------------------------------------------------------------------------------

-- The office with the subs area keeps this one setting; the rest of the company's settings stay
-- with owners and admins.
create function public.set_sub_reminders(p_company uuid, p_remind_subs boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'subs')) then
    raise exception 'Your role can''t change how subs are reminded' using errcode = '42501';
  end if;
  update public.companies
  set settings = jsonb_set(coalesce(settings, '{}'), '{subs}',
    case when jsonb_typeof(settings -> 'subs') = 'object' then settings -> 'subs' else '{}' end || jsonb_build_object('remind_subs', coalesce(p_remind_subs, true)))
  where id = p_company;
end $$;
revoke execute on function public.set_sub_reminders(uuid, boolean) from public, anon;
grant execute on function public.set_sub_reminders(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
