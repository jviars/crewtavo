-- Resetting one client's links. A quote, invoice or Client Hub link works without an account, and
-- each one leads to the client's whole Hub, so a link that was forwarded (to a bookkeeper, a tenant)
-- kept opening everything of that client's until it expired. The office can now end them for one
-- client: "Reset this client's links" on the client's page sets the time here, and the server
-- refuses any quote, invoice or client link for that client made before it (apps/api lib/links.ts
-- linksReplaced). Null, as it is for every client today, means nothing was reset: links already out
-- keep opening until someone asks. Unsubscribe, review and referral links never look at it.

alter table public.clients add column links_reset_at timestamptz;
comment on column public.clients.links_reset_at is
  'When the office last reset this client''s links: quote, invoice and Client Hub links made before it no longer open. Null: never';

-- Nobody signed in sets it or clears it: the server does, after checking who asked (POST
-- /clients/:id/links/reset), with the clock that stamps the links. Otherwise anyone who may edit a
-- client could bring ended links back by clearing it. A merge may move it (below).
create function private.client_links_reset_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) = 'authenticated' and not (tg_op = 'UPDATE' and private.merging_clients(null, new.id)) then
    if tg_op = 'UPDATE' then
      new.links_reset_at := old.links_reset_at;
    else
      new.links_reset_at := null;
    end if;
  end if;
  return new;
end $$;
create trigger client_links_reset_guard before insert or update of links_reset_at on public.clients
  for each row execute function private.client_links_reset_guard();

-- A merge moves the merged client's quotes and invoices to the kept one, so their links now open
-- the kept client's Hub. The kept client takes the later of the two resets, so links ended for
-- either stay ended. merge_clients names the pair in crewtavo.merge while it deletes the merged one.
create function private.client_links_reset_follows_merge() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_merge text := coalesce(current_setting('crewtavo.merge', true), '');
begin
  if old.links_reset_at is not null and v_merge like old.id::text || '>%' then
    update public.clients c set links_reset_at = greatest(c.links_reset_at, old.links_reset_at)
    where c.company_id = old.company_id and c.id = split_part(v_merge, '>', 2)::uuid
      and c.links_reset_at is distinct from greatest(c.links_reset_at, old.links_reset_at);
  end if;
  return old;
end $$;
create trigger client_links_reset_follows_merge before delete on public.clients
  for each row execute function private.client_links_reset_follows_merge();

revoke all on function private.client_links_reset_guard(), private.client_links_reset_follows_merge() from public;
