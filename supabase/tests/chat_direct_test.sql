-- Database tests for direct messages (20261129101000_chat_direct_messages.sql): the same people always
-- get the same conversation, only active staff can be in one, nobody outside it reads it (owners and
-- admins included), every message notifies the others and counts as a mention, mentions in one are of
-- its people only, a conversation can be closed and a group left, someone who leaves the company keeps
-- nothing, and owners and admins can turn direct messages off and on without losing any.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tdm;
grant usage on schema tdm to authenticated, service_role;
create function tdm.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tdm.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tdm to authenticated, service_role;

-- Jo owns Mike Lawn; Ava is an admin, Dana office, Mateo leads a crew, Toby and Sid are field
-- crew, Bo is field crew about to leave, Lee is a sub, Ruth is office. Xavier owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('dc010000-0000-0000-0000-000000000001', 'jo@mike.test', '{"full_name": "Jo Quinn"}'),
  ('dc010000-0000-0000-0000-000000000002', 'ava@mike.test', '{"full_name": "Ava Stone"}'),
  ('dc010000-0000-0000-0000-000000000003', 'dana@mike.test', '{"full_name": "Dana Hale"}'),
  ('dc010000-0000-0000-0000-000000000004', 'mateo@mike.test', '{"full_name": "Mateo Cruz"}'),
  ('dc010000-0000-0000-0000-000000000005', 'toby@mike.test', '{"full_name": "Toby Lane"}'),
  ('dc010000-0000-0000-0000-000000000006', 'sid@mike.test', '{"full_name": "Sid Moss"}'),
  ('dc010000-0000-0000-0000-000000000007', 'bo@mike.test', '{"full_name": "Bo Hart"}'),
  ('dc010000-0000-0000-0000-000000000008', 'lee@mike.test', '{"full_name": "Lee Sub"}'),
  ('dc010000-0000-0000-0000-000000000009', 'xavier@nov.test', '{"full_name": "Xavier Lima"}'),
  ('dc010000-0000-0000-0000-00000000000a', 'ruth@mike.test', '{"full_name": "Ruth Kim"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('November Snow', 'general') as other \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Mike Lawn', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'dc010000-0000-0000-0000-000000000003', 'office'),
  (:'co', 'dc010000-0000-0000-0000-000000000004', 'crew_lead'),
  (:'co', 'dc010000-0000-0000-0000-000000000005', 'field_crew'),
  (:'co', 'dc010000-0000-0000-0000-000000000006', 'field_crew'),
  (:'co', 'dc010000-0000-0000-0000-000000000007', 'field_crew'),
  (:'co', 'dc010000-0000-0000-0000-00000000000a', 'office');
insert into public.subcontractors (id, company_id, name) values ('dc010000-0000-0000-0000-0000000000c1', :'co', 'Lee''s Roofing');
select tdm.check(public.chat_set_enabled(:'co', true), 'the owner turns chat on');
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
select id as ann from public.chat_channels where company_id = :'co' and kind = 'announcement' \gset
commit;

-- An admin and a sub's sign-in, as the server makes them.
insert into public.memberships (company_id, user_id, role) values (:'co', 'dc010000-0000-0000-0000-000000000002', 'admin');
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', 'dc010000-0000-0000-0000-000000000008', 'subcontractor', 'dc010000-0000-0000-0000-0000000000c1');
select tdm.check(private.chat_direct_on(:'co'), 'direct messages are on in a business that never set them');

-- ===== Starting a conversation ===============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.chat_start_direct(:'co', array['dc010000-0000-0000-0000-000000000004']::uuid[]) as dm1 \gset
select tdm.check(public.chat_start_direct(:'co', array['dc010000-0000-0000-0000-000000000004', 'dc010000-0000-0000-0000-000000000004', 'dc010000-0000-0000-0000-000000000003']::uuid[]) = :'dm1',
  'messaging the same person again opens the same conversation (repeats and yourself don''t count)');
