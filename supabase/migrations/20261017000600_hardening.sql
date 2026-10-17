-- Tighter delete rules and one more starter automation.

-- Photos and files: anyone on the team can add them; only the office or whoever uploaded one can
-- remove it.
drop policy attachments_delete on public.attachments;
create policy attachments_delete on public.attachments for delete to authenticated using (
  private.has_role(company_id, '{owner,admin,office}') or created_by = (select auth.uid())
);
drop policy attachments_update on public.attachments;
create policy attachments_update on public.attachments for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') or created_by = (select auth.uid()))
  with check (private.is_member(company_id));

-- Storage: uploaders can remove their own files too (receipts, visit photos).
drop policy files_delete on storage.objects;
create policy files_delete on storage.objects for delete to authenticated using (
  bucket_id = 'files' and (
    private.has_role(private.path_company(name), '{owner,admin,office}')
    or (owner = (select auth.uid()) and private.is_member(private.path_company(name)))
  )
);

-- "On my way" text, off until the company turns it on.
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

select private.install_default_automations(id) from public.companies;

notify pgrst, 'reload schema';
