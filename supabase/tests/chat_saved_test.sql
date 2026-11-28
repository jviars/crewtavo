-- Database tests for Saved for later in team chat (20261129102300_chat_saved.sql): a person saves
-- messages they can read, sees only their own saved ones and only while they can still read the
-- channel, can't save for someone else or read anyone else's, and a deleted message leaves
-- everyone's saved.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema csv;
grant usage on schema csv to authenticated, service_role;
create function csv.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function csv.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema csv to authenticated, service_role;

-- Nia owns Oak Pools; Ray is office; Sol is on North; Ted is on South.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c9ea0000-0000-0000-0000-000000000001', 'nia@oak.test', '{"full_name": "Nia Cole"}'),
  ('c9ea0000-0000-0000-0000-000000000002', 'ray@oak.test', '{"full_name": "Ray Moss"}'),
  ('c9ea0000-0000-0000-0000-000000000003', 'sol@oak.test', '{"full_name": "Sol Reyes"}'),
  ('c9ea0000-0000-0000-0000-000000000004', 'ted@oak.test', '{"full_name": "Ted Fox"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Oak Pools', 'pools') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c9ea0000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'c9ea0000-0000-0000-0000-000000000003', 'field_crew'),
  (:'co', 'c9ea0000-0000-0000-0000-000000000004', 'field_crew');
insert into public.crews (company_id, name) values (:'co', 'North') returning id as north \gset
insert into public.crews (company_id, name) values (:'co', 'South') returning id as south \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'north', 'c9ea0000-0000-0000-0000-000000000003'), (:'co', :'south', 'c9ea0000-0000-0000-0000-000000000004');
select public.chat_set_enabled(:'co', true);
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
select id as north_ch from public.chat_channels where company_id = :'co' and name = 'north' \gset
select id as office_ch from public.chat_channels where company_id = :'co' and name = 'office' \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'north_ch', 'c9ea0000-0000-0000-0000-000000000001', 'North: the chlorine order is in the shed') returning id as north_msg \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'c9ea0000-0000-0000-0000-000000000001', 'Holiday hours are posted') returning id as general_msg \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'office_ch', 'c9ea0000-0000-0000-0000-000000000001', 'Payroll goes out Friday') returning id as office_msg \gset
commit;

-- ===== Sol saves what he can read =============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9ea0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_saved (message_id, user_id) values (:'north_msg', 'c9ea0000-0000-0000-0000-000000000003');
insert into public.chat_saved (message_id, user_id) values (:'general_msg', 'c9ea0000-0000-0000-0000-000000000003');
select csv.check((select count(*) from public.chat_saved) = 2, 'Sol saves two messages and sees them');
select csv.check((select channel_id = :'north_ch' and company_id = :'co' from public.chat_saved where message_id = :'north_msg'), 'a saved message goes with its channel');
select csv.expect_error(format('insert into public.chat_saved (message_id, user_id) values (%L, %L)', :'office_msg', 'c9ea0000-0000-0000-0000-000000000003'), 'he can''t save a message in a channel he can''t read');
select csv.expect_error(format('insert into public.chat_saved (message_id, user_id) values (%L, %L)', :'general_msg', 'c9ea0000-0000-0000-0000-000000000004'), 'or save one for someone else');
select csv.expect_error(format('insert into public.chat_saved (message_id, user_id) values (%L, %L)', :'general_msg', 'c9ea0000-0000-0000-0000-000000000003'), 'or save the same one twice');
select csv.expect_error(format('insert into public.chat_saved (message_id, user_id, channel_id, company_id) values (%L, %L, %L, %L)', :'office_msg', 'c9ea0000-0000-0000-0000-000000000003', :'general', :'co'), 'and the office''s message can''t be passed off as one in #general');
select csv.expect_error('update public.chat_saved set created_at = now() - interval ''1 year''', 'nothing about a saved message changes');
commit;

-- ===== Nobody reads or takes out anyone else's =================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9ea0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select csv.check((select count(*) from public.chat_saved) = 0, 'Ray (office) can''t read Sol''s saved messages, though he can read the messages');
delete from public.chat_saved where user_id = 'c9ea0000-0000-0000-0000-000000000003';
insert into public.chat_saved (message_id, user_id) values (:'general_msg', 'c9ea0000-0000-0000-0000-000000000002');
select csv.check((select count(*) from public.chat_saved) = 1, 'he sees only his own');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select csv.check((select count(*) from public.chat_saved) = 0, 'not even the owner reads anyone else''s');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9ea0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select csv.check((select count(*) from public.chat_saved) = 2, 'Sol''s are still there: nobody else took them out');
select csv.expect_error(format('insert into public.chat_saved (message_id, user_id) values (%L, %L)', '00000000-0000-4000-8000-00000000dead', 'c9ea0000-0000-0000-0000-000000000003'), 'a message that isn''t there can''t be saved');
commit;

select csv.check((select count(*) from public.chat_saved where company_id = :'co') = 3, 'three saved in all');

-- ===== Losing the channel hides them; a deleted message leaves everyone's saved ===============
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- Field crew no longer see #general.
select public.chat_save_roles(:'co',
  (select jsonb_agg(jsonb_build_object('role', s.role, 'role_id', s.role_id, 'color', s.color, 'show_separately', s.show_separately, 'mentionable', s.mentionable, 'own_crew_only', s.own_crew_only)) from public.chat_role_settings s where s.company_id = :'co'),
  (select jsonb_agg(jsonb_build_object('channel_id', r.channel_id, 'role', r.role, 'can_see', not (r.channel_id = :'general' and r.role = 'field_crew') and r.can_see, 'can_post', r.can_post, 'can_manage', r.can_manage)) from public.chat_role_rules r where r.company_id = :'co'));
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9ea0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select csv.check((select array_agg(message_id) from public.chat_saved) = array[:'north_msg'::uuid], 'once Sol can''t read #general, its message isn''t in his saved');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.chat_messages set deleted_at = now() where id = :'general_msg';
commit;

select csv.check((select count(*) from public.chat_saved where message_id = :'general_msg') = 0, 'deleting a message takes it out of everyone''s saved');
select csv.check((select count(*) from public.chat_saved where message_id = :'north_msg') = 1, 'and leaves the rest');
