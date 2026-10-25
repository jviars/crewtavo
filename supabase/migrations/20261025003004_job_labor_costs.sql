-- Job costs count labor once (docs/subcontractors-plan.md, phase C: "Job costs count sub and piece
-- pay as labor, once"). A roof service's cost (services.unit_cost) already has an estimate of its
-- labor in it (services.labor_cost, 20261022004100_material_prices.sql), and the job page adds line
-- costs, labor and expenses together, so a roof put on by a sub was counted twice.
--
--   job_line_items.unit_labor_cost   the labor in the line's unit cost: its service's labor_cost
--                                    when the line went on the job (a quote turned into the job, an
--                                    approved change order adding to it, or a line added by hand).
--                                    Existing lines get their service's labor_cost as it is now.
--   job_pay_costs()                  each job's sub and crew pay that's agreed, done or paid (what
--                                    was paid, else its total), for the office with job costs, as
--                                    the rest of a job's costs are.
--
-- A job with labor of its own (time on it, or job pay agreed, done or paid) then counts each line at
-- its cost without that labor, and the job pay as its own line, "Sub and crew pay" (jobProfit in
-- packages/core/src/reports.ts). A job without keeps counting the whole cost.

alter table public.job_line_items add column unit_labor_cost numeric(12, 2) check (unit_labor_cost >= 0);
comment on column public.job_line_items.unit_labor_cost is 'The labor in unit_cost: the service''s labor_cost when the line went on the job. Job costs leave it out once the job has labor of its own.';

-- Every way a line goes on a job (convert_quote_to_job, apply_change_order, the job page) takes the
-- labor its service's cost has in it then.
create function private.job_line_labor() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.unit_labor_cost is null and new.service_id is not null then
    select s.labor_cost into new.unit_labor_cost from public.services s where s.company_id = new.company_id and s.id = new.service_id;
  end if;
  return new;
end $$;
create trigger labor_cost before insert on public.job_line_items for each row execute function private.job_line_labor();

-- Lines already on jobs, from their service as it is now. Without touching the jobs: their
-- updated_at is when they were last changed, which Finance → Profit goes by.
alter table public.job_line_items disable trigger touch_job;
update public.job_line_items li set unit_labor_cost = s.labor_cost
from public.services s
where s.company_id = li.company_id and s.id = li.service_id and li.unit_labor_cost is null and s.labor_cost is not null;
alter table public.job_line_items enable trigger touch_job;

/** Each job's sub and crew pay that counts as labor (agreed, done or paid), for the office with job costs. */
create function public.job_pay_costs(p_jobs uuid[])
returns table (job_id uuid, amount numeric, payees integer)
language sql stable security definer set search_path = '' as $$
  select p.job_id, sum(case when p.status = 'paid' then p.paid_amount else p.total end), count(*)::integer
  from public.job_pay p
  where p.job_id = any (p_jobs) and p.status in ('accepted', 'done', 'paid')
    and p.company_id = any (private.role_companies('{owner,admin,office}')) and p.company_id = any (private.perm_companies('job_costs'))
  group by p.job_id
$$;
revoke execute on function public.job_pay_costs(uuid[]) from public, anon;
grant execute on function public.job_pay_costs(uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
