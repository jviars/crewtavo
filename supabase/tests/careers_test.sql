-- Database tests for Careers: only owners and admins who connect apps install it, the first install
-- makes a Job application form (and Website Forms still makes its own contact form after it), an
-- application lands in Applicants with a notice to the people who see them, and only owners, admins
-- and office staff with the hiring area see applicants and their résumés. A résumé taken off an
-- applicant goes in the Trash (20261028000300_drive.sql); nobody signed in deletes the stored file.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema cat;
grant usage on schema cat to authenticated, service_role;
create function cat.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function cat.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema cat to authenticated, service_role;

-- Ana owns Pine Lawn; Bo is office; Cy is field crew; Dot is office in a Dispatcher role without
-- hiring; Gus is an admin whose role doesn't connect apps. Ed owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ca110000-0000-0000-0000-000000000001', 'ana@pine.test', '{"full_name": "Ana Pine"}'),
  ('ca110000-0000-0000-0000-000000000002', 'bo@pine.test', '{"full_name": "Bo Rivers"}'),
  ('ca110000-0000-0000-0000-000000000003', 'cy@pine.test', '{"full_name": "Cy Stone"}'),
  ('ca110000-0000-0000-0000-000000000004', 'dot@pine.test', '{"full_name": "Dot Lane"}'),
  ('ca110000-0000-0000-0000-000000000005', 'gus@pine.test', '{"full_name": "Gus Hale"}'),
  ('ca110000-0000-0000-0000-000000000009', 'ed@oak.test', '{"full_name": "Ed Oak"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Oak Snow', 'general') as other \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Pine Lawn', 'lawn_care', 'America/Chicago') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule,sales}') returning id as dispatcher \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as keeper \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'ca110000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'ca110000-0000-0000-0000-000000000003', 'field_crew');
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'ca110000-0000-0000-0000-000000000004', 'office', :'dispatcher'),
  (:'co', 'ca110000-0000-0000-0000-000000000005', 'admin', :'keeper');
commit;

-- ===== The hiring area ========================================================================
select cat.check('hiring' = any (private.level_permissions('office')) and not ('hiring' = any (private.level_permissions('estimator')))
  and not ('hiring' = any (private.level_permissions('crew_lead'))), 'owners, admins and office staff can have the hiring area; estimators and crews can''t');
select cat.check((select 'hiring' = any (permissions) from public.company_roles where company_id = :'co' and name = 'Office manager'), 'a new business''s Office manager has it');
select cat.check((select not ('hiring' = any (permissions)) from public.company_roles where company_id = :'co' and name = 'Operations manager'), 'its Operations manager doesn''t');

-- ===== Install: owners and admins who connect apps ===========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select cat.expect_error(format('select public.careers_set_enabled(%L, true)', :'co'), 'office staff can''t install it');
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select cat.expect_error(format('select public.careers_set_enabled(%L, true)', :'co'), 'an admin whose role doesn''t connect apps can''t either');
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select cat.expect_error(format('select public.careers_set_enabled(%L, true)', :'co'), 'nor another business''s owner');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select cat.check(public.careers_set_enabled(:'co', true), 'the owner installs it');
select cat.check((select (settings -> 'careers' ->> 'enabled')::boolean from public.companies where id = :'co'), 'installed in the company''s settings');
select cat.check((select count(*) = 1 from public.website_forms where company_id = :'co'), 'the first install makes a form');
select cat.check((select name = 'Job application' and kind = 'careers' and key ~ '^[a-f0-9]{10}$' and email_to = '{ana@pine.test}' from public.website_forms where company_id = :'co'),
  'a careers form called Job application, at a random address, emailing whoever installed it');
select public.careers_set_enabled(:'co', false);
select public.careers_set_enabled(:'co', true);
select cat.check((select count(*) = 1 from public.website_forms where company_id = :'co'), 'uninstalling keeps it, and installing again doesn''t make another');
select public.website_forms_set_enabled(:'co', true);
select cat.check((select count(*) = 1 from public.website_forms where company_id = :'co' and kind = 'contact' and name = 'Contact form'),
  'Website Forms still makes its own contact form after Careers');
