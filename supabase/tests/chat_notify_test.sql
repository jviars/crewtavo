-- Database tests for how each person hears about each channel, and Team chat's quiet hours
-- (20261129101200_chat_notification_settings.sql): "all new messages" tells of every message, "nothing"
-- of none (a mention still counts in the list), direct conversations start at "all", each person's
-- choices and quiet hours are theirs alone, and only zones the database knows are kept.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tnf;
grant usage on schema tnf to authenticated, service_role;
create function tnf.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tnf.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tnf to authenticated, service_role;

-- Jo owns Papa Lawn; Dana is office, Toby and Sid field crew.
insert into auth.users (id, email, raw_user_meta_data) values
  ('dc030000-0000-0000-0000-000000000001', 'jo@papa.test', '{"full_name": "Jo Quinn"}'),
  ('dc030000-0000-0000-0000-000000000003', 'dana@papa.test', '{"full_name": "Dana Hale"}'),
  ('dc030000-0000-0000-0000-000000000005', 'toby@papa.test', '{"full_name": "Toby Lane"}'),
  ('dc030000-0000-0000-0000-000000000006', 'sid@papa.test', '{"full_name": "Sid Moss"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Papa Lawn', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'dc030000-0000-0000-0000-000000000003', 'office'),
  (:'co', 'dc030000-0000-0000-0000-000000000005', 'field_crew'),
  (:'co', 'dc030000-0000-0000-0000-000000000006', 'field_crew');
select tnf.check(public.chat_set_enabled(:'co', true), 'the owner turns chat on');
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
select id as office_ch from public.chat_channels where company_id = :'co' and name = 'office' \gset
commit;

-- ===== Choosing =============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tnf.check((select notify = 'mentions' from public.chat_overview(:'co') where id = :'general'), 'a channel starts at mentions and replies');
select tnf.check(public.chat_set_notify(:'general', 'all') = 'all', 'Toby hears about everything in #general');
select tnf.check((select notify = 'all' from public.chat_overview(:'co') where id = :'general'), 'and the list says so');
select tnf.expect_error(format('select public.chat_set_notify(%L, %L)', :'general', 'loud'), 'only the three choices are taken');
select tnf.expect_error(format('select public.chat_set_notify(%L, %L)', :'office_ch', 'all'), 'nor for a channel he can''t see');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select public.chat_set_notify(:'general', 'nothing');
select tnf.check((select count(*) from public.chat_channel_prefs) = 1, 'Sid sees only his own choices, not Toby''s');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'dc030000-0000-0000-0000-000000000003', 'Gas card is in the office');
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'dc030000-0000-0000-0000-000000000003', '<@dc030000-0000-0000-0000-000000000006> your check is ready');
select tnf.check((select count(*) from public.chat_channel_prefs) = 0, 'and Dana sees none of theirs');
commit;

select tnf.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc030000-0000-0000-0000-000000000005' and kind = 'chat' and title = 'Dana Hale posted in #general') = 2,
  'all new messages: Toby hears of both');
select tnf.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc030000-0000-0000-0000-000000000006' and kind = 'chat') = 0, 'nothing: Sid hears of neither, not even his mention');
select tnf.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc030000-0000-0000-0000-000000000001' and kind = 'chat') = 0, 'mentions and replies: the owner hears of neither');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select tnf.check((select notify = 'nothing' and mentions = 1 and unread = 2 from public.chat_overview(:'co') where id = :'general'), 'Sid''s muted channel still counts his mention');
select public.chat_set_notify(:'general', null);
select tnf.check((select notify = 'mentions' from public.chat_overview(:'co') where id = :'general'), 'and goes back to mentions and replies when he resets it');
commit;

