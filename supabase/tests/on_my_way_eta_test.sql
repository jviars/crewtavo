-- Database tests for the arrival time in the "on my way" text (20261105000210_on_my_way_eta): a visit
-- keeps when its crew should get there (and nothing about where they were), the crew on it sets that
-- with the status, and a new business's on_my_way starter says it with {{eta}}. (A sub sets it too:
-- sub_isolation_test.sql.)
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_eta;
grant usage on schema t_eta to authenticated, service_role;
create function t_eta.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema t_eta to authenticated, service_role;

-- Tess owns Teal Lawn; Rory is on its crew.
insert into auth.users (id, email, raw_user_meta_data) values
  ('e7a20000-0000-0000-0000-000000000001', 'tess@teal-lawn.test', '{"full_name": "Tess Teal"}'),
  ('e7a20000-0000-0000-0000-000000000002', 'rory@teal-lawn.test', '{"full_name": "Rory Teal"}');

select t_eta.check((select data_type = 'timestamp with time zone' and is_nullable = 'YES' and column_default is null
  from information_schema.columns where table_schema = 'public' and table_name = 'visits' and column_name = 'eta_at'), 'a visit keeps when its crew should arrive, unknown until worked out');
select t_eta.check(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'visits' and column_name ~ '(lat|lng|location|place)'),
  'and nothing about where the crew was');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a20000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Teal Lawn', 'lawn_exterior') as co \gset
select t_eta.check((select actions -> 0 ->> 'body' = 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now{{eta}}.' and not enabled
  from public.automation_rules where company_id = :'co' and template_key = 'on_my_way'), 'a new business''s on my way text says when the crew should arrive, and starts off');
insert into public.memberships (company_id, user_id, role) values (:'co', 'e7a20000-0000-0000-0000-000000000002', 'field_crew');
insert into public.crews (company_id, name) values (:'co', 'Teal mowing') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'e7a20000-0000-0000-0000-000000000002');
insert into public.clients (company_id, display_name) values (:'co', 'Teal Client Ivy') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Teal front lawn') returning id as job \gset
insert into public.visits (company_id, job_id, crew_id, title, scheduled_on) values (:'co', :'job', :'crew', 'Teal mow', current_date) returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'e7a20000-0000-0000-0000-000000000002');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7a20000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.visits set status = 'en_route', eta_at = now() + interval '20 minutes' where id = :'visit';
select t_eta.check((select status = 'en_route' and eta_at between now() + interval '19 minutes' and now() + interval '21 minutes' from public.visits where id = :'visit'),
  'the crew on the visit says they''re on the way, and when they should get there');
commit;

\echo 'All on my way arrival time tests passed.'
