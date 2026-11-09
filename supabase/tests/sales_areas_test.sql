-- Database tests for sales areas: a new request goes to whoever covers its zip (the longest match,
-- else everywhere else's), a quote takes its request's person, a roof flagged to measure on site
-- goes to the area's salesperson, and whoever gets a lead is told, once. Run with
-- scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1140;
grant usage on schema t1140 to authenticated, service_role;
create function t1140.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1140.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- Notifications as the database keeps them: each person reads only their own.
create function t1140.told(p_user uuid, p_link text, p_title text default '%', p_body text default '%') returns bigint
language sql security definer as $$
  select count(*) from public.notifications
  where (p_user is null or user_id = p_user) and (p_link is null or link = p_link) and title like p_title and coalesce(body, '') like p_body
$$;
grant execute on all functions in schema t1140 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('fa000000-0000-0000-0000-000000000001', 'owner@kilo.test', '{"full_name": "Kim Owner"}'),
  ('fa000000-0000-0000-0000-000000000002', 'mike@kilo.test', '{"full_name": "Mike North"}'),
  ('fa000000-0000-0000-0000-000000000003', 'sue@kilo.test', '{"full_name": "Sue South"}'),
  ('fa000000-0000-0000-0000-000000000004', 'ed@kilo.test', '{"full_name": "Ed Else"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fa000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Kilo Roofing', 'roofing') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'fa000000-0000-0000-0000-000000000002', 'estimator'),
  (:'co', 'fa000000-0000-0000-0000-000000000003', 'estimator'),
  (:'co', 'fa000000-0000-0000-0000-000000000004', 'office');
insert into public.clients (company_id, display_name) values (:'co', 'Sam Lee') returning id as client \gset
insert into public.properties (company_id, client_id, line1, city, postal_code) values (:'co', :'client', '12 Oak St', 'Carmel', '46032-1234') returning id as north \gset
insert into public.properties (company_id, client_id, line1, city, postal_code) values (:'co', :'client', '9 Elm St', 'Indianapolis', '46201') returning id as south \gset
insert into public.properties (company_id, client_id, line1, city, postal_code) values (:'co', :'client', '1 Far Rd', 'Muncie', '47302') returning id as far \gset
commit;

-- ===== Nothing set up: nothing changes ========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fa000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'client', :'north', 'Leak') returning id as r0 \gset
select t1140.check((select assigned_to is null from public.requests where id = :'r0'), 'with no sales areas a request stays unassigned');
commit;

-- ===== The office sets up the areas ===========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fa000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.sales_areas (company_id, zip, user_id) values
  (:'co', '460', 'fa000000-0000-0000-0000-000000000002'),
  (:'co', '462', 'fa000000-0000-0000-0000-000000000002'),
  (:'co', '46201', 'fa000000-0000-0000-0000-000000000003'),
  (:'co', '', 'fa000000-0000-0000-0000-000000000004');
select t1140.expect_error(format('insert into public.sales_areas (company_id, zip, user_id) values (%L, %L, %L)', :'co', '460', 'fa000000-0000-0000-0000-000000000003'), 'a zip is one person''s');
select t1140.expect_error(format('insert into public.sales_areas (company_id, zip, user_id) values (%L, %L, %L)', :'co', '46%', 'fa000000-0000-0000-0000-000000000003'), 'a zip is only letters and digits');
select t1140.check(private.postal_key('46032-1234') = '46032' and private.postal_key(' k1a 0b6') = 'K1A0B6' and private.postal_key(null) = '', 'postal codes are kept the one way');

insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'client', :'north', 'North roof') returning id as r1 \gset
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'client', :'south', 'South roof') returning id as r2 \gset
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'client', :'far', 'Far roof') returning id as r3 \gset
insert into public.requests (company_id, client_id, title) values (:'co', :'client', 'No address') returning id as r4 \gset
insert into public.requests (company_id, client_id, property_id, title, assigned_to) values (:'co', :'client', :'north', 'Picked', 'fa000000-0000-0000-0000-000000000003') returning id as r5 \gset
select t1140.check((select assigned_to from public.requests where id = :'r1') = 'fa000000-0000-0000-0000-000000000002', 'a request goes to whoever covers its zip (460 covers 46032-1234)');
select t1140.check((select assigned_to from public.requests where id = :'r2') = 'fa000000-0000-0000-0000-000000000003', 'the longest match wins (46201 over 462)');
select t1140.check((select assigned_to from public.requests where id = :'r3') = 'fa000000-0000-0000-0000-000000000004', 'a zip nobody covers goes to everywhere else''s');
select t1140.check((select assigned_to from public.requests where id = :'r4') = 'fa000000-0000-0000-0000-000000000004', 'so does a request with no address');
select t1140.check((select assigned_to from public.requests where id = :'r5') = 'fa000000-0000-0000-0000-000000000003', 'a request that comes in with someone keeps them');

select t1140.check(t1140.told('fa000000-0000-0000-0000-000000000002', '/requests/' || :'r1', 'Request #% is yours: North roof', 'Sam Lee · 12 Oak St, Carmel') = 1, 'the salesperson is told, with who and where');

