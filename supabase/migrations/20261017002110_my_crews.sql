-- The crews the signed-in person leads or is on, for the app: a crew lead's schedule, people
-- pickers and timesheets show their own crew (the rules themselves live in 20261017002100).
create function public.my_crew_ids(p_company uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(crew_id), '{}') from private.my_crews(p_company) as mine(crew_id)
$$;
revoke execute on function public.my_crew_ids(uuid) from public, anon;
grant execute on function public.my_crew_ids(uuid) to authenticated;

notify pgrst, 'reload schema';
