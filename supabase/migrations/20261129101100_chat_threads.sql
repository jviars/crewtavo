-- Threads: replies kept under the message they answer, out of the channel's main list. A thread reply
-- is a message with a thread_root, a message in the same channel that is itself not a thread reply
-- and not deleted, so threads don't nest. One can also be sent to the channel (also_in_channel),
-- where it shows and counts like any message. The quote reply (reply_to) stays as it was.
--
-- Who follows a thread (chat_thread_follows): the root's author, everyone who replies, anyone
-- mentioned in a reply and, in a direct conversation, everyone in it. Followers hear of new replies
-- ("Dana Hale replied in a thread in #general"); a thread can be unfollowed and followed again. How
-- far each person has read each thread is kept there too, for the Threads view's "new replies".
--
-- A thread reply doesn't count as the channel's unread, unless it's also sent to the channel; a
-- mention in one still counts, in the threads' own numbers (chat_threads). Its notification opens the
-- thread, and reading the channel doesn't mark it read: reading the thread does.

alter table public.chat_messages
  add column thread_root uuid,
  add column also_in_channel boolean not null default false,
  add constraint chat_messages_thread_fkey foreign key (company_id, thread_root) references public.chat_messages (company_id, id) on delete cascade;
create index chat_messages_thread_idx on public.chat_messages (thread_root, created_at) where thread_root is not null;

-- As 20261129101000_chat_direct_messages.sql, and where a reply goes: a thread's root is a message in
-- the same channel, not itself in a thread, and not deleted; a reply can't move to another thread.
-- (chat_message_guard checks everything else about a message.)
create or replace function private.chat_message_place() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_root record;
begin
  if tg_op = 'UPDATE' then
    if (new.thread_root, new.also_in_channel) is distinct from (old.thread_root, old.also_in_channel) then
      raise exception 'A reply can''t be moved to another thread' using errcode = '42501';
    end if;
  elsif new.thread_root is not null then
    select r.channel_id, r.thread_root, r.deleted_at into v_root from public.chat_messages r where r.id = new.thread_root;
    if not found or v_root.channel_id <> new.channel_id then
      raise exception 'You can only reply in a thread to a message in this channel' using errcode = '22023';
    end if;
    if v_root.thread_root is not null then
      raise exception 'A reply in a thread can''t start a thread of its own' using errcode = '22023';
    end if;
    if v_root.deleted_at is not null then
      raise exception 'That message was deleted' using errcode = '22023';
    end if;
  else
    new.also_in_channel := false;
  end if;
  if exists (select 1 from public.chat_channels c where c.id = new.channel_id and c.kind = 'direct') then
    new.mention_roles := '{}';
    new.mention_all := false;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Who follows a thread, and how far they've read it
-- ---------------------------------------------------------------------------------------------

create table public.chat_thread_follows (
  company_id uuid not null,
  channel_id uuid not null,
  root_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  following boolean not null default true,
  -- Replies after this are new to them; none yet: every reply is.
  last_read_at timestamptz,
  primary key (root_id, user_id),
  foreign key (company_id, root_id) references public.chat_messages (company_id, id) on delete cascade,
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade
);
create index chat_thread_follows_user_idx on public.chat_thread_follows (user_id, company_id) where following;

-- Each person sees their own, in channels they can see. Changes go through the functions below.
alter table public.chat_thread_follows enable row level security;
create policy chat_thread_follows_read on public.chat_thread_follows for select to authenticated
  using (user_id = (select auth.uid()) and private.chat_can(channel_id, 'see'));

