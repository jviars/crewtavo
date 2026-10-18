-- Database tests for 20261019001040_assistant_access.sql: an AI assistant's token (one with a
-- client_id claim) only reads until the person who connected it turns on "Allow changes", in the
-- Data API (hooks.before_request, PostgREST's pre-request) and in Storage. Ordinary sign-ins and
-- visitors are left as they were.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1040;
grant usage on schema t1040 to anon, authenticated, service_role;
create function t1040.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1040.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The error a statement stops with, as "SQLSTATE: message", or 'none'.
create function t1040.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
-- Claims as PostgREST and Storage set them, with the request's method and path.
create function t1040.as_request(p_user uuid, p_client text, p_method text default 'GET', p_path text default '/clients') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true),
         set_config('request.method', p_method, true),
         set_config('request.path', p_path, true);
$$;
grant execute on all functions in schema t1040 to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b1040000-0000-0000-0000-000000000001', 'owner@kilo.test', '{"full_name": "Kit Owner"}'),
  ('b1040000-0000-0000-0000-000000000002', 'office@kilo.test', '{"full_name": "Ola Office"}');

begin;
set local role authenticated;
select t1040.as_request('b1040000-0000-0000-0000-000000000001', null, 'POST', '/rpc/create_company');
select public.create_company('Kilo Gardens', 'general') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'b1040000-0000-0000-0000-000000000002', 'office');
insert into public.clients (company_id, display_name) values (:'co', 'Kilo client');
commit;

\set owner 'b1040000-0000-0000-0000-000000000001'
\set office 'b1040000-0000-0000-0000-000000000002'
-- Three of the owner's assistants: one allowed to change things, one switched back to reading, and
-- one connected before the switch existed (no row).
\set allowed 'c1040000-0000-0000-0000-00000000000a'
\set reading 'c1040000-0000-0000-0000-00000000000b'
\set earlier 'c1040000-0000-0000-0000-00000000000c'

\o
\echo 'Assistant access'
\o /dev/null

-- People set their own connections, with an ordinary sign-in.
begin;
set local role authenticated;
select t1040.as_request(:'owner', null);
insert into public.assistant_connections (client_id, allow_changes) values (:'allowed', true), (:'reading', true);
update public.assistant_connections set allow_changes = false where client_id = :'reading';
select t1040.check((select count(*) = 2 and bool_and(user_id = :'owner') from public.assistant_connections), 'a person''s connections are their own');
select t1040.expect_error(format('insert into public.assistant_connections (user_id, client_id, allow_changes) values (%L, %L, true)', :'office', :'earlier'),
  'nobody turns on changes for someone else''s assistant');
commit;

begin;
set local role authenticated;
select t1040.as_request(:'office', null);
select t1040.check((select count(*) = 0 from public.assistant_connections), 'nobody else sees them');
update public.assistant_connections set allow_changes = true where client_id = :'reading';
commit;
select t1040.check((select not allow_changes from public.assistant_connections where client_id = :'reading'), 'or changes them');

-- An ordinary sign-in is left as it was.
begin;
set local role authenticated;
select t1040.as_request(:'owner', null, 'POST', '/clients');
select hooks.before_request();
select t1040.check(current_setting('transaction_read_only') = 'off', 'an ordinary sign-in can change things');
select t1040.check(t1040.error_of(format('insert into public.clients (company_id, display_name) values (%L, %L)', :'co', 'Signed in')) = 'none', 'and does');
rollback;

-- So are visitors and the server's own key (the hook runs for every request).
begin;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true), set_config('request.method', 'POST', true), set_config('request.path', '/rpc/anything', true);
select hooks.before_request();
reset role;
select t1040.check(current_setting('transaction_read_only') = 'off', 'a visitor''s request goes through as before');
rollback;
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true), set_config('request.method', 'DELETE', true), set_config('request.path', '/clients', true);
select hooks.before_request();
reset role;
select t1040.check(current_setting('transaction_read_only') = 'off', 'and so does the server''s');
rollback;

-- An assistant that only reads: switched back, or connected before the switch existed.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'reading', 'GET', '/clients');
select hooks.before_request();
select t1040.check((select count(*) = 1 from public.clients where company_id = :'co'), 'an assistant that only reads still sees what its person sees');
select t1040.check(current_setting('transaction_read_only') = 'on', 'in a request that can''t change anything');
rollback;

