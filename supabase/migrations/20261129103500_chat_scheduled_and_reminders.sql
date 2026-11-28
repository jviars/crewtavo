-- Team chat messages sent later, and reminders about a message.
--
-- A scheduled message waits here, seen only by its author, until its time. The minute scheduler
-- (apps/api/src/tasks.ts, chat_later) sends it then with public.chat_send_due(), as its author: the
-- author must still be on the team and able to post in the channel (private.chat_rights), and the
-- message is read exactly as if they'd sent it then. chat_message_guard and chat_read_mentions trust
-- a request with nobody signed in as the server's, which would let @everyone through, so the send
-- sets the request's sign-in to the author for its insert and puts it back after. A message that
-- can't be sent is dropped, and the author is told why on the bell (kind chat_scheduled).
--
-- A reminder is one person's, about one message they can see. At its time
-- public.chat_send_due_reminders() puts it on their bell, and by push, email or text as their Team
-- chat choices say (kind chat_reminder: packages/core/src/notifications.ts), then it's done.

-- ---------------------------------------------------------------------------------------------
-- Scheduled messages
-- ---------------------------------------------------------------------------------------------

create table public.chat_scheduled_messages (
  -- Also the message's id once it's sent: sent twice, it's there once.
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  channel_id uuid not null,
  author_id uuid not null references auth.users (id) on delete cascade,
  body text not null default '' check (length(body) <= 4000),
  attachments jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 6),
  job_id uuid,
  reply_to uuid,
  send_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade,
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id),
  foreign key (company_id, reply_to) references public.chat_messages (company_id, id) on delete set null (reply_to)
);
create index chat_scheduled_due_idx on public.chat_scheduled_messages (send_at);
create index chat_scheduled_author_idx on public.chat_scheduled_messages (author_id, channel_id);

alter table public.chat_scheduled_messages enable row level security;
create policy chat_scheduled_read on public.chat_scheduled_messages for select to authenticated
  using (author_id = (select auth.uid()) and private.is_member(company_id));
create policy chat_scheduled_insert on public.chat_scheduled_messages for insert to authenticated
  with check (author_id = (select auth.uid()) and private.chat_can(channel_id, 'post'));
create policy chat_scheduled_update on public.chat_scheduled_messages for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()) and private.chat_can(channel_id, 'post'));
create policy chat_scheduled_delete on public.chat_scheduled_messages for delete to authenticated
  using (author_id = (select auth.uid()));

-- What a scheduled message may hold: what a message may (chat_message_guard), sent in the next year.
create function private.chat_scheduled_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.id, new.company_id, new.channel_id, new.author_id, new.created_at) is distinct from (old.id, old.company_id, old.channel_id, old.author_id, old.created_at) then
    raise exception 'A scheduled message can''t be moved or reassigned' using errcode = '42501';
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then new.created_at := now(); end if;
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
create trigger chat_scheduled_guard before insert or update on public.chat_scheduled_messages
  for each row execute function private.chat_scheduled_guard();

-- "#general", or an announcement channel's title.
create function private.chat_where(p_channel uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when c.kind = 'announcement' then c.name else '#' || c.name end from public.chat_channels c where c.id = p_channel
$$;

/**
 * Sends the scheduled messages whose time has come, oldest first, p_limit at a time (taken so two
 * runs never send the same one), each as its author. Returns each one: the message sent
 * (message_id), or why it wasn't (problem: its author was told on the bell; null when they're no
 * longer on the team, who can't see the bell there). The server's alone.
 */
create function public.chat_send_due(p_limit integer default 50)
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
begin
  for r in
    select * from public.chat_scheduled_messages s
    where s.send_at <= now()
    order by s.send_at, s.created_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update skip locked
  loop
    v_problem := null;
    v_where := coalesce(private.chat_where(r.channel_id), 'Team chat');
    v_member := exists (select 1 from public.memberships m where m.company_id = r.company_id and m.user_id = r.author_id and m.active and m.role <> 'subcontractor');
    if exists (select 1 from public.chat_messages m where m.id = r.id) then
      -- Sent already (Send now, then this run): it's done.
      null;
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
      exception when others then
        v_problem := 'It couldn''t be sent: ' || sqlerrm;
      end;
      perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
      perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
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
    message_id := case when v_problem is null then r.id end;
    problem := case when v_member then v_problem end;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Reminders
-- ---------------------------------------------------------------------------------------------

create table public.chat_reminders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  channel_id uuid not null,
  message_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  remind_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- One reminder a message for each person: set again, it's moved.
  unique (user_id, message_id),
  foreign key (company_id, message_id) references public.chat_messages (company_id, id) on delete cascade,
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade
);
create index chat_reminders_due_idx on public.chat_reminders (remind_at);

alter table public.chat_reminders enable row level security;
create policy chat_reminders_read on public.chat_reminders for select to authenticated
  using (user_id = (select auth.uid()) and private.chat_can(channel_id, 'see'));
create policy chat_reminders_insert on public.chat_reminders for insert to authenticated
  with check (user_id = (select auth.uid()) and private.chat_can(channel_id, 'see'));
create policy chat_reminders_update on public.chat_reminders for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.chat_can(channel_id, 'see'));
create policy chat_reminders_delete on public.chat_reminders for delete to authenticated
  using (user_id = (select auth.uid()));

-- A reminder goes with its message's channel, on a message that's still there, at a time in the next year.
create function private.chat_reminder_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.id, new.user_id, new.message_id) is distinct from (old.id, old.user_id, old.message_id) then
    raise exception 'A reminder can''t be moved to another message' using errcode = '42501';
  end if;
  select m.channel_id, m.company_id into new.channel_id, new.company_id
  from public.chat_messages m where m.id = new.message_id and m.deleted_at is null;
  if new.channel_id is null then raise exception 'That message is gone' using errcode = '22023'; end if;
  if new.remind_at <= now() or new.remind_at > now() + interval '366 days' then
    raise exception 'Pick a time in the next year for the reminder' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger chat_reminder_fill before insert or update on public.chat_reminders
  for each row execute function private.chat_reminder_fill();

/**
 * Reminders whose time has come, p_limit at a time: on each person's bell (and by push, email or
 * text as their Team chat choices say), "Reminder: Dana Hale's message in #general" with its words
 * and a link to it, then done. One about a message that's gone, or a channel they can't see any
 * more, is just done. Returns whose went, for the live connection. The server's alone.
 */
create function public.chat_send_due_reminders(p_limit integer default 100)
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
    where rm.remind_at <= now()
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

revoke all on function private.chat_scheduled_guard(), private.chat_reminder_fill(), private.chat_where(uuid) from public;
grant execute on function private.chat_where(uuid) to service_role;
revoke execute on function public.chat_send_due(integer), public.chat_send_due_reminders(integer) from public, anon, authenticated;
grant execute on function public.chat_send_due(integer), public.chat_send_due_reminders(integer) to service_role;

select private.fold_member_checks('public.chat_scheduled_messages');
