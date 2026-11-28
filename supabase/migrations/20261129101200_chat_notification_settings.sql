-- How each person hears about each channel and conversation (chat_channel_prefs), and Team chat's
-- quiet hours and pause, per person (chat_quiet_hours).
--
--   all        every new message from someone else (in a channel, those in its main list; a thread's
--              replies still reach its followers)
--   mentions   mentions, replies to you and replies in threads you follow: what chat did before
--   nothing    no notifications at all. The channel shows dimmed and its plain unread doesn't light up
--              Team chat (the web app); a mention still shows its number in the list.
-- A channel or announcement channel is "mentions" until the person picks; a direct conversation "all".
--
-- Quiet hours: a start, an end and the days, in the person's time zone (the business's unless they
-- picked another), and a pause until a given time. During either, Team chat notifications stay on the
-- bell: no push, email or text, and they aren't sent later (apps/api/src/services/delivery.ts).

create table public.chat_channel_prefs (
  company_id uuid not null,
  channel_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  notify text not null check (notify in ('all', 'mentions', 'nothing')),
  updated_at timestamptz not null default now(),
  primary key (channel_id, user_id),
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade
);
create index chat_channel_prefs_all_idx on public.chat_channel_prefs (channel_id) where notify = 'all';

-- Each person's own, for channels they can see. Set with chat_set_notify().
alter table public.chat_channel_prefs enable row level security;
create policy chat_channel_prefs_read on public.chat_channel_prefs for select to authenticated
  using (user_id = (select auth.uid()) and private.chat_can(channel_id, 'see'));

