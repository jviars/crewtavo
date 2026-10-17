-- Recurring visits someone deleted stay deleted, and an automation run is done by one worker.
--
-- The recurrence task (and saving a recurring job) adds any visit missing from the next 60 days,
-- matched on the job and the date it's for (visits.recurrence_key). Deleting a generated visit left
-- no trace, so the next run put it back on the default crew. Now a person deleting one leaves its
-- date here, and the API skips remembered dates. The API's own clean-up of dates a schedule no
-- longer has runs with the service key (no auth.uid()), so it isn't remembered.

create table public.recurrence_skips (
  company_id uuid not null,
  job_id uuid not null,
  recurrence_key text not null, -- the deleted visit's recurrence_key: the local date it was for
  deleted_by uuid references auth.users (id) on delete set null default auth.uid(),
  deleted_at timestamptz not null default now(),
  primary key (job_id, recurrence_key),
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete cascade
);
alter table public.recurrence_skips enable row level security;
create policy recurrence_skips_read on public.recurrence_skips for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}'));
-- Rows come only from deleting visits (below); the API reads them with the service key.
revoke insert, update, delete on public.recurrence_skips from authenticated;
revoke all on public.recurrence_skips from anon;

create function private.remember_deleted_occurrence() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Not the API's own clean-up, and not when the job itself is being deleted (its visits go with it).
  if old.recurrence_key is not null and (select auth.uid()) is not null
     and exists (select 1 from public.jobs where id = old.job_id) then
    insert into public.recurrence_skips (company_id, job_id, recurrence_key)
    values (old.company_id, old.job_id, old.recurrence_key)
    on conflict do nothing;
  end if;
  return null;
end $$;
create trigger remember_deleted_occurrence after delete on public.visits
  for each row execute function private.remember_deleted_occurrence();

-- The engine claims up to 50 automation runs for five minutes and does them one after another, so
-- a slow batch can outlast its claim and another worker can claim the rest and do them too. Right
-- before each run the engine confirms it still holds the claim (the run is still 'running' with the
-- locked_until it was claimed with) and extends it. False means someone else has it now.
create function public.extend_automation_run(p_id bigint, p_locked_until timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_runs
     set locked_until = now() + interval '5 minutes'
   where id = p_id and status = 'running' and locked_until = p_locked_until;
  return found;
end $$;
revoke execute on function public.extend_automation_run(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.extend_automation_run(bigint, timestamptz) to service_role;

notify pgrst, 'reload schema';
