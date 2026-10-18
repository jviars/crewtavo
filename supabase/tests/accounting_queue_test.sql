-- Database tests for the accounting queue: invoices and payments recorded while the accounting app
-- waits to be reconnected are still queued, and the queue waits too, then goes once it's back.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t29;
grant usage on schema t29 to authenticated, service_role;
create function t29.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t29.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t29 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b9000000-0000-0000-0000-000000000001', 'owner@tango.test', '{"full_name": "Tess Tango"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Tango Pools', 'lawn_care') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Lakeside HOA') returning id as client \gset
commit;

-- ===== Waiting to be reconnected ===============================================================
insert into public.integrations (company_id, provider, status) values (:'co', 'quickbooks', 'connected');
insert into public.payments (company_id, client_id, amount, method) values (:'co', :'client', 50, 'check');
select t29.check((select count(*) = 1 from public.outbox where company_id = :'co'), 'a payment is queued while QuickBooks is connected');

-- QuickBooks refused the sign-in (integrations/tokens.ts marks it), and a payment comes in meanwhile.
update public.integrations set status = 'error', last_error = 'Sign-in expired. Reconnect on the Apps page.' where company_id = :'co';
insert into public.payments (company_id, client_id, amount, method) values (:'co', :'client', 75, 'check');
select t29.check((select count(*) = 2 from public.outbox where company_id = :'co'), 'and still queued while it waits to be reconnected');
set role service_role;
select t29.check((select count(*) = 0 from public.claim_outbox(25)), 'the queue waits while the app does');
reset role;
select t29.check((select bool_and(attempts = 0 and locked_until is null and dead_at is null) from public.outbox where company_id = :'co'), 'without using up its tries');

update public.integrations set status = 'connected', last_error = null where company_id = :'co';
set role service_role;
select t29.check((select count(*) = 2 from public.claim_outbox(25)), 'once it''s reconnected, everything queued goes');
reset role;

-- ===== Another app connected alongside =========================================================
update public.integrations set status = 'error' where company_id = :'co';
insert into public.integrations (company_id, provider, status) values (:'co', 'zoho_books', 'connected');
insert into public.payments (company_id, client_id, amount, method) values (:'co', :'client', 20, 'check');
set role service_role;
select t29.check((select count(*) = 1 from public.claim_outbox(25)), 'with another accounting app connected, the queue doesn''t wait');
reset role;

-- ===== Disconnected ============================================================================
update public.integrations set status = 'disconnected' where company_id = :'co';
insert into public.payments (company_id, client_id, amount, method) values (:'co', :'client', 30, 'check');
select t29.check((select count(*) = 3 from public.outbox where company_id = :'co'), 'a disconnected app queues nothing');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t29.expect_error('select * from public.claim_outbox(25)', 'only the engine can claim the queue');
commit;

-- Nothing left for other tests' workers to claim.
delete from public.outbox where company_id = :'co';
delete from public.integrations where company_id = :'co';

\echo 'All accounting queue tests passed.'
