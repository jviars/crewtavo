-- Database tests for "Add to every job" items on quote templates (20261105000120_template_trip_fee):
-- the line taken off a template stays off the quotes made from it and the template's copies; a
-- template that never had it still gives its quotes the item; a quote that isn't a template, copied,
-- gets it back as before; and a template can still be deleted.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tttf;
grant usage on schema tttf to authenticated, service_role;
create function tttf.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tttf.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- How many trip charge lines a quote has.
create function tttf.trips(p_quote uuid) returns bigint language sql as $$
  select count(*) from public.quote_line_items l join public.services s on s.id = l.service_id where l.quote_id = p_quote and s.name = 'Trip charge'
$$;
grant execute on all functions in schema tttf to authenticated, service_role;

\set una 'ba530000-0000-0000-0000-000000000001'
insert into auth.users (id, email, raw_user_meta_data) values (:'una', 'una@usk-lawn.test', '{"full_name": "Una Usk"}');

begin;
set local role authenticated;
select tttf.as_user(:'una');
select public.create_company('Usk Lawn', 'lawn_exterior') as co \gset
insert into public.services (company_id, name, unit, unit_price, add_to_every_job) values (:'co', 'Trip charge', 'visit', 25, true) returning id as trip \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Lee') returning id as pat \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'pat', 'Spring cleanup') returning id as q \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'q', 'Cleanup', 1, 'ea', 300);
commit;
select tttf.check(tttf.trips(:'q') = 1, 'a quote''s first lines bring the trip charge');

-- Saved as a template, which the office takes the trip charge off.
begin;
set local role authenticated;
select tttf.as_user(:'una');
select public.duplicate_quote(:'q', 'Cleanup template') as t \gset
commit;
begin;
set local role authenticated;
select tttf.as_user(:'una');
delete from public.quote_line_items where quote_id = :'t' and service_id = :'trip';
commit;
select tttf.check(tttf.trips(:'t') = 0 and (select every_job_items_left_off = array[:'trip']::uuid[] from public.quotes where id = :'t'),
  'the template remembers the trip charge was taken off');

begin;
set local role authenticated;
select tttf.as_user(:'una');
select public.duplicate_quote(:'t', null, :'pat', null, 'Cleanup for Pat') as from_t \gset
select public.duplicate_quote(:'t') as t_copy \gset
commit;
begin;
set local role authenticated;
select tttf.as_user(:'una');
select public.duplicate_quote(:'t_copy', null, :'pat') as from_copy \gset
commit;
select tttf.check(tttf.trips(:'from_t') = 0 and (select count(*) from public.quote_line_items where quote_id = :'from_t') = 1,
  'a quote made from it has its lines, without the trip charge');
select tttf.check(tttf.trips(:'t_copy') = 0 and tttf.trips(:'from_copy') = 0, 'so do a copy of the template and the quotes made from that');

-- A template made before the trip charge was added to every job still gives its quotes the charge.
begin;
set local role authenticated;
select tttf.as_user(:'una');
update public.services set add_to_every_job = false where id = :'trip';
insert into public.quotes (company_id, is_template, title) values (:'co', true, 'Mowing template') returning id as t2 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'t2', 'Mow', 1, 'visit', 45);
commit;
begin;
set local role authenticated;
select tttf.as_user(:'una');
update public.services set add_to_every_job = true where id = :'trip';
select public.duplicate_quote(:'t2', null, :'pat') as from_t2 \gset
commit;
select tttf.check(tttf.trips(:'t2') = 0 and tttf.trips(:'from_t2') = 1, 'a template that never had it: its quotes get the trip charge, as before');

-- A quote that isn't a template, with the charge taken off, copied: the copy gets it, as before.
begin;
set local role authenticated;
select tttf.as_user(:'una');
delete from public.quote_line_items where quote_id = :'from_t2' and service_id = :'trip';
select public.duplicate_quote(:'from_t2') as q_copy \gset
commit;
select tttf.check(tttf.trips(:'from_t2') = 0 and tttf.trips(:'q_copy') = 1
  and (select every_job_items_left_off = '{}' from public.quotes where id = :'from_t2'),
  'a quote''s own removal stays on that quote only');

begin;
set local role authenticated;
select tttf.as_user(:'una');
delete from public.quotes where id = :'t';
commit;
select tttf.check(not exists (select 1 from public.quotes where id = :'t'), 'a template with lines is deleted as before');

\echo 'All template trip fee tests passed.'