select tdm.check((select kind = 'direct' from public.chat_channels where id = :'dm1'), 'it''s a direct conversation');
select tdm.check((select array_agg(user_id order by user_id) from public.chat_direct_members where channel_id = :'dm1') = array['dc010000-0000-0000-0000-000000000003', 'dc010000-0000-0000-0000-000000000004']::uuid[],
  'with its two people');
select tdm.check((select people = array['dc010000-0000-0000-0000-000000000004']::uuid[] from public.chat_overview(:'co') where id = :'dm1'), 'Dana''s list shows Mateo as who it''s with');
select tdm.check((select count(*) from public.chat_direct_people(:'co')) = 7 and not exists (select 1 from public.chat_direct_people(:'co') where user_id in ('dc010000-0000-0000-0000-000000000008', 'dc010000-0000-0000-0000-000000000003')),
  'the people Dana can message are the team, not the sub or herself');
select tdm.expect_error(format('select public.chat_start_direct(%L, %L)', :'co', '{dc010000-0000-0000-0000-000000000008}'), 'a sub can''t be messaged');
select tdm.expect_error(format('select public.chat_start_direct(%L, %L)', :'co', '{dc010000-0000-0000-0000-000000000009}'), 'nor someone from another business');
select tdm.expect_error(format('select public.chat_start_direct(%L, %L)', :'co', '{}'), 'nor nobody');
select tdm.expect_error(format('select public.chat_start_direct(%L, %L)', :'co', '{dc010000-0000-0000-0000-000000000001,dc010000-0000-0000-0000-000000000002,dc010000-0000-0000-0000-000000000004,dc010000-0000-0000-0000-000000000005,dc010000-0000-0000-0000-000000000006,dc010000-0000-0000-0000-000000000007,dc010000-0000-0000-0000-00000000000a,dc010000-0000-0000-0000-000000000009,dc010000-0000-0000-0000-000000000008}'),
  'nor more than eight people');
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm1', 'dc010000-0000-0000-0000-000000000003', 'Can you take the Elm St job Friday?') returning id as dm1_msg \gset
-- A text channel can have the name a conversation has: names of conversations don't count.
select tdm.check((select count(*) from public.chat_channels where company_id = :'co' and kind = 'direct') = 1, 'one conversation so far');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tdm.check(public.chat_start_direct(:'co', array['dc010000-0000-0000-0000-000000000003']::uuid[]) = :'dm1', 'Mateo messaging Dana gets the same conversation');
select tdm.check((select unread = 1 and mentions = 1 from public.chat_overview(:'co') where id = :'dm1'), 'Dana''s message is new for Mateo, and counts as a mention');
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm1') = 1, 'Mateo reads it');
select tdm.check((select count(*) from public.chat_members(:'dm1')) = 2, 'its member list is the two of them');
commit;

select tdm.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc010000-0000-0000-0000-000000000004' and kind = 'chat' and title = 'Dana Hale messaged you'
  and body = 'Can you take the Elm St job Friday?' and link = '/chat/' || :'dm1' || '?message=' || :'dm1_msg') = 1, 'Mateo is told "Dana Hale messaged you"');
select tdm.check((select count(*) from public.notifications where company_id = :'co' and kind = 'chat' and title like 'Dana Hale%' and user_id <> 'dc010000-0000-0000-0000-000000000004') = 0, 'and nobody else is');

