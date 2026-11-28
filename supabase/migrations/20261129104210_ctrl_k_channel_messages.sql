-- Ctrl+K finds a channel's messages for someone whose matches are mostly in direct
-- conversations. global_search took twice its few messages from chat_search and left out the
-- conversations' afterwards, so ten newer ones in a conversation could leave none at all. Now the
-- search itself looks only in channels when asked to (has 'channel'), before it takes its few.
--   * chat_search_hits: as 20261129104000_chat_together.sql, with has 'channel'.
--   * global_search: as 20261129102000_chat_search.sql, asking for that.

create or replace function private.chat_search_hits(
  p_company uuid, p_query text, p_channel uuid, p_author uuid, p_has text[], p_after timestamptz, p_before timestamptz, p_best boolean,
  p_limit integer, p_offset integer
) returns table (message_id uuid, score real)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := left(trim(coalesce(p_query, '')), 200);
  v_has text[] := coalesce(p_has, '{}');
  -- What a message has, without 'channel' (said in a channel, not a direct conversation), which only narrows where to look.
  v_filters text[] := array_remove(coalesce(p_has, '{}'), 'channel');
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
  if v_tsq is null and v_like is null and p_author is null and cardinality(v_filters) = 0 and p_after is null and p_before is null then
    return;
  end if;

  select coalesce(array_agg(c.id), '{}') into v_channels
  from public.chat_channels c
  where c.company_id = p_company and (p_channel is null or c.id = p_channel) and private.chat_can(c.id, 'see')
    and (not ('channel' = any (v_has)) or c.kind <> 'direct');
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

create or replace function public.global_search(p_company_id uuid, p_query text, p_limit integer default 5)
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
  -- in a direct conversation, which Team chat's own search finds. They're left out of the search
  -- itself (has 'channel'), so a person whose matches are mostly in conversations still gets their
  -- channels' messages.
  (select 'chat'::text, m.id,
      coalesce(nullif(private.chat_search_line(p_company_id, m.body), ''), m.attachments -> 0 ->> 'name', 'Linked job'),
      concat_ws(' · ', case when ch.kind = 'text' then '#' || ch.name else ch.name end,
        (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.user_id = m.author_id)),
      null::bigint, null::text, null::uuid, m.channel_id
     from public.chat_search(p_company_id, v_q, p_has := '{channel}', p_limit := v_limit) s
     join public.chat_messages m on m.id = s.id
     join public.chat_channels ch on ch.id = m.channel_id
    where length(v_q) >= 2 and ch.kind <> 'direct'
    order by m.created_at desc
    limit v_limit);
end $$;

notify pgrst, 'reload schema';
