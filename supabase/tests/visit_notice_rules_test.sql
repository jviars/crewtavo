-- Database tests for 20261113000510_visit_notice_rules.sql: the starter rules that tell a client
-- their visit is booked, moved or cancelled. On for a company made now (with the day-before
-- reminder), off for the companies there were, who answer a note once; texts added where the
-- company can text.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tvr;
grant usage on schema tvr to authenticated, service_role;
create function tvr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tvr.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- Which of a company's starters are on, in name order.
create function tvr.on(p_company uuid) returns text[] language sql security definer as $$
  select coalesce(array_agg(template_key order by template_key), '{}') from public.automation_rules
  where company_id = p_company and enabled and template_key in ('visit_scheduled', 'visit_rescheduled', 'visit_cancelled', 'visit_reminder', 'on_my_way')
$$;
-- A company as the ones made before this were: the three starters added switched off, the
-- reminder off as it used to start, and the note waiting.
create function tvr.as_before(p_company uuid) returns void language plpgsql security definer as $$
begin
  delete from public.automation_rules where company_id = p_company and template_key in ('visit_scheduled', 'visit_rescheduled', 'visit_cancelled');
  update public.automation_rules set enabled = false where company_id = p_company and template_key = 'visit_reminder';
  perform private.install_visit_notice_rules(p_company);
  update public.companies set settings = jsonb_set(coalesce(settings, '{}'), '{visit_notices}', '{"pending": true}') where id = p_company;
end $$;
grant execute on all functions in schema tvr to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('fd510000-0000-0000-0000-000000000001', 'owner@victor.test', '{"full_name": "Vic Owner"}'),
  ('fd510000-0000-0000-0000-000000000002', 'office@victor.test', '{"full_name": "Val Office"}'),
  ('fd510000-0000-0000-0000-000000000003', 'desk@victor.test', '{"full_name": "Dee Desk"}'),
  ('fd510000-0000-0000-0000-000000000004', 'crew@victor.test', '{"full_name": "Cal Crew"}');
\set owner_claims '{"sub": "fd510000-0000-0000-0000-000000000001", "role": "authenticated"}'
\set office_claims '{"sub": "fd510000-0000-0000-0000-000000000002", "role": "authenticated"}'
\set desk_claims '{"sub": "fd510000-0000-0000-0000-000000000003", "role": "authenticated"}'
\set crew_claims '{"sub": "fd510000-0000-0000-0000-000000000004", "role": "authenticated"}'

begin;
set local role authenticated;
select set_config('request.jwt.claims', :'owner_claims', true);
select public.create_company('Victor Lawns', 'general', 'America/Chicago') as co \gset
select public.create_company('Victor Trees', 'general', 'America/Chicago') as co2 \gset
select public.create_company('Victor Snow', 'general', 'America/Chicago') as co3 \gset
commit;
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Front desk', 'office', '{sales,schedule}') returning id as desk_role \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'fd510000-0000-0000-0000-000000000002', 'office', null),
  (:'co', 'fd510000-0000-0000-0000-000000000003', 'office', :'desk_role'),
  (:'co', 'fd510000-0000-0000-0000-000000000004', 'field_crew', null);

\o
\echo 'A company made now'
\o /dev/null
select tvr.check(tvr.on(:'co') = '{visit_cancelled,visit_reminder,visit_rescheduled,visit_scheduled}', 'starts with booked, moved, cancelled and the day-before reminder on, and the on-my-way text off');
select tvr.check((select count(*) = 3 and bool_and(delay_minutes = 0 and conditions = '[]' and jsonb_array_length(actions) = 1 and actions -> 0 ->> 'type' = 'send_email')
  from public.automation_rules where company_id = :'co' and template_key in ('visit_scheduled', 'visit_rescheduled', 'visit_cancelled')), 'each of the three emails the client');
select tvr.check((select trigger = 'visit.scheduled' and actions -> 0 ->> 'body' like '%{{date}}{{time}}%{{link}}%' from public.automation_rules where company_id = :'co' and template_key = 'visit_scheduled')
  and (select trigger = 'visit.rescheduled' and actions -> 0 ->> 'body' like '%{{old.date}}{{old.time}}%{{date}}{{time}}%{{link}}%' from public.automation_rules where company_id = :'co' and template_key = 'visit_rescheduled')
  and (select trigger = 'visit.cancelled' and actions -> 0 ->> 'body' like '%{{date}}{{time}} is cancelled%' from public.automation_rules where company_id = :'co' and template_key = 'visit_cancelled'),
  'saying when the visit is, where a moved one was, and the Hub link');