-- ===== Nobody else reads it: not the owner, not an admin =====================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tdm.check((select count(*) from public.chat_channels where id = :'dm1') = 0, 'the owner doesn''t see the conversation');
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm1') = 0, 'or read its messages');
select tdm.check((select count(*) from public.chat_direct_members where channel_id = :'dm1') = 0, 'or who''s in it');
select tdm.check((select count(*) from public.chat_members(:'dm1')) = 0, 'or its member list');
select tdm.check(not exists (select 1 from public.chat_overview(:'co') where id = :'dm1'), 'it isn''t in her list');
select tdm.check(not private.chat_can(:'dm1', 'see') and not private.chat_can(:'dm1', 'manage'), 'owners have no rights in it');
select tdm.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body) values (%L, %L, %L, %L)', :'co', :'dm1', 'dc010000-0000-0000-0000-000000000001', 'Hello?'), 'the owner can''t post in it');
select tdm.expect_error(format('insert into public.chat_reactions (message_id, user_id, kind) values (%L, %L, %L)', :'dm1_msg', 'dc010000-0000-0000-0000-000000000001', 'seen'), 'or react in it');
select tdm.expect_error(format('select public.chat_mark_read(%L)', :'dm1'), 'or mark it read');
update public.chat_channels set archived_at = now() where id = :'dm1';
delete from public.chat_channels where id = :'dm1';
select tdm.expect_error(format('insert into public.chat_channels (company_id, kind, name) values (%L, %L, %L)', :'co', 'direct', 'sneaky'), 'nor make a conversation of her own outside chat_start_direct');
select tdm.expect_error(format('select public.chat_leave_direct(%L)', :'dm1'), 'nor leave it for them');
commit;
select tdm.check((select archived_at is null from public.chat_channels where id = :'dm1'), 'the owner couldn''t archive it');
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm1') = 1, 'or delete it');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tdm.check((select count(*) from public.chat_channels where id = :'dm1') = 0, 'an admin doesn''t see the conversation either');
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm1') = 0, 'or read its messages');
select tdm.check((select count(*) from public.chat_channels where company_id = :'co' and kind <> 'direct') = 3, 'while still seeing every channel');
select tdm.check((select count(*) from storage.objects where name like :'co' || '/chat/' || :'dm1' || '/%') = 0, 'and none of its files');
select tdm.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/chat/' || :'dm1' || '/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e11.jpg', 'dc010000-0000-0000-0000-000000000002'), 'and can''t upload into it');
-- Chat settings: a rule for the conversation is left out, the rest saves.
select public.chat_save_roles(:'co', '[]'::jsonb, jsonb_build_array(
  jsonb_build_object('channel_id', :'dm1', 'role', 'admin', 'can_see', true, 'can_post', true, 'can_manage', true),
  jsonb_build_object('channel_id', :'general', 'role', 'admin', 'can_see', true, 'can_post', true, 'can_manage', true)));
select tdm.check(not private.chat_can(:'dm1', 'see'), 'a rule saved for a conversation gives an admin nothing');
commit;
select tdm.check((select count(*) from public.chat_role_rules where channel_id = :'dm1') = 0 and (select count(*) from public.chat_role_rules where channel_id = :'general') = 1,
  'roles get no rules in a conversation, while other rules save');

-- Live updates go to its two people only.
set role service_role;
select tdm.check((select array_agg(u order by u) from public.chat_audience(:'dm1') as u) = array['dc010000-0000-0000-0000-000000000003', 'dc010000-0000-0000-0000-000000000004']::uuid[], 'live updates reach only the two of them');
reset role;

-- ===== A group: mentions are of its people, and everyone else hears ==========================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.chat_start_direct(:'co', array['dc010000-0000-0000-0000-000000000004', 'dc010000-0000-0000-0000-000000000005', 'dc010000-0000-0000-0000-000000000006']::uuid[]) as dm2 \gset
select tdm.check(:'dm2' <> :'dm1', 'a different set of people is a different conversation');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body)
values (:'co', :'dm2', 'dc010000-0000-0000-0000-000000000005', 'Truck 2 is low on oil <@&office> <@dc010000-0000-0000-0000-000000000006> @everyone') returning id as dm2_msg \gset
select tdm.check((select mention_roles = '{}' and not mention_all and mention_users = array['dc010000-0000-0000-0000-000000000006']::uuid[] from public.chat_messages where id = :'dm2_msg'),
  'in a conversation only its people can be mentioned: no roles, no @everyone');
