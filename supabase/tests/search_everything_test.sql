-- Database tests for search: it finds measurements, knowledge base pages, campaigns, automation
-- rules and price list services, and each person only finds what they can already open.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tse;
grant usage on schema tse to authenticated, service_role;
create function tse.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tse to authenticated, service_role;
-- What a search for p_query finds of one kind, as the person signed in.
create function tse.found(p_company uuid, p_query text, p_kind text) returns bigint language sql as $$
  select count(*) from public.global_search(p_company, p_query, 20) where kind = p_kind
$$;
grant execute on function tse.found(uuid, text, text) to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b7100000-0000-0000-0000-000000000001', 'owner@quartz.test', '{"full_name": "Quinn Owner"}'),
  ('b7100000-0000-0000-0000-000000000002', 'crew@quartz.test', '{"full_name": "Cal Crew"}'),
  ('b7100000-0000-0000-0000-000000000003', 'owner@romeo.test', '{"full_name": "Rae Romeo"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7100000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.create_company('Romeo Lawns', 'lawn_care') as other \gset
insert into public.services (company_id, name, unit, unit_price) values (:'other', 'Zephyr mulch', 'yd', 50);
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7100000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Quartz Grounds', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'b7100000-0000-0000-0000-000000000002', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Wren Whitfield') returning id as client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '12 Larkspur Way') returning id as prop \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Patio rebuild') returning id as quote \gset
insert into public.measurements (company_id, property_id, geojson) values (:'co', :'prop', '{"type": "FeatureCollection", "features": []}') returning id as m_plain \gset
insert into public.measurements (company_id, quote_id, title, geojson) values (:'co', :'quote', 'Back slope', '{"type": "FeatureCollection", "features": []}') returning id as m_named \gset
insert into public.sop_pages (company_id, title, body_text) values (:'co', 'Opening the shop', 'Disarm the alarm, then check the zephyr blower fuel.') returning id as kb \gset
insert into public.sop_pages (company_id, title, status) values (:'co', 'Zephyr draft', 'draft');
insert into public.campaigns (company_id, name, subject) values (:'co', 'Spring zephyr', 'Book your spring cleanup');
insert into public.automation_rules (company_id, name, trigger, actions, description) values (:'co', 'Thank zephyr clients', 'invoice.paid', '[{"type": "add_note", "body": "Thanked"}]', 'After they pay');
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Zephyr mulch', 'yd', 60);
insert into public.services (company_id, name, unit, unit_price, active) values (:'co', 'Zephyr edging (old)', 'ft', 2, false);

select tse.check(tse.found(:'co', 'Larkspur', 'measurement') = 1, 'a measurement is found by its address');
select tse.check((select client_id from public.global_search(:'co', 'Larkspur', 20) where kind = 'measurement') = :'client', 'and knows the client');
select tse.check(tse.found(:'co', 'Whitfield', 'measurement') = 2, 'by the client, through the property or the quote');
select tse.check(tse.found(:'co', 'back slope', 'measurement') = 1, 'by the name someone gave it');
select tse.check(tse.found(:'co', 'Patio', 'measurement') = 1, 'by its quote');
select tse.check(tse.found(:'co', 'measurement', 'measurement') = 0, 'but not by the name every drawing starts with');
select tse.check(tse.found(:'co', 'opening', 'kb') = 1, 'a knowledge base page is found by its title');
select tse.check(tse.found(:'co', 'alarm', 'kb') = 1, 'and by its text');
select tse.check(tse.found(:'co', 'blowers', 'kb') = 1, 'with other forms of a word');
select tse.check(tse.found(:'co', 'zephyr', 'kb') = 2, 'owners find drafts too');
select tse.check(tse.found(:'co', 'zephyr', 'campaign') = 1, 'campaigns are found');
select tse.check(tse.found(:'co', 'cleanup', 'campaign') = 1, 'by subject too');
select tse.check(tse.found(:'co', 'zephyr', 'rule') = 1, 'automation rules are found');
select tse.check(tse.found(:'co', 'they pay', 'rule') = 1, 'by description too');
select tse.check(tse.found(:'co', 'zephyr', 'service') = 1, 'price list services are found, hidden ones left out, other companies'' never');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b7100000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tse.check(tse.found(:'co', 'zephyr', 'kb') = 1, 'crews find published pages only');
select tse.check(tse.found(:'co', 'Larkspur', 'measurement') = 0, 'and none of what they can''t open: measurements,');
select tse.check(tse.found(:'co', 'zephyr', 'campaign') = 0, 'campaigns,');
select tse.check(tse.found(:'co', 'zephyr', 'rule') = 0, 'automation rules,');
select tse.check(tse.found(:'co', 'zephyr', 'service') = 0, 'or prices');
commit;

drop schema tse cascade;
\echo 'All search tests passed.'