begin;
set local role authenticated;
select t1040.as_request(:'owner', :'reading', 'POST', '/clients');
select t1040.check(e like 'PT403: This assistant can only read. To let it make changes, turn on "Allow changes" for it in Crewtavo, under Settings → Apps → AI assistants.',
  'it can''t add to a table, and is told where to allow it: ' || e) from (select t1040.error_of('select hooks.before_request()') as e) x;
select t1040.as_request(:'owner', :'reading', 'PATCH', '/clients');
select t1040.check(t1040.error_of('select hooks.before_request()') like 'PT403:%', 'or change a row');
select t1040.as_request(:'owner', :'reading', 'DELETE', '/clients');
select t1040.check(t1040.error_of('select hooks.before_request()') like 'PT403:%', 'or delete one');
select t1040.as_request(:'owner', :'earlier', 'POST', '/clients');
select t1040.check(t1040.error_of('select hooks.before_request()') like 'PT403:%', 'nor can one connected before the switch existed');
rollback;

-- A function it calls answers, but can't write.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'earlier', 'POST', '/rpc/create_company');
select hooks.before_request();
select t1040.check(e like '25006:%', 'a function a read-only assistant calls can''t write: ' || e)
from (select t1040.error_of(format('insert into public.clients (company_id, display_name) values (%L, %L)', :'co', 'By a function')) as e) x;
select t1040.check(t1040.error_of('select public.create_company(''Sneaky'', ''general'')') like '25006:%', 'not even one that runs as its owner');
select t1040.check(t1040.error_of($$select set_config('transaction_read_only', 'off', true)$$) <> 'none', 'and it can''t make the request writable again');
rollback;

-- An assistant allowed to change things can, as its person could.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'allowed', 'POST', '/clients');
select hooks.before_request();
select t1040.check(current_setting('transaction_read_only') = 'off', 'an assistant allowed to change things isn''t held to reading');
select t1040.check(t1040.error_of(format('insert into public.clients (company_id, display_name) values (%L, %L)', :'co', 'By an assistant')) = 'none', 'and can add a client');
-- But not to the switches: its own, another assistant's, or a new one.
update public.assistant_connections set allow_changes = true where client_id = :'reading';
select t1040.expect_error(format('insert into public.assistant_connections (client_id, allow_changes) values (%L, true)', :'earlier'), 'an assistant can''t allow another one');
select t1040.check((select count(*) = 1 from public.assistant_connections), 'and sees only its own connection');
rollback;
select t1040.check((select not allow_changes from public.assistant_connections where client_id = :'reading'), 'nor turn another''s switch on');

begin;
set local role authenticated;
select t1040.as_request(:'owner', :'reading', 'PATCH', '/assistant_connections');
update public.assistant_connections set allow_changes = true where client_id = :'reading';
delete from public.assistant_connections where client_id = :'reading';
commit;
select t1040.check((select not allow_changes from public.assistant_connections where client_id = :'reading'), 'an assistant can''t turn its own switch on, or remove it');

-- The same app connected by someone else isn't allowed because the owner allowed theirs.
begin;
set local role authenticated;
select t1040.as_request(:'office', :'allowed', 'POST', '/clients');
select t1040.check(t1040.error_of('select hooks.before_request()') like 'PT403:%', 'allowing one person''s assistant doesn''t allow anyone else''s');
rollback;

-- Files: Storage writes with the person's token, through the storage.objects policies.
begin;
set local role authenticated;
select t1040.as_request(:'owner', null, 'POST', '/object/files');
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/notes/kept.txt', :'owner');
select t1040.as_request(:'owner', :'reading', 'POST', '/object/files');
select t1040.check(e like '42501:%', 'an assistant that only reads can''t upload a file: ' || e)
from (select t1040.error_of(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/notes/new.txt', :'owner')) as e) x;
delete from storage.objects where name = :'co' || '/notes/kept.txt';
select t1040.check((select count(*) = 1 from storage.objects where name = :'co' || '/notes/kept.txt'), 'or delete one');
select t1040.as_request(:'owner', :'allowed', 'POST', '/object/files');
select t1040.check(t1040.error_of(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/notes/new.txt', :'owner')) = 'none', 'an allowed one can upload');
delete from storage.objects where name = :'co' || '/notes/kept.txt';
select t1040.check((select count(*) = 0 from storage.objects where name = :'co' || '/notes/kept.txt'), 'and delete');
rollback;

\o
\echo 'All assistant access tests passed.'
