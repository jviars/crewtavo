-- Database tests for booking forms finding their client (20261103000100_booking_form_finds_clients):
-- a booking from a client the business has goes on their record by email or phone (changing nothing
-- about them) and their property with that street; anyone else is a new lead at a new property; only
-- the server can ask.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema bft;
grant usage on schema bft to authenticated, service_role;
create function bft.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function bft.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema bft to authenticated, service_role;

-- Ana owns Larch Lawn; Ed owns another business, with a client of the same email.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ab330000-0000-0000-0000-000000000001', 'ana@larch.test', '{"full_name": "Ana Larch"}'),
  ('ab330000-0000-0000-0000-000000000009', 'ed@elm.test', '{"full_name": "Ed Elm"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab330000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Elm Snow', 'general') as other \gset
select set_config('request.jwt.claims', '{"sub": "ab330000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Larch Lawn', 'general', 'America/Chicago') as co \gset
select bft.expect_error(format($q$select public.booking_form_client(%L, 'Eve', 'eve@x.test')$q$, :'co'), 'someone signed in can''t ask');
commit;

-- Cora is a client of Larch Lawn (and an archived Cora from years ago); Elm Snow has its own Cora.
begin;
set local role service_role;
insert into public.clients (company_id, status, display_name, email, phone, created_at) values
  (:'co', 'archived', 'Cora (old)', 'cora@birch-home.test', null, now() - interval '3 years'),
  (:'co', 'active', 'Cora Vance', 'Cora@Birch-Home.test', '(540) 555-0177', now() - interval '1 year'),
  (:'other', 'active', 'Cora Elsewhere', 'cora@birch-home.test', null, now());
select id as cora from public.clients where display_name = 'Cora Vance' \gset
insert into public.properties (company_id, client_id, line1, city) values (:'co', :'cora', '12 Oak St', 'Roanoke') returning id as cora_home \gset
commit;

begin;
set local role service_role;
select public.booking_form_client(:'co', 'Dot Newman', 'dot@birch-new.test', null, '{"line1": "9 Elm Rd", "city": "Salem", "postal_code": "24153"}') as found \gset
select bft.check(not (:'found'::jsonb ->> 'matched')::boolean and (:'found'::jsonb ->> 'new_property')::boolean, 'someone new: a new lead, at a new property');
select bft.check((select c.company_id = :'co' and c.display_name = 'Dot Newman' and c.email = 'dot@birch-new.test' and c.status = 'lead' and c.lead_source = 'Website form'
  from public.clients c where c.id = (:'found'::jsonb ->> 'client_id')::uuid), 'the lead has their name, email and where they came from');
select bft.check((select p.client_id = (:'found'::jsonb ->> 'client_id')::uuid and p.line1 = '9 Elm Rd' and p.city = 'Salem' and p.postal_code = '24153'
  from public.properties p where p.id = (:'found'::jsonb ->> 'property_id')::uuid), 'at the address they typed');

select public.booking_form_client(:'co', 'C. Vance', ' cora@BIRCH-HOME.test ', '555 0000', '{"line1": "12 OAK ST "}') as found \gset
select bft.check((:'found'::jsonb ->> 'matched')::boolean and (:'found'::jsonb ->> 'client_id')::uuid = :'cora', 'the same email, spelled differently: this business''s client (not the archived one)');
select bft.check((select display_name = 'Cora Vance' and email = 'Cora@Birch-Home.test' and phone = '(540) 555-0177' from public.clients where id = :'cora'), 'the client''s saved name, email and phone stay');
select bft.check((:'found'::jsonb ->> 'property_id')::uuid = :'cora_home' and not (:'found'::jsonb ->> 'new_property')::boolean, 'the property with that street, not a new one');

select public.booking_form_client(:'co', 'Cora', null, '+1 540-555-0177', '{"line1": "40 Pine Ave"}') as found \gset
select bft.check((:'found'::jsonb ->> 'client_id')::uuid = :'cora', 'the same phone number, written differently, finds Cora too');
select bft.check((:'found'::jsonb ->> 'new_property')::boolean and (select client_id = :'cora' from public.properties where id = (:'found'::jsonb ->> 'property_id')::uuid),
  'a street she doesn''t have yet becomes her new property');
select bft.check((select count(*) = 2 from public.clients where company_id = :'co' and email ilike 'cora@birch-home.test'), 'and no new Cora is made');
commit;

\echo 'All booking form tests passed.'
