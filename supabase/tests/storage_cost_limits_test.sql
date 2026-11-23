-- Database tests for 20261118000200_storage_cost_limits.sql: a storage limit in dollars turns into
-- bytes at the price of where files are now, never past the cap, and follows files when they move
-- (the server changes the price, the dollars stay); only owners and admins who manage settings set
-- it, nobody signed in changes it any other way, and the server's own writes keep it; settings.files
-- is the settings area's; a plan file's preview copy counts with it; rate_limit_spend counts amounts
-- and is the server's alone.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tcl;
grant usage on schema tcl to authenticated, service_role;
create function tcl.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tcl.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
create function tcl.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- The limit the gateway holds uploads to.
create function tcl.limit_of(p_company uuid) returns bigint language sql as $$
  select s.company_limit from public.storage_snapshot(p_company, '00000000-0000-0000-0000-000000000000') s
$$;
grant execute on all functions in schema tcl to authenticated, service_role;

\set ann '5f000000-0000-0000-0000-000000000001'
\set ada '5f000000-0000-0000-0000-000000000002'
\set gus '5f000000-0000-0000-0000-000000000003'
\set cy '5f000000-0000-0000-0000-000000000004'

-- Ann owns Hill Paving; Ada is an admin, Gus an admin whose Bookkeeper role doesn't manage
-- settings, and Cy field crew.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ann', 'ann@hill.test', '{"full_name": "Ann Owner"}'),
  (:'ada', 'ada@hill.test', '{"full_name": "Ada Admin"}'),
  (:'gus', 'gus@hill.test', '{"full_name": "Gus Books"}'),
  (:'cy', 'cy@hill.test', '{"full_name": "Cy Crew"}');

begin;
set local role authenticated;
select tcl.as_user(:'ann');
select public.create_company('Hill Paving', 'paving') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as keeper \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as c1 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c1', '14 Oak St') returning id as p1 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'New drive') returning id as j1 \gset
reset role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'ada', 'admin'), (:'co', :'cy', 'field_crew');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'gus', 'admin', :'keeper');
commit;

-- ---------------------------------------------------------------------------------------------
-- A limit in dollars
-- ---------------------------------------------------------------------------------------------

begin;
set local role authenticated;
select tcl.as_user(:'ann');
select tcl.check(tcl.error_of(format('select public.storage_set_limit(%L, ''dollars'', null, 10)', :'co')) like '22023: Crewtavo doesn''t know yet what Railway charges%',
  'a monthly amount waits until the server has said what a GB costs where files are');
commit;

-- The server reads Railway: files on a 5 GB volume, $0.15 a GB-month, and the default 90% of it.
set role service_role;
select public.storage_set_default(:'co', 4500000000, '90% of your 5 GB volume');
select public.storage_set_rate(:'co', 0.15, 4500000000);
reset role;

begin;
set local role authenticated;
select tcl.as_user(:'ann');
select tcl.check(tcl.error_of(format('select public.storage_set_limit(%L, ''dollars'', null, 0)', :'co')) like '22023: Enter what files may cost a month%', 'a monthly amount is more than $0');
select tcl.check(tcl.error_of(format('select public.storage_set_limit(%L, ''dollars'', null, 100001)', :'co')) like '22023: A monthly amount can be $100,000 at most%', 'and $100,000 at most');
select public.storage_set_limit(:'co', 'dollars', null, 0.5);
commit;
select tcl.check(tcl.limit_of(:'co') = 3333333333, 'half a dollar on the volume is 3.3 GB: ' || tcl.limit_of(:'co'));
select tcl.check((select settings -> 'storage' ->> 'limit_dollars' from public.companies where id = :'co') = '0.50', 'the dollars are what''s kept, to the cent');

begin;
set local role authenticated;
select tcl.as_user(:'ada');
select public.storage_set_limit(:'co', 'dollars', null, 10.004);
commit;
select tcl.check(tcl.limit_of(:'co') = 4500000000, '$10 on the volume stops at the cap, 90% of it: ' || tcl.limit_of(:'co'));
select tcl.check((select settings -> 'storage' ->> 'limit_dollars' from public.companies where id = :'co') = '10.00', 'to the cent');

begin;
set local role authenticated;
select tcl.as_user(:'ada');
select tcl.check((public.storage_overview(:'co') ->> 'limit_mode') = 'dollars' and (public.storage_overview(:'co') ->> 'limit_bytes')::bigint = 4500000000,
  'the overview says it''s a monthly amount, and the size it means');
commit;

