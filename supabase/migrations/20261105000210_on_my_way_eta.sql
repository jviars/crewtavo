-- An arrival time in the "on my way" text, as Jobber's has: "Our crew is on the way to 12 Oak St now
-- and should arrive in about 20 minutes." When a crew taps On my way, the API works out when they
-- should get there (services/routes.ts arrivalTime): the drive from where the phone was, if the
-- business keeps where people clock in and the person lets the phone say, or else from the crew's
-- last visit finished that day, timed as route planning times drives. Only that time is kept, on the
-- visit; the phone's place isn't. The template word {{eta}} says it (" and should arrive in about 20
-- minutes"), or nothing when it isn't known, so the sentence reads well either way.
--
-- The on_my_way starter uses it, and rules still word for word the old starter get it too; one a
-- business changed stays as they wrote it.

alter table public.visits add column eta_at timestamptz;
comment on column public.visits.eta_at is 'When the crew on its way should get there, worked out as they tap On my way, for the client''s text. Where they were isn''t kept.';

-- As in 20261101000100_autopay.sql, with eta_at among what a sub's On my way changes (the API sets it
-- with the status).
create or replace function private.visit_sub_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  free constant text[] := array['status', 'notes', 'completed_at', 'completed_by', 'updated_at', 'eta_at'];
begin
  if (select auth.uid()) is null or not (old.company_id = any (private.sub_companies())) then return new; end if;
  if to_jsonb(new) - free is distinct from to_jsonb(old) - free then
    raise exception 'You can change a visit''s status and notes. Ask the office about anything else.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and (old.status in ('completed', 'cancelled') or new.status not in ('scheduled', 'en_route', 'in_progress', 'completed')) then
    raise exception 'Ask the office to cancel, move or reopen this visit.' using errcode = '42501';
  end if;
  new.completed_at := case
    when new.status = 'completed' and old.completed_at is null
         and new.completed_at <= now() and new.completed_at >= now() - interval '3 days' then new.completed_at
    when new.status = 'completed' then coalesce(old.completed_at, now())
    else old.completed_at end;
  new.completed_by := case when new.status = 'completed' and old.completed_at is null then (select auth.uid()) else old.completed_by end;
  return new;
end $$;

-- As in 20261031000510_credit_covered_invoices.sql, with the arrival time in the on_my_way text.
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
     null, 'invoice.paid', 0, jsonb_build_array(jsonb_build_object('field', 'amount_paid', 'op', 'gte', 'value', 0.01)),
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
       'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now{{eta}}.')), false),
    (p_company, 'review_after_job', 'Ask for a Google review after a job',
     'Sends your review link a day after a job is completed.', 'job.completed', 1440,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'review_recurring', 'Ask for a Google review on recurring work',
     'Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job.', 'job.recurring_third_visit', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'referral_after_job', 'Ask for referrals after a job',
     'Emails your referral link a week after a job is completed.', 'job.completed', 10080,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_referral')), false),
    (p_company, 'reengage_past_clients', 'Re-engage past clients',
     'Emails clients a year after their last visit, once each time they go quiet.', 'client.inactive', 0,
     jsonb_build_array(jsonb_build_object('field', 'days_since_visit', 'op', 'gte', 'value', 365)),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr just reply to this email and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false),
    (p_company, 'win_back_lost_quotes', 'Win back lost quotes',
     'Emails the client 30 days after a quote is marked lost, if it still is.', 'quote.lost', 43200,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'lost')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email and we''ll take another look.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

-- Rules still the old starter, word for word, say when the crew should arrive too.
update public.automation_rules
   set actions = jsonb_build_array(jsonb_build_object('type', 'send_sms',
                   'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now{{eta}}.'))
 where template_key = 'on_my_way' and trigger = 'visit.en_route'
   and actions = jsonb_build_array(jsonb_build_object('type', 'send_sms',
                   'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now.'));

notify pgrst, 'reload schema';
