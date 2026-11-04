-- A job's state works out the company's today once. The Jobs list counts each of its tabs by
-- filtering on job_state, so it runs for every job many times over, and it asked for today (a lookup
-- of the company's time zone) up to twice a job. Same rules, same answers.

-- A job's earliest open visit from one index entry: visits_job_idx alone reads every visit the job
-- ever had (years of a recurring job's finished ones) to find it. Only open visits are in it.
create index visits_open_job_day_idx on public.visits (job_id, scheduled_on)
  where status not in ('completed', 'cancelled') and scheduled_on is not null;

-- As in 20261105000500_job_pause.sql, except today is looked up once, alongside the earliest open
-- visit (an aggregate, so the planner keeps it as one row rather than copying the lookup into each
-- comparison).
create or replace function public.job_state(j public.jobs) returns text
language sql stable security invoker set search_path = '' as $$
  select case
    when j.status <> 'active' then j.status
    when exists (select 1 from public.due_invoices d where d.job_id = j.id) then 'requires_invoicing'
    when j.paused_at is not null then 'paused'
    else (
      select case
        when n.first_on is null then 'unscheduled'
        when n.first_on < n.today then 'late'
        when n.first_on = n.today then 'today'
        else 'upcoming' end
      from (
        select min(v.scheduled_on) as first_on, private.company_today(j.company_id) as today
        from public.visits v
        where v.job_id = j.id and v.status not in ('completed', 'cancelled') and v.scheduled_on is not null
      ) n
    ) end
$$;
