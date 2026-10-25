-- Database tests for signing in with a code by email (20261025006001_email_sign_in_codes.sql): email
-- addresses in one spelling; whose address it is (only the email the office keeps for a sub, never a
-- profile's or an account's; only an active sign-in Crewtavo made for an active sub, and nobody's
-- sign-in elsewhere; never a staff address or a placeholder; an address on two sign-ins; any case,
-- spaces around it); and the codes by email, in the same table as codes by text: one use, 10 minutes,
-- 5 tries, a new one replacing the old by either way, an address with no sign-in answering as a real
-- one does, only the visitor who asked hearing more than "isn't right", 15 wrong tries a day for the
-- account by either way, nothing the visitor hears showing that a number and an address are one
-- account's, two tries at the same moment, a code by text and one by email asked for at the same
-- moment, tries at one account's two addresses at the same moment, the hourly tidy, and nobody but the
-- server reaching any of it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1110;
grant usage on schema t1110 to authenticated, service_role;
create function t1110.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1110.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function t1110.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- The subs an email address, as typed, belongs to the sign-in of (by business name).
create function t1110.found(p_email text) returns text[] language sql as $$
  select coalesce(array_agg(s.name order by s.name), '{}')
  from public.sub_sign_ins_for_email(p_email) f join public.subcontractors s on s.id = f.subcontractor_id
$$;
-- A 64-character stand-in for a keyed hash (not one sign_in_codes_test.sql uses, as both leave theirs).
create function t1110.h(p text) returns text language sql immutable as $$ select repeat('e' || p, 32) $$;
-- Whether another connection (p_pid) is waiting on a lock this one holds, given up to 10 seconds to
-- get there.
create function t1110.waiting_on_me(p_pid integer) returns boolean language plpgsql as $$
begin
  for i in 1..200 loop
    if pg_blocking_pids(p_pid) @> array[pg_backend_pid()] then return true; end if;
    perform pg_sleep(0.05);
  end loop;
  return false;
end $$;
grant execute on all functions in schema t1110 to authenticated, service_role;
-- Someone signed out tries too.
grant usage on schema t1110 to anon;
grant execute on function t1110.expect_error(text, text) to anon;
-- A second connection, to ask or try at the same moment as this one.
set client_min_messages = warning;
create extension if not exists dblink schema t1110;
reset client_min_messages;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset

\set oz 'd1110000-0000-0000-0000-000000000001'
\set opal 'd1110000-0000-0000-0000-000000000002'
\set cy 'd1110000-0000-0000-0000-000000000003'
\set pat 'd1110000-0000-0000-0000-000000000004'
\set al 'd1110000-0000-0000-0000-000000000005'
\set bo 'd1110000-0000-0000-0000-000000000006'
\set sid 'd1110000-0000-0000-0000-000000000007'
\set hal 'd1110000-0000-0000-0000-000000000008'
\set uma 'd1110000-0000-0000-0000-000000000009'
\set gus 'd1110000-0000-0000-0000-000000000010'
\set pia 'd1110000-0000-0000-0000-000000000011'
\set dot 'd1110000-0000-0000-0000-000000000012'
\set dan 'd1110000-0000-0000-0000-000000000013'
\set mo 'd1110000-0000-0000-0000-000000000014'
\set apex 'd1110000-0000-0000-0000-0000000000c1'
\set birch 'd1110000-0000-0000-0000-0000000000c2'
\set cedar 'd1110000-0000-0000-0000-0000000000c3'
\set hazel 'd1110000-0000-0000-0000-0000000000c4'
\set union_jack 'd1110000-0000-0000-0000-0000000000c5'
\set gutter 'd1110000-0000-0000-0000-0000000000c6'
\set pavers 'd1110000-0000-0000-0000-0000000000c7'
\set dup_one 'd1110000-0000-0000-0000-0000000000c8'
\set dup_two 'd1110000-0000-0000-0000-0000000000c9'
\set moss 'd1110000-0000-0000-0000-0000000000ca'
\set nell 'd1110000-0000-0000-0000-0000000000cb'
\set odd 'd1110000-0000-0000-0000-0000000000cc'

-- ===== Email addresses in one spelling ==========================================================
select t1110.check((select bool_and(private.email_key(typed) is not distinct from key) from (values
  ('al@apex.t1110.test', 'al@apex.t1110.test'), ('Al@Apex.t1110.TEST', 'al@apex.t1110.test'), ('  al@apex.t1110.test ', 'al@apex.t1110.test'), (E'\tAL@apex.t1110.test\n', 'al@apex.t1110.test'),
  ('', null), ('   ', null), (null, null)
) as t(typed, key)), 'email addresses come out in one spelling: trimmed and lower-cased (blank is none)');

