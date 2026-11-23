-- Database tests for 20261113000950_price_changes.sql: changing prices across repeating jobs. Which
-- jobs and lines a change reaches (all active repeating jobs, or by a service on the job, a client
-- tag, a crew or the jobs ticked; all lines or one service's; never a $0 line, money off, a one-off
-- job or a visit's extra work), the rounding, the preview's figures, applying exactly what was
-- previewed or nothing, each job's activity, undo and what stops it, autopay, and who may.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tpc;
grant usage on schema tpc to authenticated, service_role;
create function tpc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tpc.refused(p_sql text, p_like text, p_what text) returns void language plpgsql as $$
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
create function tpc.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- A repeating job with its lines: p_lines is [[name, price, service or null, quantity]...].
create function tpc.job(p_company uuid, p_client uuid, p_title text, p_pricing text, p_lines jsonb, p_crew uuid default null) returns uuid language plpgsql as $$
declare v_job uuid;
begin
  insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, pricing, invoice_schedule, default_crew_id)
  values (p_company, p_client, p_title, 'recurring', 'FREQ=WEEKLY;BYDAY=MO', p_pricing, case when p_pricing = 'fixed' then 'monthly' else 'after_visit' end, p_crew)
  returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, unit_price, service_id, quantity, sort)
  select p_company, v_job, l ->> 0, (l ->> 1)::numeric, nullif(l ->> 2, '')::uuid, coalesce((l ->> 3)::numeric, 1), n
  from jsonb_array_elements(p_lines) with ordinality x (l, n);
  return v_job;
end $$;
-- The lines of a preview as the screen sends them back to apply (all of them, or one job's).
create function tpc.lines(p_preview jsonb, p_job uuid default null) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('line_id', l ->> 'line_id', 'old_price', l -> 'old_price', 'new_price', l -> 'new_price')), '[]')
  from jsonb_array_elements(p_preview -> 'jobs') j cross join jsonb_array_elements(j -> 'lines') l
  where p_job is null or (j ->> 'job_id')::uuid = p_job
$$;
-- A job's line prices, in order.
create function tpc.prices(p_job uuid) returns text language sql stable as $$
  select string_agg(unit_price::text, ', ' order by sort, name) from public.job_line_items where job_id = p_job
$$;
-- One job of a preview, as "old > new: name old > new, ...".
create function tpc.job_of(p_preview jsonb, p_job uuid) returns text language sql as $$
  select (j ->> 'old_price') || ' > ' || (j ->> 'new_price') || ': ' || (select string_agg((l ->> 'name') || ' ' || (l ->> 'old_price') || ' > ' || (l ->> 'new_price'), ', ') from jsonb_array_elements(j -> 'lines') l)
  from jsonb_array_elements(p_preview -> 'jobs') j where (j ->> 'job_id')::uuid = p_job
$$;
grant execute on all functions in schema tpc to authenticated, service_role;

select tpc.check(private.price_after(45, '{"kind": "percent", "value": 5, "round": "cent"}') = 47.25
  and private.price_after(45, '{"kind": "percent", "value": 5, "round": "half"}') = 47.50
  and private.price_after(45, '{"kind": "percent", "value": 5, "round": "dollar"}') = 47
  and private.price_after(33.33, '{"kind": "percent", "value": 3.5, "round": "cent"}') = 34.50
  and private.price_after(45.20, '{"kind": "percent", "value": 5, "round": "half"}') = 47.50
  and private.price_after(45.70, '{"kind": "percent", "value": 5, "round": "half"}') = 48.00
  and private.price_after(45.50, '{"kind": "percent", "value": 1, "round": "dollar"}') = 46,
  'a percentage up, rounded to the cent, to 50 cents and to the dollar');
