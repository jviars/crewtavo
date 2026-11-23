-- Database tests for Crewtavo - Snow (20261113000100_snow_app): only owners and admins who connect
-- apps install it, and its two client messages come with it once; the office keeps the snow
-- customers (triggers, service level, price tiers, who else works them), in range, with people from
-- the business only, and the crew can't see or change them; snow_recipients, for the server alone,
-- picks the crew's lead and members, the people listed and the people who schedule the team;
-- snow_schedule makes a storm's visits once, as many as its pushes, with those people on them, logs
-- the storm and prices it by its depth; a priced visit bills its price in place of the job's lines;
-- a customer who's told gets its two events; people answer for themselves whether they can go out;
-- the forecast source is the office's to set, the paid one only with a key on file; and storms
-- schedule themselves through the server alone, only for a business whose office turned that on.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tsn;
grant usage on schema tsn to authenticated, service_role;
create function tsn.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tsn.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function tsn.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on all functions in schema tsn to authenticated, service_role;

\set sky 'e5a00000-0000-0000-0000-000000000001'
\set otto 'e5a00000-0000-0000-0000-000000000002'
\set lena 'e5a00000-0000-0000-0000-000000000003'
\set cole 'e5a00000-0000-0000-0000-000000000004'
\set ivy 'e5a00000-0000-0000-0000-000000000005'
\set sam 'e5a00000-0000-0000-0000-000000000006'
\set dan 'e5a00000-0000-0000-0000-000000000007'
\set nora 'e5a00000-0000-0000-0000-000000000008'
\set gail 'e5a00000-0000-0000-0000-000000000009'

-- Sky owns Sky Snow: Otto is office, Gail is office with a role that leaves out the schedule and the
-- settings, Lena leads the Plow crew with Cole and Ivy on it (Ivy has left), Sam and Dan sign in for
-- subs (Dan's sub is turned off). Nora owns Nora Lawn.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'sky', 'sky@sky-snow.test', '{"full_name": "Sky Snow"}'),
  (:'otto', 'otto@sky-snow.test', '{"full_name": "Otto Office"}'),
  (:'lena', 'lena@sky-snow.test', '{"full_name": "Lena Lead"}'),
  (:'cole', 'cole@sky-snow.test', '{"full_name": "Cole Crew"}'),
  (:'ivy', 'ivy@sky-snow.test', '{"full_name": "Ivy Gone"}'),
  (:'sam', 'sam@sam-salt.test', '{"full_name": "Sam Salt"}'),
  (:'dan', 'dan@dan-plow.test', '{"full_name": "Dan Plow"}'),
  (:'nora', 'nora@nora-lawn.test', '{"full_name": "Nora Lawn"}'),
  (:'gail', 'gail@sky-snow.test', '{"full_name": "Gail Billing"}');

begin;
set local role authenticated;
select tsn.as_user(:'nora');
select public.create_company('Nora Lawn', 'lawn_exterior') as other \gset
select tsn.as_user(:'sky');
select public.create_company('Sky Snow', 'lawn_exterior') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Billing', 'office', '{invoices}') returning id as billing \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'otto', 'office', null), (:'co', :'gail', 'office', :'billing'), (:'co', :'lena', 'crew_lead', null), (:'co', :'cole', 'field_crew', null), (:'co', :'ivy', 'field_crew', null);
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Plow', :'lena') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', :'cole'), (:'co', :'crew', :'ivy');
insert into public.clients (company_id, display_name, email) values (:'co', 'Maple Plaza', 'maple@plaza.test') returning id as client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '1 Maple Way') returning id as prop \gset
insert into public.jobs (company_id, client_id, property_id, title, default_crew_id, kind, recurrence_rule, billing_mode)
  values (:'co', :'client', :'prop', 'Plow the lot', :'crew', 'recurring', 'FREQ=YEARLY', 'per_visit') returning id as job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'job', 'Snow plowing', 1, 'push', 60);
commit;

-- The subs' sign-ins, as the server makes them, and Ivy leaving the team.
insert into public.subcontractors (id, company_id, name) values
  ('e5a00000-0000-0000-0000-0000000000c1', :'co', 'Sam Salt LLC'), ('e5a00000-0000-0000-0000-0000000000c2', :'co', 'Dan Plow LLC');
insert into public.memberships (company_id, user_id, role, subcontractor_id) values
  (:'co', :'sam', 'subcontractor', 'e5a00000-0000-0000-0000-0000000000c1'),
  (:'co', :'dan', 'subcontractor', 'e5a00000-0000-0000-0000-0000000000c2');