-- ===== Quill Roofing and Papa Paving ============================================================
-- Oz owns Quill; Opal is in its office; Cy is on the crew. Pat owns Papa Paving. Quill's subs, and the
-- sign-ins the server made for them:
--   Apex Roofing (Al)          made here; Al put another address on his profile
--   Birch Gutters (Bo)         made here; the office wrote the address with capitals
--   Cedar Siding (Sid)         Sid's own account, given sub access: not made here
--   Hazel Decks (Hal)          made here, but Hal is also on Papa's crew
--   Union Jack Builders (Uma)  made here with no email (a placeholder on her account); the office adds one later
--   Gutter Guys (Gus)          made here for his own address; the office now keeps the business's
--   Placeholder Pavers (Pia)   made here with no email, and the office keeps the placeholder on the record
--   Dup One (Dot), and Papa's Dup Two (Dan)   two sign-ins with the same address
--   Moss Masonry (Mo)          an account marked for Apex, not Moss
--   Nell's Fencing             no sign-in at all
--   Opal's Odd Jobs            the office put Opal's own address on a sub with no sign-in
insert into auth.users (id, email, raw_user_meta_data) values
  (:'oz', 'oz@quill.t1110.test', '{"full_name": "Oz Owner"}'), (:'opal', 'opal@quill.t1110.test', '{"full_name": "Opal Office"}'),
  (:'cy', 'cy@quill.t1110.test', '{"full_name": "Cy Crew"}'), (:'pat', 'pat@papa.t1110.test', '{"full_name": "Pat Papa"}'),
  (:'al', 'al@apex.t1110.test', '{"full_name": "Al Apex"}'), (:'bo', 'bo@birch.t1110.test', '{"full_name": "Bo Birch"}'),
  (:'sid', 'sid@shared.t1110.test', '{"full_name": "Sid Shared"}'), (:'hal', 'hal@hazel.t1110.test', '{"full_name": "Hal Hazel"}'),
  (:'uma', 'sub-' || :'union_jack' || '@subs.invalid', '{"full_name": "Uma Union"}'), (:'gus', 'gus@gutterguys.t1110.test', '{"full_name": "Gus Gutter"}'),
  (:'pia', 'sub-' || :'pavers' || '@subs.invalid', '{"full_name": "Pia Pavers"}'), (:'dot', 'dot@dup.t1110.test', '{"full_name": "Dot Dup"}'),
  (:'dan', 'dan@dup.t1110.test', '{"full_name": "Dan Dup"}'), (:'mo', 'mo@moss.t1110.test', '{"full_name": "Mo Moss"}');