select tpc.check(private.price_after(45, '{"kind": "amount", "value": 2, "round": "cent"}') = 47
  and private.price_after(45, '{"kind": "amount", "value": -2.25, "round": "cent"}') = 42.75
  and private.price_after(45, '{"kind": "amount", "value": -2.25, "round": "half"}') = 43.00
  and private.price_after(45, '{"kind": "percent", "value": -10, "round": "dollar"}') = 41
  and private.price_after(1.50, '{"kind": "amount", "value": -5, "round": "cent"}') = 0,
  'an amount up or down, a percentage down, and never below $0');

-- Pia owns Pine Lawn; Olin is office; Bree office without Quotes and sales; Eli estimates; Cruz is
-- crew. Ravi owns Reed Yards, another business.
\set pia 'ec000000-0000-0000-0000-000000000001'
\set olin 'ec000000-0000-0000-0000-000000000002'
\set bree 'ec000000-0000-0000-0000-000000000003'
\set eli 'ec000000-0000-0000-0000-000000000004'
\set cruz 'ec000000-0000-0000-0000-000000000005'
\set ravi 'ec000000-0000-0000-0000-000000000006'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'pia', 'pia@pine-lawn.test', '{"full_name": "Pia Pine"}'),
  (:'olin', 'olin@pine-lawn.test', '{"full_name": "Olin Pine"}'),
  (:'bree', 'bree@pine-lawn.test', '{"full_name": "Bree Pine"}'),
  (:'eli', 'eli@pine-lawn.test', '{"full_name": "Eli Pine"}'),
  (:'cruz', 'cruz@pine-lawn.test', '{"full_name": "Cruz Pine"}'),
  (:'ravi', 'ravi@reed-yards.test', '{"full_name": "Ravi Reed"}');

begin;
set local role authenticated;
select tpc.as_user(:'ravi');
select public.create_company('Reed Yards', 'general') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Reed Client') returning id as their_client \gset
select tpc.job(:'other', :'their_client', 'Reed mow', 'per_visit', '[["Reed mow", 50]]') as their_job \gset
commit;

begin;
set local role authenticated;
select tpc.as_user(:'pia');
select public.create_company('Pine Lawn', 'lawn_exterior', 'America/Chicago') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Pine scheduler', 'office', '{schedule,invoices}') returning id as no_sales \gset
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'olin', 'office', null), (:'co', :'bree', 'office', :'no_sales'), (:'co', :'eli', 'estimator', null), (:'co', :'cruz', 'field_crew', null);
set local role authenticated;
update public.companies set settings = public.company_settings(id) || '{"default_tax_rate": 0.1}' where id = :'co';
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Pine mowing', 'visit', 45) returning id as mowing \gset
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Pine edging', 'visit', 10) returning id as edging \gset
insert into public.crews (company_id, name) values (:'co', 'Pine crew A') returning id as crew_a \gset
insert into public.clients (company_id, display_name, tags) values (:'co', 'Pine Client Ada', '{Commercial}') returning id as ada \gset
insert into public.clients (company_id, display_name, tags) values (:'co', 'Pine Client Bo', '{residential,North}') returning id as bo \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pine Client Cy') returning id as cy \gset

