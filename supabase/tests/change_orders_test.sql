-- Database tests for change orders, materials logged from the field, and the price list being
-- closed to crews. Run with scripts/test-db.sh (plain Postgres + prelude.sql).
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t14;
grant usage on schema t14 to authenticated, service_role;
create function t14.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t14.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t14 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('ae000000-0000-0000-0000-000000000001', 'owner@nov.test', '{"full_name": "Noa Owner"}'),
  ('ae000000-0000-0000-0000-000000000002', 'crew@nov.test', '{"full_name": "Cy Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ae000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('November Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'ae000000-0000-0000-0000-000000000002', 'field_crew');
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'HMA surface', 'ton', 140, 82) returning id as hma \gset
insert into public.clients (company_id, display_name) values (:'co', 'Oak Plaza') returning id as client \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Parking lot') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'quote', 'Overlay', 100, 'ton', 140);
select public.convert_quote_to_job(:'quote') as job \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'job', 'Paving', current_date + 1) returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'ae000000-0000-0000-0000-000000000002');

-- A change order: priced like a quote, tied to the job.
insert into public.quotes (company_id, client_id, title, change_order_for) values (:'co', :'client', 'Change order: add speed bumps', :'job') returning id as co_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'co_quote', 'Speed bump', 3, 'ea', 450);
update public.quotes set status = 'sent', sent_at = now() where id = :'co_quote';
commit;

-- The client approves it in the Client Hub (the server does that as the service role).
update public.quotes set status = 'approved', approved_at = now() where id = :'co_quote';
select t14.check((select status from public.quotes where id = :'co_quote') = 'converted', 'an approved change order is added to its job');
select t14.check((select contract_total from public.job_financials where job_id = :'job') = 15350, 'and the job''s total includes it');
select t14.check((select count(*) from public.job_line_items where job_id = :'job' and source_quote_id = :'co_quote') = 1, 'its lines say where they came from');
select t14.check((select count(*) from public.jobs where company_id = :'co') = 1, 'no new job is made');
select t14.expect_error(format('select public.convert_quote_to_job(%L)', :'co_quote'), 'it can''t be added twice');
select t14.check((select count(*) from public.job_line_items where job_id = :'job' and source_quote_id = :'co_quote') = 1, 'so its lines are there once');

-- The crew: no price list, but materials by name, and logs what went in.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ae000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t14.check((select count(*) from public.services where company_id = :'co') = 0, 'crews can''t read the price list');
select t14.check((select count(*) from public.material_choices(:'co') where name = 'HMA surface' and unit = 'ton') = 1, 'but can pick materials by name and unit');
insert into public.job_materials (company_id, job_id, visit_id, service_id, name, quantity, unit, ticket) values (:'co', :'job', :'visit', :'hma', 'HMA surface', 42.5, 'ton', 'T-88123');
select t14.check((select count(*) from public.job_materials where job_id = :'job') = 1, 'the crew logs material with its ticket');
select t14.check((select count(*) from public.job_material_costs(:'job')) = 0, 'but doesn''t see what it cost');
select t14.expect_error(format('insert into public.job_materials (company_id, job_id, name, quantity, logged_by) values (%L, %L, %L, 1, %L)', :'co', :'job', 'Stone', 'ae000000-0000-0000-0000-000000000001'), 'and logs only as themselves');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ae000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t14.check((select cost from public.job_material_costs(:'job')) = 3485, 'job costing values materials at the price list''s cost (42.5 t x $82)');
commit;

\echo 'All change order tests passed.'