begin;
set local role authenticated;
select t1110.as_user(:'oz');
select public.create_company('Quill Roofing', 'roofing') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'opal', 'office'), (:'co', :'cy', 'field_crew');
commit;
begin;
set local role authenticated;
select t1110.as_user(:'pat');
select public.create_company('Papa Paving', 'paving') as other \gset
insert into public.subcontractors (id, company_id, name, email) values (:'dup_two', :'other', 'Dup Two', 'dup@dup.t1110.test');
commit;
-- The office adds them, as itself (each address worked out for the index as it's saved).
begin;
set local role authenticated;
select t1110.as_user(:'opal');
insert into public.subcontractors (id, company_id, name, contact_name, phone, email) values
  (:'apex', :'co', 'Apex Roofing', 'Al Apex', null, 'al@apex.t1110.test'),
  (:'birch', :'co', 'Birch Gutters', 'Bo Birch', null, 'Bo@Birch.t1110.Test'),
  (:'cedar', :'co', 'Cedar Siding', 'Sid Shared', null, 'sid@shared.t1110.test'),
  (:'hazel', :'co', 'Hazel Decks', 'Hal Hazel', null, 'hal@hazel.t1110.test'),
  (:'union_jack', :'co', 'Union Jack Builders', 'Uma Union', null, null),
  (:'gutter', :'co', 'Gutter Guys', 'Gus Gutter', null, 'office@gutterguys.t1110.test'),
  (:'pavers', :'co', 'Placeholder Pavers', 'Pia Pavers', null, 'sub-' || :'pavers' || '@subs.INVALID'),
  (:'dup_one', :'co', 'Dup One', 'Dot Dup', null, 'DUP@dup.t1110.test'),
  (:'moss', :'co', 'Moss Masonry', 'Mo Moss', null, 'mo@moss.t1110.test'),
  (:'nell', :'co', 'Nell''s Fencing', 'Nell', null, 'nell@fence.t1110.test'),
  (:'odd', :'co', 'Opal''s Odd Jobs', 'Opal', null, 'opal@quill.t1110.test');
select public.set_sub_reminders(:'co', false);
commit;

-- The sign-ins, as the server makes them, and the marks it puts on the accounts it makes
-- (services/subAccess.ts). Sid's account is his own.
insert into public.memberships (company_id, user_id, role, subcontractor_id) values
  (:'co', :'al', 'subcontractor', :'apex'), (:'co', :'bo', 'subcontractor', :'birch'), (:'co', :'sid', 'subcontractor', :'cedar'),
  (:'co', :'hal', 'subcontractor', :'hazel'), (:'co', :'uma', 'subcontractor', :'union_jack'), (:'co', :'gus', 'subcontractor', :'gutter'),
  (:'co', :'pia', 'subcontractor', :'pavers'), (:'co', :'dot', 'subcontractor', :'dup_one'), (:'other', :'dan', 'subcontractor', :'dup_two'),
  (:'co', :'mo', 'subcontractor', :'moss');
insert into public.memberships (company_id, user_id, role) values (:'other', :'hal', 'field_crew');
update auth.users u set raw_app_meta_data = jsonb_build_object('provider', 'email', 'crewtavo_sub', m.company_id::text || ':' || m.subcontractor_id::text)
from public.memberships m where m.user_id = u.id and m.role = 'subcontractor' and u.id in (:'al', :'bo', :'hal', :'uma', :'gus', :'pia', :'dot', :'dan');
update auth.users set raw_app_meta_data = jsonb_build_object('crewtavo_sub', :'co' || ':' || :'apex') where id = :'mo';
-- An address Al gave himself, which never counts.
update public.profiles set email = 'al.home@apex.t1110.test' where user_id = :'al';

-- ===== Whose address it is ======================================================================
begin;
set local role service_role;
select t1110.check(t1110.found('al@apex.t1110.test') = '{Apex Roofing}' and t1110.found('AL@Apex.t1110.Test') = '{Apex Roofing}' and t1110.found('  al@apex.t1110.test  ') = '{Apex Roofing}',
  'Al''s address finds Apex''s sign-in, in any case and with spaces around it');
select t1110.check((select row(user_id, company_id, subcontractor_id, company_name)::text from public.sub_sign_ins_for_email('al@apex.t1110.test'))
  = row(:'al'::uuid, :'co'::uuid, :'apex'::uuid, 'Quill Roofing')::text, 'with Al''s account, the company and its name for the email');
select t1110.check(t1110.found('bo@birch.t1110.test') = '{Birch Gutters}', 'however the office wrote it (with capitals)');
select t1110.check(t1110.found('al.home@apex.t1110.test') = '{}', 'the address Al put on his own profile finds nothing: only the office''s counts');
select t1110.check(t1110.found('gus@gutterguys.t1110.test') = '{}' and t1110.found('office@gutterguys.t1110.test') = '{Gutter Guys}',
  'nor does the address on Gus''s account, once the office keeps another for the business');
select t1110.check(t1110.found('sub-' || :'union_jack' || '@subs.invalid') = '{}' and t1110.found('sub-' || :'pavers' || '@subs.invalid') = '{}'
  and t1110.found('SUB-' || :'pavers' || '@SUBS.INVALID') = '{}',
  'a placeholder address never finds anything, on an account or on the office''s record, in any case');
select t1110.check(t1110.found('opal@quill.t1110.test') = '{}' and t1110.found('cy@quill.t1110.test') = '{}' and t1110.found('oz@quill.t1110.test') = '{}',
  'nor does a staff address, even one the office put on a sub with no sign-in');
select t1110.check(t1110.found('sid@shared.t1110.test') = '{}', 'Sid signs in with his own account, which Crewtavo didn''t make: no code for it');
select t1110.check(t1110.found('mo@moss.t1110.test') = '{}', 'nor for an account made for another sub');
select t1110.check(t1110.found('hal@hazel.t1110.test') = '{}', 'nor for Hal, whose sign-in is also on Papa''s crew');
select t1110.check(t1110.found('nell@fence.t1110.test') = '{}', 'a sub with no sign-in has nothing to sign in to');
select t1110.check(t1110.found('dup@dup.t1110.test') = '{"Dup One","Dup Two"}' and (select count(*) from public.sub_sign_ins_for_email(' Dup@Dup.t1110.Test')) = 2,
  'an address on two sign-ins, at two companies, finds both (and the server sends no code)');
select t1110.check(t1110.found('') = '{}' and t1110.found('   ') = '{}' and t1110.found(null) = '{}', 'nothing typed finds nothing');
select t1110.check(t1110.found('540-555-0101') = '{}', 'and a phone number isn''t an address');
commit;

-- Uma had no email when her sign-in was made; the office adds one, and it finds her.
select t1110.check(t1110.found('uma@union.t1110.test') = '{}', 'Uma has no address on file yet');
begin;
set local role authenticated;
select t1110.as_user(:'opal');
update public.subcontractors set email = 'Uma@Union.t1110.test' where id = :'union_jack';
commit;
select t1110.check(t1110.found('uma@union.t1110.test') = '{Union Jack Builders}', 'once the office adds one, it finds her sign-in (her account''s placeholder doesn''t matter)');

-- Turned off: the sub, or the sign-in.
update public.subcontractors set active = false where id = :'birch';
select t1110.check(t1110.found('bo@birch.t1110.test') = '{}', 'nothing for a sub the office turned off');
update public.subcontractors set active = true where id = :'birch';
update public.memberships set active = false where user_id = :'bo';
select t1110.check(t1110.found('bo@birch.t1110.test') = '{}', 'or whose sign-in was removed');
update public.memberships set active = true where user_id = :'bo';
select t1110.check(t1110.found('bo@birch.t1110.test') = '{Birch Gutters}', 'and found again once it''s back');

-- Hal's place on Papa's crew turned off: still someone else's sign-in, which can be turned back on.
update public.memberships set active = false where user_id = :'hal' and company_id = :'other';
select t1110.check(t1110.found('hal@hazel.t1110.test') = '{}', 'still nothing for Hal once his place on Papa''s crew is turned off');
update public.memberships set active = true where user_id = :'hal' and company_id = :'other';

-- A new address on file: the old one finds nothing.
update public.subcontractors set email = 'bo@birchgutters.t1110.test' where id = :'birch';
select t1110.check(t1110.found('bo@birch.t1110.test') = '{}' and t1110.found('BO@birchgutters.t1110.test') = '{Birch Gutters}', 'the office changing the address moves it');

-- ===== Codes by email ===========================================================================
begin;
set local role service_role;
-- Al asks for a code by email, and types it in.
select public.sign_in_code_save('email', t1110.h('a'), t1110.h('1'), :'al', t1110.h('f'));
select t1110.check(public.sign_in_code_check('email', t1110.h('a'), t1110.h('2'), :'al') = 'wrong', 'a wrong code is wrong');
select t1110.check(public.sign_in_code_check('text', t1110.h('a'), t1110.h('1'), :'al') = 'wrong', 'the code by email isn''t one by text, even for the same hash');
select t1110.check(public.sign_in_code_check('email', t1110.h('a'), t1110.h('1'), :'al') = 'ok', 'the right one works');
select t1110.check(public.sign_in_code_check('email', t1110.h('a'), t1110.h('1'), :'al') = 'wrong', 'once');
commit;
select t1110.check((select row(channel, attempts, used_at is not null, expires_at - created_at, ip_hash)::text from private.sign_in_codes where code_hash = t1110.h('1'))
  = row('email', 2, true, interval '10 minutes', t1110.h('f'))::text, 'kept as a code by email: two tries counted, used, for 10 minutes, with the visitor''s address as a hash');

-- 5 tries, then the code is dead.
begin;
set local role service_role;
select public.sign_in_code_save('email', t1110.h('a'), t1110.h('3'), :'al', t1110.h('f'));
select public.sign_in_code_check('email', t1110.h('a'), t1110.h('4'), :'al', t1110.h('f')) from generate_series(1, 4);
select t1110.check(public.sign_in_code_check('email', t1110.h('a'), t1110.h('4'), :'al', t1110.h('f')) = 'dead', 'the fifth wrong try says the code is used up');
select t1110.check(public.sign_in_code_check('email', t1110.h('a'), t1110.h('3'), :'al', t1110.h('f')) = 'dead', 'and after it even the right code doesn''t work');
select t1110.check(public.sign_in_code_check('email', t1110.h('a'), t1110.h('3'), :'al', t1110.h('e')) = 'wrong', 'someone else trying the address hears only that it isn''t right');
commit;
select t1110.check((select attempts from private.sign_in_codes where code_hash = t1110.h('3')) = 5, 'and the count stops at five');

-- 10 minutes.
begin;
set local role service_role;
select public.sign_in_code_save('email', t1110.h('a'), t1110.h('5'), :'al', t1110.h('f'));
commit;
update private.sign_in_codes set expires_at = clock_timestamp() - interval '1 second' where code_hash = t1110.h('5');
begin;
set local role service_role;
select t1110.check(public.sign_in_code_check('email', t1110.h('a'), t1110.h('5'), :'al', t1110.h('f')) = 'expired', 'a code past its 10 minutes has run out');
select t1110.check(public.sign_in_code_check('email', t1110.h('a'), t1110.h('5'), :'al', t1110.h('e')) = 'wrong' and public.sign_in_code_check('email', t1110.h('a'), t1110.h('5'), :'al') = 'wrong',
  'only the visitor who asked hears it ran out: anyone else hears it isn''t right');
commit;

-- A new code, by either way: the one before stops working. One at the account's other address is
-- stopped rather than run out, so even its right code is only "isn't right", as for any wrong code.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1110.h('t'), t1110.h('6'), :'bo', t1110.h('f'));
select public.sign_in_code_save('email', t1110.h('b'), t1110.h('7'), :'bo', t1110.h('f'));
select t1110.check(public.sign_in_code_check('text', t1110.h('t'), t1110.h('6'), :'bo', t1110.h('f')) = 'wrong', 'a code by email stops Bo''s code by text: its right code isn''t right any more');
select public.sign_in_code_save('text', t1110.h('t'), t1110.h('8'), :'bo', t1110.h('f'));
select t1110.check(public.sign_in_code_check('email', t1110.h('b'), t1110.h('7'), :'bo', t1110.h('f')) = 'wrong', 'and a code by text stops his code by email');
select public.sign_in_code_save('email', t1110.h('b'), t1110.h('9'), :'bo', t1110.h('f'));
select public.sign_in_code_save('email', t1110.h('b'), t1110.h('a'), :'bo', t1110.h('f'));
select t1110.check(public.sign_in_code_check('email', t1110.h('b'), t1110.h('9'), :'bo', t1110.h('f')) = 'wrong', 'asking again by email: the code before no longer works');
select t1110.check(public.sign_in_code_check('text', t1110.h('t'), t1110.h('8'), :'bo', t1110.h('f')) = 'wrong', 'and the one by text');
select t1110.check(public.sign_in_code_check('email', t1110.h('b'), t1110.h('a'), :'bo', t1110.h('f')) = 'ok', 'the newest one works');
commit;
select t1110.check((select count(*) from private.sign_in_codes where user_id = :'bo' and used_at is null and stopped_at is null and expires_at > clock_timestamp()) = 0, 'Bo has no code left that works');
select t1110.check((select row(attempts, stopped_at is not null, expires_at - created_at)::text from private.sign_in_codes where code_hash = t1110.h('8') and address_hash = t1110.h('t'))
  = row(1, true, interval '10 minutes')::text, 'his stopped code by text kept its 10 minutes, and the try at it counted');

