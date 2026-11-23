-- Database tests for a person's own ChatGPT plan (20261113001900_chatgpt_plans.sql): a person on
-- the team sees their own connection and nobody else's, and nobody signed in reads or writes the
-- sealed tokens or a sign-in under way; leaving the company, being turned off, or stopping being an
-- owner or admin where the team isn't allowed, ends the connection at once and leaves its tokens for
-- the server to sign out; one server at a time refreshes a person's tokens; and this Crewtavo's id
-- at OpenAI is made once.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_cgp;
grant usage on schema t_cgp to authenticated, anon, service_role;
create sequence t_cgp.passed;
grant usage on sequence t_cgp.passed to authenticated, anon, service_role;
create function t_cgp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  perform nextval('t_cgp.passed');
  raise notice 'ok - %', p_what;
end $$;
create function t_cgp.as_user(p_user uuid, p_client text default null) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true);
$$;
grant execute on all functions in schema t_cgp to authenticated, anon, service_role;

-- Pat owns Poplar Paving, Ada is an admin, Olive is in the office, Cruz is on a crew and Sal signs in
-- as a subcontractor.
\set pat 'c9a70000-0000-0000-0000-000000000001'
\set ada 'c9a70000-0000-0000-0000-000000000002'
\set olive 'c9a70000-0000-0000-0000-000000000003'
\set cruz 'c9a70000-0000-0000-0000-000000000004'
\set sal 'c9a70000-0000-0000-0000-000000000005'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'pat', 'pat@poplar.test', '{"full_name": "Pat Poplar"}'),
  (:'ada', 'ada@poplar.test', '{"full_name": "Ada Admin"}'),
  (:'olive', 'olive@poplar.test', '{"full_name": "Olive Office"}'),
  (:'cruz', 'cruz@poplar.test', '{"full_name": "Cruz Crew"}'),
  (:'sal', 'sal@poplar.test', '{"full_name": "Sal Sub"}');
begin;
set local role authenticated;
select t_cgp.as_user(:'pat');
select public.create_company('Poplar Paving', 'general') as co \gset
commit;
insert into public.memberships (company_id, user_id, role) values (:'co', :'ada', 'admin'), (:'co', :'olive', 'office'), (:'co', :'cruz', 'field_crew');
insert into public.subcontractors (company_id, name) values (:'co', 'Sal''s Striping') returning id as sub \gset
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', :'sub');

-- The server connects Pat's, Ada's and Olive's plans (and, to prove the point, leaves a row for Sal).
insert into public.chatgpt_plans (user_id, company_id, status, client_id, account_email, model) values
  (:'pat', :'co', 'connected', 'oaiapp_pat', 'pat@poplar.test', 'gpt-6.1-sol'),
  (:'ada', :'co', 'connected', 'oaiapp_ada', 'ada@poplar.test', 'gpt-6.1-sol'),
  (:'olive', :'co', 'connected', 'oaiapp_olive', 'olive@poplar.test', 'gpt-6.1-sol'),
  (:'sal', :'co', 'connected', 'oaiapp_sal', 'sal@poplar.test', 'gpt-6.1-sol');
insert into public.chatgpt_plan_secrets (user_id, company_id, ciphertext) values
  (:'pat', :'co', 'v1.sealed-pat'), (:'ada', :'co', 'v1.sealed-ada'), (:'olive', :'co', 'v1.sealed-olive');
insert into public.chatgpt_sign_ins (state, user_id, company_id, ciphertext, expires_at) values
  ('state-state-state-state-pat', :'pat', :'co', 'v1.sealed-attempt', now() + interval '10 minutes');

-- Who sees a connection: its own person, on the team.
begin;
set local role authenticated;
select t_cgp.as_user(:'pat');
select t_cgp.check((select count(*) = 1 and bool_and(user_id = :'pat' and account_email = 'pat@poplar.test' and status = 'connected') from public.chatgpt_plans),
  'the owner sees their own connection, and only their own');
select t_cgp.as_user(:'olive');
select t_cgp.check((select count(*) = 1 and bool_and(user_id = :'olive') from public.chatgpt_plans), 'another member sees theirs, never the owner''s');
select t_cgp.as_user(:'cruz');
select t_cgp.check((select count(*) = 0 from public.chatgpt_plans), 'a member with none sees none');
select t_cgp.as_user(:'sal');
select t_cgp.check((select count(*) = 0 from public.chatgpt_plans), 'a subcontractor''s sign-in sees nothing, not even a row with its name on it');
select t_cgp.as_user(:'pat', 'claude-client-1');
select t_cgp.check((select count(*) = 0 from public.chatgpt_plans), 'an AI assistant acting as the owner sees nothing of it');
rollback;