-- Ada: mowing 45 and edging 10 a visit, crew A. Bo: mowing 45.20 (typed in, no link), a $0 line, a
-- typed $5 discount and a promo code's line. Cy: a fixed $200 a month plan with 2 x $12.50 of
-- fertilizer. Also a one-off job, an archived repeating job and a paused one.
select tpc.job(:'co', :'ada', 'Ada mow', 'per_visit', jsonb_build_array(jsonb_build_array('Pine mowing', 45, :'mowing'), jsonb_build_array('Pine edging', 10, :'edging')), :'crew_a') as j_ada \gset
select tpc.job(:'co', :'bo', 'Bo mow', 'per_visit', '[["pine mowing ", 45.20], ["Gate check", 0], ["Neighbor discount", -5]]') as j_bo \gset
insert into public.job_line_items (company_id, job_id, name, unit_price, sort, discount_billing, discount_key) values (:'co', :'j_bo', 'Promo code SPRING', -20, 9, 'once', gen_random_uuid());
select tpc.job(:'co', :'cy', 'Cy plan', 'fixed', '[["Lawn plan", 200], ["Fertilizer", 12.50, null, 2]]') as j_cy \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'cy', 'Cy patio') returning id as j_oneoff \gset
insert into public.job_line_items (company_id, job_id, name, unit_price) values (:'co', :'j_oneoff', 'Patio', 900);
select tpc.job(:'co', :'cy', 'Cy old mow', 'per_visit', '[["Old mowing", 40]]') as j_old \gset
update public.jobs set status = 'archived' where id = :'j_old';
select tpc.job(:'co', :'cy', 'Cy paused mow', 'per_visit', '[["Paused mowing", 40]]') as j_paused \gset
update public.jobs set paused_at = now() where id = :'j_paused';
-- Extra work on one of Ada's visits: never changed.
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j_ada', 'Ada mow', current_date + 3) returning id as v_ada \gset
insert into public.visit_extras (company_id, visit_id, name, unit_price) values (:'co', :'v_ada', 'Ada mulch', 60) returning id as x_ada \gset
commit;

-- ===== The preview =================================================================================
\set up5 '{"kind": "percent", "value": 5, "round": "half"}'
begin;
set local role authenticated;
select tpc.as_user(:'olin');
select public.price_change_preview(:'co', :'up5') as p \gset
select tpc.check((:'p'::jsonb -> 'totals' ->> 'jobs')::integer = 4 and (:'p'::jsonb -> 'totals' ->> 'lines')::integer = 6,
  'up 5% reaches the four active repeating jobs (a paused one too) and their six priced lines');
select tpc.check(not exists (select 1 from jsonb_array_elements(:'p'::jsonb -> 'jobs') j where (j ->> 'job_id')::uuid in (:'j_oneoff', :'j_old', :'their_job')),
  'not a one-off job, an archived one, or another business''s');
select tpc.check(tpc.job_of(:'p', :'j_ada') = '55.00 > 58.00: Pine mowing 45.00 > 47.50, Pine edging 10.00 > 10.50', 'each line''s old and new price, and the job''s price for a visit');
select tpc.check(tpc.job_of(:'p', :'j_bo') = '40.20 > 42.50: pine mowing  45.20 > 47.50',
  'a $0 line, a typed discount and a promo code''s line are left alone, and the job''s price leaves out the once-per-job discount');
select tpc.check(tpc.job_of(:'p', :'j_cy') = '225.00 > 236.00: Lawn plan 200.00 > 210.00, Fertilizer 12.50 > 13.00', 'a fixed price''s month, with a line of two at the new price each');
select tpc.check((:'p'::jsonb -> 'totals' ->> 'old_price')::numeric = 360.20 and (:'p'::jsonb -> 'totals' ->> 'new_price')::numeric = 378.50, 'and a total, before and after');
select tpc.check((:'p'::jsonb ->> 'summary') = 'Up 5%, rounded to 50 cents' and (:'p'::jsonb -> 'autopay') = 'null'::jsonb, 'it says what the change is, and nothing about autopay while that''s off');
select tpc.check((select array_agg(j ->> 'client' order by n) from jsonb_array_elements(:'p'::jsonb -> 'jobs') with ordinality x (j, n))
  = '{"Pine Client Ada","Pine Client Bo","Pine Client Cy","Pine Client Cy"}', 'listed by client');

-- Which jobs.
select tpc.check((select array_agg((j ->> 'job_id')::uuid) from jsonb_array_elements(public.price_change_preview(:'co', :'up5'::jsonb || jsonb_build_object('jobs', jsonb_build_object('service_id', :'mowing'))) -> 'jobs') j)
  = array[:'j_ada', :'j_bo']::uuid[], 'narrowed to jobs with a service on them: by the line''s link, or its name when it was typed in');
