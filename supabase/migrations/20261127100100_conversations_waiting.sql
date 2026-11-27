-- Messages: what waits on the office, after 20261125100210_conversations_done.sql.
--
--   * History doesn't wait. That migration counted every conversation whose latest message is the
--     client's, back to the first one ever filed, so the Messages dot lit for a "Thanks!" from last
--     spring. Conversations whose latest message was already more than three days old are marked
--     done here (private.backfill_conversations_done), the same three days bringing in Quo's
--     history allows (apps/api/src/services/quoImport.ts). From here on a conversation waits until
--     it's answered or marked done, however long that takes.
--   * The dot and the list agree. public.waiting_conversation_messages gives each waiting
--     conversation's latest message, the Messages list shows them all (it otherwise reads the
--     newest 500 messages only, so an older one had no row and no Done button), and the dot counts
--     that same list.
--   * It's looked up a client at a time through messages_client_idx (company, client, newest
--     first): one short read per client, where it used to read every message the company has, each
--     minute, for each open tab.

-- Each waiting conversation's latest message: of those this person can see, it's the client's, and
-- came after any done mark.
create function public.waiting_conversation_messages(p_company uuid) returns setof public.messages
language sql stable security invoker set search_path = '' as $$
  select latest.*
  from public.clients c
  cross join lateral (
    select m.*
    from public.messages m
    where m.company_id = c.company_id and m.client_id = c.id and m.channel in ('sms', 'email', 'note', 'call')
    order by m.created_at desc
    limit 1
  ) latest
  left join public.conversations_done d on d.client_id = c.id
  where c.company_id = p_company and latest.direction = 'in' and (d.done_at is null or d.done_at < latest.created_at)
$$;
revoke execute on function public.waiting_conversation_messages(uuid) from public, anon;
grant execute on function public.waiting_conversation_messages(uuid) to authenticated;

-- How many there are, for the dot on the Messages button. The release before this one asks the same
-- way while an update is under way.
create or replace function public.waiting_conversations(p_company uuid) returns integer
language sql stable security invoker set search_path = '' as $$
  select count(*)::integer from public.waiting_conversation_messages(p_company)
$$;

-- Conversations whose latest message is the client's, more than three days old, with no done mark
-- since: marked done now, by nobody. A mark someone made after that message stays as it is. Says how
-- many were marked. It writes rows of conversations_done only, so the app carries on meanwhile.
create function private.backfill_conversations_done() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.conversations_done (client_id, company_id)
  select latest.client_id, latest.company_id
  from (
    select distinct on (m.company_id, m.client_id) m.company_id, m.client_id, m.direction, m.created_at
    from public.messages m
    where m.client_id is not null and m.channel in ('sms', 'email', 'note', 'call')
    order by m.company_id, m.client_id, m.created_at desc
  ) latest
  join public.clients c on c.company_id = latest.company_id and c.id = latest.client_id
  left join public.conversations_done d on d.client_id = latest.client_id
  where latest.direction = 'in' and latest.created_at < now() - interval '3 days'
    and (d.done_at is null or d.done_at < latest.created_at)
  -- A client someone deletes at this moment is left out, not marked and then refused.
  for key share of c
  -- The table's trigger dates the mark now and names whoever is signed in: nobody, here.
  on conflict (client_id) do update set done_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.backfill_conversations_done() from public;
select private.backfill_conversations_done();

notify pgrst, 'reload schema';
