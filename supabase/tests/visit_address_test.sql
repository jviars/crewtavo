-- Database tests for an address on a calendar entry with no client property (20261111000100_visit_address):
-- the office saves one on a task, the crew and a sub on it read it, and a sub can't change it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_addr;
grant usage on schema t_addr to authenticated, service_role;
create function t_addr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_addr.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;
grant execute on all functions in schema t_addr to authenticated, service_role;

-- Ana owns Amber Paving; Cal is on its crew; Sid is a sub.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ad0a0000-0000-0000-0000-000000000001', 'ana@amber-paving.test', '{"full_name": "Ana Amber"}'),
  ('ad0a0000-0000-0000-0000-000000000002', 'cal@amber-paving.test', '{"full_name": "Cal Amber"}'),
  ('ad0a0000-0000-0000-0000-000000000003', 'sid@amber-paving.test', '{"full_name": "Sid Sealing"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ad0a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Amber Paving', 'paving') as co \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', 'ad0a0000-0000-0000-0000-000000000002', 'field_crew');
insert into public.subcontractors (company_id, name) values (:'co', 'Sid''s Sealing') returning id as sub \gset
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', 'ad0a0000-0000-0000-0000-000000000003', 'subcontractor', :'sub');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ad0a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.visits (company_id, kind, title, scheduled_on, address)
  values (:'co', 'task', 'Pick up sealer', current_date, '1200 Industrial Pkwy, Dayton, OH 45404') returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values
  (:'co', :'visit', 'ad0a0000-0000-0000-0000-000000000002'), (:'co', :'visit', 'ad0a0000-0000-0000-0000-000000000003');
select t_addr.check((select address = '1200 Industrial Pkwy, Dayton, OH 45404' and property_id is null from public.visits where id = :'visit'),
  'a task with no client keeps the address it was given');
select t_addr.check(t_addr.error_of(format('update public.visits set address = %L where id = %L', repeat('a', 301), :'visit')) = '23514',
  'an address runs to 300 characters at most');
update public.visits set address = '1300 Industrial Pkwy, Dayton, OH 45404' where id = :'visit';
select t_addr.check((select address = '1300 Industrial Pkwy, Dayton, OH 45404' from public.visits where id = :'visit'), 'the office changes it');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ad0a0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t_addr.check((select address = '1300 Industrial Pkwy, Dayton, OH 45404' from public.visits where id = :'visit'), 'the crew on it reads the address');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ad0a0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t_addr.check((select address = '1300 Industrial Pkwy, Dayton, OH 45404' from public.visits where id = :'visit'), 'so does the sub on it');
select t_addr.check(t_addr.error_of(format('update public.visits set address = %L where id = %L', 'Somewhere else', :'visit')) = '42501',
  'but a sub can''t change it');
update public.visits set status = 'en_route' where id = :'visit';
select t_addr.check((select status = 'en_route' and address = '1300 Industrial Pkwy, Dayton, OH 45404' from public.visits where id = :'visit'), 'they still change its status');
commit;

\echo 'All visit address tests passed.'
