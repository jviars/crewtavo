-- Database tests for 20261123100900_addresses_an_assistant_added.sql: a client's or contact's email
-- and phone that an AI assistant added or changed are marked so (the server leaves them out of an
-- assistant's own sends), whatever the request says, until anyone else changes them; and a rule that
-- emails or texts clients is turned on, or changed while it's on, by a person.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1123a;
grant usage on schema t1123a to anon, authenticated, service_role;
create function t1123a.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement stops with, as "SQLSTATE: message", or 'none'.
create function t1123a.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
-- Claims as PostgREST sets them: an assistant's carry its client_id.
create function t1123a.as_request(p_user uuid, p_client text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true)
$$;
grant execute on all functions in schema t1123a to anon, authenticated, service_role;

\set owner 'b1123a00-0000-0000-0000-000000000001'
insert into auth.users (id, email, raw_user_meta_data) values (:'owner', 'rae@rae-roofs.test', '{"full_name": "Rae Roofs"}');

begin;
set local role authenticated;
select t1123a.as_request(:'owner', null);
select public.create_company('Rae Roofs', 'general') as co \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Pat Person', 'pat@example.test') returning id as pat \gset
commit;

\set assistant 'c1123a00-0000-0000-0000-00000000000a'
begin;
set local role authenticated;
select t1123a.as_request(:'owner', null);
insert into public.assistant_connections (client_id, level, areas) values (:'assistant', 'full', '{}');
commit;

\o
\echo 'Addresses an assistant put on file'
\o /dev/null

begin;
set local role authenticated;
select t1123a.as_request(:'owner', null);
select t1123a.check(not contact_from_assistant, 'a client the owner adds isn''t marked') from public.clients where id = :'pat';
select t1123a.as_request(:'owner', :'assistant');
insert into public.clients (company_id, display_name, email, contact_from_assistant) values (:'co', 'X', 'drop@attacker.test', false) returning id as x \gset
select t1123a.check(contact_from_assistant, 'a client an assistant adds with an email is marked, whatever it says') from public.clients where id = :'x';
insert into public.clients (company_id, display_name) values (:'co', 'No address') returning id as bare \gset
select t1123a.check(not contact_from_assistant, 'one it adds with no email or phone isn''t') from public.clients where id = :'bare';
update public.clients set email = 'drop@attacker.test' where id = :'pat';
select t1123a.check(contact_from_assistant, 'nor can it move a client''s email to its own and pass it off as theirs') from public.clients where id = :'pat';
update public.clients set notes = 'Called' where id = :'bare';
update public.clients set phone = '540-555-0100', contact_from_assistant = false where id = :'x';
select t1123a.check(contact_from_assistant, 'and it can''t take the mark off') from public.clients where id = :'x';
insert into public.client_contacts (company_id, client_id, name, email, notify_email) values (:'co', :'bare', 'Drop', 'drop2@attacker.test', true) returning id as drop_contact \gset
select t1123a.check(contact_from_assistant, 'a contact an assistant adds with an email is marked') from public.client_contacts where id = :'drop_contact';
-- Someone in Crewtavo changes the address: it's theirs now.
select t1123a.as_request(:'owner', null);
update public.clients set notes = 'Checked', contact_from_assistant = false where id = :'x';
select t1123a.check(contact_from_assistant, 'a person''s other changes leave the mark as it is') from public.clients where id = :'x';
update public.clients set email = 'pat@example.test' where id = :'pat';
select t1123a.check(not contact_from_assistant, 'a person changing the email takes it off') from public.clients where id = :'pat';
update public.client_contacts set email = 'spouse@example.test' where id = :'drop_contact';
select t1123a.check(not contact_from_assistant, 'and the same for a contact') from public.client_contacts where id = :'drop_contact';
update public.clients set contact_from_assistant = true where id = :'pat';
select t1123a.check(not contact_from_assistant, 'nobody puts the mark on by writing it') from public.clients where id = :'pat';
commit;

-- The server (a website form's client, say) adds and changes them unmarked.
insert into public.clients (company_id, display_name, email) values (:'co', 'From the website', 'web@example.test') returning id as web \gset
select t1123a.check(not contact_from_assistant, 'a client the server adds isn''t marked') from public.clients where id = :'web';

\o
\echo 'Rules that email or text clients'
\o /dev/null

begin;
set local role authenticated;
select t1123a.as_request(:'owner', :'assistant');
select t1123a.check(t1123a.error_of(format($q$insert into public.automation_rules (company_id, name, trigger, actions, enabled) values (%L, 'Welcome', 'client.created', '[{"type": "send_email", "subject": "Hi", "body": "Data"}]', true)$q$, :'co'))
    like '42501: A rule that emails or texts clients is turned on, or changed while it''s on, in Crewtavo%', 'an assistant doesn''t make a rule that emails clients turned on');
insert into public.automation_rules (company_id, name, trigger, actions, enabled) values (:'co', 'Welcome', 'client.created', '[{"type": "send_email", "subject": "Hi", "body": "Hello"}]', false) returning id as welcome \gset
select t1123a.check(true, 'but makes it turned off');
select t1123a.check(t1123a.error_of(format('update public.automation_rules set enabled = true where id = %L', :'welcome')) like '42501: A rule that emails or texts clients%', 'and doesn''t turn it on');
select t1123a.check(t1123a.error_of(format($q$insert into public.automation_rules (company_id, name, trigger, actions, enabled) values (%L, 'Texts', 'client.created', '[{"type": "add_note", "body": "New"}, {"type": "send_sms", "body": "Hi"}]', true)$q$, :'co'))
    like '42501:%', 'nor one that texts them among other things');
insert into public.automation_rules (company_id, name, trigger, actions, enabled) values (:'co', 'Note it', 'client.created', '[{"type": "add_note", "body": "New client"}]', true) returning id as note_rule \gset
select t1123a.check((select enabled from public.automation_rules where id = :'note_rule'), 'a rule that sends clients nothing of its own it turns on, as before');
-- The owner turns the welcome on, in Crewtavo.
select t1123a.as_request(:'owner', null);
update public.automation_rules set enabled = true where id = :'welcome';
select t1123a.as_request(:'owner', :'assistant');
select t1123a.check(t1123a.error_of(format($q$update public.automation_rules set actions = '[{"type": "send_email", "subject": "Hi", "body": "Other words"}]' where id = %L$q$, :'welcome'))
    like '42501: A rule that emails or texts clients%', 'an assistant doesn''t change the words of one that''s on');
select t1123a.check(t1123a.error_of(format($q$update public.automation_rules set trigger = 'quote.sent' where id = %L$q$, :'welcome')) like '42501:%', 'or what sets it off');
select t1123a.check(t1123a.error_of(format('update public.automation_rules set name = %L where id = %L', 'Welcome email', :'welcome')) = 'none', 'but renames it');
select t1123a.check(t1123a.error_of(format('update public.automation_rules set enabled = false where id = %L', :'welcome')) = 'none', 'and turns it off');
commit;

\echo 'All tests of addresses an assistant added passed.'
