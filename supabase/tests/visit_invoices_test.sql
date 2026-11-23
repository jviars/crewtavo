-- Database tests for 20261113000400_visit_invoices_for_per_visit_jobs.sql: "Completed visits" is
-- only for a job billed by the visit (a recurring job that isn't a fixed price, a one-off job
-- invoiced after each visit), a one-off job's final invoice takes on the visits finished by then
-- and frees them when it's voided or deleted, and the final invoices made before this took on theirs.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tvi;
grant usage on schema tvi to authenticated, service_role;
create function tvi.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- Expects p_sql to fail with SQLSTATE 22023 and a message like p_like.
create function tvi.refused(p_sql text, p_like text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> '22023' or sqlerrm not ilike p_like then
      raise exception 'FAIL (wrong error % "%"): %', sqlstate, sqlerrm, p_what;
    end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- A job with one $300 line and p_visits finished visits.
create function tvi.job(p_company uuid, p_client uuid, p_title text, p_kind text, p_billing text, p_visits integer default 3) returns uuid language plpgsql as $$
declare v_job uuid;
begin
  insert into public.jobs (company_id, client_id, title, kind, billing_mode, recurrence_rule, starts_on)
  values (p_company, p_client, p_title, p_kind, p_billing, case when p_kind = 'recurring' then 'FREQ=WEEKLY;INTERVAL=1' end, current_date)
  returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, unit_price) values (p_company, v_job, 'Work', 300);
  insert into public.visits (company_id, job_id, title, status, scheduled_on)
  select p_company, v_job, 'Visit ' || n, 'completed', current_date from generate_series(1, p_visits) n;
  return v_job;
end $$;
-- How many of a job's finished visits are on p_invoice, and how many on none.
create function tvi.visits(p_job uuid, p_invoice uuid) returns text language sql stable as $$
  select count(*) filter (where invoice_id = p_invoice) || ' on it, ' || count(*) filter (where invoice_id is null) || ' on none'
  from public.visits where job_id = p_job and status = 'completed'
$$;
grant execute on all functions in schema tvi to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d4000000-0000-0000-0000-000000000001', 'vera@visit-invoices.test', '{"full_name": "Vera Vine"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d4000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Vine Fencing', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Wes Ward') returning id as wes \gset
update public.companies set settings = public.company_settings(id) || '{"default_tax_rate": 0}' where id = :'co';

-- ===== A one-off job billed when it's done =====================================================
select tvi.job(:'co', :'wes', 'Fence', 'one_off', 'on_completion') as fence \gset
select tvi.refused(format('select public.create_invoice_for_job(%L, %L)', :'fence', 'visits'), '%billed as one job%final invoice%',
  'Completed visits is refused on a one-off job billed when it''s done');
select tvi.check(not exists (select 1 from public.invoices where job_id = :'fence'), 'and no draft for three times the job is left behind');
select public.create_invoice_for_job(:'fence', 'standard') as fence_final \gset
select tvi.check((select total = 300 from public.invoices where id = :'fence_final'), 'its final invoice bills the job once, whatever the visits');
select tvi.check(tvi.visits(:'fence', :'fence_final') = '3 on it, 0 on none', 'and its three finished visits are on that invoice');

-- A visit still to come isn't on it, and one finished later isn't billed by the visit either.
insert into public.visits (company_id, job_id, title, status, scheduled_on) values (:'co', :'fence', 'Touch up', 'scheduled', current_date) returning id as touch_up \gset
update public.visits set status = 'completed' where id = :'touch_up';
select tvi.refused(format('select public.create_invoice_for_job(%L, %L)', :'fence', 'visits'), '%billed as one job%',
  'a visit finished after the final invoice still isn''t billed by the visit');

-- Voided, the visits are free again, and the next final invoice takes them all on.
update public.invoices set status = 'sent' where id = :'fence_final';
update public.invoices set status = 'void' where id = :'fence_final';
select tvi.check(tvi.visits(:'fence', :'fence_final') = '0 on it, 4 on none', 'voiding the final invoice frees its visits');
select public.create_invoice_for_job(:'fence', 'standard') as fence_again \gset
select tvi.check(tvi.visits(:'fence', :'fence_again') = '4 on it, 0 on none', 'and the invoice made in its place takes them on');
delete from public.invoices where id = :'fence_again';
select tvi.check((select count(*) = 4 from public.visits where job_id = :'fence' and invoice_id is null), 'a deleted draft frees them too');

