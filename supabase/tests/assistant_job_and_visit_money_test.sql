-- Database tests for 20261123100800_assistant_job_and_visit_money.sql: to an AI assistant, what a
-- visit bills, a job's retainage and a new job's billing go with Prices, and a job's autopay with
-- Invoices, as how a job is billed already did. A job made the plain way needs only Jobs, a quote
-- turned into a job goes by its own function's area, and ordinary sign-ins are unaffected.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1123m;
grant usage on schema t1123m to anon, authenticated, service_role;
create function t1123m.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement stops with, as "SQLSTATE: message", or 'none'.
create function t1123m.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
-- Claims as PostgREST sets them, with the request's method and path.
create function t1123m.as_request(p_user uuid, p_client text, p_method text default 'GET', p_path text default '/clients') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true),
         set_config('request.method', p_method, true),
         set_config('request.path', p_path, true);
$$;
-- What a visit bills, as saved: the browser's role doesn't read the column (20261122000100).
create function t1123m.price(p_visit uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select v.price from public.visits v where v.id = p_visit
$$;
grant execute on all functions in schema t1123m to anon, authenticated, service_role;

\set owner 'b1123000-0000-0000-0000-000000000001'

insert into auth.users (id, email, raw_user_meta_data) values (:'owner', 'rae@rae-snow.test', '{"full_name": "Rae Snow"}');

begin;
set local role authenticated;
select t1123m.as_request(:'owner', null, 'POST', '/rpc/create_company');
select public.create_company('Rae Snow', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Client') returning id as client \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode) values (:'co', :'client', 'Weekly mowing', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'per_visit') returning id as job \gset
insert into public.visits (company_id, job_id, title, scheduled_on, status) values (:'co', :'job', 'Storm push', current_date + 1, 'scheduled') returning id as visit \gset
commit;

-- Rae's assistants.
\set full 'c1123000-0000-0000-0000-00000000000a'
\set nomoney 'c1123000-0000-0000-0000-00000000000b'
\set jobbing 'c1123000-0000-0000-0000-00000000000c'
\set pricing 'c1123000-0000-0000-0000-00000000000d'
\set billing 'c1123000-0000-0000-0000-00000000000e'
begin;
set local role authenticated;
select t1123m.as_request(:'owner', null);
insert into public.assistant_connections (client_id, level, areas) values
  (:'full', 'full', '{}'), (:'nomoney', 'full_no_money', '{}'), (:'jobbing', 'areas', '{jobs,clients,schedule}'),
  (:'pricing', 'areas', '{jobs,schedule,prices}'), (:'billing', 'areas', '{jobs,invoices}');
commit;

\o
\echo 'What a visit bills'
\o /dev/null

begin;
set local role authenticated;
select t1123m.as_request(:'owner', :'nomoney', 'PATCH', '/visits');
select t1123m.check(t1123m.error_of(format('update public.visits set price = 5000, price_note = %L where id = %L', 'x', :'visit'))
    like '42501: This assistant can''t change what a visit bills.%', 'full access without money doesn''t change what a visit bills');
select t1123m.check(t1123m.error_of(format('update public.visits set price_note = %L where id = %L', 'Included', :'visit')) like '42501: This assistant can''t change what a visit bills.%',
  'or its note');
select t1123m.check(t1123m.error_of(format('update public.visits set title = %L where id = %L', 'Storm push 1', :'visit')) = 'none', 'but changes the rest of the visit');
select t1123m.as_request(:'owner', :'jobbing', 'POST', '/visits');
select t1123m.check(t1123m.error_of(format('insert into public.visits (company_id, job_id, title, scheduled_on, status, price) values (%L, %L, %L, current_date + 2, %L, 10)', :'co', :'job', 'Extra push', 'scheduled'))
    like '42501: This assistant can''t change what a visit bills.%', 'an assistant given the schedule doesn''t add a visit with a price');
select t1123m.check(t1123m.error_of(format('insert into public.visits (company_id, job_id, title, scheduled_on, status) values (%L, %L, %L, current_date + 2, %L)', :'co', :'job', 'Extra push', 'scheduled')) = 'none',
  'but adds one without');
select t1123m.as_request(:'owner', :'pricing', 'PATCH', '/visits');
select t1123m.check(t1123m.error_of(format('update public.visits set price = 150, price_note = %L where id = %L', '2 in of snow', :'visit')) = 'none', 'one given prices does');
select t1123m.check(t1123m.price(:'visit') = 150, 'and the visit bills it');
rollback;

begin;
set local role authenticated;
select t1123m.as_request(:'owner', null, 'PATCH', '/visits');
update public.visits set price = 175 where id = :'visit';
select t1123m.check(t1123m.price(:'visit') = 175, 'the owner signed in sets it, as before');
rollback;

\o
\echo 'A job''s retainage and autopay'
\o /dev/null

begin;
set local role authenticated;
select t1123m.as_request(:'owner', :'nomoney', 'PATCH', '/jobs');
select t1123m.check(t1123m.error_of(format('update public.jobs set retainage_pct = 100 where id = %L', :'job')) like '42501: This assistant can''t change how a job is priced or billed.%',
  'full access without money doesn''t hold back a share of a job''s invoices');
select t1123m.check(t1123m.error_of(format('update public.jobs set autopay = true where id = %L', :'job')) like '42501: This assistant can''t turn autopay on or off for a job%',
  'or turn autopay on for it');
select t1123m.as_request(:'owner', :'pricing', 'PATCH', '/jobs');
select t1123m.check(t1123m.error_of(format('update public.jobs set retainage_pct = 10 where id = %L', :'job')) = 'none', 'one given prices sets the retainage');
select t1123m.check(t1123m.error_of(format('update public.jobs set autopay = true where id = %L', :'job')) like '42501: This assistant can''t turn autopay%', 'but not autopay');
select t1123m.as_request(:'owner', :'billing', 'PATCH', '/jobs');
select t1123m.check(t1123m.error_of(format('update public.jobs set autopay = true where id = %L', :'job')) = 'none', 'one given invoices turns autopay on');
select t1123m.check(t1123m.error_of(format('update public.jobs set title = %L where id = %L', 'Mowing', :'job')) = 'none', 'and the rest of a job changes as before');
rollback;

\o
\echo 'A job made with its billing'
\o /dev/null

begin;
set local role authenticated;
select t1123m.as_request(:'owner', :'nomoney', 'POST', '/jobs');
select t1123m.check(t1123m.error_of(format('insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode, pricing, invoice_schedule) values (%L, %L, %L, %L, %L, %L, %L, %L)',
    :'co', :'client', 'Plan', 'recurring', 'FREQ=WEEKLY;BYDAY=TU', 'per_visit', 'fixed', 'monthly')) like '42501: This assistant can''t change how a job is priced or billed.%',
  'full access without money doesn''t make a job billed at a fixed price monthly');
select t1123m.check(t1123m.error_of(format('insert into public.jobs (company_id, client_id, title, billing_mode) values (%L, %L, %L, %L)', :'co', :'client', 'Deck', 'progress'))
    like '42501: This assistant can''t change how a job is priced%', 'or one billed in progress');
select t1123m.check(t1123m.error_of(format('insert into public.jobs (company_id, client_id, title, retainage_pct) values (%L, %L, %L, 5)', :'co', :'client', 'Addition')) like '42501:%',
  'or one with retainage');
select t1123m.check(t1123m.error_of(format('insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode, autopay) values (%L, %L, %L, %L, %L, %L, true)',
    :'co', :'client', 'Auto', 'recurring', 'FREQ=WEEKLY;BYDAY=WE', 'per_visit')) like '42501: This assistant can''t turn autopay%', 'or one charged automatically');
-- The plain way, as the create_job tool makes them.
select t1123m.check(t1123m.error_of(format('insert into public.jobs (company_id, client_id, title, billing_mode) values (%L, %L, %L, %L)', :'co', :'client', 'Cleanup', 'on_completion')) = 'none',
  'but makes a one-off job billed when the work is done');
select t1123m.check(t1123m.error_of(format('insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode) values (%L, %L, %L, %L, %L, %L)',
    :'co', :'client', 'Weekly', 'recurring', 'FREQ=WEEKLY;BYDAY=TH', 'per_visit')) = 'none', 'and a repeating one billed per visit');
select t1123m.as_request(:'owner', :'pricing', 'POST', '/jobs');
select t1123m.check(t1123m.error_of(format('insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode, pricing, invoice_schedule, invoice_day) values (%L, %L, %L, %L, %L, %L, %L, %L, 15)',
    :'co', :'client', 'Plan', 'recurring', 'FREQ=WEEKLY;BYDAY=FR', 'per_visit', 'fixed', 'monthly')) = 'none', 'one given prices makes it billed as it says');
rollback;

begin;
set local role authenticated;
select t1123m.as_request(:'owner', null, 'POST', '/jobs');
select t1123m.check(t1123m.error_of(format('insert into public.jobs (company_id, client_id, title, billing_mode, retainage_pct) values (%L, %L, %L, %L, 5)', :'co', :'client', 'Deck', 'progress')) = 'none',
  'the owner signed in makes any job, as before');
rollback;

\echo 'All assistant job and visit money tests passed.'
