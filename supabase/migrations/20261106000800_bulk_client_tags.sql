-- Bulk actions on the Clients list (apps/web/src/features/clients/ClientsPage.tsx): one tag added to
-- or taken off many clients at once. An update from the screen would write each client's whole list
-- of tags as the screen last saw it, dropping any tag added since; this changes each list as it is.
--
-- Runs as the person, so the clients rules decide whose clients it reaches (the owner, office and
-- estimators of that business): another business's clients, and ones they can't change, are left
-- out. It returns the clients it changed. One that already has the tag (or doesn't, to take off)
-- isn't changed. Tags match whatever their case, as the tag field does.
create function public.change_client_tags(p_clients uuid[], p_add text default null, p_remove text default null)
returns setof uuid
language plpgsql set search_path = '' as $$
declare v_tag text := btrim(coalesce(p_add, p_remove, ''));
begin
  if (p_add is null) = (p_remove is null) then
    raise exception 'Add a tag or take one off, one at a time.' using errcode = '22023';
  end if;
  if v_tag = '' or length(v_tag) > 40 then
    raise exception 'A tag is 1 to 40 characters.' using errcode = '22023';
  end if;
  if cardinality(p_clients) > 1000 then
    raise exception 'Change up to 1,000 clients at a time.' using errcode = '22023';
  end if;
  return query
  with changed as (
    update public.clients c
    set tags = case when p_add is not null then c.tags || v_tag
      else array(select u.t from unnest(c.tags) with ordinality u (t, n) where lower(u.t) <> lower(v_tag) order by u.n) end
    where c.id = any (p_clients)
      and exists (select 1 from unnest(c.tags) u (t) where lower(u.t) = lower(v_tag)) = (p_remove is not null)
    returning c.id
  )
  select changed.id from changed;
end $$;
revoke execute on function public.change_client_tags(uuid[], text, text) from public, anon;
grant execute on function public.change_client_tags(uuid[], text, text) to authenticated;

notify pgrst, 'reload schema';
