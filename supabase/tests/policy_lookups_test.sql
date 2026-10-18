-- Database tests for 20261018000990_policy_lookups.sql: policies check each row against the
-- person's companies, looked up once per query, and give the same answers as the per-row checks.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t60;
grant usage on schema t60 to authenticated, service_role;
create function t60.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema t60 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b6000000-0000-0000-0000-000000000001', 'owner@lima.test', '{"full_name": "Lo Owner"}'),
  ('b6000000-0000-0000-0000-000000000002', 'owner@mike.test', '{"full_name": "Mo Owner"}'),
  ('b6000000-0000-0000-0000-000000000003', 'both@lima.test', '{"full_name": "Bo Th"}'),
  ('b6000000-0000-0000-0000-000000000004', 'hr@lima.test', '{"full_name": "Hari Admin"}'),
  ('b6000000-0000-0000-0000-000000000005', 'gone@lima.test', '{"full_name": "Gone Away"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Lima Lawn', 'general') as lima \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'lima', 'HR admin', 'admin', '{team}') returning id as hr_role \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'lima', 'b6000000-0000-0000-0000-000000000003', 'office', null),
  (:'lima', 'b6000000-0000-0000-0000-000000000004', 'admin', :'hr_role'),
  (:'lima', 'b6000000-0000-0000-0000-000000000005', 'office', null);
update public.memberships set active = false where company_id = :'lima' and user_id = 'b6000000-0000-0000-0000-000000000005';
insert into public.clients (company_id, display_name) values (:'lima', 'Lima client');
insert into public.invoices (company_id, client_id, status, total, balance_due)
  select :'lima', id, 'sent', 100, 100 from public.clients where company_id = :'lima';
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.create_company('Mike Mowing', 'general') as mike \gset
insert into public.memberships (company_id, user_id, role) values (:'mike', 'b6000000-0000-0000-0000-000000000003', 'field_crew');
commit;

\o
\echo 'Policy lookups'
\o /dev/null

-- The lists give the same answer as the per-row checks, for every person, company, level and area.
begin;
create temp table t60_answers (who uuid, company uuid, what text, per_row boolean, listed boolean);
create temp table t60_companies as select id from public.companies union all select null;
create temp table t60_people as select id from auth.users where id::text like 'b6000000-%';
grant all on t60_answers, t60_companies, t60_people to authenticated;
set local role authenticated;
do $$
declare
  u uuid;
  co uuid;
  r public.member_role[];
  a text;
begin
  for u in select id from t60_people loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    for co in select id from t60_companies loop
      insert into t60_answers values (u, co, 'member', private.is_member(co), co = any (private.member_companies()));
      foreach r slice 1 in array array[['owner','owner'], ['owner','admin'], ['office','office'], ['field_crew','crew_lead']]::public.member_role[][] loop
        insert into t60_answers values (u, co, r::text, private.has_role(co, r), co = any (private.role_companies(r)));
      end loop;
      foreach a in array array['invoices', 'team', 'apps', 'schedule', 'nothing'] loop
        insert into t60_answers values (u, co, a, private.has_perm(co, a), co = any (private.perm_companies(a)));
      end loop;
    end loop;
  end loop;
end $$;
reset role;
select t60.check((select count(*) from t60_answers) = 5 * (select count(*) from t60_companies) * 10, 'every person, company and question was asked');
select t60.check(not exists (select 1 from t60_answers where per_row is distinct from coalesce(listed, false)),
  'the company lists answer exactly as has_role, has_perm and is_member do');
select t60.check((select count(*) from t60_answers where per_row) > 10, 'and some of those answers are yes');
rollback;

-- No policy is left checking membership per row.
select t60.check(not exists (
  select 1 from pg_policy p join pg_class t on t.oid = p.polrelid join pg_namespace n on n.oid = t.relnamespace
  where n.nspname in ('public', 'storage')
    and concat(pg_get_expr(p.polqual, p.polrelid), ' ', pg_get_expr(p.polwithcheck, p.polrelid)) ~ 'private\.(has_role|has_perm|is_member)\('),
  'no policy calls has_role, has_perm or is_member for each row (end a migration that adds one with select private.fold_member_checks())');
select t60.check(private.fold_member_checks() = 0, 'running the rewrite again changes nothing');

-- A policy added the old way is rewritten, and still lets in exactly who it did.
create table public.t60_notes (id serial primary key, company_id uuid not null, body text);
alter table public.t60_notes enable row level security;
grant select on public.t60_notes to authenticated;
create policy t60_notes_read on public.t60_notes for select to authenticated
  using (private.has_role(company_id, '{owner,office}') and private.is_member(company_id));
insert into public.t60_notes (company_id, body) select id, name from public.companies where name in ('Lima Lawn', 'Mike Mowing');
select t60.check(private.fold_member_checks() = 1, 'the new policy is rewritten');
select t60.check(pg_get_expr(polqual, polrelid) ~ 'role_companies' and pg_get_expr(polqual, polrelid) ~ 'member_companies', 'to check against the lists')
from pg_policy where polname = 't60_notes_read';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t60.check((select array_agg(body) from public.t60_notes) = '{Lima Lawn}', 'office in one company and crew in another reads only the first');
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t60.check(not exists (select 1 from public.t60_notes), 'an inactive member reads nothing');
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t60.check((select array_agg(body) from public.t60_notes) = '{Mike Mowing}', 'an owner reads their own company''s');
rollback;
drop table public.t60_notes;

\o
\echo 'All policy lookup tests passed.'
