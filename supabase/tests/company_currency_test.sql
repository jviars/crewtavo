-- Database tests for company currencies (20261103000600_company_currency): a business starts in US
-- dollars, its owner can change it to another three-letter code, and anything else is refused.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema cct;
grant usage on schema cct to authenticated, service_role;
create function cct.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function cct.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema cct to authenticated, service_role;

-- Maple owns Maple Lawn.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0c00000-0000-0000-0000-000000000001', 'maple@maple-lawn.test', '{"full_name": "Maple Reyes"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0c00000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Maple Lawn', 'general', 'America/Toronto') as co \gset
select cct.check((select currency = 'USD' from public.companies where id = :'co'), 'a new business is in US dollars');
update public.companies set currency = 'CAD' where id = :'co';
select cct.check((select currency = 'CAD' from public.companies where id = :'co'), 'its owner can change it to Canadian dollars');
select cct.expect_error(format($q$update public.companies set currency = 'cad' where id = %L$q$, :'co'), 'a code in lower case is refused');
select cct.expect_error(format($q$update public.companies set currency = 'dollars' where id = %L$q$, :'co'), 'a word that isn''t a code is refused');
select cct.expect_error(format($q$update public.companies set currency = '' where id = %L$q$, :'co'), 'no currency is refused');
commit;

\echo 'All company currency tests passed.'
