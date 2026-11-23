-- Database tests for 20261123100700_own_pay_in_pay_periods.sql: someone's own line in a pay period
-- (what they were paid for it, and that they were) and the approval of their own time are an
-- owner's, as their pay rate is. Everyone else's are handled as before.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1123p;
grant usage on schema t1123p to authenticated, service_role;
create function t1123p.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "code: message", or 'none'.
create function t1123p.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1123p.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1123p to authenticated, service_role;

\set olive '11230000-0000-4000-8000-000000000301'
\set ada '11230000-0000-4000-8000-000000000302'
\set opal '11230000-0000-4000-8000-000000000303'
\set lee '11230000-0000-4000-8000-000000000304'
\set cy '11230000-0000-4000-8000-000000000305'

-- Olive owns Pine Painting: Ada is an admin, Opal office, Lee a crew lead with the timesheets area,
-- and Cy field crew.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@pine.test', '{"full_name": "Olive Owner"}'),
  (:'ada', 'ada@pine.test', '{"full_name": "Ada Admin"}'),
  (:'opal', 'opal@pine.test', '{"full_name": "Opal Office"}'),
  (:'lee', 'lee@pine.test', '{"full_name": "Lee Lead"}'),
  (:'cy', 'cy@pine.test', '{"full_name": "Cy Crew"}');

begin;
set local role authenticated;
select t1123p.as_user(:'olive');
select public.create_company('Pine Painting', 'general') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Lead with timesheets', 'crew_lead', '{timesheets}') returning id as lead_role \gset
commit;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'ada', 'admin', null), (:'co', :'opal', 'office', null), (:'co', :'lee', 'crew_lead', :'lead_role'), (:'co', :'cy', 'field_crew', null);
-- Everyone's finished time this week, none approved yet.
insert into public.time_entries (company_id, user_id, started_at, ended_at)
select :'co', u, now() - interval '5 hours', now() - interval '1 hour' from unnest(array[:'olive', :'ada', :'opal', :'lee', :'cy']::uuid[]) u;
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', current_date - 7, current_date) returning id as period \gset

\o
\echo 'Your own time'
\o /dev/null

-- ===== Your own time ============================================================================
begin;
set local role authenticated;
select t1123p.as_user(:'ada');
select t1123p.check(t1123p.error_of(format('update public.time_entries set approved_at = now(), approved_by = %L where company_id = %L and user_id = %L', :'ada', :'co', :'ada'))
    = '22023: An owner approves your own time.', 'an admin can''t approve their own time');
select t1123p.as_user(:'opal');
select t1123p.check(t1123p.error_of(format('update public.time_entries set approved_at = now(), approved_by = %L where company_id = %L and user_id = %L', :'opal', :'co', :'opal'))
    like '22023: An owner approves your own time.', 'nor the office theirs');
select t1123p.check(t1123p.error_of(format('insert into public.time_entries (company_id, user_id, started_at, ended_at, approved_at) values (%L, %L, now() - interval ''2 hours'', now() - interval ''1 hour'', now())', :'co', :'opal'))
    like '22023: An owner approves your own time.', 'nor adds their own time already approved');
select t1123p.as_user(:'lee');
select t1123p.check(t1123p.error_of(format('update public.time_entries set approved_at = now() where company_id = %L and user_id = %L', :'co', :'lee'))
    = '22023: The office approves your own time.', 'a crew lead still can''t approve their own, as before');
-- Everyone else's, as before: the office approves the team's, the admin the office's.
select t1123p.as_user(:'opal');
update public.time_entries set approved_at = now(), approved_by = :'opal' where company_id = :'co' and user_id in (:'cy', :'lee', :'ada');
select t1123p.as_user(:'ada');
update public.time_entries set approved_at = now(), approved_by = :'ada' where company_id = :'co' and user_id = :'opal';
select t1123p.as_user(:'olive');
update public.time_entries set approved_at = now(), approved_by = :'olive' where company_id = :'co' and user_id = :'olive';
select t1123p.check((select bool_and(approved_at is not null) from public.time_entries where company_id = :'co'),
  'everyone else''s time is approved as before, and the owner approves their own');
commit;

-- Taking an approval back is left as it was.
begin;
set local role authenticated;
select t1123p.as_user(:'ada');
update public.time_entries set approved_at = null, approved_by = null where company_id = :'co' and user_id = :'ada';
select t1123p.check((select approved_at is null from public.time_entries where company_id = :'co' and user_id = :'ada'), 'an admin can still take the approval off their own time');
rollback;

\o
\echo 'Your own line in a pay period'
\o /dev/null

-- ===== Your own line in a pay period ============================================================
begin;
set local role authenticated;
select t1123p.as_user(:'ada');
select t1123p.check(t1123p.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at, paid_by) values (%L, %L, %L, 80, 99999, 99999, %L, now(), %L)',
  :'co', :'period', :'ada', 'check', :'ada')) = '42501: Ask an owner to set your own pay', 'an admin can''t record and mark paid their own pay for a period');
select t1123p.as_user(:'opal');
select t1123p.check(t1123p.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount) values (%L, %L, %L, 4, 80)', :'co', :'period', :'opal'))
    like '42501: Ask an owner%', 'nor the office theirs');
-- The office records everyone else's, as before: Cy, Lee and the admin.
insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at, paid_by)
select :'co', :'period', u, 4, 80, 80, 'check', now(), :'opal' from unnest(array[:'cy', :'lee', :'ada']::uuid[]) u;
select t1123p.check((select count(*) = 3 from public.pay_period_lines where period_id = :'period'), 'the office records the rest of the team''s pay for the period');
select t1123p.as_user(:'ada');
select t1123p.check(t1123p.error_of(format('update public.pay_period_lines set paid_amount = 99999 where period_id = %L and user_id = %L', :'period', :'ada'))
    like '42501: Ask an owner%', 'an admin can''t change their own line someone else wrote');
select t1123p.check(t1123p.error_of(format('update public.pay_period_lines set paid_at = null, paid_amount = null, method = null where period_id = %L and user_id = %L', :'period', :'ada'))
    like '42501: Ask an owner%', 'or take its paid mark back');
select t1123p.check(t1123p.error_of(format('update public.pay_period_lines set user_id = %L where period_id = %L and user_id = %L', :'ada', :'period', :'cy'))
    like '42501: Ask an owner%', 'or move someone else''s line onto themselves');
select t1123p.check(t1123p.error_of(format('delete from public.pay_period_lines where period_id = %L and user_id = %L', :'period', :'ada')) like '42501: Ask an owner%',
  'or remove it');
update public.pay_period_lines set paid_at = null, paid_amount = null, method = null, paid_by = null where period_id = :'period' and user_id = :'cy';
select t1123p.check((select paid_at is null from public.pay_period_lines where period_id = :'period' and user_id = :'cy'), 'but handles everyone else''s, as before');
-- The owner records the office's and their own.
select t1123p.as_user(:'olive');
insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at, paid_by)
select :'co', :'period', u, 4, 120, 120, 'check', now(), :'olive' from unnest(array[:'opal', :'olive']::uuid[]) u;
update public.pay_period_lines set reference = 'Run 7' where period_id = :'period' and user_id = :'olive';
select t1123p.check((select reference = 'Run 7' from public.pay_period_lines where period_id = :'period' and user_id = :'olive')
    and exists (select 1 from public.pay_period_lines where period_id = :'period' and user_id = :'opal'), 'the owner records the office''s pay and their own');
commit;
