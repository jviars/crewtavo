-- Database tests for bringing open work over from Jobber (20261105000300_jobber_import.sql): open
-- quotes, unpaid invoices (with what was paid there) and active jobs come in quietly, with Jobber's
-- numbers kept and Crewtavo's own given; nothing is added that Jobber didn't charge (no trip charge,
-- minimum charge or late fee, the client's terms don't move a due date); no automation runs, so
-- nothing is sent; the same rows again add nothing; and only the business's owner or admin can do it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema jbi;
grant usage on schema jbi to authenticated, service_role;
create function jbi.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function jbi.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema jbi to authenticated, service_role;

-- Jo owns Juniper Lawn, with Cy on her crew and Of in her office; Ed owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ab510000-0000-0000-0000-000000000001', 'jo@juniper.test', '{"full_name": "Jo Juniper"}'),
  ('ab510000-0000-0000-0000-000000000002', 'cy@juniper.test', '{"full_name": "Cy Crew"}'),
  ('ab510000-0000-0000-0000-000000000003', 'of@juniper.test', '{"full_name": "Of Office"}'),
  ('ab510000-0000-0000-0000-000000000009', 'ed@elder.test', '{"full_name": "Ed Elder"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Elder Snow', 'general') as other \gset
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Juniper Lawn', 'general', 'America/New_York') as co \gset
-- A trip charge on every job, a $100 minimum and a $25 late fee: none of them for what's brought in.
insert into public.services (company_id, name, unit, unit_price, taxable, add_to_every_job) values (:'co', 'Trip charge', 'visit', 15, false, true) returning id as trip \gset
insert into public.clients (company_id, display_name, email, payment_terms_days) values (:'co', 'Mary Smith', 'mary@juniper-home.test', 7) returning id as mary \gset
insert into public.properties (company_id, client_id, line1, city) values (:'co', :'mary', '12 Oak St', 'Roanoke') returning id as oak \gset
insert into public.clients (company_id, display_name, tax_exempt) values (:'co', 'County Schools', true) returning id as county \gset
-- Something made here before, so Crewtavo's numbers are under way.
insert into public.quotes (company_id, client_id, title) values (:'co', :'mary', 'Made here') returning number as here_number \gset
commit;

begin;
set local role service_role;
update public.companies set settings = settings || '{"minimum_charge": 100, "payment_terms_days": 30, "late_fee": {"type": "flat", "amount": 25, "grace_days": 0}}' where id = :'co';
insert into public.memberships (company_id, user_id, role) values (:'co', 'ab510000-0000-0000-0000-000000000002', 'field_crew'), (:'co', 'ab510000-0000-0000-0000-000000000003', 'office');
commit;

-- ===== Quotes ==================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.import_jobber(:'co', 'quotes', jsonb_build_array(
  jsonb_build_object('source_id', 'jobber:101', 'number', '101', 'client_id', :'mary', 'property_id', :'oak', 'title', 'Spring cleanup', 'status', 'sent',
    'tax_rate', 0.08, 'deposit_amount', 50, 'created_on', '2026-10-01', 'sent_on', '2026-10-02',
    'lines', jsonb_build_array(jsonb_build_object('name', 'Mulch install', 'quantity', 3, 'unit_price', 60, 'taxable', true),
                               jsonb_build_object('name', 'Edging', 'quantity', 1, 'unit_price', 45, 'taxable', true))),
  jsonb_build_object('source_id', 'jobber:102', 'number', '102', 'client_id', :'mary', 'title', 'Lot sealcoat', 'status', 'approved', 'approved_on', '2026-09-20',
    'lines', jsonb_build_array(jsonb_build_object('name', 'Sealcoat', 'quantity', 1, 'unit_price', 2400))))) as quotes \gset
commit;

select id as q101 from public.quotes where source_id = 'jobber:101' \gset
select id as q102 from public.quotes where source_id = 'jobber:102' \gset
select jbi.check((select status = 'sent' and title = 'Spring cleanup' and property_id = :'oak' and total = 243 and deposit_amount = 50
  and sent_at::date = '2026-10-02' and created_at::date = '2026-10-01' and custom_fields = '{"jobber_quote": "101"}' from public.quotes where id = :'q101'),
  'an open quote comes in as it was in Jobber: sent, with its lines, tax, deposit and dates');
