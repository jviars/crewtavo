-- Who sold a job, on the job (jobs.salesperson_id): the salesperson of the estimate it came from, so
-- whoever runs the work knows who to ask about what was promised. Crew leads can open a job but not
-- its estimate (estimates hold the prices), so it's kept here too: copied when the job is made from
-- the estimate, however that happens, and kept in step when the estimate changes hands. Selling and
-- doing the work stay apart: this names the salesperson, it doesn't put them on the job's visits.

alter table public.jobs add column salesperson_id uuid references auth.users (id) on delete set null;
comment on column public.jobs.salesperson_id is 'Who sold it: the salesperson of the estimate it came from (quotes.salesperson_id).';

update public.jobs j set salesperson_id = q.salesperson_id
  from public.quotes q
 where q.id = j.quote_id and q.company_id = j.company_id and q.salesperson_id is not null and j.salesperson_id is null;

create function private.job_salesperson() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.salesperson_id := (select q.salesperson_id from public.quotes q where q.id = new.quote_id and q.company_id = new.company_id);
  return new;
end $$;
create trigger salesperson before insert on public.jobs
  for each row when (new.quote_id is not null and new.salesperson_id is null) execute function private.job_salesperson();

-- The estimate handed to someone else after it became a job: the job says so too.
create function private.quote_salesperson_to_jobs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs set salesperson_id = new.salesperson_id
   where quote_id = new.id and company_id = new.company_id and salesperson_id is not distinct from old.salesperson_id;
  return null;
end $$;
create trigger salesperson_to_jobs after update of salesperson_id on public.quotes
  for each row when (new.salesperson_id is distinct from old.salesperson_id) execute function private.quote_salesperson_to_jobs();

notify pgrst, 'reload schema';
