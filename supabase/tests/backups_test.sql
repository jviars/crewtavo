-- Database tests for the built-in backups (20261112000200_backups.sql): one run at a time across
-- servers, the night's backup once, three tries a night, a run whose server died closed as failed,
-- and nobody but the server reading the runs or the bucket the dumps are in.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1160;
grant usage on schema t1160 to anon, authenticated, service_role;
create function t1160.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1160.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t1160 to anon, authenticated, service_role;

-- ===== One run at a time ========================================================================
set role service_role;
select public.claim_backup('nightly', now() - interval '1 hour') as first \gset
select t1160.check(nullif(:'first', '') is not null, 'the night''s backup starts when none has been made since the night began');
select t1160.check(public.claim_backup('nightly', now() - interval '1 hour') is null, 'a second server asking meanwhile starts none');
select t1160.check(public.claim_backup('manual') is null, 'and neither does Back up now while one is running');
select t1160.check((select count(*) from public.backups) = 1, 'so there is one run');
reset role;
select t1160.expect_error($$insert into public.backups (kind) values ('manual')$$, 'the database itself refuses a second running row');

-- ===== Tonight's backup is made once ============================================================
update public.backups set status = 'ok', finished_at = now(), bytes = 1000, parts = 1 where id = :'first';
set role service_role;
select t1160.check(public.claim_backup('nightly', now() - interval '1 hour') is null, 'once tonight''s backup is good, the next hour starts no other');
select public.claim_backup('manual') as by_hand \gset
select t1160.check(nullif(:'by_hand', '') is not null, 'Back up now makes another whenever none is running');
reset role;
update public.backups set status = 'ok', finished_at = now(), bytes = 1000, parts = 1 where id = :'by_hand';
-- The next night began after both.
set role service_role;
select public.claim_backup('nightly', now() + interval '1 second') as next_night \gset
select t1160.check(nullif(:'next_night', '') is not null, 'the next night''s backup starts though yesterday''s is good');
reset role;

-- ===== Three tries a night ======================================================================
update public.backups set status = 'failed', finished_at = now(), error = 'Storage didn''t take the backup (500).' where id = :'next_night';
insert into public.backups (kind, status, started_at, finished_at, error) values
  ('nightly', 'failed', now(), now(), 'again'),
  ('manual', 'failed', now(), now(), 'a failed Back up now doesn''t use up the night''s tries');
set role service_role;
select public.claim_backup('nightly', (select started_at from public.backups where id = :'next_night')) as third \gset
select t1160.check(nullif(:'third', '') is not null, 'a night that failed twice gets its third try');
reset role;
update public.backups set status = 'failed', finished_at = now(), error = 'and again' where id = :'third';
set role service_role;
select t1160.check(public.claim_backup('nightly', (select started_at from public.backups where id = :'next_night')) is null, 'after three failures the night gets no fourth');
select t1160.check(public.claim_backup('nightly', now() + interval '1 second') is not null, 'the night after starts fresh');
reset role;

-- ===== A run whose server died ==================================================================
update public.backups set heartbeat_at = now() - interval '11 minutes' where status = 'running' returning id as dead \gset
set role service_role;
select public.claim_backup('manual') as after_dead \gset
select t1160.check(nullif(:'after_dead', '') is not null, 'a run that stopped saying it was going doesn''t block the next one');
reset role;
select t1160.check((select status = 'failed' and finished_at is not null and error like 'Crewtavo restarted%' from public.backups where id = :'dead'),
  'and is closed as failed, so it is never listed as good');
update public.backups set heartbeat_at = now() - interval '9 minutes' where id = :'after_dead';
set role service_role;
select t1160.check(public.claim_backup('manual') is null, 'a run that was heard from in the last ten minutes is left alone');
reset role;

-- ===== Only the server ==========================================================================
insert into auth.users (id, email, raw_user_meta_data) values ('b9000000-0000-0000-0000-000000001160', 'owner@backups.test', '{"full_name": "Bea Backup"}');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9000000-0000-0000-0000-000000001160", "role": "authenticated"}', true);
select public.create_company('Backup Paving', 'paving') as co \gset
select t1160.expect_error($$select count(*) from public.backups$$, 'a signed-in person, the owner included, can''t read the runs');
select t1160.expect_error($$select public.claim_backup('manual')$$, 'or start one in the database');
commit;
set role anon;
select t1160.expect_error($$select count(*) from public.backups$$, 'and neither can a visitor');
reset role;

-- The dumps' bucket is private, and no policy lets a signed-in person at it: every policy that
-- lets people at stored files names the files bucket.
select t1160.check((select not public from storage.buckets where id = 'backups'), 'the backups bucket is private');
select t1160.check((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and permissive = 'PERMISSIVE'
  and coalesce(qual, '') || coalesce(with_check, '') not like '%bucket_id = ''files''%') = 0, 'no storage policy opens any bucket but files');
insert into storage.objects (bucket_id, name, metadata) values ('backups', 'b9000000-0000-0000-0000-00000000aaaa/part-0001', '{"size": 5000000}');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9000000-0000-0000-0000-000000001160", "role": "authenticated"}', true);
select t1160.check((select count(*) from storage.objects where bucket_id = 'backups') = 0, 'the owner''s own key sees nothing in the backups bucket');
select t1160.expect_error($$insert into storage.objects (bucket_id, name) values ('backups', 'mine/part-0001')$$, 'and can''t put anything in it');
commit;
-- A dump isn't one of the company's files: it never counts toward the storage limit.
select t1160.check((select company_used from public.storage_snapshot(:'co', 'b9000000-0000-0000-0000-000000001160')) = 0, 'a dump doesn''t count toward the company''s storage');
