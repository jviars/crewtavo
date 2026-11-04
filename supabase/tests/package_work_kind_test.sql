-- Database tests for a package estimate's kind of work (20261104000600_package_work_kind): an
-- estimate made in the Roofing or Paving section says which, one made anywhere else says nothing,
-- and there's no third kind.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema pwk;
grant usage on schema pwk to authenticated, service_role;
create function pwk.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function pwk.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema pwk to authenticated, service_role;

-- Tess owns Tarn Roofing & Paving, which does both.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ab660000-0000-0000-0000-000000000001', 'tess@tarn-roof-pave.test', '{"full_name": "Tess Tarn"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab660000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Tarn Roofing & Paving', 'roofing_exteriors') as co \gset
select public.trade_app_set_enabled(:'co', 'paving', true);
insert into public.clients (company_id, display_name) values (:'co', 'Wren Hollis') returning id as client \gset

-- The office makes them, as the Roofing and Paving sections and the Quotes page do.
insert into public.quotes (company_id, client_id, title, work_kind) values (:'co', :'client', 'Roof at 4 Fir Ln', 'roofing') returning id as roof \gset
insert into public.quotes (company_id, client_id, title, work_kind) values (:'co', :'client', 'Paving at 4 Fir Ln', 'paving') returning id as lot \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Gutter cleaning') returning id as other \gset
select pwk.check((select work_kind = 'roofing' from public.quotes where id = :'roof'), 'a roof estimate made in Roofing is roof work');
select pwk.check((select work_kind = 'paving' from public.quotes where id = :'lot'), 'a takeoff made in Paving is paving');
select pwk.check((select work_kind is null from public.quotes where id = :'other'), 'an estimate made anywhere else says nothing, so its packages tell');

update public.quotes set work_kind = 'paving' where id = :'other';
select pwk.check((select work_kind = 'paving' from public.quotes where id = :'other'), 'the office can say which it is later');
select pwk.expect_error(format($q$update public.quotes set work_kind = 'lawn' where id = %L$q$, :'other'), 'there are only the two kinds');
commit;

\echo 'All package work kind tests passed.'
