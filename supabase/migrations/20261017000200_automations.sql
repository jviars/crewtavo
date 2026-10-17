-- Automations: "when this happens, if these conditions hold, do these things".
--
-- A rule names a trigger (an activity verb such as 'quote.approved'), optional conditions and a
-- list of actions, plus an optional delay ("3 days after a quote is sent"). Each matching activity
-- event queues an automation_run; the API's automation engine claims due runs, re-checks the
-- conditions against fresh data and performs the actions (notify, email, text, tag, task...).

alter table public.automation_rules
  add column description text,
  add column delay_minutes integer not null default 0 check (delay_minutes between 0 and 525600),
  add column template_key text,
  add column run_count integer not null default 0,
  add column last_run_at timestamptz,
  add constraint automation_rules_name_check check (length(trim(name)) between 1 and 120),
  add constraint automation_rules_trigger_check check (trigger ~ '^[a-z_]+\.[a-z_]+$'),
  add constraint automation_rules_shape_check check (jsonb_typeof(conditions) = 'array' and jsonb_typeof(actions) = 'array'),
  add constraint automation_rules_actions_check check (jsonb_array_length(actions) between 1 and 10),
  add constraint automation_rules_template_unique unique (company_id, template_key);
create index automation_rules_trigger_idx on public.automation_rules (company_id, trigger) where enabled;

create table public.automation_runs (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  rule_id uuid not null references public.automation_rules (id) on delete cascade,
  activity_id bigint references public.activity (id) on delete set null,
  subject_type text,
  subject_id uuid,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'skipped', 'failed', 'cancelled')),
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  attempts integer not null default 0,
  result jsonb not null default '[]', -- one entry per action: {type, ok, detail}
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index automation_runs_due_idx on public.automation_runs (run_after) where status in ('pending', 'running');
create index automation_runs_rule_idx on public.automation_runs (rule_id, created_at desc);
create index automation_runs_company_idx on public.automation_runs (company_id, created_at desc);

alter table public.automation_runs enable row level security;
create policy automation_runs_read on public.automation_runs for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
-- Only the engine writes runs; cancelling and retrying go through the API.
revoke insert, update, delete on public.automation_runs from authenticated;

-- Queue runs when an event happens.
create function private.queue_automations() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.automation_runs (company_id, rule_id, activity_id, subject_type, subject_id, run_after)
  select r.company_id, r.id, new.id, new.subject_type, new.subject_id, now() + make_interval(mins => r.delay_minutes)
  from public.automation_rules r
  where r.company_id = new.company_id and r.enabled and r.trigger = new.verb;
  return null;
end $$;
create trigger queue_automations after insert on public.activity
  for each row execute function private.queue_automations();

-- Turning a rule off cancels its waiting runs.
create function private.cancel_disabled_runs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.enabled and not new.enabled then
    update public.automation_runs set status = 'cancelled', finished_at = now(), error = 'Rule turned off'
    where rule_id = new.id and status = 'pending';
  end if;
  return null;
end $$;
create trigger cancel_disabled_runs after update of enabled on public.automation_rules
  for each row execute function private.cancel_disabled_runs();

-- The engine claims due runs (optionally for one company, when kicked after an action).
create function public.claim_automation_runs(p_limit integer default 25, p_company uuid default null)
returns setof public.automation_runs language plpgsql security definer set search_path = '' as $$
begin
  -- Runs that crashed three times stop retrying.
  update public.automation_runs
     set status = 'failed', finished_at = now(), locked_until = null, error = coalesce(error, 'Stopped after 3 attempts')
   where status = 'running' and locked_until < now() and attempts >= 3;

  return query
  update public.automation_runs r
     set status = 'running', locked_until = now() + interval '5 minutes', attempts = r.attempts + 1
   where r.id in (
     select x.id from public.automation_runs x
      where ((x.status = 'pending' and x.run_after <= now()) or (x.status = 'running' and x.locked_until < now()))
        and (p_company is null or x.company_id = p_company)
      order by x.run_after
      limit least(greatest(p_limit, 1), 100)
      for update skip locked)
  returning r.*;
end $$;
revoke execute on function public.claim_automation_runs(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_automation_runs(integer, uuid) to service_role;

-- Day-before visit reminders: one 'visit.reminder' event per visit, only for companies that use them.
create or replace function public.emit_visit_reminders() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  with due as (
    select v.id, v.company_id, v.title, v.scheduled_on, private.visit_client(v) as client_id
    from public.visits v
    join public.companies c on c.id = v.company_id
    where v.status = 'scheduled'
      and v.kind in ('job', 'assessment')
      and v.scheduled_on = ((now() at time zone c.timezone)::date + 1)
      and extract(hour from now() at time zone c.timezone) >= 8 -- sent in the morning, not at midnight
      and exists (select 1 from public.automation_rules r where r.company_id = v.company_id and r.enabled and r.trigger = 'visit.reminder')
      and not exists (select 1 from public.activity a where a.subject_id = v.id and a.verb = 'visit.reminder')
  )
  insert into public.activity (company_id, actor_id, verb, subject_type, subject_id, summary, data)
  select d.company_id, null, 'visit.reminder', 'visit', d.id, 'Reminder due: ' || d.title,
         jsonb_build_object('client_id', d.client_id, 'scheduled_on', d.scheduled_on)
  from due d where d.client_id is not null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.emit_visit_reminders() from public, anon, authenticated;
grant execute on function public.emit_visit_reminders() to service_role;

-- ---------------------------------------------------------------------------------------------
-- Starter rules every company gets (they can edit or turn off any of them).
-- ---------------------------------------------------------------------------------------------

create function private.install_default_automations(p_company uuid) returns void
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
    (p_company, 'review_after_job', 'Ask for a Google review after a job',
     'Sends your review link a day after a job is completed.', 'job.completed', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

create function private.company_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.install_default_automations(new.id);
  return null;
end $$;
create trigger install_defaults after insert on public.companies
  for each row execute function private.company_defaults();

-- Existing companies get the starter rules too.
select private.install_default_automations(id) from public.companies;

-- Refresh PostgREST's schema cache so new tables and relationships are available at once.
notify pgrst, 'reload schema';
