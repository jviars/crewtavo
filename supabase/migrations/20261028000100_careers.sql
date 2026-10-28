-- Careers (Apps → Crewtavo - Careers): the "Apply now" form on the business's own website sends to
-- its Crewtavo the way its contact form does with Website Forms (20261026000100_website_forms.sql),
-- and each application lands in Applicants instead of Requests: a person who wants to work there
-- isn't a client or a lead.
--
--   website_forms.kind   careers forms share the contact forms' address (/f/<key>), emails, thank-you
--                        page and spam checks; only where a message goes is different.
--   job_applicants       one application: who, what for, when they can start, their answers, their
--                        résumé, and the office's own status, rating, interview time and notes.
--   files                résumés under <company>/applicants/<applicant>/..., out of the team's reach.
--
-- All of it is for owners, admins and office staff with the new "hiring" area ("Job applicants and
-- hiring"). Office staff have it unless their role turns it off; crews never see an application.
--
--   * Owners and admins who connect apps install it and manage its forms (the app's page).
--   * Applications come in only while the app is installed (settings.careers.enabled), through the
--     server (apps/api/src/routes/websiteForms.ts), as the service role: job_application.

-- ---------------------------------------------------------------------------------------------
-- The hiring area (mirrors LEVEL_PERMISSIONS in packages/core/src/roles.ts)
-- ---------------------------------------------------------------------------------------------

create or replace function private.level_permissions(p_level public.member_role) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select case p_level
    when 'owner' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps','equipment','subs','hiring']
    when 'admin' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','apps','equipment','subs','hiring']
    when 'office' then array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','equipment','subs','hiring']
    when 'estimator' then array['sales','schedule','equipment']
    when 'crew_lead' then array['schedule','timesheets','equipment']
    else array[]::text[]
  end
$$;

-- Custom roles keep what they have. Those that manage people or set up crews and booking forms get
-- applicants too: the general and office managers a business starts with.
update public.company_roles set permissions = permissions || array['hiring']
where base_role in ('admin', 'office') and ('team' = any (permissions) or 'settings' = any (permissions)) and not ('hiring' = any (permissions));

create or replace function private.install_default_roles(p_company uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.company_roles (company_id, name, description, base_role, permissions) values
    (p_company, 'General manager', 'Runs the business day to day.', 'admin',
     array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','team','equipment','subs','hiring']),
    (p_company, 'Office manager', 'Books work, schedules crews, sends quotes and invoices, and approves time.', 'office',
     array['sales','invoices','job_costs','reports','marketing','automations','schedule','timesheets','settings','kb_edit','equipment','subs','hiring']),
    (p_company, 'Operations manager', 'Schedules crews and keeps jobs on track.', 'office',
     array['sales','job_costs','reports','schedule','timesheets','kb_edit','equipment','subs']),
    (p_company, 'Foreman', 'Runs their crew: schedules its visits, assigns its people and sees its time. No prices.', 'crew_lead', array['equipment']),
    (p_company, 'Employee', 'Works their own visits.', 'field_crew', array[]::text[])
  on conflict do nothing
$$;

-- The people who see applicants: owners, admins and office staff with the area.
create function private.hiring_people(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id
  from public.memberships m
  left join public.company_roles cr on cr.id = m.role_id
  where m.company_id = p_company and m.active and m.role in ('owner', 'admin', 'office')
    and 'hiring' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
$$;
revoke execute on function private.hiring_people(uuid) from public;
grant execute on function private.hiring_people(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Careers forms
-- ---------------------------------------------------------------------------------------------

alter table public.website_forms add column kind text not null default 'contact' check (kind in ('contact', 'careers'));
comment on column public.website_forms.kind is 'contact: each message is a request (Apps → Website Forms). careers: each is a job application (Apps → Careers).';

-- Website Forms' first install makes a contact form, even when Careers already made a form of its own.
create or replace function public.website_forms_set_enabled(p_company uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can install website forms' using errcode = '42501';
  end if;
  update public.companies
  set settings = jsonb_set(coalesce(settings, '{}'), '{website_forms}', coalesce(settings -> 'website_forms', '{}') || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
  where id = p_company;
  if p_enabled and not exists (select 1 from public.website_forms where company_id = p_company and kind = 'contact') then
    select coalesce(nullif(trim(c.email), ''), nullif(trim(u.email), '')) into v_email
    from public.companies c left join auth.users u on u.id = (select auth.uid())
    where c.id = p_company;
    insert into public.website_forms (company_id, name, email_to)
    values (p_company, 'Contact form', case when v_email is null then '{}' else array[v_email] end);
  end if;
  return p_enabled;
end $$;

-- Installing the first time makes a Job application form, emailing the business's own address (or,
-- without one, whoever installed it). Uninstalling keeps every form, its address and its applicants.
create function public.careers_set_enabled(p_company uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can install Careers' using errcode = '42501';
  end if;
  update public.companies
  set settings = jsonb_set(coalesce(settings, '{}'), '{careers}', coalesce(settings -> 'careers', '{}') || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
  where id = p_company;
  if p_enabled and not exists (select 1 from public.website_forms where company_id = p_company and kind = 'careers') then
    select coalesce(nullif(trim(c.email), ''), nullif(trim(u.email), '')) into v_email
    from public.companies c left join auth.users u on u.id = (select auth.uid())
    where c.id = p_company;
    insert into public.website_forms (company_id, name, email_to, kind)
    values (p_company, 'Job application', case when v_email is null then '{}' else array[v_email] end, 'careers');
  end if;
  return p_enabled;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Applicants
-- ---------------------------------------------------------------------------------------------

create table public.job_applicants (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- The careers form it came from; null when the office added it (a walk-in, a call, a job board).
  website_form_id uuid,
  status text not null default 'new' check (status in ('new', 'reviewing', 'interview', 'offer', 'hired', 'not_hired')),
  name text not null check (char_length(trim(name)) between 1 and 200),
  email text check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (char_length(phone) <= 30),
  -- What they typed, as they typed it: "ASAP" is as good an answer as a date.
  position text check (char_length(position) <= 200),
  location text check (char_length(location) <= 300),
  start_date text check (char_length(start_date) <= 100),
  availability text check (char_length(availability) <= 300),
  desired_pay text check (char_length(desired_pay) <= 100),
  experience text check (char_length(experience) <= 5000),
  drivers_license text check (char_length(drivers_license) <= 100),
  heard_from text check (char_length(heard_from) <= 200),
  message text check (char_length(message) <= 5000),
  -- The form's other fields, under its own field names.
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  -- Résumés and other files: [{path, name, type, size, field}], stored under <company>/applicants/<id>/.
  files jsonb not null default '[]' check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) <= 5),
  -- The website visit that brought them in, when the business counts its website's visits.
  web_visit jsonb,
  -- The office's own.
  rating smallint check (rating between 1 and 5),
  interview_at timestamptz,
  notes text check (char_length(notes) <= 10000),
  status_changed_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.job_applicants add constraint job_applicants_form_fkey
  foreign key (company_id, website_form_id) references public.website_forms (company_id, id) on delete set null (website_form_id);
create index job_applicants_company_idx on public.job_applicants (company_id, created_at desc);
create index job_applicants_status_idx on public.job_applicants (company_id, status);
-- Has this person applied before?
create index job_applicants_email_idx on public.job_applicants (company_id, email) where email is not null;

comment on table public.job_applicants is 'Job applications from the business''s careers form (Apps → Careers), or added by the office.';

select private.apply_policies('job_applicants', '{owner,admin,office}', '{owner,admin,office}');
select private.restrict_area('job_applicants', 'hiring', true);
select private.add_touch_triggers(array['job_applicants']);

-- How long it's been in its status: "In interview for 6 days".
create function private.applicant_status_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then new.status_changed_at := now(); end if;
  return new;
end $$;
create trigger status_changed before update of status on public.job_applicants
  for each row execute function private.applicant_status_changed();

-- ---------------------------------------------------------------------------------------------
-- An application from a careers form
-- ---------------------------------------------------------------------------------------------

-- The applicant for an application, with the id the server stored its files under, and a notice to
-- everyone who sees applicants. p_details holds what the form's fields were read as (packages/core/
-- src/careers.ts): position, location, start_date, availability, desired_pay, experience,
-- drivers_license, heard_from and message.
create function public.job_application(
  p_form uuid, p_id uuid, p_name text default null, p_email text default null, p_phone text default null,
  p_details jsonb default '{}', p_answers jsonb default '{}', p_files jsonb default '[]', p_web_visit jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.website_forms;
  -- A whole address only, as emailKey() in packages/core/src/email.ts takes them.
  v_email text := (select k from private.email_key(p_email) k where k ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(k) <= 254);
  v_phone text := nullif(left(trim(p_phone), 30), '');
  v_name text;
  v_position text := nullif(left(trim(p_details ->> 'position'), 200), '');
begin
  select * into f from public.website_forms where id = p_form and kind = 'careers';
  if not found then
    raise exception 'Form not found' using errcode = 'P0002';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'An email or phone number is needed' using errcode = '22023';
  end if;
  v_name := left(coalesce(nullif(trim(p_name), ''), v_email, v_phone), 200);

  insert into public.job_applicants (
    id, company_id, website_form_id, name, email, phone, position, location, start_date, availability,
    desired_pay, experience, drivers_license, heard_from, message, answers, files, web_visit
  ) values (
    p_id, f.company_id, f.id, v_name, v_email, v_phone, v_position,
    nullif(left(trim(p_details ->> 'location'), 300), ''),
    nullif(left(trim(p_details ->> 'start_date'), 100), ''),
    nullif(left(trim(p_details ->> 'availability'), 300), ''),
    nullif(left(trim(p_details ->> 'desired_pay'), 100), ''),
    nullif(left(trim(p_details ->> 'experience'), 5000), ''),
    nullif(left(trim(p_details ->> 'drivers_license'), 100), ''),
    nullif(left(trim(p_details ->> 'heard_from'), 200), ''),
    nullif(left(trim(p_details ->> 'message'), 5000), ''),
    coalesce(p_answers, '{}'), coalesce(p_files, '[]'), p_web_visit
  );

  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select f.company_id, h.user_id, 'applicant', 'New job application',
    left(v_name || case when v_position is null then ' applied' else ' applied for ' || v_position end, 300), '/applicants/' || p_id
  from private.hiring_people(f.company_id) as h(user_id);

  return jsonb_build_object('applicant_id', p_id);
end $$;

revoke execute on function public.careers_set_enabled(uuid, boolean),
  public.job_application(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.careers_set_enabled(uuid, boolean) to authenticated;
revoke execute on function public.job_application(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb) from authenticated;
grant execute on function public.job_application(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Stored files: <company>/applicants/<applicant>/... only for the office with the hiring area
-- ---------------------------------------------------------------------------------------------

-- Résumés carry home addresses and work histories. Everything else keeps its rules
-- (20261025001001_subcontractors.sql).
drop policy files_read on storage.objects;
create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'files' and private.is_member(private.path_company(name)) and (
    split_part(name, '/', 2) not in ('receipts', 'chat', 'subs', 'applicants')
    or (split_part(name, '/', 2) = 'receipts' and (owner = (select auth.uid()) or private.has_perm(private.path_company(name), 'job_costs')))
    or (split_part(name, '/', 2) = 'chat' and private.chat_can(private.chat_file_channel(name), 'see'))
    or (split_part(name, '/', 2) = 'subs' and private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'subs'))
    or (split_part(name, '/', 2) = 'applicants' and private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'hiring'))
  )
);
-- Adding, replacing or removing one needs the same, whoever uploaded it.
create policy files_applicants_insert on storage.objects as restrictive for insert to authenticated with check (
  bucket_id <> 'files' or split_part(name, '/', 2) <> 'applicants'
  or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'hiring'))
);
create policy files_applicants_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'files' or split_part(name, '/', 2) <> 'applicants'
    or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'hiring')))
  with check (bucket_id <> 'files' or split_part(name, '/', 2) <> 'applicants'
    or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'hiring')));
create policy files_applicants_delete on storage.objects as restrictive for delete to authenticated using (
  bucket_id <> 'files' or split_part(name, '/', 2) <> 'applicants'
  or (private.has_role(private.path_company(name), '{owner,admin,office}') and private.has_perm(private.path_company(name), 'hiring'))
);

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();

notify pgrst, 'reload schema';
