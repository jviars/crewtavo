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

-- ===== Scheduled messages =======================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.chat_scheduled_messages (company_id, channel_id, author_id, body, send_at)
values (:'co', :'north_ch', 'f1e1d000-0000-0000-0000-000000000004', 'Bring the plate compactor tomorrow', now() + interval '1 day') returning id as later_msg \gset
-- Field crew can't ping @everyone in #general: scheduling it doesn't get them round that.
insert into public.chat_scheduled_messages (company_id, channel_id, author_id, body, send_at)
values (:'co', :'general', 'f1e1d000-0000-0000-0000-000000000004', '@everyone the truck leaves at 6', now() + interval '1 second') returning id as nia_everyone \gset
select tcf.check((select count(*) from public.chat_scheduled_messages) = 2, 'Nia schedules messages and sees her own');
select tcf.expect_error(format('insert into public.chat_scheduled_messages (company_id, channel_id, author_id, body, send_at) values (%L, %L, %L, %L, now() + interval %L)', :'co', :'ann', 'f1e1d000-0000-0000-0000-000000000004', 'News', '1 hour'),
  'not where she can''t post');
select tcf.expect_error(format('insert into public.chat_scheduled_messages (company_id, channel_id, author_id, body, send_at) values (%L, %L, %L, %L, now() + interval %L)', :'co', :'north_ch', 'f1e1d000-0000-0000-0000-000000000003', 'As Lee', '1 hour'),
  'not as someone else');
select tcf.expect_error(format('insert into public.chat_scheduled_messages (company_id, channel_id, author_id, body, send_at) values (%L, %L, %L, %L, now() - interval %L)', :'co', :'north_ch', 'f1e1d000-0000-0000-0000-000000000004', 'Late', '1 hour'),
  'and not for a time gone by');
select tcf.expect_error(format('insert into public.chat_scheduled_messages (company_id, channel_id, author_id, attachments, send_at) values (%L, %L, %L, %L, now() + interval %L)', :'co', :'north_ch', 'f1e1d000-0000-0000-0000-000000000004',
  jsonb_build_array(jsonb_build_object('path', :'co' || '/chat/' || :'general' || '/2b7e1516-28ae-4d2a-a6c1-0d0b1a2c3d4e.jpg')), '1 hour'), 'a file from another channel''s folder is refused');
select tcf.expect_error('select * from public.chat_send_due()', 'and nobody signed in sends what''s due: only the server');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tcf.check((select count(*) from public.chat_scheduled_messages) = 0, 'the owner doesn''t read Nia''s scheduled messages');
update public.chat_scheduled_messages set body = 'Changed' where id = :'later_msg';
delete from public.chat_scheduled_messages where id = :'later_msg';
insert into public.chat_scheduled_messages (company_id, channel_id, author_id, body, send_at)
values (:'co', :'general', 'f1e1d000-0000-0000-0000-000000000001', '@everyone safety meeting at 7', now() + interval '1 second') returning id as owner_everyone \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tcf.check((select count(*) from public.chat_scheduled_messages) = 0, 'nor does Lee');
commit;
select tcf.check((select body = 'Bring the plate compactor tomorrow' from public.chat_scheduled_messages where id = :'later_msg'), 'and neither can change or delete it');

-- Sid schedules for #general, then field crew lose the right to post there before it goes. Ola
-- schedules one and is then taken off the team.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into public.chat_scheduled_messages (company_id, channel_id, author_id, body, send_at)
values (:'co', :'general', 'f1e1d000-0000-0000-0000-000000000005', 'Can someone bring gloves', now() + interval '1 second') returning id as sid_later \gset
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.chat_scheduled_messages (company_id, channel_id, author_id, body, send_at)
values (:'co', :'general', 'f1e1d000-0000-0000-0000-000000000002', 'Payroll is Friday', now() + interval '1 second') returning id as ola_later \gset
commit;

select pg_sleep(1.2);
-- What the guards do with a message from nobody signed in: they trust it, @everyone and all.
begin;
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'f1e1d000-0000-0000-0000-000000000004', '@everyone as the server') returning id as trusted \gset
select tcf.check((select mention_all from public.chat_messages where id = :'trusted'), 'a message inserted with nobody signed in is trusted as the server''s: so a scheduled one mustn''t be sent that way');
rollback;

-- Two runs: Nia's and the owner's go first (the oldest), then field crew lose #general and Ola leaves.
select count(*) as first_run from public.chat_send_due(2) \gset
select tcf.check(:'first_run' = '2', 'the scheduler sends what''s due, oldest first');
select tcf.check((select author_id = 'f1e1d000-0000-0000-0000-000000000004' and not mention_all from public.chat_messages where id = :'nia_everyone'),
  'Nia''s scheduled @everyone goes as hers, its id kept, and doesn''t ping everyone');
select tcf.check((select count(*) from public.notifications where link like '%' || :'nia_everyone') = 0, 'so nobody is told of it');
select tcf.check((select mention_all from public.chat_messages where id = :'owner_everyone'), 'the owner''s scheduled @everyone does');
select tcf.check((select count(*) from public.notifications where link like '%' || :'owner_everyone' and title = 'Owen Fern posted in #general') >= 4, 'and reaches the team');
select tcf.check(coalesce(nullif(current_setting('request.jwt.claims', true), ''), 'none') = 'none' and (select auth.uid()) is null, 'the sign-in is put back after each');

