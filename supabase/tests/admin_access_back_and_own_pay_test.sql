-- Database tests for 20261123100300_admin_access_back_and_own_pay.sql: turning a removed member's
-- access back on is giving admin access when their role is (or has since become) admin-level, so the
-- browser can't do it without the minute the server opens once the password checks out; and only an
-- owner changes their own pay: their pay rate, their piece rates and the pay on a job for them.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1122a;
grant usage on schema t1122a to authenticated, service_role;
create function t1122a.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "code: message", or 'none'.
create function t1122a.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1122a.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- What the server does once the signed-in person's password checks out (POST /api/team/:id/restore).
create function t1122a.password_ok(p_company uuid, p_target uuid) returns void language sql security definer set search_path = '' as $$
  select public.admin_grant_allow(auth.uid(), p_company, p_target)
$$;
-- A member's pay rate, as saved: the browser's role doesn't read the column (20261017000800_pay_rate_privacy.sql).
create function t1122a.rate(p_company uuid, p_user uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select m.labor_rate from public.memberships m where m.company_id = p_company and m.user_id = p_user
$$;
grant execute on all functions in schema t1122a to authenticated, service_role;

\set olive '11220000-0000-4000-8000-000000000201'
\set ada '11220000-0000-4000-8000-000000000202'
\set bea '11220000-0000-4000-8000-000000000203'
\set sam '11220000-0000-4000-8000-000000000204'
\set ari '11220000-0000-4000-8000-000000000205'
\set opal '11220000-0000-4000-8000-000000000206'
\set cy '11220000-0000-4000-8000-000000000207'

-- Olive owns Gale Gutters: Ada is a plain admin, Bea an admin as a Bookkeeper (invoices and reports
-- only, not admin-level), Sam has the Spare role (based on admin, invoices only), Ari is another plain
-- admin, Opal is office and Cy field crew.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@gale.test', '{"full_name": "Olive Owner"}'),
  (:'ada', 'ada@gale.test', '{"full_name": "Ada Admin"}'),
  (:'bea', 'bea@gale.test', '{"full_name": "Bea Books"}'),
  (:'sam', 'sam@gale.test', '{"full_name": "Sam Spare"}'),
  (:'ari', 'ari@gale.test', '{"full_name": "Ari Admin"}'),
  (:'opal', 'opal@gale.test', '{"full_name": "Opal Office"}'),
  (:'cy', 'cy@gale.test', '{"full_name": "Cy Crew"}');

begin;
set local role authenticated;
select t1122a.as_user(:'olive');
select public.create_company('Gale Gutters', 'general') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as books \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Spare', 'admin', '{invoices}') returning id as spare \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'New gutters') returning id as job \gset
commit;
-- Sign-ins as the server makes them (admin access is given through the server).
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'ada', 'admin', null), (:'co', :'bea', 'admin', :'books'), (:'co', :'sam', 'admin', :'spare'), (:'co', :'ari', 'admin', null),
  (:'co', :'opal', 'office', null), (:'co', :'cy', 'field_crew', null);
-- Ada, Bea and Sam have had their access taken away.
update public.memberships set active = false where company_id = :'co' and user_id in (:'ada', :'bea', :'sam');

\o
\echo 'Admin access given back'
\o /dev/null

