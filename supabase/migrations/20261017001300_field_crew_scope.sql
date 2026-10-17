-- Field crew ("Employee") see only their own work: the visits they're assigned to, and the jobs,
-- clients, properties, requests and messages behind those visits. Quotes (and their totals) are for
-- sales and the office. Crew leads and up keep seeing the whole schedule.

-- Helpers run as the owner, so policies can use them without recursing into each other's RLS.
create function private.assigned_to_visit(p_visit uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.visit_assignees a where a.visit_id = p_visit and a.user_id = (select auth.uid()))
$$;

create function private.my_visits() returns setof public.visits
language sql stable security definer set search_path = '' as $$
  select v.* from public.visits v join public.visit_assignees a on a.visit_id = v.id where a.user_id = (select auth.uid())
$$;

create function private.crew_sees_job(p_job uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.my_visits() v where v.job_id = p_job)
$$;

create function private.crew_sees_client(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.my_visits() v
    left join public.jobs j on j.id = v.job_id
    left join public.requests r on r.id = v.request_id
    left join public.properties p on p.id = v.property_id
    where p_client in (j.client_id, r.client_id, p.client_id)
  )
$$;

create function private.crew_sees_property(p_property uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.my_visits() v
    left join public.jobs j on j.id = v.job_id
    left join public.requests r on r.id = v.request_id
    where p_property in (v.property_id, j.property_id, r.property_id)
  )
$$;

create function private.crew_sees_request(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.my_visits() v where v.request_id = p_request)
$$;

grant execute on function private.assigned_to_visit(uuid), private.crew_sees_job(uuid), private.crew_sees_client(uuid),
  private.crew_sees_property(uuid), private.crew_sees_request(uuid) to authenticated;
revoke execute on function private.my_visits() from public;

-- Visits
drop policy visits_read on public.visits;
create policy visits_read on public.visits for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.assigned_to_visit(id))
);

-- Jobs (replaces the version from 20261017001200 with the shared helper)
drop policy jobs_read on public.jobs;
create policy jobs_read on public.jobs for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.crew_sees_job(id))
);

-- Clients, properties, requests
drop policy clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.crew_sees_client(id))
);
drop policy properties_read on public.properties;
create policy properties_read on public.properties for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.crew_sees_property(id))
);
drop policy requests_read on public.requests;
create policy requests_read on public.requests for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.crew_sees_request(id))
);

-- Quotes and their totals: sales and the office only.
drop policy quotes_read on public.quotes;
create policy quotes_read on public.quotes for select to authenticated using (private.has_role(company_id, '{owner,admin,office,estimator}'));

-- Messages: crews read and add notes only for clients they work for.
drop policy messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and client_id is not null and private.crew_sees_client(client_id))
);
drop policy messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and client_id is not null and private.crew_sees_client(client_id))
);
