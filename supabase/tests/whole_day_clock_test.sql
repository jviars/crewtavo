-- Database tests for 20261113000610_whole_day_clock.sql: how the clock works is a company setting
-- (a new company starts on the whole day, one with nothing saved stays on visits only, and saving
-- the rest of the Time clock settings keeps it); on the whole-day clock finishing a visit moves the
-- team's clocks on it to travel instead of stopping them (not a sub's, not over later or paid
-- time); on visits only it stops them as before; and the hourly upkeep measures a whole-day clock
-- from when the person clocked in.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema twd;
grant usage on schema twd to authenticated, service_role;
create function twd.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function twd.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- The server, or the test's own shortcuts: nobody signed in.
create function twd.as_nobody() returns void language sql as $$
  select set_config('request.jwt.claims', '', true)
$$;
-- A visit today with these people on it, under way.
create function twd.visit(p_company uuid, p_title text, p_people uuid[]) returns uuid language plpgsql as $$
declare v_visit uuid;
begin
  insert into public.visits (company_id, title, status, scheduled_on) values (p_company, p_title, 'in_progress', private.company_today(p_company))
  returning id into v_visit;
  insert into public.visit_assignees (company_id, visit_id, user_id) select p_company, v_visit, u from unnest(p_people) u;
  return v_visit;
end $$;
-- Someone's clock on a visit (or, with no visit, on something else), started then.
create function twd.clock(p_company uuid, p_user uuid, p_visit uuid, p_started timestamptz, p_category text default 'visit') returns uuid language sql as $$
  insert into public.time_entries (company_id, user_id, visit_id, category, started_at) values (p_company, p_user, p_visit, p_category, p_started) returning id
$$;
create function twd.ended(p_entry uuid) returns timestamptz language sql as $$
  select ended_at from public.time_entries where id = p_entry
$$;
-- What someone's clock is running on, as "category since when": null when it's off.
create function twd.running(p_user uuid) returns text language sql as $$
  select string_agg(category || case when visit_id is not null or job_id is not null then ' on work' else '' end, ', ') from public.time_entries where user_id = p_user and ended_at is null
$$;
create function twd.running_since(p_user uuid) returns timestamptz language sql as $$
  select min(started_at) from public.time_entries where user_id = p_user and ended_at is null
$$;
grant execute on all functions in schema twd to authenticated, service_role;

\set pat 'da100000-0000-0000-0000-000000000001'
\set ray 'da100000-0000-0000-0000-000000000002'
\set sam 'da100000-0000-0000-0000-000000000003'
\set tess 'da100000-0000-0000-0000-000000000004'
\set sal 'da100000-0000-0000-0000-000000000005'
\set lou 'da100000-0000-0000-0000-000000000006'

-- Everything below is rolled back at the end.
begin;
-- Pat owns Daylight Lawn; Lou leads the crew Ray, Sam and Tess are on; Sal signs in as a sub the
-- office keeps hours for.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'pat', 'pat@daylight.test', '{"full_name": "Pat Owner"}'),
  (:'ray', 'ray@daylight.test', '{"full_name": "Ray Crew"}'),
  (:'sam', 'sam@daylight.test', '{"full_name": "Sam Crew"}'),
  (:'tess', 'tess@daylight.test', '{"full_name": "Tess Crew"}'),
  (:'sal', 'sal@daylight.test', '{"full_name": "Sal Sub"}'),
  (:'lou', 'lou@daylight.test', '{"full_name": "Lou Lead"}');
set local role authenticated;
select twd.as_user(:'pat');
select public.create_company('Daylight Lawn', 'general') as co \gset