-- ===== Admin access given back ==================================================================
begin;
set local role authenticated;
select t1122a.as_user(:'olive');
select t1122a.check(t1122a.error_of(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', :'ada'))
    = '42501: Give admin access from Settings → People', 'the browser can''t turn a removed admin''s access back on by itself');
update public.memberships set active = true where company_id = :'co' and user_id = :'bea';
select t1122a.check((select active from public.memberships where company_id = :'co' and user_id = :'bea'),
  'a removed member whose role isn''t admin-level comes back as before');
commit;

-- The Spare role becomes admin-level while Sam is away (the server, after the password).
update public.company_roles set permissions = '{invoices,team}' where id = :'spare';
begin;
set local role authenticated;
select t1122a.as_user(:'olive');
select t1122a.check(t1122a.error_of(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', :'sam')) like '42501: Give admin access%',
  'nor someone whose role became admin-level while they were away');
select t1122a.password_ok(:'co', :'sam');
select t1122a.check(t1122a.error_of(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', :'ada')) like '42501: Give admin access%',
  'the minute opened for someone else doesn''t bring Ada back');
select t1122a.password_ok(:'co', :'ada');
update public.memberships set active = true where company_id = :'co' and user_id = :'ada';
select t1122a.check((select active from public.memberships where company_id = :'co' and user_id = :'ada'), 'once the server opens the minute for Ada, her access comes back');
-- Taking it away again needs no password, as before.
update public.memberships set active = false where company_id = :'co' and user_id = :'ada';
select t1122a.check((select not active from public.memberships where company_id = :'co' and user_id = :'ada'), 'taking admin access away needs no password');
commit;

begin;
set local role authenticated;
select t1122a.as_user(:'ari');
select t1122a.check(t1122a.error_of(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', :'ada')) like '42501: Give admin access%',
  'an admin can''t bring an admin back without it either');
rollback;

-- The server brings anyone back.
update public.memberships set active = true where company_id = :'co' and user_id in (:'ada', :'sam');
select t1122a.check((select bool_and(active) from public.memberships where company_id = :'co' and user_id in (:'ada', :'sam')), 'the server brings anyone back');

\o
\echo 'Your own pay'
\o /dev/null

-- ===== Your own pay rate ========================================================================
begin;
set local role authenticated;
select t1122a.as_user(:'ari');
select t1122a.check(t1122a.error_of(format('update public.memberships set labor_rate = 99 where company_id = %L and user_id = %L', :'co', :'ari'))
    = '42501: Ask an owner to change your own role, access or pay', 'an admin can''t change their own pay rate');
update public.memberships set labor_rate = 31 where company_id = :'co' and user_id = :'opal';
select t1122a.check(t1122a.rate(:'co', :'opal') = 31, 'but sets the office''s, as before');
select t1122a.as_user(:'olive');
update public.memberships set labor_rate = 45 where company_id = :'co' and user_id = :'olive';
update public.memberships set labor_rate = 40 where company_id = :'co' and user_id = :'ari';
select t1122a.check(t1122a.rate(:'co', :'olive') = 45 and t1122a.rate(:'co', :'ari') = 40,
  'the owner sets their own and an admin''s');
commit;

-- ===== Piece rates and pay on a job =============================================================
begin;
set local role authenticated;
select t1122a.as_user(:'olive');
insert into public.pay_rates (company_id, user_id, basis, rate) values (:'co', :'opal', 'per_job', 50) returning id as opal_rate \gset
insert into public.pay_rates (company_id, user_id, basis, rate) values (:'co', :'olive', 'per_job', 80) returning id as olive_rate \gset
insert into public.job_pay (company_id, job_id, user_id) values (:'co', :'job', :'opal') returning id as opal_pay \gset
insert into public.job_pay (company_id, job_id, user_id) values (:'co', :'job', :'olive') returning id as olive_pay \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) values (:'co', :'olive_pay', 'Own work', 1, 80);
select t1122a.check((select count(*) = 2 from public.pay_rates where id in (:'opal_rate', :'olive_rate')) and (select count(*) = 2 from public.job_pay where id in (:'opal_pay', :'olive_pay')),
  'the owner sets the office''s pay and their own');
commit;

begin;
set local role authenticated;
select t1122a.as_user(:'opal');
select t1122a.check(t1122a.error_of(format('insert into public.pay_rates (company_id, user_id, basis, rate) values (%L, %L, %L, 500)', :'co', :'opal', 'per_job'))
    = '42501: Ask an owner to set your own pay', 'the office can''t give themselves a piece rate');
select t1122a.check(t1122a.error_of(format('update public.pay_rates set rate = 500 where id = %L', :'opal_rate')) like '42501: Ask an owner%', 'or raise their own');
select t1122a.check(t1122a.error_of(format('delete from public.pay_rates where id = %L', :'opal_rate')) like '42501: Ask an owner%', 'or take it away');
select t1122a.check(t1122a.error_of(format('insert into public.job_pay (company_id, job_id, user_id) values (%L, %L, %L)', :'co', :'job', :'opal')) like '42501: Ask an owner%',
  'or put pay on a job for themselves');
select t1122a.check(t1122a.error_of(format('insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) values (%L, %L, %L, 1, 900)', :'co', :'opal_pay', 'Bonus'))
    like '42501: Ask an owner%', 'or add to the pay on a job for them');
select t1122a.check(t1122a.error_of(format('update public.job_pay set notes = %L where id = %L', 'Mine', :'opal_pay')) like '42501: Ask an owner%', 'or change it');
select t1122a.check(t1122a.error_of(format('select public.job_pay_start(%L, null, %L)', :'job', :'opal')) like '42501:%',
  'and the functions that start, change and finish pay on a job don''t handle their own');
insert into public.pay_rates (company_id, user_id, basis, rate) values (:'co', :'cy', 'per_job', 25) returning id as cy_rate \gset
insert into public.job_pay (company_id, job_id, user_id) values (:'co', :'job', :'cy') returning id as cy_pay \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) values (:'co', :'cy_pay', 'Gutter run', 1, 25);
select t1122a.check((select count(*) = 1 from public.job_pay_lines where job_pay_id = :'cy_pay'), 'the office still handles everyone else''s pay');
select t1122a.as_user(:'ari');
select t1122a.check(t1122a.error_of(format('insert into public.pay_rates (company_id, user_id, basis, rate) values (%L, %L, %L, 500)', :'co', :'ari', 'per_job')) like '42501: Ask an owner%',
  'nor does an admin give themselves a rate');
select t1122a.as_user(:'olive');
update public.job_pay set notes = 'Owner''s own' where id = :'olive_pay';
update public.pay_rates set rate = 85 where id = :'olive_rate';
select t1122a.check((select rate = 85 from public.pay_rates where id = :'olive_rate') and (select notes = 'Owner''s own' from public.job_pay where id = :'olive_pay'),
  'the owner changes their own');
rollback;
-- The server sets anyone's.
update public.memberships set labor_rate = 50 where company_id = :'co' and user_id = :'ari';
update public.pay_rates set rate = 55 where id = :'opal_rate';
select t1122a.check(t1122a.rate(:'co', :'ari') = 50 and (select rate = 55 from public.pay_rates where id = :'opal_rate'),
  'and the server sets anyone''s');
