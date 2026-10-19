-- Database tests for team chat: it stays off until an owner or admin turns it on, each role sees
-- and posts only where its rules allow, field crew see only their own crew's channel, mentions come
-- from the text and notify the right people, people edit and delete only their own messages,
-- managers pin, photos follow the channel, and turning chat off hides everything.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tch;
grant usage on schema tch to authenticated, service_role;
create function tch.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tch.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tch to authenticated, service_role;

-- Jess owns Kilo Lawn; Dana is office, Chris an estimator, Marcus leads North crew, Tyler is on
-- North, Ben is on South, Sam is seasonal help (a custom role on the field crew level). Xavier
-- owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c4a70000-0000-0000-0000-000000000001', 'jess@kilo.test', '{"full_name": "Jess Park"}'),
  ('c4a70000-0000-0000-0000-000000000002', 'dana@kilo.test', '{"full_name": "Dana Whitaker"}'),
  ('c4a70000-0000-0000-0000-000000000003', 'chris@kilo.test', '{"full_name": "Chris Adeyemi"}'),
  ('c4a70000-0000-0000-0000-000000000004', 'marcus@kilo.test', '{"full_name": "Marcus Reyes"}'),
  ('c4a70000-0000-0000-0000-000000000005', 'tyler@kilo.test', '{"full_name": "Tyler Brooks"}'),
  ('c4a70000-0000-0000-0000-000000000006', 'ben@kilo.test', '{"full_name": "Ben Carter"}'),
  ('c4a70000-0000-0000-0000-000000000007', 'sam@kilo.test', '{"full_name": "Sam Ortiz"}'),
  ('c4a70000-0000-0000-0000-000000000009', 'xavier@lima.test', '{"full_name": "Xavier Lima"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Lima Snow', 'general') as other \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Kilo Lawn', 'lawn_care') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Seasonal help', 'field_crew', '{}') returning id as seasonal \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c4a70000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'c4a70000-0000-0000-0000-000000000003', 'estimator'),
  (:'co', 'c4a70000-0000-0000-0000-000000000004', 'crew_lead'),
  (:'co', 'c4a70000-0000-0000-0000-000000000005', 'field_crew'),
  (:'co', 'c4a70000-0000-0000-0000-000000000006', 'field_crew');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', 'c4a70000-0000-0000-0000-000000000007', 'field_crew', :'seasonal');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'North Crew', 'c4a70000-0000-0000-0000-000000000004') returning id as north \gset
insert into public.crews (company_id, name) values (:'co', 'South Crew') returning id as south \gset
insert into public.crew_members (company_id, crew_id, user_id) values
  (:'co', :'north', 'c4a70000-0000-0000-0000-000000000005'),
  (:'co', :'north', 'c4a70000-0000-0000-0000-000000000007'),
  (:'co', :'south', 'c4a70000-0000-0000-0000-000000000006');
select tch.check((select count(*) from public.chat_channels where company_id = :'co') = 0, 'a new crew doesn''t start chat by itself');
select tch.check((select count(*) from public.chat_overview(:'co')) = 0, 'chat starts off');
commit;

-- ===== Only owners and admins turn it on =====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tch.expect_error(format('select public.chat_set_enabled(%L, true)', :'co'), 'the office can''t turn chat on');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tch.check(public.chat_set_enabled(:'co', true), 'the owner turns chat on');
select tch.check((select array_agg(name order by position) from public.chat_channels where company_id = :'co') = array['Announcements', 'general', 'north-crew', 'south-crew', 'office'],
  'it starts with announcements, general, a channel per crew and one for the office');
select id as ann from public.chat_channels where company_id = :'co' and kind = 'announcement' \gset
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
select id as north_ch from public.chat_channels where company_id = :'co' and name = 'north-crew' \gset
select id as south_ch from public.chat_channels where company_id = :'co' and name = 'south-crew' \gset
select id as office_ch from public.chat_channels where company_id = :'co' and name = 'office' \gset
select tch.check((select crew_id = :'north' from public.chat_channels where id = :'north_ch'), 'a crew''s channel belongs to the crew');
select tch.check((select count(*) from public.chat_overview(:'co')) = 5, 'the owner sees every channel');
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'ann', 'c4a70000-0000-0000-0000-000000000001', 'Fall cleanup starts Monday. @everyone') returning id as ann_msg \gset
select tch.check((select mention_all from public.chat_messages where id = :'ann_msg'), 'an owner''s @everyone counts');
commit;

