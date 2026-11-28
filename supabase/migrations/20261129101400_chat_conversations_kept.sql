-- Leaving the company leaves its direct conversations, and the server can count a thread's replies.
--
-- Someone made inactive (or taken off the team) leaves every direct conversation they were in, as
-- leaving a group does (chat_direct_members.left_at), so being made active again later doesn't bring
-- any of them back, nor what was said while they were away. The others keep the history, and still
-- see who it was with (left_company): a conversation with only them is named by them. Messaging the
-- same people again starts a new conversation (its direct_key is cleared). Those already inactive
-- leave theirs here. As 20261129101000_chat_direct_messages.sql otherwise.
--
-- public.chat_thread_summaries answers the server too (no one signed in: the service key's live
-- updates, a voice note's words written down, a scheduled message sent), so a message it shows keeps
-- its "3 replies". Only signed-in people and the server can call it, so anyone signed in is still
-- answered only for channels they can see.

alter table public.chat_direct_members add column left_company boolean not null default false;

create function private.chat_direct_leave_company() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not (old.active and not new.active) then return null; end if;
  update public.chat_channels c set direct_key = null
  where c.company_id = old.company_id and c.kind = 'direct' and c.direct_key is not null
    and exists (select 1 from public.chat_direct_members d where d.channel_id = c.id and d.user_id = old.user_id and d.left_at is null);
  update public.chat_direct_members d set left_at = now(), left_company = true
  where d.company_id = old.company_id and d.user_id = old.user_id and d.left_at is null;
  return null;
end $$;
revoke execute on function private.chat_direct_leave_company() from public;
create trigger chat_direct_leave_company after update of active or delete on public.memberships
  for each row execute function private.chat_direct_leave_company();

-- Those who left before this.
update public.chat_channels c set direct_key = null
where c.kind = 'direct' and c.direct_key is not null and exists (
  select 1 from public.chat_direct_members d
  where d.channel_id = c.id and d.left_at is null
    and not exists (select 1 from public.memberships m where m.company_id = d.company_id and m.user_id = d.user_id and m.active)
);
update public.chat_direct_members d set left_at = now(), left_company = true
where d.left_at is null and not exists (select 1 from public.memberships m where m.company_id = d.company_id and m.user_id = d.user_id and m.active);

-- As 20261129101200_chat_notification_settings.sql, except that a conversation's people include
-- those who left the company, so it's still named by them.
create or replace function public.chat_overview(p_company uuid)
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
      where d.channel_id = v.id and d.user_id <> me.user_id and (d.left_at is null or d.left_company)
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

-- As 20261129101100_chat_threads.sql, and with no one signed in (the server) for every message asked about.
create or replace function public.chat_thread_summaries(p_roots uuid[])
returns table (root_id uuid, replies integer, last_reply_at timestamptz, people uuid[])
language sql stable security definer set search_path = '' as $$
  with roots as (
    select m.id from public.chat_messages m
    where m.id = any (p_roots) and m.thread_root is null
      and ((select auth.uid()) is null or private.chat_can(m.channel_id, 'see'))
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
grant execute on function public.chat_thread_summaries(uuid[]) to service_role;

notify pgrst, 'reload schema';