-- Nothing the visitor hears shows that a number and an address are one account's. Gus asks for a code
-- by text and then by email, which stops the one by text; Dot asks by text, and Pia (someone else)
-- by email, from the same visitor. Tries at the two codes by text answer alike, try for try.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1110.h('w'), t1110.h('1'), :'gus', t1110.h('f'));
select public.sign_in_code_save('email', t1110.h('x'), t1110.h('2'), :'gus', t1110.h('f'));
select public.sign_in_code_save('text', t1110.h('y'), t1110.h('3'), :'dot', t1110.h('f'));
select public.sign_in_code_save('email', t1110.h('z'), t1110.h('4'), :'pia', t1110.h('f'));
create temp table t1110_answers as
  select i, public.sign_in_code_check('text', t1110.h('w'), t1110.h('0'), :'gus', t1110.h('f')) as linked,
    public.sign_in_code_check('text', t1110.h('y'), t1110.h('0'), :'dot', t1110.h('f')) as unlinked
  from generate_series(1, 6) i;
select t1110.check((select array_agg(linked order by i) = array_agg(unlinked order by i) and array_agg(linked order by i) = '{wrong,wrong,wrong,wrong,dead,dead}' from t1110_answers),
  'a number whose account was just asked a code by email answers wrong tries as one that wasn''t: "isn''t right", then "used up"');