create table public.chat_quiet_hours (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  quiet_on boolean not null default false,
  starts time not null default '21:00',
  ends time not null default '07:00',
  -- 0 is Sunday. The quiet time that starts on each of these days, running past midnight when it ends earlier.
  days smallint[] not null default '{0,1,2,3,4,5,6}' check (days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  -- A zone name, like America/Chicago. Empty: the business's.
  time_zone text,
  paused_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

-- A zone the time zone database knows, as for a company (20261018000400_timezone_checks.sql).
create function private.chat_quiet_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.time_zone is not null
     and not exists (select 1 from pg_catalog.pg_timezone_names where name = new.time_zone and name not in ('Factory', 'posixrules')) then
    raise exception 'Unknown time zone "%". Pick one from the list, like America/New_York', new.time_zone using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger chat_quiet_check before insert or update on public.chat_quiet_hours
  for each row execute function private.chat_quiet_check();

-- Each person's own, while they're on the team.
alter table public.chat_quiet_hours enable row level security;
create policy chat_quiet_hours_read on public.chat_quiet_hours for select to authenticated
  using (user_id = (select auth.uid()) and private.is_member(company_id));
create policy chat_quiet_hours_insert on public.chat_quiet_hours for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_member(company_id));
create policy chat_quiet_hours_update on public.chat_quiet_hours for update to authenticated
  using (user_id = (select auth.uid()) and private.is_member(company_id))
  with check (user_id = (select auth.uid()) and private.is_member(company_id));

-- How I hear about a channel or conversation: 'all', 'mentions' or 'nothing'; null goes back to its default.
create function public.chat_set_notify(p_channel uuid, p_notify text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  if not private.chat_can(p_channel, 'see') then
    raise exception 'You can''t see that channel' using errcode = '42501';
  end if;
  if p_notify is not null and p_notify not in ('all', 'mentions', 'nothing') then
    raise exception 'Choose all new messages, mentions and replies, or nothing' using errcode = '22023';
  end if;
  select company_id into v_company from public.chat_channels where id = p_channel;
  if p_notify is null then
    delete from public.chat_channel_prefs where channel_id = p_channel and user_id = (select auth.uid());
  else
    insert into public.chat_channel_prefs (company_id, channel_id, user_id, notify)
    values (v_company, p_channel, (select auth.uid()), p_notify)
    on conflict (channel_id, user_id) do update set notify = excluded.notify, updated_at = now();
  end if;
  return p_notify;
end $$;
revoke execute on function public.chat_set_notify(uuid, text) from public, anon;
grant execute on function public.chat_set_notify(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- What's new, and notifications
-- ---------------------------------------------------------------------------------------------

-- As 20261129101100_chat_threads.sql, with how I hear about each (notify), defaults included. A direct
-- conversation set to nothing counts only real mentions, as a channel does.
drop function public.chat_overview(uuid);
create function public.chat_overview(p_company uuid)
returns table (
  id uuid, kind text, name text, category text, topic text, crew_id uuid, "position" integer, archived boolean,
  can_post boolean, can_manage boolean, unread integer, mentions integer, last_message_at timestamptz,
  created_at timestamptz, people uuid[], closed boolean, notify text
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
    (case when v.kind = 'direct' and cp.notify is distinct from 'nothing' then coalesce(n.unread, 0) else coalesce(n.mentions, 0) end)::integer,
    n.last_at,
    v.created_at,
    case when v.kind = 'direct' then coalesce((
      select array_agg(d.user_id order by d.joined_at, d.user_id) from public.chat_direct_members d
      where d.channel_id = v.id and d.user_id <> me.user_id and d.left_at is null
    ), '{}') end,
    coalesce(dm.closed_at is not null and (n.last_at is null or n.last_at <= dm.closed_at), false),
    coalesce(cp.notify, case when v.kind = 'direct' then 'all' else 'mentions' end)
  from visible v
  cross join me
  left join public.chat_reads rd on rd.channel_id = v.id and rd.user_id = me.user_id
  left join public.chat_direct_members dm on dm.channel_id = v.id and dm.user_id = me.user_id
  left join public.chat_channel_prefs cp on cp.channel_id = v.id and cp.user_id = me.user_id
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
revoke execute on function public.chat_overview(uuid) from public, anon;
grant execute on function public.chat_overview(uuid) to authenticated;

-- As 20261129101100_chat_threads.sql, by each person's choice for the channel: 'nothing' tells them
-- nothing, 'all' tells them of every new message, 'mentions' what it did before. A direct conversation
-- is 'all' until they pick.
create or replace function private.chat_notify_mentions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_where text;
  v_kind text;
  v_text text;
  v_others integer;
  v_replied uuid := (select r.author_id from public.chat_messages r where r.id = new.reply_to);
  v_in_channel boolean := new.thread_root is null or new.also_in_channel;
  v_link text := case when new.thread_root is not null and not new.also_in_channel
    then '/chat/' || new.channel_id || '?thread=' || new.thread_root || '&message=' || new.id
    else '/chat/' || new.channel_id || '?message=' || new.id end;
begin
  select c.kind, case when c.kind = 'announcement' then c.name else '#' || c.name end into v_kind, v_where from public.chat_channels c where c.id = new.channel_id;
  if v_kind is distinct from 'direct' and new.thread_root is null
     and not (new.mention_all or cardinality(new.mention_users) > 0 or cardinality(new.mention_roles) > 0 or v_replied is not null)
     and not exists (select 1 from public.chat_channel_prefs p where p.channel_id = new.channel_id and p.notify = 'all') then
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
    left join public.chat_channel_prefs cp on cp.channel_id = new.channel_id and cp.user_id = d.user_id
    left join public.chat_thread_follows f on f.root_id = new.thread_root and f.user_id = d.user_id and f.following
    where d.channel_id = new.channel_id and d.left_at is null and d.user_id is distinct from new.author_id
      and coalesce(cp.notify, 'all') <> 'nothing'
      and (coalesce(cp.notify, 'all') = 'all' or d.user_id = any (new.mention_users) or d.user_id = v_replied or f.user_id is not null)
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
  left join public.chat_channel_prefs cp on cp.channel_id = new.channel_id and cp.user_id = m.user_id
  left join public.chat_thread_follows f on f.root_id = new.thread_root and f.user_id = m.user_id and f.following
  where m.company_id = new.company_id and m.active and m.user_id is distinct from new.author_id
    and coalesce(cp.notify, 'mentions') <> 'nothing'
    and (new.mention_all or m.user_id = any (new.mention_users) or coalesce(m.role_id::text, m.role::text) = any (new.mention_roles)
         or m.user_id = v_replied or f.user_id is not null or (cp.notify = 'all' and v_in_channel))
    and (private.chat_rights(new.channel_id, m.user_id)).can_see;
  return null;
end $$;

select private.fold_member_checks('public.chat_channel_prefs');
select private.fold_member_checks('public.chat_quiet_hours');

notify pgrst, 'reload schema';
