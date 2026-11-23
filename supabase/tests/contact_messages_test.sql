-- Database tests for who gets a client's messages (20261113000300_contact_messages.sql): the
-- company's switch (settings.contact_messages) that only set_contact_messages changes, and only for
-- owners and admins; who a message went to (messages.recipients); and the numbers that texted STOP
-- (sms_stops), which the office reads and only the server writes.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_cm;
grant usage on schema t_cm to authenticated, service_role;
create function t_cm.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_cm.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function t_cm.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on all functions in schema t_cm to authenticated, service_role;

-- Cora owns Cedar Contact Care, Abe is its admin, Oren is in its office and Finn is field crew.
-- Nell owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0a70000-0000-0000-0000-000000000001', 'cora@cedar-contact.test', '{"full_name": "Cora Cedar"}'),
  ('c0a70000-0000-0000-0000-000000000002', 'abe@cedar-contact.test', '{"full_name": "Abe Admin"}'),
  ('c0a70000-0000-0000-0000-000000000003', 'oren@cedar-contact.test', '{"full_name": "Oren Office"}'),
  ('c0a70000-0000-0000-0000-000000000004', 'finn@cedar-contact.test', '{"full_name": "Finn Field"}'),
  ('c0a70000-0000-0000-0000-000000000009', 'nell@north-contact.test', '{"full_name": "Nell North"}');
\set cora 'c0a70000-0000-0000-0000-000000000001'
\set abe 'c0a70000-0000-0000-0000-000000000002'
\set oren 'c0a70000-0000-0000-0000-000000000003'
\set finn 'c0a70000-0000-0000-0000-000000000004'
\set nell 'c0a70000-0000-0000-0000-000000000009'

begin;
set local role authenticated;
select t_cm.as_user(:'nell');
select public.create_company('North Contact Co', 'general') as other \gset
select t_cm.as_user(:'cora');
select public.create_company('Cedar Contact Care', 'general') as co \gset
commit;
begin;
set local role service_role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'abe', 'admin'), (:'co', :'oren', 'office'), (:'co', :'finn', 'field_crew');
commit;
insert into public.clients (company_id, display_name, phone) values (:'co', 'Ada Asked', '(540) 555-0141') returning id as ada \gset

\o
\echo 'The switch'
\o /dev/null

select t_cm.check((select not settings ? 'contact_messages' from public.companies where id = :'co'),
  'a new company has nothing saved, which reads as on');

-- A company from before the update: the migration left it off and still to be decided.
update public.companies set settings = jsonb_set(settings, '{contact_messages}', '{"enabled": false, "pending": true}') where id = :'co';

begin;
set local role authenticated;
select t_cm.as_user(:'cora');
-- A page open since before the update saves the settings it read then, without the switch.
update public.companies set settings = (public.company_settings(id) - 'contact_messages') || '{"payment_terms_days": 21}' where id = :'co';
select t_cm.check((select public.company_settings(id) -> 'contact_messages' = '{"enabled": false, "pending": true}' and public.company_settings(id) ->> 'payment_terms_days' = '21' from public.companies where id = :'co'),
  'a page saving old settings doesn''t take the switch away, and the rest of what it saved is saved');
update public.companies set settings = jsonb_set(public.company_settings(id), '{contact_messages}', '{"enabled": true}') where id = :'co';
select public.merge_company_settings(:'co', '{"contact_messages": {"enabled": true}}');
select t_cm.check((select public.company_settings(id) -> 'contact_messages' = '{"enabled": false, "pending": true}' from public.companies where id = :'co'),
  'nor does saving the company turn it on');
select t_cm.check(public.set_contact_messages(:'co', true), 'the owner turns it on');
select t_cm.check((select (public.company_settings(id) -> 'contact_messages' ->> 'enabled')::boolean and not (public.company_settings(id) -> 'contact_messages' ->> 'pending')::boolean
  and public.company_settings(id) -> 'contact_messages' ->> 'changed_by' = :'cora' and public.company_settings(id) ->> 'payment_terms_days' = '21' from public.companies where id = :'co'),
  'which settles it, says who did, and leaves the other settings alone');
select t_cm.as_user(:'abe');
select t_cm.check(not public.set_contact_messages(:'co', false), 'an admin turns it off');
select t_cm.check((select public.company_settings(id) -> 'contact_messages' ->> 'enabled' = 'false' and public.company_settings(id) -> 'contact_messages' ->> 'pending' = 'false' from public.companies where id = :'co'),
  'and off by choice isn''t asked about again');