-- ===== Field crew: their own crew, and announcements to read ===================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tch.check((select array_agg(name order by position) from public.chat_overview(:'co')) = array['Announcements', 'general', 'north-crew'],
  'Tyler sees announcements, general and his own crew, not South or the office');
select tch.check((select not can_post from public.chat_overview(:'co') where id = :'ann'), 'field crew read announcements but don''t post');
select tch.check((select unread = 1 and mentions = 1 from public.chat_overview(:'co') where id = :'ann'), 'the announcement is unread and counts as a mention (@everyone)');
select tch.check((select count(*) from public.notifications where user_id = 'c4a70000-0000-0000-0000-000000000005' and kind = 'chat' and title = 'Jess Park posted in Announcements') = 1,
  '@everyone notifies the crew');
select tch.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body) values (%L, %L, %L, %L)', :'co', :'ann', 'c4a70000-0000-0000-0000-000000000005', 'Can I post?'), 'field crew can''t post announcements');
select tch.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body) values (%L, %L, %L, %L)', :'co', :'office_ch', 'c4a70000-0000-0000-0000-000000000005', 'hi'), 'or in the office channel');
select tch.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body) values (%L, %L, %L, %L)', :'co', :'general', 'c4a70000-0000-0000-0000-000000000004', 'Pretending'), 'or as someone else');
select tch.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body) values (%L, %L, %L, %L)', :'co', :'general', 'c4a70000-0000-0000-0000-000000000005', '   '), 'an empty message is refused');
insert into public.chat_messages (company_id, channel_id, author_id, body)
values (:'co', :'north_ch', 'c4a70000-0000-0000-0000-000000000005', 'Done at Maple Ct. <@c4a70000-0000-0000-0000-000000000004> <@&office> @everyone')
returning id as tyler_msg \gset
select tch.check((select mention_users = array['c4a70000-0000-0000-0000-000000000004'::uuid] and mention_roles = array['office'] and not mention_all from public.chat_messages where id = :'tyler_msg'),
  'mentions are read from the text, and field crew can''t ping @everyone');
insert into public.chat_reactions (message_id, user_id, kind) values (:'ann_msg', 'c4a70000-0000-0000-0000-000000000005', 'thumbs_up');
select tch.check((select channel_id = :'ann' from public.chat_reactions where message_id = :'ann_msg'), 'reactions are allowed where you can read, and go with the message''s channel');
select tch.expect_error(format('update public.chat_messages set pinned_at = now() where id = %L', :'tyler_msg'), 'field crew can''t pin');
update public.chat_messages set body = 'Done at Maple Ct, gate latched. <@c4a70000-0000-0000-0000-000000000004>' where id = :'tyler_msg';
select tch.check((select edited_at is not null and body like '%gate latched%' and mention_users = array['c4a70000-0000-0000-0000-000000000004'::uuid] and mention_roles = '{}' from public.chat_messages where id = :'tyler_msg'),
  'Tyler edits his own message, and its mentions follow the text');
update public.chat_messages set body = 'Changed' where id = :'ann_msg';
select tch.check((select body like 'Fall cleanup%' from public.chat_messages where id = :'ann_msg'), 'but not anyone else''s');
select tch.expect_error(format('update public.chat_messages set channel_id = %L where id = %L', :'general', :'tyler_msg'), 'a message can''t be moved to another channel');
commit;

-- Mentions reached Marcus and the office, not Tyler himself or the estimator.
select tch.check((select count(*) from public.notifications where kind = 'chat' and title = 'Tyler Brooks mentioned you in #north-crew' and user_id in ('c4a70000-0000-0000-0000-000000000004', 'c4a70000-0000-0000-0000-000000000002')) = 2,
  'a mention notifies the person and the role named');
