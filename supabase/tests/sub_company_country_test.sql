-- Database tests for 20261124100400_sub_company_country.sql: a sub's company basics say the
-- business's country, as it's set and changed, with every column the release before reads, for
-- the business's own team and subs only.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1124s;
grant usage on schema t1124s to authenticated, service_role;
create function t1124s.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1124s.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1124s to authenticated, service_role;

\set olive '11240000-0000-4000-8000-000000000011'
\set al '11240000-0000-4000-8000-000000000012'
\set cy '11240000-0000-4000-8000-000000000013'
\set nora '11240000-0000-4000-8000-000000000014'
\set apex '11240000-0000-4000-8000-0000000000a1'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@thames.test', '{"full_name": "Olive Owner"}'),
  (:'al', 'al@apex.test', '{"full_name": "Al Apex"}'),
  (:'cy', 'cy@thames.test', '{"full_name": "Cy Crew"}'),
  (:'nora', 'nora@nora.test', '{"full_name": "Nora Other"}');

begin;
set local role authenticated;
select t1124s.as_user(:'nora');
select public.create_company('Nora Yards', 'general') as other \gset
select t1124s.as_user(:'olive');
select public.create_company('Thames Gardens', 'general', 'Europe/London') as co \gset
update public.companies set country = 'GB', phone = '020 7946 0018' where id = :'co';
insert into public.subcontractors (id, company_id, name) values (:'apex', :'co', 'Apex Roofing');
commit;
-- Al signs in as Apex Roofing, as the server makes a sub's sign-in; Cy is on the team.
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'al', 'subcontractor', :'apex');
insert into public.memberships (company_id, user_id, role) values (:'co', :'cy', 'field_crew');

-- ===== What a sub reads =========================================================================
begin;
set local role authenticated;
select t1124s.as_user(:'al');
select t1124s.check((select country from public.company_basics(:'co')) = 'GB', 'a sub reads the business''s country');
select t1124s.check((select name = 'Thames Gardens' and timezone = 'Europe/London' and currency = 'USD' and phone = '020 7946 0018' and logo is null
    and array(select jsonb_object_keys(settings) order by 1) <@ '{branding,clock,working_hours}'
  from public.company_basics(:'co')), 'with the name, time zone, currency, phone, logo and settings as before');
select t1124s.check(exists (select id, name, timezone, currency, phone, logo, settings from public.company_basics(:'co')),
  'every column the release before reads, by name');
select t1124s.as_user(:'cy');
select t1124s.check((select country from public.company_basics(:'co')) = 'GB', 'and so does the team');
select t1124s.as_user(:'nora');
select t1124s.check(not exists (select 1 from public.company_basics(:'co')), 'but not another business');
rollback;

begin;
set local role authenticated;
select t1124s.as_user(:'olive');
update public.companies set country = 'CA' where id = :'co';
select t1124s.as_user(:'al');
select t1124s.check((select country from public.company_basics(:'co')) = 'CA', 'a country the owner changes is the one the sub reads');
rollback;

-- ===== Who can ask ==============================================================================
select t1124s.check(has_function_privilege('authenticated', 'public.company_basics(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.company_basics(uuid)', 'execute'), 'signed-in people and the server can ask, as before');
select t1124s.check(not has_function_privilege('anon', 'public.company_basics(uuid)', 'execute'), 'someone signed out can''t');
select t1124s.check((select count(*) from pg_proc where proname = 'company_basics' and pronamespace = 'public'::regnamespace) = 1, 'and there''s one of it');

\echo 'All tests of a sub''s company country passed.'
