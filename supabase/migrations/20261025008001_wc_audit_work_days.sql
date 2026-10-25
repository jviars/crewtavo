-- The workers' comp audit counts a visit on the day the work was done, not only the day it was
-- scheduled for.
--
-- public.sub_wc_audit (last in 20261025007007_wc_exemption_dates.sql) took a completed visit's work day
-- from visits.scheduled_on. A visit finished before its scheduled day then counted on a later day: a
-- job finished today but booked for tomorrow was missing from a report ending today (the default "last
-- 12 months"), and work at the edge of a policy year could land in the wrong year.
--
-- A completed visit now counts on the earlier of the day it was scheduled for and the day it was
-- completed, in company time. Work finished early counts on the day it was done; a sub who taps
-- Complete the next morning still counts on the day they worked. A timed visit with no scheduled_on
-- (only starts_at) was left out before; its scheduled day is now its start in company time.

/**
 * As in 20261025007007_wc_exemption_dates.sql, with each completed visit's work day the earlier of its
 * scheduled day (scheduled_on, or starts_at's day) and its completion day, in company time.
 */
create or replace function public.sub_wc_audit(p_company uuid, p_from date, p_to date)
returns table (job_pay_id uuid, subcontractor_id uuid, sub_name text, job_id uuid, job_number bigint, job_title text, status text,
               amount numeric, pay_amount numeric, work_dates date[], covered_dates date[], coverage text, covered_amount numeric,
               uncovered_amount numeric, documents jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_tz text := coalesce((select c.timezone from public.companies c where c.id = p_company), 'UTC');
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
        (select array_agg(w.day order by w.day)
         from (select distinct least(coalesce(v.scheduled_on, (v.starts_at at time zone v_tz)::date), (v.completed_at at time zone v_tz)::date) as day
               from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
               where jv.job_pay_id = p.id and v.status = 'completed') w),
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
            and private.wc_doc_term(doc.kind, doc.starts_on, doc.expires_on, (doc.created_at at time zone v_tz)::date) @> d
        )
        order by d
      ) as covered,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', doc.id, 'kind', doc.kind, 'title', doc.title, 'carrier', doc.carrier, 'policy_number', doc.policy_number,
          'starts_on', doc.starts_on, 'expires_on', doc.expires_on, 'replaced', doc.superseded_at is not null,
          'dates_assumed', doc.starts_on is null or doc.expires_on is null)
          order by doc.expires_on nulls last, doc.created_at), '[]'::jsonb)
       from public.sub_documents doc
       where doc.subcontractor_id = w.subcontractor_id and doc.kind in ('workers_comp', 'wc_exemption') and doc.verified_at is not null
         and exists (select 1 from unnest(w.dates) d where private.wc_doc_term(doc.kind, doc.starts_on, doc.expires_on, (doc.created_at at time zone v_tz)::date) @> d)
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