-- ===== Progress billing ========================================================================
select tvi.job(:'co', :'wes', 'Deck', 'one_off', 'progress', 2) as deck \gset
select tvi.refused(format('select public.create_invoice_for_job(%L, %L)', :'deck', 'visits'), '%billed as one job%', 'nor on a job billed by progress');
select public.create_invoice_for_job(:'deck', 'progress', 100) as deck_progress \gset
select tvi.check(tvi.visits(:'deck', :'deck_progress') = '0 on it, 2 on none', 'a progress invoice takes on no visits: the final one will');

-- ===== A one-off job invoiced after each visit ==================================================
select tvi.job(:'co', :'wes', 'Three cleanups', 'one_off', 'per_visit') as cleanups \gset
select public.create_invoice_for_job(:'cleanups', 'visits') as cleanups_visits \gset
select tvi.check((select total = 900 from public.invoices where id = :'cleanups_visits') and tvi.visits(:'cleanups', :'cleanups_visits') = '3 on it, 0 on none',
  'a one-off job invoiced after each visit bills each finished visit');
select tvi.refused(format('select public.create_invoice_for_job(%L, %L)', :'cleanups', 'visits'), '%no completed visits%', 'and none of them twice');

-- ===== Recurring jobs ==========================================================================
select tvi.job(:'co', :'wes', 'Weekly mow', 'recurring', 'per_visit', 2) as mow \gset
select public.create_invoice_for_job(:'mow', 'visits') as mow_visits \gset
select tvi.check((select total = 600 from public.invoices where id = :'mow_visits'), 'a recurring job billed per visit is invoiced by the visit as before');
select tvi.job(:'co', :'wes', 'Monthly plan', 'recurring', 'fixed_schedule', 2) as plan \gset
select tvi.refused(format('select public.create_invoice_for_job(%L, %L)', :'plan', 'visits'), '%fixed price%',
  'a recurring job at a fixed price isn''t invoiced visit by visit');
select public.create_invoice_for_job(:'plan', 'standard') as plan_price \gset
select tvi.check((select total = 300 from public.invoices where id = :'plan_price') and tvi.visits(:'plan', :'plan_price') = '0 on it, 2 on none',
  'its price is invoiced once, and a recurring job''s visits are left as they were');
commit;

-- ===== Final invoices made before this ==========================================================
-- As the migration finds them: a final invoice with no visits on it, one visit finished before it
-- was made and one after; and a void one, which freed its visits.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d4000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tvi.job(:'co', :'wes', 'Old gate', 'one_off', 'on_completion', 1) as gate \gset
select public.create_invoice_for_job(:'gate', 'standard') as gate_final \gset
select tvi.job(:'co', :'wes', 'Old shed', 'one_off', 'on_completion', 1) as shed \gset
select public.create_invoice_for_job(:'shed', 'standard') as shed_final \gset
update public.invoices set status = 'sent' where id = :'shed_final';
update public.invoices set status = 'void' where id = :'shed_final';
reset role;
select set_config('request.jwt.claims', '', true);
alter table public.visits disable trigger user;
update public.visits set invoice_id = null, completed_at = now() - interval '2 days' where job_id in (:'gate', :'shed');
insert into public.visits (company_id, job_id, title, status, scheduled_on, completed_at) values (:'co', :'gate', 'Later', 'completed', current_date, now() + interval '1 day');
-- The migration's own statement.
update public.visits v set invoice_id = i.id
from public.jobs j
join lateral (
  select x.id, x.company_id, x.created_at from public.invoices x
  where x.job_id = j.id and x.kind = 'standard' and x.status <> 'void'
  order by x.number limit 1
) i on true
where j.kind <> 'recurring' and v.job_id = j.id and v.company_id = i.company_id
  and v.kind = 'job' and v.status = 'completed' and v.invoice_id is null
  and coalesce(v.completed_at, v.updated_at) <= i.created_at;
alter table public.visits enable trigger user;
select tvi.check(tvi.visits(:'gate', :'gate_final') = '1 on it, 1 on none', 'a final invoice made before takes on the visit finished before it, not the one after');
select tvi.check(tvi.visits(:'shed', :'shed_final') = '0 on it, 1 on none', 'a void one takes on none');
rollback;

\echo 'All visit invoice tests passed.'
