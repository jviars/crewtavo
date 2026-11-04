-- Search catches up with what's been added since: job applicants, team chat channels, equipment at a
-- client's property (by name, make and model, or serial), and promo codes. Clients are found by their
-- other contacts and their tags too, and a phone number by its digits however it's typed or saved
-- ("5551234567" finds "(555) 123-4567"); a property by its city or ZIP, or its whole address. It still
-- runs as the person searching, so each kind only shows what that person can already open.
create or replace function public.global_search(p_company_id uuid, p_query text, p_limit integer default 5)
returns table (kind text, id uuid, title text, subtitle text, number bigint, status text, client_id uuid)
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
  (select 'client'::text, c.id, c.display_name, concat_ws(' · ', nullif(c.company_name, ''), c.email, c.phone), null::bigint, c.status, c.id
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
  (select 'property'::text, p.id, p.line1, concat_ws(' · ', concat_ws(', ', p.city, p.region), cl.display_name), null::bigint, null::text, p.client_id
     from public.properties p join public.clients cl on cl.id = p.client_id
    where p.company_id = p_company_id
      and (concat_ws(', ', p.line1, p.city, p.region, p.postal_code) ilike v_like or p.line2 ilike v_like or p.label ilike v_like)
    order by (p.line1 ilike v_like) desc, p.line1
    limit v_limit)
  union all
  (select 'request'::text, r.id, r.title, cl.display_name, r.number, r.status, r.client_id
     from public.requests r join public.clients cl on cl.id = r.client_id
    where r.company_id = p_company_id and (r.number = v_num or r.title ilike v_like or cl.display_name ilike v_like)
    order by (r.number = v_num) desc nulls last, r.created_at desc
    limit v_limit)
  union all
  (select 'quote'::text, q.id, q.title, cl.display_name, q.number, q.status, q.client_id
     from public.quotes q join public.clients cl on cl.id = q.client_id
    where q.company_id = p_company_id and (q.number = v_num or q.title ilike v_like or cl.display_name ilike v_like)
    order by (q.number = v_num) desc nulls last, q.created_at desc
    limit v_limit)
  union all
  (select 'job'::text, j.id, j.title, cl.display_name, j.number, j.status, j.client_id
     from public.jobs j join public.clients cl on cl.id = j.client_id
    where j.company_id = p_company_id and (j.number = v_num or j.title ilike v_like or cl.display_name ilike v_like)
    order by (j.number = v_num) desc nulls last, j.created_at desc
    limit v_limit)
  union all
  (select 'invoice'::text, i.id, coalesce(nullif(i.subject, ''), 'Invoice #' || i.number), cl.display_name, i.number, i.status, i.client_id
     from public.invoices i join public.clients cl on cl.id = i.client_id
    where i.company_id = p_company_id and (i.number = v_num or i.subject ilike v_like or cl.display_name ilike v_like)
    order by (i.number = v_num) desc nulls last, i.created_at desc
    limit v_limit)
  union all
  -- "Measurement" is the name every drawing starts with, so it only matches a name someone gave it.
  (select 'measurement'::text, m.id, m.title, concat_ws(' · ', p.line1, cl.display_name), null::bigint, null::text, cl.id
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
  (select 'kb'::text, s.id, s.title, concat_ws(' · ', sc.name, case when s.status = 'draft' then 'Draft' end), null::bigint, s.status, null::uuid
     from public.sop_pages s left join public.sop_categories sc on sc.id = s.category_id
    where s.company_id = p_company_id and (s.title ilike v_like or s.body_text ilike v_like or s.search @@ v_words)
    order by (s.title ilike v_like) desc, ts_rank(s.search, v_words) desc, s.title
    limit v_limit)
  union all
  (select 'campaign'::text, cp.id, cp.name, nullif(cp.subject, ''), null::bigint, cp.status, null::uuid
     from public.campaigns cp
    where cp.company_id = p_company_id and (cp.name ilike v_like or cp.subject ilike v_like)
    order by cp.created_at desc
    limit v_limit)
  union all
  (select 'rule'::text, ar.id, ar.name, case when ar.enabled then 'On' else 'Off' end, null::bigint, null::text, null::uuid
     from public.automation_rules ar
    where ar.company_id = p_company_id and (ar.name ilike v_like or ar.description ilike v_like)
    order by (ar.name ilike v_like) desc, ar.name
    limit v_limit)
  union all
  (select 'service'::text, sv.id, sv.name, nullif(sv.category, ''), null::bigint, null::text, null::uuid
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
      null::bigint, case when f.archived then 'archived' end, f.client_id
     from private.drive_files f
    where f.company_id = p_company_id and f.company_id = any ((select private.member_companies())::uuid[])
      and f.superseded_at is null and (f.title ilike v_like or f.file_name ilike v_like)
    order by (f.title ilike v_q || '%') desc, f.updated_at desc
    limit v_limit)
  union all
  -- Those still being decided first.
  (select 'applicant'::text, a.id, a.name, concat_ws(' · ', nullif(a.position, ''), a.email, a.phone), null::bigint, a.status, null::uuid
     from public.job_applicants a
    where a.company_id = p_company_id
      and (a.name ilike v_like or a.email ilike v_like or a.position ilike v_like or a.phone ilike v_like
        or regexp_replace(a.phone, '\D', '', 'g') like '%' || v_digits || '%')
    order by (a.status in ('hired', 'not_hired')), a.created_at desc
    limit v_limit)
  union all
  -- "#north-crew", "north crew" and "north" all find #north-crew.
  (select 'channel'::text, ch.id, case when ch.kind = 'text' then '#' || ch.name else ch.name end, coalesce(nullif(ch.topic, ''), ch.category),
      null::bigint, null::text, null::uuid
     from public.chat_channels ch
    where ch.company_id = p_company_id and ch.archived_at is null
      and (('#' || ch.name) ilike v_like or replace(ch.name, '-', ' ') ilike v_like or ch.topic ilike v_like)
    order by ch.position
    limit v_limit)
  union all
  (select 'asset'::text, pa.id, pa.name, concat_ws(' · ', nullif(concat_ws(' ', pa.make, pa.model), ''), p.line1, cl.display_name), null::bigint, pa.status, cl.id
     from public.property_assets pa
     join public.properties p on p.id = pa.property_id
     join public.clients cl on cl.id = p.client_id
    where pa.company_id = p_company_id
      and (pa.name ilike v_like or concat_ws(' ', pa.make, pa.model) ilike v_like or pa.serial ilike v_like)
    order by (pa.status = 'retired'), pa.name
    limit v_limit)
  union all
  (select 'promo'::text, pc.id, pc.code, nullif(pc.description, ''), null::bigint, case when not pc.active then 'off' end, null::uuid
     from public.promo_codes pc
    where pc.company_id = p_company_id and (pc.code ilike v_like or pc.description ilike v_like)
    order by pc.active desc, pc.code
    limit v_limit);
end $$;

notify pgrst, 'reload schema';