select t_cgp.check(not has_table_privilege('anon', 'public.chatgpt_plans', 'select'), 'someone signed out reads nothing');
select t_cgp.check(not has_table_privilege('authenticated', 'public.chatgpt_plans', 'insert')
  and not has_table_privilege('authenticated', 'public.chatgpt_plans', 'update')
  and not has_table_privilege('authenticated', 'public.chatgpt_plans', 'delete'),
  'nobody signed in writes a connection: only the server does');
select t_cgp.check(not has_table_privilege('authenticated', 'public.chatgpt_plan_secrets', 'select') and not has_table_privilege('anon', 'public.chatgpt_plan_secrets', 'select')
  and not has_table_privilege('authenticated', 'public.chatgpt_plan_secrets', 'insert') and not has_table_privilege('authenticated', 'public.chatgpt_plan_secrets', 'update'),
  'nobody signed in reads or writes the sealed tokens');
select t_cgp.check(not has_table_privilege('authenticated', 'public.chatgpt_sign_ins', 'select') and not has_table_privilege('anon', 'public.chatgpt_sign_ins', 'select')
  and not has_table_privilege('authenticated', 'public.chatgpt_sign_ins', 'insert') and not has_table_privilege('authenticated', 'public.chatgpt_sign_ins', 'delete'),
  'nor a sign-in under way');
select t_cgp.check((select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'chatgpt_plans' and column_name ~ 'token|secret|cipher'),
  'the connection a person can see has no column a token could be in');
select t_cgp.check(not has_function_privilege('authenticated', 'public.claim_chatgpt_plan_refresh(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.chatgpt_plan_leftovers(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.chatgpt_host_id()', 'execute')
  and not has_function_privilege('anon', 'public.claim_chatgpt_plan_refresh(uuid, uuid)', 'execute'),
  'and the server''s functions are the server''s alone');

-- One server at a time refreshes a person's tokens.
set role service_role;
select t_cgp.check((select public.claim_chatgpt_plan_refresh(:'pat', :'co')) = 'v1.sealed-pat', 'the first server to ask gets the tokens to refresh');
select t_cgp.check((select public.claim_chatgpt_plan_refresh(:'pat', :'co')) is null, 'a second server asking meanwhile gets nothing, and waits');
select t_cgp.check((select public.claim_chatgpt_plan_refresh(:'ada', :'co')) = 'v1.sealed-ada', 'another person''s tokens aren''t held up by it');
update public.chatgpt_plan_secrets set ciphertext = 'v1.sealed-pat-2', refresh_claimed_until = null where user_id = :'pat';
select t_cgp.check((select public.claim_chatgpt_plan_refresh(:'pat', :'co')) = 'v1.sealed-pat-2', 'once the new tokens are saved they can be had again');
update public.chatgpt_plan_secrets set refresh_claimed_until = now() - interval '1 second' where user_id = :'ada';
select t_cgp.check((select public.claim_chatgpt_plan_refresh(:'ada', :'co')) = 'v1.sealed-ada', 'a server that died holding them doesn''t hold them past 30 seconds');
select t_cgp.check((select public.claim_chatgpt_plan_refresh(:'cruz', :'co')) is null, 'someone with no tokens has none to refresh');
update public.chatgpt_plan_secrets set refresh_claimed_until = null;

-- This Crewtavo's id at OpenAI.
select public.chatgpt_host_id() as host \gset
select t_cgp.check(:'host' ~ '^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'this Crewtavo''s id at OpenAI is a urn:uuid');
select t_cgp.check(public.chatgpt_host_id() = :'host' and public.chatgpt_host_id() = :'host', 'and the same every time it''s asked for');
select t_cgp.check((select count(*) = 0 from public.chatgpt_plan_leftovers() where company_id = :'co'), 'tokens with a connected plan aren''t leftovers');
reset role;

-- Stopping being an owner or admin, where the team isn't allowed to connect theirs.
update public.memberships set role = 'office' where company_id = :'co' and user_id = :'ada';
select t_cgp.check((select status = 'disconnected' from public.chatgpt_plans where user_id = :'ada'), 'an admin who becomes office loses their connection while the team isn''t allowed one');
update public.companies set settings = settings || '{"ai": {"team_plans": true}}' where id = :'co';
update public.chatgpt_plans set status = 'connected' where user_id = :'ada';
update public.memberships set role = 'estimator' where company_id = :'co' and user_id = :'ada';
select t_cgp.check((select status = 'connected' from public.chatgpt_plans where user_id = :'ada'), 'but keeps it through a change of role once the company lets the whole team connect theirs');
-- Who changes settings.ai: only someone with the apps area. Bea is an admin whose role doesn't have it.
insert into auth.users (id, email, raw_user_meta_data) values ('c9a70000-0000-0000-0000-000000000006', 'bea@poplar.test', '{"full_name": "Bea Books"}');
\set bea 'c9a70000-0000-0000-0000-000000000006'
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as books_role \gset
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'bea', 'admin', :'books_role');
begin;
set local role authenticated;
select t_cgp.as_user(:'bea');
update public.companies set settings = public.company_settings(id) || '{"ai": {"team_plans": false, "service": "chatgpt"}}' where id = :'co';
reset role;
select t_cgp.check((select settings -> 'ai' = '{"team_plans": true}'::jsonb from public.companies where id = :'co'),
  'an admin without the apps area can''t change which key the AI uses or whether the team may connect their plans');
