-- Database tests for threads (20261129101100_chat_threads.sql): a reply goes under a top-level,
-- not-deleted message in the same channel and stays there; the root's author, repliers and anyone
-- mentioned follow it and hear of new replies; thread replies stay out of the channel's counts unless
-- also sent there, while a mention in one still counts; reading and following are each person's own;
-- and nobody who can't see the channel gets anything of its threads.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tth;
grant usage on schema tth to authenticated, service_role;
create function tth.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tth.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tth to authenticated, service_role;

-- Jo owns Oscar Lawn; Dana is office, Mateo leads a crew, Toby and Sid are field crew.
insert into auth.users (id, email, raw_user_meta_data) values
  ('dc020000-0000-0000-0000-000000000001', 'jo@oscar.test', '{"full_name": "Jo Quinn"}'),
  ('dc020000-0000-0000-0000-000000000003', 'dana@oscar.test', '{"full_name": "Dana Hale"}'),
  ('dc020000-0000-0000-0000-000000000004', 'mateo@oscar.test', '{"full_name": "Mateo Cruz"}'),
  ('dc020000-0000-0000-0000-000000000005', 'toby@oscar.test', '{"full_name": "Toby Lane"}'),
  ('dc020000-0000-0000-0000-000000000006', 'sid@oscar.test', '{"full_name": "Sid Moss"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Oscar Lawn', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'dc020000-0000-0000-0000-000000000003', 'office'),
  (:'co', 'dc020000-0000-0000-0000-000000000004', 'crew_lead'),
  (:'co', 'dc020000-0000-0000-0000-000000000005', 'field_crew'),
  (:'co', 'dc020000-0000-0000-0000-000000000006', 'field_crew');
select tth.check(public.chat_set_enabled(:'co', true), 'the owner turns chat on');
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
select id as office_ch from public.chat_channels where company_id = :'co' and name = 'office' \gset
commit;

-- ===== Replying in a thread =================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'dc020000-0000-0000-0000-000000000003', 'Who can cover Saturday?') returning id as root \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'office_ch', 'dc020000-0000-0000-0000-000000000003', 'Quotes due Friday') returning id as office_root \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'dc020000-0000-0000-0000-000000000003', 'Oops') returning id as gone \gset
update public.chat_messages set deleted_at = now() where id = :'gone';
insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (:'co', :'office_ch', 'dc020000-0000-0000-0000-000000000003', 'Mine are in', :'office_root');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (:'co', :'general', 'dc020000-0000-0000-0000-000000000005', 'I can, after 9', :'root') returning id as r1 \gset
select tth.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (%L, %L, %L, %L, %L)', :'co', :'general', 'dc020000-0000-0000-0000-000000000005', 'Nested', :'r1'),
  'a reply in a thread can''t start a thread of its own');
select tth.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (%L, %L, %L, %L, %L)', :'co', :'general', 'dc020000-0000-0000-0000-000000000005', 'Gone', :'gone'),
  'nor go under a deleted message');
select tth.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (%L, %L, %L, %L, %L)', :'co', :'general', 'dc020000-0000-0000-0000-000000000005', 'Elsewhere', :'office_root'),
  'nor under a message in another channel');
select tth.expect_error(format('update public.chat_messages set thread_root = null where id = %L', :'r1'), 'a reply can''t be moved out of its thread');
select tth.expect_error(format('update public.chat_messages set also_in_channel = true where id = %L', :'r1'), 'or sent to the channel afterwards');
insert into public.chat_messages (company_id, channel_id, author_id, body, also_in_channel) values (:'co', :'general', 'dc020000-0000-0000-0000-000000000005', 'Plain message', true) returning id as plain \gset
select tth.check((select not also_in_channel from public.chat_messages where id = :'plain'), '"also send to the channel" means nothing outside a thread');
commit;

select tth.check((select count(*) from public.chat_thread_follows where root_id = :'root' and following) = 2, 'the root''s author and the replier follow the thread');
select tth.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc020000-0000-0000-0000-000000000003' and title = 'Toby Lane replied in a thread in #general'
  and link = '/chat/' || :'general' || '?thread=' || :'root' || '&message=' || :'r1') = 1, 'Dana is told of the reply, and it opens the thread');
select tth.check((select count(*) from public.notifications where company_id = :'co' and kind = 'chat' and title like 'Toby Lane replied in a thread%') = 1, 'and nobody else is');

-- ===== Counts: out of the channel's, into the threads' ========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tth.check((select unread from public.chat_overview(:'co') where id = :'general') = 2, 'for Mateo the thread reply isn''t one of #general''s unread (the root and Toby''s plain message are)');
select tth.check((select count(*) from public.chat_threads(:'co')) = 0, 'and he follows no threads');
select tth.check((select replies = 1 and people = array['dc020000-0000-0000-0000-000000000005']::uuid[] from public.chat_thread_summaries(array[:'root']::uuid[])), 'the root says 1 reply, from Toby');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tth.check((select unread from public.chat_overview(:'co') where id = :'general') = 1, 'for Dana #general has only Toby''s plain message new');
select tth.check((select unread = 1 and mentions = 0 and replies = 1 from public.chat_threads(:'co') where root_id = :'root'), 'her thread has a new reply');
select tth.check((select unread = 1 and mentions = 0 from public.chat_thread_counts(:'co')), 'one thread with new replies');
commit;