update public.subcontractors set active = false where id = 'e5a00000-0000-0000-0000-0000000000c2';
update public.memberships set active = false where company_id = :'co' and user_id = :'ivy';

-- ===== Installing it ============================================================================
begin;
set local role authenticated;
select tsn.as_user(:'otto');
select tsn.expect_error(format($q$select public.trade_app_set_enabled(%L, 'snow', true)$q$, :'co'), 'the office can''t install Snow');
select tsn.as_user(:'sky');
select public.trade_app_set_enabled(:'co', 'snow', true);
select tsn.check((select public.company_settings(id) #>> '{snow_app,enabled}' = 'true' from public.companies where id = :'co'), 'the owner installs Snow');
update public.automation_rules set name = 'We''re coming' where company_id = :'co' and template_key = 'snow_scheduled';
select public.trade_app_set_enabled(:'co', 'snow', false);
select public.trade_app_set_enabled(:'co', 'snow', true);
commit;
select tsn.check((select count(*) = 2 and bool_and(enabled) and bool_or(name = 'We''re coming')
  from public.automation_rules where company_id = :'co' and template_key in ('snow_scheduled', 'snow_completed')),
  'its two client messages come with it once, and stay as the business rewords them');

-- ===== Snow customers ===========================================================================
begin;
set local role authenticated;
select tsn.as_user(:'otto');
insert into public.snow_sites (company_id, job_id, trigger_in, salt_trigger_in, repeat_in, clear_by, priority, tell_client, tiers)
  values (:'co', :'job', 2, 0.5, 3, '07:00', 1, true, '[{"up_to_in": 4, "price": 75}, {"up_to_in": 8, "price": 110}, {"up_to_in": null, "price": 140}]');
select tsn.check((select trigger_in = 2 and priority = 1 from public.snow_sites where job_id = :'job'), 'the office makes a job a snow customer, with its triggers and service level');
select tsn.expect_error(format('update public.snow_sites set trigger_in = 0 where job_id = %L', :'job'), 'a trigger of no snow is refused');
select tsn.expect_error(format('update public.snow_sites set trigger_in = 60 where job_id = %L', :'job'), 'and one of five feet');
select tsn.expect_error(format('update public.snow_sites set salt_trigger_in = 2 where job_id = %L', :'job'), 'salting starts under the plow trigger');
select tsn.expect_error(format($q$update public.snow_sites set tiers = '[{"up_to_in": 4}]' where job_id = %L$q$, :'job'), 'a price tier needs a price');
insert into public.snow_site_people (company_id, job_id, user_id) values (:'co', :'job', :'otto'), (:'co', :'job', :'sam'), (:'co', :'job', :'dan');
select tsn.check((select count(*) = 3 from public.snow_site_people where job_id = :'job'), 'the office lists people on it, a sub''s sign-in too');
select tsn.expect_error(format('insert into public.snow_site_people (company_id, job_id, user_id) values (%L, %L, %L)', :'co', :'job', :'nora'),
  'but not someone from another business');
commit;

begin;
set local role authenticated;
select tsn.as_user(:'cole');
select tsn.check((select count(*) = 0 from public.snow_sites) and (select count(*) = 0 from public.snow_site_people), 'the crew doesn''t see the snow customers or who''s on them');
select tsn.expect_error(format('insert into public.snow_site_people (company_id, job_id, user_id) values (%L, %L, %L)', :'co', :'job', :'cole'), 'nor add to them');
select tsn.as_user(:'nora');
select tsn.check((select count(*) = 0 from public.snow_sites), 'nor does another business');
select tsn.expect_error(format('select public.snow_recipients(array[%L]::uuid[])', :'job'), 'only the server asks who''s told');
commit;

-- ===== Who's told ================================================================================
select tsn.check((select array_agg(user_id order by user_id) = array[:'otto', :'lena', :'cole', :'sam']::uuid[] from public.snow_recipients(array[:'job']::uuid[]) where not office),
  'the crew''s lead and members and the people listed, not someone who left or a sub turned off');
select tsn.check((select array_agg(user_id order by user_id) = array[:'sky', :'otto']::uuid[] from public.snow_recipients(array[:'job']::uuid[]) where office),
  'and the people who schedule the team: the owner and the office, not office staff without the schedule area');

-- ===== Scheduling a storm ========================================================================
select private.company_today(:'co') + 1 as tomorrow \gset
select jsonb_build_array(jsonb_build_object('job_id', :'job', 'inches', 8.2, 'pushes', 3, 'kind', 'plow')) as plan \gset
begin;
set local role authenticated;
select tsn.as_user(:'cole');
select tsn.expect_error(format('select public.snow_schedule(%L, %L, %L)', :'co', :'tomorrow', :'plan'), 'the crew can''t schedule the storm');
select tsn.as_user(:'gail');
select tsn.expect_error(format('select public.snow_schedule(%L, %L, %L)', :'co', :'tomorrow', :'plan'), 'nor office staff without the schedule area');
select tsn.as_user(:'otto');
select tsn.expect_error(format('select public.snow_schedule(%L, %L, %L)', :'co', private.company_today(:'co') - 1, :'plan'), 'a day gone by is refused');
select tsn.check(public.snow_schedule(:'co', :'tomorrow', :'plan'::jsonb) = 3, 'the office schedules the storm: a visit for each of its three pushes');
select tsn.check(public.snow_schedule(:'co', :'tomorrow', :'plan'::jsonb) = 0, 'asking again doesn''t double them');
commit;
select tsn.check((select count(*) = 3 and bool_and(v.crew_id = :'crew' and v.property_id = :'prop' and v.notes = E'Clear by 7:00 AM\nFirst priority')
    and array_agg(v.title order by v.title) = array['Plow the lot (push 1 of 3)', 'Plow the lot (push 2 of 3)', 'Plow the lot (push 3 of 3)']
  from public.visits v join public.snow_visits sv on sv.visit_id = v.id where sv.job_id = :'job' and sv.snow_date = :'tomorrow'),
  'the visits are the job''s, with its crew, at its property, numbered, with the service level in their notes');
select tsn.check((select count(*) = 12 and count(distinct a.user_id) = 4 and bool_and(a.user_id in (:'otto', :'lena', :'cole', :'sam'))
  from public.visit_assignees a join public.snow_visits sv on sv.visit_id = a.visit_id where sv.job_id = :'job'),
  'with the crew and the people listed on each, the sub too');
select tsn.check((select count(distinct user_id) = 3 from public.notifications where company_id = :'co' and kind = 'schedule' and user_id in (:'lena', :'cole', :'sam')),
  'and each of them is told they''re on it (not the one who scheduled it)');
select tsn.check((select forecast_in = 8.2 and pushes = 3 and kind = 'plow' and actual_in is null from public.snow_events where job_id = :'job' and snow_date = :'tomorrow'),
  'the storm is in the log, with what was forecast');
begin;
set local role authenticated;
select tsn.as_user(:'nora');
select tsn.expect_error(format('select public.snow_schedule(%L, %L, %L)', :'co', :'tomorrow', :'plan'), 'another business can''t schedule it');
select tsn.check(public.snow_schedule(:'other', :'tomorrow', :'plan'::jsonb) = 0, 'nor through its own company');
commit;

-- ===== What the storm bills =====================================================================
select tsn.check((select array_agg(v.price order by v.title) = array[140, 0, 0]::numeric[] and bool_or(v.price_note = '8.2 in of snow') and bool_or(v.price_note = 'Included in the storm''s price')
  from public.visits v join public.snow_visits sv on sv.visit_id = v.id where sv.job_id = :'job'),
  'the storm''s price, by the depth forecast, is on its first visit, and the pushes after it are included');
begin;
set local role authenticated;
select tsn.as_user(:'otto');
update public.snow_events set actual_in = 6 where job_id = :'job' and snow_date = :'tomorrow';
commit;
select tsn.check((select actual_by = :'otto' from public.snow_events where job_id = :'job' and snow_date = :'tomorrow')
  and (select array_agg(v.price order by v.title) = array[110, 0, 0]::numeric[] and bool_or(v.price_note = '6.0 in of snow')
       from public.visits v join public.snow_visits sv on sv.visit_id = v.id where sv.job_id = :'job'),
  'what fell, once the office writes it, reprices the storm');
begin;
set local role authenticated;
select tsn.as_user(:'cole');
select tsn.expect_error(format('update public.visits set price = 1 where job_id = %L', :'job'), 'the crew on a visit can''t change what it bills');
commit;

-- The first two pushes are done, and so is an ordinary visit on the same job.
select v.id as push1 from public.visits v where v.title = 'Plow the lot (push 1 of 3)' \gset
select v.id as push2 from public.visits v where v.title = 'Plow the lot (push 2 of 3)' \gset
begin;
set local role authenticated;
select tsn.as_user(:'otto');
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'job', :'prop', 'Stake the lot', private.company_today(:'co')) returning id as plain \gset
update public.visits set status = 'completed' where id in (:'push1', :'push2', :'plain');
select public.create_invoice_for_job(:'job', 'visits') as invoice \gset
commit;
select tsn.check((select count(*) = 3 and sum(quantity * unit_price) = 170
    and bool_or(unit_price = 110 and name = 'Snow plowing' and description like 'Visit on %: 6.0 in of snow')
    and bool_or(unit_price = 0 and description like '%Included in the storm''s price')
    and bool_or(unit_price = 60 and unit = 'push')
  from public.invoice_line_items where invoice_id = :'invoice'),
  'a priced visit bills its price as one line, an included push bills nothing, and an ordinary visit bills the job''s lines');
begin;
set local role authenticated;
select tsn.as_user(:'otto');
update public.snow_events set actual_in = 3 where job_id = :'job' and snow_date = :'tomorrow';
commit;
select tsn.check((select price = 110 from public.visits where id = :'push1'), 'a visit already invoiced keeps what it was billed');

-- ===== The customer is told =====================================================================
select tsn.check((select count(*) = 1 from public.activity where company_id = :'co' and verb = 'snow.scheduled' and subject_type = 'visit')
  and (select count(*) = 2 from public.activity where company_id = :'co' and verb = 'snow.completed' and subject_id in (:'push1', :'push2'))
  and not exists (select 1 from public.activity where verb = 'snow.completed' and subject_id = :'plain'),
  'a customer who''s told gets one event when the storm is scheduled and one for each snow visit done, not for other visits');
select tsn.check((select count(*) = 3 from public.automation_runs r join public.automation_rules a on a.id = r.rule_id
  where a.company_id = :'co' and a.template_key in ('snow_scheduled', 'snow_completed')), 'and its messages are queued');

-- ===== Can you go out? ==========================================================================
insert into public.snow_availability (company_id, snow_date, user_id) values (:'co', :'tomorrow', :'lena'), (:'co', :'tomorrow', :'sam');
begin;
set local role authenticated;
select tsn.as_user(:'lena');
select tsn.check((select count(*) = 1 and bool_and(user_id = :'lena' and can is null) from public.snow_availability), 'someone asked sees their own question, not anyone else''s');
select tsn.expect_error(format('select public.snow_answer(%L, %L, true)', :'co', (:'tomorrow'::date + 5)), 'and can''t answer for a day nobody asked about');
update public.snow_availability set can = true where user_id = :'sam';
select tsn.check(public.snow_answer(:'co', :'tomorrow', true), 'they say yes');
select tsn.as_user(:'sam');
select tsn.check((select can is null from public.snow_availability), 'and nobody can answer for someone else: the sub''s question is still open');
select tsn.check(not public.snow_answer(:'co', :'tomorrow', false), 'a sub says no');
select tsn.as_user(:'otto');
select tsn.check((select count(*) = 2 and bool_or(can) and bool_or(not can) from public.snow_availability where snow_date = :'tomorrow'), 'the office sees everyone''s answers');
commit;
select tsn.check((select array_agg(user_id order by user_id) = array[:'sky', :'otto']::uuid[] and bool_and(title like 'Sam Salt can''t go out for snow on %' and link = '/snow')
  from public.notifications where company_id = :'co' and kind = 'snow'), 'a no is news for the people who schedule the team, and a yes isn''t');

-- ===== Where forecasts come from ================================================================
begin;
set local role authenticated;
select tsn.as_user(:'cole');
select tsn.expect_error(format($q$select public.set_weather_source(%L, 'nws')$q$, :'co'), 'the crew can''t change the forecast source');
select tsn.as_user(:'gail');
select tsn.expect_error(format($q$select public.set_weather_source(%L, 'nws')$q$, :'co'), 'nor office staff without the settings area');
select tsn.as_user(:'otto');
select public.set_weather_source(:'co', 'nws');
select tsn.check((select public.company_settings(id) ->> 'weather_source' = 'nws' and public.company_settings(id) #>> '{snow_app,enabled}' = 'true' from public.companies where id = :'co'),
  'the office picks the National Weather Service, and the other settings stay');
select tsn.expect_error(format($q$select public.set_weather_source(%L, 'accuweather')$q$, :'co'), 'a source that isn''t one is refused');
select tsn.expect_error(format($q$select public.set_weather_source(%L, 'open_meteo_commercial')$q$, :'co'), 'and Open-Meteo''s paid service, until its key is on the Apps page');
commit;
insert into public.integrations (company_id, provider, status) values (:'co', 'open_meteo', 'connected');
begin;
set local role authenticated;
select tsn.as_user(:'otto');
select tsn.check(public.set_weather_source(:'co', 'open_meteo_commercial') = 'open_meteo_commercial', 'with the key on file, the paid service can be picked');
commit;

-- ===== The standard storm prices ==============================================================
begin;
set local role authenticated;
select tsn.as_user(:'cole');
select tsn.expect_error(format($q$select public.set_snow_storm_prices(%L, '[{"up_to_in": 3, "times": 1}]')$q$, :'co'), 'the crew can''t set the standard storm prices');
select tsn.as_user(:'otto');
select tsn.expect_error(format($q$select public.set_snow_storm_prices(%L, '{"times": 1}')$q$, :'co'), 'the standard is a list of depths');
select tsn.expect_error(format($q$select public.set_snow_storm_prices(%L, '[{"up_to_in": 3, "times": 0}]')$q$, :'co'), 'a depth needs a multiple above zero');
select tsn.expect_error(format($q$select public.set_snow_storm_prices(%L, '[{"up_to_in": "deep", "times": 1}]')$q$, :'co'), 'and inches that are a number');
select tsn.expect_error(format($q$select public.set_snow_storm_prices(%L, '[{"times": 1}, {"up_to_in": null, "times": 2}]')$q$, :'co'), 'only one depth can be left open');
select public.set_snow_storm_prices(:'co', '[{"up_to_in": 3, "times": 1}, {"up_to_in": 6, "times": 1.5}, {"up_to_in": null, "times": 2}]');
select tsn.check((select jsonb_array_length(public.company_settings(id) -> 'snow_storm_prices') = 3 and public.company_settings(id) #>> '{snow_storm_prices,1,times}' = '1.5' and public.company_settings(id) ->> 'weather_source' is not null
  from public.companies where id = :'co'), 'the office sets them, and the other settings stay');
commit;

-- ===== Storms that schedule themselves ===========================================================
-- The storm grows by two pushes past the visits it has, on the day it's already scheduled for.
select count(*) + 2 as more from public.snow_visits sv join public.visits v on v.id = sv.visit_id where sv.job_id = :'job' and sv.snow_date = :'tomorrow' and v.status <> 'cancelled' \gset
select jsonb_build_array(jsonb_build_object('job_id', :'job', 'inches', 14, 'pushes', :more, 'kind', 'plow')) as grown \gset
begin;
set local role authenticated;
select tsn.as_user(:'cole');
select tsn.expect_error(format('select public.set_snow_auto_schedule(%L, true)', :'co'), 'the crew can''t have storms schedule themselves');
select tsn.as_user(:'otto');
select tsn.expect_error(format('select public.snow_schedule_auto(%L, %L, %L)', :'co', :'tomorrow', :'grown'), 'scheduling as the server is the server''s alone');
commit;
begin;
set local role service_role;
select tsn.check(public.snow_schedule_auto(:'co', :'tomorrow', :'grown'::jsonb) = 0, 'with the switch off the server schedules nothing');
commit;
select coalesce(settings -> 'snow_app', '{}'::jsonb) as before from public.companies where id = :'co' \gset
begin;
set local role authenticated;
select tsn.as_user(:'otto');
select tsn.check(public.set_snow_auto_schedule(:'co', true), 'the office turns it on');
commit;
select tsn.check((select settings -> 'snow_auto_schedule' = 'true' and coalesce(settings -> 'snow_app', '{}'::jsonb) = :'before'::jsonb from public.companies where id = :'co'), 'which is its own setting: whether Snow is installed stays the Apps area''s');
begin;
set local role service_role;
select tsn.check(public.snow_schedule_auto(:'co', :'tomorrow', :'grown'::jsonb) = 2, 'with it on the server schedules the storm it''s telling people about: the two visits it grew by');
select tsn.check(public.snow_schedule_auto(:'co', :'tomorrow', :'grown'::jsonb) = 0, 'and never doubles them');
commit;
select tsn.check((select count(*) = :more from public.snow_visits sv join public.visits v on v.id = sv.visit_id where sv.job_id = :'job' and sv.snow_date = :'tomorrow' and v.status <> 'cancelled'),
  'they''re the storm''s own visits, as the office''s are');
begin;
set local role authenticated;
select tsn.as_user(:'otto');
select tsn.check(not public.set_snow_auto_schedule(:'co', false), 'and the office turns it off again');
commit;

-- ===== Leaving =================================================================================
update public.crews set active = false where id = :'crew';
select tsn.check((select array_agg(user_id order by user_id) = array[:'otto', :'sam']::uuid[] from public.snow_recipients(array[:'job']::uuid[]) where not office),
  'a crew that''s no longer active isn''t told');
delete from public.snow_sites where job_id = :'job';
select tsn.check((select count(*) = 0 from public.snow_site_people where job_id = :'job') and (select count(*) = 1 from public.snow_events where job_id = :'job'),
  'a job that stops being a snow customer loses its list of people, and keeps its storm log');
