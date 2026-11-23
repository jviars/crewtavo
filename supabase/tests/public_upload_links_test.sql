-- Database tests for 20261123100500_public_upload_links.sql: upload links' records are the
-- server's alone and belong to their company's folder; the links that ran out are forgotten once,
-- with only the files nobody recorded handed over; and an AI assistant's token doesn't read guides'
-- share links while the person's own sign-in does.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tpu;
grant usage on schema tpu to authenticated, service_role;
create function tpu.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tpu.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
create function tpu.as_user(p_user uuid, p_client text default null) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true)
$$;
grant execute on all functions in schema tpu to authenticated, service_role;

\set ann '5e000000-0000-4000-8000-000000000001'
-- The file that arrives and is recorded: named as the server names a request's files.
\set kept '5e000000-0000-4000-8000-0000000000f1'

insert into auth.users (id, email, raw_user_meta_data) values (:'ann', 'ann@birch.test', '{"full_name": "Ann Owner"}');

begin;
set local role authenticated;
select tpu.as_user(:'ann');
select public.create_company('Birch Lawn', 'general') as co \gset
insert into public.sop_pages (company_id, title, body_html) values (:'co', 'Edging a bed', '<p>Cut a clean line.</p>') returning id as guide \gset
insert into public.sop_shares (page_id, company_id) values (:'guide', :'co');
insert into public.clients (company_id, display_name) values (:'co', 'Cal Client') returning id as client \gset
insert into public.requests (company_id, client_id, title) values (:'co', :'client', 'Patio drainage') returning id as request \gset
commit;

-- ---------------------------------------------------------------------------------------------
-- Upload links' records
-- ---------------------------------------------------------------------------------------------

set role service_role;
insert into public.upload_links (path, company_id, kind, max_bytes, expires_at) values
  (:'co' || '/plans/' || :'kept' || '.pdf', :'co', 'form', 5000, now() - interval '1 minute'),
  (:'co' || '/plans/stray.pdf', :'co', 'form', 5000, now() - interval '2 minutes'),
  (:'co' || '/subs/s1/stray.jpg', :'co', 'paperwork', 9000, now() - interval '3 minutes'),
  (:'co' || '/plans/later.pdf', :'co', 'form', 5000, now() + interval '1 hour');
select tpu.check(tpu.error_of(format('insert into public.upload_links (path, company_id, kind, max_bytes, expires_at) values (%L, %L, ''form'', 1, now())', '00000000-0000-4000-8000-000000000000/plans/x.pdf', :'co')) like '23514:%',
  'a link''s file is in its own company''s folder');
select tpu.check(tpu.error_of(format('insert into public.upload_links (path, company_id, kind, max_bytes, expires_at) values (%L, %L, ''form'', 1, now())', :'co' || '/plans/../x.pdf', :'co')) like '23514:%',
  'and never climbs out of it');
select tpu.check(tpu.error_of(format('insert into public.upload_links (path, company_id, kind, max_bytes, expires_at) values (%L, %L, ''form'', 0, now())', :'co' || '/plans/y.pdf', :'co')) like '23514:%',
  'a link''s file has a size');
-- One of them arrived and was recorded on the request's Plans and files.
insert into public.plan_files (company_id, request_id, title, path, file_name, created_by) values (:'co', :'request', 'Site plan', :'co' || '/plans/' || :'kept' || '.pdf', 'site plan.pdf', null);
reset role;

begin;
set local role authenticated;
select tpu.as_user(:'ann');
select tpu.check(tpu.error_of('select count(*) from public.upload_links') like '42501:%', 'people signed in, the owner too, don''t read upload links');
select tpu.check(tpu.error_of(format('insert into public.upload_links (path, company_id, kind, max_bytes, expires_at) values (%L, %L, ''form'', 1, now() + interval ''1 day'')', :'co' || '/plans/mine.pdf', :'co')) like '42501:%',
  'nor make them');
select tpu.check(tpu.error_of('select * from public.expired_upload_links(10)') like '42501:%', 'nor ask which ran out');
commit;

set role service_role;
select tpu.check(tpu.error_of('select * from public.expired_upload_links(0)') like '22023:%', 'a limit is at least 1');
create temp table tpu_ran_out as select * from public.expired_upload_links(2);
select tpu.check((select sum(links) from tpu_ran_out) = 2, 'the links that ran out longest ago go first, up to the limit');
select tpu.check((select paths from tpu_ran_out where company_id = :'co') = array[:'co' || '/plans/stray.pdf', :'co' || '/subs/s1/stray.jpg'],
  'and their files nobody recorded are handed over');
create temp table tpu_rest as select * from public.expired_upload_links(10);
select tpu.check((select links from tpu_rest where company_id = :'co') = 1 and (select paths from tpu_rest where company_id = :'co') = '{}'::text[],
  'a recorded file is never handed over, though its link is forgotten');
select tpu.check(not exists (select 1 from public.expired_upload_links(10)), 'each link is handed over once');
select tpu.check((select array_agg(path) from public.upload_links) = array[:'co' || '/plans/later.pdf'], 'a link still open stays');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Guides' share links
-- ---------------------------------------------------------------------------------------------

begin;
set local role authenticated;
select tpu.as_user(:'ann');
select tpu.check((select count(*) from public.sop_shares where page_id = :'guide') = 1, 'the owner reads the guide''s share link');
select tpu.as_user(:'ann', 'oauth-client-1');
select tpu.check((select count(*) from public.sop_shares) = 0, 'an AI assistant''s token, signed in as the owner, reads no share link');
commit;

delete from public.companies where id = :'co';

set client_min_messages = warning;
drop schema tpu cascade;
reset client_min_messages;

\o
\echo 'All public upload links tests passed.'