select tpc.check((select array_agg((j ->> 'job_id')::uuid) from jsonb_array_elements(public.price_change_preview(:'co', :'up5'::jsonb || '{"jobs": {"client_tag": "commercial"}}') -> 'jobs') j)
  = array[:'j_ada']::uuid[], 'to a client tag, whatever its capitals');
select tpc.check((select array_agg((j ->> 'job_id')::uuid) from jsonb_array_elements(public.price_change_preview(:'co', :'up5'::jsonb || jsonb_build_object('jobs', jsonb_build_object('crew_id', :'crew_a'))) -> 'jobs') j)
  = array[:'j_ada']::uuid[], 'to a crew');
select tpc.check((select array_agg((j ->> 'job_id')::uuid) from jsonb_array_elements(public.price_change_preview(:'co', :'up5'::jsonb || jsonb_build_object('jobs', jsonb_build_object('job_ids', jsonb_build_array(:'j_cy', :'j_oneoff', :'their_job')))) -> 'jobs') j)
  = array[:'j_cy']::uuid[], 'to the jobs ticked (a one-off or another business''s among them is passed over)');
-- Which lines.
select public.price_change_preview(:'co', :'up5'::jsonb || jsonb_build_object('line_service_id', :'mowing')) as p_mow \gset
select tpc.check(tpc.job_of(:'p_mow', :'j_ada') = '55.00 > 57.50: Pine mowing 45.00 > 47.50' and (:'p_mow'::jsonb -> 'totals' ->> 'jobs')::integer = 2
  and (:'p_mow'::jsonb ->> 'summary') = 'Up 5%, rounded to 50 cents, on Pine mowing lines', 'only a chosen service''s lines: the job''s other lines stay, and jobs without it aren''t listed');
select tpc.check((public.price_change_preview(:'co', '{"kind": "amount", "value": -2, "round": "cent"}') ->> 'summary') = 'Down $2.00 a line'
  and (public.price_change_preview(:'co', '{"kind": "percent", "value": 0.001, "round": "cent"}') -> 'totals' ->> 'jobs')::integer = 0,
  'a change that leaves every price where it was lists nothing');
-- What isn't a change.
select tpc.refused(format('select public.price_change_preview(%L, %L)', :'co', '{"kind": "percent", "value": 0, "round": "cent"}'), '%how much%', 'no change at all is refused');
select tpc.refused(format('select public.price_change_preview(%L, %L)', :'co', '{"kind": "percent", "value": -100, "round": "cent"}'), '%percentage%', 'so is everything to $0');
select tpc.refused(format('select public.price_change_preview(%L, %L)', :'co', '{"kind": "double", "value": 2, "round": "cent"}'), '%percentage or an amount%', 'and a change it doesn''t know');
select tpc.refused(format('select public.price_change_preview(%L, %L)', :'co', '{"kind": "percent", "value": 5}'), '%round%', 'and one that doesn''t say how to round');
select tpc.check(tpc.prices(:'j_ada') = '45.00, 10.00' and not exists (select 1 from public.price_changes where company_id = :'co'), 'a preview changes nothing');

-- ===== Who may ======================================================================================
select tpc.as_user(:'bree');
select tpc.refused(format('select public.price_change_preview(%L, %L)', :'co', :'up5'), '%Quotes and sales%', 'the office without Quotes and sales can''t');
select tpc.refused(format('select public.apply_price_change(%L, gen_random_uuid(), %L, %L)', :'co', :'up5', tpc.lines(:'p')), '%Quotes and sales%', 'preview or apply');
select tpc.as_user(:'eli');
select tpc.refused(format('select public.price_change_preview(%L, %L)', :'co', :'up5'), '%Quotes and sales%', 'nor an estimator');
select tpc.as_user(:'cruz');
select tpc.refused(format('select public.price_change_preview(%L, %L)', :'co', :'up5'), '%Quotes and sales%', 'nor the crew');
select tpc.as_user(:'ravi');
select tpc.refused(format('select public.price_change_preview(%L, %L)', :'co', :'up5'), '%Quotes and sales%', 'nor another business''s owner');
select tpc.refused(format('select public.apply_price_change(%L, gen_random_uuid(), %L, %L)', :'co', :'up5', tpc.lines(:'p')), '%Quotes and sales%', 'who can''t apply one either');
select tpc.refused(format('select public.apply_price_change(%L, gen_random_uuid(), %L, %L)', :'other', :'up5', tpc.lines(:'p')), '%changed since the preview%', 'or use his own business to change Pine Lawn''s lines');
commit;
select tpc.check(tpc.prices(:'j_ada') = '45.00, 10.00', 'nothing was changed by those turned away');

