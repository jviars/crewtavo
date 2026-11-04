-- Database tests for Show to client on a checklist (20261106000600_checklists_for_clients): it's
-- off on a new checklist, the owner turns it on and off, and neither the crew nor another business
-- can turn it on.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_cfc;
grant usage on schema t_cfc to authenticated, service_role;
create function t_cfc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema t_cfc to authenticated, service_role;

-- Rhea owns Sorrel Gutters and Tad is on her crew; Uma owns Umber Pools.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c5c70000-0000-0000-0000-000000000001', 'rhea@sorrel-gutters.test', '{"full_name": "Rhea Sorrel"}'),
  ('c5c70000-0000-0000-0000-000000000002', 'tad@sorrel-gutters.test', '{"full_name": "Tad Sorrel"}'),
  ('c5c70000-0000-0000-0000-000000000003', 'uma@umber-pools.test', '{"full_name": "Uma Umber"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5c70000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.create_company('Umber Pools', 'general') as other \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5c70000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Sorrel Gutters', 'general') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'c5c70000-0000-0000-0000-000000000002', 'field_crew');
insert into public.checklist_templates (company_id, name, items) values (:'co', 'Sorrel cleanup sign-off', '[]') returning id as list \gset
select t_cfc.check(not (select show_to_client from public.checklist_templates where id = :'list'), 'a new checklist isn''t shown to clients');
update public.checklist_templates set show_to_client = true where id = :'list';
select t_cfc.check((select show_to_client from public.checklist_templates where id = :'list'), 'the owner shows it to clients');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5c70000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.checklist_templates set show_to_client = false where id = :'list';
commit;
select t_cfc.check((select show_to_client from public.checklist_templates where id = :'list'), 'the crew can''t turn it off');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5c70000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.checklist_templates set show_to_client = false where id = :'list';
commit;
select t_cfc.check(not (select show_to_client from public.checklist_templates where id = :'list'), 'the owner turns it off again');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5c70000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.checklist_templates set show_to_client = true where id = :'list';
commit;
select t_cfc.check(not (select show_to_client from public.checklist_templates where id = :'list'), 'nor turn it on');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5c70000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.checklist_templates set show_to_client = true where id = :'list';
commit;
select t_cfc.check(not (select show_to_client from public.checklist_templates where id = :'list'), 'and another business can''t either');

\echo 'All checklists-for-clients tests passed.'
