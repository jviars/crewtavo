-- Files sent with a booking request: a general contractor's plan set, a city's work order, photos of
-- the driveway. The public form uploads them (apps/api/src/routes/public.ts) and they're plan files
-- on the request and its property, so they show on the request and go on the quote made from it
-- (and from there on the job, like any quote's files). Crews on an assessment visit for the request
-- see the ones marked for the crew.

alter table public.plan_files
  add column request_id uuid,
  add constraint plan_files_request_fk foreign key (company_id, request_id)
    references public.requests (company_id, id) on delete set null (request_id);
create index plan_files_request_idx on public.plan_files (company_id, request_id) where request_id is not null;

-- A new file takes the property from its request too.
create or replace function private.plan_files_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev public.plan_files;
begin
  if new.replaces_id is not null then
    select * into v_prev from public.plan_files where id = new.replaces_id and company_id = new.company_id for update;
    if not found then
      raise exception 'That file wasn''t found' using errcode = '23503';
    end if;
    -- A crew lead can only add a version of a file they can see.
    if not private.has_role(new.company_id, '{owner,admin,office,estimator}') and (not v_prev.crew_visible or v_prev.archived) then
      raise exception 'That file wasn''t found' using errcode = '23503';
    end if;
    if v_prev.superseded_at is not null then
      raise exception 'A newer version of % was already added. Refresh and try again.', v_prev.title using errcode = '23505';
    end if;
    new.property_id := coalesce(new.property_id, v_prev.property_id);
    new.request_id := coalesce(new.request_id, v_prev.request_id);
    new.quote_id := coalesce(new.quote_id, v_prev.quote_id);
    new.job_id := coalesce(new.job_id, v_prev.job_id);
  end if;
  if new.property_id is null and new.job_id is not null then
    select property_id into new.property_id from public.jobs where id = new.job_id and company_id = new.company_id;
  end if;
  if new.property_id is null and new.quote_id is not null then
    select property_id into new.property_id from public.quotes where id = new.quote_id and company_id = new.company_id;
  end if;
  if new.property_id is null and new.request_id is not null then
    select property_id into new.property_id from public.requests where id = new.request_id and company_id = new.company_id;
  end if;
  if new.property_id is null and new.request_id is null and new.quote_id is null and new.job_id is null then
    raise exception 'A file goes on a property, a request, a quote or a job' using errcode = '23514';
  end if;
  new.superseded_at := null;
  return new;
end $$;

-- A quote made from the request gets the request's files.
create function private.plan_files_follow_quote() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.request_id is not null then
    update public.plan_files set quote_id = new.id
    where company_id = new.company_id and request_id = new.request_id and quote_id is null;
  end if;
  return null;
end $$;
create trigger plan_files_follow_quote after insert or update of request_id on public.quotes
  for each row execute function private.plan_files_follow_quote();

-- Crews on a visit for the request (an assessment) see its files marked for the crew.
drop policy plan_files_read on public.plan_files;
create policy plan_files_read on public.plan_files for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator}')
  or (crew_visible and not archived and superseded_at is null and (
    private.has_role(company_id, '{crew_lead}')
    or (private.is_member(company_id) and (
      (job_id is not null and private.crew_sees_job(job_id))
      or (property_id is not null and private.crew_sees_property(property_id))
      or (request_id is not null and private.crew_sees_request(request_id))
    ))
  ))
);

-- Rewrite the new policy's per-row checks like the others (see 20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
