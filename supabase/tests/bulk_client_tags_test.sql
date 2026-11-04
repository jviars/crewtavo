-- Database tests for tagging many clients at once (20261106000800_bulk_client_tags.sql): a tag goes
-- on each client that lacks it and comes off each that has it, whatever its case, keeping their other
-- tags; it says which clients it changed; another business's clients and the crew are refused.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema bkt;
grant usage on schema bkt to authenticated, service_role;
create function bkt.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function bkt.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema bkt to authenticated, service_role;

-- Tia owns Teak Tag Lawn; Eve estimates there and Cal is on the crew. Ed owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('b7a90000-0000-0000-0000-000000000001', 'tia@teak-tag.test', '{"full_name": "Tia Teak"}'),
  ('b7a90000-0000-0000-0000-000000000003', 'eve@teak-tag.test', '{"full_name": "Eve Estimator"}'),
  ('b7a90000-0000-0000-0000-000000000004', 'cal@teak-tag.test', '{"full_name": "Cal Crew"}'),
  ('b7a90000-0000-0000-0000-000000000009', 'ed@elm-tag.test', '{"full_name": "Ed Elm"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a90000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Elm Tag Snow', 'general') as other \gset
select set_config('request.jwt.claims', '{"sub": "b7a90000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Teak Tag Lawn', 'general') as co \gset
commit;
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'b7a90000-0000-0000-0000-000000000003', 'estimator'),
  (:'co', 'b7a90000-0000-0000-0000-000000000004', 'field_crew');

-- Ann has no tags, Bo is already a VIP (in capitals) and Spring, Cy is Spring only; Elm has its own Dee.
insert into public.clients (company_id, display_name, tags) values (:'co', 'Ann Teak', '{}') returning id as ann \gset
insert into public.clients (company_id, display_name, tags) values (:'co', 'Bo Teak', '{VIP,Spring}') returning id as bo \gset
insert into public.clients (company_id, display_name, tags) values (:'co', 'Cy Teak', '{Spring}') returning id as cy \gset
insert into public.clients (company_id, display_name, tags) values (:'other', 'Dee Elm', '{Spring}') returning id as dee \gset

-- Adding.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a90000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select bkt.check((select array_agg(x order by x) from public.change_client_tags(array[:'ann', :'bo', :'cy']::uuid[], p_add => ' vip ') x)
  = (select array_agg(x order by x) from unnest(array[:'ann', :'cy']::uuid[]) x), 'adding vip changes Ann and Cy, not Bo who has it as VIP');
select bkt.check((select tags = '{vip}' from public.clients where id = :'ann'), 'Ann has it, trimmed');
select bkt.check((select tags = '{Spring,vip}' from public.clients where id = :'cy'), 'Cy keeps Spring, with vip after it');
select bkt.check((select tags = '{VIP,Spring}' from public.clients where id = :'bo'), 'Bo keeps his tags as they were');
commit;

-- Taking off, by an estimator; another business's client is left out.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a90000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select bkt.check((select array_agg(x order by x) from public.change_client_tags(array[:'ann', :'bo', :'cy', :'dee']::uuid[], p_remove => 'SPRING') x)
  = (select array_agg(x order by x) from unnest(array[:'bo', :'cy']::uuid[]) x), 'taking Spring off changes Bo and Cy, not Ann who hasn''t it or Elm''s Dee');
select bkt.check((select tags = '{VIP}' from public.clients where id = :'bo'), 'Bo keeps VIP');
select bkt.check((select tags = '{vip}' from public.clients where id = :'cy'), 'Cy keeps vip');
commit;
select bkt.check((select tags = '{Spring}' from public.clients where id = :'dee'), 'Elm''s Dee keeps Spring');

-- Another business and the crew change nothing.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a90000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select bkt.check((select count(*) = 0 from public.change_client_tags(array[:'ann', :'bo', :'cy']::uuid[], p_add => 'Elm')), 'another business changes none of Teak''s clients');
select set_config('request.jwt.claims', '{"sub": "b7a90000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select bkt.check((select count(*) = 0 from public.change_client_tags(array[:'ann', :'bo', :'cy']::uuid[], p_add => 'Crew')), 'nor does the crew');
commit;
select bkt.check((select bool_and(not ('Elm' = any (tags)) and not ('Crew' = any (tags))) from public.clients where company_id = :'co'), 'their tags stay off');

-- What it won't do.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7a90000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select bkt.expect_error(format($q$select public.change_client_tags(array[%L]::uuid[], 'a', 'b')$q$, :'ann'), 'not both at once');
select bkt.expect_error(format($q$select public.change_client_tags(array[%L]::uuid[])$q$, :'ann'), 'nor neither');
select bkt.expect_error(format($q$select public.change_client_tags(array[%L]::uuid[], '  ')$q$, :'ann'), 'nor an empty tag');
select bkt.expect_error(format($q$select public.change_client_tags(array[%L]::uuid[], repeat('x', 41))$q$, :'ann'), 'nor one over 40 characters');
commit;
select bkt.check(not has_function_privilege('anon', 'public.change_client_tags(uuid[], text, text)', 'execute'), 'someone signed out can''t call it');
\echo 'All bulk client tag tests passed.'
