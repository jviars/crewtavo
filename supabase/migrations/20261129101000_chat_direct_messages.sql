-- Direct messages: private conversations between people on the team, one to one or a small group
-- (you and 1 to 8 others). A conversation is a channel of its own kind, 'direct', whose people are
-- in chat_direct_members. Messaging the same people again always opens the same conversation
-- (chat_channels.direct_key, their ids in order).
--
-- A direct conversation is only its people's. Roles have no rules in one and can't be given any;
-- owners and admins don't see into other people's (private.chat_rights, the chat_channels policies),
-- and it isn't in Chat settings. Only active staff can be in one: never a sub. Someone who leaves the
-- company keeps nothing: the history stays for the others, and they can't read or post any more.
-- Every message in one is for everyone else in it, so it notifies them and counts as a mention.
--
-- Owners and admins can turn direct messages off for the business (companies.settings.team_chat.
-- direct_messages; missing counts as on). Off, nobody can read or post in any direct conversation,
-- owners included, so they leave every list, live update and notification. Nothing is deleted:
-- turning it back on brings them back.

-- ---------------------------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------------------------

create function private.chat_direct_on(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.settings -> 'team_chat' -> 'direct_messages') is distinct from 'false'::jsonb from public.companies c where c.id = p_company), true)
$$;

create function public.chat_set_direct_messages(p_company uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_company, '{owner,admin}') then
    raise exception 'Only owners and admins can turn direct messages on or off' using errcode = '42501';
  end if;
  update public.companies
  set settings = jsonb_set(coalesce(settings, '{}'), '{team_chat}', coalesce(settings -> 'team_chat', '{}') || jsonb_build_object('direct_messages', p_on))
  where id = p_company;
  return p_on;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Conversations and their people
-- ---------------------------------------------------------------------------------------------

