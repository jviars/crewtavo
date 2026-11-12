-- Database tests for 20261112000420_rates_behind_job_costs.sql: nobody types the pay rate on a time
-- entry (it's the person's own when the time is approved), and a price-list item added to a quote
-- or job by someone who isn't shown costs takes the item's cost.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema trates;
grant usage on schema trates to anon, authenticated, service_role;
create function trates.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function trates.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function trates.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- Pay rates and costs can't be read by the people under test, so the checks read them as the database.
create function trates.entry_rate(p_entry uuid) returns numeric language sql security definer as $$
  select labor_rate from public.time_entries where id = p_entry;
$$;
create function trates.pay_rate(p_user uuid) returns numeric language sql security definer as $$
  select labor_rate from public.memberships where user_id = p_user;
$$;
grant execute on all functions in schema trates to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('7a7e0000-0000-0000-0000-000000000001', 'owner@rates.test', '{"full_name": "Pat Owner"}'),
  ('7a7e0000-0000-0000-0000-000000000002', 'office@rates.test', '{"full_name": "Oli Office"}'),
  ('7a7e0000-0000-0000-0000-000000000003', 'people@rates.test', '{"full_name": "Paz People"}'),
  ('7a7e0000-0000-0000-0000-000000000004', 'estimator@rates.test', '{"full_name": "Eve Estimator"}'),
  ('7a7e0000-0000-0000-0000-000000000005', 'crew@rates.test', '{"full_name": "Cam Crew"}');
\set owner '7a7e0000-0000-0000-0000-000000000001'
\set office '7a7e0000-0000-0000-0000-000000000002'
\set people '7a7e0000-0000-0000-0000-000000000003'
\set estimator '7a7e0000-0000-0000-0000-000000000004'
\set crew '7a7e0000-0000-0000-0000-000000000005'

begin;
set local role authenticated;
select trates.as_user(:'owner');
select public.create_company('Rates Roofing', 'general') as co \gset
commit;
-- Oli is office without job costs (approves time, sends invoices); Paz is an admin who manages
-- people, also without job costs. Set up as the database, the way the server's invite does it.
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Front desk', 'office', '{timesheets,invoices,sales}') returning id as desk \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'People', 'admin', '{team}') returning id as people_role \gset
insert into public.memberships (company_id, user_id, role, role_id, labor_rate) values
  (:'co', :'office', 'office', :'desk', 30),
  (:'co', :'people', 'admin', :'people_role', null),
  (:'co', :'estimator', 'estimator', null, null),
  (:'co', :'crew', 'field_crew', null, 22);
insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values (:'co', :'crew', 'shop', now() - interval '5 hours', now() - interval '4 hours') returning id as crew_time \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Ridge vent', 'lf', 12, 7.5) returning id as vent \gset
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Haul away', 'ea', 150) returning id as haul \gset
insert into public.clients (company_id, display_name) values (:'co', 'Rates Client') returning id as client \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Rates roof') returning id as quote \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Rates job') returning id as job \gset

\o
\echo 'Rates behind job costs'
\o /dev/null

-- The rate on a time entry is the person's own, whoever approves and whatever they send.
begin;
set local role authenticated;
select trates.as_user(:'office');
select trates.check(not private.has_perm(:'co', 'job_costs') and private.has_perm(:'co', 'timesheets'), 'Oli approves time and has no job costs');
insert into public.time_entries (company_id, user_id, category, started_at, ended_at, labor_rate) values (:'co', :'office', 'shop', now() - interval '3 hours', now() - interval '2 hours', 999) returning id as own \gset
select trates.check(trates.entry_rate(:'own') is null, 'a rate typed on new time isn''t kept, from the office either');
update public.time_entries set approved_at = now(), approved_by = :'office', labor_rate = 500 where id = :'own';
select trates.check(trates.entry_rate(:'own') = 30, 'approving their own time with a rate of their choosing pays their real rate');
update public.time_entries set labor_rate = 500 where id = :'own';
select trates.check(trates.entry_rate(:'own') = 30, 'and it can''t be raised afterwards');
update public.time_entries set approved_at = now(), approved_by = :'office', labor_rate = 500 where id = :'crew_time';
select trates.check(trates.entry_rate(:'crew_time') = 22, 'nor anyone else''s: approved time takes the person''s pay rate');
rollback;

