-- Roofing estimates, from the office to a signature on the homeowner's porch, and the look of every
-- estimate, proposal and invoice.
--
-- Estimate templates (document_templates): how a business's paperwork looks, in every trade. The
-- letterhead style, color and lettering, the license number and insurer, the terms printed above the
-- signatures, which signature lines there are and the footer. One is the default; a quote can use
-- another. The business's name, address, phone and logo still come from Settings → Business.
--
-- Saved signatures (user_signatures): a salesperson signs once and their signature goes on every
-- estimate they sign after, one per person in each business they work for.
--
-- Roof packages (roof_packages, roof_package_items): what goes on each kind of roof, made from the
-- price list's services: the roof itself (priced by the square, set by hand or following ABC Supply's
-- prices with a markup), what's always on it, and the quick adds a person can put on an estimate with
-- one tap in the office or on the iPad.
--
-- On a quote: the template and the package it uses; the price range the homeowner was sent (the
-- estimate to the estimate plus a margin, rounded) with the lines it was made from, so the office can
-- see what changed on site; when the homeowner said yes to it; and when the salesperson set the price
-- on site. Saying yes to a range is a step of its own (accept_hub_range), which tells the office to
-- book the site visit.

-- ---------------------------------------------------------------------------------------------
-- Estimate templates
-- ---------------------------------------------------------------------------------------------

create table public.document_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  is_default boolean not null default false,
  -- {header, color, font, tagline, license, insurer, show_license, show_insurer, terms,
  --  customer_signs, customer_label, company_signs, company_label, sign_dates, footer, page_numbers};
  -- core documents.ts templateSettings() reads it with defaults.
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index document_templates_default_idx on public.document_templates (company_id) where is_default;
select private.add_touch_triggers(array['document_templates']);

-- Everyone in the business prints with them; the office changes them (Settings).
select private.apply_policies('document_templates', '{owner,admin,office}');
select private.restrict_area('document_templates', 'settings', false);

-- ---------------------------------------------------------------------------------------------
-- Saved signatures
-- ---------------------------------------------------------------------------------------------

create table public.user_signatures (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  image text not null check (image ~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' and length(image) <= 300000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
select private.add_touch_triggers(array['user_signatures']);
alter table public.user_signatures enable row level security;

-- Each person keeps their own. The server reads a salesperson's to sign for the business.
create policy user_signatures_own on public.user_signatures for all to authenticated
  using (user_id = (select auth.uid()) and private.is_member(company_id))
  with check (user_id = (select auth.uid()) and private.is_member(company_id));

-- ---------------------------------------------------------------------------------------------
-- Roof packages
-- ---------------------------------------------------------------------------------------------

create table public.roof_packages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  -- The picture on its card: shingles, designer shingles, metal panels or plain.
  style text not null default 'shingle' check (style in ('shingle', 'designer', 'metal', 'other')),
  -- The service that prices the roof itself by the square.
  roof_service_id uuid,
  -- 'manual': the price list's price. 'follow': ABC Supply materials plus labor and the rest, plus the markup.
  price_mode text not null default 'manual' check (price_mode in ('manual', 'follow')),
  markup_pct numeric(6, 2) not null default 70 check (markup_pct >= 0 and markup_pct <= 1000),
  is_default boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, roof_service_id) references public.services (company_id, id) on delete set null (roof_service_id)
);
create unique index roof_packages_default_idx on public.roof_packages (company_id) where is_default;
select private.add_touch_triggers(array['roof_packages']);

create table public.roof_package_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  package_id uuid not null,
  service_id uuid not null,
  -- 'included': always on the roof. 'quick': a one-tap add.
  kind text not null check (kind in ('included', 'quick')),
  -- How many to start with, for services that aren't measured (pipe boots: 3). Null: the measurement or 1.
  quantity numeric(14, 3) check (quantity > 0),
  sort integer not null default 0,
  unique (package_id, service_id, kind),
  foreign key (company_id, package_id) references public.roof_packages (company_id, id) on delete cascade,
  foreign key (company_id, service_id) references public.services (company_id, id) on delete cascade
);
create index roof_package_items_package_idx on public.roof_package_items (package_id, kind, sort);