-- Files move to a bucket: the server says the new price, and the dollars buy ten times the room.
set role service_role;
select public.storage_set_rate(:'co', 0.015, null);
reset role;
select tcl.check(tcl.limit_of(:'co') = 666666666666, 'in a bucket, the same $10 is 667 GB: ' || tcl.limit_of(:'co'));
select tcl.check((select settings -> 'storage' ->> 'limit_dollars' from public.companies where id = :'co') = '10.00', 'and the dollars stay as they were');

-- The server clearing the default (Railway disconnected) leaves the price, so the limit stays.
set role service_role;
select public.storage_set_default(:'co', null, null);
select tcl.check(tcl.error_of(format('select public.storage_set_rate(%L, null, null)', :'co')) like '22023:%', 'a price that isn''t known is never sent');
reset role;
select tcl.check(tcl.limit_of(:'co') = 666666666666, 'a monthly amount doesn''t go when the default does');

-- Nobody signed in changes it but through storage_set_limit; the server's own writes keep it too.
begin;
set local role authenticated;
select tcl.as_user(:'ann');
update public.companies set settings = jsonb_set(public.company_settings(id), '{storage,limit_dollars}', '99999') where id = :'co';
update public.companies set settings = jsonb_set(public.company_settings(id), '{storage,price_per_gb}', '0.0001') where id = :'co';
commit;
select tcl.check(tcl.limit_of(:'co') = 666666666666, 'an owner saving settings can''t change the amount or the price');
update public.companies set settings = jsonb_set(jsonb_set(settings, '{storage,limit_dollars}', '1'), '{hosting_alerts}', '{"bucket": "2026-11-18T00:00:00Z"}') where id = :'co';
select tcl.check((select settings -> 'storage' ->> 'limit_dollars' from public.companies where id = :'co') = '10.00'
  and (select settings -> 'hosting_alerts' ? 'bucket' from public.companies where id = :'co'), 'the server saving its own settings keeps the amount');

begin;
set local role authenticated;
select tcl.as_user(:'gus');
select tcl.check(tcl.error_of(format('select public.storage_set_limit(%L, ''dollars'', null, 1)', :'co')) like '42501:%', 'an admin who doesn''t manage settings can''t set it');
select tcl.as_user(:'cy');
select tcl.check(tcl.error_of(format('select public.storage_set_limit(%L, ''none'')', :'co')) like '42501:%', 'nor can the crew');
select tcl.check(tcl.error_of(format('select public.storage_set_rate(%L, 1, null)', :'co')) like '42501:%', 'and only the server says what storage costs');
commit;

-- Choosing again: a size takes the dollars off, and the default takes both off.
begin;
set local role authenticated;
select tcl.as_user(:'ann');
select public.storage_set_limit(:'co', 'custom', 45000000000);
commit;
select tcl.check((select not (settings -> 'storage' ? 'limit_dollars') from public.companies where id = :'co') and tcl.limit_of(:'co') = 45000000000, 'a size takes the place of the dollars');
begin;
set local role authenticated;
select tcl.as_user(:'ann');
select public.storage_set_limit(:'co', 'dollars', null, 5);
select public.storage_set_limit(:'co', 'default');
select tcl.check((select not (public.company_settings(id) -> 'storage' ?| array['limit_dollars', 'limit_bytes']) from public.companies where id = :'co'), 'and the default takes both off');
commit;

-- An old app's call, with no amount, still works.
begin;
set local role authenticated;
select tcl.as_user(:'ann');
select public.storage_set_limit(p_company => :'co', p_mode => 'none');
select tcl.check((public.storage_overview(:'co') ->> 'limit_mode') = 'none', 'a call without the new argument works as it did');
commit;

-- ---------------------------------------------------------------------------------------------
-- settings.files is the settings area's
-- ---------------------------------------------------------------------------------------------

begin;
set local role authenticated;
select tcl.as_user(:'ada');
update public.companies set settings = public.company_settings(id) || '{"files": {"videos": "office", "video_max_bytes": 50000000}}' where id = :'co';
select tcl.as_user(:'gus');
update public.companies set settings = public.company_settings(id) || '{"files": {"videos": "everyone", "video_max_bytes": 200000000}, "railway_usage_limit": {"set_at": "2026-11-18T00:00:00Z"}}' where id = :'co';
commit;
select tcl.check((select settings -> 'files' ->> 'videos' from public.companies where id = :'co') = 'office', 'an admin who doesn''t manage settings can''t loosen the video rules');
select tcl.check((select settings ? 'railway_usage_limit' from public.companies where id = :'co'), 'while the rest of what they saved is saved');

