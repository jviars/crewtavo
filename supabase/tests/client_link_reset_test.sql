-- Database tests for resetting one client's links (20261112000520_client_link_reset.sql): a client
-- starts with no reset; nobody signed in can set the time, move it or clear it, only the server;
-- and a merge leaves the kept client with the later of the two resets, so links ended for either
-- client stay ended.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema clr;
grant usage on schema clr to authenticated, service_role;
create function clr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema clr to authenticated, service_role;

-- Lena owns Larch Link Lawn.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c11e0000-0000-0000-0000-000000000001', 'lena@larch-link.test', '{"full_name": "Lena Larch"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c11e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Larch Link Lawn', 'general') as co \gset
commit;
insert into public.clients (company_id, display_name) values (:'co', 'Ada Asked') returning id as ada \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ada A.') returning id as ada2 \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bo Both') returning id as bo \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bo B.') returning id as bo2 \gset

-- Someone signed in tries to make a client with a reset already on, and to set one.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c11e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.clients (company_id, display_name, links_reset_at) values (:'co', 'Cy Cheeky', now());
update public.clients set links_reset_at = now() where id = :'ada';
commit;
select id as cy from public.clients where company_id = :'co' and display_name = 'Cy Cheeky' \gset
select clr.check((select count(*) = 5 and bool_and(links_reset_at is null) from public.clients where company_id = :'co'), 'a client starts with no reset, and nobody signed in can set one');

-- The server resets Ada's links (the office asked), and both Bos'.
update public.clients set links_reset_at = '2026-11-01 12:00+00' where id = :'ada';
update public.clients set links_reset_at = '2026-11-05 12:00+00' where id = :'bo';
update public.clients set links_reset_at = '2026-11-03 12:00+00' where id = :'bo2';
select clr.check((select links_reset_at = '2026-11-01 12:00+00' from public.clients where id = :'ada'), 'the server sets it');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c11e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.clients set links_reset_at = null where id = :'ada';
update public.clients set links_reset_at = '2020-01-01', notes = 'Gate sticks' where id = :'bo';
commit;
select clr.check((select links_reset_at = '2026-11-01 12:00+00' from public.clients where id = :'ada'), 'nobody signed in can clear it and bring ended links back');
select clr.check((select links_reset_at = '2026-11-05 12:00+00' and notes = 'Gate sticks' from public.clients where id = :'bo'), 'or move it back, while the rest of their edit is saved');

-- Merging: Ada (reset) goes into Ada A. (never reset), who then goes into Cy; Bo B. (reset
-- earlier) goes into Bo.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c11e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.merge_clients(:'co', :'ada2', :'ada');
select public.merge_clients(:'co', :'bo', :'bo2');
select public.merge_clients(:'co', :'cy', :'ada2');
commit;
select clr.check((select count(*) = 0 from public.clients where id in (:'ada', :'ada2', :'bo2')), 'the merged clients are gone');
select clr.check((select links_reset_at = '2026-11-05 12:00+00' from public.clients where id = :'bo'), 'a kept client keeps its own later reset');
select clr.check((select links_reset_at = '2026-11-01 12:00+00' from public.clients where id = :'cy'), 'a kept client takes the merged client''s reset, through two merges, so its ended links stay ended');

\echo 'All client link reset tests passed.'