-- A reply: the root's author follows from the first one (every reply so far is new to them), whoever
-- replies follows and has read up to their own reply, anyone mentioned follows from this reply (again,
-- if they'd stopped), and in a direct conversation everyone in it follows unless they stopped. Named to
-- run before chat_notify_mentions, which tells the followers.
create function private.chat_follow_thread() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_root record;
begin
  select r.author_id, r.created_at into v_root from public.chat_messages r where r.id = new.thread_root;
  if v_root.author_id is not null and v_root.author_id is distinct from new.author_id then
    insert into public.chat_thread_follows (company_id, channel_id, root_id, user_id, following, last_read_at)
    values (new.company_id, new.channel_id, new.thread_root, v_root.author_id, true, v_root.created_at)
    on conflict (root_id, user_id) do nothing;
  end if;
  if new.author_id is not null then
    insert into public.chat_thread_follows (company_id, channel_id, root_id, user_id, following, last_read_at)
    values (new.company_id, new.channel_id, new.thread_root, new.author_id, true, new.created_at)
    on conflict (root_id, user_id) do update set following = true, last_read_at = greatest(public.chat_thread_follows.last_read_at, excluded.last_read_at);
  end if;
  insert into public.chat_thread_follows (company_id, channel_id, root_id, user_id, following, last_read_at)
  select new.company_id, new.channel_id, new.thread_root, u, true, new.created_at - interval '1 microsecond'
  from unnest(new.mention_users) as u
  where u is distinct from new.author_id and (private.chat_rights(new.channel_id, u)).can_see
  on conflict (root_id, user_id) do update set following = true;
  insert into public.chat_thread_follows (company_id, channel_id, root_id, user_id, following, last_read_at)
  select new.company_id, new.channel_id, new.thread_root, d.user_id, true, new.created_at - interval '1 microsecond'
  from public.chat_direct_members d
  where d.channel_id = new.channel_id and d.left_at is null and d.user_id is distinct from new.author_id
    and (private.chat_rights(new.channel_id, d.user_id)).can_see
  on conflict (root_id, user_id) do nothing;
  return null;
end $$;
create trigger chat_follow_thread after insert on public.chat_messages
  for each row when (new.thread_root is not null) execute function private.chat_follow_thread();
revoke execute on function private.chat_follow_thread() from public;

-- ---------------------------------------------------------------------------------------------
-- What's new, and notifications
-- ---------------------------------------------------------------------------------------------

-- As 20261129101000_chat_direct_messages.sql, except that a thread reply counts in its channel only
-- when it's also sent there (the threads' counts are chat_threads').
create or replace function public.chat_overview(p_company uuid)
returns table (
  id uuid, kind text, name text, category text, topic text, crew_id uuid, "position" integer, archived boolean,
  can_post boolean, can_manage boolean, unread integer, mentions integer, last_message_at timestamptz,
  created_at timestamptz, people uuid[], closed boolean
)
language sql stable security definer set search_path = '' as $$
  with me as (
    select m.user_id, m.created_at, coalesce(m.role_id::text, m.role::text) as role_key
    from public.memberships m where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active
  ),
  visible as (
    select c.*, r.can_post as may_post, r.can_manage as may_manage
    from public.chat_channels c
    cross join lateral private.chat_rights(c.id, (select auth.uid())) r
    where c.company_id = p_company and r.can_see
  )
  select v.id, v.kind, v.name, v.category, v.topic, v.crew_id, v.position, v.archived_at is not null, v.may_post, v.may_manage,
    coalesce(n.unread, 0)::integer,
    (case when v.kind = 'direct' then coalesce(n.unread, 0) else coalesce(n.mentions, 0) end)::integer,
    n.last_at,
    v.created_at,
    case when v.kind = 'direct' then coalesce((
      select array_agg(d.user_id order by d.joined_at, d.user_id) from public.chat_direct_members d
      where d.channel_id = v.id and d.user_id <> me.user_id and d.left_at is null
    ), '{}') end,
    coalesce(dm.closed_at is not null and (n.last_at is null or n.last_at <= dm.closed_at), false)
  from visible v
  cross join me
  left join public.chat_reads rd on rd.channel_id = v.id and rd.user_id = me.user_id
  left join public.chat_direct_members dm on dm.channel_id = v.id and dm.user_id = me.user_id
  left join lateral (
    select
      count(*) filter (where msg.created_at > coalesce(rd.last_read_at, me.created_at) and msg.author_id is distinct from me.user_id) as unread,
      count(*) filter (where msg.created_at > coalesce(rd.last_read_at, me.created_at) and msg.author_id is distinct from me.user_id
                        and (msg.mention_all or me.user_id = any (msg.mention_users) or me.role_key = any (msg.mention_roles) or replied.author_id = me.user_id)) as mentions,
      max(msg.created_at) as last_at
    from public.chat_messages msg
    left join public.chat_messages replied on replied.id = msg.reply_to
    where msg.channel_id = v.id and msg.deleted_at is null and (msg.thread_root is null or msg.also_in_channel)
  ) n on true
  order by v.position, v.name
$$;

-- As 20261129101000_chat_direct_messages.sql, and a thread reply tells the thread's followers ("Dana
-- Hale replied in a thread in #general"); its notification opens the thread, unless it was also sent
-- to the channel.
create or replace function private.chat_notify_mentions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_where text;
  v_kind text;
  v_text text;
  v_others integer;
  v_replied uuid := (select r.author_id from public.chat_messages r where r.id = new.reply_to);
  v_link text := case when new.thread_root is not null and not new.also_in_channel
    then '/chat/' || new.channel_id || '?thread=' || new.thread_root || '&message=' || new.id
    else '/chat/' || new.channel_id || '?message=' || new.id end;
begin
  select c.kind, case when c.kind = 'announcement' then c.name else '#' || c.name end into v_kind, v_where from public.chat_channels c where c.id = new.channel_id;
  if v_kind is distinct from 'direct' and new.thread_root is null
     and not (new.mention_all or cardinality(new.mention_users) > 0 or cardinality(new.mention_roles) > 0 or v_replied is not null) then
    return null;
  end if;
  v_name := coalesce((select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.user_id = new.author_id), 'Crewtavo');
  v_text := nullif(left(regexp_replace(private.chat_plain(new.company_id, new.body), '\s+', ' ', 'g'), 140), '');
  if v_kind = 'direct' then
    select count(*) into v_others from public.chat_direct_members d
    where d.channel_id = new.channel_id and d.left_at is null and d.user_id is distinct from new.author_id;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select new.company_id, d.user_id, 'chat',
      case when v_others <= 1 then v_name || ' messaged you'
        when v_others = 2 then v_name || ' messaged you and 1 other'
        else format('%s messaged you and %s others', v_name, v_others - 1) end,
      coalesce(v_text, 'Sent a photo'),
      v_link
    from public.chat_direct_members d
    where d.channel_id = new.channel_id and d.left_at is null and d.user_id is distinct from new.author_id
      and (private.chat_rights(new.channel_id, d.user_id)).can_see;
    return null;
  end if;
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, m.user_id, 'chat',
    case when m.user_id = v_replied then v_name || ' replied to you in ' || v_where
      when m.user_id = any (new.mention_users) or coalesce(m.role_id::text, m.role::text) = any (new.mention_roles)
      then v_name || ' mentioned you in ' || v_where
      when f.user_id is not null then v_name || ' replied in a thread in ' || v_where
      else v_name || ' posted in ' || v_where end,
    coalesce(v_text, 'Sent a photo'),
    v_link
  from public.memberships m
  left join public.chat_thread_follows f on f.root_id = new.thread_root and f.user_id = m.user_id and f.following
  where m.company_id = new.company_id and m.active and m.user_id is distinct from new.author_id
    and (new.mention_all or m.user_id = any (new.mention_users) or coalesce(m.role_id::text, m.role::text) = any (new.mention_roles)
         or m.user_id = v_replied or f.user_id is not null)
    and (private.chat_rights(new.channel_id, m.user_id)).can_see;
  return null;
end $$;

-- As 20261019001600_team_chat.sql, except that a thread's notifications stay until the thread is read.
create or replace function public.chat_mark_read(p_channel uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  if not private.chat_can(p_channel, 'see') then
    raise exception 'You can''t see that channel' using errcode = '42501';
  end if;
  select company_id into v_company from public.chat_channels where id = p_channel;
  insert into public.chat_reads (company_id, channel_id, user_id, last_read_at)
  values (v_company, p_channel, (select auth.uid()), now())
  on conflict (channel_id, user_id) do update set last_read_at = greatest(public.chat_reads.last_read_at, excluded.last_read_at);
  update public.notifications set read_at = now()
  where user_id = (select auth.uid()) and company_id = v_company and kind = 'chat' and read_at is null
    and link like '/chat/' || p_channel || '%' and link not like '/chat/' || p_channel || '?thread=%';
end $$;

-- ---------------------------------------------------------------------------------------------
-- What the app calls
-- ---------------------------------------------------------------------------------------------

-- For the messages on a page: how many replies each has, the last one's time, and who replied (the
-- latest first, up to five).
create function public.chat_thread_summaries(p_roots uuid[])
returns table (root_id uuid, replies integer, last_reply_at timestamptz, people uuid[])
language sql stable security definer set search_path = '' as $$
  with roots as (
    select m.id from public.chat_messages m
    where m.id = any (p_roots) and m.thread_root is null and private.chat_can(m.channel_id, 'see')
  )
  select r.thread_root, count(*)::integer, max(r.created_at),
    (select array_agg(x.author_id order by x.last desc) from (
      select r2.author_id, max(r2.created_at) as last from public.chat_messages r2
      where r2.thread_root = r.thread_root and r2.deleted_at is null and r2.author_id is not null
      group by r2.author_id order by 2 desc limit 5
    ) x)
  from public.chat_messages r
  where r.thread_root in (select id from roots) and r.deleted_at is null
  group by r.thread_root
$$;

-- The threads I follow, with new replies first: how many replies, the last one's time, how many are
-- new to me and how many of those mention me (in a direct conversation, every new one does). A
-- reply also sent to the channel counts as a mention there, not here.
create function public.chat_threads(p_company uuid)
returns table (root_id uuid, channel_id uuid, replies integer, last_reply_at timestamptz, unread integer, mentions integer)
language sql stable security definer set search_path = '' as $$
  with me as (
    select m.user_id, coalesce(m.role_id::text, m.role::text) as role_key
    from public.memberships m where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active
  )
  select f.root_id, f.channel_id, n.replies::integer, n.last_at, n.unread::integer, n.mentions::integer
  from public.chat_thread_follows f
  cross join me
  join public.chat_channels ch on ch.id = f.channel_id
  cross join lateral (
    select count(*) as replies, max(r.created_at) as last_at,
      count(*) filter (where r.created_at > coalesce(f.last_read_at, '-infinity') and r.author_id is distinct from me.user_id) as unread,
      count(*) filter (where r.created_at > coalesce(f.last_read_at, '-infinity') and r.author_id is distinct from me.user_id and not r.also_in_channel
                        and (ch.kind = 'direct' or r.mention_all or me.user_id = any (r.mention_users) or me.role_key = any (r.mention_roles) or q.author_id = me.user_id)) as mentions
    from public.chat_messages r
    left join public.chat_messages q on q.id = r.reply_to
    where r.thread_root = f.root_id and r.deleted_at is null
  ) n
  where f.company_id = p_company and f.user_id = me.user_id and f.following and n.replies > 0
    and private.chat_can(f.channel_id, 'see')
  order by (n.unread > 0) desc, n.last_at desc
$$;

-- For the list and the Team chat badge: how many threads I follow have new replies, and the mentions in them.
create function public.chat_thread_counts(p_company uuid, out unread integer, out mentions integer)
language sql stable security definer set search_path = '' as $$
  select (count(*) filter (where t.unread > 0))::integer, coalesce(sum(t.mentions), 0)::integer from public.chat_threads(p_company) t
$$;

-- I've read this thread up to now: its notifications too. Reading one doesn't follow it, except for
-- the message's own author, who follows their thread from the start.
create function public.chat_thread_read(p_root uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_root record;
begin
  select m.company_id, m.channel_id, m.author_id into v_root from public.chat_messages m where m.id = p_root and m.thread_root is null;
  if not found or not private.chat_can(v_root.channel_id, 'see') then
    raise exception 'You can''t see that thread' using errcode = '42501';
  end if;
  insert into public.chat_thread_follows (company_id, channel_id, root_id, user_id, following, last_read_at)
  values (v_root.company_id, v_root.channel_id, p_root, (select auth.uid()), v_root.author_id is not distinct from (select auth.uid()), now())
  on conflict (root_id, user_id) do update set last_read_at = greatest(coalesce(public.chat_thread_follows.last_read_at, '-infinity'), excluded.last_read_at);
  update public.notifications set read_at = now()
  where user_id = (select auth.uid()) and company_id = v_root.company_id and kind = 'chat' and read_at is null
    and link like '/chat/' || v_root.channel_id || '?thread=' || p_root || '&%';
end $$;

-- Follow a thread, or stop following it (no more notifications of its replies, and out of Threads).
create function public.chat_follow(p_root uuid, p_following boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_root record;
begin
  select m.company_id, m.channel_id into v_root from public.chat_messages m where m.id = p_root and m.thread_root is null;
  if not found or not private.chat_can(v_root.channel_id, 'see') then
    raise exception 'You can''t see that thread' using errcode = '42501';
  end if;
  insert into public.chat_thread_follows (company_id, channel_id, root_id, user_id, following, last_read_at)
  values (v_root.company_id, v_root.channel_id, p_root, (select auth.uid()), p_following, now())
  on conflict (root_id, user_id) do update set following = excluded.following;
  return p_following;
end $$;

revoke execute on function public.chat_thread_summaries(uuid[]), public.chat_threads(uuid), public.chat_thread_counts(uuid),
  public.chat_thread_read(uuid), public.chat_follow(uuid, boolean) from public, anon;
grant execute on function public.chat_thread_summaries(uuid[]), public.chat_threads(uuid), public.chat_thread_counts(uuid),
  public.chat_thread_read(uuid), public.chat_follow(uuid, boolean) to authenticated;

select private.fold_member_checks('public.chat_thread_follows');

notify pgrst, 'reload schema';
