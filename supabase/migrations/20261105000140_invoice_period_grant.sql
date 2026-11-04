-- create_invoice_for_job runs as the person asking (security invoker), and for a month it reads two
-- date helpers from 20261104000800_recurring_billing.sql that were only ever granted to the server.
-- So invoicing a month with no reminder yet failed for the office through the API and the assistant
-- ("permission denied for function invoice_period"). They only do date arithmetic.
grant execute on function private.invoice_period(integer, date), private.visit_day(date, timestamptz, text) to authenticated, service_role;
