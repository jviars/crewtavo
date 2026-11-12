-- Database tests for 20261112000410_one_running_clock.sql: a person has one running clock, kept
-- without turning a clock-in away (a second start stops the first, a late one ends where the
-- running one began, two at once take turns), and the repair of people who already had two.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tclock;
grant usage on schema tclock to anon, authenticated, service_role;
create function tclock.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tclock.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function tclock.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- Whether a session is waiting for a lock another holds (checked for up to 10 seconds).
create function tclock.waits(p_pid integer) returns boolean language plpgsql as $$
begin
  for i in 1 .. 200 loop
    if cardinality(pg_blocking_pids(p_pid)) > 0 then return true; end if;
    perform pg_sleep(0.05);
  end loop;
  return false;
end $$;
-- How many clocks someone has running.
create function tclock.running(p_user uuid) returns integer language sql as $$
  select count(*)::integer from public.time_entries where user_id = p_user and ended_at is null;
$$;
grant execute on all functions in schema tclock to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c10c0000-0000-0000-0000-000000000001', 'owner@clock.test', '{"full_name": "Pat Owner"}'),
  ('c10c0000-0000-0000-0000-000000000002', 'ray@clock.test', '{"full_name": "Ray Crew"}'),
  ('c10c0000-0000-0000-0000-000000000003', 'sam@clock.test', '{"full_name": "Sam Crew"}'),
  ('c10c0000-0000-0000-0000-000000000004', 'tess@clock.test', '{"full_name": "Tess Crew"}');
\set owner 'c10c0000-0000-0000-0000-000000000001'
\set ray 'c10c0000-0000-0000-0000-000000000002'
\set sam 'c10c0000-0000-0000-0000-000000000003'
\set tess 'c10c0000-0000-0000-0000-000000000004'

begin;
set local role authenticated;
select tclock.as_user(:'owner');
select public.create_company('Clock Roofing', 'general') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'ray', 'field_crew'), (:'co', :'sam', 'field_crew'), (:'co', :'tess', 'field_crew');
commit;
-- Fixed moments today, so the checks can name them.
select date_trunc('hour', now()) - interval '6 hours' as t0 \gset

\o
\echo 'One running clock'
\o /dev/null

-- A second start, from another phone that didn't see the first.
begin;
set local role authenticated;
select tclock.as_user(:'ray');
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', :'ray', 'shop', :'t0'::timestamptz) returning id as first \gset
select tclock.check(tclock.error_of(format('insert into public.time_entries (company_id, user_id, category, started_at, in_place) values (%L, %L, %L, %L, %L)',
  :'co', :'ray', 'drive', :'t0'::timestamptz + interval '2 hours', '{"missing": "denied"}')) = 'none', 'a second clock starts while one is running: it isn''t turned away');
select tclock.check(tclock.running(:'ray') = 1, 'and only one is running');
select tclock.check((select ended_at = :'t0'::timestamptz + interval '2 hours' and auto_stopped_at is null from public.time_entries where id = :'first'),
  'the first one stopped when the second began');
select id as second from public.time_entries where user_id = :'ray' and ended_at is null \gset

-- A queued tap sent late: its start is before the clock that's running now.
select tclock.check(tclock.error_of(format('insert into public.time_entries (company_id, user_id, category, started_at, in_place) values (%L, %L, %L, %L, %L)',
  :'co', :'ray', 'other', :'t0'::timestamptz + interval '1 hour', '{"missing": "timeout"}')) = 'none', 'a start that arrives late, from before the running clock, is saved too');
select tclock.check((select ended_at = :'t0'::timestamptz + interval '2 hours' from public.time_entries where user_id = :'ray' and category = 'other'),
  'ending when the running one began (and the place it was sent with is taken, as for any start)');
select tclock.check((select ended_at is null from public.time_entries where id = :'second') and tclock.running(:'ray') = 1, 'and the running clock keeps running');

