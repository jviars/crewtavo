-- Clients, intake, sales and field work.
-- Child tables reference parents by (company_id, id), so a row can't point at another company's data.

-- ---------------------------------------------------------------------------------------------
-- Crews
-- ---------------------------------------------------------------------------------------------

create table public.crews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  color text,
  lead_user_id uuid references auth.users (id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

create table public.crew_members (
  company_id uuid not null,
  crew_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (crew_id, user_id),
  foreign key (company_id, crew_id) references public.crews (company_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Clients and properties
-- ---------------------------------------------------------------------------------------------

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  status text not null default 'lead' check (status in ('lead', 'active', 'archived')),
  display_name text not null check (length(display_name) between 1 and 200),
  company_name text,
  email text,
  phone text,
  billing_address jsonb not null default '{}',
  lead_source text,
  tags text[] not null default '{}',
  custom_fields jsonb not null default '{}',
  notes text,
  search tsvector generated always as (
    to_tsvector('simple', coalesce(display_name, '') || ' ' || coalesce(company_name, '') || ' ' ||
      coalesce(email, '') || ' ' || coalesce(phone, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index clients_company_status_idx on public.clients (company_id, status);
create index clients_search_idx on public.clients using gin (search);
create index clients_name_trgm_idx on public.clients using gin (display_name extensions.gin_trgm_ops);

create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  client_id uuid not null,
  name text not null,
  email text,
  phone text,
  role text,
  is_primary boolean not null default false,
  notify_email boolean not null default true,
  notify_sms boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
create index client_contacts_client_idx on public.client_contacts (client_id);

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  client_id uuid not null,
  label text,
  line1 text not null,
  line2 text,
  city text,
  region text,
  postal_code text,
  country text not null default 'US',
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  lot_size_sqft numeric(12, 2),
  notes text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
create index properties_client_idx on public.properties (client_id);

-- Gate codes and alarm codes: tighter rules than the rest of the property (see policy below).
create table public.property_access (
  property_id uuid primary key,
  company_id uuid not null,
  gate_code text,
  lockbox_code text,
  alarm_code text,
  instructions text,
  updated_at timestamptz not null default now(),
  foreign key (company_id, property_id) references public.properties (company_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Catalog, intake and requests
-- ---------------------------------------------------------------------------------------------

create table public.services (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  description text,
  category text,
  unit text not null default 'ea',
  unit_price numeric(12, 2) not null default 0,
  unit_cost numeric(12, 2),
  taxable boolean not null default true,
  formula text, -- e.g. 'area_sqyd * depth_in * 110 / 2000'
  formula_target text not null default 'quantity' check (formula_target in ('quantity', 'unit_price')),
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

create table public.intake_forms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null,
  kind text not null default 'request' check (kind in ('request', 'assessment', 'booking')),
  questions jsonb not null default '[]',
  service_ids uuid[] not null default '{}',
  service_area_zips text[] not null default '{}', -- empty = anywhere
  slot_minutes integer,
  lead_time_days integer not null default 1,
  max_per_day integer,
  requires_approval boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, slug),
  unique (company_id, id)
);

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number bigint,
  client_id uuid not null,
  property_id uuid,
  intake_form_id uuid,
  source text not null default 'manual' check (source in ('manual', 'phone', 'web_form', 'hub', 'email', 'assistant')),
  status text not null default 'new'
    check (status in ('new', 'assessment_scheduled', 'assessment_complete', 'quoted', 'converted', 'archived')),
  title text not null,
  details text,
  answers jsonb not null default '{}',
  preferred_times jsonb not null default '[]',
  assigned_to uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, property_id) references public.properties (company_id, id) on delete set null (property_id),
  foreign key (company_id, intake_form_id) references public.intake_forms (company_id, id) on delete set null (intake_form_id)
);
create index requests_company_status_idx on public.requests (company_id, status, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------------------------

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number bigint,
  client_id uuid not null,
  property_id uuid,
  request_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'changes_requested', 'approved', 'converted', 'lost', 'archived')),
  title text not null,
  message text,
  salesperson_id uuid references auth.users (id) on delete set null,
  pipeline_stage text,
  -- Totals are maintained by triggers from the line items; values written by clients are replaced.
  subtotal numeric(12, 2) not null default 0,
  discount_amount numeric(12, 2) not null default 0 check (discount_amount >= 0),
  tax_rate numeric(6, 4) not null default 0 check (tax_rate >= 0 and tax_rate < 1),
  tax_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  deposit_amount numeric(12, 2) not null default 0,
  valid_until date,
  sent_at timestamptz,
  approved_at timestamptz,
  approval jsonb, -- {name, ip, selected_line_ids, signed_at}
  converted_at timestamptz,
  lost_reason text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, property_id) references public.properties (company_id, id) on delete set null (property_id),
  foreign key (company_id, request_id) references public.requests (company_id, id) on delete set null (request_id)
);
create index quotes_company_status_idx on public.quotes (company_id, status, updated_at desc);

create table public.quote_line_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  quote_id uuid not null,
  service_id uuid,
  name text not null,
  description text,
  quantity numeric(14, 3) not null default 1,
  unit text not null default 'ea',
  unit_price numeric(12, 2) not null default 0,
  unit_cost numeric(12, 2),
  taxable boolean not null default true,
  optional boolean not null default false,
  selected boolean not null default true, -- optional lines the client didn't choose are false
  option_group text,                      -- 'Good' / 'Better' / 'Best'
  formula text,
  sort integer not null default 0,
  foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete cascade,
  foreign key (company_id, service_id) references public.services (company_id, id) on delete set null (service_id)
);
create index quote_line_items_quote_idx on public.quote_line_items (quote_id);

create table public.measurements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid,
  request_id uuid,
  quote_id uuid,
  title text not null default 'Measurement',
  provider text not null default 'google',
  geojson jsonb not null,
  sections jsonb not null default '[]',
  roof_pitch text,
  waste_pct numeric(5, 2) not null default 0,
  total_area_sqft numeric(14, 2) not null default 0,
  total_area_sqyd numeric(14, 2) not null default 0,
  total_length_ft numeric(14, 2) not null default 0,
  roofing_squares numeric(10, 2),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, property_id) references public.properties (company_id, id) on delete set null (property_id),
  foreign key (company_id, request_id) references public.requests (company_id, id) on delete set null (request_id),
  foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete set null (quote_id)
);

