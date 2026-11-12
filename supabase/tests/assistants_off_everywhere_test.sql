-- Database tests for the company's own switch for AI assistants and the owner's view of the team's
-- connections (20261112000530_assistants_off_everywhere.sql). Off: an assistant's token gets nothing
-- from the Data API. Look things up only: it reads, and changes nothing, files included, whatever
-- the person gave it. For someone on two teams the strictest setting holds. Ordinary sign-ins never
-- notice. The server lists a team's connections for its owner and ends one; nobody signed in can.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t530;
grant usage on schema t530 to anon, authenticated, service_role;
create function t530.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement stops with, as "SQLSTATE: message", or 'none'.
create function t530.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
-- Claims as PostgREST and Storage set them, with the request's method and path.
create function t530.as_request(p_user uuid, p_client text, p_method text default 'GET', p_path text default '/clients') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true),
         set_config('request.method', p_method, true),
         set_config('request.path', p_path, true);
$$;
-- What the pre-request hook says to a request: 'none' when it goes through.
create function t530.hook(p_user uuid, p_client text, p_method text, p_path text) returns text language plpgsql as $$
begin
  perform t530.as_request(p_user, p_client, p_method, p_path);
  return t530.error_of('select hooks.before_request()');
end $$;
-- The company's switch, as Settings → AI assistants saves it.
create function t530.set_switch(p_company uuid, p_assistants jsonb) returns void language sql as $$
  update public.companies set settings = settings - 'assistants' || case when p_assistants is null then '{}'::jsonb else jsonb_build_object('assistants', p_assistants) end where id = p_company;
$$;
grant execute on function t530.check(boolean, text), t530.error_of(text), t530.as_request(uuid, text, text, text), t530.hook(uuid, text, text, text) to anon, authenticated, service_role;

-- Nora owns November Lawns, where Otto is in the office and Sid is a sub. Otto also owns Oscar
-- Snow. Pia owns a third business and has nothing to do with either.
\set nora 'b5300000-0000-0000-0000-000000000001'
\set otto 'b5300000-0000-0000-0000-000000000002'
\set sid 'b5300000-0000-0000-0000-000000000003'
\set pia 'b5300000-0000-0000-0000-000000000004'
-- Their assistants (Auth's OAuth clients): Nora's with full access, Otto's with full access, and
-- one Otto connected and never gave anything.
\set claude 'c5300000-0000-0000-0000-00000000000a'
\set chatgpt 'c5300000-0000-0000-0000-00000000000b'
\set editor 'c5300000-0000-0000-0000-00000000000c'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'nora', 'nora@november.test', '{"full_name": "Nora November"}'),
  (:'otto', 'otto@november.test', '{"full_name": "Otto Office"}'),
  (:'sid', 'sid@november.test', '{"full_name": "Sid Sub"}'),
  (:'pia', 'pia@papa.test', '{"full_name": "Pia Papa"}');

begin;
set local role authenticated;
select t530.as_request(:'nora', null, 'POST', '/rpc/create_company');
select public.create_company('November Lawns', 'general') as co \gset
select t530.as_request(:'otto', null, 'POST', '/rpc/create_company');
select public.create_company('Oscar Snow', 'general') as snow \gset
select t530.as_request(:'pia', null, 'POST', '/rpc/create_company');
select public.create_company('Papa Paving', 'general') as papa \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', :'otto', 'office');
insert into public.subcontractors (company_id, name) values (:'co', 'Sid''s Sealcoating') returning id as sub \gset
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sid', 'subcontractor', :'sub');
insert into public.clients (company_id, display_name) values (:'co', 'November client'), (:'snow', 'Snow client');

insert into auth.oauth_clients (id, client_name, logo_uri) values (:'claude', 'Claude', null), (:'chatgpt', 'ChatGPT', 'https://example.test/logo.png'), (:'editor', null, null);
insert into auth.oauth_consents (user_id, client_id, granted_at) values
  (:'nora', :'claude', '2026-11-10 10:00+00'), (:'otto', :'chatgpt', '2026-11-11 10:00+00'), (:'otto', :'editor', '2026-11-09 10:00+00'),
  (:'sid', :'claude', '2026-11-08 10:00+00'), (:'pia', :'claude', '2026-11-07 10:00+00');
