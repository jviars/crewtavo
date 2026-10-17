-- Database tests for schedule-change notifications and delivery settings: people on a visit hear
-- when they're added, taken off, moved or cancelled; changes fold into one notification; nobody is
-- told about their own change or about old work; preferences and push devices are private.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t11;
grant usage on schema t11 to authenticated, service_role;
create function t11.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t11.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t11 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('ab000000-0000-0000-0000-000000000001', 'owner@kilo.test', '{"full_name": "Kim Owner"}'),
  ('ab000000-0000-0000-0000-000000000002', 'lead@kilo.test', '{"full_name": "Lee Lead"}'),
  ('ab000000-0000-0000-0000-000000000003', 'mae@kilo.test', '{"full_name": "Mae Member"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Kilo Paving', 'paving') as co \gset
update public.companies set timezone = 'America/New_York' where id = :'co';
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'ab000000-0000-0000-0000-000000000002', 'crew_lead'),
  (:'co', 'ab000000-0000-0000-0000-000000000003', 'field_crew');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Paving', 'ab000000-0000-0000-0000-000000000002') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'ab000000-0000-0000-0000-000000000003');
insert into public.visits (company_id, title, kind, crew_id, starts_at, ends_at) values (:'co', 'Driveway overlay', 'task', :'crew', date_trunc('day', now()) + interval '3 days 12 hours', date_trunc('day', now()) + interval '3 days 18 hours') returning id as visit \gset
insert into public.visits (company_id, title, kind, crew_id, starts_at, ends_at) values (:'co', 'Old job', 'task', :'crew', now() - interval '10 days', now() - interval '10 days' + interval '2 hours') returning id as old_visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'ab000000-0000-0000-0000-000000000003'), (:'co', :'old_visit', 'ab000000-0000-0000-0000-000000000003');
commit;

select t11.check((select count(*) from public.notifications where user_id = 'ab000000-0000-0000-0000-000000000003') = 1, 'being put on an upcoming visit notifies you (old work doesn''t)');
select t11.check((select title like 'You''re on Driveway overlay: %' and link = '/field/visits/' || :'visit' from public.notifications where user_id = 'ab000000-0000-0000-0000-000000000003'), 'it says which visit and when, and links to it');

-- The owner moves it: the change joins the unread notification.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.visits set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = :'visit';
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'ab000000-0000-0000-0000-000000000002');
commit;
select t11.check((select count(*) from public.notifications where user_id = 'ab000000-0000-0000-0000-000000000003') = 1, 'changes within minutes fold into one notification');
select t11.check((select title = '2 changes to your schedule' and body like '%moved to % (was %' from public.notifications where user_id = 'ab000000-0000-0000-0000-000000000003'), 'listing each change');

-- The lead changes the start time on their crew's visit: Mae hears about it, the lead doesn't.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.visits set starts_at = starts_at + interval '2 hours', ends_at = ends_at + interval '2 hours' where id = :'visit';
commit;
select t11.check((select body like '%now starts%' from public.notifications where user_id = 'ab000000-0000-0000-0000-000000000003'), 'a new start time on the same day says so');
select t11.check((select count(*) from public.notifications where user_id = 'ab000000-0000-0000-0000-000000000002' and body like '%now starts%') = 0, 'nobody is told about a change they made');

-- Once Mae has read it, the next change starts a new notification.
update public.notifications set read_at = now() where user_id = 'ab000000-0000-0000-0000-000000000003';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.visits set status = 'cancelled' where id = :'visit';
update public.visits set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = :'old_visit';
commit;
select t11.check((select count(*) from public.notifications where user_id = 'ab000000-0000-0000-0000-000000000003' and read_at is null) = 1, 'after reading, a change starts a new notification');
select t11.check((select body like 'Driveway overlay on % was cancelled' from public.notifications where user_id = 'ab000000-0000-0000-0000-000000000003' and read_at is null), 'cancelling tells the crew');

-- Delivery: claimed once, after the folding window.
select t11.check((select count(*) from public.claim_notifications(3600)) = 0, 'brand-new notifications wait so changes can fold together');
select count(*) as claimed from public.claim_notifications(0) \gset
select t11.check(:'claimed'::int >= 2, 'then each is claimed for delivery');
select t11.check((select count(*) from public.claim_notifications(0)) = 0, 'and only once');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t11.expect_error('select public.claim_notifications(0)', 'people can''t claim deliveries');

-- Preferences and push devices are each person's own.
insert into public.notification_prefs (company_id, user_id, email, sms, push) values (:'co', 'ab000000-0000-0000-0000-000000000003', '{schedule,time}', '{schedule}', '{}');
select t11.expect_error(format('insert into public.notification_prefs (company_id, user_id) values (%L, %L)', :'co', 'ab000000-0000-0000-0000-000000000002'), 'you can''t set someone else''s preferences');
select t11.expect_error(format('update public.notification_prefs set email = %L where user_id = %L', '{marketing}', 'ab000000-0000-0000-0000-000000000003'), 'only known kinds of notification');
insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example.com/abc', 'key', 'secret');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t11.check((select count(*) from public.notification_prefs) = 0, 'others can''t read your preferences');
select t11.check((select count(*) from public.push_subscriptions) = 0, 'or your push devices');
select t11.expect_error('select * from public.app_secrets', 'server keys are never readable');
commit;

-- Deleting an upcoming visit tells the people on it.
update public.visits set status = 'scheduled' where id = :'visit';
update public.notifications set read_at = now();
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.visits where id = :'visit';
commit;
select t11.check((select count(*) from public.notifications where read_at is null and body like 'Driveway overlay on % was cancelled' and link = '/field') = 2, 'deleting a visit tells everyone on it');

-- Deleting the company still works (no notifications for a company that's going away).
delete from public.companies where id = :'co';
select t11.check((select count(*) from public.notifications where company_id = :'co') = 0, 'a company can still be deleted');

\echo 'All notification tests passed.'