-- The guard is rebuilt here: what it kept before (the Snow app is the apps area's, the forecast's
-- source the settings area's: 20261113000100_snow_app.sql) is still kept from an admin without them.
begin;
set local role authenticated;
select tcl.as_user(:'ada');
update public.companies set settings = public.company_settings(id) || '{"snow_app": {"enabled": false}, "weather_source": "nws"}' where id = :'co';
select tcl.as_user(:'gus');
update public.companies set settings = public.company_settings(id) || '{"snow_app": {"enabled": true}, "weather_source": "open_meteo"}' where id = :'co';
commit;
select tcl.check((select settings -> 'snow_app' ->> 'enabled' from public.companies where id = :'co') = 'false', 'an admin without the apps area still can''t turn Snow on');
select tcl.check((select settings ->> 'weather_source' from public.companies where id = :'co') = 'nws', 'nor change where the forecast comes from without the settings area');

-- ---------------------------------------------------------------------------------------------
-- A plan file's preview copy counts with it
-- ---------------------------------------------------------------------------------------------

\set pf '5f000000-0000-0000-0000-0000000000f1'
insert into public.plan_files (id, company_id, job_id, title, path, preview_path, file_name, content_type, crew_visible, created_by) values
  (:'pf', :'co', :'j1', 'Site photo', :'co' || '/plans/' || :'pf' || '.jpg', :'co' || '/plans/' || :'pf' || '.preview.webp', 'site.jpg', 'image/jpeg', true, :'ada');
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('files', :'co' || '/plans/' || :'pf' || '.jpg', :'ada', '{"size": 3000}'),
  -- The copy the server stored, for nobody: it counts for whoever added the file.
  ('files', :'co' || '/plans/' || :'pf' || '.preview.webp', null, '{"size": 40}');
set role service_role;
select tcl.check((select s.company_used = 3040 and s.user_used = 3040 from public.storage_snapshot(:'co', :'ada') s), 'a file and its preview copy count for whoever added the file');
reset role;
begin;
set local role authenticated;
select tcl.as_user(:'ann');
select public.drive_trash_file(:'pf');
commit;
set role service_role;
select tcl.check((select s.company_used = 3040 and s.user_used = 0 from public.storage_snapshot(:'co', :'ada') s), 'in the Trash, neither counts toward their own limit, and both still toward the company''s');
reset role;
begin;
set local role authenticated;
select tcl.as_user(:'ann');
select tcl.check((public.storage_overview(:'co') ->> 'trash_bytes')::bigint = 3040, 'and the overview has the copy in the Trash with its file');
commit;
delete from storage.objects where name like :'co' || '/%';

-- ---------------------------------------------------------------------------------------------
-- rate_limit_spend
-- ---------------------------------------------------------------------------------------------

set role service_role;
select tcl.check(public.rate_limit_spend('tcl:link', 600, 1000, 60), 'an amount within the limit goes');
select tcl.check(public.rate_limit_spend('tcl:link', 400, 1000, 60), 'up to the limit');
select tcl.check(not public.rate_limit_spend('tcl:link', 1, 1000, 60), 'one more is over');
select tcl.check(not public.rate_limit_spend('tcl:link', 0, 1000, 60), 'and it stays over until the window is out, asking or not');
select tcl.check(public.rate_limit_spend('tcl:other', 0, 1000, 60), 'each key is its own');
select tcl.check(not public.rate_limit_spend('tcl:big', 5000, 1000, 60), 'one amount bigger than the whole limit is over');
reset role;
select tcl.check((select hits from private.rate_limits where key_hash = sha256(convert_to('tcl:link', 'UTF8'))) = 1001, 'kept just past the limit, never adding up past it');
update private.rate_limits set reset_at = now() - interval '1 second' where key_hash = sha256(convert_to('tcl:link', 'UTF8'));
set role service_role;
select tcl.check(public.rate_limit_spend('tcl:link', 10, 1000, 60), 'a new window starts over');
reset role;
begin;
set local role authenticated;
select tcl.as_user(:'ann');
select tcl.check(tcl.error_of('select public.rate_limit_spend(''tcl:x'', 1, 10, 60)') like '42501:%', 'the server''s alone');
commit;
delete from private.rate_limits where key_hash in (sha256(convert_to('tcl:link', 'UTF8')), sha256(convert_to('tcl:other', 'UTF8')), sha256(convert_to('tcl:big', 'UTF8')));

delete from public.companies where id = :'co';

set client_min_messages = warning;
drop schema tcl cascade;
reset client_min_messages;

\o
\echo 'All storage cost limits tests passed.'
