-- The Jobs list's tab counts in one go: how many of the company's jobs are in each state (job_state),
-- as the person asking can see them. Before, each of its 8 tabs was its own count, and each worked out
-- every job's state again.
create function public.job_state_counts(p_company uuid) returns table (state text, jobs bigint)
language sql stable security invoker set search_path = '' as $$
  select public.job_state(j), count(*) from public.jobs j where j.company_id = p_company group by 1
$$;
revoke execute on function public.job_state_counts(uuid) from public, anon;
grant execute on function public.job_state_counts(uuid) to authenticated;

notify pgrst, 'reload schema';
