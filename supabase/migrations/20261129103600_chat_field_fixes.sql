-- Team chat in the field (20261129103300 to 103500), made safer:
--
--   * A scheduled message's id is the database's own, never one someone picks. It becomes the
--     message's id once it's sent, so a picked one could name another message: the minute's run
--     would have taken that message for this one, sent already, and shown it to this channel.
--   * public.chat_send_due counts a message as sent already only when it's this one (the same
--     channel, author and company); anything else is a problem. It gives up on a message only for
--     what means it can't be sent (no right to post, a rule it breaks): a lock, a deadlock or the
--     server being busy has it tried again a few minutes on, up to ten times. While Team chat, or
--     direct messages for a conversation, is turned off, a scheduled message and a reminder wait for
--     it to come back on, instead of being thrown away.
--   * Send now is public.chat_send_scheduled_now: it takes the row as it sends, so it and the
--     minute's run never both send one, and the run doesn't send again what it sent.
--   * A scheduled message with only a job on it no longer stops the job being deleted (its link is
--     cleared, as on a message).
--   * Status, and what the clock says, only while Team chat is on.

alter table public.chat_scheduled_messages
  add column tries integer not null default 0,
  add column retry_at timestamptz;

create or replace function private.chat_scheduled_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    new.created_at := now();
    new.tries := 0;
    new.retry_at := null;
  else
    if (new.id, new.company_id, new.channel_id, new.author_id, new.created_at) is distinct from (old.id, old.company_id, old.channel_id, old.author_id, old.created_at) then
      raise exception 'A scheduled message can''t be moved or reassigned' using errcode = '42501';
    end if;
    -- A deleted job or replied-to message clears its link here (as chat_message_guard does).
    if ((new.job_id is null and old.job_id is not null) or (new.reply_to is null and old.reply_to is not null))
       and (new.body, new.attachments, new.send_at) is not distinct from (old.body, old.attachments, old.send_at) then
      return new;
    end if;
    -- Its tries are the server's to count.
    if (select auth.uid()) is not null then
      new.tries := old.tries;
      new.retry_at := old.retry_at;
    end if;
  end if;
  new.updated_at := now();
  if (tg_op = 'INSERT' or new.send_at is distinct from old.send_at) and (new.send_at <= now() or new.send_at > now() + interval '366 days') then
    raise exception 'Pick a time in the next year to send it' using errcode = '22023';
  end if;
  if length(trim(new.body)) = 0 and jsonb_array_length(new.attachments) = 0 and new.job_id is null then
    raise exception 'Write a message first' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.attachments) a
    where jsonb_typeof(a) <> 'object'
       or coalesce(a ->> 'path', '') !~ ('^' || new.company_id || '/chat/' || new.channel_id || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(' || private.chat_file_endings() || ')$')
  ) then
    raise exception 'Files must be uploaded to this channel first' using errcode = '22023';
  end if;
  if new.reply_to is not null and not exists (select 1 from public.chat_messages r where r.id = new.reply_to and r.channel_id = new.channel_id) then
    raise exception 'You can only reply to a message in the same channel' using errcode = '22023';
  end if;
  return new;
end $$;

/**
 * As in 20261129103500_chat_scheduled_and_reminders.sql, with the checks above: what's due and can
 * go now (Team chat on, and direct messages for a conversation, and not waiting to be tried again)
 * is sent as its author. message_id is the message this run sent; null when it sent nothing (sent
 * already, or dropped: then problem says why, unless its author has left the team).
 */