-- ---------------------------------------------------------------------------------------------
-- Jobs and visits
-- ---------------------------------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number bigint,
  client_id uuid not null,
  property_id uuid,
  quote_id uuid,
  title text not null,
  kind text not null default 'one_off' check (kind in ('one_off', 'recurring')),
  status text not null default 'active' check (status in ('active', 'requires_invoicing', 'completed', 'archived')),
  starts_on date,
  ends_on date,
  -- Recurrence: RFC 5545 RRULE without DTSTART, e.g. 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU'
  recurrence_rule text,
  active_months smallint[], -- season, e.g. {4,5,6,7,8,9,10}; null = all year
  visit_start_time time,    -- null = anytime visits
  visit_duration_min integer not null default 60 check (visit_duration_min > 0),
  default_crew_id uuid,
  billing_mode text not null default 'on_completion'
    check (billing_mode in ('per_visit', 'on_completion', 'fixed_schedule', 'progress')),
  instructions text,
  po_number text,
  permit_number text,
  retainage_pct numeric(5, 2) not null default 0 check (retainage_pct between 0 and 100),
  warranty_until date,
  contract_total numeric(12, 2) not null default 0, -- maintained from job_line_items
  weather_rules jsonb not null default '[]',         -- [{min_temp_f, max_rain_pct, requires_dry_hours}]
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number),
  check (kind = 'one_off' or recurrence_rule is not null),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, property_id) references public.properties (company_id, id) on delete set null (property_id),
  foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete set null (quote_id),
  foreign key (company_id, default_crew_id) references public.crews (company_id, id) on delete set null (default_crew_id)
);
create index jobs_company_status_idx on public.jobs (company_id, status);

create table public.job_line_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  job_id uuid not null,
  service_id uuid,
  name text not null,
  description text,
  quantity numeric(14, 3) not null default 1,
  unit text not null default 'ea',
  unit_price numeric(12, 2) not null default 0,
  unit_cost numeric(12, 2),
  taxable boolean not null default true,
  sort integer not null default 0,
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete cascade,
  foreign key (company_id, service_id) references public.services (company_id, id) on delete set null (service_id)
);
create index job_line_items_job_idx on public.job_line_items (job_id);

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  job_id uuid,
  request_id uuid,
  property_id uuid,
  kind text not null default 'job' check (kind in ('job', 'assessment', 'task', 'event')),
  title text not null,
  -- Timed visits have starts_at/ends_at. Anytime visits have only scheduled_on.
  scheduled_on date,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'scheduled'
    check (status in ('unscheduled', 'scheduled', 'en_route', 'in_progress', 'completed', 'cancelled')),
  crew_id uuid,
  route_order integer,
  recurrence_key text, -- local date the recurrence generated this visit for; prevents duplicates
  hold_reason text,    -- set by the weather task
  notes text,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (job_id, recurrence_key),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (status = 'unscheduled' or scheduled_on is not null or starts_at is not null),
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete cascade,
  foreign key (company_id, request_id) references public.requests (company_id, id) on delete cascade,
  foreign key (company_id, property_id) references public.properties (company_id, id) on delete set null (property_id),
  foreign key (company_id, crew_id) references public.crews (company_id, id) on delete set null (crew_id)
);
create index visits_company_start_idx on public.visits (company_id, starts_at);
create index visits_company_day_idx on public.visits (company_id, scheduled_on);
create index visits_job_idx on public.visits (job_id);