commit;
select t1110.check(not exists (select 1 from private.sign_in_codes where code_hash = t1110.h('1') and address_hash = t1110.h('w') and used_at is not null), 'and the stopped code never signed Gus in');
update private.sign_in_codes set expires_at = clock_timestamp() - interval '1 second' where address_hash in (t1110.h('w'), t1110.h('y'));
begin;
set local role service_role;
select t1110.check(public.sign_in_code_check('text', t1110.h('w'), t1110.h('1'), :'gus', t1110.h('f')) = 'expired' and public.sign_in_code_check('text', t1110.h('y'), t1110.h('3'), :'dot', t1110.h('f')) = 'expired',
  'and after their 10 minutes both have run out alike');
select t1110.check(public.sign_in_code_check('email', t1110.h('x'), t1110.h('2'), :'gus', t1110.h('f')) = 'ok', 'Gus''s newer code by email still works');
commit;

-- Tied to one account.
begin;
set local role service_role;
select public.sign_in_code_save('email', t1110.h('c'), t1110.h('a'), :'al');
select t1110.check(public.sign_in_code_check('email', t1110.h('c'), t1110.h('a'), :'bo') = 'wrong', 'a code emailed for Al doesn''t sign in Bo');
select t1110.check(public.sign_in_code_check('email', t1110.h('c'), t1110.h('a'), null) = 'wrong', 'or anyone, once the address is nobody''s (a sign-in turned off since)');
select t1110.check(public.sign_in_code_check('email', t1110.h('c'), t1110.h('a'), :'al') = 'ok', 'only Al');
commit;