create or replace function public.chat_send_due(p_limit integer default 50)
returns table (scheduled_id uuid, company_id uuid, channel_id uuid, author_id uuid, message_id uuid, problem text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r public.chat_scheduled_messages;
  v_claims text;
  v_sub text;
  v_problem text;
  v_member boolean;
  v_where text;
  v_sent boolean;
  v_again boolean;
begin
  for r in
    select s.* from public.chat_scheduled_messages s
    join public.chat_channels c on c.id = s.channel_id
    where s.send_at <= now() and (s.retry_at is null or s.retry_at <= now())
      and private.chat_enabled(s.company_id) and (c.kind <> 'direct' or private.chat_direct_on(s.company_id))
    order by s.send_at, s.created_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of s skip locked
  loop
    v_problem := null;
    v_sent := false;
    v_again := false;
    v_where := coalesce(private.chat_where(r.channel_id), 'Team chat');
    v_member := exists (select 1 from public.memberships m where m.company_id = r.company_id and m.user_id = r.author_id and m.active and m.role <> 'subcontractor');
    if exists (select 1 from public.chat_messages m where m.id = r.id) then
      -- Sent already, as itself: it's done. Anything else of that id isn't this message.
      if not exists (select 1 from public.chat_messages m where m.id = r.id and m.channel_id = r.channel_id and m.author_id = r.author_id and m.company_id = r.company_id) then
        v_problem := 'It couldn''t be sent: another message has its id.';
      end if;
    elsif not v_member then
      v_problem := 'Not on the team';
    elsif not (private.chat_rights(r.channel_id, r.author_id)).can_post then
      v_problem := 'You can''t post in ' || v_where || ' any more.';
    else
      -- As the author, for this insert only: mentions, @everyone and every rule are theirs.
      v_claims := current_setting('request.jwt.claims', true);
      v_sub := current_setting('request.jwt.claim.sub', true);
      perform set_config('request.jwt.claims', json_build_object('sub', r.author_id, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', r.author_id::text, true);
      begin
        insert into public.chat_messages (id, company_id, channel_id, author_id, body, attachments, job_id, reply_to)
        values (r.id, r.company_id, r.channel_id, r.author_id, r.body, r.attachments, r.job_id, r.reply_to);
        v_sent := true;
      exception
        -- What it is that can't be sent: a rule it breaks.
        when insufficient_privilege or check_violation or invalid_parameter_value or foreign_key_violation or unique_violation
          or not_null_violation or string_data_right_truncation then
          v_problem := 'It couldn''t be sent: ' || sqlerrm;
        -- Anything else (a lock, a deadlock, the server busy): again later, ten tries at most.
        when others then
          v_again := r.tries < 9;
          if not v_again then v_problem := 'It couldn''t be sent: ' || sqlerrm; end if;
      end;
      perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
      perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    end if;
    if v_again then
      update public.chat_scheduled_messages s
         set tries = s.tries + 1, retry_at = now() + make_interval(mins => least(60, power(2, least(r.tries, 6))::integer))
       where s.id = r.id;
      continue;
    end if;
    delete from public.chat_scheduled_messages s where s.id = r.id;
    if v_problem is not null and v_member then
      insert into public.notifications (company_id, user_id, kind, title, body, link)
      values (r.company_id, r.author_id, 'chat_scheduled', 'Your scheduled message to ' || v_where || ' wasn''t sent', v_problem, '/chat/' || r.channel_id);
    end if;
    scheduled_id := r.id;
    company_id := r.company_id;
    channel_id := r.channel_id;
    author_id := r.author_id;
    message_id := case when v_sent then r.id end;
    problem := case when v_member then v_problem end;
    return next;
  end loop;
end $$;

/**
 * Send now, as the person (their own rules, as for a message they send this moment): the scheduled
 * message is taken first, so the minute's run can't send it too, then sent by its own id and taken
 * off the list. The message's id; null when it was sent already. Refused while the minute's run is
 * sending it (it's there in a moment), and once it's gone.
 */
create function public.chat_send_scheduled_now(p_id uuid) returns uuid
language plpgsql set search_path = '' as $$
declare r public.chat_scheduled_messages;
begin
  select * into r from public.chat_scheduled_messages s where s.id = p_id and s.author_id = (select auth.uid()) for update skip locked;
  if not found then
    if exists (select 1 from public.chat_messages m where m.id = p_id and m.author_id = (select auth.uid())) then return null; end if;
    if exists (select 1 from public.chat_scheduled_messages s where s.id = p_id) then
      raise exception 'It''s being sent right now' using errcode = '55P03';
    end if;
    raise exception 'That message was sent or taken back already' using errcode = 'P0002';
  end if;
  insert into public.chat_messages (id, company_id, channel_id, author_id, body, attachments, job_id, reply_to)
  values (r.id, r.company_id, r.channel_id, r.author_id, r.body, r.attachments, r.job_id, r.reply_to);
  delete from public.chat_scheduled_messages s where s.id = r.id;
  return r.id;
end $$;
revoke execute on function public.chat_send_scheduled_now(uuid) from public, anon;
grant execute on function public.chat_send_scheduled_now(uuid) to authenticated;

/**
 * As in 20261129103500_chat_scheduled_and_reminders.sql, except that a reminder waits while Team
 * chat (or, for a conversation, direct messages) is off, rather than being done untold.
 */
create or replace function public.chat_send_due_reminders(p_limit integer default 100)
returns table (reminder_id uuid, company_id uuid, user_id uuid, told boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r record;
  v_told boolean;
  v_name text;
  v_text text;
begin
  for r in
    select rm.id, rm.company_id, rm.channel_id, rm.message_id, rm.user_id, m.author_id, m.body, m.attachments, m.deleted_at
    from public.chat_reminders rm
    join public.chat_messages m on m.id = rm.message_id
    join public.chat_channels c on c.id = rm.channel_id
    where rm.remind_at <= now()
      and private.chat_enabled(rm.company_id) and (c.kind <> 'direct' or private.chat_direct_on(rm.company_id))
    order by rm.remind_at
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    for update of rm skip locked
  loop
    v_told := r.deleted_at is null
      and exists (select 1 from public.memberships mb where mb.company_id = r.company_id and mb.user_id = r.user_id and mb.active)
      and (private.chat_rights(r.channel_id, r.user_id)).can_see;
    if v_told then
      v_name := (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.user_id = r.author_id);
      v_text := nullif(left(regexp_replace(private.chat_plain(r.company_id, r.body), '\s+', ' ', 'g'), 140), '');
      insert into public.notifications (company_id, user_id, kind, title, body, link)
      values (
        r.company_id, r.user_id, 'chat_reminder',
        case
          when r.author_id = r.user_id then 'Reminder: your message in ' || private.chat_where(r.channel_id)
          when v_name is null then 'Reminder: a message in ' || private.chat_where(r.channel_id)
          else 'Reminder: ' || v_name || '''s message in ' || private.chat_where(r.channel_id)
        end,
        coalesce(v_text, case when jsonb_array_length(r.attachments) > 0 then 'A photo or a file' else 'A linked job' end),
        '/chat/' || r.channel_id || '?message=' || r.message_id
      );
    end if;
    delete from public.chat_reminders rm where rm.id = r.id;
    reminder_id := r.id;
    company_id := r.company_id;
    user_id := r.user_id;
    told := v_told;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Status, only while Team chat is on
-- ---------------------------------------------------------------------------------------------

drop policy chat_statuses_read on public.chat_statuses;
create policy chat_statuses_read on public.chat_statuses for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}') and private.chat_enabled(company_id));
drop policy chat_statuses_insert on public.chat_statuses;
create policy chat_statuses_insert on public.chat_statuses for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}') and private.chat_enabled(company_id));
drop policy chat_statuses_update on public.chat_statuses;
create policy chat_statuses_update on public.chat_statuses for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.has_role(company_id, '{owner,admin,office,estimator,crew_lead,field_crew}') and private.chat_enabled(company_id));

create or replace function public.chat_statuses(p_company uuid)
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
    and private.chat_enabled(p_company)
    and private.has_role(p_company, '{owner,admin,office,estimator,crew_lead,field_crew}')
    and coalesce(s.kind, c.kind) is not null
$$;

select private.fold_member_checks('public.chat_statuses');