-- Changing the property re-matches only while nobody has it.
update public.requests set assigned_to = null where id = :'r0';
update public.requests set property_id = :'south' where id = :'r0';
select t1140.check((select assigned_to from public.requests where id = :'r0') = 'fa000000-0000-0000-0000-000000000003', 'a request given an address later goes to that area');
update public.requests set property_id = :'far' where id = :'r1';
select t1140.check((select assigned_to from public.requests where id = :'r1') = 'fa000000-0000-0000-0000-000000000002', 'but a request someone has stays theirs');
update public.requests set title = 'North roof leak' where id = :'r1';
select t1140.check(t1140.told(null, '/requests/' || :'r1') = 1, 'editing a request doesn''t tell anyone again');
update public.requests set assigned_to = 'fa000000-0000-0000-0000-000000000001' where id = :'r1';
select t1140.check(t1140.told('fa000000-0000-0000-0000-000000000001', null) = 0, 'taking a request yourself tells nobody');

-- A quote takes its request's person, or the area's.
insert into public.quotes (company_id, client_id, property_id, request_id, title) values (:'co', :'client', :'south', :'r2', 'South roof') returning id as q1 \gset
select t1140.check((select salesperson_id from public.quotes where id = :'q1') = 'fa000000-0000-0000-0000-000000000003', 'a quote made from a request goes to the same person');
select t1140.check(t1140.told(null, '/quotes/' || :'q1') = 0, 'who already heard about the request');
insert into public.quotes (company_id, client_id, property_id, title, work_kind) values (:'co', :'client', :'north', 'Roof at 12 Oak St', 'roofing') returning id as q2 \gset
select t1140.check((select salesperson_id from public.quotes where id = :'q2') = 'fa000000-0000-0000-0000-000000000002', 'a quote without a request goes to the area''s salesperson');
select t1140.check(t1140.told('fa000000-0000-0000-0000-000000000002', '/roofing/' || :'q2', 'Estimate #% is yours: Roof at 12 Oak St') = 1, 'who is told, at the roofing project');
insert into public.quotes (company_id, title, is_template) values (:'co', 'Template', true) returning id as tmpl \gset
select t1140.check((select salesperson_id is null from public.quotes where id = :'tmpl'), 'a template goes to nobody');
insert into public.quotes (company_id, client_id, property_id, title, source_id) values (:'co', :'client', :'north', 'Imported', 'jobber-1') returning id as imported \gset
select t1140.check((select salesperson_id is null from public.quotes where id = :'imported'), 'nor does a quote brought in from another app');
commit;

-- ===== A roof that can't be measured from the air ==============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fa000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, property_id, title, work_kind, salesperson_id) values (:'co', :'client', :'south', 'Roof at 9 Elm St', 'roofing', 'fa000000-0000-0000-0000-000000000001') returning id as q3 \gset
update public.quotes set salesperson_id = null where id = :'q3';
update public.quotes set measure_on_site_at = now(), measure_on_site_reason = 'Trees cover the roof' where id = :'q3';
select t1140.check((select salesperson_id from public.quotes where id = :'q3') = 'fa000000-0000-0000-0000-000000000003', 'flagged to measure on site with nobody on it, it goes to the area''s salesperson');
select t1140.check(t1140.told('fa000000-0000-0000-0000-000000000003', '/roofing/' || :'q3', 'Measure the roof on site: Roof at 9 Elm St', '%Trees cover the roof') = 1, 'who is told to go measure it, and why');
update public.quotes set salesperson_id = 'fa000000-0000-0000-0000-000000000002' where id = :'q3';
select t1140.check(t1140.told('fa000000-0000-0000-0000-000000000002', '/roofing/' || :'q3', 'Measure the roof on site:%') = 1, 'handing it to someone else tells them to measure it too');
update public.quotes set measure_on_site_reason = 'Trees cover the roof: the oaks' where id = :'q3';
select t1140.check(t1140.told(null, '/roofing/' || :'q3') = 2, 'changing why doesn''t tell anyone again');
commit;

-- ===== Leaving the team, and who can change the areas ==========================================
update public.memberships set active = false where company_id = :'co' and user_id = 'fa000000-0000-0000-0000-000000000003';
select t1140.check((select not active from public.memberships where company_id = :'co' and user_id = 'fa000000-0000-0000-0000-000000000003'), 'Sue leaves the team');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fa000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'client', :'south', 'After Sue left') returning id as r6 \gset
select t1140.check((select assigned_to from public.requests where id = :'r6') = 'fa000000-0000-0000-0000-000000000002', 'someone who left is skipped: the next match (462) gets it');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fa000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t1140.check((select count(*) from public.sales_areas where company_id = :'co') = 4, 'a salesperson sees the areas');
select t1140.expect_error(format('insert into public.sales_areas (company_id, zip, user_id) values (%L, %L, %L)', :'co', '47', 'fa000000-0000-0000-0000-000000000002'), 'but an estimator can''t change them');
commit;

-- ===== Who sold the job =========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fa000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.jobs (company_id, client_id, property_id, quote_id, title) values (:'co', :'client', :'north', :'q2', 'Roof at 12 Oak St') returning id as job \gset
select t1140.check((select salesperson_id from public.jobs where id = :'job') = 'fa000000-0000-0000-0000-000000000002', 'a job made from an estimate says who sold it');
update public.quotes set salesperson_id = 'fa000000-0000-0000-0000-000000000004' where id = :'q2';
select t1140.check((select salesperson_id from public.jobs where id = :'job') = 'fa000000-0000-0000-0000-000000000004', 'and follows the estimate when it changes hands');
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Gutter cleaning') returning id as plain_job \gset
select t1140.check((select salesperson_id is null from public.jobs where id = :'plain_job'), 'a job made without an estimate has nobody');
commit;

\o
