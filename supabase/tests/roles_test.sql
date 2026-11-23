-- Database tests for custom roles: access levels, switched-off areas, and who can manage roles.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t3;
grant usage on schema t3 to authenticated, service_role;

create function t3.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

create function t3.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t3 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d0000000-0000-0000-0000-000000000001', 'owner@delta.test', '{"full_name": "Dee Owner"}'),
  ('d0000000-0000-0000-0000-000000000002', 'gm@delta.test', '{"full_name": "Gil Manager"}'),
  ('d0000000-0000-0000-0000-000000000003', 'ops@delta.test', '{"full_name": "Oli Ops"}'),
  ('d0000000-0000-0000-0000-000000000004', 'foreman@delta.test', '{"full_name": "Fran Foreman"}'),
  ('d0000000-0000-0000-0000-000000000005', 'worker@delta.test', '{"full_name": "Wes Worker"}');

-- ===== Owner sets up roles and the team =========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Delta Paving', 'paving') as co \gset
select t3.check((select count(*) from public.company_roles where company_id = :'co') = 5, 'new companies get five starter roles');
select id as gm_role from public.company_roles where company_id = :'co' and name = 'General manager' \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
select id as foreman_role from public.company_roles where company_id = :'co' and name = 'Foreman' \gset
select id as worker_role from public.company_roles where company_id = :'co' and name = 'Employee' \gset

select t3.expect_error(format('insert into public.company_roles (company_id, name, base_role, permissions) values (%L, %L, %L, %L)', :'co', 'Super crew', 'field_crew', '{invoices}'), 'a role can''t have areas its access level doesn''t allow');
select t3.expect_error(format('insert into public.company_roles (company_id, name, base_role) values (%L, %L, %L)', :'co', 'Co-owner', 'owner'), 'custom roles can''t be owners');
select t3.expect_error(format('insert into public.company_roles (company_id, name, base_role) values (%L, %L, %L)', :'co', ' general MANAGER ', 'office'), 'role names are unique');

-- role says "field_crew" but the custom role decides the level.
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'd0000000-0000-0000-0000-000000000002', 'field_crew', :'gm_role'),
  (:'co', 'd0000000-0000-0000-0000-000000000003', 'field_crew', :'ops_role'),
  (:'co', 'd0000000-0000-0000-0000-000000000004', 'field_crew', :'foreman_role'),
  (:'co', 'd0000000-0000-0000-0000-000000000005', 'admin', :'worker_role');
set local role authenticated;
select t3.check((select role from public.memberships where user_id = 'd0000000-0000-0000-0000-000000000002') = 'admin', 'a custom role sets the access level (general manager is admin)');
select t3.check((select role from public.memberships where user_id = 'd0000000-0000-0000-0000-000000000005') = 'field_crew', 'a custom role overrides the level it was saved with');

insert into public.clients (company_id, display_name) values (:'co', 'Town Square HOA') returning id as client \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Parking lot') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (:'co', :'quote', 'Overlay', 100, 20);
select public.convert_quote_to_job(:'quote') as job \gset
select t3.check((select contract_total from public.job_financials where job_id = :'job') = 2000, 'a job''s total is kept from its line items');
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price) values (:'co', :'job', 'Striping', 1, 250);
select t3.check((select contract_total from public.job_financials where job_id = :'job') = 2250, 'adding a line item updates the total');
select t3.expect_error(format('update public.job_financials set contract_total = 1 where job_id = %L', :'job'), 'nobody writes job totals directly');
insert into public.visits (company_id, job_id, title, starts_at, ends_at) values (:'co', :'job', 'Overlay day', now() + interval '1 day', now() + interval '1 day 8 hours') returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'd0000000-0000-0000-0000-000000000005');
update public.visits set price = 350, price_note = 'Storm push' where id = :'visit';
insert into public.clients (company_id, display_name) values (:'co', 'Elm Street Lofts') returning id as other_client \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type) values (:'co', 'client', :'other_client', :'co' || '/client/' || :'other_client' || '/lofts.jpg', 'lofts.jpg', 'image/jpeg') returning id as lofts_photo \gset
update public.memberships set labor_rate = 40 where company_id = :'co' and user_id = 'd0000000-0000-0000-0000-000000000001';
select t3.check(true, 'an owner sets their own pay rate');
-- Saved as a screen saves its own settings (the browser doesn't read companies.settings:
-- 20261123100100_prices_and_settings_for_the_office.sql).
select public.merge_company_settings(:'co', '{"roofing": {"range_pct": 10, "typical_squares": 30}, "revenue_goal": 100000}');
select public.merge_company_settings(:'co', '{"roofing": {"range_pct": 12}}');
select t3.check((select settings -> 'roofing' = '{"range_pct": 12, "typical_squares": 30}' and settings ->> 'revenue_goal' = '100000' from public.company_private_settings where company_id = :'co')
  and not public.company_settings(:'co') ?| array['roofing', 'revenue_goal'],
  'the business''s prices and targets are kept apart from its settings, and saving one keeps the rest');
