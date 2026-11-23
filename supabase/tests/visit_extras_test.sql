-- Database tests for 20261113000900_visit_extras.sql: extra work on one visit of a repeating job.
-- It isn't a job line (the job's price and what the previous app reads are as they were); it's
-- billed once, on the invoice that bills its visit, in every billing mode, and only when the visit
-- is done; a voided or deleted invoice frees it and nothing else can; a cancelled or deleted visit
-- leaves it unbilled and tells the office; the crew adds one by item and quantity without seeing a
-- price; tax and a once-per-job discount treat it as any line; and autopay asks the office first.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tvx;
grant usage on schema tvx to authenticated, service_role;
create function tvx.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- Expects p_sql to fail with a message like p_like.
create function tvx.refused(p_sql text, p_like text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not ilike p_like then
      raise exception 'FAIL (wrong error % "%"): %', sqlstate, sqlerrm, p_what;
    end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function tvx.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- A repeating job with one line, priced and invoiced as given.
create function tvx.job(p_company uuid, p_client uuid, p_title text, p_pricing text, p_schedule text, p_price numeric) returns uuid language plpgsql as $$
declare v_job uuid;
begin
  insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule)
  values (p_company, p_client, p_title, 'recurring', 'FREQ=WEEKLY;BYDAY=MO', p_pricing, p_schedule) returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (p_company, v_job, p_title, 1, 'visit', p_price);
  return v_job;
end $$;
-- A visit of it on a day, done or still to come.
create function tvx.visit(p_job uuid, p_on date, p_status text default 'completed') returns uuid language plpgsql as $$
declare v_visit uuid;
begin
  insert into public.visits (company_id, job_id, title, status, scheduled_on)
  select company_id, id, title, p_status, p_on from public.jobs where id = p_job returning id into v_visit;
  return v_visit;
end $$;
-- Extra work on a visit, as the office types it.
create function tvx.extra(p_visit uuid, p_name text, p_price numeric, p_quantity numeric default 1, p_taxable boolean default true) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.visit_extras (company_id, visit_id, name, quantity, unit_price, taxable)
  select company_id, id, p_name, p_quantity, p_price, p_taxable from public.visits where id = p_visit returning id into v_id;
  return v_id;
end $$;
-- An invoice's lines, in order, as "name amount", and its extras as "name: description".
create function tvx.lines(p_invoice uuid) returns text language sql stable as $$
  select string_agg(name || ' ' || round(quantity * unit_price, 2), ', ' order by sort, id) from public.invoice_line_items where invoice_id = p_invoice
$$;
create function tvx.figures(p_invoice uuid) returns text language sql stable as $$
  select subtotal || '/' || tax_amount || '/' || total from public.invoices where id = p_invoice
$$;
-- How many invoices that aren't void bill an extra.
create function tvx.billed_on(p_extra uuid) returns text language sql stable as $$
  select coalesce((select '#' || i.number || ' ' || i.status from public.visit_extras e join public.invoices i on i.id = e.invoice_id where e.id = p_extra), 'none')
$$;
create function tvx.void(p_invoice uuid) returns void language plpgsql as $$
begin
  update public.invoices set status = 'sent' where id = p_invoice and status = 'draft';
  update public.invoices set status = 'void' where id = p_invoice;
end $$;
grant execute on all functions in schema tvx to authenticated, service_role;

-- Mae owns Mossy Lawn; Owen is office; Edie estimates; Tad is crew on the visits, Uma crew who
-- isn't. Ivo owns Ivy Yards, another business.
\set mae 'e9000000-0000-0000-0000-000000000001'
\set owen 'e9000000-0000-0000-0000-000000000002'
\set edie 'e9000000-0000-0000-0000-000000000003'
\set tad 'e9000000-0000-0000-0000-000000000004'
\set uma 'e9000000-0000-0000-0000-000000000005'
\set ivo 'e9000000-0000-0000-0000-000000000006'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mae', 'mae@mossy-lawn.test', '{"full_name": "Mae Moss"}'),
  (:'owen', 'owen@mossy-lawn.test', '{"full_name": "Owen Moss"}'),
  (:'edie', 'edie@mossy-lawn.test', '{"full_name": "Edie Moss"}'),
  (:'tad', 'tad@mossy-lawn.test', '{"full_name": "Tad Moss"}'),
  (:'uma', 'uma@mossy-lawn.test', '{"full_name": "Uma Moss"}'),
  (:'ivo', 'ivo@ivy-yards.test', '{"full_name": "Ivo Ivy"}');