select jbi.check((select status = 'approved' and approved_at::date = '2026-09-20' and total = 2400 from public.quotes where id = :'q102'), 'an approved one comes in approved, ready to become a job');
select jbi.check((select array_agg(number order by number) = array[:here_number + 1, :here_number + 2]::bigint[] from public.quotes where source_id is not null),
  'Crewtavo numbers them next in its own sequence (Jobber''s number is kept beside it)');
select jbi.check((select count(*) = 1 from public.custom_field_definitions where company_id = :'co' and record_type = 'quote' and key = 'jobber_quote' and label = 'Jobber quote #' and type = 'text'),
  'a "Jobber quote #" field shows Jobber''s number');
select jbi.check(not exists (select 1 from public.quote_line_items where quote_id in (:'q101', :'q102') and service_id = :'trip'), 'no trip charge joins Jobber''s lines');
select jbi.check(not exists (select 1 from public.activity where subject_id in (:'q101', :'q102'))
  and not exists (select 1 from public.automation_runs where subject_id in (:'q101', :'q102')), 'no activity, so no quote follow-up goes to the client');
select jbi.check(jsonb_array_length(:'quotes'::jsonb) = 2 and (select bool_and((e ->> 'new')::boolean) from jsonb_array_elements(:'quotes'::jsonb) e), 'both are new');