-- Keep scheduled_on in step with starts_at so day views can filter on one column.
create function private.visit_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tz text;
begin
  if new.starts_at is not null then
    select timezone into tz from public.companies where id = new.company_id;
    new.scheduled_on := (new.starts_at at time zone coalesce(tz, 'UTC'))::date;
  end if;
  if new.status = 'completed' and new.completed_at is null then
    new.completed_at := now();
    new.completed_by := (select auth.uid());
  end if;
  return new;
end $$;
create trigger visit_defaults before insert or update on public.visits
  for each row execute function private.visit_defaults();

create table public.visit_assignees (
  company_id uuid not null,
  visit_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (visit_id, user_id),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade
);
create index visit_assignees_user_idx on public.visit_assignees (user_id);

-- ---------------------------------------------------------------------------------------------
-- Checklists, time and expenses
-- ---------------------------------------------------------------------------------------------

create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  job_type text,
  -- [{key, label, type: check|number|text|choice|photo|signature, required, options?, sop_page_id?}]
  items jsonb not null default '[]',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

create table public.checklist_responses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  visit_id uuid not null,
  template_id uuid,
  answers jsonb not null default '{}',
  completed_by uuid references auth.users (id) on delete set null default auth.uid(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade,
  foreign key (company_id, template_id) references public.checklist_templates (company_id, id) on delete set null (template_id)
);

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  visit_id uuid,
  job_id uuid,
  category text not null default 'visit' check (category in ('visit', 'assessment', 'drive', 'shop', 'break', 'other')),
  started_at timestamptz not null,
  ended_at timestamptz,
  notes text,
  labor_rate numeric(10, 2), -- snapshot of the member's rate when approved
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete set null (visit_id),
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id)
);
create index time_entries_user_idx on public.time_entries (company_id, user_id, started_at desc);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  job_id uuid,
  user_id uuid references auth.users (id) on delete set null default auth.uid(),
  vendor text,
  description text,
  category text,
  amount numeric(12, 2) not null,
  incurred_on date not null default current_date,
  receipt_path text, -- Storage object key
  reimbursable boolean not null default false,
  reimbursed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id)
);

-- ---------------------------------------------------------------------------------------------
-- Communication, files, activity and automations
-- ---------------------------------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid,
  channel text not null check (channel in ('sms', 'email', 'note', 'call')),
  direction text not null default 'out' check (direction in ('in', 'out', 'internal')),
  subject text,
  body text not null,
  status text not null default 'sent' check (status in ('queued', 'sent', 'delivered', 'failed', 'received')),
  external_id text,
  related_type text,
  related_id uuid,
  sent_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
create index messages_client_idx on public.messages (company_id, client_id, created_at desc);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  owner_type text not null, -- 'client' | 'property' | 'request' | 'quote' | 'job' | 'visit' | 'invoice'
  owner_id uuid not null,
  path text not null,       -- Storage key: <company_id>/<owner_type>/<owner_id>/<file>
  file_name text not null,
  content_type text,
  size_bytes bigint,
  caption text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (path like company_id::text || '/%')
);
create index attachments_owner_idx on public.attachments (company_id, owner_type, owner_id);

