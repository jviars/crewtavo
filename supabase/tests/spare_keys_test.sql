-- Database tests for spare keys: each works once, a new set replaces the old one, and only the
-- API's service key can make, use or count them.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t9;
grant usage on schema t9 to anon, authenticated, service_role;
create function t9.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t9.expect_error(p_sql text, p_what text, p_like text default '%') returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm not like p_like then raise exception 'FAIL (wrong error "%"): %', sqlerrm, p_what; end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t9 to anon, authenticated, service_role;

insert into auth.users (id, email) values
  ('a9000000-0000-0000-0000-000000000001', 'owner@spare.test'),
  ('a9000000-0000-0000-0000-000000000002', 'other@spare.test');

-- How the API calls them: as the service role, with HMAC hashes (64 hex characters).
set role service_role;
select t9.check(public.spare_keys_replace('a9000000-0000-0000-0000-000000000001', array[repeat('a', 64), repeat('b', 64), repeat('c', 64)]) = 3, 'a set of three is saved');
select t9.check(public.spare_keys_left('a9000000-0000-0000-0000-000000000001') = 3, 'all three are unused');
select t9.check(public.spare_key_use('a9000000-0000-0000-0000-000000000001', repeat('a', 64)), 'a saved key works');
select t9.check(not public.spare_key_use('a9000000-0000-0000-0000-000000000001', repeat('a', 64)), 'but only once');
select t9.check(public.spare_keys_left('a9000000-0000-0000-0000-000000000001') = 2, 'two are left');
select t9.check(not public.spare_key_use('a9000000-0000-0000-0000-000000000001', repeat('d', 64)), 'a key that was never saved doesn''t work');
select t9.check(not public.spare_key_use('a9000000-0000-0000-0000-000000000002', repeat('b', 64)), 'nor does someone else''s key on another account');

-- A new set replaces the old one entirely.
select t9.check(public.spare_keys_replace('a9000000-0000-0000-0000-000000000001', array[repeat('e', 64)]) = 1, 'a new set is saved');
select t9.check(not public.spare_key_use('a9000000-0000-0000-0000-000000000001', repeat('b', 64)), 'the old keys stop working');
select t9.check(public.spare_keys_left('a9000000-0000-0000-0000-000000000001') = 1, 'only the new one is left');

-- Bad arguments are refused with a readable message.
select t9.expect_error($$select public.spare_keys_replace('a9000000-0000-0000-0000-000000000001', array[]::text[])$$, 'an empty set is refused', '%1 to 20 codes%');
select t9.expect_error(format('select public.spare_keys_replace(%L, %L::text[])', 'a9000000-0000-0000-0000-000000000001', (select array_agg(repeat('f', 64)) from generate_series(1, 21))), 'so is a huge one', '%1 to 20 codes%');
select t9.expect_error($$select public.spare_keys_replace('a9000000-0000-0000-0000-000000000001', array['short'])$$, 'a hash has to be a full HMAC', '%check constraint%');
reset role;

-- Nobody but the API can make, use or count spare keys, or read them. Otherwise anyone could
-- replace an owner's keys with their own, or use up a stranger's.
set role authenticated;
select set_config('request.jwt.claims', '{"sub": "a9000000-0000-0000-0000-000000000001", "role": "authenticated"}', false);
select t9.expect_error($$select public.spare_keys_replace('a9000000-0000-0000-0000-000000000001', array[repeat('9', 64)])$$, 'signed-in people can''t make keys, even for themselves', '%permission denied%');
select t9.expect_error($$select public.spare_key_use('a9000000-0000-0000-0000-000000000001', repeat('e', 64))$$, 'or use them', '%permission denied%');
select t9.expect_error($$select public.spare_keys_left('a9000000-0000-0000-0000-000000000001')$$, 'or count them', '%permission denied%');
select t9.expect_error('select count(*) from private.spare_keys', 'or read the table', '%permission denied%');
reset role;
set role anon;
select t9.expect_error($$select public.spare_key_use('a9000000-0000-0000-0000-000000000001', repeat('e', 64))$$, 'neither can visitors', '%permission denied%');
reset role;
select set_config('request.jwt.claims', '', false);

\echo 'All spare key tests passed.'
