-- Lookups that read a whole table for want of an index: a visit's time, checklists and materials,
-- a job's time and invoices, a client's jobs and payments, and payments by the day they came in.
-- Each of these columns was checked against the indexes there are; none led one (invoices.job_id
-- only in the one-invoice-a-month index, which leaves out every invoice without a billing month).
-- Deleting a visit, a job or a client looks its rows up by these columns too.
--
-- Built in place: these tables are one business's, so each build takes a moment.
-- supabase/tests/lookup_indexes_test.sql checks every one is there.

create index if not exists time_entries_visit_idx on public.time_entries (visit_id) where visit_id is not null;
create index if not exists time_entries_job_idx on public.time_entries (job_id) where job_id is not null;
create index if not exists checklist_responses_visit_idx on public.checklist_responses (visit_id);
create index if not exists job_materials_visit_idx on public.job_materials (visit_id) where visit_id is not null;
create index if not exists invoices_job_idx on public.invoices (job_id) where job_id is not null;
create index if not exists payments_client_idx on public.payments (client_id);
create index if not exists payments_received_idx on public.payments (received_at);
create index if not exists jobs_client_idx on public.jobs (client_id);
