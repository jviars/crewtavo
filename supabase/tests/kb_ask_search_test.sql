-- Database tests for finding guides: Ask (p_any) finds guides with any of a question's words, best
-- matches first, while the Search box still needs every word. Either way people only find what they
-- can already open.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tka;
grant usage on schema tka to authenticated, service_role;
create function tka.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tka to authenticated, service_role;
-- The titles a search finds, best first, as the person signed in.
create function tka.titles(p_company uuid, p_query text, p_any boolean) returns text[] language sql as $$
  select coalesce(array_agg(title order by rank desc, title), '{}') from public.search_sops(p_company, p_query, 10, p_any)
$$;
grant execute on function tka.titles(uuid, text, boolean) to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c5a50000-0000-0000-0000-000000000001', 'owner@sierra.test', '{"full_name": "Sid Owner"}'),
  ('c5a50000-0000-0000-0000-000000000002', 'crew@sierra.test', '{"full_name": "Cleo Crew"}'),
  ('c5a50000-0000-0000-0000-000000000003', 'owner@tango.test', '{"full_name": "Tess Tango"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5a50000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.create_company('Tango Paving', 'paving') as other \gset
insert into public.sop_pages (company_id, title, body_text) values (:'other', 'Tango sealer guide', 'Sealer needs a day to dry before cars drive on it.');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5a50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Sierra Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'c5a50000-0000-0000-0000-000000000002', 'field_crew');
insert into public.sop_pages (company_id, title, body_text) values
  (:'co', 'Sealcoating a driveway', 'Let the sealer cure 24 hours before driving on it. Keep cars off until then.'),
  (:'co', 'Crack filling', 'Blow out the cracks, then fill with hot pour. Cars can drive on it after an hour.'),
  (:'co', 'Truck safety', 'Chock the wheels and set the brake before you leave the cab.');
insert into public.sop_pages (company_id, title, body_text, status) values (:'co', 'Sealer draft', 'New sealer, still being tested.', 'draft');

select tka.check(tka.titles(:'co', 'how long does sealer need to dry before cars drive on it', false) = '{}', 'the Search box needs every word of a question');
select tka.check(tka.titles(:'co', 'how long does sealer need to dry before cars drive on it', true) = '{Sealer draft,Sealcoating a driveway,Crack filling}',
  'Ask finds guides with any of its words, best first: a word in the title counts most, then having more of them');
select tka.check(tka.titles(:'co', 'sealer cars', false) = '{Sealcoating a driveway}', 'the Search box still finds guides with every word');
select tka.check(tka.titles(:'co', 'how do I', true) = '{}', 'a question of only stop words finds nothing rather than everything');
select tka.check(tka.titles(:'co', 'what''s O''Brien''s "sealer" | & ! <-> :*', true) @> '{Sealcoating a driveway}', 'quotes and search operators in a question are just words');
select tka.check((select snippet from public.search_sops(:'co', 'when can cars drive on fresh sealer', 4, true) where title = 'Sealcoating a driveway') like '%sealer%',
  'and the snippet shows where the words are');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5a50000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tka.check(tka.titles(:'co', 'how long does sealer need to dry before cars drive on it', true) = '{Sealcoating a driveway,Crack filling}', 'crews only find published guides');
select tka.check(tka.titles(:'other', 'sealer', true) = '{}', 'and never another company''s');
commit;

drop schema tka cascade;
\echo 'All guide search tests passed.'
