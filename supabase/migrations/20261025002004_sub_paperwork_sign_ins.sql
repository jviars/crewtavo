-- A sub's paperwork from their own sign-in (docs/subcontractors-plan.md, phase B: "My paperwork").
--
--   - A document a sub adds from the field app is theirs and waits for the office to check it, like
--     one sent by link: sub_document_defaults marks it sent by the sub, unchecked, with them as who
--     sent it, whatever the browser says. A certificate says when it ends, and not on a day already
--     past (as endDateProblem in packages/core/src/subs.ts, which the link's page uses).
--   - And it's a file they stored first: the row points at their own file in their folder, and its
--     type and size are the ones Storage recorded, not what the browser says. Only PDFs and photos,
--     as the link takes (routes/subs.ts), so nothing the office opens can be a web page. At most 20
--     a day, since each one tells the office.
--   - The reminders before a certificate runs out (emit_sub_document_alerts) also reach the sub's
--     sign-in, as a notification that opens their paperwork, unless the company turned reminding
--     subs off or they've already sent a new one. The email or text with a link still goes out as
--     before, for subs who never sign in.

create or replace function private.sub_document_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_today date;
  v_file record;
begin
  perform 1 from public.subcontractors where id = new.subcontractor_id for no key update;
  if (select auth.uid()) is not null then
    new.uploaded_by := (select auth.uid());
    if private.has_role(new.company_id, '{owner,admin,office}') and private.has_perm(new.company_id, 'subs') then
      new.uploaded_via := 'office';
      new.verified_at := now();
      new.verified_by := (select auth.uid());
    else
      -- The sub themselves (sub_documents_sub_insert lets them add only their own; anyone else is
      -- refused by it, so these checks are for their own).
      new.uploaded_via := 'sub';
      new.verified_at := null;
      new.verified_by := null;
      if (new.company_id, new.subcontractor_id) not in (select m.company_id, m.subcontractor_id from private.my_subs() m) then
        return new;
      end if;
      v_today := private.company_today(new.company_id);
      if new.expires_on < v_today then
        raise exception 'That date has already passed. Check it, or send the newer one.' using errcode = '22023';
      end if;
      if new.kind not in ('license', 'other') and new.expires_on > v_today + 5 * 366 then
        raise exception 'Check the date it ends. It''s more than five years away.' using errcode = '22023';
      end if;
      select o.metadata ->> 'mimetype' as type, o.metadata ->> 'size' as size into v_file
      from storage.objects o
      where o.bucket_id = 'files' and o.name = new.path and o.owner = (select auth.uid());
      if not found then
        raise exception 'Send the file first, then try again.' using errcode = '22023';
      end if;
      if lower(split_part(coalesce(v_file.type, ''), ';', 1)) not in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp') then
        raise exception 'Send a PDF or a photo (JPG, PNG or HEIC).' using errcode = '22023';
      end if;
      new.content_type := lower(split_part(v_file.type, ';', 1));
      new.size_bytes := case when v_file.size ~ '^[0-9]{1,15}$' then v_file.size::bigint end;
      if (select count(*) from public.sub_documents d
          where d.subcontractor_id = new.subcontractor_id and d.uploaded_via = 'sub' and d.created_at > now() - interval '1 day') >= 20 then
        raise exception 'That''s a lot sent today. Try again tomorrow, or call the office.' using errcode = '22023';
      end if;
    end if;
  end if;
  new.alerted_state := null;
  new.superseded_at := null;
  new.superseded_by := null;
  return new;
end $$;

/**
 * As in 20261025001002_sub_paperwork_reminders.sql, and the sub's sign-in hears too: a "subs"
 * notification that opens their paperwork (/field/paperwork), unless the company turned reminding
 * subs off or they've already sent a new one that's waiting to be checked.
 */
create or replace function public.emit_sub_document_alerts(p_can_text boolean default false, p_can_email boolean default false)
returns table (company_id uuid, subcontractor_id uuid, document_id uuid, kind text, expires_on date, days_left integer, alert text, remind_sub boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r record;
  v_when text;
  v_title text;
  v_body text;
  v_ends text;
begin
  for r in
    select d.id, d.company_id, d.subcontractor_id, d.kind, d.expires_on, x.days_left, private.sub_alert_due(x.days_left) as due,
           s.name, w.waiting,
           (c.settings -> 'subs' -> 'remind_subs') is distinct from 'false'::jsonb and not w.waiting
             and ((s.email is not null and (coalesce(p_can_email, false)
                   or exists (select 1 from public.integrations i where i.company_id = d.company_id and i.provider = 'email' and i.status <> 'disconnected')))
               or (s.phone is not null and coalesce(p_can_text, false))) as remind,
           (c.settings -> 'subs' -> 'remind_subs') is distinct from 'false'::jsonb and not w.waiting as remind_sign_in
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
    v_ends := format('%s %s.', case when r.days_left < 0 then 'It ended' else 'It ends' end, to_char(r.expires_on, 'Mon FMDD, YYYY'));
    v_title := format('%s''s %s %s', r.name, private.sub_document_words(r.kind), v_when);
    v_body := v_ends
      || case
        when r.waiting then ' They''ve sent a new one. Have a look and verify it.'
        when r.remind then ' We''re sending them a link to send in a new one.'
        else ''
      end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select r.company_id, o.user_id, 'subs', v_title, v_body, '/subs/' || r.subcontractor_id
    from private.subs_office(r.company_id) as o(user_id);
    if r.remind_sign_in then
      insert into public.notifications (company_id, user_id, kind, title, body, link)
      select r.company_id, m.user_id, 'subs', format('Your %s %s', private.sub_document_words(r.kind), v_when),
        v_ends || ' Send us the new one under My paperwork.', '/field/paperwork'
      from public.memberships m
      where m.company_id = r.company_id and m.subcontractor_id = r.subcontractor_id and m.active;
    end if;
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

notify pgrst, 'reload schema';