\o
\echo 'How the clock works is a company setting'
\o /dev/null
select twd.check((select public.company_settings(id) -> 'clock' ->> 'mode' = 'day' from public.companies where id = :'co'), 'a new company starts on the whole-day clock');
-- Settings → Company saving the rest of the Time clock card (the previous app version doesn't send the mode).
select public.merge_company_settings(:'co', '{"clock": {"record_location": true, "breaks": "paid"}}');
select twd.check((select public.company_settings(id) -> 'clock' = '{"mode": "day", "record_location": true, "breaks": "paid"}'::jsonb from public.companies where id = :'co'), 'saving the other clock settings keeps it');
reset role;
select twd.check(private.clock_mode(:'co') = 'day', 'and the database reads it as the whole day');
set local role authenticated;
select public.merge_company_settings(:'co', '{"clock": {"mode": "visits"}}');
reset role;
select twd.as_nobody();
select twd.check(private.clock_mode(:'co') = 'visits', 'an owner can change it');
-- A company from before the setting has nothing saved.
update public.companies set settings = settings #- '{clock,mode}' where id = :'co';
select twd.check(private.clock_mode(:'co') = 'visits', 'a company with nothing saved is on visits only, as it always was');
update public.companies set settings = jsonb_set(settings, '{clock,mode}', '"anything"') where id = :'co';
select twd.check(private.clock_mode(:'co') = 'visits', 'and so is one with something else saved');
-- A row that says how its clock works keeps what it says (a restore, an import).
insert into public.companies (name, slug, settings) values ('Old Timer', 'old-timer', '{"clock": {"mode": "visits", "breaks": "unpaid"}}') returning id as old \gset
select twd.check((select settings -> 'clock' = '{"mode": "visits", "breaks": "unpaid"}'::jsonb from public.companies where id = :'old'), 'a company added with its clock already set keeps it');
insert into public.companies (name, slug, settings) values ('Half Set', 'half-set', '{"clock": {"breaks": "unpaid"}, "hub_tips": true}') returning id as half \gset
select twd.check((select settings = '{"clock": {"mode": "day", "breaks": "unpaid"}, "hub_tips": true}'::jsonb from public.companies where id = :'half'), 'one added without it gets the whole day beside its other settings');

insert into public.memberships (company_id, user_id, role) values (:'co', :'ray', 'field_crew'), (:'co', :'sam', 'field_crew'), (:'co', :'tess', 'field_crew'), (:'co', :'lou', 'crew_lead');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Mowing', :'lou') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', :'ray'), (:'co', :'crew', :'sam'), (:'co', :'crew', :'tess');
insert into public.subcontractors (company_id, name, uses_clock) values (:'co', 'Sal''s Stump Grinding', true) returning id as sub \gset
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', :'sub');
-- Fixed moments earlier today, so the checks can name them.
select date_trunc('minute', now()) - interval '5 hours' as t0 \gset

\o
\echo 'The whole-day clock: finishing a visit moves its clocks to travel'
\o /dev/null
update public.companies set settings = jsonb_set(settings, '{clock,mode}', '"day"') where id = :'co';
select twd.visit(:'co', 'Front lawn', array[:'ray', :'sam', :'tess', :'sal']::uuid[]) as v1 \gset
select twd.clock(:'co', :'ray', :'v1', :'t0') as ray1 \gset
select twd.clock(:'co', :'sam', :'v1', :'t0'::timestamptz + interval '10 minutes') as sam1 \gset
select twd.clock(:'co', :'sal', :'v1', :'t0') as sal1 \gset
-- Tess is on her break.
select twd.clock(:'co', :'tess', null, :'t0'::timestamptz + interval '90 minutes', 'break') as tess1 \gset

set local role authenticated;
select twd.as_user(:'ray');
update public.visits set status = 'completed', completed_at = :'t0'::timestamptz + interval '2 hours' where id = :'v1';
reset role;
select twd.as_nobody();
select twd.check(twd.ended(:'sam1') = :'t0'::timestamptz + interval '2 hours' and twd.ended(:'ray1') = twd.ended(:'sam1'), 'everyone''s clock on the visit ends when it was finished');
select twd.check(twd.running(:'sam') = 'drive' and twd.running(:'ray') = 'drive', 'and each of them is on travel from there: Driving, on no visit and no job');
select twd.check(twd.running_since(:'sam') = :'t0'::timestamptz + interval '2 hours' + interval '1 millisecond', 'it starts a millisecond on, so a phone on the previous app version doesn''t stop it with the visit');
select twd.check((select count(*) = 2 from public.time_entries where user_id = :'sam') and not exists (select 1 from public.time_entries a join public.time_entries b on a.user_id = b.user_id and a.id < b.id
  where a.company_id = :'co' and a.started_at < coalesce(b.ended_at, 'infinity') and b.started_at < coalesce(a.ended_at, 'infinity')), 'one clock each, and none of their time overlaps');
