-- Database tests for plans and files: a file on a quote takes the quote's property and goes on the
-- job when the quote becomes one, new versions supersede the old and crews only see current files
-- marked for them, crew leads add files but can't reach office-only ones, the crew on the job hears
-- about new ones, and taking a version out puts the history back together.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tpf;
grant usage on schema tpf to authenticated, service_role;
create function tpf.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tpf.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- A storage path for one of the company's plan files.
create function tpf.path(p_company uuid, p_ext text default 'pdf') returns text language sql as $$
  select p_company || '/plans/' || gen_random_uuid() || '.' || p_ext
$$;
grant execute on all functions in schema tpf to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('ef000000-0000-0000-0000-000000000001', 'owner@papa.test', '{"full_name": "Pat Owner"}'),
  ('ef000000-0000-0000-0000-000000000002', 'lead@papa.test', '{"full_name": "Lee Foreman"}'),
  ('ef000000-0000-0000-0000-000000000003', 'crew@papa.test', '{"full_name": "Cal Crew"}'),
  ('ef000000-0000-0000-0000-000000000004', 'other@papa.test', '{"full_name": "Oz Other"}'),
  ('ef000000-0000-0000-0000-000000000005', 'owner@romeo.test', '{"full_name": "Rae Romeo"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select public.create_company('Romeo Paving', 'paving') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Their Client') returning id as other_client \gset
