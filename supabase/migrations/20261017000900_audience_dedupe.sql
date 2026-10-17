-- Campaign audiences: de-duplicate on the trimmed, lower-cased address (the value that's returned
-- and stored), so "Ana@x.com " and "ana@x.com" are one recipient rather than a duplicate-key error.
create or replace function public.campaign_audience(p_company_id uuid, p_audience jsonb)
returns table (client_id uuid, display_name text, email text)
language sql stable security invoker set search_path = '' as $$
  select distinct on (lower(trim(c.email))) c.id, c.display_name, lower(trim(c.email))
  from public.clients c
  where c.company_id = p_company_id
    and c.email is not null
    and trim(c.email) ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and not c.marketing_opt_out
    and (coalesce(jsonb_array_length(p_audience -> 'statuses'), 0) = 0
         or c.status in (select jsonb_array_elements_text(p_audience -> 'statuses')))
    and (coalesce(jsonb_array_length(p_audience -> 'tags_any'), 0) = 0
         or c.tags && array(select jsonb_array_elements_text(p_audience -> 'tags_any')))
    and not (c.tags && array(select jsonb_array_elements_text(coalesce(p_audience -> 'tags_none', '[]'))))
    and (coalesce((p_audience ->> 'no_visit_days')::integer, 0) <= 0 or not exists (
         select 1 from public.visits v join public.jobs j on j.id = v.job_id
         where j.client_id = c.id and v.status = 'completed'
           and v.completed_at > now() - make_interval(days => (p_audience ->> 'no_visit_days')::integer)))
  order by lower(trim(c.email)), c.created_at
$$;
