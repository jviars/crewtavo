-- Database tests for 20261125100210_conversations_done.sql: the office marks a client's conversation
-- done, for everyone; the mark is always now; a reply or the client writing again decides the rest;
-- and only those who answer messages, in that company, read or write marks.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1124c;
grant usage on schema t1124c to anon, authenticated, service_role;
create function t1124c.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1124c.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1124c.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1124c to anon, authenticated, service_role;

\set owner 'b1124c00-0000-0000-0000-000000000001'
\set crew 'b1124c00-0000-0000-0000-000000000002'
\set other 'b1124c00-0000-0000-0000-000000000003'
insert into auth.users (id, email) values (:'owner', 'olive@greens.test'), (:'crew', 'cal@greens.test'), (:'other', 'otto@elsewhere.test');

begin;
set local role authenticated;
select t1124c.as_user(:'owner');
select public.create_company('Olive Greens', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat') returning id as pat \gset
insert into public.clients (company_id, display_name) values (:'co', 'Sam') returning id as sam \gset
select t1124c.as_user(:'other');
select public.create_company('Elsewhere', 'general') as co2 \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', :'crew', 'field_crew');

-- Pat texted an hour ago; Sam texted and was answered.
insert into public.messages (company_id, client_id, channel, direction, body, status, created_at) values
  (:'co', :'pat', 'sms', 'in', 'Thanks!', 'received', now() - interval '1 hour'),
  (:'co', :'sam', 'sms', 'in', 'Can you come Tuesday?', 'received', now() - interval '2 hours'),
  (:'co', :'sam', 'sms', 'out', 'Tuesday works.', 'sent', now() - interval '90 minutes');

\o
\echo 'A conversation marked done'
\o /dev/null

begin;
set local role authenticated;
select t1124c.as_user(:'owner');
select t1124c.check(public.waiting_conversations(:'co') = 1, 'one conversation waits: the client spoke last, the answered one doesn''t');
insert into public.conversations_done (company_id, client_id, done_at) values (:'co', :'pat', now() + interval '1 year');
select t1124c.check(done_at <= now() and done_by = :'owner'::uuid, 'the mark is now and by whoever made it, whatever was sent') from public.conversations_done where client_id = :'pat';
select t1124c.check(public.waiting_conversations(:'co') = 0, 'marked done, it no longer waits');
commit;

-- Pat writes again.
insert into public.messages (company_id, client_id, channel, direction, body, status) values (:'co', :'pat', 'email', 'in', 'One more thing', 'received');
begin;
set local role authenticated;
select t1124c.as_user(:'owner');
select t1124c.check(public.waiting_conversations(:'co') = 1, 'the client writing again makes it wait again');
update public.conversations_done set done_at = now() where client_id = :'pat';
select t1124c.check(public.waiting_conversations(:'co') = 0, 'marked done again');
commit;

\o
\echo 'Who reads and writes marks'
\o /dev/null

begin;
set local role authenticated;
select t1124c.as_user(:'crew');
select t1124c.check((select count(*) from public.conversations_done) = 0, 'the crew doesn''t read them');
select t1124c.check(t1124c.error_of(format('insert into public.conversations_done (company_id, client_id) values (%L, %L)', :'co', :'sam')) like '42501:%', 'or mark one');
select t1124c.as_user(:'other');
select t1124c.check((select count(*) from public.conversations_done) = 0, 'another company doesn''t read them');
select t1124c.check(t1124c.error_of(format('insert into public.conversations_done (company_id, client_id) values (%L, %L)', :'co', :'sam')) like '42501:%', 'or mark one of this company''s');
select t1124c.check(t1124c.error_of(format('insert into public.conversations_done (company_id, client_id) values (%L, %L)', :'co2', :'sam')) like '23503:%', 'nor mark this company''s client as its own');
select t1124c.check(public.waiting_conversations(:'co') = 0, 'and counts none of its waiting');
commit;

delete from public.clients where id = :'pat';
select t1124c.check(not exists (select 1 from public.conversations_done where client_id = :'pat'), 'a deleted client''s mark goes with them');

\echo 'All tests of conversations marked done passed.'