create table public.activity (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null default auth.uid(),
  verb text not null,        -- 'quote.approved', 'visit.completed', ...
  subject_type text not null,
  subject_id uuid,
  summary text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index activity_company_idx on public.activity (company_id, created_at desc);

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  trigger text not null,      -- 'quote.sent', 'visit.completed', 'invoice.overdue', ...
  conditions jsonb not null default '[]',
  actions jsonb not null default '[]',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Numbering, timestamps and RLS
-- ---------------------------------------------------------------------------------------------

create trigger assign_number before insert on public.requests for each row execute function private.assign_number();
create trigger assign_number before insert on public.quotes for each row execute function private.assign_number();
create trigger assign_number before insert on public.jobs for each row execute function private.assign_number();

select private.add_touch_triggers(array[
  'crews', 'clients', 'client_contacts', 'properties', 'property_access', 'services', 'intake_forms',
  'requests', 'quotes', 'measurements', 'jobs', 'visits', 'checklist_templates', 'checklist_responses',
  'time_entries', 'expenses', 'automation_rules'
]);

-- Any member reads; office staff and up write.
select private.apply_policies('clients', '{owner,admin,office,estimator}');
select private.apply_policies('client_contacts', '{owner,admin,office,estimator}');
select private.apply_policies('properties', '{owner,admin,office,estimator}');
select private.apply_policies('crews', '{owner,admin,office}');
select private.apply_policies('crew_members', '{owner,admin,office}');
select private.apply_policies('services', '{owner,admin,office,estimator}');
select private.apply_policies('intake_forms', '{owner,admin,office}');
select private.apply_policies('requests', '{owner,admin,office,estimator}');
select private.apply_policies('measurements', '{owner,admin,office,estimator,crew_lead}');
select private.apply_policies('jobs', '{owner,admin,office,estimator}');
select private.apply_policies('job_line_items', '{owner,admin,office,estimator}');
select private.apply_policies('visits', '{owner,admin,office,estimator,crew_lead}');
select private.apply_policies('visit_assignees', '{owner,admin,office,crew_lead}');
select private.apply_policies('checklist_templates', '{owner,admin,office}');
select private.apply_policies('automation_rules', '{owner,admin,office}', '{owner,admin,office}');
select private.apply_policies('attachments', '{owner,admin,office,estimator,crew_lead,field_crew}');
select private.apply_policies('messages', '{owner,admin,office,estimator,crew_lead,field_crew}');

-- Quotes: everyone can see what was sold; costs live on line items, which only sales roles read.
select private.apply_policies('quotes', '{owner,admin,office,estimator}');
select private.apply_policies('quote_line_items', '{owner,admin,office,estimator}', '{owner,admin,office,estimator}');

-- Crews can update the visits they're assigned to (status, notes), even without a lead role.
create policy visits_update_assigned on public.visits for update to authenticated
  using (exists (select 1 from public.visit_assignees a where a.visit_id = visits.id and a.user_id = (select auth.uid())))
  with check (private.is_member(company_id));

-- Checklist answers: any member on the visit's company can fill them in.
select private.apply_policies('checklist_responses', '{owner,admin,office,estimator,crew_lead,field_crew}');

-- Gate codes: office and up, or crew assigned to a visit at that property within the next day.
alter table public.property_access enable row level security;
create policy property_access_read on public.property_access for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office}')
  or exists (
    select 1 from public.visits v
    join public.visit_assignees a on a.visit_id = v.id
    where v.property_id = property_access.property_id
      and a.user_id = (select auth.uid())
      and v.status not in ('completed', 'cancelled')
      and coalesce(v.starts_at, v.scheduled_on::timestamptz) between now() - interval '12 hours' and now() + interval '24 hours'
  )
);
create policy property_access_write on public.property_access for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'))
  with check (private.has_role(company_id, '{owner,admin,office}'));

-- Time: your own entries until approved; office and up see and approve everyone's.
alter table public.time_entries enable row level security;
create policy time_entries_read on public.time_entries for select to authenticated
  using ((user_id = (select auth.uid()) and private.is_member(company_id)) or private.has_role(company_id, '{owner,admin,office}'));
create policy time_entries_insert on public.time_entries for insert to authenticated
  with check ((user_id = (select auth.uid()) and private.is_member(company_id)) or private.has_role(company_id, '{owner,admin,office,crew_lead}'));
create policy time_entries_update on public.time_entries for update to authenticated
  using ((user_id = (select auth.uid()) and approved_at is null) or private.has_role(company_id, '{owner,admin,office}'))
  with check (private.is_member(company_id) and (approved_at is null or private.has_role(company_id, '{owner,admin,office}')));
create policy time_entries_delete on public.time_entries for delete to authenticated
  using ((user_id = (select auth.uid()) and approved_at is null) or private.has_role(company_id, '{owner,admin,office}'));

-- Expenses: anyone can log one; office and up see them all.
alter table public.expenses enable row level security;
create policy expenses_read on public.expenses for select to authenticated
  using ((user_id = (select auth.uid()) and private.is_member(company_id)) or private.has_role(company_id, '{owner,admin,office}'));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (private.is_member(company_id) and (user_id = (select auth.uid()) or private.has_role(company_id, '{owner,admin,office}')));
create policy expenses_update on public.expenses for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office}')) with check (private.has_role(company_id, '{owner,admin,office}'));
create policy expenses_delete on public.expenses for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));

-- Activity: members read and add entries as themselves.
alter table public.activity enable row level security;
create policy activity_read on public.activity for select to authenticated using (private.is_member(company_id));
create policy activity_insert on public.activity for insert to authenticated
  with check (private.is_member(company_id) and actor_id = (select auth.uid()));

-- Field crew may update status and notes on their visits, but not reschedule or reassign them.
create function private.visit_crew_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and not private.has_role(new.company_id, '{owner,admin,office,estimator,crew_lead}')
     and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
          or new.scheduled_on is distinct from old.scheduled_on or new.crew_id is distinct from old.crew_id
          or new.job_id is distinct from old.job_id or new.property_id is distinct from old.property_id) then
    raise exception 'Only the office or a crew lead can reschedule a visit' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger visit_crew_guard before update on public.visits
  for each row execute function private.visit_crew_guard();