alter table public.chat_channels drop constraint chat_channels_kind_check;
alter table public.chat_channels add constraint chat_channels_kind_check check (kind in ('text', 'announcement', 'direct'));
-- A conversation's name is never shown (its people's are), so the channel-name rules don't apply.
alter table public.chat_channels drop constraint chat_channels_check;
alter table public.chat_channels add constraint chat_channels_check check (kind in ('announcement', 'direct') or name ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
drop index public.chat_channels_name_idx;
create unique index chat_channels_name_idx on public.chat_channels (company_id, lower(name)) where kind <> 'direct';

-- Its people's ids in order, comma-separated. Cleared when someone leaves a group: it's no longer
-- the conversation for that set of people, so messaging them all again starts a new one.
alter table public.chat_channels add column direct_key text;
alter table public.chat_channels add constraint chat_channels_direct_key_check check (direct_key is null or kind = 'direct');
create unique index chat_channels_direct_idx on public.chat_channels (company_id, direct_key) where direct_key is not null;

create table public.chat_direct_members (
  company_id uuid not null,
  channel_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  -- Left a group conversation: it's gone from their list for good.
  left_at timestamptz,
  -- Closed: out of their list until a new message comes.
  closed_at timestamptz,
  primary key (channel_id, user_id),
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade
);
create index chat_direct_members_user_idx on public.chat_direct_members (user_id, company_id);

-- Its people see who's in it. Changes go through the functions below.
alter table public.chat_direct_members enable row level security;
create policy chat_direct_members_read on public.chat_direct_members for select to authenticated
  using (private.chat_can(channel_id, 'see'));

-- ---------------------------------------------------------------------------------------------
-- Who can see, post and manage
-- ---------------------------------------------------------------------------------------------

-- As 20261025002002_sub_sign_ins.sql, with direct conversations: only their people, while they're
-- on the team and direct messages are on. Posting needs someone else in it who can still read it.
-- Nobody manages one: nobody pins in it or removes another person's message.
create or replace function private.chat_rights(p_channel uuid, p_user uuid, out can_see boolean, out can_post boolean, out can_manage boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  ch record;
  m record;
  rule record;
  own_only boolean;
begin
  can_see := false;
  can_post := false;
  can_manage := false;
  select c.company_id, c.crew_id, c.archived_at, c.kind into ch from public.chat_channels c where c.id = p_channel;
  if not found or not private.chat_enabled(ch.company_id) then return; end if;
  select mb.role, mb.role_id into m from public.memberships mb where mb.company_id = ch.company_id and mb.user_id = p_user and mb.active;
  if not found or m.role = 'subcontractor' then return; end if;
  if ch.kind = 'direct' then
    if not private.chat_direct_on(ch.company_id)
       or not exists (select 1 from public.chat_direct_members d where d.channel_id = p_channel and d.user_id = p_user and d.left_at is null) then
      return;
    end if;
    can_see := true;
    can_post := ch.archived_at is null and exists (
      select 1 from public.chat_direct_members d
      join public.memberships o on o.company_id = ch.company_id and o.user_id = d.user_id and o.active and o.role <> 'subcontractor'
      where d.channel_id = p_channel and d.user_id <> p_user and d.left_at is null
    );
    return;
  end if;
  if m.role = 'owner' then
    can_see := true;
    can_manage := true;
    can_post := ch.archived_at is null;
    return;
  end if;
  -- The custom role's own rule, else its access level's.
  select r.can_see, r.can_post, r.can_manage into rule from public.chat_role_rules r
  where r.channel_id = p_channel and ((m.role_id is not null and r.role_id = m.role_id) or r.role = m.role)
  order by (r.role_id is not null) desc
  limit 1;
  if not found or not rule.can_see then return; end if;
  if ch.crew_id is not null then
    select s.own_crew_only into own_only from public.chat_role_settings s
    where s.company_id = ch.company_id and ((m.role_id is not null and s.role_id = m.role_id) or s.role = m.role)
    order by (s.role_id is not null) desc
    limit 1;
    if coalesce(own_only, false)
       and not exists (select 1 from public.crews c where c.id = ch.crew_id and c.lead_user_id = p_user)
       and not exists (select 1 from public.crew_members cm where cm.crew_id = ch.crew_id and cm.user_id = p_user) then
      return;
    end if;
  end if;
  can_manage := rule.can_manage;
  if ch.archived_at is null then
    can_see := true;
    can_post := rule.can_post;
  else
    -- An archived channel is read-only, and only its managers still see it (to bring it back).
    can_see := rule.can_manage;
  end if;
end $$;

grant execute on function private.chat_direct_on(uuid) to authenticated, service_role;

-- As 20261019001600_team_chat.sql, except that owners and admins see, change and remove every
-- channel but direct conversations, which only their people see (and nobody changes from here).
drop policy chat_channels_read on public.chat_channels;
create policy chat_channels_read on public.chat_channels for select to authenticated
  using (private.chat_can(id, 'see') or (kind <> 'direct' and private.chat_admin(company_id) and private.chat_enabled(company_id)));
drop policy chat_channels_insert on public.chat_channels;
create policy chat_channels_insert on public.chat_channels for insert to authenticated
  with check (kind <> 'direct' and private.chat_admin(company_id));
drop policy chat_channels_update on public.chat_channels;
create policy chat_channels_update on public.chat_channels for update to authenticated
  using (kind <> 'direct' and (private.chat_admin(company_id) or private.chat_can(id, 'manage')))
  with check (kind <> 'direct' and (private.chat_admin(company_id) or private.chat_can(id, 'manage')));
drop policy chat_channels_delete on public.chat_channels;
create policy chat_channels_delete on public.chat_channels for delete to authenticated
  using (kind <> 'direct' and private.chat_admin(company_id));

-- Roles have no rules in a direct conversation: Chat settings never saves one there.
create function private.chat_rules_not_direct() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.chat_channels c where c.id = new.channel_id and c.kind = 'direct') then return null; end if;
  return new;
end $$;
create trigger chat_rules_not_direct before insert or update on public.chat_role_rules
  for each row execute function private.chat_rules_not_direct();

-- A mention in a direct conversation is of someone in it: no roles and no @everyone. After
-- chat_message_guard, which reads mentions out of the text (triggers go in name order).
create function private.chat_message_place() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.chat_channels c where c.id = new.channel_id and c.kind = 'direct') then
    new.mention_roles := '{}';
    new.mention_all := false;
  end if;
  return new;