begin;
set local role authenticated;
select tvx.as_user(:'ivo');
select public.create_company('Ivy Yards', 'general') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Ivy Client') returning id as their_client \gset
select tvx.job(:'other', :'their_client', 'Ivy mow', 'per_visit', 'after_visit', 30) as their_job \gset
select tvx.visit(:'their_job', current_date, 'scheduled') as their_visit \gset
commit;

begin;
set local role authenticated;
select tvx.as_user(:'mae');
select public.create_company('Mossy Lawn', 'lawn_exterior', 'America/Chicago') as co \gset
reset role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'owen', 'office'), (:'co', :'edie', 'estimator'), (:'co', :'tad', 'field_crew'), (:'co', :'uma', 'field_crew');
set local role authenticated;
update public.companies set settings = public.company_settings(id) || '{"default_tax_rate": 0.1}' where id = :'co';
insert into public.services (company_id, name, description, unit, unit_price, unit_cost, taxable) values (:'co', 'Mossy mulch', 'Brown hardwood', 'yd', 60, 25, true) returning id as mulch \gset
insert into public.services (company_id, name, unit, unit_price, taxable) values (:'co', 'Mossy aeration', 'ea', 80, false) returning id as aeration \gset
insert into public.clients (company_id, display_name) values (:'co', 'Mossy Client Ada') returning id as client \gset
commit;
select current_date - 21 as d1, current_date - 14 as d2, current_date - 7 as d3, current_date as d4, current_date + 7 as d5 \gset

-- ===== Per visit, invoiced after each visit =======================================================
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.job(:'co', :'client', 'Mossy mow', 'per_visit', 'after_visit', 45) as mow \gset
select tvx.visit(:'mow', :'d1') as mow1 \gset
select tvx.visit(:'mow', :'d2', 'scheduled') as mow2 \gset
select tvx.visit(:'mow', :'d3', 'scheduled') as mow3 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'mow1', :'tad'), (:'co', :'mow2', :'tad'), (:'co', :'mow3', :'tad');

insert into public.visit_extras (company_id, visit_id, service_id, name, description, quantity, unit, unit_price) values (:'co', :'mow1', :'mulch', 'Mossy mulch', 'Front beds', 2, 'yd', 60) returning id as x_mulch \gset
select tvx.extra(:'mow2', 'Storm cleanup', 30) as x_storm \gset
select tvx.check((select job_id = :'mow'::uuid and created_by = :'owen'::uuid and added_in_field_at is null and unit_cost is null from public.visit_extras where id = :'x_mulch'),
  'the office puts extra work on a visit: it''s the job''s, says who added it, and isn''t marked as from the field');
select tvx.check((select unit_labor_cost is null and invoice_id is null from public.visit_extras where id = :'x_mulch'), 'it''s on no invoice yet');
select tvx.check((select contract_total = 45 from public.job_financials where job_id = :'mow') and (select count(*) = 1 from public.job_line_items where job_id = :'mow'),
  'the job''s price for a visit and its lines are as they were: an extra isn''t a job line');
select tvx.check((select count(*) = 1 from public.job_scope(:'mow')), 'and what the previous app lists as the job''s work doesn''t have it');

select public.create_invoice_for_job(:'mow', 'visits') as mow_inv1 \gset
select tvx.check(tvx.lines(:'mow_inv1') = 'Mossy mow 45.00, Mossy mulch 120.00', 'the visit''s invoice bills the visit and its extra, after the visit''s own line');
select tvx.check((select description = 'Extra work, visit on ' || to_char(now() at time zone 'America/Chicago', 'Mon DD, YYYY') || E'\nFront beds' and service_id = :'mulch'::uuid
  from public.invoice_line_items where invoice_id = :'mow_inv1' and name = 'Mossy mulch'), 'as its own line with the visit''s date, its note and its price list item');
select tvx.check(tvx.figures(:'mow_inv1') = '165.00/16.50/181.50', 'taxed like any line at the invoice''s rate');
select tvx.check(tvx.billed_on(:'x_mulch') like '#% draft' and tvx.billed_on(:'x_storm') = 'none', 'the extra says which invoice has it; one on a visit still to come waits');

-- Never twice.
update public.visits set status = 'completed' where id = :'mow2';
select public.create_invoice_for_job(:'mow', 'visits') as mow_inv2 \gset
select tvx.check(tvx.lines(:'mow_inv2') = 'Mossy mow 45.00, Storm cleanup 30.00', 'the next visit''s invoice has its own extra and not the first one''s again');

