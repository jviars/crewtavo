-- Database tests for writing invoices off (20261020000200_invoice_write_off.sql): what can be
-- written off, what it no longer counts toward, reminders called off, paid after all, undone, and
-- invoices written off in Stripe. Run with scripts/test-db.sh (plain Postgres + prelude.sql).
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema two;
grant usage on schema two to authenticated, service_role;
create function two.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function two.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema two to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b0ad0000-0000-0000-0000-000000000001', 'owner@meadow.test', '{"full_name": "Mel Owner"}');

-- A lawn company: one invoice not due yet, one past due, one past due and partly paid, a draft, a
-- paid one, and one for a completed visit.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b0ad0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Meadow Exteriors', 'lawn_care') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Perry Arnold') returning id as perry \gset
insert into public.clients (company_id, display_name) values (:'co', 'Daren Perkins') returning id as daren \gset
insert into public.jobs (company_id, client_id, title, billing_mode) values (:'co', :'perry', 'Weekly mowing', 'per_visit') returning id as job \gset
insert into public.visits (company_id, job_id, title, scheduled_on, status) values (:'co', :'job', 'Mow', current_date - 20, 'completed') returning id as visit \gset
-- A follow-up three days after an invoice is sent, besides the usual past-due reminder.
insert into public.automation_rules (company_id, name, trigger, delay_minutes, actions)
values (:'co', 'Nudge unpaid invoices', 'invoice.sent', 4320, '[{"type": "add_note", "body": "Nudged"}]');

insert into public.invoices (company_id, client_id, due_on) values (:'co', :'perry', current_date + 20) returning id as fresh \gset
insert into public.invoices (company_id, client_id, due_on) values (:'co', :'perry', current_date - 10) returning id as late \gset
insert into public.invoices (company_id, client_id, due_on) values (:'co', :'daren', current_date - 10) returning id as part \gset
insert into public.invoices (company_id, client_id) values (:'co', :'daren') returning id as draft \gset
insert into public.invoices (company_id, client_id) values (:'co', :'daren') returning id as paid \gset
insert into public.invoices (company_id, client_id, job_id, kind) values (:'co', :'perry', :'job', 'visits') returning id as visits \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values
  (:'co', :'fresh', 'Spring cleanup', 1, 'ea', 200), (:'co', :'late', 'Aeration', 1, 'ea', 300),
  (:'co', :'part', 'Mulch', 1, 'ea', 400), (:'co', :'draft', 'Edging', 1, 'ea', 50),
  (:'co', :'paid', 'Trim', 1, 'ea', 100), (:'co', :'visits', 'Mow', 1, 'ea', 45);
update public.visits set invoice_id = :'visits' where id = :'visit';
update public.invoices set status = 'sent' where id in (:'fresh', :'late', :'part', :'paid', :'visits');
insert into public.payments (company_id, invoice_id, client_id, amount, method) values
  (:'co', :'part', :'daren', 150, 'check'), (:'co', :'paid', :'daren', 100, 'cash');
commit;

-- ===== What can be written off =================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b0ad0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select two.check((select string_agg(status, ',' order by status) from public.invoices where id in (:'fresh', :'late', :'part', :'paid')) = 'overdue,overdue,paid,sent', 'the invoices start out owed, past due and paid');
select two.expect_error(format('update public.invoices set status = %L where id = %L', 'written_off', :'draft'), 'a draft can''t be written off');
select two.expect_error(format('update public.invoices set status = %L where id = %L', 'written_off', :'paid'), 'nor a paid invoice');
select two.expect_error(format('insert into public.invoices (company_id, client_id, status) values (%L, %L, %L)', :'co', :'perry', 'written_off'), 'nor a new one');
select two.check((select count(*) from public.automation_runs where subject_id = :'late' and status = 'pending') > 0, 'reminders are waiting to go out for the past-due one');

update public.invoices set status = 'written_off' where id in (:'late', :'part', :'visits');
select two.check((select status = 'written_off' and written_off_at is not null and balance_due = 300 from public.invoices where id = :'late'), 'a past-due invoice is written off, all $300 of it, noting when');
select two.check((select status = 'written_off' and amount_paid = 150 and balance_due = 250 from public.invoices where id = :'part'), 'a partly paid one too: the $250 left');
select two.check((select invoice_id from public.visits where id = :'visit') = :'visits', 'its visits stay billed, so they don''t need invoicing again');
select two.check((select count(*) from public.automation_runs where subject_id = :'late' and status = 'pending') = 0, 'reminders waiting to go out for it are called off');
select two.check((select count(*) from public.automation_runs where subject_id = :'late' and status = 'cancelled' and error = 'The invoice was written off') > 0, 'saying why');
select two.check((select count(*) from public.automation_runs where subject_id = :'fresh' and status = 'pending') = 1, 'other invoices'' reminders still go out');
select two.check((select summary from public.activity where verb = 'invoice.written_off' and subject_id = :'late') like 'Invoice #% for Perry Arnold written off ($300.00)', 'the activity log says so');
commit;