commit;

select id as form from public.website_forms where company_id = :'co' and kind = 'careers' \gset
select id as contact_form from public.website_forms where company_id = :'co' and kind = 'contact' \gset

-- ===== Applications ==========================================================================
begin;
set local role service_role;
select public.job_application(:'form', 'b0b00000-0000-0000-0000-000000000001', 'Dee New', ' Dee@New.test ', '540 555 0101',
  '{"position": "Lawn technician", "start_date": "ASAP", "availability": "Full-time", "desired_pay": "$18/hr", "experience": "3 years mowing",
    "drivers_license": "Yes", "location": "Radford, VA", "heard_from": "Indeed", "message": "I love being outside."}',
  '{"shirt_size": "L"}', format('[{"path": "%s/applicants/b0b00000-0000-0000-0000-000000000001/resume.pdf", "name": "resume.pdf", "type": "application/pdf", "size": 1200, "field": "resume"}]', :'co')::jsonb,
  '{"page": "/careers"}') as sent \gset
select cat.check((:'sent'::jsonb ->> 'applicant_id')::uuid = 'b0b00000-0000-0000-0000-000000000001', 'an application: the applicant, under the id its files were stored with');
select cat.check((select a.company_id = :'co' and a.website_form_id = :'form' and a.status = 'new' and a.name = 'Dee New' and a.email = 'dee@new.test' and a.phone = '540 555 0101'
  and a.position = 'Lawn technician' and a.start_date = 'ASAP' and a.availability = 'Full-time' and a.desired_pay = '$18/hr' and a.experience = '3 years mowing'
  and a.drivers_license = 'Yes' and a.location = 'Radford, VA' and a.heard_from = 'Indeed' and a.message = 'I love being outside.'
  and a.answers = '{"shirt_size": "L"}' and jsonb_array_length(a.files) = 1 and a.web_visit = '{"page": "/careers"}'
  from public.job_applicants a where a.id = 'b0b00000-0000-0000-0000-000000000001'), 'with everything the form was read as, its other answers, its résumé and the visit');
select cat.check((select array_agg(user_id order by user_id) = array['ca110000-0000-0000-0000-000000000001', 'ca110000-0000-0000-0000-000000000002']::uuid[]
  from public.notifications where kind = 'applicant' and company_id = :'co'), 'a notice to the owner and office staff, not the crew or a role without hiring');
select cat.check((select title = 'New job application' and body = 'Dee New applied for Lawn technician' and link = '/applicants/b0b00000-0000-0000-0000-000000000001'
  from public.notifications where kind = 'applicant' limit 1), 'saying who applied for what, opening the applicant');

select public.job_application(:'form', 'b0b00000-0000-0000-0000-000000000002', null, null, '+1 540 555 0199') as sent \gset
select cat.check((select name = '+1 540 555 0199' and position is null and files = '[]' from public.job_applicants where id = 'b0b00000-0000-0000-0000-000000000002'),
  'no name: called by how to reach them');
select cat.check((select body = '+1 540 555 0199 applied' from public.notifications where link = '/applicants/b0b00000-0000-0000-0000-000000000002' limit 1), 'and no position: just "applied"');