-- What can't be done to one that's on an invoice.
select tvx.refused(format('update public.visit_extras set unit_price = 1 where id = %L', :'x_mulch'), '%is on invoice #%Change it on the invoice%', 'a billed extra''s price can''t be changed under the invoice');
select tvx.refused(format('delete from public.visit_extras where id = %L', :'x_mulch'), '%is on invoice #%Void the invoice%', 'nor is it deleted');
select tvx.refused(format('update public.visit_extras set invoice_id = null where id = %L', :'x_mulch'), '%Void the invoice to bill it again%', 'nor freed by hand, to be billed twice');
select tvx.refused(format('update public.visit_extras set visit_id = %L where id = %L', :'mow3', :'x_mulch'), '%already on an invoice%', 'nor moved to another visit');
select tvx.refused(format('insert into public.visit_extras (company_id, visit_id, name, unit_price) values (%L, %L, %L, 5)', :'co', :'mow1', 'Late add'),
  '%already on invoice #%', 'and nothing more goes on a visit that''s been invoiced');

-- Voided, it's free again with its visit, and the invoice made in their place bills both once.
select tvx.void(:'mow_inv1');
select tvx.check(tvx.billed_on(:'x_mulch') = 'none' and (select invoice_id is null from public.visits where id = :'mow1'), 'voiding the invoice frees the extra with its visit');
select public.create_invoice_for_job(:'mow', 'visits') as mow_inv3 \gset
select tvx.check(tvx.lines(:'mow_inv3') = 'Mossy mow 45.00, Mossy mulch 120.00', 'the invoice made in its place bills it again');
select tvx.check((select count(*) = 1 from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id where i.job_id = :'mow' and i.status <> 'void' and l.name = 'Mossy mulch'),
  'so it''s on one invoice that isn''t void, never two');
-- A draft deleted frees it too.
delete from public.invoices where id = :'mow_inv3';
select tvx.check(tvx.billed_on(:'x_mulch') = 'none', 'deleting the draft frees it');
update public.visit_extras set quantity = 3 where id = :'x_mulch';
select tvx.check((select quantity = 3 from public.visit_extras where id = :'x_mulch'), 'and free, it can be changed');
select tvx.refused(format('update public.visit_extras set invoice_id = %L where id = %L', :'mow_inv2', :'x_mulch'), '%goes on an invoice when its visit is invoiced%', 'but not put on an invoice by hand');
select public.create_invoice_for_job(:'mow', 'visits') as mow_inv4 \gset
select tvx.check(tvx.lines(:'mow_inv4') = 'Mossy mow 45.00, Mossy mulch 180.00', 'billed again as it is now');

-- A standard invoice on a job billed by the visit leaves the extras for their visits' invoice.
update public.visits set status = 'completed' where id = :'mow3';
select tvx.extra(:'mow3', 'Hedge trim', 40) as x_hedge \gset
select public.create_invoice_for_job(:'mow', 'standard') as mow_std \gset
select tvx.check(tvx.lines(:'mow_std') = 'Mossy mow 45.00' and tvx.billed_on(:'x_hedge') = 'none', 'a standard invoice on a per-visit job doesn''t take its visits'' extras');
delete from public.invoices where id = :'mow_std';
select public.create_invoice_for_job(:'mow', 'visits') as mow_inv_h \gset
select tvx.check(tvx.lines(:'mow_inv_h') = 'Mossy mow 45.00, Hedge trim 40.00', 'the visits invoice made next has them');

-- Where it can't go.
select tvx.visit(:'mow', :'d4', 'cancelled') as mow_off \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Mossy patio') returning id as patio \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'patio', 'Mossy patio day', :'d4') returning id as patio_visit \gset
insert into public.visits (company_id, title, kind, scheduled_on) values (:'co', 'Supply run', 'task', :'d4') returning id as task \gset
select tvx.visit(:'mow', :'d4', 'scheduled') as mow_spare \gset
select tvx.extra(:'mow_spare', 'Spare', 5) as x_spare \gset
select tvx.refused(format('select tvx.extra(%L, %L, 5)', :'mow_off', 'On a cancelled visit'), '%visit is cancelled%', 'not on a cancelled visit');
select tvx.refused(format('select tvx.extra(%L, %L, 5)', :'patio_visit', 'On a one-off job'), '%doesn''t repeat%line items%', 'not on a one-off job, whose work goes in its line items');
select tvx.refused(format('select tvx.extra(%L, %L, 5)', :'task', 'On a task'), '%visit for a job%', 'not on a task');
select tvx.refused(format('select tvx.extra(%L, %L, 5, 0)', :'mow_spare', 'None of it'), '%visit_extras_quantity_check%', 'nor none of it');
select tvx.refused(format('insert into public.visit_extras (company_id, visit_id, name, unit_price) values (%L, %L, %L, 5)', :'co', :'their_visit', 'Theirs'), '%', 'nor on another business''s visit');
select tvx.refused(format('update public.visit_extras set visit_id = %L where id = %L', :'patio_visit', :'x_spare'), '%stays with its job%', 'and it can''t be moved to another job''s visit');
delete from public.visit_extras where id = :'x_spare';
select tvx.check(not exists (select 1 from public.visit_extras where id = :'x_spare'), 'one that isn''t on an invoice can be removed');
delete from public.visits where id = :'mow_spare';
commit;