-- An address with no sign-in: a code nobody has, answering as a real one does.
begin;
set local role service_role;
select public.sign_in_code_save('email', t1110.h('d'), t1110.h('b'), null, t1110.h('f'));
select t1110.check(public.sign_in_code_check('email', t1110.h('d'), t1110.h('b'), null) = 'wrong' and public.sign_in_code_check('email', t1110.h('d'), t1110.h('b'), :'al') = 'wrong',
  'an address with no sign-in never signs anyone in');
select t1110.check(public.sign_in_code_check('email', t1110.h('e'), t1110.h('b'), :'al', t1110.h('f')) = 'wrong', 'nor does an address nobody asked a code for');
commit;
select t1110.check((select user_id is null and channel = 'email' from private.sign_in_codes where address_hash = t1110.h('d')), 'its row has nobody''s account');
update private.sign_in_codes set expires_at = clock_timestamp() - interval '1 second' where address_hash = t1110.h('d');
begin;
set local role service_role;
select t1110.check(public.sign_in_code_check('email', t1110.h('d'), t1110.h('b'), null, t1110.h('f')) = 'expired', 'and after 10 minutes it has run out, as a real code would');
select t1110.check(public.sign_in_code_check('email', t1110.h('d'), t1110.h('b'), null, t1110.h('e')) = 'wrong', 'to the visitor who asked, and isn''t right to anyone else');
commit;

-- What a code needs.
begin;
set local role service_role;
select t1110.expect_error(format('select public.sign_in_code_save(%L, %L, %L)', 'post', t1110.h('g'), t1110.h('1')), 'a code goes by text or by email, nothing else');
select t1110.expect_error(format('select public.sign_in_code_save(%L, null, %L)', 'email', t1110.h('1')), 'and needs the address');
select t1110.check(public.sign_in_code_check(null, t1110.h('a'), t1110.h('1'), :'al') = 'wrong' and public.sign_in_code_check('email', null, t1110.h('1'), :'al') = 'wrong',
  'a try without the way or the address is wrong');
commit;