begin;
set local role authenticated;
select trates.as_user(:'owner');
-- What Timesheets sends: the approval with the rate it was shown (here an out-of-date one), or null.
update public.time_entries set approved_at = now(), approved_by = :'owner', labor_rate = 20 where id = :'crew_time';
select trates.check(trates.entry_rate(:'crew_time') = 22, 'an owner''s approval reads the rate too, so an out-of-date screen can''t set it');
update public.memberships set labor_rate = 25 where company_id = :'co' and user_id = :'crew';
update public.time_entries set notes = 'Shop clean-up' where id = :'crew_time';
select trates.check(trates.entry_rate(:'crew_time') = 22, 'approved time keeps its rate when the person''s rate changes');
update public.time_entries set approved_at = null, approved_by = null where id = :'crew_time';
update public.time_entries set approved_at = now(), approved_by = :'owner', labor_rate = null where id = :'crew_time';
select trates.check(trates.entry_rate(:'crew_time') = 25, 'approved again, it takes the rate as it is now');
rollback;

-- The server's own writes (no person signed in) keep the rate they give, as before.
begin;
update public.time_entries set approved_at = now(), labor_rate = 40 where id = :'crew_time';
select trates.check(trates.entry_rate(:'crew_time') = 40, 'the server''s own write keeps its rate');
rollback;

-- Setting pay rates stays with the people who manage the team, job costs or not.
begin;
set local role authenticated;
select trates.as_user(:'people');
select trates.check(private.has_perm(:'co', 'team') and not private.has_perm(:'co', 'job_costs'), 'Paz manages people and has no job costs');
select trates.check(trates.error_of(format('update public.memberships set labor_rate = 24 where company_id = %L and user_id = %L', :'co', :'crew')) = 'none' and trates.pay_rate(:'crew') = 24, 'and still sets pay rates');
rollback;

-- A price-list item goes on with its cost, whoever adds it.
begin;
set local role authenticated;
select trates.as_user(:'estimator');
select trates.check(not private.has_perm(:'co', 'job_costs'), 'Eve estimates and has no job costs');
insert into public.quote_line_items (company_id, quote_id, service_id, name, unit, unit_price, quantity) values (:'co', :'quote', :'vent', 'Ridge vent', 'lf', 12, 40) returning id as line \gset
select trates.check((select unit_cost = 7.5 from public.quote_line_items where id = :'line'), 'an estimator''s line, sent without a cost, takes the item''s');
insert into public.quote_line_items (company_id, quote_id, service_id, name, unit, unit_price, quantity, unit_cost) values (:'co', :'quote', :'vent', 'Ridge vent', 'lf', 12, 10, 6) returning id as sent \gset
select trates.check((select unit_cost = 6 from public.quote_line_items where id = :'sent'), 'a cost that''s sent is kept (the previous app version sends it)');
insert into public.quote_line_items (company_id, quote_id, service_id, name, unit, unit_price, quantity) values (:'co', :'quote', :'haul', 'Haul away', 'ea', 150, 1) returning id as nocost \gset
insert into public.quote_line_items (company_id, quote_id, name, unit, unit_price, quantity) values (:'co', :'quote', 'Custom flashing', 'ea', 80, 1) returning id as custom \gset
select trates.check((select bool_and(unit_cost is null) from public.quote_line_items where id in (:'nocost', :'custom')), 'an item with no cost, or a line that isn''t from the price list, has none');
rollback;
begin;
set local role authenticated;
select trates.as_user(:'office');
insert into public.job_line_items (company_id, job_id, service_id, name, unit, unit_price, quantity) values (:'co', :'job', :'vent', 'Ridge vent', 'lf', 12, 5) returning id as jline \gset
select trates.check((select unit_cost = 7.5 from public.job_line_items where id = :'jline'), 'the same on a job, for the office without job costs');
rollback;
begin;
set local role authenticated;
select trates.as_user(:'owner');
insert into public.quote_line_items (company_id, quote_id, service_id, name, unit, unit_price, quantity) values (:'co', :'quote', :'vent', 'Ridge vent', 'lf', 12, 1) returning id as oline \gset
select trates.check((select unit_cost is null from public.quote_line_items where id = :'oline'), 'a line from someone who sees costs is kept as they sent it');
rollback;

\o
\echo 'All rates-behind-job-costs tests passed.'
