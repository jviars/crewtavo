-- The workers' comp audit no longer lets an exemption with no start date cover all earlier work.
--
-- private.wc_doc_term (20261025003002_sub_pay_reports.sql) took a workers' comp exemption with no start
-- date as covering every day before its end date, so the audit report could count work done before
-- the exemption existed as covered, understating what the auditor charges for, and without saying the
-- dates were assumed. Start dates are optional on the paperwork forms.
--
-- An exemption is now bounded the way a certificate is: with no start date, a year up to its end
-- date; with no end date either, from the day it was added to Crewtavo. (One with a start date and no
-- end date still runs on, as an exemption can.) The report's dates_assumed now says so for an
-- exemption missing either date, as it does for a certificate.

-- The days a workers' comp document covers, as the audit counts them. A certificate missing a date is
-- taken as a one-year policy from the date it has (missing both, it covers nothing). An exemption
-- missing its start is taken as a year up to its end, or with neither date, as starting the day it
-- was added (p_added); missing only its end, it runs on.
create function private.wc_doc_term(p_kind text, p_starts date, p_expires date, p_added date) returns daterange
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_kind = 'wc_exemption' then
      daterange(coalesce(p_starts, (p_expires - interval '1 year')::date + 1, p_added), p_expires, '[]')
    when p_starts is null and p_expires is null then 'empty'::daterange
    else daterange(coalesce(p_starts, (p_expires - interval '1 year')::date + 1), coalesce(p_expires, (p_starts + interval '1 year')::date - 1), '[]')
  end
$$;
revoke all on function private.wc_doc_term(text, date, date, date) from public;

/**
 * As in 20261025004002_sub_pay_seams.sql, with exemptions' terms bounded as certificates' are
 * (private.wc_doc_term with the day each was added), and dates_assumed for an exemption missing a date.
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

-- The old three-argument form isn't used any more.
drop function private.wc_doc_term(text, date, date);