-- ===== A visit cancelled or deleted ===============================================================
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.visit(:'mow', :'d5', 'scheduled') as mow5 \gset
select tvx.visit(:'mow', :'d5'::date + 7, 'scheduled') as mow6 \gset
select tvx.visit(:'mow', :'d5'::date + 14, 'scheduled') as mow7 \gset
select tvx.extra(:'mow5', 'Leaf haul', 55) as x_leaf \gset
select tvx.extra(:'mow6', 'Edging', 20) as x_edge \gset
update public.visits set status = 'cancelled' where id = :'mow5';
delete from public.visits where id = :'mow6';
commit;
select tvx.check((select visit_id = :'mow5'::uuid and invoice_id is null from public.visit_extras where id = :'x_leaf'), 'an extra on a cancelled visit stays, unbilled');
select tvx.check((select visit_id is null and visit_was_on = :'d5'::date + 7 and invoice_id is null from public.visit_extras where id = :'x_edge'),
  'an extra whose visit was deleted stays too, with the day the visit was for');
select tvx.check((select count(*) = 2 and bool_and(link = '/jobs/' || :'mow') from public.notifications where user_id = :'owen' and title like 'Extra work wasn''t billed%')
  and (select body like 'Leaf haul, on Mossy Client Ada: Mossy mow%' from public.notifications where user_id = :'owen' and title = 'Extra work wasn''t billed: its visit was cancelled')
  and exists (select 1 from public.notifications where user_id = :'mae' and title = 'Extra work wasn''t billed: its visit was removed'),
  'the office with invoices is told once for each, with the work, the job and the day');
select tvx.check(not exists (select 1 from public.notifications where user_id in (:'tad', :'edie') and title like 'Extra work wasn''t billed%'), 'not the crew or an estimator');
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.refused(format('select public.create_invoice_for_job(%L, %L)', :'mow', 'visits'), '%no completed visits waiting%', 'neither is billed: there''s no finished visit to bill');
-- Put on another visit, they're billed with it.
update public.visit_extras set visit_id = :'mow7' where id in (:'x_leaf', :'x_edge');
select tvx.check((select bool_and(visit_id = :'mow7'::uuid and visit_was_on is null) from public.visit_extras where id in (:'x_leaf', :'x_edge')), 'the office puts them on another visit');
select tvx.refused(format('update public.visit_extras set visit_id = null where id = %L', :'x_leaf'), '%stays on a visit%', 'an extra can''t be taken off its visit and left on none');
update public.visits set status = 'completed' where id = :'mow7';
select public.create_invoice_for_job(:'mow', 'visits') as mow_inv5 \gset
-- Both extras were made in one transaction, at one time, so which follows the other isn't set.
select tvx.check(tvx.lines(:'mow_inv5') in ('Mossy mow 45.00, Leaf haul 55.00, Edging 20.00', 'Mossy mow 45.00, Edging 20.00, Leaf haul 55.00'), 'and they''re billed with that visit');
commit;

-- A visit with extra work on it isn't one of those a closed job's schedule drops.
begin;
set local role authenticated;
select tvx.as_user(:'owen');
insert into public.visits (company_id, job_id, title, status, scheduled_on, recurrence_key) values (:'co', :'mow', 'Mossy mow', 'scheduled', :'d5'::date + 21, (:'d5'::date + 21)::text) returning id as mow8 \gset
insert into public.visits (company_id, job_id, title, status, scheduled_on, recurrence_key) values (:'co', :'mow', 'Mossy mow', 'scheduled', :'d5'::date + 28, (:'d5'::date + 28)::text) returning id as mow9 \gset
select tvx.extra(:'mow8', 'Fall aeration', 80) as x_fall \gset
reset role;
select tvx.check((select array_agg(v) = array[:'mow9'::uuid] from private.job_waiting_visits(:'mow') v), 'closing the job would drop its waiting visits, but not the one with extra work on it');
rollback;

