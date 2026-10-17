-- Database tests for forgotten clocks: a long-running clock reminds its owner and crew lead once,
-- and a clock left on overnight is stopped and marked for the office to check.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t12;
grant usage on schema t12 to authenticated, service_role;
create function t12.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('ac000000-0000-0000-0000-000000000001', 'owner@lima.test', '{"full_name": "Lin Owner"}'),
  ('ac000000-0000-0000-0000-000000000002', 'lead@lima.test', '{"full_name": "Lou Lead"}'),
  ('ac000000-0000-0000-0000-000000000003', 'ray@lima.test', '{"full_name": "Ray Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ac000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Lima Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'ac000000-0000-0000-0000-000000000002', 'crew_lead'),
  (:'co', 'ac000000-0000-0000-0000-000000000003', 'field_crew');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Paving', 'ac000000-0000-0000-0000-000000000002') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'ac000000-0000-0000-0000-000000000003');
commit;

insert into public.time_entries (company_id, user_id, started_at) values (:'co', 'ac000000-0000-0000-0000-000000000003', now() - interval '11 hours') returning id as long \gset
insert into public.time_entries (company_id, user_id, started_at) values (:'co', 'ac000000-0000-0000-0000-000000000002', now() - interval '20 hours') returning id as overnight \gset
insert into public.time_entries (company_id, user_id, started_at) values (:'co', 'ac000000-0000-0000-0000-000000000001', now() - interval '2 hours') returning id as fresh \gset

select public.clock_upkeep() as first \gset
select t12.check((:'first'::jsonb ->> 'reminded')::int = 1 and (:'first'::jsonb ->> 'stopped')::int = 1, 'one clock gets a reminder and one is stopped');
select t12.check((select count(*) from public.notifications where kind = 'time' and title = 'Your clock is still running' and user_id = 'ac000000-0000-0000-0000-000000000003') = 1, 'the person is reminded');
select t12.check((select count(*) from public.notifications where kind = 'time' and title = 'Ray Crew''s clock is still running' and user_id = 'ac000000-0000-0000-0000-000000000002') = 1, 'and so is their crew lead');
select t12.check((select ended_at is not null and auto_stopped_at is not null and ended_at > started_at and ended_at <= started_at + interval '16 hours' from public.time_entries where id = :'overnight'), 'the overnight clock is stopped within its day and marked');
select t12.check((select count(*) from public.notifications where title = 'Your clock was stopped for you' and user_id = 'ac000000-0000-0000-0000-000000000002') = 1, 'and its owner is told');
select t12.check((select ended_at is null and reminded_at is null from public.time_entries where id = :'fresh'), 'a two-hour clock is left alone');

select public.clock_upkeep() as second \gset
select t12.check((:'second'::jsonb ->> 'reminded')::int = 0 and (:'second'::jsonb ->> 'stopped')::int = 0, 'nobody is reminded twice');

update public.companies set settings = settings || '{"clock": {"remind_after_hours": 1}}' where id = :'co';
select public.clock_upkeep() as third \gset
select t12.check((:'third'::jsonb ->> 'reminded')::int = 1, 'companies can set their own limits');

\echo 'All clock tests passed.'