update public.chat_messages set body = 'Truck 2 is low on oil <@&office>' where id = :'dm2_msg';
select tdm.check((select mention_roles = '{}' from public.chat_messages where id = :'dm2_msg'), 'not after an edit either');
commit;

select tdm.check((select count(*) from public.notifications where company_id = :'co' and kind = 'chat' and title = 'Toby Lane messaged you and 2 others') = 3
  and (select count(*) from public.notifications where company_id = :'co' and kind = 'chat' and title like 'Toby Lane%') = 3, 'a group message tells the other three, and nobody else (not the office it named)');

-- ===== Closing and leaving ==================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select public.chat_close_direct(:'dm1');
select tdm.check((select closed from public.chat_overview(:'co') where id = :'dm1'), 'Mateo closes his conversation with Dana');
select tdm.expect_error(format('select public.chat_leave_direct(%L)', :'dm1'), 'a conversation of two can''t be left, only closed');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm1', 'dc010000-0000-0000-0000-000000000003', 'Never mind, Toby has it.');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tdm.check((select not closed from public.chat_overview(:'co') where id = :'dm1'), 'a new message brings it back');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select public.chat_leave_direct(:'dm2');
select tdm.check(not exists (select 1 from public.chat_overview(:'co') where id = :'dm2'), 'Sid leaves the group: it''s gone from his list');
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm2') = 0, 'and he can''t read it any more');
select tdm.check((select count(*) from public.notifications where company_id = :'co' and user_id = 'dc010000-0000-0000-0000-000000000006' and kind = 'chat' and read_at is null) = 0, 'its notifications are put away');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tdm.check((select people = array['dc010000-0000-0000-0000-000000000003', 'dc010000-0000-0000-0000-000000000004']::uuid[] from public.chat_overview(:'co') where id = :'dm2'), 'the others carry on without him');
select tdm.check(public.chat_start_direct(:'co', array['dc010000-0000-0000-0000-000000000003', 'dc010000-0000-0000-0000-000000000004', 'dc010000-0000-0000-0000-000000000006']::uuid[]) <> :'dm2',
  'messaging all four again starts a new conversation: Sid isn''t pulled back into the old one');
commit;

-- ===== Someone who leaves the company ========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select public.chat_start_direct(:'co', array['dc010000-0000-0000-0000-00000000000a']::uuid[]) as dm_ben \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm_ben', 'dc010000-0000-0000-0000-000000000007', 'My last day is Friday.');
commit;

update public.memberships set active = false where company_id = :'co' and user_id = 'dc010000-0000-0000-0000-000000000007';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm_ben') = 0, 'Bo has left: he can''t read the conversation');
select tdm.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body) values (%L, %L, %L, %L)', :'co', :'dm_ben', 'dc010000-0000-0000-0000-000000000007', 'One more thing'),
  'or post in it');
select tdm.expect_error(format('select public.chat_start_direct(%L, %L)', :'co', '{dc010000-0000-0000-0000-00000000000a}'), 'or start one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-00000000000a", "role": "authenticated"}', true);
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm_ben') = 1, 'Ruth keeps the history');
select tdm.check((select not can_post from public.chat_overview(:'co') where id = :'dm_ben'), 'with nobody left to read it, she can''t post in it');
select tdm.expect_error(format('select public.chat_start_direct(%L, %L)', :'co', '{dc010000-0000-0000-0000-000000000007}'), 'and can''t message Bo any more');
commit;

set role service_role;
select tdm.check((select array_agg(u) from public.chat_audience(:'dm_ben') as u) = array['dc010000-0000-0000-0000-00000000000a']::uuid[], 'Bo gets no live updates from it');
reset role;
select tdm.check((select left_at is not null and left_company from public.chat_direct_members where channel_id = :'dm_ben' and user_id = 'dc010000-0000-0000-0000-000000000007'),
  'leaving the company leaves his conversations');