-- ===== Applying exactly what was previewed ==========================================================
\set change1 'ec000000-0000-0000-0000-0000000000c1'
begin;
set local role authenticated;
select tpc.as_user(:'olin');
select public.price_change_preview(:'co', :'up5') as p \gset
-- Something changed since: nothing is written, for any job in the group.
update public.job_line_items set unit_price = 46 where job_id = :'j_ada' and name = 'Pine mowing';
select tpc.refused(format('select public.apply_price_change(%L, %L, %L, %L)', :'co', :'change1', :'up5', tpc.lines(:'p')), '%changed since the preview (job #%', 'a line edited since the preview stops the whole group, naming a job');
select tpc.check(tpc.prices(:'j_bo') = '45.20, 0.00, -5.00, -20.00' and tpc.prices(:'j_cy') = '200.00, 12.50' and not exists (select 1 from public.price_changes where id = :'change1'),
  'and no job in it is changed, nor a change recorded');
update public.job_line_items set unit_price = 45 where job_id = :'j_ada' and name = 'Pine mowing';
-- A job can't be half changed: every line of it the change reaches, or it's refused.
select tpc.refused(format('select public.apply_price_change(%L, %L, %L, %L)', :'co', :'change1', :'up5', (tpc.lines(:'p', :'j_ada') -> 0) || '[]'::jsonb), '%changed since the preview%', 'one line of a job''s two is refused: a job is never half changed');
select tpc.refused(format('select public.apply_price_change(%L, %L, %L, %L)', :'co', :'change1', :'up5',
  jsonb_set(tpc.lines(:'p', :'j_ada'), '{0,new_price}', '99')), '%changed since the preview%', 'and so is a price the change wouldn''t give');
select tpc.refused(format('select public.apply_price_change(%L, %L, %L, %L)', :'co', :'change1', :'up5', '[]'), '%Preview the change first%', 'and applying nothing');

-- In two groups, as the screen sends them, under one change.
select public.apply_price_change(:'co', :'change1', :'up5', tpc.lines(:'p', :'j_ada') || tpc.lines(:'p', :'j_bo')) as r1 \gset
select tpc.check(:'r1'::jsonb = '{"jobs": 2, "lines": 3}', 'the first group: two jobs, three lines');
select tpc.check(tpc.prices(:'j_ada') = '47.50, 10.50' and tpc.prices(:'j_bo') = '47.50, 0.00, -5.00, -20.00', 'their lines have the new prices; $0 and money off are as they were');
select tpc.check(tpc.prices(:'j_cy') = '200.00, 12.50', 'a job in the next group isn''t changed yet');
select tpc.check((public.apply_price_change(:'co', :'change1', :'up5', tpc.lines(:'p', :'j_ada') || tpc.lines(:'p', :'j_bo')) ->> 'again')::boolean and tpc.prices(:'j_ada') = '47.50, 10.50',
  'the same group sent again (its answer was lost) is applied once');
select public.apply_price_change(:'co', :'change1', :'up5', tpc.lines(:'p', :'j_cy') || tpc.lines(:'p', :'j_paused')) as r2 \gset
select tpc.check(tpc.prices(:'j_cy') = '210.00, 13.00' and tpc.prices(:'j_paused') = '42.00', 'the second group');
select tpc.check((select row(jobs, lines, summary, created_by)::text from public.price_changes where id = :'change1') = row(4, 6, 'Up 5%, rounded to 50 cents', :'olin'::uuid)::text,
  'one change on record for both groups: four jobs, six lines, what it was and who made it');