end $$;
create trigger chat_message_place before insert or update on public.chat_messages
  for each row execute function private.chat_message_place();

revoke execute on function private.chat_rules_not_direct(), private.chat_message_place() from public;

-- ---------------------------------------------------------------------------------------------
-- What's new, and notifications
-- ---------------------------------------------------------------------------------------------

-- As 20261124100500_chat_replies_count_as_mentions.sql, with direct conversations: the other people
-- in each (people, in the order they joined), whether it's closed (until a new message), and when it
-- started (one with no messages yet sorts by that). Every new message in one counts as a mention.
drop function public.chat_overview(uuid);
create function public.chat_overview(p_company uuid)
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
    where msg.channel_id = v.id and msg.deleted_at is null
  ) n on true
  order by v.position, v.name
$$;
revoke execute on function public.chat_overview(uuid) from public, anon;
grant execute on function public.chat_overview(uuid) to authenticated;

-- As 20261124100500_chat_replies_count_as_mentions.sql, and a message in a direct conversation tells
-- everyone else in it: "Dana Hale messaged you", or "Dana Hale messaged you and 2 others" in a group.
create or replace function private.chat_notify_mentions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_where text;
  v_kind text;
  v_text text;
  v_others integer;
  v_replied uuid := (select r.author_id from public.chat_messages r where r.id = new.reply_to);
begin
  select c.kind, case when c.kind = 'announcement' then c.name else '#' || c.name end into v_kind, v_where from public.chat_channels c where c.id = new.channel_id;
  if v_kind is distinct from 'direct'
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
      '/chat/' || new.channel_id || '?message=' || new.id
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
      else v_name || ' posted in ' || v_where end,
    coalesce(v_text, 'Sent a photo'),
    '/chat/' || new.channel_id || '?message=' || new.id
  from public.memberships m
  where m.company_id = new.company_id and m.active and m.user_id is distinct from new.author_id
    and (new.mention_all or m.user_id = any (new.mention_users) or coalesce(m.role_id::text, m.role::text) = any (new.mention_roles) or m.user_id = v_replied)
    and (private.chat_rights(new.channel_id, m.user_id)).can_see;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- What the app calls
-- ---------------------------------------------------------------------------------------------