-- ===== Per visit, invoiced monthly ================================================================
select date_trunc('month', current_date - interval '2 months')::date as m0 \gset
select (:'m0'::date + interval '1 month')::date as m1 \gset
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.job(:'co', :'client', 'Mossy monthly mow', 'per_visit', 'monthly', 40) as mm \gset
select tvx.visit(:'mm', :'m0'::date + 5) as mm1 \gset
select tvx.visit(:'mm', :'m0'::date + 12, 'scheduled') as mm2 \gset
select tvx.visit(:'mm', :'m1'::date + 3) as mm3 \gset
select tvx.extra(:'mm1', 'Spring mulch', 100) as x_mm1 \gset
select tvx.extra(:'mm2', 'Not done yet', 15) as x_mm2 \gset
select tvx.extra(:'mm3', 'Next month''s trim', 25) as x_mm3 \gset
select public.create_invoice_for_job(:'mm', 'visits', null, :'m0') as mm_inv0 \gset
select tvx.check(tvx.lines(:'mm_inv0') = 'Mossy monthly mow 40.00, Spring mulch 100.00', 'the month''s invoice bills the month''s finished visit and its extra');
select tvx.check(tvx.billed_on(:'x_mm2') = 'none' and tvx.billed_on(:'x_mm3') = 'none', 'not an extra on a visit that isn''t done, nor next month''s');
select public.create_invoice_for_job(:'mm', 'visits', null, :'m1') as mm_inv1 \gset
select tvx.check(tvx.lines(:'mm_inv1') = 'Mossy monthly mow 40.00, Next month''s trim 25.00', 'next month''s invoice has next month''s');
commit;

-- ===== A fixed price, invoiced monthly ============================================================
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.job(:'co', :'client', 'Mossy lawn plan', 'fixed', 'monthly', 200) as plan \gset
select tvx.visit(:'plan', :'m0'::date + 5) as plan1 \gset
select tvx.visit(:'plan', :'m0'::date + 12, 'scheduled') as plan2 \gset
select tvx.visit(:'plan', :'m1'::date + 3) as plan3 \gset
select tvx.extra(:'plan1', 'Plan aeration', 80, 1, false) as x_p1 \gset
select tvx.extra(:'plan2', 'Plan overseed', 60) as x_p2 \gset
select tvx.extra(:'plan3', 'Plan dethatch', 90) as x_p3 \gset
select public.create_invoice_for_job(:'plan', 'standard', null, :'m0') as plan_inv0 \gset
select tvx.check(tvx.lines(:'plan_inv0') = 'Mossy lawn plan 200.00, Plan aeration 80.00', 'a fixed-price month bills the price and, added to it, the extra on its finished visit');
select tvx.check(tvx.figures(:'plan_inv0') = '280.00/20.00/300.00', 'an extra that isn''t taxable isn''t taxed');
select tvx.check((select description like 'Extra work, visit on %' from public.invoice_line_items where invoice_id = :'plan_inv0' and name = 'Plan aeration'), 'with its visit''s date');
select tvx.check(tvx.billed_on(:'x_p2') = 'none' and tvx.billed_on(:'x_p3') = 'none', 'not the one on a visit that isn''t done, nor one after the month''s days');
select tvx.check((select contract_total = 200 from public.job_financials where job_id = :'plan'), 'the monthly price is still the price');
-- Added late to a visit of a month already invoiced, and a visit finished late: the next invoice has them.
select tvx.extra(:'plan1', 'Added late', 10) as x_late \gset
update public.visits set status = 'completed' where id = :'plan2';
select public.create_invoice_for_job(:'plan', 'standard', null, :'m1') as plan_inv1 \gset
select tvx.check((select array_agg(name order by name) = '{"Added late","Mossy lawn plan","Plan dethatch","Plan overseed"}' from public.invoice_line_items where invoice_id = :'plan_inv1'),
  'the next month''s invoice has its own, one added late to an earlier visit, and one whose visit was finished late');
select tvx.check((select subtotal = 360 from public.invoices where id = :'plan_inv1'), 'each once');
select tvx.void(:'plan_inv0');
select tvx.check(tvx.billed_on(:'x_p1') = 'none', 'voiding the month''s invoice frees its extra');
select public.create_invoice_for_job(:'plan', 'standard', null, :'m0') as plan_inv0b \gset
select tvx.check(tvx.lines(:'plan_inv0b') = 'Mossy lawn plan 200.00, Plan aeration 80.00', 'and the month''s invoice made again bills it again, alone');
commit;

