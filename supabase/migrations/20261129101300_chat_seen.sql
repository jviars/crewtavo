-- "Seen by": who has read a message, from how far each person has read its channel
-- (chat_reads.last_read_at, which chat_mark_read moves on while the channel is open).
--
--   An announcement channel   under each message, "Seen by 12 of 15": of everyone who can see the
--                             channel but its author, how many have read past it, and a list of who has
--                             and who hasn't yet. Only the message's author and the channel's managers
--                             (owners, admins, office, and whoever manages it) can ask.
--   A direct conversation     how far each of the others has read, so your own latest message can say
--                             "Seen", or "Seen by Marcus" in a group. Only its people can ask.
-- Nobody else gets an answer, and other channels have none.

-- Who can see the channel, and how far each has read it: the people the answers are about.
create function private.chat_readers(p_channel uuid)
returns table (user_id uuid, last_read_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, rd.last_read_at
  from public.chat_channels c
  join public.memberships m on m.company_id = c.company_id and m.active and m.role <> 'subcontractor'
  left join public.chat_reads rd on rd.channel_id = c.id and rd.user_id = m.user_id
  where c.id = p_channel and (private.chat_rights(c.id, m.user_id)).can_see
$$;
revoke execute on function private.chat_readers(uuid) from public;

-- May I see who has read this announcement channel's messages? Its managers may, for every message.
create function private.chat_reads_managed(p_channel uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chat_channels c
    where c.id = p_channel and c.kind = 'announcement' and private.chat_can(c.id, 'see')
      and (private.chat_can(c.id, 'manage') or private.has_role(c.company_id, '{owner,admin,office}'))
  )
$$;
revoke execute on function private.chat_reads_managed(uuid) from public;

-- For these messages of an announcement channel: how many have seen each, of how many (its author left
-- out of both). Only for the messages I wrote, unless I manage the channel.
create function public.chat_seen_counts(p_channel uuid, p_messages uuid[])
returns table (message_id uuid, seen integer, total integer)
language sql stable security definer set search_path = '' as $$
  with allowed as (
    select msg.id, msg.author_id, msg.created_at from public.chat_messages msg
    join public.chat_channels c on c.id = msg.channel_id and c.kind = 'announcement'
    where msg.id = any (p_messages) and msg.channel_id = p_channel and msg.deleted_at is null
      and private.chat_can(p_channel, 'see')
      and (msg.author_id = (select auth.uid()) or private.chat_reads_managed(p_channel))
  ),
  readers as (select r.user_id, r.last_read_at from private.chat_readers(p_channel) r where exists (select 1 from allowed))
  select a.id,
    (count(r.user_id) filter (where r.user_id is distinct from a.author_id and r.last_read_at >= a.created_at))::integer,
    (count(r.user_id) filter (where r.user_id is distinct from a.author_id))::integer
  from allowed a
  left join readers r on true
  group by a.id
$$;

-- Who has seen one announcement, and who hasn't yet (seen_at null), for its author and the channel's managers.
create function public.chat_seen_list(p_message uuid)
returns table (user_id uuid, seen_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.user_id, case when r.last_read_at >= msg.created_at then r.last_read_at end
  from public.chat_messages msg
  join public.chat_channels c on c.id = msg.channel_id and c.kind = 'announcement'
  cross join lateral private.chat_readers(msg.channel_id) r
  where msg.id = p_message and msg.deleted_at is null and private.chat_can(msg.channel_id, 'see')
    and (msg.author_id = (select auth.uid()) or private.chat_reads_managed(msg.channel_id))
    and r.user_id is distinct from msg.author_id
$$;

-- How far each of the others in a direct conversation has read it, for its people.
create function public.chat_read_marks(p_channel uuid)
returns table (user_id uuid, last_read_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.user_id, r.last_read_at
  from public.chat_channels c
  cross join lateral private.chat_readers(c.id) r
  where c.id = p_channel and c.kind = 'direct' and private.chat_can(c.id, 'see') and r.user_id <> (select auth.uid())
$$;

revoke execute on function public.chat_seen_counts(uuid, uuid[]), public.chat_seen_list(uuid), public.chat_read_marks(uuid) from public, anon;
grant execute on function public.chat_seen_counts(uuid, uuid[]), public.chat_seen_list(uuid), public.chat_read_marks(uuid) to authenticated;

notify pgrst, 'reload schema';