-- ===== Invoices ================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.import_jobber(:'co', 'invoices', jsonb_build_array(
  -- Past due, half paid in Jobber; issued with the business's 30 days, though Mary's terms are 7.
  jsonb_build_object('source_id', 'jobber:2001', 'number', '2001', 'client_id', :'mary', 'subject', 'Fall work', 'issued_on', '2026-01-01', 'due_on', '2026-01-31',
    'tax_rate', 0.07, 'total', 214, 'paid', 100,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Mowing', 'quantity', 4, 'unit_price', 45, 'taxable', true),
                               jsonb_build_object('name', 'Trimming', 'quantity', 1, 'unit_price', 20, 'taxable', true))),
  -- Under the minimum, and not due yet.
  jsonb_build_object('source_id', 'jobber:2002', 'number', '2002', 'client_id', :'mary', 'issued_on', (current_date)::text, 'due_on', (current_date + 20)::text,
    'total', 40, 'paid', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Weeding', 'quantity', 1, 'unit_price', 40))),
  -- Taxed in Jobber, but the client is tax exempt here: Jobber's total still stands.
  jsonb_build_object('source_id', 'jobber:2003', 'number', '2003', 'client_id', :'county', 'subject', 'Field mowing', 'issued_on', (current_date)::text, 'due_on', (current_date + 30)::text,
    'tax_rate', 0.05, 'total', 105, 'paid', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Field mowing', 'quantity', 1, 'unit_price', 100, 'taxable', true))))) as invoices \gset
commit;

select id as i2001 from public.invoices where source_id = 'jobber:2001' \gset
select id as i2002 from public.invoices where source_id = 'jobber:2002' \gset
select id as i2003 from public.invoices where source_id = 'jobber:2003' \gset
select jbi.check((select status = 'overdue' and total = 214 and amount_paid = 100 and balance_due = 114 and due_on = '2026-01-31' and sent_at::date = '2026-01-01'
  and custom_fields = '{"jobber_invoice": "2001"}' from public.invoices where id = :'i2001'),
  'a past-due invoice owes what it owed in Jobber, due when Jobber said (not moved by the client''s terms)');
select jbi.check((select count(*) = 1 and min(amount) = 100 and min(method) = 'other' and min(notes) = 'Paid in Jobber before the move' and min(received_at)::date = '2026-01-01'
  from public.payments where invoice_id = :'i2001'), 'what was paid in Jobber is one payment, saying so');
select jbi.check((select status = 'sent' and total = 40 and minimum_charge is null from public.invoices where id = :'i2002')
  and not exists (select 1 from public.invoice_line_items where invoice_id = :'i2002' and kind = 'minimum'), 'no minimum charge tops one up');
select jbi.check((select total = 105 and tax_rate = 0 from public.invoices where id = :'i2003')
  and (select count(*) = 1 and min(unit_price) = 105 and not bool_or(taxable) from public.invoice_line_items where invoice_id = :'i2003'),
  'where Crewtavo would add it up differently, Jobber''s total comes in as one line');
select jbi.check(not exists (select 1 from public.activity where subject_id in (:'i2001', :'i2002', :'i2003'))
  and not exists (select 1 from public.automation_runs where subject_id in (:'i2001', :'i2002', :'i2003'))
  and not exists (select 1 from public.outbox where payload ->> 'invoice_id' in (:'i2001', :'i2002', :'i2003')),
  'no activity, so no invoice or past-due email, and nothing queued for accounting or Stripe');

begin;
set local role service_role;
select public.add_late_fees() as fees \gset
select public.mark_overdue_invoices() as flagged \gset
commit;
select jbi.check(not exists (select 1 from public.invoice_line_items where invoice_id in (:'i2001', :'i2002', :'i2003') and kind = 'late_fee'),
  'the hourly upkeep adds no late fee to a Jobber balance');
select jbi.check(not exists (select 1 from public.automation_runs where subject_id = :'i2001'), 'and doesn''t make an already past-due one news');

-- ===== Jobs ====================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.import_jobber(:'co', 'jobs', jsonb_build_array(
  jsonb_build_object('source_id', 'jobber:J50', 'number', 'J50', 'client_id', :'mary', 'property_id', :'oak', 'title', 'Biweekly mowing', 'kind', 'recurring',
    'recurrence_rule', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'starts_on', '2026-10-06', 'visit_duration_min', 90, 'pricing', 'per_visit',
    'lines', jsonb_build_array(jsonb_build_object('name', 'Mowing', 'quantity', 1, 'unit_price', 45))),
  jsonb_build_object('source_id', 'jobber:J51', 'number', 'J51', 'client_id', :'mary', 'title', 'Pool service', 'kind', 'recurring', 'pricing', 'fixed'),
  jsonb_build_object('source_id', 'jobber:J60', 'number', 'J60', 'client_id', :'mary', 'title', 'Patio pavers', 'kind', 'one_off',
    'lines', jsonb_build_array(jsonb_build_object('name', 'Pavers', 'quantity', 50, 'unit_price', 20))))) as jobs \gset
commit;

select id as j50 from public.jobs where source_id = 'jobber:J50' \gset
select id as j51 from public.jobs where source_id = 'jobber:J51' \gset
select id as j60 from public.jobs where source_id = 'jobber:J60' \gset
select jbi.check((select kind = 'recurring' and status = 'active' and recurrence_rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' and starts_on = '2026-10-06' and visit_duration_min = 90
  and billing_mode = 'per_visit' and custom_fields = '{"jobber_job": "J50"}' from public.jobs where id = :'j50'), 'a recurring job with its schedule comes in repeating, billed per visit');
select jbi.check((select kind = 'one_off' and recurrence_rule is null and pricing is null from public.jobs where id = :'j51'), 'one without a schedule comes in for the office to set it');
select jbi.check((select kind = 'one_off' and status = 'active' from public.jobs where id = :'j60'), 'an active one-off job comes in active');
select jbi.check(not exists (select 1 from public.job_line_items where job_id in (:'j50', :'j51', :'j60') and service_id = :'trip')
  and (select count(*) = 1 from public.job_line_items where job_id = :'j60'), 'Jobber''s lines, and no trip charge, even after they''re saved');
select jbi.check(not exists (select 1 from public.activity where subject_id in (:'j50', :'j51', :'j60')), 'no "job created" news');

-- A job made here still gets the trip charge.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.jobs (company_id, client_id, title) values (:'co', :'mary', 'Made here') returning id as made_here \gset
commit;
select jbi.check(exists (select 1 from public.job_line_items where job_id = :'made_here' and service_id = :'trip'), 'a job made here still gets its trip charge');

-- ===== The same files again ====================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.import_jobber(:'co', 'quotes', jsonb_build_array(jsonb_build_object('source_id', 'jobber:101', 'number', '101', 'client_id', :'mary', 'title', 'Spring cleanup again', 'status', 'draft'))) as again \gset
select public.import_jobber(:'co', 'invoices', jsonb_build_array(jsonb_build_object('source_id', 'jobber:2001', 'number', '2001', 'client_id', :'mary', 'total', 214, 'paid', 100))) as again_invoice \gset
select public.import_jobber(:'co', 'jobs', jsonb_build_array(jsonb_build_object('source_id', 'jobber:J60', 'number', 'J60', 'client_id', :'mary', 'title', 'Patio', 'kind', 'one_off'))) as again_job \gset
commit;
select jbi.check(not (:'again'::jsonb -> 0 ->> 'new')::boolean and (:'again'::jsonb -> 0 ->> 'id')::uuid = :'q101'
  and not (:'again_invoice'::jsonb -> 0 ->> 'new')::boolean and not (:'again_job'::jsonb -> 0 ->> 'new')::boolean, 'importing again finds each one already here');
select jbi.check((select count(*) = 2 from public.quotes where source_id is not null) and (select count(*) = 3 from public.invoices where source_id is not null)
  and (select count(*) = 3 from public.jobs where source_id is not null) and (select count(*) = 1 from public.payments where invoice_id = :'i2001')
  and (select title = 'Spring cleanup' and status = 'sent' from public.quotes where id = :'q101'), 'and adds or changes nothing');
select jbi.check((select count(*) = 1 from public.custom_field_definitions where company_id = :'co' and key = 'jobber_quote'), 'the field is made once');

-- ===== Who can ==================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select jbi.expect_error(format($q$select public.import_jobber(%L, 'jobs', %L)$q$, :'co',
  jsonb_build_array(jsonb_build_object('source_id', 'jobber:J99', 'number', 'J99', 'client_id', :'mary', 'title', 'Sneaky', 'kind', 'one_off'))), 'the crew can''t bring work in');
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select jbi.expect_error(format($q$select public.import_jobber(%L, 'jobs', %L)$q$, :'co',
  jsonb_build_array(jsonb_build_object('source_id', 'jobber:J98', 'number', 'J98', 'client_id', :'mary', 'title', 'Quiet', 'kind', 'one_off'))), 'nor the rest of the office: it''s quiet, so it''s the owner''s or an admin''s');
select set_config('request.jwt.claims', '{"sub": "ab510000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select jbi.expect_error(format($q$select public.import_jobber(%L, 'quotes', %L)$q$, :'co',
  jsonb_build_array(jsonb_build_object('source_id', 'jobber:999', 'number', '999', 'client_id', :'mary', 'title', 'Not mine', 'status', 'draft'))), 'another business can''t bring work into this one');
select jbi.expect_error(format($q$select public.import_jobber(%L, 'quotes', %L)$q$, :'other',
  jsonb_build_array(jsonb_build_object('source_id', 'jobber:998', 'number', '998', 'client_id', :'mary', 'title', 'Their client', 'status', 'draft'))), 'nor put this one''s client on its own');
select jbi.check(not exists (select 1 from public.quotes where source_id = 'jobber:101') and not exists (select 1 from public.invoices where source_id = 'jobber:2001'), 'and sees none of what this one brought in');
select jbi.expect_error(format($q$select public.import_jobber(%L, 'payments', '[]')$q$, :'other'), 'only quotes, invoices and jobs');
commit;
select jbi.check(not has_function_privilege('anon', 'public.import_jobber(uuid, text, jsonb)', 'execute'), 'nobody signed out can call it');
select jbi.check(not exists (select 1 from public.quotes where source_id in ('jobber:999', 'jobber:998')) and not exists (select 1 from public.jobs where source_id in ('jobber:J99', 'jobber:J98')), 'none of those came in');

\echo 'All Jobber import tests passed.'
