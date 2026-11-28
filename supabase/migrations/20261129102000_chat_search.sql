-- Searching team chat: a message is found by its words, its files' names and the words of a voice
-- note (an attachment's "words", which the field app writes as it records one), whole or partial
-- ("fenc" finds "fences", "way" finds "driveway"), newest or best first, with filters for a channel,
-- a person, what it has (a photo, a file, a linked job, a link) and a date. Deleted messages never
-- show, and people find only what they can already read: chat_messages' row-level security
-- (20261019001600_team_chat.sql) has the last word on every result, whatever kinds of conversation
-- there are.
--
-- Ctrl+K (public.global_search) finds messages too, and no longer lists direct conversations among
-- its channels.

-- ---------------------------------------------------------------------------------------------
-- What a message is found by
-- ---------------------------------------------------------------------------------------------

-- Its words without mention tokens (<@id>, <@&role>) or Markdown's marks, then its files' names and
-- a voice note's words, in lower case. Kept on the row (chat_messages.search_text and .search), so
-- an edit or a delete (which empties the message) changes them at once.
create function private.chat_search_text(p_body text, p_attachments jsonb) returns text
language sql immutable parallel safe set search_path = '' as $$
  select lower(
    regexp_replace(regexp_replace(coalesce(p_body, ''), '<@&?[^<>\s]{1,64}>', ' ', 'g'), '[*_~`#>|\\]+', ' ', 'g')
    || coalesce(' ' || (
      select string_agg(coalesce(a ->> 'name', '') || ' ' || coalesce(a ->> 'words', ''), ' ')
      from jsonb_array_elements(case when jsonb_typeof(p_attachments) = 'array' then p_attachments else '[]'::jsonb end) a
      where jsonb_typeof(a) = 'object'
    ), '')
  )
$$;
revoke execute on function private.chat_search_text(text, jsonb) from public;
grant execute on function private.chat_search_text(text, jsonb) to authenticated, service_role;

alter table public.chat_messages
  add column search_text text generated always as (private.chat_search_text(body, attachments)) stored,
  add column search tsvector generated always as (to_tsvector('english'::regconfig, private.chat_search_text(body, attachments))) stored;

-- Whole words and the starts of words (search), and words inside others (search_text, by trigrams).
create index chat_messages_search_idx on public.chat_messages using gin (search);
create index chat_messages_search_text_idx on public.chat_messages using gin (search_text extensions.gin_trgm_ops);
-- "From a person".
create index chat_messages_author_idx on public.chat_messages (author_id, created_at desc) where author_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Searching
-- ---------------------------------------------------------------------------------------------

-- The messages that match, best or newest first, among the channels the person searching can see
-- (chat_can, the rule chat_messages' own policy uses). It reads the messages itself, so the search
-- indexes are used: Postgres won't use them under a row-level security policy, as matching words
-- isn't "leakproof", and would read every message in the company instead. public.chat_search
-- reads each result again as the person, so their row-level security still decides.
--   p_has: any of 'photo', 'file', 'job', 'link'; a message must have them all.
create function private.chat_search_hits(
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

  return query
  select hit.id, hit.found_score
  from (
    select m.id, m.created_at,
      (coalesce(case when v_tsq is not null then ts_rank(m.search, v_tsq) end, 0)
        + case when v_like is not null and m.search_text like v_like then 0.5 else 0 end)::real as found_score
    from public.chat_messages m
    where m.company_id = p_company
      and m.channel_id = any (v_channels)
      and m.deleted_at is null
      and ((v_tsq is null and v_like is null) or (v_tsq is not null and m.search @@ v_tsq) or (v_like is not null and m.search_text like v_like))
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
revoke execute on function private.chat_search_hits(uuid, text, uuid, uuid, text[], timestamptz, timestamptz, boolean, integer, integer) from public;
grant execute on function private.chat_search_hits(uuid, text, uuid, uuid, text[], timestamptz, timestamptz, boolean, integer, integer) to authenticated, service_role;

-- What the app calls: the matches, in order, as the person searching reads them (row-level
-- security on chat_messages). p_order: 'best' or 'newest'.
create function public.chat_search(
  p_company uuid, p_query text default null, p_channel uuid default null, p_author uuid default null, p_has text[] default '{}',
  p_after timestamptz default null, p_before timestamptz default null, p_order text default 'newest', p_limit integer default 30, p_offset integer default 0
) returns table (id uuid, channel_id uuid, rank real)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.channel_id, h.score
  from private.chat_search_hits(p_company, p_query, p_channel, p_author, p_has, p_after, p_before, p_order = 'best', p_limit, p_offset) with ordinality h (message_id, score, n)
  join public.chat_messages m on m.id = h.message_id and m.deleted_at is null
  order by h.n
$$;
revoke execute on function public.chat_search(uuid, text, uuid, uuid, text[], timestamptz, timestamptz, text, integer, integer) from public, anon;
grant execute on function public.chat_search(uuid, text, uuid, uuid, text[], timestamptz, timestamptz, text, integer, integer) to authenticated;

-- A message as one line for Ctrl+K: @names for mentions (as the person reads them), no Markdown
-- marks, at most 140 characters. It runs as the person, so it names only people they can see.
create function private.chat_search_line(p_company uuid, p_body text) returns text
language plpgsql stable security invoker set search_path = '' as $$
declare
  v text := coalesce(p_body, '');
  r record;
begin
  for r in select distinct x[1] as id from regexp_matches(v, '<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>', 'g') as t(x) loop
    v := replace(v, '<@' || r.id || '>', '@' || coalesce((select nullif(p.full_name, '') from public.profiles p where p.user_id = r.id::uuid), 'someone'));
  end loop;
  for r in select distinct x[1] as k from regexp_matches(v, '<@&([a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>', 'g') as t(x) loop
    v := replace(v, '<@&' || r.k || '>', '@' || coalesce(private.chat_role_label(p_company, r.k), 'role'));
  end loop;
  v := regexp_replace(v, '^[ \t]*(#{1,3}|>|[-*+•]|[0-9]{1,3}[.)])[ \t]+', '', 'gn');
  v := regexp_replace(v, '(\*\*|__|~~|`)', '', 'g');
  return left(trim(regexp_replace(v, '\s+', ' ', 'g')), 140);
end $$;
revoke execute on function private.chat_search_line(uuid, text) from public;
grant execute on function private.chat_search_line(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Ctrl+K: as 20261107000800_search_more.sql, with chat messages (each with its channel in
-- parent_id, to open it there), and no direct conversations among the channels.
-- ---------------------------------------------------------------------------------------------

drop function public.global_search(uuid, text, integer);
create function public.global_search(p_company_id uuid, p_query text, p_limit integer default 5)
returns table (kind text, id uuid, title text, subtitle text, number bigint, status text, client_id uuid, parent_id uuid)
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_q text := trim(coalesce(p_query, ''));
  v_like text;
  v_num bigint;
  v_digits text;
  v_words tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
begin
  if length(v_q) = 0 then
    return;
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if v_q ~ '^#?[0-9]{1,12}$' then
    v_num := ltrim(v_q, '#')::bigint;
  end if;
  -- Something that looks like a phone number: its digits, without a leading 1 before ten more.
  if v_q ~ '^[0-9\s().+-]+$' then
    v_digits := regexp_replace(regexp_replace(v_q, '\D', '', 'g'), '^1([0-9]{10})$', '\1');
    if length(v_digits) < 4 then
      v_digits := null;
    end if;
  end if;
  v_words := websearch_to_tsquery('english', v_q);

  return query
  (select 'client'::text, c.id, c.display_name, concat_ws(' · ', nullif(c.company_name, ''), c.email, c.phone), null::bigint, c.status, c.id, null::uuid
     from public.clients c
    where c.company_id = p_company_id
      and (c.display_name ilike v_like or c.company_name ilike v_like or c.email ilike v_like or c.phone ilike v_like
        or regexp_replace(c.phone, '\D', '', 'g') like '%' || v_digits || '%'
        or exists (select 1 from unnest(c.tags) t (tag) where t.tag ilike v_like)
        or exists (select 1 from public.client_contacts cc
                    where cc.company_id = p_company_id and cc.client_id = c.id
                      and (cc.name ilike v_like or cc.email ilike v_like or regexp_replace(cc.phone, '\D', '', 'g') like '%' || v_digits || '%')))
    order by (c.status = 'archived'), (c.display_name ilike v_q || '%') desc, c.display_name
    limit v_limit)
  union all
  (select 'property'::text, p.id, p.line1, concat_ws(' · ', concat_ws(', ', p.city, p.region), cl.display_name), null::bigint, null::text, p.client_id, null::uuid
     from public.properties p join public.clients cl on cl.id = p.client_id
    where p.company_id = p_company_id
      and (concat_ws(', ', p.line1, p.city, p.region, p.postal_code) ilike v_like or p.line2 ilike v_like or p.label ilike v_like)
    order by (p.line1 ilike v_like) desc, p.line1
    limit v_limit)
  union all
  (select 'request'::text, r.id, r.title, cl.display_name, r.number, r.status, r.client_id, null::uuid
     from public.requests r join public.clients cl on cl.id = r.client_id
    where r.company_id = p_company_id and (r.number = v_num or r.title ilike v_like or cl.display_name ilike v_like)
    order by (r.number = v_num) desc nulls last, r.created_at desc
    limit v_limit)
  union all
  (select 'quote'::text, q.id, q.title, cl.display_name, q.number, q.status, q.client_id, null::uuid
     from public.quotes q join public.clients cl on cl.id = q.client_id
    where q.company_id = p_company_id and (q.number = v_num or q.title ilike v_like or cl.display_name ilike v_like)
    order by (q.number = v_num) desc nulls last, q.created_at desc
    limit v_limit)
  union all
  (select 'job'::text, j.id, j.title, cl.display_name, j.number, j.status, j.client_id, null::uuid
     from public.jobs j join public.clients cl on cl.id = j.client_id
    where j.company_id = p_company_id and (j.number = v_num or j.title ilike v_like or cl.display_name ilike v_like)
    order by (j.number = v_num) desc nulls last, j.created_at desc
    limit v_limit)
  union all
  (select 'invoice'::text, i.id, coalesce(nullif(i.subject, ''), 'Invoice #' || i.number), cl.display_name, i.number, i.status, i.client_id, null::uuid
     from public.invoices i join public.clients cl on cl.id = i.client_id
    where i.company_id = p_company_id and (i.number = v_num or i.subject ilike v_like or cl.display_name ilike v_like)
    order by (i.number = v_num) desc nulls last, i.created_at desc
    limit v_limit)
  union all
  -- "Measurement" is the name every drawing starts with, so it only matches a name someone gave it.
  (select 'measurement'::text, m.id, m.title, concat_ws(' · ', p.line1, cl.display_name), null::bigint, null::text, cl.id, null::uuid
     from public.measurements m
     left join public.properties p on p.id = m.property_id
     left join public.quotes q on q.id = m.quote_id
     left join public.requests r on r.id = m.request_id
     left join public.invoices i on i.id = m.invoice_id
     left join public.clients cl on cl.id = coalesce(p.client_id, q.client_id, r.client_id, i.client_id)
    where m.company_id = p_company_id
      and ((m.title <> 'Measurement' and m.title ilike v_like) or p.line1 ilike v_like or cl.display_name ilike v_like
        or q.title ilike v_like or q.number = v_num)
    order by m.updated_at desc
    limit v_limit)
  union all
  (select 'kb'::text, s.id, s.title, concat_ws(' · ', sc.name, case when s.status = 'draft' then 'Draft' end), null::bigint, s.status, null::uuid, null::uuid
     from public.sop_pages s left join public.sop_categories sc on sc.id = s.category_id
    where s.company_id = p_company_id and (s.title ilike v_like or s.body_text ilike v_like or s.search @@ v_words)
    order by (s.title ilike v_like) desc, ts_rank(s.search, v_words) desc, s.title
    limit v_limit)
  union all
  (select 'campaign'::text, cp.id, cp.name, nullif(cp.subject, ''), null::bigint, cp.status, null::uuid, null::uuid
     from public.campaigns cp
    where cp.company_id = p_company_id and (cp.name ilike v_like or cp.subject ilike v_like)
    order by cp.created_at desc
    limit v_limit)
  union all
  (select 'rule'::text, ar.id, ar.name, case when ar.enabled then 'On' else 'Off' end, null::bigint, null::text, null::uuid, null::uuid
     from public.automation_rules ar
    where ar.company_id = p_company_id and (ar.name ilike v_like or ar.description ilike v_like)
    order by (ar.name ilike v_like) desc, ar.name
    limit v_limit)
  union all
  (select 'service'::text, sv.id, sv.name, nullif(sv.category, ''), null::bigint, null::text, null::uuid, null::uuid
     from public.services sv
    where sv.company_id = p_company_id and sv.active and (sv.name ilike v_like or sv.category ilike v_like)
    order by (sv.name ilike v_q || '%') desc, sv.sort, sv.name
    limit v_limit)
  union all
  (select 'file'::text, f.id, f.title,
      concat_ws(' · ', case
        when f.job_id is not null then 'Job #' || f.job_number
        when f.quote_id is not null then 'Quote #' || f.quote_number
        when f.request_id is not null then f.request_title
        when f.property_id is not null then f.property_label
        else coalesce(f.folder_name, 'Company files')
      end, f.client_name),
      null::bigint, case when f.archived then 'archived' end, f.client_id, null::uuid
     from private.drive_files f
    where f.company_id = p_company_id and f.company_id = any ((select private.member_companies())::uuid[])
      and f.superseded_at is null and (f.title ilike v_like or f.file_name ilike v_like)
    order by (f.title ilike v_q || '%') desc, f.updated_at desc
    limit v_limit)
  union all
  -- Those still being decided first.
  (select 'applicant'::text, a.id, a.name, concat_ws(' · ', nullif(a.position, ''), a.email, a.phone), null::bigint, a.status, null::uuid, null::uuid
     from public.job_applicants a
    where a.company_id = p_company_id
      and (a.name ilike v_like or a.email ilike v_like or a.position ilike v_like or a.phone ilike v_like
        or regexp_replace(a.phone, '\D', '', 'g') like '%' || v_digits || '%')
    order by (a.status in ('hired', 'not_hired')), a.created_at desc
    limit v_limit)
  union all
  -- "#north-crew", "north crew" and "north" all find #north-crew. A direct conversation is two
  -- people's, not a channel to jump to.
  (select 'channel'::text, ch.id, case when ch.kind = 'text' then '#' || ch.name else ch.name end, coalesce(nullif(ch.topic, ''), ch.category),
      null::bigint, null::text, null::uuid, null::uuid
     from public.chat_channels ch
    where ch.company_id = p_company_id and ch.archived_at is null and ch.kind <> 'direct'
      and (('#' || ch.name) ilike v_like or replace(ch.name, '-', ' ') ilike v_like or ch.topic ilike v_like)
    order by ch.position
    limit v_limit)
  union all
  (select 'asset'::text, pa.id, pa.name, concat_ws(' · ', nullif(concat_ws(' ', pa.make, pa.model), ''), p.line1, cl.display_name), null::bigint, pa.status, cl.id, null::uuid
     from public.property_assets pa
     join public.properties p on p.id = pa.property_id
     join public.clients cl on cl.id = p.client_id
    where pa.company_id = p_company_id
      and (pa.name ilike v_like or concat_ws(' ', pa.make, pa.model) ilike v_like or pa.serial ilike v_like)
    order by (pa.status = 'retired'), pa.name
    limit v_limit)
  union all
  (select 'promo'::text, pc.id, pc.code, nullif(pc.description, ''), null::bigint, case when not pc.active then 'off' end, null::uuid, null::uuid
     from public.promo_codes pc
    where pc.company_id = p_company_id and (pc.code ilike v_like or pc.description ilike v_like)
    order by pc.active desc, pc.code
    limit v_limit)
  union all
  -- Team chat messages, newest first, in the channels the person can read (chat_search); not those
  -- in a direct conversation, which Team chat's own search finds.
  (select 'chat'::text, m.id,
      coalesce(nullif(private.chat_search_line(p_company_id, m.body), ''), m.attachments -> 0 ->> 'name', 'Linked job'),
      concat_ws(' · ', case when ch.kind = 'text' then '#' || ch.name else ch.name end,
        (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.user_id = m.author_id)),
      null::bigint, null::text, null::uuid, m.channel_id
     from public.chat_search(p_company_id, v_q, p_limit := v_limit * 2) s
     join public.chat_messages m on m.id = s.id
     join public.chat_channels ch on ch.id = m.channel_id
    where length(v_q) >= 2 and ch.kind <> 'direct'
    order by m.created_at desc
    limit v_limit);
end $$;
revoke execute on function public.global_search(uuid, text, integer) from public, anon;
grant execute on function public.global_search(uuid, text, integer) to authenticated;

notify pgrst, 'reload schema';