-- A mention in a thread: the person follows it, and it counts as a mention in the threads.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (:'co', :'general', 'dc020000-0000-0000-0000-000000000005', '<@dc020000-0000-0000-0000-000000000004> can you bring the trimmer?', :'root') returning id as r2 \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tth.check((select unread = 1 and mentions = 1 from public.chat_threads(:'co') where root_id = :'root'), 'Mateo now follows the thread, with its mention of him new');
select tth.check((select mentions from public.chat_overview(:'co') where id = :'general') = 0, 'the mention isn''t counted again in #general');
select tth.check((select mentions = 1 from public.chat_thread_counts(:'co')), 'but counts in the threads'' mentions');
select public.chat_mark_read(:'general');
select tth.check((select read_at is null from public.notifications where company_id = :'co' and user_id = 'dc020000-0000-0000-0000-000000000004' and title = 'Toby Lane mentioned you in #general'),
  'reading the channel leaves the thread''s notification');
select public.chat_thread_read(:'root');
select tth.check((select unread = 0 and mentions = 0 from public.chat_threads(:'co') where root_id = :'root'), 'reading the thread clears it');
select tth.check((select read_at is not null from public.notifications where company_id = :'co' and user_id = 'dc020000-0000-0000-0000-000000000004' and title = 'Toby Lane mentioned you in #general'), 'and its notification');
commit;

select tth.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc020000-0000-0000-0000-000000000003' and title = 'Toby Lane replied in a thread in #general') = 2, 'Dana hears of the second reply too');

-- Also sent to the channel: it counts there like any message.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root, also_in_channel) values (:'co', :'general', 'dc020000-0000-0000-0000-000000000006', 'I''m off Saturday, sorry', :'root', true) returning id as r3 \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tth.check((select unread from public.chat_overview(:'co') where id = :'general') = 1, 'a reply also sent to the channel is new in #general');
select tth.check((select unread = 1 and mentions = 0 from public.chat_threads(:'co') where root_id = :'root'), 'and in the thread');
commit;
select tth.check((select link = '/chat/' || :'general' || '?message=' || :'r3' from public.notifications where company_id = :'co' and user_id = 'dc020000-0000-0000-0000-000000000003' and body = 'I''m off Saturday, sorry'),
  'its notification opens it in the channel');

-- ===== Following and not ======================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tth.check(not public.chat_follow(:'root', false), 'Dana stops following her thread');
select tth.check(not exists (select 1 from public.chat_threads(:'co') where root_id = :'root'), 'it''s out of her threads');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (:'co', :'general', 'dc020000-0000-0000-0000-000000000005', 'Sorted, Mateo has it', :'root');
commit;
select tth.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc020000-0000-0000-0000-000000000003' and body = 'Sorted, Mateo has it') = 0, 'and she isn''t told of new replies');
select tth.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc020000-0000-0000-0000-000000000004' and body = 'Sorted, Mateo has it') = 1, 'while Mateo, who follows, is');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tth.check(public.chat_follow(:'root', true), 'she follows it again');
select tth.check((select unread from public.chat_threads(:'co') where root_id = :'root') >= 1, 'and it''s back with what''s new');
-- Following is each person's own: someone else's row isn't hers to read.
select tth.check((select count(*) from public.chat_thread_follows where root_id = :'root') = 1, 'she sees only her own following');
commit;

-- ===== People who can't see the channel get nothing ==========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tth.check((select count(*) from public.chat_thread_summaries(array[:'office_root']::uuid[])) = 0, 'Toby can''t count replies in the office''s threads');
select tth.expect_error(format('select public.chat_thread_read(%L)', :'office_root'), 'or read one');
select tth.expect_error(format('select public.chat_follow(%L, true)', :'office_root'), 'or follow one');
select tth.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (%L, %L, %L, %L, %L)', :'co', :'office_ch', 'dc020000-0000-0000-0000-000000000005', 'Me too', :'office_root'), 'or reply in one');
commit;

-- ===== In a direct conversation, everyone in it follows ======================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.chat_start_direct(:'co', array['dc020000-0000-0000-0000-000000000004', 'dc020000-0000-0000-0000-000000000006']::uuid[]) as dm \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm', 'dc020000-0000-0000-0000-000000000003', 'Truck 3 inspection') returning id as dm_root \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (:'co', :'dm', 'dc020000-0000-0000-0000-000000000004', 'Booked for Tuesday', :'dm_root');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select tth.check((select unread = 1 and mentions = 1 from public.chat_threads(:'co') where root_id = :'dm_root'), 'Sid follows the conversation''s thread, and its new reply is for him');
select tth.check((select unread from public.chat_overview(:'co') where id = :'dm') = 1, 'the conversation itself counts only the root');
commit;
select tth.check((select count(*) from public.notifications where company_id = :'co' and kind = 'chat' and title = 'Mateo Cruz messaged you and 1 other' and link like '/chat/' || :'dm' || '?thread=' || :'dm_root' || '&%') = 2,
  'a reply in a conversation''s thread tells everyone else in it, and opens the thread');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc020000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tth.check((select count(*) from public.chat_thread_summaries(array[:'dm_root']::uuid[])) = 0, 'the owner can''t see into the conversation''s threads');
select tth.expect_error(format('select public.chat_thread_read(%L)', :'dm_root'), 'or read one');
commit;