select tpc.check((select count(*) = 6 and bool_and(restored_at is null) from public.price_change_lines where change_id = :'change1')
  and (select row(old_price, new_price)::text = '(45.00,47.50)' from public.price_change_lines l join public.job_line_items li on li.id = l.line_id where l.change_id = :'change1' and li.job_id = :'j_ada' and li.name = 'Pine mowing'),
  'with each line''s old and new price');
select tpc.check((select contract_total = 58 from public.job_financials where job_id = :'j_ada') and (select contract_total = 236 from public.job_financials where job_id = :'j_cy'),
  'each job''s price follows its lines');
select tpc.check((select unit_price = 60 from public.visit_extras where id = :'x_ada'), 'extra work on one visit isn''t touched');
select tpc.check((select unit_price = 900 from public.job_line_items where job_id = :'j_oneoff') and (select unit_price = 40 from public.job_line_items where job_id = :'j_old')
  and (select unit_price = 45 from public.services where id = :'mowing'), 'nor a one-off job, an archived one, or the price list');
select tpc.check((select summary = 'Prices changed on job #' || (select number from public.jobs where id = :'j_ada') || ' for Pine Client Ada: $55.00 to $58.00 a visit (Pine edging $10.00 to $10.50, Pine mowing $45.00 to $47.50)'
    and data ->> 'change_id' = :'change1' and (data ->> 'old_price')::numeric = 55 and (data ->> 'new_price')::numeric = 58 and jsonb_array_length(data -> 'lines') = 2
  from public.activity where verb = 'job.prices_changed' and subject_id = :'j_ada'),
  'each job''s activity says its old and new price, and each line''s');
select tpc.check((select summary like '%$225.00 to $236.00 a month%' from public.activity where verb = 'job.prices_changed' and subject_id = :'j_cy'), 'a fixed price''s by the month');
select tpc.refused(format('select public.apply_price_change(%L, %L, %L, %L)', :'co', :'change1', '{"kind": "percent", "value": 9, "round": "cent"}', tpc.lines(public.price_change_preview(:'co', '{"kind": "percent", "value": 9, "round": "cent"}'))),
  '%already made or undone%', 'another change can''t be made under the same id');

-- Invoices made from now on bill the new prices; one already made keeps its own.
select tpc.as_user(:'pia');
insert into public.visits (company_id, job_id, title, status, scheduled_on) values (:'co', :'j_bo', 'Bo mow', 'completed', current_date - 1);
commit;

-- ===== Undo =========================================================================================
begin;
set local role authenticated;
select tpc.as_user(:'olin');
select tpc.check((select jsonb_array_length(h) = 1 and (h -> 0 ->> 'summary') = 'Up 5%, rounded to 50 cents' and (h -> 0 ->> 'by') = 'Olin Pine' and (h -> 0 -> 'invoice') = 'null'::jsonb and (h -> 0 ->> 'jobs')::integer = 4
  from public.price_change_history(:'co') h), 'the history lists the change, who made it, and that nothing stops Undo');
