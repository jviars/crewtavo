-- Database tests for 20261127100100_conversations_waiting.sql: conversations that were already old
-- when the Done mark arrived wait on nobody; the Messages dot counts exactly the conversations the
-- list is given (each one's latest message); and only those who answer messages get them.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1127cw;
grant usage on schema t1127cw to anon, authenticated, service_role;
create function t1127cw.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1127cw.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1127cw to anon, authenticated, service_role;

\set owner 'b1127c00-0000-0000-0000-000000000001'
\set crew 'b1127c00-0000-0000-0000-000000000002'
\set other 'b1127c00-0000-0000-0000-000000000003'
insert into auth.users (id, email) values (:'owner', 'wren@hedges.test'), (:'crew', 'cole@hedges.test'), (:'other', 'opal@elsewhere.test');

begin;
set local role authenticated;
select t1127cw.as_user(:'owner');
select public.create_company('Wren Hedges', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ada') returning id as ada \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ben') returning id as ben \gset
insert into public.clients (company_id, display_name) values (:'co', 'Cy') returning id as cy \gset
insert into public.clients (company_id, display_name) values (:'co', 'Dot') returning id as dot \gset
insert into public.clients (company_id, display_name) values (:'co', 'Eve') returning id as eve \gset
insert into public.clients (company_id, display_name) values (:'co', 'Flo') returning id as flo \gset
select t1127cw.as_user(:'other');
select public.create_company('Elsewhere Too', 'general') as co2 \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', :'crew', 'field_crew');

-- As an instance looks when the update arrives:
--   Ada   "Thanks!" last spring, never answered.
--   Ben   texted yesterday, not answered yet.
--   Cy    marked done three weeks ago, wrote again two weeks ago.
--   Dot   wrote last month and was answered.
--   Eve   wrote last month, marked done since.
--   Flo   has no messages.
insert into public.messages (company_id, client_id, channel, direction, body, status, created_at) values
  (:'co', :'ada', 'sms', 'out', 'All set for Friday.', 'sent', now() - interval '200 days 1 hour'),
  (:'co', :'ada', 'sms', 'in', 'Thanks!', 'received', now() - interval '200 days'),
  (:'co', :'ben', 'email', 'in', 'Can you quote the back fence?', 'received', now() - interval '1 day'),
  (:'co', :'cy', 'sms', 'in', 'Great, thanks', 'received', now() - interval '25 days'),
  (:'co', :'cy', 'sms', 'in', 'See you then', 'received', now() - interval '14 days'),
  (:'co', :'dot', 'sms', 'in', 'Is Tuesday OK?', 'received', now() - interval '30 days'),
  (:'co', :'dot', 'email', 'out', 'Tuesday works.', 'sent', now() - interval '29 days'),
  (:'co', :'eve', 'sms', 'in', 'Got it', 'received', now() - interval '30 days');
insert into public.messages (company_id, client_id, channel, direction, body, status, created_at)
  values (:'co', :'ben', 'sms', 'in', 'Also the gate', 'received', now() - interval '20 hours') returning id as ben_latest \gset
-- A mark is always made now (the table's trigger), so the old ones are dated back with triggers off.
insert into public.conversations_done (company_id, client_id) values (:'co', :'cy'), (:'co', :'eve');
set session_replication_role = replica;
update public.conversations_done set done_at = now() - interval '21 days', done_by = :'owner' where client_id = :'cy';
update public.conversations_done set done_at = now() - interval '10 days', done_by = :'owner' where client_id = :'eve';
set session_replication_role = origin;

\o
\echo 'Conversations that were old when the update came'
\o /dev/null

begin;
set local role authenticated;
select t1127cw.as_user(:'owner');
select t1127cw.check(public.waiting_conversations(:'co') = 3, 'before, old history waits too: Ada''s from last spring, Cy''s from two weeks ago, and Ben''s');
commit;

-- Other tests' old conversations are in this database too, so it marks at least these two.
select t1127cw.check(private.backfill_conversations_done() >= 2, 'the update marks the old ones done');
select t1127cw.check((select done_at > now() - interval '1 minute' and done_by is null from public.conversations_done where client_id = :'ada'),
  'Ada''s old "Thanks!" is done, by nobody in particular');
select t1127cw.check((select done_at > now() - interval '1 minute' from public.conversations_done where client_id = :'cy'),
  'Cy''s mark moves past the message that came after it');
select t1127cw.check(not exists (select 1 from public.conversations_done where client_id in (:'ben', :'dot', :'flo')),
  'a recent conversation, an answered one and a client with no messages get no mark');
select t1127cw.check((select done_by = :'owner'::uuid and done_at < now() - interval '9 days' from public.conversations_done where client_id = :'eve'),
  'a mark someone already made stays theirs');
select t1127cw.check(private.backfill_conversations_done() = 0, 'run again, it finds nothing more');
select t1127cw.check(not has_function_privilege('authenticated', 'private.backfill_conversations_done()', 'execute'), 'nobody signed in can run it');

\o
\echo 'What waits, counted and listed'
\o /dev/null

begin;
set local role authenticated;
select t1127cw.as_user(:'owner');
select t1127cw.check(public.waiting_conversations(:'co') = 1, 'after, only the recent conversation waits');
select t1127cw.check((select array_agg(id) = array[:'ben_latest'::uuid] from public.waiting_conversation_messages(:'co')),
  'the list is given that conversation''s latest message');
commit;

-- Ada writes again; Dot writes and is called back.
insert into public.messages (company_id, client_id, channel, direction, body, status) values (:'co', :'ada', 'sms', 'in', 'Are you coming this week?', 'received') returning id as ada_latest \gset
insert into public.messages (company_id, client_id, channel, direction, body, status, created_at) values
  (:'co', :'dot', 'sms', 'in', 'Running late', 'received', now() - interval '2 hours'),
  (:'co', :'dot', 'call', 'out', 'Called back', 'sent', now() - interval '1 hour');
begin;
set local role authenticated;
select t1127cw.as_user(:'owner');
select t1127cw.check((select array_agg(client_id order by created_at desc) = array[:'ada'::uuid, :'ben'::uuid] from public.waiting_conversation_messages(:'co')),
  'a client who writes after the update waits again; one called back doesn''t');
select t1127cw.check(public.waiting_conversations(:'co') = (select count(*) from public.waiting_conversation_messages(:'co')),
  'the dot counts exactly the conversations listed');
insert into public.conversations_done (company_id, client_id) values (:'co', :'ben');
select t1127cw.check((select array_agg(id) = array[:'ada_latest'::uuid] from public.waiting_conversation_messages(:'co')), 'marked done, a conversation leaves the list');
select t1127cw.check(public.waiting_conversations(:'co') = 1, 'and the count');
commit;

\o
\echo 'Who gets them'
\o /dev/null

begin;
set local role authenticated;
select t1127cw.as_user(:'other');
select t1127cw.check((select count(*) from public.waiting_conversation_messages(:'co')) = 0, 'another company is given none of this company''s');
select t1127cw.check(public.waiting_conversations(:'co') = 0, 'and counts none');
commit;
select t1127cw.check(not has_function_privilege('anon', 'public.waiting_conversation_messages(uuid)', 'execute'), 'nobody signed out can ask');

\echo 'All tests of conversations that wait passed.'
