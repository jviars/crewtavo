-- Database tests for finishing the paperwork on site (20261106000700_field_lines): the crew on a
-- visit adds a price list item to its job at the office's price, which they still can't read, and
-- the line says who added it and when; sent twice, it's added once. Not crew off the visit, not on a
-- repeating or cancelled job's visit, never another business. Invoicing and recording cash or check
-- go through the office's own paths, which turn crews (and an office role without invoices) away.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_ffl;
grant usage on schema t_ffl to authenticated, service_role;
create function t_ffl.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_ffl.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function t_ffl.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t_ffl to authenticated, service_role;

-- Rosa owns Sorrel Paving: Tad is crew on the driveway visit, Uma is crew who isn't, Lars leads a
-- crew, Owen is office, Bree is office without invoices. Ines owns Isle Lawn.
\set rosa 'fa110000-0000-0000-0000-000000000001'
\set tad 'fa110000-0000-0000-0000-000000000002'
\set uma 'fa110000-0000-0000-0000-000000000003'
\set lars 'fa110000-0000-0000-0000-000000000004'
\set owen 'fa110000-0000-0000-0000-000000000005'
\set bree 'fa110000-0000-0000-0000-000000000006'
\set ines 'fa110000-0000-0000-0000-000000000007'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'rosa', 'rosa@sorrel-paving.test', '{"full_name": "Rosa Sorrel"}'),
  (:'tad', 'tad@sorrel-paving.test', '{"full_name": "Tad Sorrel"}'),
  (:'uma', 'uma@sorrel-paving.test', '{"full_name": "Uma Sorrel"}'),
  (:'lars', 'lars@sorrel-paving.test', '{"full_name": "Lars Sorrel"}'),
  (:'owen', 'owen@sorrel-paving.test', '{"full_name": "Owen Sorrel"}'),
  (:'bree', 'bree@sorrel-paving.test', '{"full_name": "Bree Sorrel"}'),
  (:'ines', 'ines@isle-lawn.test', '{"full_name": "Ines Isle"}');

begin;
set local role authenticated;
select t_ffl.as_user(:'ines');
select public.create_company('Isle Lawn', 'general') as other \gset
insert into public.services (company_id, name, unit, unit_price) values (:'other', 'Isle mulch', 'yd', 60) returning id as their_mulch \gset
commit;

begin;
set local role authenticated;
select t_ffl.as_user(:'rosa');
select public.create_company('Sorrel Paving', 'general') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Sorrel dispatcher', 'office', '{schedule,settings}') returning id as dispatch_role \gset
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'tad', 'field_crew', null), (:'co', :'uma', 'field_crew', null), (:'co', :'lars', 'crew_lead', null),
  (:'co', :'owen', 'office', null), (:'co', :'bree', 'office', :'dispatch_role');
set local role authenticated;
insert into public.services (company_id, name, description, unit, unit_price, unit_cost, taxable) values
  (:'co', 'Sorrel crack seal', 'Hot-pour rubberized', 'lf', 2.50, 1.10, true) returning id as seal \gset
insert into public.services (company_id, name, unit, unit_price, active) values (:'co', 'Sorrel old patch', 'ea', 90, false) returning id as old_patch \gset
insert into public.clients (company_id, display_name) values (:'co', 'Sorrel Client Ada') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Sorrel driveway') returning id as job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, sort) values (:'co', :'job', 'Sorrel driveway seal', 1, 'ea', 300, 0);
insert into public.visits (company_id, job_id, title, starts_at, ends_at) values (:'co', :'job', 'Sorrel seal day', now(), now() + interval '4 hours') returning id as visit \gset
insert into public.visits (company_id, job_id, title, starts_at, ends_at, status) values (:'co', :'job', 'Sorrel rain day', now() - interval '1 day', now() - interval '20 hours', 'cancelled') returning id as called_off \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode) values (:'co', :'client', 'Sorrel lot sweep', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'per_visit') returning id as sweep \gset
insert into public.visits (company_id, job_id, title, starts_at, ends_at) values (:'co', :'sweep', 'Sorrel sweep', now(), now() + interval '1 hour') returning id as sweep_visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', :'tad'), (:'co', :'called_off', :'tad'), (:'co', :'sweep_visit', :'tad');
commit;

-- ===== The crew on the visit ======================================================================
\set line 'fa110000-0000-0000-0000-0000000000a1'
begin;
set local role authenticated;
select t_ffl.as_user(:'tad');
select t_ffl.check(public.add_field_line(:'visit', :'seal', 40, :'line') = :'line', 'Tad adds 40 lf of crack seal to his visit''s job');
select t_ffl.check(public.add_field_line(:'visit', :'seal', 40, :'line') = :'line', 'sent again after no signal, it answers the same line');
select t_ffl.check(not exists (select from public.job_line_items where job_id = :'job'), 'he still can''t read the job''s lines (they have prices)');
select t_ffl.check((select array_agg(name || ' ' || quantity || ' ' || unit order by sort) from public.job_scope(:'job')) = '{"Sorrel driveway seal 1.000 ea","Sorrel crack seal 40.000 lf"}',
  'but his list of the work has it, after what was there');