-- An invoice made at the new prices stops it.
select tpc.as_user(:'pia');
select public.create_invoice_for_job(:'j_bo', 'visits') as bo_inv \gset
select tpc.check((select subtotal = 22.50 from public.invoices where id = :'bo_inv'), 'an invoice made after the change bills the new price ($47.50, less the $5 and the promo code''s $20)');
select tpc.as_user(:'olin');
select tpc.refused(format('select public.undo_price_change(%L, %L)', :'co', :'change1'), '%Invoice #% was made at the new prices%', 'once an invoice is made for one of its jobs, the change can''t be undone');
select tpc.check((select (h -> 0 ->> 'invoice')::bigint = (select number from public.invoices where id = :'bo_inv') from public.price_change_history(:'co') h), 'and the history says which invoice');
-- Voided, it no longer counts.
select tpc.as_user(:'pia');
update public.invoices set status = 'sent' where id = :'bo_inv';
update public.invoices set status = 'void' where id = :'bo_inv';
select tpc.as_user(:'olin');
-- A line edited by hand since, and one removed, are left alone.
update public.job_line_items set unit_price = 11 where job_id = :'j_ada' and name = 'Pine edging';
delete from public.job_line_items where job_id = :'j_cy' and name = 'Fertilizer';
select tpc.as_user(:'bree');
select tpc.refused(format('select public.undo_price_change(%L, %L)', :'co', :'change1'), '%Quotes and sales%', 'not by the office without Quotes and sales');
select tpc.as_user(:'olin');
select public.undo_price_change(:'co', :'change1') as u \gset
select tpc.check(:'u'::jsonb = '{"left": 2, "restored": 4}', 'with the invoice voided the whole change is undone: four lines back, two left as someone changed them since');
select tpc.check(tpc.prices(:'j_ada') = '45.00, 11.00' and tpc.prices(:'j_bo') = '45.20, 0.00, -5.00, -20.00' and tpc.prices(:'j_cy') = '200.00' and tpc.prices(:'j_paused') = '40.00',
  'every line is back at its old price, but the one edited by hand since');
select tpc.check((select undone_at is not null and undone_by = :'olin'::uuid from public.price_changes where id = :'change1')
  and (select count(*) = 4 from public.price_change_lines where change_id = :'change1' and restored_at is not null), 'the change says it was undone, by whom, and which lines went back');
select tpc.check((select count(*) = 4 from public.activity where verb = 'job.prices_changed' and data ->> 'undone' = 'true' and data ->> 'change_id' = :'change1')
  and (select summary like 'Price change undone on job #% for Pine Client Bo: back to $40.20 a visit' from public.activity where verb = 'job.prices_changed' and data ->> 'undone' = 'true' and subject_id = :'j_bo'),
  'and each job''s activity says so');
select tpc.refused(format('select public.undo_price_change(%L, %L)', :'co', :'change1'), '%already undone%', 'it''s undone once');
select tpc.refused(format('select public.undo_price_change(%L, %L)', :'co', gen_random_uuid()), '%wasn''t found%', 'and a change that isn''t there can''t be');
commit;

