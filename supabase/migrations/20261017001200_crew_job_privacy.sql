-- Crews don't see pricing: job line items are for the office and sales. Field crew see only the jobs
-- they're assigned a visit on (for instructions and the client), not every job in the company.
drop policy job_line_items_read on public.job_line_items;
create policy job_line_items_read on public.job_line_items for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'));

drop policy jobs_read on public.jobs;
create policy jobs_read on public.jobs for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and exists (
    select 1 from public.visits v join public.visit_assignees a on a.visit_id = v.id
    where v.job_id = jobs.id and a.user_id = (select auth.uid())
  ))
);