select t_ffl.expect_error(format('select public.add_field_line(%L, %L, 1)', :'sweep_visit', :'seal'), 'not on a repeating job, where it would bill every visit');
select t_ffl.expect_error(format('select public.add_field_line(%L, %L, 1)', :'called_off', :'seal'), 'not on a cancelled visit');
select t_ffl.expect_error(format('select public.add_field_line(%L, %L, 1)', :'visit', :'old_patch'), 'not an item taken off the price list');
select t_ffl.expect_error(format('select public.add_field_line(%L, %L, 1)', :'visit', :'their_mulch'), 'nor another business''s item');
select t_ffl.expect_error(format('select public.add_field_line(%L, %L, 0)', :'visit', :'seal'), 'nor none of it');
select t_ffl.expect_error(format('insert into public.job_line_items (company_id, job_id, name, unit_price) values (%L, %L, %L, 1)', :'co', :'job', 'My own price'), 'nor a line of his own, at his own price');
select t_ffl.expect_error(format('select public.create_invoice_for_job(%L)', :'job'), 'he can''t make the invoice');
select t_ffl.expect_error(format('insert into public.payments (company_id, client_id, amount, method) values (%L, %L, 50, %L)', :'co', :'client', 'cash'), 'nor record cash');
commit;

select t_ffl.check((select row(service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, added_in_field_by)::text from public.job_line_items where id = :'line')
  = row(:'seal'::uuid, 'Sorrel crack seal', 'Hot-pour rubberized', 40.000, 'lf', 2.50, 1.10, true, :'tad'::uuid)::text, 'the line is the price list''s item at its price and cost, added by Tad');
select t_ffl.check((select added_in_field_at > now() - interval '1 minute' from public.job_line_items where id = :'line'), 'and says when');
select t_ffl.check((select count(*) = 2 from public.job_line_items where job_id = :'job'), 'once, though it was sent twice');
select t_ffl.check((select contract_total = 400 from public.job_financials where job_id = :'job'), 'the job is worth that much more');
select t_ffl.check((select added_in_field_at is null from public.job_line_items where job_id = :'job' and name = 'Sorrel driveway seal'), 'the office''s own line isn''t marked');

-- ===== Others on the team =========================================================================
begin;
set local role authenticated;
select t_ffl.as_user(:'uma');
select t_ffl.expect_error(format('select public.add_field_line(%L, %L, 1)', :'visit', :'seal'), 'Uma isn''t on the visit, so she can''t add to it');
select t_ffl.as_user(:'lars');
select public.add_field_line(:'visit', :'seal', 2.5);
select t_ffl.check((select count(*) = 1 from public.job_scope(:'job') where quantity = 2.5), 'Lars, a crew lead, can');
select t_ffl.expect_error(format('select public.create_invoice_for_job(%L)', :'job'), 'but he can''t make the invoice either');
select t_ffl.as_user(:'bree');
select t_ffl.expect_error(format('select public.create_invoice_for_job(%L)', :'job'), 'nor can Bree, office without invoices');
select t_ffl.expect_error(format('insert into public.payments (company_id, client_id, amount, method) values (%L, %L, 50, %L)', :'co', :'client', 'cash'), 'nor record cash');
rollback;

-- ===== The office =================================================================================
begin;
set local role authenticated;
select t_ffl.as_user(:'owen');
select public.create_invoice_for_job(:'job') as inv \gset
select t_ffl.check((select subtotal = 400 from public.invoices where id = :'inv'), 'Owen makes the invoice the office''s way, with the line from the field on it');
update public.invoices set status = 'sent' where id = :'inv';
insert into public.payments (company_id, invoice_id, client_id, amount, method, notes) values (:'co', :'inv', :'client', 150, 'check', '1042 · Left in the mailbox');
insert into public.payments (company_id, invoice_id, client_id, amount, method) values (:'co', :'inv', :'client', 250, 'cash');
select t_ffl.check((select status = 'paid' and amount_paid = 400 from public.invoices where id = :'inv'), 'and records a check and cash, which pay it');
rollback;

-- ===== Another business ===========================================================================
begin;
set local role authenticated;
select t_ffl.as_user(:'ines');
select t_ffl.expect_error(format('select public.add_field_line(%L, %L, 1)', :'visit', :'seal'), 'Ines can''t add to another business''s visit');
select t_ffl.expect_error(format('select public.add_field_line(%L, %L, 1)', :'visit', :'their_mulch'), 'not even with her own item');
select t_ffl.expect_error(format('select public.create_invoice_for_job(%L)', :'job'), 'nor make its invoice');
select t_ffl.expect_error(format('insert into public.payments (company_id, client_id, amount, method) values (%L, %L, 50, %L)', :'co', :'client', 'cash'), 'nor record a payment there');
commit;
select t_ffl.check((select count(*) = 2 from public.job_line_items where job_id = :'job'), 'nothing was added by those turned away');

\echo 'All field lines tests passed.'