-- ===== Autopay ======================================================================================
begin;
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'stripe', 'connected', '{"autopay": true}');
select set_config('crewtavo.autopay', 'on', true);
update public.companies set settings = jsonb_set(coalesce(settings, '{}'), '{autopay}', '{"enabled": true, "max_amount": 50}') where id = :'co';
commit;
-- Bo is on autopay at $40.20 a visit ($44.22 with tax): under the $50 limit now.
select public.autopay_save_payment_method(:'co', :'bo', jsonb_build_object(
  'stripe_payment_method_id', 'pm_tpc_bo', 'stripe_customer_id', 'cus_tpc_bo', 'stripe_account', 'acct_pine', 'livemode', false,
  'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2030, 'status', 'active', 'source', 'hub', 'make_default', true)) as bo_pm \gset
insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source, link_kind, link_via, accepted_at)
values (:'co', :'bo', :'bo_pm', private.autopay_terms_shown(:'co'), private.autopay_terms_version(:'co'), 'hub', 'client', 'client', now() - interval '30 days');
select id as bo_agreement from public.autopay_authorizations where client_id = :'bo' and revoked_at is null \gset
update public.jobs set autopay = true where id = :'j_bo';
delete from public.job_line_items where job_id = :'j_bo' and discount_key is not null;
\set up20 '{"kind": "percent", "value": 20, "round": "cent"}'
\set change2 'ec000000-0000-0000-0000-0000000000c2'
begin;
set local role authenticated;
select tpc.as_user(:'pia');
select public.price_change_preview(:'co', :'up20') as p \gset
select tpc.check((:'p'::jsonb -> 'autopay') = '{"jobs": 1, "limit": 50, "over_limit": 1}'::jsonb, 'with autopay on, the preview counts the jobs on it and those the new price puts over the limit');
select tpc.check((select (j ->> 'autopay')::boolean and (j ->> 'over_limit')::boolean and not (j ->> 'was_over_limit')::boolean and (j ->> 'new_price')::numeric = 49.24
  from jsonb_array_elements(:'p'::jsonb -> 'jobs') j where (j ->> 'job_id')::uuid = :'j_bo'),
  'Bo''s visit goes to $49.24, $54.16 with tax: over the $50 limit, where it wasn''t');
select tpc.check((select not (j ->> 'autopay')::boolean and not (j ->> 'over_limit')::boolean from jsonb_array_elements(:'p'::jsonb -> 'jobs') j where (j ->> 'job_id')::uuid = :'j_ada'), 'a job that isn''t on autopay isn''t flagged');
select tpc.as_user(:'eli');
select tpc.as_user(:'pia');
select public.apply_price_change(:'co', :'change2', :'up20', tpc.lines(:'p'));
commit;
select tpc.check((select count(*) = 1 and bool_and(revoked_at is null) from public.autopay_authorizations where client_id = :'bo') and (select id = :'bo_agreement'::uuid from public.autopay_authorizations where client_id = :'bo'),
  'a price change leaves the client''s agreement as it is: nobody is asked to agree again');
select tpc.check((select autopay from public.jobs where id = :'j_bo'), 'and the job stays on autopay');
-- The next visit's charge: over the limit, so it waits for the office's OK, as any charge over it does.
delete from public.visits where job_id = :'j_bo';
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j_bo', 'Bo mow', current_date) returning id as bo_visit \gset
update public.visits set status = 'completed' where id = :'bo_visit';
update public.autopay_charges set due_at = now() - interval '1 minute' where job_id = :'j_bo' and status = 'waiting';
select id as bo_charge, claim_token as bo_token from public.claim_autopay_charges(100, :'co') where job_id = :'j_bo' \gset
select public.autopay_bill(:'bo_charge', :'bo_token') as bo_bill \gset
select tpc.check((:'bo_bill'::jsonb ->> 'outcome') = 'needs_approval' and (:'bo_bill'::jsonb -> 'reason') = 'null'::jsonb
  and (select total = 54.16 from public.invoices where id = (:'bo_bill'::jsonb ->> 'invoice_id')::uuid),
  'the next visit is billed at the new price, and its charge waits for the office''s OK because it''s over the limit');
-- Someone without the invoices area isn't told about autopay.
begin;
set local role authenticated;
select tpc.as_user(:'pia');
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Pine sales desk', 'office', '{sales}') returning id as sales_only \gset
reset role;
update public.memberships set role_id = :'sales_only' where company_id = :'co' and user_id = :'bree';
set local role authenticated;
select tpc.as_user(:'bree');
select public.price_change_preview(:'co', :'up5') as p_bree \gset
select tpc.check((:'p_bree'::jsonb -> 'autopay') = 'null'::jsonb and not exists (select 1 from jsonb_array_elements(:'p_bree'::jsonb -> 'jobs') j where (j ->> 'autopay')::boolean or (j ->> 'over_limit')::boolean),
  'the office with Quotes and sales but not invoices can change prices, and is told nothing about autopay');
rollback;

-- ===== AI assistants ================================================================================
-- A price change is what clients pay: Prices, which full access without money leaves out
-- (20261123100600_assistant_prices_are_money.sql).
select tpc.check(private.assistant_rpc_area('apply_price_change') = 'prices' and private.assistant_rpc_area('undo_price_change') = 'prices'
  and private.assistant_rpc_area('price_change_preview') is null and private.assistant_rpc_area('edit_invoice') = 'invoices' and private.assistant_rpc_area('remove_late_fee') = 'invoices',
  'an assistant that may change prices may make and undo a price change; the preview only answers; the rest are where they were');

\echo 'All price change tests passed.'