update public.chat_role_rules set can_post = false where channel_id = :'general' and role = 'field_crew';
update public.memberships set active = false where company_id = :'co' and user_id = 'f1e1d000-0000-0000-0000-000000000002';
create temp table tcf_run as select * from public.chat_send_due();
select tcf.check((select count(*) from tcf_run) = 2 and (select count(*) from tcf_run where message_id is not null) = 0, 'a message from someone who can''t post there now, or who left, isn''t sent');
select tcf.check((select count(*) from public.chat_messages where id in (:'sid_later', :'ola_later')) = 0, 'neither is in the channel');
select tcf.check((select problem = 'You can''t post in #general any more.' from tcf_run where scheduled_id = :'sid_later'), 'and why is kept for Sid');
select tcf.check((select count(*) from public.notifications where user_id = 'f1e1d000-0000-0000-0000-000000000005' and kind = 'chat_scheduled'
  and title = 'Your scheduled message to #general wasn''t sent' and body = 'You can''t post in #general any more.') = 1, 'Sid hears why on the bell');
select tcf.check((select count(*) from public.notifications where user_id = 'f1e1d000-0000-0000-0000-000000000002' and kind = 'chat_scheduled') = 0, 'Ola, off the team, isn''t told there');
select tcf.check((select count(*) from public.chat_scheduled_messages where id in (:'sid_later', :'ola_later', :'nia_everyone', :'owner_everyone')) = 0, 'and nothing sent or dropped waits any more');
select tcf.check((select count(*) from public.chat_send_due()) = 0, 'run again, nothing goes twice');
update public.chat_role_rules set can_post = true where channel_id = :'general' and role = 'field_crew';
update public.memberships set active = true where company_id = :'co' and user_id = 'f1e1d000-0000-0000-0000-000000000002';

-- ===== Reminders ================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'north_ch', 'f1e1d000-0000-0000-0000-000000000003', 'Order more sealer for Monday') returning id as lee_msg \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.chat_reminders (message_id, user_id, remind_at) values (:'lee_msg', 'f1e1d000-0000-0000-0000-000000000004', now() + interval '1 second') returning id as nia_reminder \gset
select tcf.check((select channel_id = :'north_ch' from public.chat_reminders where id = :'nia_reminder'), 'Nia sets a reminder on Lee''s message, in its channel');
select tcf.expect_error(format('insert into public.chat_reminders (message_id, user_id, remind_at) values (%L, %L, now() + interval %L)', :'lee_msg', 'f1e1d000-0000-0000-0000-000000000003', '1 hour'), 'not one for Lee');
select tcf.expect_error(format('insert into public.chat_reminders (message_id, user_id, remind_at) values (%L, %L, now() - interval %L)', :'later_msg', 'f1e1d000-0000-0000-0000-000000000004', '1 hour'), 'and only on a message that''s there, at a time to come');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tcf.expect_error(format('insert into public.chat_reminders (message_id, user_id, remind_at) values (%L, %L, now() + interval %L)', :'lee_msg', 'f1e1d000-0000-0000-0000-000000000005', '1 hour'), 'Sid can''t be reminded of a message he can''t see');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tcf.check((select count(*) from public.chat_reminders) = 0, 'Lee doesn''t read Nia''s reminders');
delete from public.chat_reminders where id = :'nia_reminder';
commit;
select tcf.check((select count(*) from public.chat_reminders where id = :'nia_reminder') = 1, 'or delete them');

-- Sid wants a reminder too, then field crew lose sight of #general before it's due.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f1e1d000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'f1e1d000-0000-0000-0000-000000000005', 'Who has the van keys?') returning id as sid_msg \gset
insert into public.chat_reminders (message_id, user_id, remind_at) values (:'sid_msg', 'f1e1d000-0000-0000-0000-000000000005', now() + interval '1 second');
commit;
select pg_sleep(1.2);
update public.chat_role_rules set can_see = false, can_post = false where channel_id = :'general' and role = 'field_crew';
create temp table tcf_reminded as select * from public.chat_send_due_reminders();
update public.chat_role_rules set can_see = true, can_post = true where channel_id = :'general' and role = 'field_crew';
select tcf.check((select told from tcf_reminded where user_id = 'f1e1d000-0000-0000-0000-000000000004'), 'Nia''s reminder is due and goes');
select tcf.check((select count(*) from public.notifications where user_id = 'f1e1d000-0000-0000-0000-000000000004' and kind = 'chat_reminder'
  and title = 'Reminder: Lee Lead''s message in #north-crew' and body = 'Order more sealer for Monday' and link = '/chat/' || :'north_ch' || '?message=' || :'lee_msg') = 1,
  'on her bell: whose message, where, its words and the way to it');
select tcf.check((select not told from tcf_reminded where user_id = 'f1e1d000-0000-0000-0000-000000000005'), 'Sid, who can''t see #general any more, isn''t told of it');
select tcf.check((select count(*) from public.chat_reminders) = 0 and (select count(*) from public.chat_send_due_reminders()) = 0, 'and each is done once');
