-- Field crew see a client's other contacts, the files on a record and the news of a visit or a new
-- job only for their own work: the visits they're on, and the jobs, clients, properties and requests
-- behind them. 20261017001300_field_crew_scope.sql drew that line for clients, properties, requests
-- and messages; these three tables still showed every client's to anyone on the team. Crew leads
-- and the office keep seeing all of it, as they do clients.
--
--   client_contacts   the contacts of a client they work for (as the client itself)
--   attachments       the files on a visit they're on, on its job, property, request or client, and
--                     on the quote that job came from (the Photos card on a job shows those); and
--                     the ones they added themselves, which stay theirs to see and take back
--   activity          "visit started", "job created" and the like for their own visits and jobs,
--                     which name the client
--
-- Writing is unchanged. supabase/tests/crew_contacts_test.sql covers it.

-- The quotes behind the jobs this person has visits on (what private.crew_jobs is for jobs).
create function private.crew_quotes() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select j.quote_id from private.my_visits() v join public.jobs j on j.id = v.job_id where j.quote_id is not null
$$;
revoke all on function private.crew_quotes() from public;
grant execute on function private.crew_quotes() to authenticated, service_role;

drop policy client_contacts_read on public.client_contacts;
create policy client_contacts_read on public.client_contacts for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.crew_sees_client(client_id))
);

drop policy attachments_read on public.attachments;
create policy attachments_read on public.attachments for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and (
    created_by = (select auth.uid())
    or (owner_type = 'visit' and private.assigned_to_visit(owner_id))
    or (owner_type = 'job' and private.crew_sees_job(owner_id))
    or (owner_type = 'quote' and owner_id in (select private.crew_quotes()))
    or (owner_type = 'property' and private.crew_sees_property(owner_id))
    or (owner_type = 'request' and private.crew_sees_request(owner_id))
    or (owner_type = 'client' and private.crew_sees_client(owner_id))
  ))
);

-- The office's part is as it was (20261018000100_audit_fixes.sql): invoice and payment news needs
-- the invoices area.
drop policy activity_read on public.activity;
create policy activity_read on public.activity for select to authenticated using (
  (private.has_role(company_id, '{owner,admin,office,estimator}')
   and (subject_type is distinct from 'invoice' or private.has_perm(company_id, 'invoices')))
  or ((verb like 'visit.%' or verb = 'job.created') and (
    private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
    or (private.is_member(company_id) and (
      (subject_type = 'visit' and private.assigned_to_visit(subject_id))
      or (subject_type = 'job' and private.crew_sees_job(subject_id))
    ))
  ))
);

-- The policies above check membership once per query (20261018000990_policy_lookups).
select private.fold_member_checks('public.client_contacts');
select private.fold_member_checks('public.attachments');
select private.fold_member_checks('public.activity');

notify pgrst, 'reload schema';
