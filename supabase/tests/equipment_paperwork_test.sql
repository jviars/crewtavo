-- Database tests for equipment paperwork (tags and inspection): who keeps it, how many days are
-- left, renewing it into the history, and reminders going out once each.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tep;
grant usage on schema tep to authenticated, service_role;
create function tep.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tep.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tep to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e9e90000-0000-0000-0000-000000000001', 'owner@juliet.test', '{"full_name": "Jo Owner"}'),
  ('e9e90000-0000-0000-0000-000000000002', 'crew@juliet.test', '{"full_name": "Jay Crew"}'),
  ('e9e90000-0000-0000-0000-000000000003', 'other@kilo.test', '{"full_name": "Kim Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e9e90000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Juliet Lawns', 'landscaping') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'e9e90000-0000-0000-0000-000000000002', 'field_crew');
commit;

-- Reminders go out from 8 in the morning where the company is: put it where it's about noon now.
update public.companies set timezone = 'Etc/GMT' || case when 12 - extract(hour from now() at time zone 'UTC')::int >= 0 then '-' else '+' end
  || abs(12 - extract(hour from now() at time zone 'UTC')::int) where id = :'co';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e9e90000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.equipment (company_id, name, kind, meter, meter_reading) values (:'co', 'Truck 2', 'truck', 'miles', 52000) returning id as truck \gset
insert into public.equipment (company_id, name, kind, meter) values (:'co', 'Utility trailer', 'trailer', 'none') returning id as trailer \gset
insert into public.equipment_documents (company_id, equipment_id, kind, expires_on) values
  (:'co', :'truck', 'registration', private.company_today(:'co') + 20) returning id as reg \gset
insert into public.equipment_documents (company_id, equipment_id, kind, expires_on) values
  (:'co', :'truck', 'inspection', private.company_today(:'co') - 3) returning id as insp \gset
insert into public.equipment_documents (company_id, equipment_id, kind, expires_on) values (:'co', :'trailer', 'registration', null);
select tep.check((select days_left = 20 and state = 'due_soon' from public.equipment_paperwork where id = :'reg'), 'tags 20 days out are coming due');
select tep.check((select days_left = -3 and state = 'overdue' from public.equipment_paperwork where id = :'insp'), 'a sticker past its date has run out');
select tep.check((select state = 'ok' and days_left is null from public.equipment_paperwork where equipment_id = :'trailer'), 'a permanent plate never comes due');
select tep.expect_error(format('insert into public.equipment_documents (company_id, equipment_id, kind) values (%L, %L, %L)', :'co', :'truck', 'registration'), 'one registration per machine');
select tep.expect_error(format('insert into public.equipment_documents (company_id, equipment_id, kind) values (%L, %L, %L)', :'co', :'truck', 'other'), 'something else needs a name');
insert into public.equipment_documents (company_id, equipment_id, kind, name, expires_on) values (:'co', :'truck', 'other', 'Fire extinguisher tag', private.company_today(:'co') + 200);
commit;

-- Field crew see it but can't change it or renew it.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e9e90000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tep.check((select count(*) from public.equipment_paperwork where company_id = :'co') = 4, 'crew see the paperwork');
update public.equipment_documents set expires_on = '2099-01-01' where id = :'reg';
select tep.check((select expires_on <> '2099-01-01' from public.equipment_documents where id = :'reg'), 'but can''t change the date');
select tep.expect_error(format('select public.renew_equipment_document(%L, %L)', :'reg', '2099-01-01'), 'or renew it');
commit;

-- Reminders: once per stage, to the people who look after equipment.
select public.emit_equipment_document_alerts() as sent \gset
select tep.check(:'sent'::int = 2, 'the coming-due tags and the expired sticker each send one reminder');
select tep.check((select count(*) from public.notifications where kind = 'equipment' and user_id = 'e9e90000-0000-0000-0000-000000000001') = 2, 'the owner hears about both');
select tep.check((select count(*) from public.notifications where kind = 'equipment' and user_id = 'e9e90000-0000-0000-0000-000000000002') = 0, 'field crew don''t');
select tep.check(exists (select 1 from public.notifications where kind = 'equipment' and title = 'Truck 2''s safety inspection ran out'), 'the reminder says what ran out');
select public.emit_equipment_document_alerts() as again \gset
select tep.check(:'again'::int = 0, 'running again sends nothing new');
update public.equipment_documents set expires_on = expires_on + 1 where id = :'reg';
select tep.check((select alerted_state = 'd30' from public.equipment_documents where id = :'reg'), 'a day''s fix to the date stays quiet');

-- Renewing: the new date, a line in the history, and reminders start over.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e9e90000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.renew_equipment_document(:'insp', '2027-11-30', 'Passed at Main St Garage') as log \gset
select tep.check((select expires_on = '2027-11-30' and alerted_state is null from public.equipment_documents where id = :'insp'), 'renewing sets the new date and clears the reminders');
select tep.check((select kind = 'service' and title = 'Safety inspection renewed, good through Nov 30, 2027' and notes = 'Passed at Main St Garage'
  and user_id = 'e9e90000-0000-0000-0000-000000000001' and meter_reading = 52000 from public.equipment_logs where id = :'log'), 'and logs it in the history with the odometer');
commit;

-- Retired equipment drops out; another company sees nothing.
update public.equipment set status = 'retired' where id = :'trailer';
select tep.check((select count(*) from public.equipment_paperwork where equipment_id = :'trailer') = 0, 'retired equipment has no paperwork due');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e9e90000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.create_company('Kilo Pools', 'landscaping') as other \gset
select tep.check((select count(*) from public.equipment_paperwork) = 0 and (select count(*) from public.equipment_documents) = 0, 'other companies can''t see it');
select tep.expect_error(format('insert into public.equipment_documents (company_id, equipment_id, kind) values (%L, %L, %L)', :'other', :'truck', 'emissions'), 'or add to it');
select tep.expect_error('select public.emit_equipment_document_alerts()', 'people can''t send reminders themselves');
commit;

\echo 'All equipment paperwork tests passed.'