insert into auth.sessions (user_id, oauth_client_id) values (:'otto', :'chatgpt'), (:'otto', :'chatgpt'), (:'otto', :'editor'), (:'otto', null), (:'nora', :'claude');
insert into public.assistant_connections (user_id, client_id, level, areas) values (:'nora', :'claude', 'full', '{}'), (:'otto', :'chatgpt', 'full', '{}');

\o
\echo 'The company''s switch for AI assistants'
\o /dev/null

-- ===== On (never set, or set on): as before ====================================================
begin;
set local role authenticated;
select t530.check(t530.hook(:'nora', :'claude', 'GET', '/clients') = 'none', 'never set: an assistant reads');
select t530.check((select count(*) = 1 from public.clients), 'what its person can');
select t530.check(t530.hook(:'nora', :'claude', 'POST', '/clients') = 'none', 'and one with full access changes things');
select t530.check((select public.assistant_switch()) = '{"state": "on"}'::jsonb, 'the switch says on');
rollback;
select t530.set_switch(:'co', '{"enabled": true, "read_only": false}');
begin;
set local role authenticated;
select t530.check(t530.hook(:'nora', :'claude', 'DELETE', '/clients') = 'none', 'set on: the same');
select t530.check(private.assistant_may_change('files', true), 'files too');
rollback;

-- ===== Look things up only =====================================================================
select t530.set_switch(:'co', '{"enabled": true, "read_only": true}');
begin;
set local role authenticated;
select t530.as_request(:'nora', :'claude', 'GET', '/clients');
select hooks.before_request();
select t530.check((select count(*) = 1 from public.clients), 'look things up only: an assistant still reads');
select t530.check(current_setting('transaction_read_only') = 'on', 'in a request that can''t change anything');
rollback;
begin;
set local role authenticated;
select t530.check(t530.hook(:'nora', :'claude', 'POST', '/clients')
  = 'PT403: Assistants can only look things up for November Lawns, not make changes. An owner or admin can change this in Crewtavo, under Settings → AI assistants.',
  'but one with full access changes nothing, and is told who set it');
select t530.check(t530.hook(:'nora', :'claude', 'PATCH', '/invoices') like 'PT403: Assistants can only look things up for November Lawns%', 'not money');
select t530.check(t530.hook(:'nora', :'claude', 'DELETE', '/clients') like 'PT403: Assistants can only look things up for November Lawns%', 'and deletes nothing');
select t530.check(not private.assistant_may_change('clients', false) and not private.assistant_may_change('files', false), 'the guards on tables and files say the same');
select t530.check((select public.assistant_switch()) = jsonb_build_object('state', 'read_only', 'company', 'November Lawns', 'company_id', :'co'), 'the switch says so, and who set it');
rollback;
begin;
set local role authenticated;
select t530.as_request(:'nora', :'claude', 'POST', '/rpc/merge_company_settings');
select hooks.before_request();
select t530.check(current_setting('transaction_read_only') = 'on', 'a function that would write for it answers in a request that can''t');
rollback;
begin;
set local role authenticated;
select t530.as_request(:'nora', null, 'POST', '/clients');
select hooks.before_request();
select t530.check(current_setting('transaction_read_only') = 'off', 'Nora herself changes things as ever');
select t530.check(private.assistant_may_change('files', true), 'files too');
rollback;

-- ===== Off =====================================================================================
select t530.set_switch(:'co', '{"enabled": false, "read_only": false}');
begin;
set local role authenticated;
select t530.check(t530.hook(:'nora', :'claude', 'GET', '/clients')
  = 'PT403: AI assistants are turned off for November Lawns. An owner or admin can turn them on in Crewtavo, under Settings → AI assistants.',
  'off: an assistant with full access reads nothing, and is told who turned them off');
