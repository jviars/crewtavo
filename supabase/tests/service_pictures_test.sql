-- Database tests for price list pictures (20261025000200_service_pictures): an item's picture is a
-- JPEG in the business's own services folder with a sensible size, its three columns set or cleared
-- together, and it's changed by those who change the price list (the Settings area), never by an
-- estimator without it, a crew or another company. Run with scripts/test-db.sh (plain Postgres +
-- prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_pictures;
grant usage on schema t_pictures to authenticated, service_role;
create function t_pictures.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_pictures.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t_pictures to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('9c7e0000-0000-0000-0000-000000000001', 'owner@pictures.test', '{"full_name": "Pia Pictures"}'),
  ('9c7e0000-0000-0000-0000-000000000002', 'estimator@pictures.test', '{"full_name": "Eli Estimator"}'),
  ('9c7e0000-0000-0000-0000-000000000003', 'crew@pictures.test', '{"full_name": "Cy Crew"}'),
  ('9c7e0000-0000-0000-0000-000000000004', 'other@pictures.test', '{"full_name": "Otto Other"}');

-- ===== The owner gives the pipe boot a picture ==================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c7e0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Pia Roofing', 'roofing_exteriors') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', '9c7e0000-0000-0000-0000-000000000002', 'estimator'),
  (:'co', '9c7e0000-0000-0000-0000-000000000003', 'field_crew');
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Pipe boot', 'ea', 45) returning id as boot \gset
select t_pictures.check((select picture is null and picture_width is null and picture_height is null from public.services where id = :'boot'), 'an item starts without a picture');
select format('%s/services/%s.jpg', :'co', gen_random_uuid()) as boot_picture \gset
update public.services set picture = :'boot_picture', picture_width = 1200, picture_height = 900 where id = :'boot';
select t_pictures.check((select picture = :'boot_picture' and picture_width = 1200 and picture_height = 900 from public.services where id = :'boot'), 'the owner gives the pipe boot its picture');
select t_pictures.expect_error(format('update public.services set picture = %L where id = %L', format('%s/services/%s.jpg', gen_random_uuid(), gen_random_uuid()), :'boot'), 'a picture is in the business''s own folder');
select t_pictures.expect_error(format('update public.services set picture = %L where id = %L', format('%s/packages/%s.jpg', :'co', gen_random_uuid()), :'boot'), 'its services folder');
select t_pictures.expect_error(format('update public.services set picture = %L where id = %L', format('%s/services/%s.png', :'co', gen_random_uuid()), :'boot'), 'as a JPEG');
select t_pictures.expect_error(format('update public.services set picture_width = null where id = %L', :'boot'), 'with its size');
select t_pictures.expect_error(format('update public.services set picture_width = 5000 where id = %L', :'boot'), 'a sensible size');
select t_pictures.expect_error(format('update public.services set picture = null where id = %L', :'boot'), 'its columns go together');
update public.services set picture = null, picture_width = null, picture_height = null where id = :'boot';
select t_pictures.check((select picture is null from public.services where id = :'boot'), 'and it goes back to the drawing');
update public.services set picture = :'boot_picture', picture_width = 1200, picture_height = 900 where id = :'boot';
commit;

-- ===== Nobody else changes it ===================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c7e0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t_pictures.check((select picture = :'boot_picture' from public.services where id = :'boot'), 'the estimator sees it');
update public.services set picture = null, picture_width = null, picture_height = null where id = :'boot';
commit;
select t_pictures.check((select picture = :'boot_picture' from public.services where id = :'boot'), 'but without Settings doesn''t take it off');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c7e0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.services set picture = null, picture_width = null, picture_height = null where id = :'boot';
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c7e0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select public.create_company('Otto Exteriors', 'roofing_exteriors') as other \gset
update public.services set picture = null, picture_width = null, picture_height = null where id = :'boot';
commit;
select t_pictures.check((select picture = :'boot_picture' from public.services where id = :'boot'), 'nor does a crew or another company');

\o
\echo 'All price list picture tests passed.'
