-- The copies the team keeps of what was sent to a client hold no working link to the client's page.
--
-- A Client Hub link opens a client's quote, invoice or home without a sign-in, as the client, for
-- months. The copy of each email or text kept on the client's timeline held one, and so did the
-- notes, tasks and notices an Automations rule writes. Everyone who reads those would hold the link
-- too: crews read a visit's messages and notes and see tasks on the schedule, and an AI assistant
-- connected as someone, even one that only looks things up, reads what they do. Now the server
-- writes "[Client Hub link]" there in its place (apps/api/src/lib/links.ts KEPT_LINK), and this
-- does the same to the copies already kept. The client's own emails and texts are as they were.
--
-- supabase/tests/team_copies_keep_no_client_links_test.sql covers it.

/**
 * Puts "[Client Hub link]" in place of each Client Hub link (the app's address, /hub/, and a token
 * the server signed: a JSON body and a 43-character signature) in the copies the team reads: what
 * was sent to a client and the notes on their timeline (not what a client sent in), the notices a
 * rule sent the team, and the tasks it put on the schedule. How many it changed. The server's alone.
 */
create function private.keep_no_client_links() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_link constant text := 'https?://[^[:space:]]*/hub/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}(\?[A-Za-z0-9=&_-]*)?';
  v_kept constant text := '[Client Hub link]';
  v_messages integer;
  v_notices integer;
  v_tasks integer;
begin
  update public.messages m set body = regexp_replace(m.body, v_link, v_kept, 'g')
  where m.direction <> 'in' and m.body ~ v_link;
  get diagnostics v_messages = row_count;
  update public.notifications n set title = regexp_replace(n.title, v_link, v_kept, 'g'), body = regexp_replace(n.body, v_link, v_kept, 'g')
  where n.title ~ v_link or n.body ~ v_link;
  get diagnostics v_notices = row_count;
  update public.visits v set title = regexp_replace(v.title, v_link, v_kept, 'g')
  where v.kind = 'task' and v.title ~ v_link;
  get diagnostics v_tasks = row_count;
  return v_messages + v_notices + v_tasks;
end $$;
revoke all on function private.keep_no_client_links() from public;

select private.keep_no_client_links();