-- A thread's replies in a channel set to all: only its followers hear.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'dc030000-0000-0000-0000-000000000003', 'Who has the trailer?') returning id as root \gset
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body, thread_root) values (:'co', :'general', 'dc030000-0000-0000-0000-000000000006', 'I do', :'root');
commit;
select tnf.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc030000-0000-0000-0000-000000000005' and body = 'I do') = 0, 'a thread''s reply isn''t one of the channel''s new messages, even for Toby');
select tnf.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc030000-0000-0000-0000-000000000003' and title = 'Sid Moss replied in a thread in #general') = 1, 'the thread''s follower hears of it');

-- ===== Direct conversations start at all =====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.chat_start_direct(:'co', array['dc030000-0000-0000-0000-000000000005']::uuid[]) as dm \gset
select tnf.check((select notify = 'all' from public.chat_overview(:'co') where id = :'dm'), 'a direct conversation starts at all new messages');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select public.chat_set_notify(:'dm', 'mentions');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm', 'dc030000-0000-0000-0000-000000000003', 'Running late');
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm', 'dc030000-0000-0000-0000-000000000003', '<@dc030000-0000-0000-0000-000000000005> call me');
commit;
select tnf.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc030000-0000-0000-0000-000000000005' and title = 'Dana Hale messaged you') = 1, 'set to mentions, Toby hears only of the message naming him');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select public.chat_set_notify(:'dm', 'nothing');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm', 'dc030000-0000-0000-0000-000000000003', '<@dc030000-0000-0000-0000-000000000005> call me now');
commit;
select tnf.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc030000-0000-0000-0000-000000000005' and title = 'Dana Hale messaged you') = 1, 'set to nothing, he hears of nothing');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tnf.check((select unread = 3 and mentions = 2 from public.chat_overview(:'co') where id = :'dm'), 'muted, only the messages naming him count as mentions; all three are new');
commit;

-- ===== Quiet hours are each person's own =====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into public.chat_quiet_hours (company_id, user_id, quiet_on, starts, ends, days, time_zone) values (:'co', 'dc030000-0000-0000-0000-000000000005', true, '20:00', '06:30', '{1,2,3,4,5}', 'America/Chicago');
update public.chat_quiet_hours set paused_until = now() + interval '1 hour' where user_id = 'dc030000-0000-0000-0000-000000000005';
select tnf.check((select quiet_on and paused_until > now() and time_zone = 'America/Chicago' from public.chat_quiet_hours where user_id = 'dc030000-0000-0000-0000-000000000005'), 'Toby sets quiet hours and pauses for an hour');
select tnf.expect_error(format('insert into public.chat_quiet_hours (company_id, user_id) values (%L, %L)', :'co', 'dc030000-0000-0000-0000-000000000006'), 'he can''t set someone else''s');
select tnf.expect_error(format('update public.chat_quiet_hours set time_zone = %L where user_id = %L', 'Mars/Olympus', 'dc030000-0000-0000-0000-000000000005'), 'a zone the database doesn''t know is refused');
select tnf.expect_error(format('update public.chat_quiet_hours set days = %L where user_id = %L', '{7}', 'dc030000-0000-0000-0000-000000000005'), 'and so is a day that isn''t one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tnf.check((select count(*) from public.chat_quiet_hours) = 0, 'Dana can''t read Toby''s quiet hours');
update public.chat_quiet_hours set quiet_on = false where user_id = 'dc030000-0000-0000-0000-000000000005';
commit;
select tnf.check((select quiet_on from public.chat_quiet_hours where user_id = 'dc030000-0000-0000-0000-000000000005'), 'or change them');

-- Someone who left the team keeps nothing of theirs to change.
update public.memberships set active = false where company_id = :'co' and user_id = 'dc030000-0000-0000-0000-000000000006';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc030000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select tnf.expect_error(format('insert into public.chat_quiet_hours (company_id, user_id) values (%L, %L)', :'co', 'dc030000-0000-0000-0000-000000000006'), 'someone who left can''t set quiet hours');
select tnf.expect_error(format('select public.chat_set_notify(%L, %L)', :'general', 'all'), 'or choose how they hear about a channel');
commit;