select tvr.check((select settings -> 'visit_notices' is null from public.companies where id = :'co'), 'and has no note to answer');
select tvr.check((select count(*) = 14 from public.automation_rules where company_id = :'co' and template_key not in ('visit_scheduled', 'visit_rescheduled', 'visit_cancelled')), 'its other starters are as they were');

-- Booking a visit starts the starter.
insert into public.clients (company_id, display_name, email) values (:'co', 'Lee Lawn', 'lee@victor.test') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Mow') returning id as job \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'job', 'Mow', private.company_today(:'co') + 2) returning id as visit \gset
select tvr.check((select count(*) = 1 and bool_and(r.status = 'pending' and u.template_key = 'visit_scheduled')
  from public.automation_runs r join public.automation_rules u on u.id = r.rule_id where r.subject_id = :'visit'), 'a visit booked for its client queues the booked starter');

\o
\echo 'Where the company can text'
\o /dev/null
set role service_role;
select tvr.check(public.texting_starters(:'co2') = 4, 'the server adds a text to each of the three and turns the on-my-way text on');
reset role;
select tvr.check(tvr.on(:'co2') = '{on_my_way,visit_cancelled,visit_reminder,visit_rescheduled,visit_scheduled}', 'so all five are on');
select tvr.check((select count(*) = 3 and bool_and(jsonb_array_length(actions) = 2 and actions -> 0 ->> 'type' = 'send_email' and actions -> 1 ->> 'type' = 'send_sms' and length(actions -> 1 ->> 'body') < 320)
  from public.automation_rules where company_id = :'co2' and template_key in ('visit_scheduled', 'visit_rescheduled', 'visit_cancelled')), 'each emails and then texts');
set role service_role;
select tvr.check(public.texting_starters(:'co2') = 0, 'asking again changes nothing');
reset role;
-- A starter the office already changed, and an on-my-way text it turned off after using it, stay.
update public.automation_rules set actions = '[{"type": "send_email", "subject": "Booked", "body": "Our own words"}, {"type": "add_note", "body": "Told them"}]' where company_id = :'co3' and template_key = 'visit_scheduled';
update public.automation_rules set run_count = 5 where company_id = :'co3' and template_key = 'on_my_way';
set role service_role;
select tvr.check(public.texting_starters(:'co3') = 2, 'a starter the office reworded is left as it wrote it');
reset role;
select tvr.check((select actions -> 0 ->> 'body' = 'Our own words' and jsonb_array_length(actions) = 2 from public.automation_rules where company_id = :'co3' and template_key = 'visit_scheduled')
  and not (select enabled from public.automation_rules where company_id = :'co3' and template_key = 'on_my_way'), 'and an on-my-way text that has run stays how the office left it');
begin;
set local role authenticated;
select set_config('request.jwt.claims', :'owner_claims', true);
select tvr.expect_error(format('select public.texting_starters(%L)', :'co'), 'only the server adds the texts');
commit;

\o
\echo 'A company there already'
\o /dev/null
-- The office's own rule on a booking, and a starter it turned off and one it deleted, to be left alone.
insert into public.automation_rules (company_id, name, trigger, actions, enabled) values (:'co', 'Tell the office', 'visit.scheduled', '[{"type": "notify", "roles": ["office"], "title": "Booked"}]', true) returning id as own_rule \gset
update public.automation_rules set enabled = false where company_id = :'co' and template_key = 'invoice_overdue';
delete from public.automation_rules where company_id = :'co' and template_key = 'quote_followup';
select tvr.as_before(:'co');
select tvr.check(tvr.on(:'co') = '{}', 'gets the three starters switched off, with its reminder as it was');
select tvr.check((select count(*) = 3 from public.automation_rules where company_id = :'co' and template_key in ('visit_scheduled', 'visit_rescheduled', 'visit_cancelled') and not enabled), 'all three are there to turn on');
select tvr.check(private.add_visit_notice_texts(:'co') = 3 and tvr.on(:'co') = '{}', 'one that texts from its own Twilio account gets the text on each, and they stay off');
select tvr.check((select count(*) = 3 and bool_and(actions -> 1 ->> 'type' = 'send_sms' and not enabled) from public.automation_rules where company_id = :'co' and template_key in ('visit_scheduled', 'visit_rescheduled', 'visit_cancelled')),
  'ready to email and text when they''re turned on');
select tvr.check((select enabled from public.automation_rules where id = :'own_rule') and not (select enabled from public.automation_rules where company_id = :'co' and template_key = 'invoice_overdue')
  and not exists (select 1 from public.automation_rules where company_id = :'co' and template_key = 'quote_followup'), 'and nothing else of its rules changes: one it turned off stays off, one it deleted stays deleted');