-- The people who price work read them; the price list's people change them, like services.
select private.apply_policies('roof_packages', '{owner,admin,office,estimator}', '{owner,admin,office,estimator}');
select private.restrict_area('roof_packages', 'settings', false);
select private.apply_policies('roof_package_items', '{owner,admin,office,estimator}', '{owner,admin,office,estimator}');
select private.restrict_area('roof_package_items', 'settings', false);

-- ---------------------------------------------------------------------------------------------
-- Quotes: the template, the package, the range and the site visit
-- ---------------------------------------------------------------------------------------------

alter table public.quotes
  add column template_id uuid,
  add column roof_package_id uuid,
  add column range_low numeric(12, 2) check (range_low >= 0),
  add column range_high numeric(12, 2) check (range_high >= 0),
  add column range_sent_at timestamptz,
  add column range_accepted_at timestamptz,
  add column range_lines jsonb check (range_lines is null or jsonb_typeof(range_lines) = 'array'),
  add column priced_on_site_at timestamptz,
  add column exact_sent_at timestamptz,
  add constraint quotes_template_fkey foreign key (company_id, template_id)
    references public.document_templates (company_id, id) on delete set null (template_id),
  add constraint quotes_roof_package_fkey foreign key (company_id, roof_package_id)
    references public.roof_packages (company_id, id) on delete set null (roof_package_id),
  add constraint quotes_range_check check ((range_low is null) = (range_high is null) and (range_low is null or range_low <= range_high));

comment on column public.quotes.template_id is 'The estimate template it prints with; null uses the default one.';
comment on column public.quotes.roof_package_id is 'The roof package its lines came from.';
comment on column public.quotes.range_low is 'The low end of the price range the client was sent.';
comment on column public.quotes.range_lines is 'The lines the range was made from: [{id, service_id, name, quantity, unit, unit_price, unit_cost, taxable, formula, total}].';
comment on column public.quotes.range_accepted_at is 'When the client said yes to the range and asked for a visit.';
comment on column public.quotes.priced_on_site_at is 'When the salesperson set the exact price on site.';
comment on column public.quotes.exact_sent_at is 'When the office sent the exact price instead of the range (it is no longer out as a range).';
create index quotes_template_idx on public.quotes (template_id) where template_id is not null;
create index quotes_roof_package_idx on public.quotes (roof_package_id) where roof_package_id is not null;