select twd.check(twd.ended(:'tess1') is null and twd.running(:'tess') = 'break', 'a break is still a break: someone not on the visit''s clock is left as they are');
select twd.check(twd.ended(:'sal1') = :'t0'::timestamptz + interval '2 hours' and twd.running(:'sal') is null, 'a sub''s clock stops with the visit and doesn''t go on to travel');

-- A clock-in that arrives after the visit was finished (Tess tapped Start with no signal, 1 h 45 in).
set local role authenticated;
select twd.as_user(:'tess');
insert into public.time_entries (company_id, user_id, visit_id, category, started_at) values (:'co', :'tess', :'v1', 'visit', :'t0'::timestamptz + interval '105 minutes') returning id as tess1b \gset
reset role;
select twd.as_nobody();
select twd.check(twd.ended(:'tess1') = :'t0'::timestamptz + interval '105 minutes' and twd.ended(:'tess1b') = :'t0'::timestamptz + interval '2 hours' and twd.running(:'tess') = 'drive',
  'a clock-in that arrives late ends when the visit was finished and goes on to travel too');
delete from public.time_entries where company_id = :'co';

-- What it never does.
select twd.visit(:'co', 'Back lawn', array[:'ray', :'sam', :'tess']::uuid[]) as v2 \gset
-- Ray: later time already on record.
select twd.clock(:'co', :'ray', :'v2', :'t0') as ray2 \gset
insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values (:'co', :'ray', 'shop', :'t0'::timestamptz + interval '1 hour', :'t0'::timestamptz + interval '90 minutes');
-- Sam: marked paid for a period with today in it.
select twd.clock(:'co', :'sam', :'v2', :'t0') as sam2 \gset
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', private.company_today(:'co') - 7, private.company_today(:'co') + 1) returning id as period \gset
insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at) values (:'co', :'period', :'sam', 0, 0, 0, 'check', now());
-- Tess: no longer with the company (her sign-in was turned off with her clock running).
select twd.clock(:'co', :'tess', :'v2', :'t0') as tess2 \gset
update public.memberships set active = false where company_id = :'co' and user_id = :'tess';
set local role authenticated;
select twd.as_user(:'pat');
update public.visits set status = 'completed', completed_at = :'t0'::timestamptz + interval '2 hours' where id = :'v2';
reset role;
select twd.as_nobody();
select twd.check(twd.ended(:'ray2') = :'t0'::timestamptz + interval '1 hour' and twd.running(:'ray') is null, 'a clock that ends where the person''s later time begins doesn''t go on to travel over it');
select twd.check(twd.ended(:'sam2') is null and (select count(*) = 1 from public.time_entries where user_id = :'sam'), 'paid time is left as it was paid, with no travel added');
select twd.check(twd.ended(:'tess2') = :'t0'::timestamptz + interval '2 hours' and twd.running(:'tess') is null, 'someone whose sign-in is off is clocked out, not put on travel');
update public.memberships set active = true where company_id = :'co' and user_id = :'tess';
delete from public.pay_period_lines where company_id = :'co';
delete from public.time_entries where company_id = :'co';

\o
\echo 'Visits only: finishing a visit stops its clocks'
\o /dev/null
update public.companies set settings = jsonb_set(settings, '{clock,mode}', '"visits"') where id = :'co';
select twd.visit(:'co', 'Hedges', array[:'ray', :'sam']::uuid[]) as v3 \gset
select twd.clock(:'co', :'ray', :'v3', :'t0') as ray3 \gset
select twd.clock(:'co', :'sam', :'v3', :'t0') as sam3 \gset
set local role authenticated;
select twd.as_user(:'ray');
update public.visits set status = 'completed', completed_at = :'t0'::timestamptz + interval '2 hours' where id = :'v3';
reset role;
select twd.as_nobody();
select twd.check(twd.ended(:'sam3') = :'t0'::timestamptz + interval '2 hours' and twd.ended(:'ray3') = twd.ended(:'sam3'), 'everyone''s clock on the visit ends when it was finished');
select twd.check(twd.running(:'ray') is null and twd.running(:'sam') is null and (select count(*) = 2 from public.time_entries where company_id = :'co'), 'and nobody is put on travel');
delete from public.time_entries where company_id = :'co';