update public.automation_rules set enabled = true, name = 'Booked, our way' where company_id = :'co' and template_key = 'visit_scheduled';
select private.install_visit_notice_rules(:'co');
select tvr.check((select count(*) = 1 and bool_and(enabled and name = 'Booked, our way') from public.automation_rules where company_id = :'co' and template_key = 'visit_scheduled'), 'adding the starters again changes none that are there');
update public.automation_rules set enabled = false where company_id = :'co' and template_key = 'visit_scheduled';
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'job', 'Mow again', private.company_today(:'co') + 3) returning id as visit2 \gset
select tvr.check((select count(*) = 1 and bool_and(r.rule_id = :'own_rule') from public.automation_runs r where r.subject_id = :'visit2'), 'a booking starts its own rule and tells no client');

\o
\echo 'The note'
\o /dev/null
select tvr.check((select settings -> 'visit_notices' ->> 'pending' = 'true' from public.companies where id = :'co'), 'waits to be answered');
-- A settings page open since before the update saves what it read then: the note stays.
begin;
set local role authenticated;
select set_config('request.jwt.claims', :'owner_claims', true);
update public.companies set settings = public.company_settings(id) - 'visit_notices' || '{"arrival_window_min": 60}' where id = :'co';
commit;
select tvr.check((select settings -> 'visit_notices' ->> 'pending' = 'true' and settings ->> 'arrival_window_min' = '60' from public.companies where id = :'co'), 'a settings page open since before it saves the rest and leaves the note waiting');
begin;
set local role authenticated;
select set_config('request.jwt.claims', :'owner_claims', true);
update public.companies set settings = jsonb_set(public.company_settings(id), '{visit_notices}', '{"pending": false}') where id = :'co';
commit;
select tvr.check((select settings -> 'visit_notices' ->> 'pending' = 'true' from public.companies where id = :'co'), 'and nobody answers it by saving settings');

begin;
set local role authenticated;
select set_config('request.jwt.claims', :'crew_claims', true);
select tvr.expect_error(format('select public.set_visit_notices(%L, true)', :'co'), 'field crew can''t answer it');
select set_config('request.jwt.claims', :'desk_claims', true);
select tvr.expect_error(format('select public.set_visit_notices(%L, true)', :'co'), 'nor can the office without the Automations area');
select set_config('request.jwt.claims', :'office_claims', true);
select tvr.expect_error(format('select public.set_visit_notices(%L, null)', :'co'), 'an answer says yes or no');
select tvr.check(public.set_visit_notices(:'co', true) = 3, 'the office with Automations turns the three on');
commit;
select tvr.check(tvr.on(:'co') = '{visit_cancelled,visit_rescheduled,visit_scheduled}', 'booked, moved and cancelled are on, and the reminder stays as it was');
select tvr.check((select settings -> 'visit_notices' ->> 'pending' = 'false' and settings -> 'visit_notices' ->> 'answered_by' = 'fd510000-0000-0000-0000-000000000002' and settings ->> 'arrival_window_min' = '60'
  from public.companies where id = :'co'), 'the note is answered, by whom, and the other settings are as they were');
select tvr.check((select enabled and name = 'Booked, our way' from public.automation_rules where company_id = :'co' and template_key = 'visit_scheduled'), 'a starter keeps the office''s own wording');

-- The reminder too, and a starter that was deleted comes back to be turned on.
select tvr.as_before(:'co2');
delete from public.automation_rules where company_id = :'co2' and template_key = 'visit_cancelled';
begin;
set local role authenticated;
select set_config('request.jwt.claims', :'owner_claims', true);
select tvr.check(public.set_visit_notices(:'co2', true, true) = 4, 'the three and the reminder are turned on together when asked');
commit;
select tvr.check(tvr.on(:'co2') = '{on_my_way,visit_cancelled,visit_reminder,visit_rescheduled,visit_scheduled}', 'all of them on, a deleted starter back with them');

-- Keep them off.
select tvr.as_before(:'co3');
begin;
set local role authenticated;
select set_config('request.jwt.claims', :'owner_claims', true);
select tvr.check(public.set_visit_notices(:'co3', false, true) = 0, 'keeping them off turns nothing on');
commit;
select tvr.check(tvr.on(:'co3') = '{}' and (select settings -> 'visit_notices' ->> 'pending' = 'false' from public.companies where id = :'co3'), 'and the note doesn''t come back');

delete from public.companies where id in (:'co', :'co2', :'co3');
set client_min_messages = warning;
drop schema tvr cascade;
reset client_min_messages;

\o
\echo 'All visit notice rule tests passed (34 checks).'
