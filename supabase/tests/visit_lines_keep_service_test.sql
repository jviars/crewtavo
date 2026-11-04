-- Database tests for a visit's invoice lines keeping their price list item
-- (20261106000530_visit_lines_keep_service): invoicing a job's completed visits gives each visit's
-- lines the job line's service_id, as the job's own invoice does; a line without one stays without.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tvs;
grant usage on schema tvs to authenticated, service_role;
create function tvs.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tvs to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c7a40000-0000-0000-0000-000000000001', 'bo@birch-yard.test', '{"full_name": "Bo Birch"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a40000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Birch Yard', 'general', 'America/Chicago') as co \gset
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Birch mowing', 'visit', 40) returning id as mowing \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ivy Birch') returning id as ivy \gset
-- Weekly mowing from the price list (renamed on the job), and bagging typed in.
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, billing_mode)
values (:'co', :'ivy', 'Ivy weekly', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', '2026-06-01', 'per_visit') returning id as job \gset
insert into public.job_line_items (company_id, job_id, service_id, name, quantity, unit_price, sort) values
  (:'co', :'job', :'mowing', 'Front and back mow', 1, 40, 0),
  (:'co', :'job', null, 'Bagging', 1, 10, 1);
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at) values
  (:'co', :'job', 'Mowing', 'job', 'completed', '2026-06-01', '2026-06-01 15:00Z'),
  (:'co', :'job', 'Mowing', 'job', 'completed', '2026-06-08', '2026-06-08 15:00Z');
select public.create_invoice_for_job(:'job', 'visits') as inv \gset
commit;

select tvs.check((select count(*) = 4 and count(*) filter (where name = 'Front and back mow' and service_id = :'mowing') = 2
                    and count(*) filter (where name = 'Bagging' and service_id is null) = 2
                  from public.invoice_line_items where invoice_id = :'inv'),
  'each visit''s lines keep the price list item their job line has, and one typed in has none');

\echo 'All visit lines keep service tests passed.'