select tch.check((select count(*) from public.notifications where kind = 'chat' and title like 'Tyler Brooks%' and user_id in ('c4a70000-0000-0000-0000-000000000005', 'c4a70000-0000-0000-0000-000000000003')) = 0,
  'and nobody else');
select tch.check((select link = '/chat/' || :'north_ch' || '?message=' || :'tyler_msg' from public.notifications where kind = 'chat' and user_id = 'c4a70000-0000-0000-0000-000000000004' and title like 'Tyler%'),
  'the notification opens the message');

-- ===== Another crew, and the office ===========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select tch.check((select count(*) from public.chat_messages where channel_id = :'north_ch') = 0, 'Ben (South) can''t read North''s channel');
select tch.expect_error(format('insert into public.chat_reactions (message_id, user_id, kind) values (%L, %L, %L)', :'tyler_msg', 'c4a70000-0000-0000-0000-000000000006', 'seen'), 'or react to it');
select tch.check((select count(*) from public.chat_members(:'north_ch')) = 0, 'or list who''s in it');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tch.check((select array_agg(name order by position) from public.chat_overview(:'co')) = array['Announcements', 'general', 'north-crew', 'south-crew'],
  'a crew lead sees every crew''s channel, not the office''s');
select tch.check((select can_manage from public.chat_overview(:'co') where id = :'north_ch'), 'and manages the crews');
update public.chat_messages set pinned_at = now() where id = :'tyler_msg';
select tch.check((select pinned_at is not null and pinned_by = 'c4a70000-0000-0000-0000-000000000004' from public.chat_messages where id = :'tyler_msg'), 'Marcus pins Tyler''s message');
select tch.check((select mentions from public.chat_overview(:'co') where id = :'north_ch') = 1, 'Marcus has a mention waiting in #north-crew');
select public.chat_mark_read(:'north_ch');
select tch.check((select unread = 0 and mentions = 0 from public.chat_overview(:'co') where id = :'north_ch'), 'reading the channel clears it');
select tch.check((select read_at is not null from public.notifications where kind = 'chat' and user_id = 'c4a70000-0000-0000-0000-000000000004' and title like 'Tyler%'), 'and its notification');
select tch.check((select array_agg(full_name order by full_name) from public.chat_members(:'north_ch')) @> array['Marcus Reyes', 'Tyler Brooks', 'Sam Ortiz', 'Dana Whitaker', 'Jess Park']
  and not (select array_agg(full_name) from public.chat_members(:'north_ch')) @> array['Ben Carter'], 'North''s member list has North, the office and the owner, not Ben');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tch.check((select count(*) from public.chat_overview(:'co') where id = :'office_ch') = 1, 'an estimator is in the office channel');