insert into public.jobs (company_id, client_id, title) values (:'other', :'other_client', 'Their job') returning id as other_job \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Papa Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'ef000000-0000-0000-0000-000000000002', 'crew_lead'),
  (:'co', 'ef000000-0000-0000-0000-000000000003', 'field_crew'),
  (:'co', 'ef000000-0000-0000-0000-000000000004', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Steel Works') returning id as client \gset
insert into public.properties (company_id, client_id, line1, city) values (:'co', :'client', '160 Mill Rd', 'Rocky Mount') returning id as prop \gset
insert into public.quotes (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Plant parking lot') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'quote', 'Overlay', 400, 'ton', 140);

-- ===== Where a file belongs ===================================================================
insert into public.plan_files (company_id, quote_id, title, path, file_name, content_type, size_bytes)
  values (:'co', :'quote', 'Site plan', tpf.path(:'co'), 'C-101 Site Plan.pdf', 'application/pdf', 48000000) returning id as site \gset
select tpf.check((select property_id = :'prop' and crew_visible and superseded_at is null from public.plan_files where id = :'site'), 'a file on a quote takes the quote''s property, and the crew can see it unless the office says otherwise');
insert into public.plan_files (company_id, quote_id, title, path, file_name, crew_visible)
  values (:'co', :'quote', 'Bid form', tpf.path(:'co'), 'Bid form.pdf', false) returning id as bid \gset
insert into public.plan_files (company_id, property_id, title, path, file_name)
  values (:'co', :'prop', 'Old striping layout', tpf.path(:'co', 'png'), 'striping.png') returning id as striping \gset

select tpf.expect_error(format('insert into public.plan_files (company_id, title, path, file_name) values (%L, %L, %L, %L)', :'co', 'Loose', tpf.path(:'co'), 'x.pdf'), 'a file goes on a property, quote or job');
select tpf.expect_error(format('insert into public.plan_files (company_id, quote_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'quote', 'Receipt', :'co' || '/receipts/' || gen_random_uuid() || '.pdf', 'x.pdf'), 'the file is a plan file, never a receipt');
select tpf.expect_error(format('insert into public.plan_files (company_id, quote_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'quote', 'Theirs', tpf.path(:'other'), 'x.pdf'), 'and this company''s');
select tpf.expect_error(format('insert into public.plan_files (company_id, quote_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'quote', 'Climb', :'co' || '/plans/../receipts/x.pdf', 'x.pdf'), 'no climbing out of the folder');
select tpf.expect_error(format('insert into public.plan_files (company_id, job_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'other_job', 'Wrong job', tpf.path(:'co'), 'x.pdf'), 'not on another company''s job');

-- ===== Quote to job, and telling the crew =====================================================
select public.convert_quote_to_job(:'quote') as job \gset
select tpf.check((select count(*) from public.plan_files where job_id = :'job') = 2, 'when the quote becomes a job, its files go on the job');
select tpf.check((select quote_id = :'quote' from public.plan_files where id = :'site'), 'and stay on the quote too');
select tpf.check((select job_id is null from public.plan_files where id = :'striping'), 'a file on the property alone stays there');
insert into public.visits (company_id, job_id, title, starts_at, ends_at) values (:'co', :'job', 'Paving day', now() + interval '1 day', now() + interval '1 day 8 hours') returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'ef000000-0000-0000-0000-000000000003');

insert into public.plan_files (company_id, replaces_id, title, revision, path, file_name)
  values (:'co', :'site', 'Site plan', 'Rev B', tpf.path(:'co'), 'C-101 Site Plan rev B.pdf') returning id as site2 \gset
select tpf.check((select superseded_at is not null from public.plan_files where id = :'site'), 'a new version supersedes the old one');
select tpf.check((select job_id = :'job' and quote_id = :'quote' and property_id = :'prop' and superseded_at is null from public.plan_files where id = :'site2'), 'and goes where the old one was');
select tpf.expect_error(format('insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'site', 'Site plan', tpf.path(:'co'), 'y.pdf'), 'an old version can''t get a second new version');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'job', 'Pavement sections', tpf.path(:'co'), 'C-501.pdf') returning id as sections \gset
insert into public.plan_files (company_id, job_id, title, path, file_name, archived) values (:'co', :'job', 'Geotech report', tpf.path(:'co'), 'geo.pdf', true) returning id as geo \gset

-- What a file is doesn't change by hand.
update public.plan_files set path = tpf.path(:'co'), file_name = 'renamed.pdf', superseded_at = null, replaces_id = null, title = 'Site plan (Rev A)' where id = :'site';
select tpf.check((select file_name = 'C-101 Site Plan.pdf' and superseded_at is not null and title = 'Site plan (Rev A)' from public.plan_files where id = :'site'), 'renaming works, but the file, its history and being superseded stay as they were');
commit;

-- ===== The crew on the job ====================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select tpf.check((select array_agg(title order by title) from public.plan_files where company_id = :'co') = array['Old striping layout', 'Pavement sections', 'Site plan'], 'the crew on the job sees the current files for it and its property, not old versions, office-only or put-away ones');
select tpf.check((select count(*) from public.plan_files where id in (:'site', :'bid', :'geo')) = 0, 'old versions, the bid form and archived files stay hidden');
select tpf.check((select count(*) from public.notifications where user_id = 'ef000000-0000-0000-0000-000000000003' and body like '%New version of Site plan for job #%: Rev B%' and body like '%Pavement sections added to job #%') = 1, 'the crew on the job hears about the new version and the new file, in one notification');
select tpf.expect_error(format('insert into public.plan_files (company_id, job_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'job', 'Mine', tpf.path(:'co'), 'mine.pdf'), 'crews can''t add files');
update public.plan_files set title = 'Changed' where id = :'site2';
select tpf.check((select title = 'Site plan' from public.plan_files where id = :'site2'), 'or change them');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tpf.check((select count(*) from public.plan_files where company_id = :'co') = 0, 'someone not on the work sees none of it');
select tpf.check((select count(*) from public.notifications where user_id = 'ef000000-0000-0000-0000-000000000004') = 0, 'and hears nothing');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpf.check((select count(*) from public.notifications where user_id = 'ef000000-0000-0000-0000-000000000001') = 0, 'whoever added the files isn''t told about them');
commit;

-- ===== The crew lead ==========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tpf.check((select count(*) from public.plan_files where company_id = :'co') = 3, 'the crew lead sees every current file marked for the crew');
insert into public.plan_files (company_id, job_id, title, path, file_name, content_type) values (:'co', :'job', 'Field sketch', tpf.path(:'co', 'jpg'), 'sketch.jpg', 'image/jpeg') returning id as sketch \gset
select tpf.check((select property_id = :'prop' from public.plan_files where id = :'sketch'), 'the crew lead adds a file to the job, and it lands on the property too');
insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (:'co', :'sections', 'Pavement sections', tpf.path(:'co'), 'C-501 rev.pdf') returning id as sections2 \gset
select tpf.check((select count(*) from public.plan_files where id = :'sections') = 0, 'and a new version (the old one drops out of sight)');
select tpf.expect_error(format('insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'bid', 'Bid form', tpf.path(:'co'), 'bid2.pdf'), 'but not a version of an office-only file');
delete from public.plan_files where id = :'site2';
commit;
select tpf.check((select count(*) from public.plan_files where id = :'site2') = 1, 'the crew lead can''t remove the office''s files');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
delete from public.plan_files where id = :'sketch';
select tpf.check((select count(*) from public.plan_files where id = :'sketch') = 0, 'but removes one they added');
commit;

-- ===== Taking versions out ====================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.plan_files where id = :'sections2';
select tpf.check((select superseded_at is null from public.plan_files where id = :'sections'), 'removing the current version makes the one before current again');

insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (:'co', :'site2', 'Site plan', tpf.path(:'co'), 'C-101 rev C.pdf') returning id as site3 \gset
delete from public.plan_files where id = :'site2';
commit;
select tpf.check((select replaces_id = :'site' from public.plan_files where id = :'site3'), 'removing a version in the middle joins the history up');
select tpf.check((select superseded_at is null from public.plan_files where id = :'site3') and (select superseded_at is not null from public.plan_files where id = :'site'), 'and the newest is still the current one');

-- ===== Change orders ==========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, property_id, title, change_order_for) values (:'co', :'client', :'prop', 'Change order: add a drive lane', :'job') returning id as co_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'co_quote', 'Drive lane', 80, 'ton', 140);
insert into public.plan_files (company_id, quote_id, title, path, file_name) values (:'co', :'co_quote', 'Drive lane sketch', tpf.path(:'co'), 'lane.pdf') returning id as lane \gset
select tpf.check((select job_id is null from public.plan_files where id = :'lane'), 'a change order''s file waits for the approval');
update public.quotes set status = 'sent', sent_at = now() where id = :'co_quote';
commit;
update public.quotes set status = 'approved', approved_at = now() where id = :'co_quote';
select tpf.check((select job_id = :'job' from public.plan_files where id = :'lane'), 'once the change order is approved, its files go on the job');

-- ===== Files sent with a booking request ======================================================
-- The public form saves them as the service (no one signed in), on the request.
insert into public.clients (company_id, display_name) values (:'co', 'Hill Church') returning id as gc \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'gc', '9 Hill Rd') returning id as hill \gset
insert into public.requests (company_id, client_id, property_id, title, source) values (:'co', :'gc', :'hill', 'Church lot bid', 'web_form') returning id as req \gset
insert into public.plan_files (company_id, request_id, title, path, file_name, created_by) values (:'co', :'req', 'Church lot plans', tpf.path(:'co'), 'church.pdf', null) returning id as church \gset
select tpf.check((select property_id = :'hill' and quote_id is null and created_by is null from public.plan_files where id = :'church'), 'a file sent with a request takes the request''s property');
insert into public.visits (company_id, request_id, property_id, title, kind, starts_at, ends_at) values (:'co', :'req', :'hill', 'Assessment: Church lot', 'assessment', now() + interval '2 days', now() + interval '2 days 1 hour') returning id as assess \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'assess', 'ef000000-0000-0000-0000-000000000004');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select tpf.check((select array_agg(title) from public.plan_files where company_id = :'co') = array['Church lot plans'], 'the crew on the assessment visit sees the request''s files');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ef000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, property_id, request_id, title) values (:'co', :'gc', :'hill', :'req', 'Church lot') returning id as church_quote \gset
select tpf.check((select quote_id = :'church_quote' and request_id = :'req' from public.plan_files where id = :'church'), 'a quote made from the request gets its files');
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'church_quote', 'Overlay', 90, 'ton', 140);
select public.convert_quote_to_job(:'church_quote') as church_job \gset
select tpf.check((select job_id = :'church_job' from public.plan_files where id = :'church'), 'and the job made from that quote');
select tpf.expect_error(format('insert into public.plan_files (company_id, request_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'other', :'req', 'Theirs', tpf.path(:'other'), 'x.pdf'), 'a file goes on this company''s request only');
commit;

-- ===== Deleting things ========================================================================
delete from public.jobs where id = :'job';
select tpf.check((select job_id is null and quote_id = :'quote' from public.plan_files where id = :'site3'), 'deleting the job keeps the file on the quote and property');
delete from public.companies where id = :'other';
delete from public.companies where id = :'co';
select tpf.check((select count(*) from public.plan_files) = 0, 'deleting a company takes its files with it');

drop schema tpf cascade;
