-- Ask (AI answers from guides) finds guides with any of a question's words, best matches first.
-- "How long does sealer need to dry before cars drive on it" rarely has every word in one guide,
-- so search_sops gets p_any; the Search box leaves it off and still needs every word.

drop function public.search_sops(uuid, text, integer);

create function public.search_sops(p_company uuid, p_query text, p_limit integer default 10, p_any boolean default false)
returns table (
  id uuid, title text, category text, snippet text, body_text text,
  required boolean, revision integer, acknowledged boolean, rank real
)
language sql stable security invoker set search_path = '' as $$
  -- Any word: the question's words without stop words ("how", "does", "on"), joined with OR. The
  -- text form quotes each word, and a word never holds " & ", so the swap only changes operators.
  with q as (
    select case when p_any
      then replace(plainto_tsquery('english', p_query)::text, ' & ', ' | ')::tsquery
      else websearch_to_tsquery('english', p_query)
    end as tsq
  )
  select p.id, p.title, c.name,
    ts_headline('english', p.body_text, q.tsq, 'StartSel="",StopSel="",MaxWords=30,MinWords=12,MaxFragments=1'),
    p.body_text, p.required, p.revision,
    exists (select 1 from public.sop_acknowledgements a
            where a.page_id = p.id and a.revision = p.revision and a.user_id = (select auth.uid())),
    ts_rank(p.search, q.tsq)
  from public.sop_pages p
  cross join q
  left join public.sop_categories c on c.id = p.category_id
  where p.company_id = p_company and p.search @@ q.tsq
  order by ts_rank(p.search, q.tsq) desc
  limit least(greatest(p_limit, 1), 50)
$$;
revoke execute on function public.search_sops(uuid, text, integer, boolean) from public, anon;
grant execute on function public.search_sops(uuid, text, integer, boolean) to authenticated;

notify pgrst, 'reload schema';