-- The client says yes to the range from the Client Hub (POST /hub/:token/accept-range): once, while
-- the range is out and nobody has priced it on site yet. It tells the office to book the visit.
create function public.accept_hub_range(p_company uuid, p_quote uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare q public.quotes;
begin
  select * into q from public.quotes
   where company_id = p_company and id = p_quote and status in ('sent', 'changes_requested')
     and range_low is not null and range_accepted_at is null and priced_on_site_at is null and exact_sent_at is null
   for update;
  if not found then
    return null;
  end if;
  update public.quotes set range_accepted_at = now() where id = p_quote;
  -- Following up on the quote ("any questions about it?") would ask what they've just answered.
  update public.automation_runs r
     set status = 'cancelled', finished_at = now(), error = 'The client said yes to the price range.'
    from public.automation_rules rule
   where rule.id = r.rule_id and rule.trigger = 'quote.sent'
     and r.company_id = p_company and r.subject_type = 'quote' and r.subject_id = p_quote and r.status = 'pending';
  perform private.emit(p_company, 'quote.range_accepted', 'quote', p_quote,
    format('%s said yes to %s to %s for quote #%s', private.client_name(q.client_id),
      private.money(q.range_low), private.money(q.range_high), q.number),
    jsonb_build_object('number', q.number, 'range_low', q.range_low, 'range_high', q.range_high));
  return now();
end $$;
revoke execute on function public.accept_hub_range(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_hub_range(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Tell the office when a client says yes to a range
-- ---------------------------------------------------------------------------------------------

insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
select id, 'notify_range_accepted', 'Tell the office when a client says yes to a price range',
  'A notification to book the site visit.', 'quote.range_accepted', 0, '[]',
  jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', '["owner", "admin", "office", "estimator"]'::jsonb,
    'title', '{{client.name}} wants a visit', 'body', 'They said yes to the price range for “{{title}}”. Book the site visit.')), true
from public.companies
on conflict (company_id, template_key) do nothing;

-- New businesses get it with the other starter rules (20261017000600_hardening, plus this one).
create or replace function private.install_default_automations(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare office jsonb := '["owner", "admin", "office"]';
begin
  insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  values
    (p_company, 'notify_quote_approved', 'Tell the office when a quote is approved',
     'A notification for the office as soon as a client approves.', 'quote.approved', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Quote #{{number}} approved',
       'body', '{{client.name}} approved “{{title}}” ({{total}}).')), true),
    (p_company, 'notify_changes_requested', 'Tell the office when a client asks for changes',
     null, 'quote.changes_requested', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Changes requested on quote #{{number}}',
       'body', '{{client.name}} wants changes to “{{title}}”.')), true),
    (p_company, 'notify_range_accepted', 'Tell the office when a client says yes to a price range',
     'A notification to book the site visit.', 'quote.range_accepted', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', '["owner", "admin", "office", "estimator"]'::jsonb,
       'title', '{{client.name}} wants a visit', 'body', 'They said yes to the price range for “{{title}}”. Book the site visit.')), true),
    (p_company, 'notify_new_request', 'Tell the office about new online requests',
     'Requests from your booking forms and the Client Hub.', 'request.created', 0,
     jsonb_build_array(jsonb_build_object('field', 'source', 'op', 'in', 'value', jsonb_build_array('web_form', 'hub', 'referral'))),
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'New request from {{client.name}}',
       'body', '{{title}}')), true),
    (p_company, 'notify_invoice_paid', 'Tell the office when an invoice is paid',
     null, 'invoice.paid', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Invoice #{{number}} paid',
       'body', '{{client.name}} paid {{total}}.')), true),
    (p_company, 'quote_followup', 'Follow up on quotes after 3 days',
     'Emails the client if they haven''t answered a quote three days after you send it.', 'quote.sent', 4320,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'sent')),
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Following up on your quote from {{company.name}}',
       'body', E'Hi {{client.first_name}},\n\nJust checking whether you had any questions about quote #{{number}} ({{total}}). You can review and approve it here:\n\n{{link}}\n\nThanks,\n{{company.name}}')), true),
    (p_company, 'invoice_overdue', 'Remind clients when an invoice is past due',
     null, 'invoice.overdue', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: invoice #{{number}} from {{company.name}} is past due',
       'body', E'Hi {{client.first_name}},\n\nThis is a friendly reminder that invoice #{{number}} has a balance of {{balance}}. You can view and pay it here:\n\n{{link}}\n\nThank you,\n{{company.name}}')), true),
    (p_company, 'visit_reminder', 'Remind clients the day before a visit',
     'Sent the day before each scheduled visit or assessment.', 'visit.reminder', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: {{company.name}} is coming {{date}}',
       'body', E'Hi {{client.first_name}},\n\nThis is a reminder that {{company.name}} is scheduled to visit {{address}} on {{date}}{{time}}.\n\nQuestions? Reply to this email or call {{company.phone}}.')), false),
    (p_company, 'on_my_way', 'Text the client when the crew is on the way',
     'Sent when a crew taps “On my way” in the app.', 'visit.en_route', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_sms',
       'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now.')), false),
    (p_company, 'review_after_job', 'Ask for a Google review after a job',
     'Sends your review link a day after a job is completed.', 'job.completed', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();

notify pgrst, 'reload schema';
