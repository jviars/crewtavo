-- Database tests for Quo (20261126100100_quo.sql): only the server says a message came from Quo or
-- what a call was, a call is on a client's timeline once, a call from a number nobody knows moves
-- onto the client's timeline as a call when the number is attached, and the server's own records
-- of Quo's deliveries and sent texts aren't anyone else's to read.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_quo;
grant usage on schema t_quo to authenticated, service_role;
create function t_quo.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_quo.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function t_quo.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on all functions in schema t_quo to authenticated, service_role;

-- Quinn owns Quill Painting and Ola works in its office.
insert into auth.users (id, email, raw_user_meta_data) values
  ('0a0a0000-0000-0000-0000-000000000001', 'quinn@quill-quo.test', '{"full_name": "Quinn Quill"}'),
  ('0a0a0000-0000-0000-0000-000000000002', 'ola@quill-quo.test', '{"full_name": "Ola Office"}');
\set quinn '0a0a0000-0000-0000-0000-000000000001'
\set ola '0a0a0000-0000-0000-0000-000000000002'

begin;
set local role authenticated;
select t_quo.as_user(:'quinn');
select public.create_company('Quill Painting', 'general') as co \gset
commit;
begin;
set local role service_role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'ola', 'office');
commit;
insert into public.clients (company_id, display_name, phone) values (:'co', 'Ana Alvarez', '(540) 555-0163') returning id as ana \gset

\o
\echo 'Only the server says where a message came from'
\o /dev/null

begin;
set local role authenticated;
select t_quo.as_user(:'ola');
insert into public.messages (company_id, client_id, channel, direction, body, origin, call)
  values (:'co', :'ana', 'note', 'internal', 'A note dressed up', 'quo', '{"outcome": "answered", "seconds": 60}') returning id as note \gset
select t_quo.check((select origin is null and call is null from public.messages where id = :'note'), 'a message written from the browser isn''t marked as from Quo, and has no call details');
update public.messages set origin = 'quo_import', call = '{"outcome": "missed"}', body = 'Edited note' where id = :'note';
select t_quo.check((select origin is null and call is null and body = 'Edited note' from public.messages where id = :'note'), 'and can''t be marked so later, while the rest of it can change');
rollback;

-- The server files a call (as Quo reports it), and a text sent from the Quo app.
insert into public.messages (company_id, client_id, channel, direction, status, body, external_id, sent_by, origin, call)
  values (:'co', :'ana', 'call', 'in', 'received', 'Call · 4 min', 'ACcall1', null, 'quo', '{"outcome": "answered", "seconds": 240, "quo_id": "ACcall1"}');
select t_quo.check((select origin = 'quo' and call->>'outcome' = 'answered' from public.messages where external_id = 'ACcall1'), 'the server files a call with its details');
select t_quo.expect_error(format($q$insert into public.messages (company_id, client_id, channel, direction, status, body, external_id, origin) values (%L, %L, 'call', 'in', 'received', 'Again', 'ACcall1', 'quo')$q$, :'co', :'ana'),
  'a call is on a client''s timeline once');
insert into public.messages (company_id, client_id, channel, direction, status, body, external_id, origin)
  values (:'co', :'ana', 'sms', 'out', 'delivered', 'Running late', 'ACtext1', 'quo'), (:'co', :'ana', 'sms', 'out', 'delivered', 'Running late', 'ACtext1', 'quo_import');
select t_quo.check((select count(*) = 2 from public.messages where external_id = 'ACtext1'), 'a text can be filed under the same id more than once (one per client it went to)');
select t_quo.expect_error(format($q$insert into public.messages (company_id, client_id, channel, direction, body, origin) values (%L, %L, 'sms', 'out', 'x', 'twilio')$q$, :'co', :'ana'),
  'origin is Quo''s or nothing');

begin;
set local role authenticated;
select t_quo.as_user(:'ola');
select t_quo.check((select count(*) = 1 from public.messages where external_id = 'ACcall1' and call->>'seconds' = '240'), 'the office reads the call and its details');
rollback;

\o
\echo 'Calls from numbers nobody knows'
\o /dev/null

insert into public.unknown_texts (company_id, from_phone, phone_key, body, external_id, channel, call, created_at) values
  (:'co', '+15405550199', '5405550199', 'Voicemail · 18 sec', 'ACvm', 'call', '{"outcome": "voicemail", "seconds": 18, "voicemail": "Hi, about a quote", "quo_id": "ACvm"}', now() - interval '1 hour'),
  (:'co', '+15405550199', '5405550199', 'Are you free next week?', 'ACt', 'sms', null, now());
select t_quo.expect_error(format($q$insert into public.unknown_texts (company_id, from_phone, phone_key, body, external_id, channel) values (%L, '+15405550199', '5405550199', 'Again', 'ACvm', 'call')$q$, :'co'),
  'a call waits under Unknown numbers once');
select t_quo.expect_error(format($q$insert into public.unknown_texts (company_id, from_phone, phone_key, body, channel) values (%L, '+15405550199', '5405550199', 'x', 'email')$q$, :'co'),
  'and is a text or a call');
select t_quo.check((select channel = 'sms' from public.unknown_texts where external_id = 'ACt'), 'a text from an unknown number is a text, as before');

begin;
set local role authenticated;
select t_quo.as_user(:'ola');
select public.attach_unknown_texts(:'co', '+15405550199', :'ana', 'contact', 'Ben Alvarez') as moved \gset
select t_quo.check(:moved = 2, 'attaching the number moves its call and its text');
select t_quo.check((select channel = 'call' and origin = 'quo' and call->>'voicemail' = 'Hi, about a quote' and from_name = 'Ben Alvarez' and direction = 'in'
  from public.messages where external_id = 'ACvm'), 'the call goes on the client''s timeline as a call, with its voicemail');
select t_quo.check((select channel = 'sms' and origin is null and call is null from public.messages where external_id = 'ACt'), 'and the text as a text');
commit;

\o
\echo 'The server''s own records'
\o /dev/null

insert into public.quo_events (company_id, event_id) values (:'co', 'msg_1');
select t_quo.expect_error(format($q$insert into public.quo_events (company_id, event_id) values (%L, 'msg_1')$q$, :'co'), 'a delivery from Quo is handled once');
insert into public.quo_sent (company_id, message_id) values (:'co', 'ACsent');
begin;
set local role authenticated;
select t_quo.as_user(:'quinn');
select t_quo.expect_error($q$select count(*) from public.quo_events$q$, 'nobody signed in reads which deliveries came');
select t_quo.expect_error($q$select count(*) from public.quo_sent$q$, 'or which texts went out through Quo');
rollback;

-- Left as it was found, for the tests after this one.
delete from public.companies where id = :'co';
select t_quo.check((select count(*) = 0 from public.quo_events) and (select count(*) = 0 from public.quo_sent), 'and they go with the business');
set client_min_messages = warning;
drop schema t_quo cascade;