-- Back on the team later: none of it comes back.
update public.memberships set active = true where company_id = :'co' and user_id = 'dc010000-0000-0000-0000-000000000007';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm_ben') = 0 and not exists (select 1 from public.chat_overview(:'co') where id = :'dm_ben'),
  'made active again, Bo doesn''t get the conversation back, or what was said while he was away');
select tdm.check(public.chat_start_direct(:'co', array['dc010000-0000-0000-0000-00000000000a']::uuid[]) <> :'dm_ben', 'messaging Ruth again starts a new conversation');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-00000000000a", "role": "authenticated"}', true);
select tdm.check((select people = array['dc010000-0000-0000-0000-000000000007']::uuid[] and not can_post from public.chat_overview(:'co') where id = :'dm_ben'),
  'Ruth''s old conversation is still named by Bo, and still takes no messages');
commit;

-- ===== Subs never see chat ===================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select tdm.check((select count(*) from public.chat_overview(:'co')) = 0 and (select count(*) from public.chat_direct_people(:'co')) = 0, 'a sub has no conversations and nobody to message');
select tdm.expect_error(format('select public.chat_start_direct(%L, %L)', :'co', '{dc010000-0000-0000-0000-000000000003}'), 'and can''t start one');
commit;

-- ===== Turning direct messages off and on ====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.chat_start_direct(:'co', array['dc010000-0000-0000-0000-000000000002']::uuid[]) as dm_owner \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm_owner', 'dc010000-0000-0000-0000-000000000001', 'Payroll is done.');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tdm.expect_error(format('select public.chat_set_direct_messages(%L, false)', :'co'), 'the office can''t turn direct messages off');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tdm.expect_error(format('select public.chat_set_direct_messages(%L, false)', :'co'), 'nor can a crew lead');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tdm.expect_error(format('select public.chat_set_direct_messages(%L, false)', :'co'), 'nor field crew');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select tdm.expect_error(format('select public.chat_set_direct_messages(%L, false)', :'co'), 'nor another business''s owner');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tdm.check(not public.chat_set_direct_messages(:'co', false), 'an admin turns direct messages off');
commit;
select tdm.check((select settings -> 'team_chat' ->> 'direct_messages' = 'false' and settings -> 'team_chat' ->> 'enabled' = 'true' from public.companies where id = :'co'),
  'it''s kept next to chat''s own switch, which stays on');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm_owner') = 0, 'off: the owner can''t read her own conversation');
select tdm.check(not exists (select 1 from public.chat_overview(:'co') where kind = 'direct'), 'there are none in her list');
select tdm.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body) values (%L, %L, %L, %L)', :'co', :'dm_owner', 'dc010000-0000-0000-0000-000000000001', 'Still there?'), 'and she can''t post in one');
select tdm.expect_error(format('select public.chat_start_direct(%L, %L)', :'co', '{dc010000-0000-0000-0000-000000000003}'), 'or start one');
select tdm.check((select count(*) from public.chat_direct_people(:'co')) = 0, 'nobody is offered to message');
select tdm.check((select count(*) from public.chat_overview(:'co')) = 3, 'channels carry on as before');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tdm.check((select count(*) from public.chat_messages where channel_id in (:'dm1', :'dm2')) = 0, 'Mateo can''t read his either');
commit;

set role service_role;
select tdm.check((select count(*) from public.chat_audience(:'dm1')) = 0, 'and nobody gets live updates from one');
reset role;
select tdm.check((select count(*) from public.chat_messages where channel_id in (:'dm1', :'dm2', :'dm_owner', :'dm_ben')) = 5, 'every message is kept');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc010000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tdm.check(public.chat_set_direct_messages(:'co', true), 'the owner turns them back on');
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm_owner') = 1, 'and her conversation is back as it was');
select tdm.check((select count(*) from public.chat_messages where channel_id = :'dm1') = 0, 'and still nobody else''s');
commit;
