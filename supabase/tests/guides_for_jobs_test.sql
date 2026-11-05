-- Database tests for guides for a job (20261108000100_guides_for_jobs.sql): a role's job description
-- is one of its own company's guides, and deleting that guide (by office staff who can't manage
-- roles) leaves the role without one instead of being refused.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tgj;
grant usage on schema tgj to authenticated, service_role;
create function tgj.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tgj.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tgj to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('9b000000-0000-4000-8000-000000000001', 'owner@juliet.test', '{"full_name": "Jo Owner"}'),
  ('9b000000-0000-4000-8000-000000000002', 'ops@juliet.test', '{"full_name": "Oz Ops"}'),
  ('9b000000-0000-4000-8000-000000000003', 'owner@kilo.test', '{"full_name": "Kit Kilo"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9b000000-0000-4000-8000-000000000003", "role": "authenticated"}', true);
select public.create_company('Kilo Paving', 'paving') as other \gset
insert into public.sop_pages (company_id, title) values (:'other', 'Kilo office admin') returning id as other_guide \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9b000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select public.create_company('Juliet Paving', 'paving') as co \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
insert into public.sop_pages (company_id, title, required, audience_roles) values (:'co', 'Operations manager', true, array[:'ops_role']::uuid[]) returning id as guide \gset
update public.company_roles set guide_id = :'guide' where id = :'ops_role';
select tgj.check((select guide_id from public.company_roles where id = :'ops_role') = :'guide', 'an owner gives a role its job description');
select tgj.check((select audience_roles from public.sop_pages where id = :'guide') = array[:'ops_role']::uuid[], 'a guide is required reading for a team role');
select tgj.expect_error(format('update public.company_roles set guide_id = %L where id = %L', :'other_guide', :'ops_role'), 'another company''s guide can''t be a role''s job description');
commit;

-- Office staff with the knowledge base but not the team area.
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', '9b000000-0000-4000-8000-000000000002', 'office', :'ops_role');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9b000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
delete from public.sop_pages where id = :'guide';
select tgj.check((select count(*) from public.sop_pages where id = :'guide') = 0, 'office staff delete a guide that''s a role''s job description');
select tgj.check((select guide_id is null from public.company_roles where id = :'ops_role'), 'and the role is left without one');
commit;
