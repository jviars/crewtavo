-- What job pay (20261025003001_job_pay.sql) left for offers (docs/subcontractors-plan.md, phase D):
--
--   - A sign-in given to a sub after their pay was agreed (or given back, or made while the sub was
--     turned off and the sub turned back on) goes on the visits that pay covers that aren't finished
--     yet, as if it had been there when the pay was agreed: noted on job_pay_visits.assigned, so
--     cancelling the pay takes it off again. Only that sign-in: someone the office took off a visit
--     isn't put back. A new price waiting for an answer counts as agreed: the sub stays on its visits
--     meanwhile, and when it ends, nobody is put on again (job_pay_status_change).
--   - The sub's sign-ins hear when their pay is owed (the work's done: "Owed: $2,040 for Smith roof")
--     and when it's paid ("Paid $2,040 on Nov 3"), under their "jobs" topic, opening My jobs.
--   - Job costs and the workers' comp audit count pay with a new price waiting for an answer at the
--     price agreed, as they did before it was changed.

-- ---------------------------------------------------------------------------------------------
-- A sign-in given later
-- ---------------------------------------------------------------------------------------------

-- The sign-in given (or given back) goes on the open visits the sub's agreed pay covers, and a sub
-- turned back on gets the sign-ins made while they were off (those the pay hasn't put there before).
-- Nobody else is put back: someone the office took off a visit stays off it.
create function private.sub_sign_in_joins() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_company uuid := new.company_id; v_sub uuid; v_user uuid; x record; v_added uuid[];
begin
  if tg_table_name = 'memberships' then
    -- A sign-in already on, for the same sub: nothing new.
    if tg_op = 'UPDATE' and old.active and old.subcontractor_id is not distinct from new.subcontractor_id then return null; end if;
    v_sub := new.subcontractor_id;
    v_user := new.user_id;
    -- A sub that's turned off gets it when they're turned back on.
    if not exists (select 1 from public.subcontractors s where s.company_id = v_company and s.id = v_sub and s.active) then return null; end if;
  else
    v_sub := new.id;
  end if;
  for x in
    select jv.job_pay_id, jv.visit_id, jv.assigned
    from public.job_pay p
    join public.job_pay_visits jv on jv.job_pay_id = p.id
    join public.visits v on v.id = jv.visit_id
    where p.company_id = v_company and p.subcontractor_id = v_sub
      and (p.status = 'accepted' or (p.status = 'offered' and p.accepted_snapshot is not null))
      and v.status not in ('completed', 'cancelled')
    order by v.scheduled_on, v.id
  loop
    with added as (
      insert into public.visit_assignees (company_id, visit_id, user_id)
      select v_company, x.visit_id, m.user_id
      from public.memberships m
      where m.company_id = v_company and m.subcontractor_id = v_sub and m.active
        and case when v_user is not null then m.user_id = v_user else m.user_id <> all (x.assigned) end
      on conflict do nothing
      returning user_id
    )
    select coalesce(array_agg(user_id), '{}') into v_added from added;
    if cardinality(v_added) > 0 then
      update public.job_pay_visits set assigned = array(select distinct u from unnest(assigned || v_added) u)
      where job_pay_id = x.job_pay_id and visit_id = x.visit_id;
    end if;
  end loop;
  return null;
end $$;
create trigger sub_pay_visits after insert or update of active, subcontractor_id on public.memberships
  for each row when (new.role = 'subcontractor' and new.active) execute function private.sub_sign_in_joins();
create trigger sub_pay_visits after update of active on public.subcontractors
  for each row when (not old.active and new.active) execute function private.sub_sign_in_joins();

-- ---------------------------------------------------------------------------------------------
-- When a new price ends
-- ---------------------------------------------------------------------------------------------

/**
 * As in 20261025003001_job_pay.sql: agreed, the sub goes on its visits; cancelled, off them again;
 * agreed after the work, done straight away. A new price that ends (taken, turned down, run out or
 * taken back) leaves them where they are: they stayed on the visits while it waited, and a sign-in
 * given meanwhile was put on (above). Only pay agreed the first time, from a draft or a first offer,
 * puts the sub's sign-ins on.
 */
create or replace function private.job_pay_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x record;
begin
  if new.subcontractor_id is not null then
    if new.status = 'accepted' and (old.status = 'draft' or (old.status = 'offered' and old.accepted_snapshot is null)) then
      perform private.job_pay_assign(new.id, null);
    elsif new.status = 'cancelled' then
      for x in select jv.visit_id, jv.assigned from public.job_pay_visits jv where jv.job_pay_id = new.id and cardinality(jv.assigned) > 0 loop
        perform private.job_pay_unassign(x.visit_id, x.assigned);
      end loop;
      update public.job_pay_visits set assigned = '{}' where job_pay_id = new.id and cardinality(assigned) > 0;
    end if;
  end if;
  if new.status = 'accepted' then
    perform private.job_pay_sync_done(new.id);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Owed and paid
-- ---------------------------------------------------------------------------------------------

-- A sub's pay done (the work is) or paid: their sign-ins hear, once for the same words.
create function private.job_pay_sub_notices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_job text := (select j.title from public.jobs j where j.id = new.job_id);
  v_tz text := (select c.timezone from public.companies c where c.id = new.company_id);
begin
  if new.status = 'done' and old.status = 'accepted' then
    perform private.tell_sub(new.company_id, new.subcontractor_id, format('Owed: %s for %s', private.money_short(new.total), v_job),
      'The work''s done. We''ll let you know when it''s paid.', '/field/jobs/' || new.id, true);
  elsif new.status = 'paid' then
    perform private.tell_sub(new.company_id, new.subcontractor_id,
      format('Paid %s on %s', private.money_short(new.paid_amount), to_char(new.paid_at at time zone coalesce(v_tz, 'UTC'), 'Mon FMDD')),
      v_job || case new.method
        when 'check' then ', by check.' when 'ach' then ', by bank transfer.' when 'cash' then ', in cash.'
        when 'card_or_app' then ', by card or payment app.' when 'payroll' then ', through payroll.' else '.' end,
      '/field/jobs/' || new.id, true);
  end if;
  return null;
end $$;
create trigger sub_notices after update of status on public.job_pay
  for each row when (new.subcontractor_id is not null and old.status is distinct from new.status and new.status in ('done', 'paid'))
  execute function private.job_pay_sub_notices();

-- ---------------------------------------------------------------------------------------------
-- A new price waiting for an answer still costs what was agreed
-- ---------------------------------------------------------------------------------------------

/** As in 20261025003004_job_labor_costs.sql; pay with a new price waiting for an answer counts at the agreed one. */
create or replace function public.job_pay_costs(p_jobs uuid[])
returns table (job_id uuid, amount numeric, payees integer)
language sql stable security definer set search_path = '' as $$
  select p.job_id,
    sum(case when p.status = 'paid' then p.paid_amount when p.status = 'offered' then (p.accepted_snapshot ->> 'total')::numeric else p.total end),
    count(*)::integer
  from public.job_pay p
  where p.job_id = any (p_jobs) and (p.status in ('accepted', 'done', 'paid') or (p.status = 'offered' and p.accepted_snapshot is not null))
    and p.company_id = any (private.role_companies('{owner,admin,office}')) and p.company_id = any (private.perm_companies('job_costs'))
  group by p.job_id
$$;

/**
 * As in 20261025003002_sub_pay_reports.sql; pay with a new price waiting for an answer is agreed work,
 * at the agreed price.
 */
create or replace function public.sub_wc_audit(p_company uuid, p_from date, p_to date)
returns table (job_pay_id uuid, subcontractor_id uuid, sub_name text, job_id uuid, job_number bigint, job_title text, status text,
               amount numeric, pay_amount numeric, work_dates date[], covered_dates date[], coverage text, covered_amount numeric,
               uncovered_amount numeric, documents jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'subs')) then
    raise exception 'Your role can''t see what subs were paid' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose the dates the report covers, the end on or after the start.' using errcode = '22023';
  end if;
  if p_to - p_from > 800 then
    raise exception 'Choose two years at most.' using errcode = '22023';
  end if;
  return query
  with pay as (
    select p.id, p.subcontractor_id, s.name as sub_name, p.job_id, j.number as job_number, j.title as job_title,
      case when p.status = 'offered' then 'accepted' else p.status end as status,
      case when p.status = 'paid' then p.paid_amount when p.status = 'offered' then (p.accepted_snapshot ->> 'total')::numeric else p.total end as amount,
      coalesce(
        (select array_agg(distinct v.scheduled_on order by v.scheduled_on)
         from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
         where jv.job_pay_id = p.id and v.status = 'completed' and v.scheduled_on is not null),
        case when p.earned_on is not null then array[p.earned_on] else '{}'::date[] end
      ) as days
    from public.job_pay p
    join public.subcontractors s on s.company_id = p.company_id and s.id = p.subcontractor_id
    join public.jobs j on j.company_id = p.company_id and j.id = p.job_id
    where p.company_id = p_company and (p.status in ('accepted', 'done', 'paid') or (p.status = 'offered' and p.accepted_snapshot is not null))
  ),
  worked as (
    select pay.*, array(select d from unnest(pay.days) d where d between p_from and p_to order by d) as dates
    from pay
  ),
  covered as (
    select w.*,
      array(
        select d from unnest(w.dates) d
        where exists (
          select 1 from public.sub_documents doc
          where doc.subcontractor_id = w.subcontractor_id and doc.kind in ('workers_comp', 'wc_exemption') and doc.verified_at is not null
            and private.wc_doc_term(doc.kind, doc.starts_on, doc.expires_on) @> d
        )
        order by d
      ) as covered,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', doc.id, 'kind', doc.kind, 'title', doc.title, 'carrier', doc.carrier, 'policy_number', doc.policy_number,
          'starts_on', doc.starts_on, 'expires_on', doc.expires_on, 'replaced', doc.superseded_at is not null,
          'dates_assumed', doc.kind = 'workers_comp' and (doc.starts_on is null or doc.expires_on is null))
          order by doc.expires_on nulls last, doc.created_at), '[]'::jsonb)
       from public.sub_documents doc
       where doc.subcontractor_id = w.subcontractor_id and doc.kind in ('workers_comp', 'wc_exemption') and doc.verified_at is not null
         and exists (select 1 from unnest(w.dates) d where private.wc_doc_term(doc.kind, doc.starts_on, doc.expires_on) @> d)
      ) as docs,
      round(w.amount * cardinality(w.dates) / cardinality(w.days), 2) as in_amount
    from worked w
    where cardinality(w.dates) > 0
  )
  select c.id, c.subcontractor_id, c.sub_name, c.job_id, c.job_number, c.job_title, c.status, c.in_amount, c.amount, c.dates, c.covered,
    case when cardinality(c.covered) = cardinality(c.dates) then 'yes' when cardinality(c.covered) = 0 then 'no' else 'partly' end,
    round(c.in_amount * cardinality(c.covered) / cardinality(c.dates), 2),
    c.in_amount - round(c.in_amount * cardinality(c.covered) / cardinality(c.dates), 2),
    c.docs
  from covered c
  order by c.sub_name, c.subcontractor_id, c.dates[1], c.job_number, c.id;
end $$;

notify pgrst, 'reload schema';