select t_cgp.check((select status = 'connected' from public.chatgpt_plans where user_id = :'olive'), 'so nobody''s connection ends over it');
set local role authenticated;
select t_cgp.as_user(:'pat');
update public.companies set settings = public.company_settings(id) || '{"ai": {"team_plans": true, "service": "chatgpt"}}' where id = :'co';
reset role;
select t_cgp.check((select settings -> 'ai' ->> 'service' = 'chatgpt' from public.companies where id = :'co'), 'the owner can');
rollback;
delete from public.memberships where company_id = :'co' and user_id = :'bea';
delete from public.company_roles where id = :'books_role';

-- The company stops letting the team connect theirs, by whatever way the setting is changed.
begin;
update public.companies set settings = jsonb_set(settings, '{ai,team_plans}', 'false') where id = :'co';
select t_cgp.check((select array_agg(u.email || ':' || p.status order by u.email) from public.chatgpt_plans p join auth.users u on u.id = p.user_id where p.company_id = :'co' and u.id in (:'pat', :'ada', :'olive'))
  = array['ada@poplar.test:disconnected', 'olive@poplar.test:disconnected', 'pat@poplar.test:connected'],
  'turning it off ends everyone''s connection but the owners'' and admins'', at once');
rollback;

update public.memberships set labor_rate = 31 where company_id = :'co' and user_id = :'olive';
select t_cgp.check((select status = 'connected' from public.chatgpt_plans where user_id = :'olive'), 'a change that isn''t to someone''s role or place on the team touches nothing');

-- Turned off on the Team page, and leaving.
update public.chatgpt_plans set problem = 'usage_limit', problem_at = now(), retry_at = now() + interval '15 minutes' where user_id = :'olive';
update public.memberships set active = false where company_id = :'co' and user_id = :'olive';
select t_cgp.check((select status = 'disconnected' and problem is null and retry_at is null from public.chatgpt_plans where user_id = :'olive'),
  'someone turned off on the Team page loses their connection at once');
set role service_role;
select t_cgp.check((select count(*) = 0 from public.chatgpt_plan_leftovers() where company_id = :'co'),
  'tokens saved a moment ago are left alone: their sign-in may be finishing right now');
update public.chatgpt_plan_secrets set updated_at = now() - interval '5 minutes' where company_id = :'co';
select t_cgp.check((select count(*) = 1 and bool_and(user_id = :'olive' and ciphertext = 'v1.sealed-olive' and client_id = 'oaiapp_olive') from public.chatgpt_plan_leftovers() where company_id = :'co'),
  'after that their tokens wait for the server to sign them out at OpenAI, with the client they were issued to');
reset role;
update public.memberships set active = true where company_id = :'co' and user_id = :'olive';
select t_cgp.check((select status = 'disconnected' from public.chatgpt_plans where user_id = :'olive'), 'turned back on, they sign in again: the connection doesn''t come back by itself');
delete from public.memberships where company_id = :'co' and user_id = :'ada';
select t_cgp.check((select status = 'disconnected' and client_id = 'oaiapp_ada' from public.chatgpt_plans where user_id = :'ada'), 'someone removed from the company loses theirs too');

-- An account that's deleted takes its connection with it; the tokens are left to be signed out.
delete from auth.users where id = :'ada';
select t_cgp.check((select count(*) = 0 from public.chatgpt_plans where user_id = :'ada'), 'a deleted account''s connection goes with it');
set role service_role;
select t_cgp.check((select count(*) = 1 and bool_and(client_id is null) from public.chatgpt_plan_leftovers() where user_id = :'ada'), 'and its tokens are left for the server to delete');
reset role;

-- Left as it was found, for the tests after this one.
delete from public.companies where id = :'co';
select t_cgp.check((select count(*) = 0 from public.chatgpt_plans where company_id = :'co') and (select count(*) = 0 from public.chatgpt_sign_ins where company_id = :'co'),
  'a company that''s deleted takes its people''s connections and sign-ins with it');
delete from public.chatgpt_plan_secrets where company_id = :'co';
delete from auth.users where id in (:'pat', :'olive', :'cruz', :'sal', :'bea');
select last_value as passed from t_cgp.passed \gset
set client_min_messages = warning;
drop schema t_cgp cascade;
reset client_min_messages;

\o
\echo All :passed ChatGPT plan checks passed.
