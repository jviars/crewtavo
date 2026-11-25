-- A reply to your message counts as a mention: the channel's number in the sidebar and the menu
-- (chat_overview), and a "replied to you" notification for the bell, push, email or text by the
-- Team chat choices (chat_notify_mentions). Replying to yourself tells nobody. Otherwise both are
-- as in 20261019001600_team_chat.sql.

create or replace function public.chat_overview(p_company uuid)
returns table (
  id uuid, kind text, name text, category text, topic text, crew_id uuid, "position" integer, archived boolean,
  can_post boolean, can_manage boolean, unread integer, mentions integer, last_message_at timestamptz
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
    coalesce(n.unread, 0)::integer, coalesce(n.mentions, 0)::integer, n.last_at
  from visible v
  cross join me
  left join public.chat_reads rd on rd.channel_id = v.id and rd.user_id = me.user_id
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

create or replace function private.chat_notify_mentions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_where text;
  v_text text;
  v_replied uuid := (select r.author_id from public.chat_messages r where r.id = new.reply_to);
begin
  if not (new.mention_all or cardinality(new.mention_users) > 0 or cardinality(new.mention_roles) > 0 or v_replied is not null) then return null; end if;
  select case when c.kind = 'announcement' then c.name else '#' || c.name end into v_where from public.chat_channels c where c.id = new.channel_id;
  v_name := coalesce((select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.user_id = new.author_id), 'Crewtavo');
  v_text := nullif(left(regexp_replace(private.chat_plain(new.company_id, new.body), '\s+', ' ', 'g'), 140), '');
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
