-- Pay rates on time entries are private like members' rates (20261017000800_pay_rate_privacy.sql).
-- An approved entry keeps the rate it was approved at, and crew leads (who see their crew's time)
-- and field crew (their own) could read it there. Now nobody reads the column directly: job costs
-- and reports get it from the API, which reads it with the service role for the office with the
-- job costs area. Adding, editing and approving time work as before.
revoke select on public.time_entries from anon, authenticated;
-- Every other column stays readable (a column added later needs its own grant).
grant select (id, company_id, user_id, visit_id, job_id, category, started_at, ended_at, notes, approved_by, approved_at,
              created_at, updated_at, reminded_at, auto_stopped_at)
  on public.time_entries to authenticated;
