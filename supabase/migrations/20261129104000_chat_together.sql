-- Team chat's new parts, fitted together (direct messages, threads and notification choices in
-- 20261129101000 to 101300; search, reactions, files, link cards and saved messages in 102000 to
-- 102300; voice notes, scheduled messages and reminders in 103100 to 103500):
--   * A notification about a message with no words says what it carried: a voice note, a file or a
--     photo (it said "Sent a photo" for all three). chat_notify_mentions is otherwise as in
--     20261129101200_chat_notification_settings.sql.
--   * A notification shows a message's words without their Markdown marks (bold, strikethrough and
--     code marks, a quote's ">", a heading's "#", a link's address), as Team chat shows them
--     (packages/core/src/chat.ts).
--   * A direct conversation is "a conversation" in words about it (a reminder, a scheduled message
--     that couldn't be sent), not its internal name.
--   * Search finds a voice note by the words the server wrote down for it (chat_transcripts), as it
--     already did by the words the phone heard. chat_search_hits is otherwise as in
--     20261129102000_chat_search.sql.

-- What a message without words carried, for its notification.
create function private.chat_files_line(p_attachments jsonb) returns text
language sql immutable set search_path = '' as $$
  select case
    when exists (select 1 from jsonb_array_elements(coalesce(p_attachments, '[]')) a
                 where a ->> 'path' ~* '\.(webm|weba|m4a|mp4|aac|mp3|mpga|ogg|oga|opus|wav)$') then 'Sent a voice note'
    when exists (select 1 from jsonb_array_elements(coalesce(p_attachments, '[]')) a
                 where a ->> 'path' ~* '\.(pdf|doc|docx|xls|xlsx|csv|txt|rtf|ppt|pptx|odt|ods|odp)$') then 'Sent a file'
    else 'Sent a photo'
  end
$$;
revoke execute on function private.chat_files_line(jsonb) from public;

-- A message as plain text: <@id> and <@&role> become @names, and Markdown's marks go.
create or replace function private.chat_plain(p_company uuid, p_body text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v text := p_body;
  r record;
begin
  for r in select distinct x[1] as id from regexp_matches(p_body, '<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>', 'g') as t(x) loop
    v := replace(v, '<@' || r.id || '>', '@' || coalesce((select nullif(p.full_name, '') from public.profiles p where p.user_id = r.id::uuid), 'someone'));
  end loop;
  for r in select distinct x[1] as k from regexp_matches(p_body, '<@&([a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>', 'g') as t(x) loop
    v := replace(v, '<@&' || r.k || '>', '@' || coalesce(private.chat_role_label(p_company, r.k), 'role'));
  end loop;
  -- [words](address) keeps its words; bold, strikethrough and code marks go; so do a line's quote
  -- and heading marks.
  v := regexp_replace(v, '\[([^]\n]+)\]\((https?://|mailto:|tel:)[^)[:space:]]+\)', '\1', 'g');
  v := regexp_replace(v, '\*\*|__|~~|`', '', 'g');
  v := regexp_replace(v, '^[ \t]*(>[ \t]?|#{1,3}[ \t]+)', '', 'gn');
  return v;
end $$;

-- A channel in words: its name, #name for a text channel, "a conversation" for a direct one.
create or replace function private.chat_where(p_channel uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case c.kind when 'announcement' then c.name when 'direct' then 'a conversation' else '#' || c.name end
  from public.chat_channels c where c.id = p_channel
$$;

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
      coalesce(v_text, private.chat_files_line(new.attachments)),
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
    coalesce(v_text, private.chat_files_line(new.attachments)),
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

create or replace function private.chat_search_hits(
  p_company uuid, p_query text, p_channel uuid, p_author uuid, p_has text[], p_after timestamptz, p_before timestamptz, p_best boolean,
  p_limit integer, p_offset integer
) returns table (message_id uuid, score real)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := left(trim(coalesce(p_query, '')), 200);
  v_has text[] := coalesce(p_has, '{}');
  v_words text[];
  v_tsq tsquery;
  v_like text;
  v_channels uuid[];
  v_spoken uuid[] := '{}';
begin
  if p_company is null or not private.chat_enabled(p_company) then
    return;
  end if;
  -- Words: split at spaces and punctuation, each matching as the start of a word ("fenc" finds
  -- "fences", "fences" finds "fence"). Common words (the, and) match anything.
  v_words := array(select w from regexp_split_to_table(lower(v_q), '[[:space:][:punct:]]+') w where w <> '' limit 12);
  if cardinality(v_words) > 0 then
    v_tsq := to_tsquery('english', array_to_string(array(select quote_literal(w) || ':*' from unnest(v_words) w), ' & '));
    if numnode(v_tsq) = 0 then
      v_tsq := null;
    end if;
  end if;
  -- Three letters or more also match inside a word ("way" finds "driveway") or across words as typed.
  if length(v_q) >= 3 then
    v_like := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  -- Nothing to look for at all: nothing found.
  if v_tsq is null and v_like is null and p_author is null and cardinality(v_has) = 0 and p_after is null and p_before is null then
    return;
  end if;

  select coalesce(array_agg(c.id), '{}') into v_channels
  from public.chat_channels c
  where c.company_id = p_company and (p_channel is null or c.id = p_channel) and private.chat_can(c.id, 'see');
  if cardinality(v_channels) = 0 then
    return;
  end if;
  -- Voice notes the server put into words (chat_transcripts) are found by those words too.
  if v_tsq is not null or v_like is not null then
    select coalesce(array_agg(distinct t.message_id), '{}') into v_spoken
    from public.chat_transcripts t
    where t.company_id = p_company and t.channel_id = any (v_channels)
      and ((v_tsq is not null and to_tsvector('english', t.words) @@ v_tsq) or (v_like is not null and lower(t.words) like v_like));
  end if;

  return query
  select hit.id, hit.found_score
  from (
    select m.id, m.created_at,
      (coalesce(case when v_tsq is not null then ts_rank(m.search, v_tsq) end, 0)
        + case when v_like is not null and m.search_text like v_like then 0.5 else 0 end
        + case when m.id = any (v_spoken) then 0.3 else 0 end)::real as found_score
    from public.chat_messages m
    where m.company_id = p_company
      and m.channel_id = any (v_channels)
      and m.deleted_at is null
      and ((v_tsq is null and v_like is null) or (v_tsq is not null and m.search @@ v_tsq) or (v_like is not null and m.search_text like v_like) or m.id = any (v_spoken))
      and (p_author is null or m.author_id = p_author)
      and (p_after is null or m.created_at >= p_after)
      and (p_before is null or m.created_at < p_before)
      -- The endings private.chat_file_endings() allows: pictures, and documents (not voice notes).
      and (not ('photo' = any (v_has)) or exists (select 1 from jsonb_array_elements(m.attachments) a where a ->> 'path' ~* '\.(jpg|jpeg|png|webp|gif|heic|heif)$'))
      and (not ('file' = any (v_has)) or exists (select 1 from jsonb_array_elements(m.attachments) a where a ->> 'path' ~* '\.(pdf|doc|docx|xls|xlsx|csv|txt|rtf|ppt|pptx|odt|ods|odp)$'))
      and (not ('job' = any (v_has)) or m.job_id is not null)
      and (not ('link' = any (v_has)) or m.body ~* 'https?://')
  ) hit
  order by case when p_best then hit.found_score end desc nulls last, hit.created_at desc, hit.id
  limit least(greatest(coalesce(p_limit, 30), 1), 101)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;
