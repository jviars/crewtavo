-- What subs were paid, for the bookkeeper and the auditor (docs/subcontractors-plan.md, phase C:
-- "Yearly totals for the 1099" and "A workers' comp audit report"). Both for the office with the
-- subs area, and both read past row-level security, so each checks who's asking first.
--
--   sub_1099_totals()   each sub's pay marked paid in a calendar year, by the day it was paid in the
--                       company's time zone. Card and payment-app payments are left out of the total
--                       (the processor reports those on a 1099-K) and counted on their own. Payments
--                       through a payroll service count, and are counted on their own too: the
--                       service may file that 1099 itself. With the W-9's classification and the
--                       mailing address, and corporations flagged (they usually don't get a 1099). The reporting threshold, and so who needs one, is
--                       in packages/core/src/jobPay.ts, which changes by year. No tax ID numbers:
--                       they stay on the W-9 file.
--   sub_wc_audit()      for a stretch of dates (usually the workers' comp policy year), each sub's
--                       pay with work in it: the days worked (the completed visits it covers; the day
--                       the work was done when it has none), its share of the pay for the days in
--                       the range (pay with work on both sides of the range is split by days, so no
--                       two reports count the same money), and whether a workers' comp certificate
--                       or exemption the office checked covered each of those days, the current one
--                       or one since replaced: yes, no or partly, with the certificates that did.
--                       A certificate without a start date is taken as a one-year policy up to its
--                       end date (and one without an end date as a year from its start), and says
--                       so, so a missing date can't prove cover on its own. Part-covered pay is
--                       split by days.

/**
 * Each sub paid in p_year (the company's calendar year, by the day each payment was made): the total
 * and number of payments, without card and payment-app ones (counted apart), what of it went through
 * a payroll service, their W-9 classification, contact and mailing address, and whether they're a
 * corporation.
 */
create function public.sub_1099_totals(p_company uuid, p_year integer)
returns table (subcontractor_id uuid, name text, contact_name text, email text, phone text, address jsonb, tax_classification text,
               active boolean, corporation boolean, total numeric, payments integer, card_or_app_total numeric, card_or_app_payments integer,
               payroll_total numeric, payroll_payments integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_tz text;
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'subs')) then
    raise exception 'Your role can''t see what subs were paid' using errcode = '42501';
  end if;
  if p_year is null or p_year < 2000 or p_year > 2200 then
    raise exception 'Choose a year.' using errcode = '22023';
  end if;
  select coalesce(c.timezone, 'UTC') into v_tz from public.companies c where c.id = p_company;
  return query
  select s.id, s.name, s.contact_name, s.email, s.phone, s.address, s.tax_classification, s.active,
    coalesce(s.tax_classification in ('c_corp', 's_corp', 'llc_c_corp', 'llc_s_corp'), false),
    coalesce(sum(p.paid_amount) filter (where p.method <> 'card_or_app'), 0)::numeric,
    (count(*) filter (where p.method <> 'card_or_app'))::integer,
    coalesce(sum(p.paid_amount) filter (where p.method = 'card_or_app'), 0)::numeric,
    (count(*) filter (where p.method = 'card_or_app'))::integer,
    coalesce(sum(p.paid_amount) filter (where p.method = 'payroll'), 0)::numeric,
    (count(*) filter (where p.method = 'payroll'))::integer
  from public.job_pay p
  join public.subcontractors s on s.company_id = p.company_id and s.id = p.subcontractor_id
  where p.company_id = p_company and p.status = 'paid'
    and p.paid_at >= make_timestamptz(p_year, 1, 1, 0, 0, 0, v_tz) and p.paid_at < make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, v_tz)
  group by s.id
  order by s.name, s.id;
end $$;

-- The days a workers' comp document covers, as the audit counts them: from its start to its end
-- date. A certificate missing one is taken as a one-year policy from the date it has (missing both,
-- it covers nothing); an exemption missing one is open on that side.
create function private.wc_doc_term(p_kind text, p_starts date, p_expires date) returns daterange
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_kind = 'wc_exemption' then daterange(p_starts, p_expires, '[]')
    when p_starts is null and p_expires is null then 'empty'::daterange
    else daterange(coalesce(p_starts, (p_expires - interval '1 year')::date + 1), coalesce(p_expires, (p_starts + interval '1 year')::date - 1), '[]')
  end
$$;
revoke all on function private.wc_doc_term(text, date, date) from public;

/**
 * Subs' pay with work from p_from to p_to (the company's dates), for a workers' comp audit: agreed,
 * done or paid pay; the days worked in the range (the completed visits it covers, else the day the
 * work was done); what it came to (what was paid, else its total: pay_amount) and amount, its share
 * for the days in the range (split by days, when some of its work is outside); which of those days a
 * workers' comp certificate or exemption covered (checked by the office, current or since replaced,
 * by private.wc_doc_term); "yes", "no" or "partly"; the amount covered and not, split by days; and
 * the certificates that covered any of them (dates_assumed when a certificate's term was taken as a
 * year for want of a date).
 */
create function public.sub_wc_audit(p_company uuid, p_from date, p_to date)
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
    select p.id, p.subcontractor_id, s.name as sub_name, p.job_id, j.number as job_number, j.title as job_title, p.status,
      case when p.status = 'paid' then p.paid_amount else p.total end as amount,
      coalesce(
        (select array_agg(distinct v.scheduled_on order by v.scheduled_on)
         from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
         where jv.job_pay_id = p.id and v.status = 'completed' and v.scheduled_on is not null),
        case when p.earned_on is not null then array[p.earned_on] else '{}'::date[] end
      ) as days
    from public.job_pay p
    join public.subcontractors s on s.company_id = p.company_id and s.id = p.subcontractor_id
    join public.jobs j on j.company_id = p.company_id and j.id = p.job_id
    where p.company_id = p_company and p.status in ('accepted', 'done', 'paid')
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

revoke execute on function public.sub_1099_totals(uuid, integer), public.sub_wc_audit(uuid, date, date) from public, anon;
grant execute on function public.sub_1099_totals(uuid, integer), public.sub_wc_audit(uuid, date, date) to authenticated, service_role;

notify pgrst, 'reload schema';
