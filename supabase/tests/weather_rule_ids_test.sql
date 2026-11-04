-- Database tests for weather rules that name their price list item by id (20261106000400_weather_rule_ids):
-- set_weather_rules keeps an id of the business's own item, with the item's name as it is now, and
-- finds the id of a rule sent by name; another business's item, or something that isn't an id, falls
-- back to the rule's name, or is turned down without one; and rules saved before ids get the id of
-- the item of their name.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_wri;
grant usage on schema t_wri to authenticated, service_role;
create function t_wri.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_wri.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t_wri to authenticated, service_role;

-- Ida owns Ida Paving; Max owns Max Seal, with an item of the same name.
insert into auth.users (id, email, raw_user_meta_data) values
  ('e7b20000-0000-0000-0000-000000000001', 'ida@ida-paving.test', '{"full_name": "Ida Paving"}'),
  ('e7b20000-0000-0000-0000-000000000009', 'max@max-seal.test', '{"full_name": "Max Seal"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7b20000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Max Seal', 'general') as other \gset
insert into public.services (company_id, name) values (:'other', 'Sealcoat') returning id as other_seal \gset
select set_config('request.jwt.claims', '{"sub": "e7b20000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Ida Paving', 'general') as co \gset
-- An old Sealcoat taken off the price list, then the one in use.
insert into public.services (company_id, name, active, created_at) values (:'co', 'Sealcoat', false, now() - interval '1 year') returning id as old_seal \gset
insert into public.services (company_id, name) values (:'co', 'Sealcoat') returning id as seal \gset
insert into public.services (company_id, name) values (:'co', 'Crack fill') returning id as crack \gset
commit;

\o
\echo 'Saving rules with ids'
\o /dev/null

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7b20000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.set_weather_rules(:'co', format('[{"service_id": %s, "applies_to": "Crack filling", "min_temp_f": 40},
  {"applies_to": " sealcoat ", "requires_dry_hours": 24}, {"applies_to": "Hand patching", "max_rain_pct": 30}, {"max_wind_mph": 20}]', to_jsonb(:'crack'::text))::jsonb) as saved \gset
select t_wri.check(:'saved'::jsonb -> 0 = jsonb_build_object('applies_to', 'Crack fill', 'service_id', :'crack', 'min_temp_f', 40),
  'a rule keeps its item''s id, with the item''s name as it is now');
select t_wri.check(:'saved'::jsonb -> 1 = jsonb_build_object('applies_to', 'Sealcoat', 'service_id', :'seal', 'requires_dry_hours', 24),
  'one sent by name gets the id of the item of that name, the active one');
select t_wri.check(:'saved'::jsonb -> 2 = '{"applies_to": "Hand patching", "max_rain_pct": 30}' and :'saved'::jsonb -> 3 = '{"max_wind_mph": 20}',
  'a name that isn''t on the price list, and a rule for every job, stay as they are');
select t_wri.check((select settings -> 'weather_rules' = :'saved'::jsonb from public.companies where id = :'co'), 'and that''s what''s saved');

update public.services set name = 'Sealcoating' where id = :'seal';
select public.set_weather_rules(:'co', settings -> 'weather_rules') from public.companies where id = :'co';
select t_wri.check((select settings -> 'weather_rules' -> 1 = jsonb_build_object('applies_to', 'Sealcoating', 'service_id', :'seal', 'requires_dry_hours', 24)
  from public.companies where id = :'co'), 'renaming the item keeps its rule, which takes the new name when saved again');

select t_wri.check(public.set_weather_rules(:'co', format('[{"service_id": %s, "applies_to": "crack fill", "max_rain_pct": 50},
  {"service_id": "e7b20000-0000-0000-0000-0000000000ff", "applies_to": "Hand patching", "max_rain_pct": 30}]', to_jsonb(:'other_seal'::text))::jsonb)
  = jsonb_build_array(jsonb_build_object('applies_to', 'Crack fill', 'service_id', :'crack', 'max_rain_pct', 50), '{"applies_to": "Hand patching", "max_rain_pct": 30}'::jsonb),
  'an id that isn''t one of the business''s items (another''s, or one removed) falls back to the rule''s name');
select t_wri.expect_error(format($q$select public.set_weather_rules(%L, '[{"service_id": %s, "max_rain_pct": 50}]')$q$, :'co', to_jsonb(:'other_seal'::text)),
  'and without a name, another business''s item isn''t on this price list (nor is the rule for every job)');
select t_wri.expect_error(format($q$select public.set_weather_rules(%L, '[{"service_id": "sealcoat", "max_rain_pct": 50}]')$q$, :'co'), 'nor is something that isn''t an id');
select t_wri.expect_error(format($q$select public.set_weather_rules(%L, '[{"service_id": 7, "max_rain_pct": 50}]')$q$, :'co'), 'or isn''t text');
select t_wri.expect_error(format($q$select public.set_weather_rules(%L, '[{"service_id": %s}]')$q$, :'co', to_jsonb(:'crack'::text)), 'an item is no limit: a rule still needs one');
commit;

\o
\echo 'Rules saved before ids'
\o /dev/null

begin;
update public.companies set settings = jsonb_set(settings, '{weather_rules}', format('[{"applies_to": "crack fill ", "min_temp_f": 40}, "not a rule",
  {"applies_to": "Sealcoat", "service_id": %s, "requires_dry_hours": 24}, {"applies_to": "Hand patching", "max_rain_pct": 30}, {"max_wind_mph": 20}]', to_jsonb(:'old_seal'::text))::jsonb)
where id = :'co';
update public.companies set settings = jsonb_set(settings, '{weather_rules}', '[{"applies_to": "Crack fill", "min_temp_f": 40}]') where id = :'other';
select private.fill_weather_rule_ids();
select t_wri.check((select settings -> 'weather_rules' = format('[{"applies_to": "crack fill ", "min_temp_f": 40, "service_id": %s}, "not a rule",
  {"applies_to": "Sealcoat", "service_id": %s, "requires_dry_hours": 24}, {"applies_to": "Hand patching", "max_rain_pct": 30}, {"max_wind_mph": 20}]',
  to_jsonb(:'crack'::text), to_jsonb(:'old_seal'::text))::jsonb from public.companies where id = :'co'),
  'a rule gets the id of the item of its name, in order; one with an id, one with no such item, and what isn''t a rule stay as they were');
select t_wri.check((select settings -> 'weather_rules' = '[{"applies_to": "Crack fill", "min_temp_f": 40}]' from public.companies where id = :'other'),
  'only the business''s own items count');
rollback;

\echo 'All weather rule id tests passed.'
