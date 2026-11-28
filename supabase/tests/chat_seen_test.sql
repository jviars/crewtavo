-- Database tests for "Seen by" (20261129101300_chat_seen.sql): an announcement's author and the
-- channel's managers see how many of the channel's people have read it and who, nobody else does;
-- someone who left isn't counted; other channels have no answer; and in a direct conversation only its
-- people see how far the others have read.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tsn;
grant usage on schema tsn to authenticated, service_role;
create function tsn.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tsn to authenticated, service_role;

-- Jo owns Romeo Lawn; Ava is an admin, Dana office, Mateo leads a crew, Toby, Sid and Bo are field crew.
insert into auth.users (id, email, raw_user_meta_data) values
  ('dc040000-0000-0000-0000-000000000001', 'jo@romeo.test', '{"full_name": "Jo Quinn"}'),
  ('dc040000-0000-0000-0000-000000000002', 'ava@romeo.test', '{"full_name": "Ava Stone"}'),
  ('dc040000-0000-0000-0000-000000000003', 'dana@romeo.test', '{"full_name": "Dana Hale"}'),
  ('dc040000-0000-0000-0000-000000000004', 'mateo@romeo.test', '{"full_name": "Mateo Cruz"}'),
  ('dc040000-0000-0000-0000-000000000005', 'toby@romeo.test', '{"full_name": "Toby Lane"}'),
  ('dc040000-0000-0000-0000-000000000006', 'sid@romeo.test', '{"full_name": "Sid Moss"}'),
  ('dc040000-0000-0000-0000-000000000007', 'bo@romeo.test', '{"full_name": "Bo Hart"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Romeo Lawn', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'dc040000-0000-0000-0000-000000000003', 'office'),
  (:'co', 'dc040000-0000-0000-0000-000000000004', 'crew_lead'),
  (:'co', 'dc040000-0000-0000-0000-000000000005', 'field_crew'),
  (:'co', 'dc040000-0000-0000-0000-000000000006', 'field_crew'),
  (:'co', 'dc040000-0000-0000-0000-000000000007', 'field_crew');
select tsn.check(public.chat_set_enabled(:'co', true), 'the owner turns chat on');
select id as ann from public.chat_channels where company_id = :'co' and kind = 'announcement' \gset
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', 'dc040000-0000-0000-0000-000000000002', 'admin');
update public.memberships set active = false where company_id = :'co' and user_id = 'dc040000-0000-0000-0000-000000000007';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'ann', 'dc040000-0000-0000-0000-000000000003', 'Office closed Thursday') returning id as a1 \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'dc040000-0000-0000-0000-000000000003', 'Pizza at noon') returning id as g1 \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select public.chat_mark_read(:'ann');
select public.chat_mark_read(:'general');
-- Toby reads it, but isn't its author or a manager: he isn't told who else has.
select tsn.check((select count(*) from public.chat_seen_counts(:'ann', array[:'a1']::uuid[])) = 0, 'field crew don''t see who has read an announcement');
select tsn.check((select count(*) from public.chat_seen_list(:'a1')) = 0, 'or the list of who has');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tsn.check((select count(*) from public.chat_seen_counts(:'ann', array[:'a1']::uuid[])) = 0, 'nor does a crew lead who doesn''t manage the channel');
commit;

-- Its author: of the five who can see it besides her (Jo, Ava, Mateo, Toby, Sid; not Bo, who left), one has read it.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tsn.check((select seen = 1 and total = 5 from public.chat_seen_counts(:'ann', array[:'a1']::uuid[])), 'Dana sees her announcement was seen by 1 of 5');
select tsn.check((select array_agg(user_id) from public.chat_seen_list(:'a1') where seen_at is not null) = array['dc040000-0000-0000-0000-000000000005']::uuid[]
  and (select count(*) from public.chat_seen_list(:'a1') where seen_at is null) = 4, 'Toby has seen it, four haven''t yet');
select tsn.check(not exists (select 1 from public.chat_seen_list(:'a1') where user_id in ('dc040000-0000-0000-0000-000000000007', 'dc040000-0000-0000-0000-000000000003')), 'Bo, who left, and Dana herself aren''t in it');
select tsn.check((select count(*) from public.chat_seen_counts(:'general', array[:'g1']::uuid[])) = 0, 'a text channel has no "seen by"');
commit;

-- Managers: the owner and an admin see it for every announcement.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.chat_mark_read(:'ann');
select tsn.check((select seen = 2 and total = 5 from public.chat_seen_counts(:'ann', array[:'a1']::uuid[])), 'the owner sees it too, and her own reading counts');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tsn.check((select count(*) from public.chat_seen_list(:'a1')) = 5, 'and so does an admin');
commit;

-- ===== A direct conversation ===============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.chat_start_direct(:'co', array['dc040000-0000-0000-0000-000000000004', 'dc040000-0000-0000-0000-000000000005']::uuid[]) as dm \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'dm', 'dc040000-0000-0000-0000-000000000003', 'Trailer lights are out');
select tsn.check((select count(*) from public.chat_read_marks(:'dm') where last_read_at is not null) = 0, 'nobody else has read the group yet');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select public.chat_mark_read(:'dm');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tsn.check((select array_agg(user_id) from public.chat_read_marks(:'dm') where last_read_at is not null) = array['dc040000-0000-0000-0000-000000000004']::uuid[]
  and (select count(*) from public.chat_read_marks(:'dm')) = 2, 'Dana sees Mateo has read it, and Toby not yet');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "dc040000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tsn.check((select count(*) from public.chat_read_marks(:'dm')) = 0, 'the owner can''t see who read someone else''s conversation');
select tsn.check((select count(*) from public.chat_read_marks(:'ann')) = 0, 'and a channel has no read marks');
commit;
