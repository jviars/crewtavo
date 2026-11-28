-- Database tests for Team chat's new parts fitted together (20261129104000_chat_together.sql): a
-- notification about a message with no words says what it carried; a notification's words lose
-- their Markdown marks; a direct conversation is "a conversation" in words about it; and search finds
-- a voice note by the words the server wrote down for it, only for people who can read it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema ctg;
grant usage on schema ctg to authenticated, service_role;
create function ctg.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema ctg to authenticated, service_role;

-- What a message carried, when it has no words.
select ctg.check(private.chat_files_line('[{"path": "c/chat/x/a.webm"}]') = 'Sent a voice note', 'a voice note says so');
select ctg.check(private.chat_files_line('[{"path": "c/chat/x/a.m4a"}, {"path": "c/chat/x/b.jpg"}]') = 'Sent a voice note', 'a voice note with a photo is a voice note');
select ctg.check(private.chat_files_line('[{"path": "c/chat/x/a.pdf"}]') = 'Sent a file', 'a document is a file');
select ctg.check(private.chat_files_line('[{"path": "c/chat/x/a.jpg"}]') = 'Sent a photo', 'a photo is a photo');

-- Ivy owns Juniper Lawn; Noel is office, Quinn is on the field crew. Uma owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c7e10000-0000-0000-0000-000000000001', 'ivy@juniper.test', '{"full_name": "Ivy Juniper"}'),
  ('c7e10000-0000-0000-0000-000000000002', 'noel@juniper.test', '{"full_name": "Noel Barrow"}'),
  ('c7e10000-0000-0000-0000-000000000003', 'quinn@juniper.test', '{"full_name": "Quinn Archer"}'),
  ('c7e10000-0000-0000-0000-000000000009', 'uma@other.test', '{"full_name": "Uma Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7e10000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Juniper Lawn', 'landscaping') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c7e10000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'c7e10000-0000-0000-0000-000000000003', 'field_crew');
select public.chat_set_enabled(:'co', true);
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
commit;

-- Words without their marks.
select ctg.check(private.chat_plain(:'co', E'**Gate code** is `4411`, ~~not 4410~~\n> call [the office](https://example.com/x) first\n## Notes') =
  E'Gate code is 4411, not 4410\ncall the office first\nNotes', 'a notification''s words lose bold, code, strikethrough, quote, heading and link marks');
select ctg.check(private.chat_plain(:'co', 'snake_case and 2 * 3 stay as typed') = 'snake_case and 2 * 3 stay as typed', 'what only looks like formatting stays');

-- Noel sends Quinn a voice note in a direct conversation, and a file.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7e10000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.chat_start_direct(:'co', array['c7e10000-0000-0000-0000-000000000003']::uuid[]) as dm \gset
insert into public.chat_messages (company_id, channel_id, author_id, body, attachments)
values (:'co', :'dm', 'c7e10000-0000-0000-0000-000000000002', '',
  format('[{"path": "%s/chat/%s/c7e10000-0000-0000-0000-0000000000a1.webm", "name": "Voice note", "type": "audio/webm"}]', :'co', :'dm')::jsonb)
returning id as voice \gset
insert into public.chat_messages (company_id, channel_id, author_id, body, attachments)
values (:'co', :'dm', 'c7e10000-0000-0000-0000-000000000002', '',
  format('[{"path": "%s/chat/%s/c7e10000-0000-0000-0000-0000000000a2.pdf", "name": "Site plan.pdf", "type": "application/pdf"}]', :'co', :'dm')::jsonb);
insert into public.chat_messages (company_id, channel_id, author_id, body)
values (:'co', :'dm', 'c7e10000-0000-0000-0000-000000000002', E'**Bring** the `trimmer`');
commit;

select ctg.check((select count(*) = 1 from public.notifications where user_id = 'c7e10000-0000-0000-0000-000000000003' and kind = 'chat' and body = 'Sent a voice note'),
  'a voice note''s notification says it''s a voice note');
select ctg.check((select count(*) = 1 from public.notifications where user_id = 'c7e10000-0000-0000-0000-000000000003' and kind = 'chat' and body = 'Sent a file'),
  'a file''s notification says it''s a file');
select ctg.check((select count(*) = 1 from public.notifications where user_id = 'c7e10000-0000-0000-0000-000000000003' and kind = 'chat' and body = 'Bring the trimmer'),
  'a notification''s words come without their marks');
select ctg.check(not exists (select 1 from public.notifications where user_id = 'c7e10000-0000-0000-0000-000000000003' and body = 'Sent a photo'),
  'nothing about a voice note or a file says photo');
select ctg.check(private.chat_where(:'dm') = 'a conversation', 'a direct conversation is "a conversation" in words about it');
select ctg.check(private.chat_where(:'general') = '#general', 'a text channel is still #name');

-- The server writes down the voice note's words; search finds it by them.
begin;
set local role service_role;
insert into public.chat_transcripts (company_id, channel_id, message_id, path, words)
values (:'co', :'dm', :'voice', format('%s/chat/%s/c7e10000-0000-0000-0000-0000000000a1.webm', :'co', :'dm'), 'Meet at the Willowbrook property after lunch');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7e10000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select ctg.check((select count(*) = 1 from public.chat_search(:'co', 'willowbrook') s where s.id = :'voice'), 'search finds a voice note by the server''s words');
select ctg.check((select count(*) = 1 from public.chat_search(:'co', 'willow') s where s.id = :'voice'), 'and by the start of a word in them');
select ctg.check((select count(*) = 1 from public.chat_search(:'co', 'brook') s where s.id = :'voice'), 'and inside a word');
commit;

-- Ivy owns the business, but the conversation is Noel's and Quinn's: she finds nothing in it.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7e10000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select ctg.check((select count(*) = 0 from public.chat_search(:'co', 'willowbrook')), 'the owner doesn''t find words in other people''s conversations');
commit;

-- Uma, in another business, finds nothing either.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7e10000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select ctg.check((select count(*) = 0 from public.chat_search(:'co', 'willowbrook')), 'another business finds nothing');
commit;