-- ===== As needed ==================================================================================
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.job(:'co', :'client', 'Mossy beds', 'fixed', 'as_needed', 150) as beds \gset
select tvx.visit(:'beds', :'d1') as beds1 \gset
select tvx.visit(:'beds', :'d5', 'scheduled') as beds2 \gset
select tvx.extra(:'beds1', 'Beds mulch', 70) as x_b1 \gset
select tvx.extra(:'beds2', 'Beds later', 35) as x_b2 \gset
select public.create_invoice_for_job(:'beds', 'standard') as beds_inv \gset
select tvx.check(tvx.lines(:'beds_inv') = 'Mossy beds 150.00, Beds mulch 70.00' and tvx.billed_on(:'x_b2') = 'none', 'as needed, a fixed price: the next invoice has the extras of the visits done by then');
select tvx.job(:'co', :'client', 'Mossy trims', 'per_visit', 'as_needed', 35) as trims \gset
select tvx.visit(:'trims', :'d1') as trims1 \gset
select tvx.visit(:'trims', :'d2') as trims2 \gset
select tvx.extra(:'trims2', 'Trims haul', 22) as x_t2 \gset
select public.create_invoice_for_job(:'trims', 'visits') as trims_inv \gset
select tvx.check(tvx.lines(:'trims_inv') = 'Mossy trims 35.00, Mossy trims 35.00, Trims haul 22.00', 'as needed, per visit: the next invoice bills each visit, and each extra after its own visit''s lines');
commit;

-- ===== A once-per-job discount ====================================================================
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.job(:'co', :'client', 'Mossy promo mow', 'per_visit', 'after_visit', 40) as promo \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price, sort, discount_billing, discount_key) values (:'co', :'promo', 'Promo code SPRING50', 1, -50, 1, 'once', gen_random_uuid());
select tvx.visit(:'promo', :'d1') as promo1 \gset
select tvx.extra(:'promo1', 'Promo mulch', 30) as x_pr \gset
select public.create_invoice_for_job(:'promo', 'visits') as promo_inv1 \gset
select tvx.check((select subtotal = 20 from public.invoices where id = :'promo_inv1') and (select sum(round(quantity * unit_price, 2)) = -50 from public.invoice_line_items where invoice_id = :'promo_inv1' and discount_quote_id is not null),
  'a once-per-job discount comes off the first invoice, extra and all, as far as its lines go: $50 off $70');
select tvx.visit(:'promo', :'d2') as promo2 \gset
select tvx.extra(:'promo2', 'Promo trim', 15) as x_pr2 \gset
select public.create_invoice_for_job(:'promo', 'visits') as promo_inv2 \gset
select tvx.check((select subtotal = 55 from public.invoices where id = :'promo_inv2') and not exists (select 1 from public.invoice_line_items where invoice_id = :'promo_inv2' and discount_quote_id is not null),
  'and isn''t taken again from the next one, whatever extras it has');
commit;

-- ===== The crew on the visit =======================================================================
\set field_id 'e9000000-0000-0000-0000-0000000000f1'
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.visit(:'mow', :'d4', 'in_progress') as today \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'today', :'tad'), (:'co', :'patio_visit', :'tad'), (:'co', :'mow_off', :'tad');
select tvx.extra(:'today', 'Office add', 12) as x_office \gset
commit;
begin;
set local role authenticated;
select tvx.as_user(:'tad');
select tvx.check(public.add_field_line(:'today', :'mulch', 1.5, :'field_id') = :'field_id', 'Tad adds 1.5 yd of mulch to his visit of a repeating job');
select tvx.check(public.add_field_line(:'today', :'mulch', 1.5, :'field_id') = :'field_id', 'sent again after no signal, it answers the same one');
select tvx.check(not exists (select from public.visit_extras) and not exists (select from public.job_line_items), 'he can''t read extras or job lines (they have prices)');
select tvx.check((select string_agg(name || ' ' || quantity || ' ' || unit || ' ' || added_in_field, ', ' order by name) from public.visit_extra_scope(:'today')) = 'Mossy mulch 1.500 yd true, Office add 1.000 ea false',
  'but his list of the visit''s extra work has it, with the office''s, and no prices');
