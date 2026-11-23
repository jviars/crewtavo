-- Database tests for 20261123101000_team_copies_keep_no_client_links.sql: the Client Hub links in
-- the copies the team reads (what was sent to a client, notes, a rule's notices and tasks) are put
-- out of reach, and nothing else changes: what a client sent in, other links, and a page called
-- /hub/ somewhere else stay as they are.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1123k;
create function t1123k.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;

\set owner 'b1123c00-0000-0000-0000-000000000001'
\set link 'https://ops.example.com/hub/eyJjIjoiY28iLCJ0IjoiY2xpZW50IiwiaWQiOiJ4IiwidmlhIjoib2ZmaWNlIiwiYXQiOjEsImV4cCI6Mn0.ooZ3FVuHDji7Po_7ZmNsJz2pL086KcG4cXVvPMsXKqQ'
insert into auth.users (id, email, raw_user_meta_data) values (:'owner', 'rae@rae-paving.test', '{"full_name": "Rae Paving"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
select public.create_company('Rae Paving', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Client') returning id as client \gset
commit;

-- What's on record before: a quote's email, an autopay text with its page, a rule's note, a client's
-- own message that pasted their link, a note with someone else's /hub/ page, a notice and a task.
insert into public.messages (company_id, client_id, channel, direction, body) values
  (:'co', :'client', 'email', 'out', format(E'Hi Pat,\n\nHere''s your quote:\n\n%s\n\nThanks', :'link')) returning id as emailed \gset
insert into public.messages (company_id, client_id, channel, direction, body) values
  (:'co', :'client', 'sms', 'out', format('Rae Paving: update your card: %s?view=autopay or pay: %s?tip=1', :'link', :'link')) returning id as texted \gset
insert into public.messages (company_id, client_id, channel, direction, body) values
  (:'co', :'client', 'note', 'internal', format('Sent %s', :'link')) returning id as noted \gset
insert into public.messages (company_id, client_id, channel, direction, body) values
  (:'co', :'client', 'sms', 'in', format('Is this right? %s', :'link')) returning id as theirs \gset
insert into public.messages (company_id, client_id, channel, direction, body) values
  (:'co', :'client', 'note', 'internal', 'Specs at https://supplier.example/hub/index.html and https://ops.example.com/quotes/1') returning id as other \gset
insert into public.notifications (company_id, user_id, kind, title, body, link) values
  (:'co', :'owner', 'quote', 'Quote viewed', format('Pat opened %s', :'link'), '/quotes/1') returning id as notice \gset
insert into public.visits (company_id, kind, title, scheduled_on, status) values
  (:'co', 'task', format('Follow up %s', :'link'), current_date + 1, 'scheduled') returning id as task \gset

select private.keep_no_client_links() as changed \gset

\o
\echo 'The copies the team reads keep no client link'
\o /dev/null

select t1123k.check(:changed = 5, 'five copies changed');
select t1123k.check(body = E'Hi Pat,\n\nHere''s your quote:\n\n[Client Hub link]\n\nThanks', 'an email''s copy keeps its words, without the link') from public.messages where id = :'emailed';
select t1123k.check(body = 'Rae Paving: update your card: [Client Hub link] or pay: [Client Hub link]', 'a text''s copy loses every link, the page it opened included') from public.messages where id = :'texted';
select t1123k.check(body = 'Sent [Client Hub link]', 'and a note''s') from public.messages where id = :'noted';
select t1123k.check(body = 'Pat opened [Client Hub link]', 'and a rule''s notice') from public.notifications where id = :'notice';
select t1123k.check(title = 'Follow up [Client Hub link]', 'and a task on the schedule') from public.visits where id = :'task';
select t1123k.check(body = format('Is this right? %s', :'link'), 'what a client sent in stays as it is') from public.messages where id = :'theirs';
select t1123k.check(body = 'Specs at https://supplier.example/hub/index.html and https://ops.example.com/quotes/1', 'and so do other links') from public.messages where id = :'other';
select t1123k.check(private.keep_no_client_links() = 0, 'a second run changes nothing');

\echo 'All tests of team copies without client links passed.'