-- ===== No longer owed, still invoiced ==========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b0ad0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.dashboard(:'co') as dash \gset
select two.check((:'dash'::jsonb #>> '{workflow,invoices,awaiting}')::int = 1 and (:'dash'::jsonb #>> '{workflow,invoices,awaiting_value}')::numeric = 200, 'the dashboard''s awaiting payment leaves them out');
select two.check((:'dash'::jsonb #>> '{workflow,invoices,past_due}')::int = 0, 'as does past due');
select two.check((:'dash'::jsonb #>> '{receivables,total}')::numeric = 200 and (:'dash'::jsonb #>> '{receivables,clients_owing}')::int = 1, 'and what clients owe');
select two.check(not exists (select 1 from jsonb_array_elements(:'dash'::jsonb -> 'attention') a where a ->> 'kind' = 'invoice'), 'and nothing past due needs attention');
select two.check((:'dash'::jsonb #>> '{month,invoiced}')::numeric = 1045, 'but the work still counts as invoiced');
commit;
set role service_role;
select public.mark_overdue_invoices();
reset role;
select two.check((select count(*) from public.invoices where id in (:'late', :'part', :'visits') and status = 'written_off') = 3, 'the hourly past-due check leaves written-off invoices alone');

-- ===== Paid after all, undone ==================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b0ad0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.payments (company_id, invoice_id, client_id, amount, method) values (:'co', :'part', :'daren', 50, 'check');
select two.check((select status = 'written_off' and balance_due = 200 from public.invoices where id = :'part'), 'some of it paid after all: still written off, for less');
insert into public.payments (company_id, invoice_id, client_id, amount, method) values (:'co', :'part', :'daren', 200, 'check');
select two.check((select status = 'paid' and written_off_at is null from public.invoices where id = :'part'), 'all of it paid: the invoice is paid');
select two.check((select count(*) from public.activity where verb = 'invoice.paid' and subject_id = :'part') = 1, 'which is noted, as any payment in full');

select count(*) as overdue_before from public.activity where verb = 'invoice.overdue' and subject_id = :'late' \gset
update public.invoices set status = 'sent' where id = :'late';
select two.check((select status = 'overdue' and written_off_at is null from public.invoices where id = :'late'), 'undone, it''s owed again, and past due as before');
select two.check((select count(*) from public.activity where verb = 'invoice.overdue' and subject_id = :'late') = :overdue_before, 'without setting off past-due reminders again');
update public.invoices set status = 'written_off' where id = :'late';

select two.expect_error(format('update public.invoices set status = %L where id = %L', 'draft', :'late'), 'a written-off invoice doesn''t go back to draft without undoing it first');
update public.invoices set status = 'void' where id = :'visits';
select two.check((select status from public.invoices where id = :'visits') = 'void', 'one sent by mistake can still be voided');
select two.check((select invoice_id from public.visits where id = :'visit') is null, 'freeing its visits as voiding does');
commit;

-- ===== Written off in Stripe ===================================================================
reset role;
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_wo_1', 'status', 'open', 'amount_due', 120,
  'customer', jsonb_build_object('id', 'cus_wo_claude', 'name', 'Claude C. Steele'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Leaf removal', 'quantity', 1, 'unit_price', 160))
), false) as made \gset
insert into public.payments (company_id, invoice_id, client_id, amount, method, processor, processor_ref)
select :'co', :'made', client_id, 40, 'other', null, 'in_wo_1:credit_note' from public.invoices where id = :'made';
select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_wo_1', 'status', 'uncollectible', 'amount_due', 120, 'written_off_at', '2026-09-30T15:00:00Z'
), false);
select two.check((select status = 'written_off' and balance_due = 120 and written_off_at = '2026-09-30T15:00:00Z' from public.invoices where id = :'made'),
  'written off in Stripe, partly paid or not: written off here, when it was there');
update public.invoices set status = 'sent' where id = :'made';
select public.stripe_import_invoice(:'co', jsonb_build_object('stripe_id', 'in_wo_1', 'status', 'uncollectible', 'amount_due', 120), false);
select two.check((select status from public.invoices where id = :'made') = 'partially_paid', 'undone here, it stays owed when Stripe tells about it again');

select public.stripe_import_invoice(:'co', jsonb_build_object(
  'stripe_id', 'in_wo_2', 'status', 'uncollectible', 'amount_due', 75,
  'customer', jsonb_build_object('id', 'cus_wo_claude'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Gutter cleaning', 'quantity', 1, 'unit_price', 75))
), true) as old \gset
select two.check((select status = 'written_off' and written_off_at is not null from public.invoices where id = :'old'), 'one brought in from history that was written off there is written off here');