select cat.expect_error(format($q$select public.job_application(%L, gen_random_uuid(), 'Nobody', 'not an email', ' ')$q$, :'form'), 'no way to reach them: refused');
select cat.expect_error(format($q$select public.job_application(%L, gen_random_uuid(), 'X', 'x@x.test')$q$, :'contact_form'), 'a contact form doesn''t take applications');
select cat.expect_error($q$select public.job_application('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'X', 'x@x.test')$q$, 'an unknown form: refused');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select cat.expect_error(format($q$select public.job_application(%L, gen_random_uuid(), 'Eve', 'eve@x.test')$q$, :'form'), 'nobody signed in makes applications');
commit;

-- ===== Who sees and changes applicants ========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select cat.check((select count(*) = 2 from public.job_applicants), 'the owner sees both applicants');
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select cat.check((select count(*) = 2 from public.job_applicants), 'office staff see them');
update public.job_applicants set status = 'interview', interview_at = now() + interval '1 day', rating = 4, notes = 'Strong on equipment.', status_changed_at = now() - interval '1 week'
where id = 'b0b00000-0000-0000-0000-000000000001';
select cat.check((select status = 'interview' and rating = 4 and status_changed_at > now() - interval '1 minute' from public.job_applicants where id = 'b0b00000-0000-0000-0000-000000000001'),
  'and move one along, rate it and take notes; the status says when it changed');
select cat.expect_error($q$update public.job_applicants set rating = 6 where id = 'b0b00000-0000-0000-0000-000000000001'$q$, 'a rating is one to five stars');
select cat.expect_error($q$update public.job_applicants set status = 'maybe' where id = 'b0b00000-0000-0000-0000-000000000001'$q$, 'a status is one of the six');
insert into public.job_applicants (company_id, name, phone, position, heard_from, created_by)
values (:'co', 'Walk In', '540 555 0123', 'Crew lead', 'Walked in', 'ca110000-0000-0000-0000-000000000002');
select cat.check((select count(*) = 1 from public.job_applicants where name = 'Walk In' and website_form_id is null), 'and add someone who walked in');

select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select cat.check((select count(*) = 0 from public.job_applicants), 'the crew see no applicants');
update public.job_applicants set status = 'hired' where company_id = :'co';
select cat.expect_error(format($q$insert into public.job_applicants (company_id, name) values (%L, 'Sneaky')$q$, :'co'), 'nor add one');
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select cat.check((select count(*) = 0 from public.job_applicants), 'nor does an office role without hiring');
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select cat.check((select count(*) = 0 from public.job_applicants), 'nor another business');
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select cat.check((select count(*) = 0 from public.job_applicants where status = 'hired'), 'nobody without hiring changed a status');
commit;

-- ===== Résumés ================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into storage.objects (bucket_id, name, owner) values
  ('files', :'co' || '/applicants/b0b00000-0000-0000-0000-000000000001/resume.pdf', 'ca110000-0000-0000-0000-000000000002'),
  ('files', :'co' || '/visit/aaaa0000-0000-0000-0000-000000000001/photo.jpg', 'ca110000-0000-0000-0000-000000000002');
select cat.check((select count(*) = 1 from storage.objects where name like '%/applicants/%'), 'office staff store and open a résumé');
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select cat.check((select count(*) = 0 from storage.objects where name like '%/applicants/%'), 'the crew can''t open it');
select cat.check((select count(*) = 1 from storage.objects where name like '%/visit/%'), 'but still see the rest of the team''s files');
select cat.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/applicants/b0b00000-0000-0000-0000-000000000001/fake.pdf', 'ca110000-0000-0000-0000-000000000003'),
  'nor store one');
delete from storage.objects where name like '%/applicants/%';
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select cat.check((select count(*) = 0 from storage.objects where name like '%/applicants/%'), 'an office role without hiring can''t open it either');
delete from storage.objects where name like '%/applicants/%';
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select cat.check((select count(*) = 1 from storage.objects where name like '%/applicants/%'), 'and neither of them removed it');
delete from storage.objects where name like '%/applicants/%';
select cat.check((select count(*) = 1 from storage.objects where name like '%/applicants/%'), 'nor can office staff: nobody signed in deletes a stored file');
update public.job_applicants set files = '[]' where id = 'b0b00000-0000-0000-0000-000000000001';
commit;
select cat.check((select source = 'applicant_file' and file_name = 'resume.pdf' and restore ->> 'applicant_id' = 'b0b00000-0000-0000-0000-000000000001'
  from public.trashed_files where path = :'co' || '/applicants/b0b00000-0000-0000-0000-000000000001/resume.pdf'),
  'a résumé taken off the applicant goes in the Trash, ready to go back on them');

-- ===== Deleting the form keeps its applicants ==================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ca110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.website_forms where id = :'form';
select cat.check((select count(*) = 1 from public.job_applicants where id = 'b0b00000-0000-0000-0000-000000000001' and website_form_id is null), 'its applicants stay in Applicants');
commit;
