-- Database tests for paving worksheets: the office keeps the calculator's working on a quote and
-- its line, and nobody else sees it: not crew leads, not field crews, not another company. A
-- worksheet's line is one of its own quote's, it stays on its quote, and it goes with the quote.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tpw;
grant usage on schema tpw to authenticated, service_role;
create function tpw.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tpw.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tpw to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b7a40000-0000-0000-0000-000000000001', 'owner@pave.test', '{"full_name": "Pam Owner"}'),
  ('b7a40000-0000-0000-0000-000000000002', 'estimator@pave.test', '{"full_name": "Ed Estimator"}'),
  ('b7a40000-0000-0000-0000-000000000003', 'lead@pave.test', '{"full_name": "Lyle Lead"}'),
  ('b7a40000-0000-0000-0000-000000000004', 'crew@pave.test', '{"full_name": "Cruz Crew"}'),
  ('b7a40000-0000-0000-0000-000000000005', 'owner@other.test', '{"full_name": "Otto Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a40000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Pave Co', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'b7a40000-0000-0000-0000-000000000002', 'estimator'),
  (:'co', 'b7a40000-0000-0000-0000-000000000003', 'crew_lead'),
  (:'co', 'b7a40000-0000-0000-0000-000000000004', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Dee Driveway') returning id as client \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Driveway') returning id as q1 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, unit_cost) values (:'co', :'q1', 'Mill and overlay', 1, 59390, 38390) returning id as l1 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Barn lot') returning id as q2 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (:'co', :'q2', 'Gravel', 1, 4000) returning id as l2 \gset
commit;

-- The estimator keeps the working with the quote and its line, and changes its notes and working.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a40000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.paving_worksheets (company_id, quote_id, line_id, name, notes, data)
  values (:'co', :'q1', :'l1', 'Mill and overlay', 'Quote 2, entire driveway including circle', '{"v": 1, "input": {"sqft": 12000}}') returning id as ws \gset
select tpw.check((select count(*) from public.paving_worksheets where quote_id = :'q1') = 1, 'the estimator keeps a worksheet on the quote');
update public.paving_worksheets set notes = 'Quote 2', data = '{"v": 1, "input": {"sqft": 11796}}' where id = :'ws';
select tpw.check((select notes = 'Quote 2' and data #>> '{input,sqft}' = '11796' from public.paving_worksheets where id = :'ws'), 'and changes its notes and working');
select tpw.expect_error(format('insert into public.paving_worksheets (company_id, quote_id, line_id, name, data) values (%L, %L, %L, %L, %L)', :'co', :'q1', :'l2', 'Wrong', '{}'),
  'a worksheet''s line is one of its own quote''s');
select tpw.expect_error(format('update public.paving_worksheets set line_id = %L where id = %L', :'l2', :'ws'), 'even when it''s changed');
select tpw.expect_error(format('update public.paving_worksheets set quote_id = %L where id = %L', :'q2', :'ws'), 'and it stays on its quote');
select tpw.expect_error(format('insert into public.paving_worksheets (company_id, quote_id, name, data) values (%L, %L, %L, %L)', :'co', :'q1', 'Not an object', '[1]'), 'its working is an object');
commit;

-- Crew leads and field crews never see it, or add one.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a40000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tpw.check((select count(*) from public.paving_worksheets) = 0, 'a crew lead sees no worksheets');
select tpw.expect_error(format('insert into public.paving_worksheets (company_id, quote_id, name, data) values (%L, %L, %L, %L)', :'co', :'q1', 'Lead', '{}'), 'or adds one');
select set_config('request.jwt.claims', '{"sub": "b7a40000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tpw.check((select count(*) from public.paving_worksheets) = 0, 'a field crew member sees none');
update public.paving_worksheets set notes = 'changed' where id = :'ws';
delete from public.paving_worksheets where id = :'ws';
commit;
select tpw.check((select notes = 'Quote 2' from public.paving_worksheets where id = :'ws'), 'or changes or deletes one');

-- Another company sees nothing and can't add to this one's quote.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a40000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select public.create_company('Other Paving', 'paving') as other \gset
select tpw.check((select count(*) from public.paving_worksheets) = 0, 'another company sees no worksheets');
select tpw.expect_error(format('insert into public.paving_worksheets (company_id, quote_id, name, data) values (%L, %L, %L, %L)', :'co', :'q1', 'Sneaky', '{}'), 'or adds one to this company''s quote');
select tpw.expect_error(format('insert into public.paving_worksheets (company_id, quote_id, name, data) values (%L, %L, %L, %L)', :'other', :'q1', 'Sneaky', '{}'), 'even from its own company');
commit;

-- Taking the line off keeps the working; deleting the quote takes it.
delete from public.quote_line_items where id = :'l1';
select tpw.check((select line_id is null from public.paving_worksheets where id = :'ws'), 'the working stays when its line is taken off');
delete from public.quotes where id = :'q1';
select tpw.check((select count(*) from public.paving_worksheets where id = :'ws') = 0, 'and goes with its quote');

\echo 'All paving worksheets tests passed.'