-- Who I can message: everyone active on the team but me, with how their role looks in chat.
create function public.chat_direct_people(p_company uuid)
returns table (user_id uuid, full_name text, avatar_color text, avatar_url text, role_key text, role_name text, color text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, coalesce(nullif(p.full_name, ''), p.email, 'Someone'), p.color, p.avatar_url,
    coalesce(m.role_id::text, m.role::text),
    coalesce(cr.name, private.chat_role_label(m.company_id, m.role::text)),
    coalesce(s.color, 'default')
  from public.memberships m
  left join public.profiles p on p.user_id = m.user_id
  left join public.company_roles cr on cr.id = m.role_id
  left join lateral (
    select st.color from public.chat_role_settings st
    where st.company_id = m.company_id and ((m.role_id is not null and st.role_id = m.role_id) or st.role = m.role)
    order by (st.role_id is not null) desc limit 1
  ) s on true
  where m.company_id = p_company and m.active and m.role <> 'subcontractor' and m.user_id <> (select auth.uid())
    and private.chat_enabled(p_company) and private.chat_direct_on(p_company)
    and exists (select 1 from public.memberships me where me.company_id = p_company and me.user_id = (select auth.uid()) and me.active and me.role <> 'subcontractor')
  order by 2
$$;

-- The conversation with these people (1 to 8 of them, besides me): the one we already have, or a new one.
create function public.chat_start_direct(p_company uuid, p_people uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_people uuid[];
  v_key text;
  v_channel uuid;
begin
  if not private.chat_enabled(p_company) then
    raise exception 'Team chat is turned off' using errcode = '42501';
  end if;
  if not private.chat_direct_on(p_company) then
    raise exception 'Direct messages are turned off for this business' using errcode = '42501';
  end if;
  if not exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = v_me and m.active and m.role <> 'subcontractor') then
    raise exception 'Only people on the team can send direct messages' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_people from unnest(coalesce(p_people, '{}')) as x where x is not null and x <> v_me;
  if cardinality(v_people) not between 1 and 8 then
    raise exception 'Pick 1 to 8 people to message' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_people) as x
    where not exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = x and m.active and m.role <> 'subcontractor')
  ) then
    raise exception 'You can only message people on your team' using errcode = '22023';
  end if;
  select string_agg(x::text, ',' order by x::text) into v_key from unnest(v_people || v_me) as x;
  select c.id into v_channel from public.chat_channels c where c.company_id = p_company and c.direct_key = v_key;
  if v_channel is null then
    v_channel := gen_random_uuid();
    insert into public.chat_channels (id, company_id, kind, name, category, position, created_by, direct_key)
    values (v_channel, p_company, 'direct', 'dm-' || replace(v_channel::text, '-', ''), 'Direct messages', 0, v_me, v_key)
    on conflict (company_id, direct_key) where direct_key is not null do nothing;
    if found then
      insert into public.chat_direct_members (company_id, channel_id, user_id)
      select p_company, v_channel, x from unnest(v_people || v_me) as x;
    else
      -- Someone else started it at the same moment.
      select c.id into v_channel from public.chat_channels c where c.company_id = p_company and c.direct_key = v_key;
    end if;
  end if;
  -- Back in my list if I'd closed it.
  update public.chat_direct_members set closed_at = null where channel_id = v_channel and user_id = v_me and closed_at is not null;
  return v_channel;
end $$;

-- Out of my list until a new message comes.
create function public.chat_close_direct(p_channel uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.chat_can(p_channel, 'see') or not exists (select 1 from public.chat_channels c where c.id = p_channel and c.kind = 'direct') then
    raise exception 'You''re not in that conversation' using errcode = '42501';
  end if;
  update public.chat_direct_members set closed_at = now() where channel_id = p_channel and user_id = (select auth.uid());
end $$;

-- Leave a group conversation (three or more people): it's gone from my list, and I can't read it
-- any more. A conversation with one other person is closed instead.
create function public.chat_leave_direct(p_channel uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid());
begin
  if not private.chat_can(p_channel, 'see') or not exists (select 1 from public.chat_channels c where c.id = p_channel and c.kind = 'direct') then
    raise exception 'You''re not in that conversation' using errcode = '42501';
  end if;
  if (select count(*) from public.chat_direct_members d where d.channel_id = p_channel and d.left_at is null) < 3 then
    raise exception 'Only a group conversation can be left. Close this one instead.' using errcode = '22023';
  end if;
  update public.chat_direct_members set left_at = now() where channel_id = p_channel and user_id = v_me;
  update public.chat_channels set direct_key = null where id = p_channel;
  update public.notifications set read_at = now()
  where user_id = v_me and kind = 'chat' and read_at is null and link like '/chat/' || p_channel || '%';
end $$;

revoke execute on function public.chat_set_direct_messages(uuid, boolean), public.chat_direct_people(uuid), public.chat_start_direct(uuid, uuid[]),
  public.chat_close_direct(uuid), public.chat_leave_direct(uuid) from public, anon;
grant execute on function public.chat_set_direct_messages(uuid, boolean), public.chat_direct_people(uuid), public.chat_start_direct(uuid, uuid[]),
  public.chat_close_direct(uuid), public.chat_leave_direct(uuid) to authenticated;

-- The policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks('public.chat_channels');
select private.fold_member_checks('public.chat_direct_members');

notify pgrst, 'reload schema';