select t_cm.expect_error(format('select public.set_contact_messages(%L, null)', :'co'), 'it''s on or off');
commit;

begin;
set local role authenticated;
select t_cm.as_user(:'oren');
select t_cm.expect_error(format('select public.set_contact_messages(%L, true)', :'co'), 'the office can''t change it');
select t_cm.as_user(:'nell');
select t_cm.expect_error(format('select public.set_contact_messages(%L, true)', :'co'), 'nor another business');
select t_cm.check(not has_function_privilege('anon', 'public.set_contact_messages(uuid, boolean)', 'execute'), 'nor anyone signed out');
rollback;
select t_cm.check((select settings -> 'contact_messages' ->> 'enabled' = 'false' from public.companies where id = :'co'), 'and it stays as the admin left it');

-- The server (a migration, a repair) still writes it.
update public.companies set settings = jsonb_set(settings, '{contact_messages}', '{"enabled": true, "pending": false}') where id = :'co';
select t_cm.check((select settings -> 'contact_messages' = '{"enabled": true, "pending": false}' from public.companies where id = :'co'), 'the server writes it');

\o
\echo 'Who a message went to'
\o /dev/null

begin;
set local role authenticated;
select t_cm.as_user(:'oren');
insert into public.messages (company_id, client_id, channel, direction, body, recipients)
values (:'co', :'ada', 'email', 'out', 'Your invoice', '[{"to": "ada@example.com", "name": "Ada Asked"}, {"to": "mo@example.com", "name": "Mo Manager", "failed": true}]');
select t_cm.check((select jsonb_array_length(recipients) = 2 from public.messages where company_id = :'co' and client_id = :'ada'), 'a message keeps who it went to');
select t_cm.expect_error(format($q$insert into public.messages (company_id, client_id, channel, direction, body, recipients) values (%L, %L, 'email', 'out', 'x', '{"to": "ada@example.com"}')$q$, :'co', :'ada'),
  'as a list');
insert into public.messages (company_id, client_id, channel, direction, status, body, from_phone, from_name)
values (:'co', :'ada', 'sms', 'in', 'received', 'Running late', '+15405550122', 'Mo Manager');
select t_cm.check((select from_name = 'Mo Manager' from public.messages where company_id = :'co' and direction = 'in'), 'and a text that came in keeps whose phone it came from');
commit;

\o
\echo 'Numbers that texted STOP'
\o /dev/null

-- The webhook (the server) records a STOP.
insert into public.sms_stops (company_id, phone_key, phone) values (:'co', '5405550122', '+15405550122'), (:'other', '5405550199', '+15405550199');
select t_cm.expect_error(format($q$insert into public.sms_stops (company_id, phone_key, phone) values (%L, '+15405550122', '+15405550122')$q$, :'co'), 'a number is kept by its last 10 digits');
select t_cm.expect_error(format($q$insert into public.sms_stops (company_id, phone_key, phone) values (%L, '5405550122', '(540) 555-0122')$q$, :'co'), 'once for a company');

begin;
set local role authenticated;
select t_cm.as_user(:'oren');
select t_cm.check((select count(*) = 1 and bool_and(phone_key = '5405550122') from public.sms_stops), 'the office reads its own company''s');
select t_cm.expect_error(format($q$insert into public.sms_stops (company_id, phone_key, phone) values (%L, '5405550133', '+15405550133')$q$, :'co'), 'and can''t add one');
select t_cm.expect_error('delete from public.sms_stops', 'or take one back: a STOP is the person''s own');
select t_cm.expect_error($q$update public.sms_stops set phone_key = '5405550100'$q$, 'or change one');
select t_cm.as_user(:'finn');
select t_cm.check((select count(*) = 0 from public.sms_stops), 'field crew don''t read them');
select t_cm.as_user(:'nell');
select t_cm.check((select count(*) = 1 and bool_and(phone_key = '5405550199') from public.sms_stops), 'another business reads only its own');
rollback;
select t_cm.check((select count(*) = 1 from public.sms_stops where company_id = :'co'), 'and the list is as the server left it');

-- Left as it was found, for the tests after this one.
delete from public.companies where id in (:'co', :'other');
select t_cm.check((select count(*) = 0 from public.sms_stops where company_id in (:'co', :'other')), 'a company''s stops go with it');
set client_min_messages = warning;
drop schema t_cm cascade;
reset client_min_messages;

\o
\echo 'All contact messages tests passed.'