select tvx.refused(format('insert into public.visit_extras (company_id, visit_id, name, unit_price) values (%L, %L, %L, 1)', :'co', :'today', 'My own price'), '%row-level security%', 'he can''t add one at his own price');
select tvx.refused(format('select public.add_field_line(%L, %L, 1)', :'mow_off', :'mulch'), '%closed%notes%', 'not on a cancelled visit');
select tvx.refused(format('select public.add_field_line(%L, %L, 1)', :'mow1', :'mulch'), '%already invoiced%notes%', 'nor on a visit that''s been invoiced');
select tvx.refused(format('select public.add_field_line(%L, %L, 0)', :'today', :'mulch'), '%how many%', 'nor none of it');
select public.add_field_line(:'patio_visit', :'mulch', 2);
select tvx.as_user(:'uma');
select tvx.refused(format('select public.add_field_line(%L, %L, 1)', :'today', :'mulch'), '%wasn''t found%', 'Uma isn''t on the visit, so she can''t');
select tvx.check((select count(*) = 0 from public.visit_extra_scope(:'today')), 'nor read its extra work');
select tvx.as_user(:'ivo');
select tvx.refused(format('select public.add_field_line(%L, %L, 1)', :'today', :'mulch'), '%wasn''t found%', 'nor can another business');
select tvx.check((select count(*) = 0 from public.visit_extra_scope(:'today')) and not exists (select from public.visit_extras where company_id = :'co'), 'which reads none of it');
commit;
select tvx.check((select row(job_id, visit_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, added_in_field_by)::text from public.visit_extras where id = :'field_id')
  = row(:'mow'::uuid, :'today'::uuid, :'mulch'::uuid, 'Mossy mulch', 'Brown hardwood', 1.500, 'yd', 60.00, 25.00, true, :'tad'::uuid)::text,
  'the crew''s extra is the price list''s item at its price and cost, on that visit alone, added by Tad');
select tvx.check((select added_in_field_at > now() - interval '1 minute' from public.visit_extras where id = :'field_id') and (select count(*) = 1 from public.visit_extras where visit_id = :'today' and added_in_field_at is not null),
  'marked as from the field, once though it was sent twice');
select tvx.check((select count(*) = 1 from public.job_line_items where job_id = :'mow') and (select contract_total = 45 from public.job_financials where job_id = :'mow'), 'the repeating job''s lines and price are untouched');
select tvx.check((select count(*) = 1 and bool_and(added_in_field_at is not null) from public.job_line_items where job_id = :'patio' and name = 'Mossy mulch') and not exists (select 1 from public.visit_extras where job_id = :'patio'),
  'on a one-off job the crew''s work is still a line on the job, as before');
begin;
set local role authenticated;
select tvx.as_user(:'owen');
update public.visit_extras set added_in_field_at = now(), added_in_field_by = :'owen' where id = :'x_office';
select tvx.check((select added_in_field_at is null and added_in_field_by is null from public.visit_extras where id = :'x_office'), 'the office''s own can''t be made to look as if it came from the field');
insert into public.visit_extras (company_id, visit_id, name, unit_price, added_in_field_at, added_in_field_by) values (:'co', :'today', 'Dressed up', 5, now(), :'tad') returning id as x_dressed \gset
select tvx.check((select added_in_field_at is null and added_in_field_by is null from public.visit_extras where id = :'x_dressed'), 'nor added that way');
select tvx.as_user(:'edie');
select tvx.check((select count(*) = 3 from public.visit_extras where visit_id = :'today'), 'an estimator reads a visit''s extras, as she reads job lines');
update public.visits set status = 'completed' where id = :'today';
select tvx.refused(format('select public.create_invoice_for_job(%L, %L)', :'mow', 'visits'), '%', 'but can''t make the invoice');
commit;

-- ===== Autopay asks first ==========================================================================
create function tvx.autopay_client(p_company uuid, p_name text) returns uuid language plpgsql as $$
declare
  v_client uuid;
  v_key text := 'pm_tvx_' || replace(lower(p_name), ' ', '_');
  v_pm uuid;