select public.create_invoice_for_job(:'job') as invoice \gset
insert into public.expenses (company_id, job_id, user_id, amount, description) values (:'co', :'job', 'd0000000-0000-0000-0000-000000000001', 120, 'Owner fuel');
insert into public.time_entries (company_id, user_id, started_at, ended_at) values (:'co', 'd0000000-0000-0000-0000-000000000004', now() - interval '3 hours', now() - interval '1 hour') returning id as entry \gset
update public.jobs set status = 'requires_invoicing' where id = :'job';
select t3.check((select (public.dashboard(:'co') -> 'workflow' -> 'jobs' ->> 'to_invoice_value')::numeric) = 2250, 'the dashboard shows the owner what''s ready to invoice');
commit;

-- ===== Operations manager: office level, but no invoices, marketing, automations or settings ====
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t3.check((select count(*) from public.clients where company_id = :'co') = 2, 'ops manager sees clients');
select t3.check((select count(*) from public.company_private_settings where company_id = :'co') = 1, 'the office reads the business''s prices and targets');
select t3.check((select count(*) from public.invoices where company_id = :'co') = 0, 'ops manager can''t see invoices without the invoices area');
select t3.check((select count(*) from public.payments where company_id = :'co') = 0, 'ops manager can''t see payments');
select t3.check((select count(*) from public.automation_rules where company_id = :'co') = 0, 'ops manager can''t see automations');
select t3.check((select count(*) from public.expenses where company_id = :'co') = 1, 'ops manager sees job costs (area on)');
select t3.check((select count(*) from public.job_financials where company_id = :'co') = 1, 'ops manager sees job totals');
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Sealcoat') returning id as quote2 \gset
select t3.check(:'quote2' is not null, 'ops manager can write quotes (sales area on)');
select t3.expect_error(format('insert into public.services (company_id, name, unit_price) values (%L, %L, 10)', :'co', 'Crack fill'), 'ops manager can''t change the price list without settings');
update public.time_entries set approved_at = now() where id = :'entry';
select t3.check((select approved_at is not null from public.time_entries where id = :'entry'), 'ops manager can approve time (timesheets area on)');
commit;

-- Switch off timesheets and sales for the ops role, as the owner.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.company_roles set permissions = array['job_costs','reports','schedule','kb_edit'] where id = :'ops_role';
update public.time_entries set approved_at = null where id = :'entry';
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t3.expect_error(format('update public.time_entries set approved_at = now() where id = %L', :'entry'), 'without the timesheets area, time can''t be approved');
select t3.expect_error(format('insert into public.quotes (company_id, client_id, title) values (%L, %L, %L)', :'co', :'client', 'Blocked'), 'without the sales area, quotes can''t be written');
select t3.check((select count(*) from public.quotes where company_id = :'co') = 2, 'quotes can still be read without the sales area');
select t3.expect_error(format('insert into public.job_line_items (company_id, job_id, name, quantity, unit_price) values (%L, %L, %L, 1, 1)', :'co', :'job', 'Cheap'), 'without the sales area, lines can''t be added to a job');
select t3.expect_error(format('update public.job_line_items set unit_price = 1 where job_id = %L', :'job'), 'without the sales area, a job''s prices can''t be changed');
select t3.expect_error(format('delete from public.job_line_items where job_id = %L', :'job'), 'without the sales area, a job''s lines can''t be removed');
update public.job_line_items set sort = sort where job_id = :'job';
select t3.check(true, 'without the sales area, a job''s other line details can still be saved');
select t3.expect_error(format('insert into public.company_roles (company_id, name, base_role) values (%L, %L, %L)', :'co', 'Sneaky', 'admin'), 'only admins with the team area can create roles');
commit;