-- The very same start sent twice.
select tclock.check(tclock.error_of(format('insert into public.time_entries (company_id, user_id, category, started_at) values (%L, %L, %L, %L)',
  :'co', :'ray', 'drive', :'t0'::timestamptz + interval '2 hours')) = 'none', 'the same start sent again isn''t turned away either');
select tclock.check(tclock.running(:'ray') = 1 and (select count(*) = 1 from public.time_entries where user_id = :'ray' and category = 'drive' and ended_at = started_at + interval '1 second'),
  'it''s kept as a second-long entry beside the clock that''s running');

-- Stopping, finished time, and other people are as before.
select tclock.check(tclock.error_of(format('insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values (%L, %L, %L, %L, %L)',
  :'co', :'ray', 'shop', :'t0'::timestamptz - interval '3 hours', :'t0'::timestamptz - interval '2 hours')) = 'none' and tclock.running(:'ray') = 1, 'finished time is added without touching the clock');
update public.time_entries set ended_at = :'t0'::timestamptz + interval '3 hours' where id = :'second';
select tclock.check(tclock.running(:'ray') = 0, 'the clock stops as it always did');
rollback;

begin;
set local role authenticated;
select tclock.as_user(:'owner');
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', :'ray', 'shop', :'t0'::timestamptz), (:'co', :'sam', 'shop', :'t0'::timestamptz);
select tclock.check(tclock.running(:'ray') = 1 and tclock.running(:'sam') = 1, 'two people each have their own clock');
-- Setting a stopped clock running again counts as a start.
insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values (:'co', :'ray', 'drive', :'t0'::timestamptz - interval '2 hours', :'t0'::timestamptz - interval '1 hour') returning id as old \gset
update public.time_entries set ended_at = null where id = :'old';
select tclock.check(tclock.running(:'ray') = 1 and (select ended_at = :'t0'::timestamptz from public.time_entries where id = :'old'), 'a stopped clock set running again, with a later one running, ends where that one began');
rollback;

-- Underneath, the index: with the rule switched off, a second running clock is refused outright.
begin;
alter table public.time_entries disable trigger running_clock;
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', :'ray', 'shop', :'t0'::timestamptz);
select tclock.check(tclock.error_of(format('insert into public.time_entries (company_id, user_id, category, started_at) values (%L, %L, %L, %L)', :'co', :'ray', 'drive', :'t0'::timestamptz + interval '1 hour')) like '23505:%',
  'the database itself holds one running clock per person');
rollback;

-- Two starts at the same moment (two phones, or a phone sending its queue beside a new tap): a
-- second connection starts Sam's clock while this one is still starting another for him.
create extension if not exists dblink schema tclock;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset
select :"dbl".dblink_connect('phone', 'dbname=' || current_database());
select pid as phone_pid from :"dbl".dblink('phone', 'select pg_backend_pid()') as t(pid integer) \gset
begin;
set local role authenticated;
select tclock.as_user(:'sam');
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', :'sam', 'shop', :'t0'::timestamptz) returning id as held \gset
select :"dbl".dblink_exec('phone', format('begin; set local role authenticated; set local request.jwt.claims = %L', jsonb_build_object('sub', :'sam', 'role', 'authenticated')::text));
select :"dbl".dblink_send_query('phone', format('insert into public.time_entries (company_id, user_id, category, started_at) values (%L, %L, %L, %L)', :'co', :'sam', 'drive', :'t0'::timestamptz + interval '1 hour'));
select tclock.check(tclock.waits(:phone_pid), 'a second start for the same person waits for the first to finish');
commit;
select tclock.check(tclock.error_of(format('select * from %s.dblink_get_result(%L) as t(status text)', :'dbl', 'phone')) = 'none', 'then goes through: neither clock-in is lost');
select * from :"dbl".dblink_get_result('phone') as t(status text);
select :"dbl".dblink_exec('phone', 'commit');
select :"dbl".dblink_disconnect('phone');
select tclock.check(tclock.running(:'sam') = 1 and (select category = 'drive' from public.time_entries where user_id = :'sam' and ended_at is null), 'one clock is running, the later one');
select tclock.check((select ended_at = :'t0'::timestamptz + interval '1 hour' from public.time_entries where id = :'held'), 'and the earlier one stopped where it began, so no hour is counted twice');
delete from public.time_entries where company_id = :'co';

