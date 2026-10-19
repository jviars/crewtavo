-- Search finds more of the app: saved measurements (by name, address or client), knowledge base
-- pages (by title or anything in the text), marketing campaigns, automation rules and price list
-- services, besides clients, properties, requests, quotes, jobs and invoices. It runs as the
-- person searching, so each kind only shows what that person can already open.

create or replace function public.global_search(p_company_id uuid, p_query text, p_limit integer default 5)
returns table (kind text, id uuid, title text, subtitle text, number bigint, status text, client_id uuid)
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_q text := trim(coalesce(p_query, ''));
  v_like text;
  v_num bigint;
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
  v_words := websearch_to_tsquery('english', v_q);

  return query
  (select 'client'::text, c.id, c.display_name, concat_ws(' · ', nullif(c.company_name, ''), c.email, c.phone), null::bigint, c.status, c.id
     from public.clients c
    where c.company_id = p_company_id
      and (c.display_name ilike v_like or c.company_name ilike v_like or c.email ilike v_like or c.phone ilike v_like)
    order by (c.status = 'archived'), (c.display_name ilike v_q || '%') desc, c.display_name
    limit v_limit)
  union all
  (select 'property'::text, p.id, p.line1, concat_ws(' · ', concat_ws(', ', p.city, p.region), cl.display_name), null::bigint, null::text, p.client_id
     from public.properties p join public.clients cl on cl.id = p.client_id
    where p.company_id = p_company_id and (p.line1 ilike v_like or p.label ilike v_like)
    order by p.line1
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
    limit v_limit);
end $$;

revoke execute on function public.global_search(uuid, text, integer) from public, anon;
grant execute on function public.global_search(uuid, text, integer) to authenticated;

notify pgrst, 'reload schema';
