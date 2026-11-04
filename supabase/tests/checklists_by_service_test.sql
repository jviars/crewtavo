-- Database tests for checklists that go with price list items (20261103000300_checklists_by_service):
-- the office sets a checklist's items all at once, the crew reads them but can't change them,
-- another business can't link or see them, deleting an item takes its links, and the crew on a
-- visit learns which checklists its job's line items bring up without reading the lines.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_cbs;
grant usage on schema t_cbs to authenticated, service_role;
create function t_cbs.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_cbs.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t_cbs to authenticated, service_role;

-- Opal owns Quince Lawn, Cal is on her crew's mowing visit, Fay is crew who isn't; Nell owns Nettle Snow.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c4ec0000-0000-0000-0000-000000000001', 'opal@quince-lawn.test', '{"full_name": "Opal Quince"}'),
  ('c4ec0000-0000-0000-0000-000000000002', 'cal@quince-lawn.test', '{"full_name": "Cal Quince"}'),
  ('c4ec0000-0000-0000-0000-000000000003', 'fay@quince-lawn.test', '{"full_name": "Fay Quince"}'),
  ('c4ec0000-0000-0000-0000-000000000004', 'nell@nettle-snow.test', '{"full_name": "Nell Nettle"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4ec0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select public.create_company('Nettle Snow', 'general') as other \gset
insert into public.services (company_id, name, unit, unit_price) values (:'other', 'Nettle plowing', 'visit', 80) returning id as their_plow \gset
insert into public.checklist_templates (company_id, name, items) values (:'other', 'Nettle plow stop', '[]') returning id as their_list \gset
select public.set_checklist_services(:'their_list', array[:'their_plow']::uuid[]);
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4ec0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Quince Lawn', 'lawn_exterior') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c4ec0000-0000-0000-0000-000000000002', 'field_crew'),
  (:'co', 'c4ec0000-0000-0000-0000-000000000003', 'field_crew');
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Quince weekly mow', 'visit', 45) returning id as mow \gset
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Quince edging', 'visit', 15) returning id as edge \gset
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Quince leaf cleanup', 'visit', 120) returning id as leaves \gset
insert into public.checklist_templates (company_id, name, items) values (:'co', 'Quince mow standard', '[]') returning id as mow_list \gset
insert into public.checklist_templates (company_id, name, items) values (:'co', 'Quince trim check', '[]') returning id as trim_list \gset
insert into public.checklist_templates (company_id, name, items, active) values (:'co', 'Quince old mow sheet', '[]', false) returning id as old_list \gset
insert into public.checklist_templates (company_id, name, items) values (:'co', 'Quince any job', '[]') returning id as any_list \gset

select t_cbs.check(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'checklist_templates' and column_name = 'job_type'),
  'the job type nothing read is gone');

select public.set_checklist_services(:'mow_list', array[:'mow', :'edge', :'mow']::uuid[]);
select t_cbs.check((select array_agg(service_id order by service_id) from public.checklist_template_services where template_id = :'mow_list')
  = (select array_agg(id order by id) from public.services where id in (:'mow', :'edge')), 'the owner sets a checklist''s items, each once');
select public.set_checklist_services(:'mow_list', array[:'mow', :'leaves']::uuid[]);
select t_cbs.check((select array_agg(service_id order by service_id) from public.checklist_template_services where template_id = :'mow_list')
  = (select array_agg(id order by id) from public.services where id in (:'mow', :'leaves')), 'setting them again replaces them');
select public.set_checklist_services(:'trim_list', array[:'edge']::uuid[]);
select public.set_checklist_services(:'old_list', array[:'mow']::uuid[]);
select public.set_checklist_services(:'any_list', '{}');
select t_cbs.check(not exists (select 1 from public.checklist_template_services where template_id = :'any_list'), 'a checklist can go with none (offered on any job)');
select t_cbs.check((select company_id = :'co' from public.checklist_template_services where template_id = :'trim_list'), 'a link is the checklist''s business''s');

select t_cbs.expect_error(format('select public.set_checklist_services(%L, array[%L]::uuid[])', :'mow_list', :'their_plow'), 'another business''s item can''t go on a checklist');
select t_cbs.expect_error(format('insert into public.checklist_template_services (company_id, template_id, service_id) values (%L, %L, %L)', :'co', :'mow_list', :'their_plow'),
  'nor be linked directly');

-- Cal mows the Quince job: its lines are the weekly mow and edging (and a discount).
insert into public.clients (company_id, display_name) values (:'co', 'Quince Client Ada') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Quince front lawn') returning id as job \gset
insert into public.job_line_items (company_id, job_id, service_id, name, quantity, unit, unit_price) values
  (:'co', :'job', :'mow', 'Quince weekly mow', 1, 'visit', 45),
  (:'co', :'job', :'edge', 'Quince edging', 1, 'visit', 15),
  (:'co', :'job', null, 'Discount', 1, 'ea', -5);