-- The repair, on rows as a live database may hold them: made with the rule and the index off.
begin;
drop index public.time_entries_one_running;
alter table public.time_entries disable trigger running_clock;
insert into public.time_entries (id, company_id, user_id, category, started_at, ended_at) values
  -- Ray left one running 30 hours ago, started another 5 hours ago and another an hour ago.
  ('c10c0000-0000-0000-0001-000000000001', :'co', :'ray', 'shop', :'t0'::timestamptz - interval '30 hours', null),
  ('c10c0000-0000-0000-0001-000000000002', :'co', :'ray', 'visit', :'t0'::timestamptz - interval '5 hours', null),
  ('c10c0000-0000-0000-0001-000000000003', :'co', :'ray', 'drive', :'t0'::timestamptz - interval '1 hour', null),
  -- Sam's phone sent the same start twice.
  ('c10c0000-0000-0000-0001-000000000004', :'co', :'sam', 'visit', :'t0'::timestamptz - interval '2 hours', null),
  ('c10c0000-0000-0000-0001-000000000005', :'co', :'sam', 'visit', :'t0'::timestamptz - interval '2 hours', null),
  -- Tess has one clock running and finished time that overlaps it: neither is the repair's to change.
  ('c10c0000-0000-0000-0001-000000000006', :'co', :'tess', 'shop', :'t0'::timestamptz - interval '3 hours', null),
  ('c10c0000-0000-0000-0001-000000000007', :'co', :'tess', 'drive', :'t0'::timestamptz - interval '2 hours', :'t0'::timestamptz - interval '1 hour');
select tclock.check(private.stop_doubled_clocks() = 3, 'the repair stops the three clocks that had a later one running beside them');
select tclock.check(tclock.running(:'ray') = 1 and tclock.running(:'sam') = 1 and tclock.running(:'tess') = 1, 'everyone is left with one running clock');
select tclock.check((select ended_at is null and auto_stopped_at is null from public.time_entries where id = 'c10c0000-0000-0000-0001-000000000003'), 'the newest keeps running');
select tclock.check((select ended_at = :'t0'::timestamptz - interval '1 hour' and auto_stopped_at is not null from public.time_entries where id = 'c10c0000-0000-0000-0001-000000000002'),
  'an earlier one ends when the next began, marked for the office to check');
select tclock.check((select ended_at = started_at + interval '16 hours' and auto_stopped_at is not null from public.time_entries where id = 'c10c0000-0000-0000-0001-000000000001'),
  'one left running more than 16 hours before the next ends 16 hours in');
select tclock.check((select count(*) = 1 from public.time_entries where user_id = :'sam' and ended_at = started_at + interval '1 second' and auto_stopped_at is not null), 'of two started at the same instant, one is kept a second long');
select tclock.check((select count(*) = 2 and count(*) filter (where auto_stopped_at is null) = 2 and count(*) filter (where ended_at is null) = 1 from public.time_entries where user_id = :'tess'), 'a single running clock and finished time are left alone');
select tclock.check((select count(*) = 7 from public.time_entries where company_id = :'co'), 'nothing is deleted');
-- Ray's time, once: 16 hours, then 4, then the clock still running. No two of his entries overlap.
select tclock.check(not exists (select 1 from public.time_entries a join public.time_entries b on a.user_id = b.user_id and a.id < b.id
  where a.user_id = :'ray' and a.started_at < coalesce(b.ended_at, 'infinity') and b.started_at < coalesce(a.ended_at, 'infinity')), 'and none of his hours are counted twice');
select tclock.check(private.stop_doubled_clocks() = 0, 'run again, it finds nothing to do');
select tclock.check(tclock.error_of('create unique index time_entries_one_running on public.time_entries (company_id, user_id) where ended_at is null') = 'none', 'and the index goes on');
rollback;

\o
\echo 'All one-running-clock tests passed.'
