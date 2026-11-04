-- What an active job needs next, in the words someone coming from Jobber knows, worked out from its
-- visits on the company's today:
--   late         a visit before today that isn't done (Home and the job page call that visit overdue)
--   today        a visit today that isn't done
--   upcoming     a visit after today
--   unscheduled  none of these: nothing from today on, and nothing late
-- A visit isn't done until it's completed; cancelled ones don't count, and unscheduled ones have no day.
-- Since the earliest open visit decides it, late beats today beats upcoming. A job that isn't active
-- keeps its stored status (requires_invoicing, completed, archived).
--
-- A computed field on jobs: lists select, filter and count it (select=job_state, job_state=eq.late).
-- It runs with the caller's access, so it shows only on jobs they can see, from the visits they can see.
create function public.job_state(j public.jobs) returns text
language sql stable security invoker set search_path = '' as $$
  select case when j.status <> 'active' then j.status else (
    select case
      when min(v.scheduled_on) is null then 'unscheduled'
      when min(v.scheduled_on) < private.company_today(j.company_id) then 'late'
      when min(v.scheduled_on) = private.company_today(j.company_id) then 'today'
      else 'upcoming' end
    from public.visits v
    where v.job_id = j.id and v.status not in ('completed', 'cancelled') and v.scheduled_on is not null
  ) end
$$;
revoke execute on function public.job_state(public.jobs) from public, anon;
grant execute on function public.job_state(public.jobs) to authenticated, service_role;