insert into public.visits (company_id, job_id, title, starts_at, ends_at) values (:'co', :'job', 'Quince mow', now() + interval '1 day', now() + interval '1 day 1 hour') returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'c4ec0000-0000-0000-0000-000000000002');
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Quince no-items job') returning id as bare_job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'bare_job', 'Something custom', 1, 'ea', 30);

select t_cbs.check((select array_agg(c order by c) from public.job_checklists(:'job') c) = (select array_agg(id order by id) from public.checklist_templates where id in (:'mow_list', :'trim_list')),
  'a job brings up the turned-on checklists its items go with, each once (not the turned-off one)');
select t_cbs.check(not exists (select from public.job_checklists(:'bare_job')), 'a job whose lines go with no checklist brings up none');
commit;

-- ===== The crew ================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4ec0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t_cbs.check(not exists (select from public.job_line_items where job_id = :'job'), 'Cal can''t read the job''s lines (they have prices)');
select t_cbs.check((select array_agg(c order by c) from public.job_checklists(:'job') c) = (select array_agg(id order by id) from public.checklist_templates where id in (:'mow_list', :'trim_list')),
  'but on his visit he gets the checklists they bring up');
select t_cbs.check((select count(*) from public.checklist_template_services) = 4, 'the crew reads which items checklists go with');
select t_cbs.expect_error(format('select public.set_checklist_services(%L, array[%L]::uuid[])', :'any_list', :'mow'), 'but can''t link one');
select public.set_checklist_services(:'mow_list', '{}');
delete from public.checklist_template_services where template_id = :'trim_list';
commit;
select t_cbs.check((select count(*) from public.checklist_template_services where company_id = :'co') = 4, 'or take one off');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4ec0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t_cbs.check(not exists (select from public.job_checklists(:'job')), 'crew who aren''t on the job''s visits get nothing for it');
commit;

-- ===== Another business ========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4ec0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_cbs.check((select count(*) from public.checklist_template_services) = 1, 'Nell sees only her own business''s links');
select t_cbs.check(not exists (select from public.job_checklists(:'job')), 'and nothing of another business''s job');
select t_cbs.expect_error(format('select public.set_checklist_services(%L, array[%L]::uuid[])', :'mow_list', :'their_plow'), 'she can''t link to another business''s checklist');
select t_cbs.expect_error(format('select public.set_checklist_services(%L, array[%L]::uuid[])', :'their_list', :'mow'), 'or another business''s item to hers');
select t_cbs.expect_error(format('insert into public.checklist_template_services (company_id, template_id, service_id) values (%L, %L, %L)', :'co', :'mow_list', :'mow'),
  'or add a link to another business directly');
delete from public.checklist_template_services where company_id = :'co';
commit;
select t_cbs.check((select count(*) from public.checklist_template_services where company_id = :'co') = 4, 'or take another business''s off');

-- ===== Deleting =================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4ec0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.services where id = :'leaves';
select t_cbs.check((select array_agg(service_id) from public.checklist_template_services where template_id = :'mow_list') = array[:'mow']::uuid[], 'deleting an item takes it off its checklists');
delete from public.checklist_templates where id = :'trim_list';
select t_cbs.check(not exists (select from public.checklist_template_services where template_id = :'trim_list'), 'deleting a checklist takes its links');
select t_cbs.expect_error(format('select public.set_checklist_services(%L, array[%L]::uuid[])', :'trim_list', :'mow'), 'and a deleted checklist isn''t found');
commit;

-- ===== AI assistants ============================================================================
-- One given checklists sets a checklist's items with the function; one given only prices can't.
-- (The hook runs directly, as in assistant_access_test.sql.)
\set cbs_lists 'c4ec0000-0000-0000-0000-0000000000a1'
\set cbs_prices 'c4ec0000-0000-0000-0000-0000000000a2'
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4ec0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.assistant_connections (client_id, level, areas) values (:'cbs_lists', 'areas', '{checklists}'), (:'cbs_prices', 'areas', '{prices}');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub": "c4ec0000-0000-0000-0000-000000000001", "role": "authenticated", "client_id": "%s"}', :'cbs_lists'), true),
  set_config('request.method', 'POST', true), set_config('request.path', '/rpc/set_checklist_services', true);
select hooks.before_request();
select t_cbs.check(current_setting('transaction_read_only') = 'off', 'an assistant given checklists sets which items a checklist goes with');
select public.set_checklist_services(:'mow_list', array[:'mow', :'edge']::uuid[]);
select t_cbs.check((select count(*) = 2 from public.checklist_template_services where template_id = :'mow_list'), 'and it''s set');
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claims', format('{"sub": "c4ec0000-0000-0000-0000-000000000001", "role": "authenticated", "client_id": "%s"}', :'cbs_prices'), true),
  set_config('request.method', 'POST', true), set_config('request.path', '/rpc/set_checklist_services', true);
select hooks.before_request();
select t_cbs.check(current_setting('transaction_read_only') = 'on', 'one not given checklists can''t');
rollback;

\echo 'All checklists-by-service tests passed.'
