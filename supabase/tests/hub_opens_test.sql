-- Database tests for 20261125100200_hub_opens.sql: the server records a client opening a sent quote
-- or invoice (first and last time), with one history line on the first open; drafts and void
-- invoices aren't recorded; nobody signed in can write it or call it; and it's seen with the record.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tho;
grant usage on schema tho to anon, authenticated, service_role;
create function tho.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tho.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
create function tho.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tho to anon, authenticated, service_role;

\set ora '0be40000-0000-0000-0000-000000000001'
\set fred '0be40000-0000-0000-0000-000000000002'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'ora', 'ora@opens.test', '{"full_name": "Ora Owner"}'), (:'fred', 'fred@opens.test', '{"full_name": "Fred Foreman"}');

begin;
set local role authenticated;
select tho.as_user(:'ora');
select public.create_company('Opens Lawn', 'general') as co \gset
reset role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'fred', 'crew_lead');
insert into public.clients (company_id, display_name) values (:'co', 'Lee Lopez') returning id as lee \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'lee', 'Spring cleanup') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'quote', 'Cleanup', 400);
insert into public.quotes (company_id, client_id, title) values (:'co', :'lee', 'Still a draft') returning id as draft \gset
insert into public.invoices (company_id, client_id, subject) values (:'co', :'lee', 'Mowing') returning id as invoice \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable) values (:'co', :'invoice', 'Mowing', 1, 'ea', 50, false);
update public.quotes set status = 'sent', sent_at = now() where id = :'quote';
update public.invoices set status = 'sent' where id = :'invoice';
commit;

-- ===== Only the server records it ============================================================
begin;
set local role authenticated;
select tho.as_user(:'ora');
select tho.expect_error(format('select public.hub_opened(%L, %L, %L)', :'co', 'quote', :'quote'), 'the owner can''t call it');
select tho.expect_error(format('insert into public.hub_opens (company_id, quote_id) values (%L, %L)', :'co', :'quote'), 'nor write the table');
rollback;
begin;
set local role anon;
select tho.expect_error(format('select public.hub_opened(%L, %L, %L)', :'co', 'quote', :'quote'), 'nor can anyone signed out');
rollback;

-- ===== First open, then another ==============================================================
begin;
set local role service_role;
select tho.check(public.hub_opened(:'co', 'quote', :'quote'), 'the first open says it was the first');
reset role;
commit;
begin;
set local role service_role;
select tho.check(not public.hub_opened(:'co', 'quote', :'quote'), 'a later one doesn''t');
select public.hub_opened(:'co', 'invoice', :'invoice');
reset role;
commit;
select tho.check((select first_at < last_at from public.hub_opens where quote_id = :'quote'), 'a second open moves "last" and keeps "first"');
select tho.check((select count(*) = 1 from public.activity where verb = 'quote.viewed' and subject_id = :'quote'), 'only the first open adds a history line');
select tho.check((select summary = format('Lee Lopez opened quote #%s', (select number from public.quotes where id = :'quote')) from public.activity where verb = 'quote.viewed' and subject_id = :'quote'), 'it says who opened which quote');
select tho.check((select count(*) = 1 from public.activity where verb = 'invoice.viewed' and subject_id = :'invoice'), 'an invoice''s first open is in its history too');

-- ===== Not a draft ===========================================================================
begin;
set local role service_role;
select public.hub_opened(:'co', 'quote', :'draft');
reset role;
commit;
select tho.check(not exists (select 1 from public.hub_opens where quote_id = :'draft'), 'a draft isn''t recorded');

-- ===== Seen with the record ==================================================================
begin;
set local role authenticated;
select tho.as_user(:'ora');
select tho.check((select count(*) = 2 from public.hub_opens), 'the owner sees when the quote and the invoice were opened');
select tho.as_user(:'fred');
select tho.check(not exists (select 1 from public.hub_opens where invoice_id = :'invoice'), 'a foreman, who sees no invoices, doesn''t see the invoice''s');
rollback;