select t530.check(t530.hook(:'nora', :'claude', 'HEAD', '/invoices') like 'PT403: AI assistants are turned off for November Lawns%', 'nothing at all');
select t530.check(t530.hook(:'nora', :'claude', 'POST', '/clients') like 'PT403: AI assistants are turned off for November Lawns%', 'and writes nothing');
select t530.check(t530.hook(:'nora', :'claude', 'POST', '/rpc/merge_clients') like 'PT403: AI assistants are turned off for November Lawns%', 'through a function either');
select t530.check(t530.hook(:'nora', :'claude', 'GET', '/rpc/search_sops') like 'PT403: AI assistants are turned off for November Lawns%', 'not one that only answers');
select t530.check(t530.hook(:'otto', :'editor', 'GET', '/clients') like 'PT403: AI assistants are turned off for November Lawns%', 'one that was never given anything doesn''t read either');
select t530.check(not private.assistant_may_change('files', false), 'no files');
rollback;
begin;
set local role authenticated;
select t530.as_request(:'nora', :'claude', 'GET', '/rpc/assistant_switch');
select hooks.before_request();
select t530.check(current_setting('transaction_read_only') = 'on', 'it may still ask about the switch, and nothing more');
select t530.check((select public.assistant_switch()) = jsonb_build_object('state', 'off', 'company', 'November Lawns', 'company_id', :'co'), 'which says off, and who set it');
rollback;
begin;
set local role authenticated;
select t530.check(t530.hook(:'nora', null, 'GET', '/clients') = 'none' and t530.hook(:'nora', null, 'DELETE', '/clients') = 'none', 'Nora herself is left as she was');
select t530.check((select public.assistant_switch()) = '{"state": "on"}'::jsonb, 'and isn''t an assistant to ask about');
select t530.check(t530.hook(:'pia', :'claude', 'GET', '/clients') = 'none', 'another business''s assistant isn''t touched');
rollback;
-- Off with look-only also ticked is still off.
select t530.set_switch(:'co', '{"enabled": false, "read_only": true}');
begin;
set local role authenticated;
select t530.check(t530.hook(:'nora', :'claude', 'GET', '/clients') like 'PT403: AI assistants are turned off for November Lawns%', 'off comes before look things up only');
rollback;

-- ===== Someone on two teams: the strictest holds ===============================================
-- Otto is in November's office (assistants off) and owns Oscar Snow (never set).
begin;
set local role authenticated;
select t530.check(t530.hook(:'otto', :'chatgpt', 'GET', '/clients') like 'PT403: AI assistants are turned off for November Lawns%',
  'someone on two teams: their assistant is refused while either has them off, and told which');
rollback;
select t530.set_switch(:'co', null);
select t530.set_switch(:'snow', '{"read_only": true}');
begin;
set local role authenticated;
select t530.check(t530.hook(:'otto', :'chatgpt', 'GET', '/clients') = 'none', 'it reads once that one turns them back on');
select t530.check(t530.hook(:'otto', :'chatgpt', 'POST', '/clients') like 'PT403: Assistants can only look things up for Oscar Snow%', 'and changes nothing while the other only lets them look');
select t530.check(t530.hook(:'nora', :'claude', 'POST', '/clients') = 'none', 'Nora, who isn''t in that one, isn''t held to it');
rollback;
select t530.set_switch(:'snow', null);
-- A sub's sign-in doesn't count: an assistant gets nothing through one anyway.
select t530.set_switch(:'papa', '{"enabled": false}');
insert into public.subcontractors (company_id, name) values (:'papa', 'Nora on the side') returning id as side \gset
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'papa', :'nora', 'subcontractor', :'side');
begin;
set local role authenticated;
select t530.check(t530.hook(:'nora', :'claude', 'POST', '/clients') = 'none', 'a business she only subs for doesn''t decide for her assistant');
rollback;
-- Someone no longer on a team isn't held to its switch.
update public.memberships set active = false where company_id = :'papa' and user_id = :'nora';
select t530.set_switch(:'papa', null);

