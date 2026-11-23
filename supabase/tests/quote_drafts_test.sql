-- Database tests for 20261113001110_quote_drafts.sql: "Draft quotes with Claude" (settings.quote_ai)
-- is the server's to turn on, after it checks the key with Claude: a page saving the company's
-- settings can't turn it on or off, and the other quote settings save as usual.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tqd;
grant usage on schema tqd to authenticated, service_role;
create function tqd.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tqd.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tqd to authenticated, service_role;

\set val 'a5c30000-0000-0000-0000-000000000001'

begin;
insert into auth.users (id, email, raw_user_meta_data) values (:'val', 'val@vista.test', '{"full_name": "Val Vista"}');
set local role authenticated;
select tqd.as_user(:'val');
select public.create_company('Vista Pools', 'general') as co \gset
select public.merge_company_settings(:'co', '{"quote_ai": {"on": true}, "quotes": {"draft_requests": true}}');
reset role;
select tqd.check((select settings -> 'quote_ai' is null and settings -> 'quotes' -> 'draft_requests' = 'true' from public.companies where id = :'co'),
  'the owner saving settings can''t turn Claude on for drafts, and the other quote settings save');

-- The server: nobody signed in.
select set_config('request.jwt.claims', '', true);
set local role service_role;
select tqd.check((public.set_quote_ai(:'co', true, :'val')) ->> 'on' = 'true', 'the server turns it on once Claude answered');
reset role;

set local role authenticated;
select tqd.as_user(:'val');
select public.merge_company_settings(:'co', '{"quote_ai": {"on": false}, "quotes": {"alert_over": 5000}}');
update public.companies set settings = public.company_settings(id) - 'quote_ai' where id = :'co';
reset role;
select tqd.check((select settings -> 'quote_ai' ->> 'on' = 'true' and settings -> 'quote_ai' ->> 'checked_by' = :'val'
                         and settings -> 'quotes' = '{"alert_over": 5000, "draft_requests": true}' from public.companies where id = :'co'),
  'nor turn it off or remove it from a page: only the server''s switch does');
select tqd.check(not has_function_privilege('authenticated', 'public.set_quote_ai(uuid, boolean, uuid)', 'execute'), 'only the server calls set_quote_ai');

-- What a draft keeps for the office is the office's: never read by the Client Hub, which names its columns.
select tqd.check((select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'drafted'), 'quotes keep how they were drafted');

-- ===== A draft made by itself leaves its request alone (20261113001650_drafts_leave_requests.sql) =====
insert into public.clients (company_id, display_name) values (:'co', 'Remy Request') returning id as remy \gset
insert into public.requests (company_id, client_id, title) values (:'co', :'remy', 'Pool opening') returning id as req \gset
insert into public.requests (company_id, client_id, title, status) values (:'co', :'remy', 'Booked online', 'assessment_scheduled') returning id as booked \gset
insert into public.requests (company_id, client_id, title, status) values (:'co', :'remy', 'Old one', 'archived') returning id as archived \gset
insert into public.requests (company_id, client_id, title) values (:'co', :'remy', 'By hand') returning id as by_hand \gset
insert into public.quotes (company_id, client_id, request_id, title, drafted) values (:'co', :'remy', :'req', 'Pool opening', '{"by": "price_list", "auto": true}') returning id as q_req \gset
insert into public.quotes (company_id, client_id, request_id, title, drafted) values (:'co', :'remy', :'booked', 'Booked online', '{"by": "claude", "auto": true}') returning id as q_booked \gset
insert into public.quotes (company_id, client_id, request_id, title, drafted) values (:'co', :'remy', :'archived', 'Old one', '{"by": "claude", "auto": true}') returning id as q_archived \gset
insert into public.quotes (company_id, client_id, request_id, title, drafted) values (:'co', :'remy', :'by_hand', 'By hand', '{"by": "price_list"}') returning id as q_by_hand \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price)
select :'co', q.id, 'Opening', 250 from public.quotes q where q.id in (:'q_req', :'q_booked', :'q_archived', :'q_by_hand');
update public.quotes set title = 'Pool opening, spring' where id = :'q_req';
select tqd.check((select status = 'new' from public.requests where id = :'req') and (select status = 'assessment_scheduled' from public.requests where id = :'booked'),
  'while a draft made by itself sits, and is edited, its request is as it came in: new, or booked for its assessment');
update public.quotes set status = 'sent', sent_at = now() where id in (:'q_req', :'q_archived', :'q_by_hand');
update public.quotes set status = 'approved', approved_at = now() where id = :'q_booked';
select tqd.check((select status = 'quoted' from public.requests where id = :'req') and (select status = 'quoted' from public.requests where id = :'booked'),
  'sending that quote, or approving it, marks the request Quoted');
select tqd.check((select status = 'archived' from public.requests where id = :'archived'), 'an archived request stays archived');
select tqd.check((select status = 'new' from public.requests where id = :'by_hand'), 'a quote a person drafted changes nothing here: the server marked its request as they pressed the button');
rollback;

\echo 'All quote draft tests passed.'
