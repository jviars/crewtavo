-- Checklists go with price list items, the way Jobber attaches job forms to line items: a visit
-- whose job has one of a checklist's items brings that checklist up on the crew's phone, ready to
-- fill in (job_checklists below). A checklist with no items is offered on any job, as before.
--
-- The links are a table like roof_package_items, so a checklist and its items are always the same
-- business's, and deleting either takes its links with it. They're read by the team and set, all at
-- once, by those who change checklists (set_checklist_services), Settings and AI assistants alike.
--
-- The free-text job type nothing read goes.

alter table public.checklist_templates drop column job_type;

create table public.checklist_template_services (
  company_id uuid not null,
  template_id uuid not null,
  service_id uuid not null,
  primary key (template_id, service_id),
  foreign key (company_id, template_id) references public.checklist_templates (company_id, id) on delete cascade,
  foreign key (company_id, service_id) references public.services (company_id, id) on delete cascade
);
create index checklist_template_services_service_idx on public.checklist_template_services (company_id, service_id);

-- As the checklists themselves: read by the team, changed with the Settings area.
select private.apply_policies('checklist_template_services', '{owner,admin,office}');
select private.restrict_area('checklist_template_services', 'settings', false);

/**
 * The price list items a checklist goes with, replacing the ones it had. Runs as the person, so the
 * rules above decide who may; another business's checklist isn't found, and its items aren't this
 * business's (the foreign key).
 */
create function public.set_checklist_services(p_template uuid, p_services uuid[]) returns void
language plpgsql set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.checklist_templates where id = p_template;
  if v_company is null then raise exception 'That checklist wasn''t found.' using errcode = 'P0002'; end if;
  delete from public.checklist_template_services
  where template_id = p_template and service_id <> all (coalesce(p_services, '{}'));
  insert into public.checklist_template_services (company_id, template_id, service_id)
  select v_company, p_template, s from unnest(p_services) s
  on conflict do nothing;
end $$;
revoke execute on function public.set_checklist_services(uuid, uuid[]) from public, anon;
grant execute on function public.set_checklist_services(uuid, uuid[]) to authenticated;

/**
 * The turned-on checklists that go with a job's line items, for the crew app. The crew can't read
 * the lines (they have prices), so this answers for whoever sees the job's work, as job_scope() does.
 */
create function public.job_checklists(p_job uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct cs.template_id
  from public.jobs j
  join public.job_line_items li on li.job_id = j.id
  join public.checklist_template_services cs on cs.company_id = j.company_id and cs.service_id = li.service_id
  join public.checklist_templates t on t.id = cs.template_id and t.active
  where j.id = p_job
    and (private.has_role(j.company_id, '{owner,admin,office,estimator,crew_lead}')
         or (private.is_member(j.company_id) and private.crew_sees_job(j.id))
         or (j.company_id = any (private.sub_companies()) and private.crew_sees_job(j.id)))
$$;
revoke execute on function public.job_checklists(uuid) from public, anon;
grant execute on function public.job_checklists(uuid) to authenticated;

-- An AI assistant sets a checklist's items with the function above, as a change to checklists
-- (as in 20261019002000_assistant_more_areas.sql, with that one added).
create or replace function private.assistant_rpc_area(p_function text) returns text
language sql immutable set search_path = '' as $$
  select case p_function
    when 'convert_quote_to_job' then 'quotes'
    when 'create_invoice_for_job' then 'invoices'
    when 'set_checklist_services' then 'checklists'
  end
$$;

select private.fold_member_checks();

notify pgrst, 'reload schema';
