-- Database tests for Team chat in the field: voice notes' words (the server's transcripts), a message
-- sent twice with the same id, status (by hand and from the clock), scheduled messages and reminders.
-- Each table is read only by whom it's for, and the server sends scheduled messages as their author,
-- so a mention is judged as if they sent it. Run with scripts/test-db.sh.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tcf;
grant usage on schema tcf to authenticated, service_role;
create function tcf.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tcf.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tcf to authenticated, service_role;

-- Owen owns Fern Paving; Ola is office, Lee leads North crew, Nia is on North, Sid is on South.
-- Vic owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('f1e1d000-0000-0000-0000-000000000001', 'owen@fern.test', '{"full_name": "Owen Fern"}'),
  ('f1e1d000-0000-0000-0000-000000000002', 'ola@fern.test', '{"full_name": "Ola Office"}'),
  ('f1e1d000-0000-0000-0000-000000000003', 'lee@fern.test', '{"full_name": "Lee Lead"}'),
  ('f1e1d000-0000-0000-0000-000000000004', 'nia@fern.test', '{"full_name": "Nia North"}'),
  ('f1e1d000-0000-0000-0000-000000000005', 'sid@fern.test', '{"full_name": "Sid South"}'),
  ('f1e1d000-0000-0000-0000-000000000009', 'vic@other.test', '{"full_name": "Vic Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Other Lawn', 'general') as other \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Fern Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'f1e1d000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'f1e1d000-0000-0000-0000-000000000003', 'crew_lead'),
  (:'co', 'f1e1d000-0000-0000-0000-000000000004', 'field_crew'),
  (:'co', 'f1e1d000-0000-0000-0000-000000000005', 'field_crew');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'North Crew', 'f1e1d000-0000-0000-0000-000000000003') returning id as north \gset
insert into public.crews (company_id, name) values (:'co', 'South Crew') returning id as south \gset
insert into public.crew_members (company_id, crew_id, user_id) values
  (:'co', :'north', 'f1e1d000-0000-0000-0000-000000000004'),
  (:'co', :'south', 'f1e1d000-0000-0000-0000-000000000005');
select public.chat_set_enabled(:'co', true);
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
select id as ann from public.chat_channels where company_id = :'co' and kind = 'announcement' \gset
select id as north_ch from public.chat_channels where company_id = :'co' and name = 'north-crew' \gset
commit;

-- ===== Voice notes' words =====================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, attachments)
values (:'co', :'north_ch', 'f1e1d000-0000-0000-0000-000000000004', jsonb_build_array(jsonb_build_object(
  'path', :'co' || '/chat/' || :'north_ch' || '/2b7e1516-28ae-4d2a-a6c1-0d0b1a2c3d4e.webm', 'name', 'Voice note', 'type', 'audio/webm', 'duration', 12, 'words', 'gate is open')))
returning id as voice_msg \gset
select tcf.check((select attachments -> 0 ->> 'words' = 'gate is open' from public.chat_messages where id = :'voice_msg'), 'a voice note goes with the words the phone heard');
select tcf.expect_error(format('insert into public.chat_transcripts (message_id, path, words) values (%L, %L, %L)', :'voice_msg', :'co' || '/chat/' || :'north_ch' || '/2b7e1516-28ae-4d2a-a6c1-0d0b1a2c3d4e.webm', 'made up'),
  'nobody but the server writes a transcript');
commit;

-- The server (no one signed in) keeps its words, only for a voice note that's on the message.
insert into public.chat_transcripts (message_id, path, words) values (:'voice_msg', :'co' || '/chat/' || :'north_ch' || '/2b7e1516-28ae-4d2a-a6c1-0d0b1a2c3d4e.webm', 'The gate is open, the dog is inside.');
select tcf.check((select channel_id = :'north_ch' and company_id = :'co' from public.chat_transcripts where message_id = :'voice_msg'), 'the server''s words go with the message''s channel');
select tcf.expect_error(format('insert into public.chat_transcripts (message_id, path, words) values (%L, %L, %L)', :'voice_msg', :'co' || '/chat/' || :'north_ch' || '/00000000-0000-4000-8000-000000000000.webm', 'other'),
  'a transcript is only of a voice note on its message');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tcf.check((select count(*) from public.chat_transcripts where message_id = :'voice_msg') = 1, 'Lee (North''s lead) reads the words');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tcf.check((select count(*) from public.chat_transcripts) = 0, 'Sid (South) doesn''t read North''s words');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select tcf.check((select count(*) from public.chat_transcripts) = 0, 'nor does another business');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
update public.chat_messages set deleted_at = now() where id = :'voice_msg';
commit;
select tcf.check((select count(*) from public.chat_transcripts where message_id = :'voice_msg') = 0, 'deleting the message takes its words with it');