-- ===== Foreman: crew lead level, sees the whole schedule but no money ==========================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t3.check((select count(*) from public.jobs where company_id = :'co') = 1, 'foreman sees jobs');
select t3.check((select count(*) from public.job_financials where company_id = :'co') = 0, 'foreman can''t see job totals');
select t3.check((select count(*) from public.job_line_items where company_id = :'co') = 0, 'foreman can''t see line item prices');
select t3.check((select count(*) from public.visits where company_id = :'co') = 1, 'foreman sees the visit');
select t3.check((select count(*) from public.company_private_settings) = 0, 'foreman can''t read the business''s prices and targets');
select t3.expect_error('select price from public.visits', 'foreman can''t read what a visit bills');
select t3.check((select count(*) from public.invoices where company_id = :'co') = 0, 'foreman can''t see invoices');
select t3.check((select (public.dashboard(:'co') -> 'workflow' -> 'jobs' ->> 'to_invoice_value')::numeric) = 0, 'the dashboard shows the foreman no job value');
commit;

-- ===== General manager: admin level with team, without apps =====================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t3.check((select count(*) from public.invoices where company_id = :'co') = 1, 'general manager sees invoices');
select t3.check(private.has_perm(:'co', 'team') and not private.has_perm(:'co', 'apps'), 'general manager manages the team but not apps');
select t3.expect_error(format('update public.memberships set labor_rate = 99 where company_id = %L and user_id = %L', :'co', 'd0000000-0000-0000-0000-000000000002'), 'an admin can''t set their own member rate');
select t3.expect_error(format('insert into public.pay_rates (company_id, user_id, basis, rate) values (%L, %L, %L, 99)', :'co', 'd0000000-0000-0000-0000-000000000002', 'per_job'), 'an admin can''t give themselves a pay rate');
reset role; -- handles_pay is the database's own check, as the general manager (their claims stay set)
select t3.check(not private.handles_pay(:'co', null, 'd0000000-0000-0000-0000-000000000002') and private.handles_pay(:'co', null, 'd0000000-0000-0000-0000-000000000005'), 'an admin handles others'' job pay, not their own');
set local role authenticated;
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Estimator', 'estimator', '{sales}') returning id as est_role \gset
update public.memberships set role_id = :'est_role' where company_id = :'co' and user_id = 'd0000000-0000-0000-0000-000000000004';
select t3.check((select role from public.memberships where user_id = 'd0000000-0000-0000-0000-000000000004') = 'estimator', 'changing someone''s role changes their level');
update public.company_roles set base_role = 'office', permissions = '{sales,schedule}' where id = :'est_role';
select t3.check((select role from public.memberships where user_id = 'd0000000-0000-0000-0000-000000000004') = 'office', 'changing a role''s level moves everyone who has it');
delete from public.company_roles where id = :'est_role';
select t3.check((select role || '/' || coalesce(role_id::text, 'none') from public.memberships where user_id = 'd0000000-0000-0000-0000-000000000004') = 'office/none', 'deleting a role keeps its members'' level');
commit;

-- ===== Employee: field level, nothing switched on ============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t3.check((select count(*) from public.company_roles where company_id = :'co') = 5, 'everyone can see role names');
select t3.check((select count(*) from public.jobs where company_id = :'co') = 1, 'employees see the job they''re scheduled on');
select t3.check((select title from public.visits where id = :'visit') = 'Overlay day', 'employees see their visit');
select t3.check((select count(*) from public.company_private_settings) = 0, 'employees can''t read the business''s prices and targets');
select t3.expect_error(format('insert into public.company_private_settings (company_id) values (%L)', :'co'), 'nobody writes them except by saving the company''s settings');
select t3.expect_error('select price_note from public.visits', 'employees can''t read what a visit bills');
select t3.expect_error(format('select public.set_photo_shareable(%L, true)', :'lofts_photo'), 'employees can''t mark a photo they can''t see as postable');
select t3.check((select count(*) from public.job_financials where company_id = :'co') = 0, 'employees can''t see job totals');
select t3.check((select count(*) from public.expenses where company_id = :'co') = 0, 'employees don''t see other people''s expenses');
insert into public.expenses (company_id, job_id, user_id, amount, description) values (:'co', :'job', 'd0000000-0000-0000-0000-000000000005', 15, 'Gloves');
select t3.check((select count(*) from public.expenses where company_id = :'co') = 1, 'employees see the expenses they logged');
with changed as (update public.memberships set role = 'admin', role_id = null where user_id = 'd0000000-0000-0000-0000-000000000005' returning 1)
select t3.check((select count(*) from changed) = 0, 'employees can''t promote themselves');
select t3.check((select role from public.memberships where user_id = 'd0000000-0000-0000-0000-000000000005') = 'field_crew', 'their level is unchanged');
commit;

\echo 'All role tests passed.'