\o
\echo 'The reminder and the automatic stop go by the whole day'
\o /dev/null
-- Ray's day: clocked in 11 hours ago (travel), a visit, and travel again since half an hour ago.
insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values
  (:'co', :'ray', 'drive', now() - interval '11 hours', now() - interval '10 hours 30 minutes'),
  (:'co', :'ray', 'visit', now() - interval '10 hours 30 minutes', now() - interval '30 minutes');
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', :'ray', 'drive', now() - interval '30 minutes' + interval '1 millisecond') returning id as ray_now \gset
-- Sam's: clocked in 17 hours ago, on a break for part of it, and travel since 20 minutes ago.
insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values
  (:'co', :'sam', 'visit', now() - interval '17 hours', now() - interval '12 hours'),
  (:'co', :'sam', 'break', now() - interval '12 hours', now() - interval '11 hours 30 minutes'),
  (:'co', :'sam', 'visit', now() - interval '11 hours 30 minutes', now() - interval '20 minutes');
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', :'sam', 'drive', now() - interval '20 minutes') returning id as sam_now \gset
-- Tess stopped for lunch and started again 3 hours ago: her run begins there.
insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values (:'co', :'tess', 'visit', now() - interval '12 hours', now() - interval '4 hours');
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', :'tess', 'visit', now() - interval '3 hours') returning id as tess_now \gset
select twd.check(private.clock_run_start(:'ray_now') = (select min(started_at) from public.time_entries where user_id = :'ray')
  and private.clock_run_start(:'tess_now') = (select started_at from public.time_entries where id = :'tess_now'), 'a run of time goes back through entries that end where the next begins, and no further');

-- Visits only: each clock is measured from its own start, as before.
select public.clock_upkeep() as visits_only \gset
select twd.check((:'visits_only'::jsonb ->> 'reminded')::int = 0 and (:'visits_only'::jsonb ->> 'stopped')::int = 0, 'on visits only a clock half an hour old is left alone, whatever came before it');

update public.companies set settings = jsonb_set(settings, '{clock,mode}', '"day"') where id = :'co';
select public.clock_upkeep() as whole_day \gset
select twd.check((:'whole_day'::jsonb ->> 'reminded')::int = 1 and (:'whole_day'::jsonb ->> 'stopped')::int = 1, 'on the whole-day clock, 11 hours on the clock gets a reminder and 17 hours is stopped');
select twd.check((select count(*) = 1 from public.notifications where user_id = :'ray' and title = 'Your clock is still running' and body like 'On the clock since %, 11 hours ago. Stop it if the day is done.'),
  'the reminder says since when they''ve been on the clock');
select twd.check((select count(*) = 1 from public.notifications where user_id = :'lou' and title = 'Ray Crew''s clock is still running'), 'and their crew lead hears too');
select twd.check((select ended_at > started_at and ended_at <= now() and auto_stopped_at is not null from public.time_entries where id = :'sam_now'),
  'the clock stopped for someone ends after it began and no later than now, marked for the office to check');
select twd.check((select count(*) = 1 from public.notifications where user_id = :'sam' and title = 'Your clock was stopped for you' and body like 'It had been running since %'), 'and they''re told since when it had been running');
select twd.check(twd.ended(:'tess_now') is null and not exists (select 1 from public.notifications where user_id = :'tess' and kind = 'time'), 'someone who stopped and started again is measured from when they started again');
select public.clock_upkeep() as again \gset
select twd.check((:'again'::jsonb ->> 'reminded')::int = 0 and (:'again'::jsonb ->> 'stopped')::int = 0, 'nobody is reminded twice');
-- The next entry of the same day doesn't bring another reminder.
update public.time_entries set ended_at = now() - interval '5 minutes' where id = :'ray_now';
insert into public.time_entries (company_id, user_id, category, started_at) values (:'co', :'ray', 'visit', now() - interval '5 minutes');
select public.clock_upkeep() as next_entry \gset
select twd.check((:'next_entry'::jsonb ->> 'reminded')::int = 0, 'and a day is reminded about once, not once for every visit in it');

rollback;

\o
\echo 'All whole-day clock tests passed.'