select tch.expect_error(format('select public.chat_save_roles(%L, %L, %L)', :'co', '[]', '[]'), 'but can''t change chat roles');
select tch.expect_error(format('select public.chat_create_channel(%L, %L, %L)', :'co', 'quotes', 'office'), 'or add channels');
select tch.expect_error('select * from public.chat_audience(''' || :'office_ch' || ''')', 'or ask who gets live updates');
commit;

-- ===== Photos follow the channel ==============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/chat/' || :'north_ch' || '/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e11.jpg', 'c4a70000-0000-0000-0000-000000000005');
select tch.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/chat/' || :'office_ch' || '/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e12.jpg', 'c4a70000-0000-0000-0000-000000000005'),
  'nobody uploads into a channel they can''t post in');
insert into public.chat_messages (company_id, channel_id, author_id, attachments)
values (:'co', :'north_ch', 'c4a70000-0000-0000-0000-000000000005', jsonb_build_array(jsonb_build_object('path', :'co' || '/chat/' || :'north_ch' || '/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e11.jpg', 'name', 'before.jpg')))
returning id as photo_msg \gset
select tch.check(:'photo_msg' is not null, 'a photo on its own is a message');
select tch.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, attachments) values (%L, %L, %L, %L)', :'co', :'general', 'c4a70000-0000-0000-0000-000000000005',
  jsonb_build_array(jsonb_build_object('path', :'co' || '/chat/' || :'north_ch' || '/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e11.jpg'))), 'a photo can''t be borrowed from another channel');
update public.chat_messages set deleted_at = now() where id = :'photo_msg';
select tch.check((select deleted_at is not null and attachments = '[]' and body = '' from public.chat_messages where id = :'photo_msg'), 'deleting a message clears what it said');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select tch.check((select count(*) from storage.objects where name like '%/chat/%') = 0, 'Ben can''t open North''s photos');
commit;

-- ===== Custom roles follow their level until they get rules of their own ======================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select tch.check((select array_agg(name order by position) from public.chat_overview(:'co')) = array['Announcements', 'general', 'north-crew'], 'seasonal help starts with what field crew see');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.chat_save_roles(:'co',
  jsonb_build_array(
    jsonb_build_object('role', 'field_crew', 'color', 'default', 'own_crew_only', true),
    jsonb_build_object('role', 'office', 'color', 'blue', 'mentionable', false),
    jsonb_build_object('role_id', :'seasonal', 'color', 'teal', 'own_crew_only', true)
  ),
  (select jsonb_agg(jsonb_build_object('channel_id', r.channel_id, 'role', r.role, 'can_see', r.can_see, 'can_post', r.can_post, 'can_manage', r.can_manage)) from public.chat_role_rules r where r.company_id = :'co')
  || jsonb_build_array(
    jsonb_build_object('channel_id', :'general', 'role_id', :'seasonal', 'can_see', false),
    jsonb_build_object('channel_id', :'ann', 'role_id', :'seasonal', 'can_see', true, 'can_post', true)
  ));
select tch.check((select color = 'teal' from public.chat_role_settings where role_id = :'seasonal'), 'roles save their chat color');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select tch.check((select array_agg(name order by position) from public.chat_overview(:'co')) = array['Announcements', 'north-crew'], 'seasonal help''s own rule takes them out of #general');
select tch.check((select can_post from public.chat_overview(:'co') where id = :'ann'), 'and lets them post announcements');
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'north_ch', 'c4a70000-0000-0000-0000-000000000007', '<@&office> where are the keys?') returning id as sam_msg \gset
select tch.check((select mention_roles = '{}' from public.chat_messages where id = :'sam_msg'), 'a role that isn''t open to mentions isn''t pinged by just anyone');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'north_ch', 'c4a70000-0000-0000-0000-000000000004', '<@&office> keys are in truck 3') returning id as lead_msg \gset
select tch.check((select mention_roles = array['office'] from public.chat_messages where id = :'lead_msg'), 'but the channel''s manager can');
commit;

-- ===== New crews, other businesses, and turning it off ========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.crews (company_id, name) values (:'co', 'Irrigation') returning id as irrigation \gset
select tch.check((select count(*) from public.chat_channels where company_id = :'co' and crew_id = :'irrigation' and name = 'irrigation') = 1, 'a new crew gets its own channel');
select public.chat_create_channel(:'co', 'Equipment & Trucks', 'everyone') as equip \gset
select tch.check((select name = 'equipment-trucks' from public.chat_channels where id = :'equip'), 'a new channel''s name is made tidy');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select tch.check((select count(*) from public.chat_channels where company_id = :'co') = 0 and (select count(*) from public.chat_messages where company_id = :'co') = 0, 'another business sees none of it');
select tch.expect_error(format('select public.chat_set_enabled(%L, false)', :'co'), 'or turns it off');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tch.check(not public.chat_set_enabled(:'co', false), 'the owner turns chat off');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select tch.check((select count(*) from public.chat_overview(:'co')) = 0 and (select count(*) from public.chat_messages where company_id = :'co') = 0, 'chat off: Tyler sees nothing');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4a70000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tch.check(public.chat_set_enabled(:'co', true), 'turned back on');
select tch.check((select count(*) from public.chat_channels where company_id = :'co') = 7, 'it keeps the channels it had, without making new ones');
commit;

select tch.check((select count(*) from public.chat_messages where company_id = :'co') = 5, 'and every message is still there');

-- Topics: chat is one of them, and on for push.
select tch.check((select column_default like '%chat%' from information_schema.columns where table_name = 'notification_prefs' and column_name = 'push'), 'chat mentions come by push unless turned off');
