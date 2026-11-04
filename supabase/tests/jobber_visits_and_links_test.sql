-- Database tests for a Jobber import's one-off visits and invoice links
-- (20261106000510_jobber_import_visits_and_invoice_jobs): a one-off job comes with the visits it was
-- given, once each, at its property and on no crew; a recurring one gets none from its row; an
-- invoice links to the job its row names when that job came in for the same client, in this import
-- or one before, and comes in without one otherwise (saying which in what it returns). Named to run
-- after jobber_import_test, which counts every record brought in.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tjl;
grant usage on schema tjl to authenticated, service_role;
create function tjl.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tjl to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c7a20000-0000-0000-0000-000000000001', 'lu@linden-lawn.test', '{"full_name": "Lu Linden"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a20000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Linden Lawn', 'general', 'America/New_York') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Rae Holt') returning id as rae \gset
insert into public.properties (company_id, client_id, line1, city) values (:'co', :'rae', '3 Fir Ln', 'Salem') returning id as fir \gset
insert into public.clients (company_id, display_name) values (:'co', 'Sol Ames') returning id as sol \gset
commit;

-- ===== Jobs ====================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a20000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.import_jobber(:'co', 'jobs', jsonb_build_array(
  jsonb_build_object('source_id', 'jobber:J1', 'number', 'J1', 'client_id', :'rae', 'property_id', :'fir', 'title', 'Deck build', 'kind', 'one_off',
    'visit_dates', jsonb_build_array('2026-11-12', '2026-11-05', '2026-11-12'), 'lines', '[]'::jsonb),
  jsonb_build_object('source_id', 'jobber:J2', 'number', 'J2', 'client_id', :'rae', 'title', 'Weekly mow', 'kind', 'recurring',
    'recurrence_rule', 'FREQ=WEEKLY;BYDAY=TU', 'starts_on', '2026-11-03', 'visit_dates', jsonb_build_array('2026-11-10'), 'lines', '[]'::jsonb),
  jsonb_build_object('source_id', 'jobber:J3', 'number', 'J3', 'client_id', :'sol', 'title', 'Fence fix', 'kind', 'one_off', 'lines', '[]'::jsonb)));
commit;
select id as j1 from public.jobs where source_id = 'jobber:J1' \gset
select id as j2 from public.jobs where source_id = 'jobber:J2' \gset
select id as j3 from public.jobs where source_id = 'jobber:J3' \gset

select tjl.check((select array_agg(scheduled_on order by scheduled_on) = '{2026-11-05,2026-11-12}'
                    and bool_and(property_id = :'fir' and crew_id is null and starts_at is null and status = 'scheduled' and title = 'Deck build' and recurrence_key is null)
                  from public.visits where job_id = :'j1'),
  'a one-off job comes with its visits, once a day, any time, at its property and on no crew');
select tjl.check(not exists (select 1 from public.visits where job_id in (:'j2', :'j3')),
  'a recurring job''s come from its schedule, and one with no dates has none');

-- ===== Invoices ================================================================================
-- J1 is Rae's, J3 is Sol's; J4 never came in. 9001 is for J1, 9002 names J3 but is Rae's, 9003 names J4.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a20000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.import_jobber(:'co', 'invoices', jsonb_build_array(
  jsonb_build_object('source_id', 'jobber:9001', 'number', '9001', 'client_id', :'rae', 'job_source_id', 'jobber:J1', 'issued_on', '2026-10-01', 'due_on', '2026-10-31', 'total', 100, 'paid', 0,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Deposit', 'quantity', 1, 'unit_price', 100, 'taxable', false))),
  jsonb_build_object('source_id', 'jobber:9002', 'number', '9002', 'client_id', :'rae', 'job_source_id', 'jobber:J3', 'issued_on', '2026-10-01', 'due_on', '2026-10-31', 'total', 50, 'paid', 0,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Other', 'quantity', 1, 'unit_price', 50, 'taxable', false))),
  jsonb_build_object('source_id', 'jobber:9003', 'number', '9003', 'client_id', :'rae', 'job_source_id', 'jobber:J4', 'issued_on', '2026-10-01', 'due_on', '2026-10-31', 'total', 25, 'paid', 0,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Gone', 'quantity', 1, 'unit_price', 25, 'taxable', false))))) as result \gset
commit;

select tjl.check((select job_id = :'j1' and status in ('sent', 'overdue') and total = 100 from public.invoices where source_id = 'jobber:9001'),
  'an invoice comes in on the job its row names');
select tjl.check((select bool_and(job_id is null) from public.invoices where source_id in ('jobber:9002', 'jobber:9003')),
  'one whose job is another client''s, or never came in, comes in without one');
select tjl.check((select jsonb_agg(r ->> 'job_id' order by r ->> 'source_id') from jsonb_array_elements(:'result'::jsonb) r) = jsonb_build_array(:'j1', null, null),
  'and the import hears which found their job');

-- The same rows again: nothing new, and what was linked stays.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7a20000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.import_jobber(:'co', 'invoices', jsonb_build_array(
  jsonb_build_object('source_id', 'jobber:9001', 'number', '9001', 'client_id', :'rae', 'job_source_id', 'jobber:J1', 'total', 100, 'lines', '[]'::jsonb))) as again \gset
commit;
select tjl.check((:'again'::jsonb -> 0 ->> 'new')::boolean = false and (:'again'::jsonb -> 0 ->> 'job_id')::uuid = :'j1'
  and (select count(*) = 1 from public.invoices where source_id = 'jobber:9001'),
  'importing it again adds nothing, and still says its job');

\echo 'All Jobber import link tests passed.'
