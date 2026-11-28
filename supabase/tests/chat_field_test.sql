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

-- ===== A message sent twice with the id the phone chose =======================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.chat_messages (id, company_id, channel_id, author_id, body)
values ('5e5e5e5e-0000-4000-8000-000000000001', :'co', :'north_ch', 'f1e1d000-0000-0000-0000-000000000004', 'Done at Elm St <@f1e1d000-0000-0000-0000-000000000003>');
select tcf.expect_error(format('insert into public.chat_messages (id, company_id, channel_id, author_id, body) values (%L, %L, %L, %L, %L)',
  '5e5e5e5e-0000-4000-8000-000000000001', :'co', :'north_ch', 'f1e1d000-0000-0000-0000-000000000004', 'Done at Elm St <@f1e1d000-0000-0000-0000-000000000003>'), 'the same message sent again is turned away by its id');
commit;
select tcf.check((select count(*) from public.chat_messages where body like 'Done at Elm St%') = 1, 'so it''s there once');
select tcf.check((select count(*) from public.notifications where link like '%5e5e5e5e-0000-4000-8000-000000000001') = 1, 'and Lee hears about it once');

-- ===== Status ===================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.chat_statuses (company_id, user_id, kind) values (:'co', 'f1e1d000-0000-0000-0000-000000000001', 'office');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.chat_statuses (company_id, user_id, kind, until) values (:'co', 'f1e1d000-0000-0000-0000-000000000004', 'off', now() + interval '8 hours');
select tcf.check((select kind = 'off' from public.chat_statuses where user_id = 'f1e1d000-0000-0000-0000-000000000004'), 'Nia sets her own status');
select tcf.expect_error(format('insert into public.chat_statuses (company_id, user_id, kind) values (%L, %L, %L)', :'co', 'f1e1d000-0000-0000-0000-000000000003', 'busy'), 'but not Lee''s');
update public.chat_statuses set kind = 'busy' where user_id = 'f1e1d000-0000-0000-0000-000000000001';
delete from public.chat_statuses where user_id = 'f1e1d000-0000-0000-0000-000000000001';
select tcf.check((select kind = 'office' from public.chat_statuses where user_id = 'f1e1d000-0000-0000-0000-000000000001'), 'nor changes or clears anyone else''s');
select tcf.expect_error(format('insert into public.chat_statuses (company_id, user_id, kind) values (%L, %L, %L) on conflict (company_id, user_id) do update set kind = excluded.kind', :'co', 'f1e1d000-0000-0000-0000-000000000004', 'custom'), 'her own words need words');
select tcf.expect_error(format('update public.chat_statuses set kind = %L, words = %L where user_id = %L', 'custom', repeat('x', 61), 'f1e1d000-0000-0000-0000-000000000004'), 'up to 60 characters of them');
select tcf.expect_error(format('update public.chat_statuses set until = now() - interval %L where user_id = %L', '1 hour', 'f1e1d000-0000-0000-0000-000000000004'), 'and a status clears in the future');
commit;

-- Lee's clock runs on a drive; Nia's on a visit, though she set Off today by hand.
insert into public.time_entries (company_id, user_id, category, started_at) values
  (:'co', 'f1e1d000-0000-0000-0000-000000000003', 'drive', now() - interval '20 minutes'),
  (:'co', 'f1e1d000-0000-0000-0000-000000000004', 'visit', now() - interval '1 hour');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tcf.check((select count(*) from public.chat_statuses where company_id = :'co') = 2, 'Sid reads the team''s statuses');
select tcf.check((select kind = 'driving' and by_clock from public.chat_statuses(:'co') where user_id = 'f1e1d000-0000-0000-0000-000000000003'), 'Lee on the clock for a drive is Driving');
select tcf.check((select kind = 'off' and not by_clock from public.chat_statuses(:'co') where user_id = 'f1e1d000-0000-0000-0000-000000000004'), 'a status set by hand comes before the clock''s');
select tcf.check((select count(*) from public.chat_statuses(:'co') where user_id = 'f1e1d000-0000-0000-0000-000000000005') = 0, 'nobody else has one');
select tcf.check((select count(*) from public.time_entries where user_id = 'f1e1d000-0000-0000-0000-000000000003') = 0, 'and Sid still can''t read Lee''s time');
commit;

update public.time_entries set ended_at = now() where user_id = 'f1e1d000-0000-0000-0000-000000000003';
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', 'f1e1d000-0000-0000-0000-000000000003', 'break', now() - interval '1 minute');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tcf.check((select kind = 'break' from public.chat_statuses(:'co') where user_id = 'f1e1d000-0000-0000-0000-000000000003'), 'Lee''s break is On a break');
update public.chat_statuses set until = now() + interval '1 second' where user_id = 'f1e1d000-0000-0000-0000-000000000004';
commit;
select pg_sleep(1.2);
update public.time_entries set ended_at = now() where user_id = 'f1e1d000-0000-0000-0000-000000000003';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tcf.check((select kind = 'on_job' and by_clock from public.chat_statuses(:'co') where user_id = 'f1e1d000-0000-0000-0000-000000000004'), 'once Nia''s own status clears, her visit''s clock says On a job');
select tcf.check((select count(*) from public.chat_statuses(:'co') where user_id = 'f1e1d000-0000-0000-0000-000000000003') = 0, 'and Lee, clocked out, has none');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select tcf.check((select count(*) from public.chat_statuses) = 0 and (select count(*) from public.chat_statuses(:'co')) = 0, 'another business sees no one''s status');
select tcf.expect_error(format('insert into public.chat_statuses (company_id, user_id, kind) values (%L, %L, %L)', :'co', 'f1e1d000-0000-0000-0000-000000000009', 'busy'), 'or sets one there');
commit;
