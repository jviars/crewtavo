-- Database tests for calendar feeds and the assistant log: people see their own feed exists but
-- never its token, and only owners and admins read what assistants did.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t6;
grant usage on schema t6 to authenticated, service_role;
create function t6.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t6.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t6 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a6000000-0000-0000-0000-000000000001', 'owner@golf.test', '{"full_name": "Gus Owner"}'),
  ('a6000000-0000-0000-0000-000000000002', 'crew@golf.test', '{"full_name": "Cleo Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a6000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Golf Grounds', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'a6000000-0000-0000-0000-000000000002', 'field_crew');
commit;

-- The server writes feeds and the assistant log.
insert into public.calendar_feeds (company_id, user_id, scope, token_hash, token_sealed) values
  (:'co', 'a6000000-0000-0000-0000-000000000002', 'mine', 'hash-crew', 'sealed-crew'),
  (:'co', 'a6000000-0000-0000-0000-000000000001', 'all', 'hash-owner', 'sealed-owner');
insert into public.assistant_calls (company_id, user_id, tool, ok) values (:'co', 'a6000000-0000-0000-0000-000000000002', 'search_clients', true);

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a6000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t6.check((select count(*) from public.calendar_feeds where company_id = :'co') = 1, 'people see only their own calendar feed');
select t6.check((select scope from public.calendar_feeds where user_id = 'a6000000-0000-0000-0000-000000000002') = 'mine', 'and what it shows');
select t6.expect_error('select token_hash from public.calendar_feeds', 'but never its token');
select t6.expect_error(format('insert into public.calendar_feeds (company_id, user_id, token_hash, token_sealed) values (%L, %L, %L, %L)', :'co', 'a6000000-0000-0000-0000-000000000002', 'x', 'y'), 'and can''t make one directly');
select t6.check((select count(*) from public.assistant_calls where company_id = :'co') = 0, 'crew can''t read the assistant log');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a6000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t6.check((select count(*) from public.assistant_calls where company_id = :'co') = 1, 'the owner reads the assistant log');
select t6.expect_error(format('delete from public.assistant_calls where company_id = %L', :'co'), 'nobody edits the log, not even the owner');
commit;

\echo 'All access tests passed.'
