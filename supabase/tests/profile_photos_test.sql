-- Database tests for profile photos: only the API sets someone's photo, and it can only point at
-- that person's own photo in the files bucket. Names and colors stay theirs to change.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tphoto;
grant usage on schema tphoto to authenticated, service_role;
create function tphoto.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tphoto.expect_error(p_sql text, p_what text, p_like text default '%') returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm not like p_like then raise exception 'FAIL (wrong error "%"): %', sqlerrm, p_what; end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tphoto to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('f6700000-0000-0000-0000-000000000001', 'owner@photo.test', '{"full_name": "Pia Owner"}'),
  ('f6700000-0000-0000-0000-000000000002', 'crew@photo.test', '{"full_name": "Cy Crew"}');

-- People change their own name and color, but not their photo: that goes through the API.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f6700000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.profiles set full_name = 'Cy Crewman', color = '#3b7d23' where user_id = 'f6700000-0000-0000-0000-000000000002';
select tphoto.check((select full_name = 'Cy Crewman' from public.profiles where user_id = 'f6700000-0000-0000-0000-000000000002'), 'someone still changes their own name and color');
select tphoto.expect_error(
  $$update public.profiles set avatar_url = 'c0ffee00-0000-0000-0000-000000000000/plans/plan.pdf' where user_id = 'f6700000-0000-0000-0000-000000000002'$$,
  'but not their photo, which could point at any file', '%permission denied%');
commit;

-- The API (service role) sets photos, only at the person's own photo path.
set role service_role;
update public.profiles set avatar_url = 'c0ffee00-0000-0000-0000-000000000000/avatars/f6700000-0000-0000-0000-000000000002/0a0a0a0a-0000-0000-0000-000000000000.jpg'
where user_id = 'f6700000-0000-0000-0000-000000000002';
select tphoto.check((select avatar_url like '%/avatars/f6700000-0000-0000-0000-000000000002/%' from public.profiles where user_id = 'f6700000-0000-0000-0000-000000000002'), 'the API sets a photo');
select tphoto.expect_error(
  $$update public.profiles set avatar_url = 'c0ffee00-0000-0000-0000-000000000000/avatars/f6700000-0000-0000-0000-000000000001/0a0a0a0a-0000-0000-0000-000000000000.jpg' where user_id = 'f6700000-0000-0000-0000-000000000002'$$,
  'not someone else''s photo', '%profiles_avatar_url_check%');
select tphoto.expect_error(
  $$update public.profiles set avatar_url = 'c0ffee00-0000-0000-0000-000000000000/receipts/f6700000-0000-0000-0000-000000000002/0a0a0a0a-0000-0000-0000-000000000000.jpg' where user_id = 'f6700000-0000-0000-0000-000000000002'$$,
  'nor another kind of file', '%profiles_avatar_url_check%');
update public.profiles set avatar_url = null where user_id = 'f6700000-0000-0000-0000-000000000002';
select tphoto.check((select avatar_url is null from public.profiles where user_id = 'f6700000-0000-0000-0000-000000000002'), 'and removes it');
reset role;

\echo 'All profile photo tests passed.'