-- ===== 15 wrong tries in a day, by either way ===================================================
-- Uma's account has 15 wrong tries by text (her number, 'l') and email (her address, 'u'): a code to
-- either doesn't work even when it's right. Only the address that had the 15 itself says "too many";
-- otherwise it's "isn't right", as at an address that isn't hers, so the two can't be matched up. An
-- address with no sign-in ('m') gets its own 15.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1110.h('l'), t1110.h('1'), :'uma', t1110.h('f'));
select public.sign_in_code_check('text', t1110.h('l'), t1110.h('0'), :'uma', t1110.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('text', t1110.h('l'), t1110.h('2'), :'uma', t1110.h('f'));
select public.sign_in_code_check('text', t1110.h('l'), t1110.h('0'), :'uma', t1110.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('email', t1110.h('u'), t1110.h('3'), :'uma', t1110.h('f'));
select public.sign_in_code_check('email', t1110.h('u'), t1110.h('0'), :'uma', t1110.h('f')) from generate_series(1, 4);
select t1110.check(public.sign_in_code_check('email', t1110.h('u'), t1110.h('3'), :'uma', t1110.h('f')) = 'ok', 'fourteen wrong tries by text and email, and the right one still works');
select public.sign_in_code_save('email', t1110.h('u'), t1110.h('4'), :'uma', t1110.h('f'));
select t1110.check(public.sign_in_code_check('email', t1110.h('u'), t1110.h('0'), :'uma', t1110.h('f')) = 'wrong', 'the fifteenth wrong try');
select public.sign_in_code_save('email', t1110.h('u'), t1110.h('5'), :'uma', t1110.h('f'));
select t1110.check(public.sign_in_code_check('email', t1110.h('u'), t1110.h('5'), :'uma', t1110.h('f')) = 'wrong', 'after it, a new code by email doesn''t work even when it''s right, and her address (5 of the 15) hears only that it isn''t right');
select t1110.check(public.sign_in_code_check('email', t1110.h('u'), t1110.h('5'), :'uma', t1110.h('e')) = 'wrong', 'as does anyone else');
select public.sign_in_code_save('text', t1110.h('l'), t1110.h('6'), :'uma', t1110.h('f'));
select t1110.check(public.sign_in_code_check('text', t1110.h('l'), t1110.h('6'), :'uma', t1110.h('f')) = 'wrong', 'nor does one by text (10 of the 15 at her number)');
select public.sign_in_code_save('email', t1110.h('m'), t1110.h('1'), null, t1110.h('f'));
select public.sign_in_code_check('email', t1110.h('m'), t1110.h('0'), null, t1110.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('email', t1110.h('m'), t1110.h('2'), null, t1110.h('f'));
select public.sign_in_code_check('email', t1110.h('m'), t1110.h('0'), null, t1110.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('email', t1110.h('m'), t1110.h('3'), null, t1110.h('f'));
select public.sign_in_code_check('email', t1110.h('m'), t1110.h('0'), null, t1110.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('email', t1110.h('m'), t1110.h('4'), null, t1110.h('f'));
select t1110.check(public.sign_in_code_check('email', t1110.h('m'), t1110.h('4'), null, t1110.h('f')) = 'locked', 'an address with no sign-in answers the same after 15 wrong tries');
commit;
select t1110.check((select array_agg(attempts order by created_at) from private.sign_in_codes where user_id = :'uma') = '{5,5,5,1,2,1}',
  'a used code''s right try isn''t a wrong one, and tries past the account''s 15 count as any wrong try');
select t1110.check(not exists (select 1 from private.sign_in_codes where user_id = :'uma' and code_hash in (t1110.h('5'), t1110.h('6')) and used_at is not null), 'and none of them signed Uma in');
select t1110.check((select array_agg(attempts order by created_at) from private.sign_in_codes where address_hash = t1110.h('m')) = '{5,5,5,0}',
  'at an address''s own 15, tries aren''t counted any more');

-- ===== Two tries at the same moment =============================================================
-- Bo types his emailed code on two phones at once. The second waits for the first, then finds it used.
begin;
set local role service_role;
select public.sign_in_code_save('email', t1110.h('r'), t1110.h('c'), :'bo');
commit;
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select pid as other_pid from :"dbl".dblink('other', 'select pg_backend_pid()') as t(pid integer) \gset
select :"dbl".dblink_exec('other', 'begin; set local role service_role');
begin;
set local role service_role;
select public.sign_in_code_check('email', t1110.h('r'), t1110.h('c'), :'bo') as first_try \gset
reset role;
select :"dbl".dblink_send_query('other', format('select public.sign_in_code_check(%L, %L, %L, %L)', 'email', t1110.h('r'), t1110.h('c'), :'bo'));
select t1110.check(t1110.waiting_on_me(:other_pid), 'the second try waits for the first');
commit;
select r as second_try from :"dbl".dblink_get_result('other') as t(r text) \gset
select count(*) from :"dbl".dblink_get_result('other') as t(r text);
select :"dbl".dblink_exec('other', 'commit');
select t1110.check(:'first_try' = 'ok' and :'second_try' = 'wrong', 'the first try signs in, and the second at the same moment gets wrong');
select t1110.check((select row(attempts, used_at is not null)::text from private.sign_in_codes where address_hash = t1110.h('r')) = row(1, true)::text, 'used once, one try counted');

-- Al asks for a code by email and by text at the same moment: the second waits for the first, then
-- stops it, so only one of them works.
select :"dbl".dblink_exec('other', 'begin; set local role service_role');
begin;
set local role service_role;
select public.sign_in_code_save('email', t1110.h('s'), t1110.h('d'), :'al', t1110.h('f'));
reset role;
select :"dbl".dblink_send_query('other', format('select public.sign_in_code_save(%L, %L, %L, %L, %L)', 'text', t1110.h('v'), t1110.h('e'), :'al', t1110.h('f')));
select t1110.check(t1110.waiting_on_me(:other_pid), 'asking by text waits for the ask by email for the same account');
commit;
select count(*) from :"dbl".dblink_get_result('other') as t(r text);
select count(*) from :"dbl".dblink_get_result('other') as t(r text);
select :"dbl".dblink_exec('other', 'commit');
select :"dbl".dblink_disconnect('other');
begin;
set local role service_role;
select t1110.check(public.sign_in_code_check('email', t1110.h('s'), t1110.h('d'), :'al', t1110.h('f')) = 'wrong', 'the code by email, asked for first, no longer works');
select t1110.check(public.sign_in_code_check('text', t1110.h('v'), t1110.h('e'), :'al', t1110.h('f')) = 'ok', 'the one by text, asked for last, does');
commit;

-- Tries at one account's codes at its two addresses take turns, so the account's 15 can't be passed
-- by trying both at once. Al has had 14 wrong tries today; his code by text ('q') was stopped by his
-- newer one by email ('p'). A wrong try at the code by text holds the account's turn; the right code
-- by email, tried at the same moment, waits, then finds the 15th try counted and doesn't sign in.
delete from private.sign_in_codes where user_id = :'al';
insert into private.sign_in_codes (channel, user_id, address_hash, code_hash, attempts, created_at, expires_at)
select 'text', :'al', t1110.h('k'), t1110.h('0'), n, clock_timestamp(), clock_timestamp() from unnest(array[5, 5, 4]) n;
begin;
set local role service_role;
select public.sign_in_code_save('text', t1110.h('q'), t1110.h('5'), :'al', t1110.h('f'));
select public.sign_in_code_save('email', t1110.h('p'), t1110.h('6'), :'al', t1110.h('f'));
commit;
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select pid as other_pid from :"dbl".dblink('other', 'select pg_backend_pid()') as t(pid integer) \gset
select :"dbl".dblink_exec('other', 'begin; set local role service_role');
begin;
set local role service_role;
select public.sign_in_code_check('text', t1110.h('q'), t1110.h('0'), :'al', t1110.h('f')) as first_try \gset
reset role;
select :"dbl".dblink_send_query('other', format('select public.sign_in_code_check(%L, %L, %L, %L, %L)', 'email', t1110.h('p'), t1110.h('6'), :'al', t1110.h('f')));
select t1110.check(t1110.waiting_on_me(:other_pid), 'a try at Al''s address waits for the try at his number');
commit;
select r as second_try from :"dbl".dblink_get_result('other') as t(r text) \gset
select count(*) from :"dbl".dblink_get_result('other') as t(r text);
select :"dbl".dblink_exec('other', 'commit');
select :"dbl".dblink_disconnect('other');
select t1110.check(:'first_try' = 'wrong' and :'second_try' = 'wrong', 'the 15th wrong try counts first, so the right code at the same moment doesn''t sign Al in');
select t1110.check((select used_at is null and attempts = 1 from private.sign_in_codes where address_hash = t1110.h('p'))
  and (select sum(attempts) from private.sign_in_codes where user_id = :'al') = 16, 'his code by email is unused, and both tries counted');

-- ===== The hourly tidy ==========================================================================
update private.sign_in_codes set created_at = now() - interval '25 hours' where address_hash in (t1110.h('a'), t1110.h('t'));
select count(*) as old_codes from private.sign_in_codes where created_at < now() - interval '1 day' \gset
select count(*) as all_codes from private.sign_in_codes \gset
begin;
set local role service_role;
select public.tidy_sign_in_codes() as tidied \gset
commit;
select t1110.check(:old_codes > 0 and :tidied = :old_codes and (select count(*) from private.sign_in_codes) = :all_codes - :old_codes
  and not exists (select 1 from private.sign_in_codes where address_hash in (t1110.h('a'), t1110.h('t'))),
  'the hourly upkeep clears codes over a day old, by email and by text, and keeps the rest');

-- ===== Nobody but the server ====================================================================
select t1110.check(to_regprocedure('public.sign_in_code_save(text, text, uuid, text)') is null and to_regprocedure('public.sign_in_code_check(text, text, uuid, text)') is null,
  'the old functions that didn''t say which way the code went are gone');
select t1110.check((select bool_and(not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and has_function_privilege('service_role', f, 'execute'))
  from unnest(array['public.sign_in_code_save(text, text, text, uuid, text)', 'public.sign_in_code_check(text, text, text, uuid, text)',
    'public.sub_sign_ins_for_email(text)', 'public.sub_sign_ins_for_phone(text)', 'public.tidy_sign_in_codes()']) as f),
  'saving and checking codes, and finding whose address or number it is, are for the server''s key only');
select t1110.check(not has_function_privilege('authenticated', 'private.sign_in_code_turn(text, uuid)', 'execute') and not has_function_privilege('service_role', 'private.sign_in_code_turn(text, uuid)', 'execute'),
  'and nobody calls the turn-taking inside them directly, the server included');
begin;
set local role authenticated;
select t1110.as_user(:'al');
select t1110.expect_error('select * from public.sub_sign_ins_for_email(''al@apex.t1110.test'')', 'Al can''t look up whose address it is');
select t1110.expect_error(format('select public.sign_in_code_check(%L, %L, %L, %L)', 'email', t1110.h('a'), t1110.h('1'), :'al'), 'or try a code himself');
select t1110.expect_error(format('select public.sign_in_code_save(%L, %L, %L, %L)', 'email', t1110.h('a'), t1110.h('1'), :'al'), 'or make one');
select t1110.expect_error('select count(*) from private.sign_in_codes', 'or read the codes');
select t1110.as_user(:'oz');
select t1110.expect_error('select * from public.sub_sign_ins_for_email(''al@apex.t1110.test'')', 'and neither can the owner');
select t1110.as_user(:'opal');
select t1110.expect_error('select * from public.sub_sign_ins_for_email(''al@apex.t1110.test'')', 'or the office');
select t1110.as_user(:'pat');
select t1110.expect_error('select * from public.sub_sign_ins_for_email(''dup@dup.t1110.test'')', 'or another company''s owner');
commit;
begin;
set local role anon;
select t1110.expect_error('select * from public.sub_sign_ins_for_email(''al@apex.t1110.test'')', 'nor anyone signed out');
select t1110.expect_error(format('select public.sign_in_code_check(%L, %L, %L, %L)', 'email', t1110.h('a'), t1110.h('1'), :'al'), 'who can''t try a code either');
commit;

\o
\echo 'All email sign-in code tests passed.'