begin
  insert into public.clients (company_id, display_name) values (p_company, p_name) returning id into v_client;
  v_pm := public.autopay_save_payment_method(p_company, v_client, jsonb_build_object(
    'stripe_payment_method_id', v_key, 'stripe_customer_id', 'cus' || v_key, 'stripe_account', 'acct_mossy', 'livemode', false,
    'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2030, 'status', 'active', 'source', 'hub', 'make_default', true));
  insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source, link_kind, link_via, accepted_at)
  values (p_company, v_client, v_pm, private.autopay_terms_shown(p_company), private.autopay_terms_version(p_company), 'hub', 'client', 'client', now() - interval '60 days');
  return v_client;
end $$;
-- The task's claim and bill for a job's newest charge: its answer.
create function tvx.bill(p_company uuid, p_job uuid) returns jsonb language plpgsql as $$
declare
  v_charge uuid := (select id from public.autopay_charges where job_id = p_job order by created_at desc, id desc limit 1);
  v_token uuid;
begin
  update public.autopay_charges set due_at = now() - interval '1 minute' where id = v_charge and status = 'waiting';
  select claim_token into v_token from public.claim_autopay_charges(100, p_company) where id = v_charge;
  update public.autopay_charges set status = 'waiting', claim_token = null, locked_until = null
  where company_id = p_company and status = 'charging' and id <> v_charge;
  return public.autopay_bill(v_charge, v_token) || jsonb_build_object('charge', v_charge);
end $$;
begin;
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'stripe', 'connected', '{"autopay": true}');
select set_config('crewtavo.autopay', 'on', true);
update public.companies set settings = jsonb_set(coalesce(settings, '{}'), '{autopay}', '{"enabled": true, "max_amount": 500}') where id = :'co';
commit;
select tvx.autopay_client(:'co', 'Mossy Autopay Al') as al \gset
select tvx.autopay_client(:'co', 'Mossy Autopay Bea') as bea \gset
select tvx.autopay_client(:'co', 'Mossy Autopay Cal') as cal \gset
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.job(:'co', :'al', 'Al mow', 'per_visit', 'after_visit', 45) as al_job \gset
select tvx.job(:'co', :'bea', 'Bea mow', 'per_visit', 'after_visit', 45) as bea_job \gset
update public.jobs set autopay = true where id in (:'al_job', :'bea_job');
select tvx.visit(:'al_job', :'d4', 'scheduled') as al_visit \gset
select tvx.visit(:'bea_job', :'d4', 'scheduled') as bea_visit \gset
select tvx.extra(:'bea_visit', 'Bea mulch', 60) as x_bea \gset
commit;
update public.visits set status = 'completed' where id in (:'al_visit', :'bea_visit');
select tvx.bill(:'co', :'al_job') as al_bill \gset
select tvx.check((:'al_bill'::jsonb ->> 'outcome') = 'charge' and (:'al_bill'::jsonb ->> 'balance_due')::numeric = 49.50, 'an autopay visit with no extra is charged as it always was');
select tvx.bill(:'co', :'bea_job') as bea_bill \gset
select tvx.check((:'bea_bill'::jsonb ->> 'outcome') = 'needs_approval' and (:'bea_bill'::jsonb ->> 'reason') = 'Includes extra work added to a visit',
  'one with extra work on it waits for the office''s OK, and says why');
select tvx.check((select status = 'draft' and total = 115.50 from public.invoices where id = (:'bea_bill'::jsonb ->> 'invoice_id')::uuid) and tvx.billed_on(:'x_bea') like '#% draft',
  'its invoice is a draft with the extra on it, not charged');
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select public.approve_autopay_charge((:'bea_bill'::jsonb ->> 'charge')::uuid);
commit;
select tvx.check((tvx.bill(:'co', :'bea_job') ->> 'outcome') = 'charge', 'approved, it''s charged');
-- A monthly plan's month with extra work on it waits too.
begin;
set local role authenticated;
select tvx.as_user(:'owen');
select tvx.job(:'co', :'cal', 'Cal plan', 'fixed', 'monthly', 120) as cal_job \gset
update public.jobs set autopay = true, invoice_day = 15 where id = :'cal_job';
commit;
select (date_trunc('month', current_date::timestamp) + interval '2 months')::date as cal_month \gset
select tvx.visit(:'cal_job', ((private.invoice_period(15, :'cal_month')).period_end - 3)) as cal_visit \gset
select tvx.extra(:'cal_visit', 'Cal aeration', 80) as x_cal \gset
select public.emit_invoice_reminders(((private.invoice_period(15, :'cal_month')).period_end + time '10:00') at time zone 'America/Chicago');
select tvx.bill(:'co', :'cal_job') as cal_bill \gset
select tvx.check((:'cal_bill'::jsonb ->> 'outcome') = 'needs_approval' and (:'cal_bill'::jsonb ->> 'reason') = 'Includes extra work added to a visit',
  'a monthly plan''s charge with extra work on its invoice waits for the office''s OK');
select tvx.check((select subtotal = 200 from public.invoices where id = (:'cal_bill'::jsonb ->> 'invoice_id')::uuid), 'the plan''s price and the extra are on the month''s invoice');

-- ===== AI assistants ================================================================================
-- Extra work and a job's lines are what clients pay: Prices, which full access without money leaves
-- out (20261123100600_assistant_prices_are_money.sql).
select tvx.check(private.assistant_table_area('visit_extras') = 'prices' and private.assistant_table_area('job_line_items') = 'prices' and private.assistant_table_area('visits') = 'schedule',
  'an assistant that may change prices may add a visit''s extra work, and the other tables are where they were');

\echo 'All visit extras tests passed.'
