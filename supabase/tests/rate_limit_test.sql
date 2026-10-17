-- Database tests for rate limits: counting, windows starting over, keys kept as hashes, old
-- windows cleared, and only the API's service key can use them.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t8;
grant usage on schema t8 to anon, authenticated, service_role;
create function t8.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t8.expect_error(p_sql text, p_what text, p_like text default '%') returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm not like p_like then raise exception 'FAIL (wrong error "%"): %', sqlerrm, p_what; end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t8 to anon, authenticated, service_role;

-- How the API calls it: as the service role.
set role service_role;
select t8.check(public.rate_limit_hit('promo:203.0.113.9', 3, 600), 'the first try is allowed');
select t8.check(public.rate_limit_hit('promo:203.0.113.9', 3, 600), 'so is the second');
select t8.check(public.rate_limit_hit('promo:203.0.113.9', 3, 600), 'and the third');
select t8.check(not public.rate_limit_hit('promo:203.0.113.9', 3, 600), 'the fourth inside the window is refused');
select t8.check(not public.rate_limit_hit('promo:203.0.113.9', 3, 600), 'and so is every try after it');
select t8.check(public.rate_limit_hit('promo:198.51.100.7', 3, 600), 'someone else has their own count');
select t8.check(public.rate_limit_hit('hub-message:203.0.113.9', 3, 600), 'and so does each kind of limit');
reset role;

select t8.check((select hits from private.rate_limits where key_hash = sha256(convert_to('promo:203.0.113.9', 'UTF8'))) = 4,
  'refused tries stop counting just past the limit');
select t8.check((select reset_at between now() + interval '599 seconds' and now() + interval '601 seconds'
  from private.rate_limits where key_hash = sha256(convert_to('promo:203.0.113.9', 'UTF8'))), 'the window runs from the first try');
select t8.check((select count(*) from private.rate_limits where position(convert_to('203.0.113', 'UTF8') in key_hash) > 0) = 0,
  'IP addresses aren''t stored, only hashes of the keys');

-- When the window ends the count starts over.
update private.rate_limits set reset_at = now() - interval '1 second' where key_hash = sha256(convert_to('promo:203.0.113.9', 'UTF8'));
set role service_role;
select t8.check(public.rate_limit_hit('promo:203.0.113.9', 3, 600), 'after the window ends, tries are allowed again');
reset role;
select t8.check((select hits = 1 and reset_at > now() from private.rate_limits where key_hash = sha256(convert_to('promo:203.0.113.9', 'UTF8'))),
  'with a fresh count and a new window');

-- Finished windows are cleared as new tries come in.
insert into private.rate_limits (key_hash, hits, reset_at)
select sha256(convert_to('old:' || i, 'UTF8')), 1, now() - interval '1 hour' from generate_series(1, 5) i;
set role service_role;
select public.rate_limit_hit('promo:192.0.2.1', 3, 600);
reset role;
select t8.check((select count(*) from private.rate_limits where reset_at < now()) = 0, 'finished windows are cleared');
select t8.check((select count(*) from private.rate_limits where reset_at > now()) = 4, 'current ones are kept');

-- Bad arguments are refused with a readable message.
set role service_role;
select t8.expect_error($$select public.rate_limit_hit('', 3, 600)$$, 'an empty key is refused', '%1 to 200 characters%');
select t8.expect_error(format('select public.rate_limit_hit(%L, 3, 600)', repeat('x', 201)), 'so is a very long one', '%1 to 200 characters%');
select t8.expect_error($$select public.rate_limit_hit('k', 0, 600)$$, 'a limit allows at least one try', '%at least one%');
select t8.expect_error($$select public.rate_limit_hit('k', 3, 0)$$, 'a window can''t be empty', '%1 second to 1 day%');
select t8.expect_error($$select public.rate_limit_hit('k', 3, 86401)$$, 'or longer than a day', '%1 second to 1 day%');
reset role;

-- Nobody but the API can use the limiter or see the counts. Otherwise anyone could use up a
-- stranger's tries.
set role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8000000-0000-0000-0000-000000000001", "role": "authenticated"}', false);
select t8.expect_error($$select public.rate_limit_hit('promo:198.51.100.7', 3, 600)$$, 'signed-in people can''t count tries', '%permission denied%');
select t8.expect_error('select count(*) from private.rate_limits', 'or read the counts', '%permission denied%');
reset role;
set role anon;
select t8.expect_error($$select public.rate_limit_hit('promo:198.51.100.7', 3, 600)$$, 'neither can visitors', '%permission denied%');
reset role;
select set_config('request.jwt.claims', '', false);

\echo 'All rate limit tests passed.'
