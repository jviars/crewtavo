-- Database tests for reactions with emoji (20261129102100_chat_reaction_emoji.sql): the three quick
-- reactions and the listed emoji go on, anything else doesn't; nobody reacts where they can't read
-- or as someone else; and a message takes at most 20 kinds, 12 from one person.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema crx;
grant usage on schema crx to authenticated, service_role;
create function crx.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function crx.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema crx to authenticated, service_role;

-- Ivy owns Pine Roofing; Gus is on the field crew of North; Hal is on South.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c6ea0000-0000-0000-0000-000000000001', 'ivy@pine.test', '{"full_name": "Ivy Park"}'),
  ('c6ea0000-0000-0000-0000-000000000002', 'gus@pine.test', '{"full_name": "Gus Lee"}'),
  ('c6ea0000-0000-0000-0000-000000000003', 'hal@pine.test', '{"full_name": "Hal Ng"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c6ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Pine Roofing', 'roofing') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c6ea0000-0000-0000-0000-000000000002', 'field_crew'),
  (:'co', 'c6ea0000-0000-0000-0000-000000000003', 'field_crew');
insert into public.crews (company_id, name) values (:'co', 'North') returning id as north \gset
insert into public.crews (company_id, name) values (:'co', 'South') returning id as south \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'north', 'c6ea0000-0000-0000-0000-000000000002'), (:'co', :'south', 'c6ea0000-0000-0000-0000-000000000003');
select public.chat_set_enabled(:'co', true);
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
select id as north_ch from public.chat_channels where company_id = :'co' and name = 'north' \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'c6ea0000-0000-0000-0000-000000000001', 'Tear-off starts at 7') returning id as msg \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'north_ch', 'c6ea0000-0000-0000-0000-000000000001', 'North: shingles are on the truck') returning id as north_msg \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c6ea0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.chat_reactions (message_id, user_id, kind) values (:'msg', 'c6ea0000-0000-0000-0000-000000000002', 'on_it');
insert into public.chat_reactions (message_id, user_id, kind) values (:'msg', 'c6ea0000-0000-0000-0000-000000000002', '🔥');
insert into public.chat_reactions (message_id, user_id, kind) values (:'msg', 'c6ea0000-0000-0000-0000-000000000002', '👷');
insert into public.chat_reactions (message_id, user_id, kind) values (:'msg', 'c6ea0000-0000-0000-0000-000000000002', '😮‍💨');
select crx.check((select array_agg(kind order by created_at, kind) from public.chat_reactions where message_id = :'msg') @> array['on_it', '🔥', '👷', '😮‍💨'], 'a quick reaction and listed emoji go on');
select crx.expect_error(format('insert into public.chat_reactions (message_id, user_id, kind) values (%L, %L, %L)', :'msg', 'c6ea0000-0000-0000-0000-000000000002', '🦄'), 'an emoji that isn''t listed doesn''t');
select crx.expect_error(format('insert into public.chat_reactions (message_id, user_id, kind) values (%L, %L, %L)', :'msg', 'c6ea0000-0000-0000-0000-000000000002', 'hello'), 'nor do words');
select crx.expect_error(format('insert into public.chat_reactions (message_id, user_id, kind) values (%L, %L, %L)', :'msg', 'c6ea0000-0000-0000-0000-000000000003', '🔥'), 'nobody reacts as someone else');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c6ea0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select crx.expect_error(format('insert into public.chat_reactions (message_id, user_id, kind) values (%L, %L, %L)', :'north_msg', 'c6ea0000-0000-0000-0000-000000000003', '🔥'), 'Hal (South) can''t react in North''s channel');
select crx.check((select count(*) from public.chat_reactions where message_id = :'north_msg') = 0, 'or see its reactions');
commit;

-- At most 12 from one person on a message.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c6ea0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.chat_reactions (message_id, user_id, kind)
select :'msg', 'c6ea0000-0000-0000-0000-000000000002', e from unnest(array['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣']) e;
select crx.check((select count(*) from public.chat_reactions where message_id = :'msg' and user_id = 'c6ea0000-0000-0000-0000-000000000002') = 12, 'Gus has 12 reactions on it');
select crx.expect_error(format('insert into public.chat_reactions (message_id, user_id, kind) values (%L, %L, %L)', :'msg', 'c6ea0000-0000-0000-0000-000000000002', '🙂'), 'a 13th is one too many');
insert into public.chat_reactions (message_id, user_id, kind) values (:'msg', 'c6ea0000-0000-0000-0000-000000000002', '🔥') on conflict do nothing;
select crx.check(true, 'adding one he has already is no error');
commit;

-- At most 20 kinds on a message: Hal and Ivy add more.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c6ea0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_reactions (message_id, user_id, kind)
select :'msg', 'c6ea0000-0000-0000-0000-000000000003', e from unnest(array['🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩']) e;
select crx.check((select count(distinct kind) from public.chat_reactions where message_id = :'msg') = 20, 'the message has 20 kinds of reaction');
select crx.expect_error(format('insert into public.chat_reactions (message_id, user_id, kind) values (%L, %L, %L)', :'msg', 'c6ea0000-0000-0000-0000-000000000003', '😘'), 'a 21st kind is refused');
insert into public.chat_reactions (message_id, user_id, kind) values (:'msg', 'c6ea0000-0000-0000-0000-000000000003', '🔥');
select crx.check((select count(*) from public.chat_reactions where message_id = :'msg' and kind = '🔥') = 2, 'but anyone can add one of the kinds it has');
commit;
