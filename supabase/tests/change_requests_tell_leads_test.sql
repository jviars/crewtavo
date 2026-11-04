-- Database tests for change requests telling the crew's lead (20261106000420_change_requests_tell_leads):
-- a client's request to move or cancel a visit tells the lead of the visit's crew, who can answer it,
-- as well as the owner and the office; not another crew's lead, nor a lead who has left; and someone
-- who is both is told once.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_crl;
grant usage on schema t_crl to authenticated, service_role;
create function t_crl.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- Who was told about a request for this visit, in order.
create function t_crl.told(p_visit uuid) returns uuid[] language sql as $$
  select array_agg(n.user_id order by n.user_id) from public.notifications n
  where n.kind = 'client' and n.link like '%&visit=' || p_visit::text
$$;
grant execute on all functions in schema t_crl to authenticated, service_role;

-- Tess owns Teal Yards and leads the West crew herself; Olga is in its office; Lou leads North, Kip
-- leads South, and Ida led East but has left. Neither lead schedules the whole team.
insert into auth.users (id, email, raw_user_meta_data) values
  ('e7d40000-0000-0000-0000-000000000001', 'tess@teal-yards.test', '{"full_name": "Tess Teal"}'),
  ('e7d40000-0000-0000-0000-000000000002', 'olga@teal-yards.test', '{"full_name": "Olga Office"}'),
  ('e7d40000-0000-0000-0000-000000000003', 'lou@teal-yards.test', '{"full_name": "Lou North"}'),
  ('e7d40000-0000-0000-0000-000000000004', 'kip@teal-yards.test', '{"full_name": "Kip South"}'),
  ('e7d40000-0000-0000-0000-000000000005', 'ida@teal-yards.test', '{"full_name": "Ida East"}');
\set tess 'e7d40000-0000-0000-0000-000000000001'
\set olga 'e7d40000-0000-0000-0000-000000000002'
\set lou 'e7d40000-0000-0000-0000-000000000003'
\set kip 'e7d40000-0000-0000-0000-000000000004'
\set ida 'e7d40000-0000-0000-0000-000000000005'

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7d40000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Teal Yards', 'general') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Teal crew lead', 'crew_lead', '{timesheets}') returning id as own_crew \gset
insert into public.memberships (company_id, user_id, role, role_id, active) values
  (:'co', :'olga', 'office', null, true),
  (:'co', :'lou', 'crew_lead', :'own_crew', true),
  (:'co', :'kip', 'crew_lead', :'own_crew', true),
  (:'co', :'ida', 'crew_lead', :'own_crew', false);
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'North', :'lou') returning id as north \gset
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'South', :'kip');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'East', :'ida') returning id as east \gset
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'West', :'tess') returning id as west \gset
insert into public.clients (company_id, display_name) values (:'co', 'Rae Crl') returning id as rae \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'rae', 'Fall cleanup') returning id as job \gset
select private.company_today(:'co') + 2 as later \gset
insert into public.visits (company_id, job_id, title, crew_id, scheduled_on) values (:'co', :'job', 'North visit', :'north', :'later') returning id as v_north \gset
insert into public.visits (company_id, job_id, title, crew_id, scheduled_on) values (:'co', :'job', 'East visit', :'east', :'later') returning id as v_east \gset
insert into public.visits (company_id, job_id, title, crew_id, scheduled_on) values (:'co', :'job', 'West visit', :'west', :'later') returning id as v_west \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'job', 'Nobody''s visit', :'later') returning id as v_none \gset
commit;

begin;
set local role service_role;
insert into public.visit_change_requests (company_id, visit_id, client_id, kind, reason) values
  (:'co', :'v_north', :'rae', 'cancel', 'Moving'), (:'co', :'v_east', :'rae', 'cancel', null),
  (:'co', :'v_west', :'rae', 'cancel', null), (:'co', :'v_none', :'rae', 'cancel', null);
commit;
\o
\echo 'Who is told'
\o /dev/null
select t_crl.check(t_crl.told(:'v_north') = array[:'tess', :'olga', :'lou']::uuid[], 'the lead of the visit''s crew is told, with the owner and the office, not another crew''s lead');
select t_crl.check(t_crl.told(:'v_east') = array[:'tess', :'olga']::uuid[], 'a lead who has left isn''t');
select t_crl.check(t_crl.told(:'v_west') = array[:'tess', :'olga']::uuid[], 'an owner who leads the crew is told once');
select t_crl.check(t_crl.told(:'v_none') = array[:'tess', :'olga']::uuid[], 'a visit on no crew tells the owner and the office');
select t_crl.check((select bool_and(n.link = '/schedule?date=' || :'later' || '&visit=' || :'v_north' and n.title = 'Rae Crl asked to cancel North visit' and n.body like '% Reason: Moving')
  from public.notifications n where n.link like '%&visit=' || :'v_north'), 'the lead''s notice is the office''s: what was asked, opening the visit');

\echo 'All change request lead tests passed.'