\o
\echo 'The team''s connections, for the owner'
\o /dev/null

-- ===== Who may ask =============================================================================
begin;
set local role authenticated;
select t530.as_request(:'nora', null, 'POST', '/rpc/company_assistant_connections');
select t530.check(t530.error_of(format('select * from public.company_assistant_connections(%L)', :'co')) like '42501:%', 'nobody signed in lists a team''s connections, the owner included: the server does, for them');
select t530.check(t530.error_of(format('select public.end_assistant_connection(%L, %L, %L)', :'co', :'otto', :'chatgpt')) like '42501:%', 'or ends one');
select t530.check((select count(*) = 1 from public.assistant_connections), 'people still see only their own');
rollback;
begin;
set local role anon;
select t530.check(t530.error_of(format('select * from public.company_assistant_connections(%L)', :'co')) like '42501:%', 'a visitor can''t either');
select t530.check(t530.error_of('select public.assistant_switch()') like '42501:%', 'or ask about the switch');
rollback;

-- ===== The list ================================================================================
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
create temp table listed on commit drop as select * from public.company_assistant_connections(:'co');
select t530.check((select count(*) = 3 from listed), 'the server lists the team''s three connections: not the sub''s, not another business''s');
select t530.check((select array_agg(l.full_name || ': ' || coalesce(l.name, '(no name)') order by l.connected_at desc) = array['Otto Office: ChatGPT', 'Nora November: Claude', 'Otto Office: (no name)'] from listed l),
  'newest first, with who connected which');
select t530.check((select l.level = 'full' and l.logo = 'https://example.test/logo.png' and l.connected_at = '2026-11-11 10:00+00' from listed l where l.client_id = :'chatgpt'),
  'what the person let it change, its logo and since when');
select t530.check((select l.level = 'read' and l.areas = '{}' from listed l where l.client_id = :'editor'), 'one never given anything only reads');
select t530.check((select count(*) = 2 and bool_and(c.user_id = :'otto') from public.company_assistant_connections(:'snow') c), 'Otto''s show for his other business too: a connection is the person''s');
rollback;

-- ===== Ending one ==============================================================================
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select t530.check(t530.error_of(format('select public.end_assistant_connection(%L, %L, %L)', :'co', :'pia', :'claude')) like 'P0002:%', 'the server ends nothing for someone who isn''t on the team');
select t530.check(public.end_assistant_connection(:'co', :'otto', :'chatgpt'), 'it ends Otto''s ChatGPT');
select t530.check(not public.end_assistant_connection(:'co', :'otto', :'chatgpt'), 'once');
select t530.check(not public.end_assistant_connection(:'co', :'otto', 'not-an-id'), 'and nothing for an app Auth never knew');
commit;
select t530.check((select count(*) = 0 from public.assistant_connections where user_id = :'otto'), 'what it could change is gone, so a token it still holds only reads');
select t530.check((select revoked_at is not null from auth.oauth_consents where user_id = :'otto' and client_id = :'chatgpt'), 'Auth no longer has Otto''s approval of it');
select t530.check((select count(*) = 0 from auth.sessions where user_id = :'otto' and oauth_client_id = :'chatgpt'), 'or its sign-ins, so it can''t get a new token');
select t530.check((select count(*) = 2 from auth.sessions where user_id = :'otto'), 'Otto''s own sign-in and his other assistant''s are left alone');
select t530.check((select revoked_at is null from auth.oauth_consents where user_id = :'otto' and client_id = :'editor')
  and (select count(*) = 1 from public.assistant_connections where user_id = :'nora'), 'and so is everyone else''s');
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select t530.check((select count(*) = 2 and bool_and(c.client_id <> :'chatgpt') from public.company_assistant_connections(:'co') c), 'it''s off the owner''s list');
rollback;

\o
\echo 'All assistant switch tests passed.'
