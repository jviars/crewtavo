-- What a sub has been paid this year now also says how much of it counts toward their 1099.
--
-- My jobs shows a sub what they've been paid this year (my_sub_pay_totals, 20261025004001_sub_offers.sql),
-- counting every payment, with "Ask the office for your 1099" under it. The office's 1099 totals
-- (sub_1099_totals, 20261025003002_sub_pay_reports.sql) leave out card and payment-app payments,
-- which the processor reports on a 1099-K, so the two could differ with no word why. The sub's totals
-- now also give `counted`: this year's pay without card and payment-app payments, as the 1099 counts
-- it, and the field app says so when the two differ (apps/web/src/features/field/myJobs.ts).

drop function public.my_sub_pay_totals(uuid);

/**
 * As in 20261025004001_sub_offers.sql: what a sub has been paid this year at p_company (by the day it
 * was paid, the company's) and what they're owed now, through their active sign-in there; and of what
 * they were paid, how much counts toward a 1099 (counted: not card or payment-app payments). Nothing
 * for anyone who isn't one of its subs.
 */
create function public.my_sub_pay_totals(p_company uuid)
returns table (year integer, paid numeric, payments integer, owed numeric, owed_jobs integer, counted numeric)
language sql stable security definer set search_path = '' as $$
  with co as (
    select coalesce(c.timezone, 'UTC') as tz from public.companies c
    where c.id = p_company and exists (select 1 from private.my_subs() s where s.company_id = p_company)
  ),
  mine as (
    select p.status, p.total, p.paid_at, p.paid_amount, p.method from public.job_pay p
    join private.my_subs() s on s.company_id = p.company_id and s.subcontractor_id = p.subcontractor_id
    where p.company_id = p_company and p.status in ('done', 'paid')
  )
  select extract(year from now() at time zone co.tz)::integer,
    coalesce(sum(m.paid_amount) filter (where m.status = 'paid' and m.paid_at >= date_trunc('year', now() at time zone co.tz) at time zone co.tz), 0),
    (count(*) filter (where m.status = 'paid' and m.paid_at >= date_trunc('year', now() at time zone co.tz) at time zone co.tz))::integer,
    coalesce(sum(m.total) filter (where m.status = 'done'), 0),
    (count(*) filter (where m.status = 'done'))::integer,
    coalesce(sum(m.paid_amount) filter (where m.status = 'paid' and m.method is distinct from 'card_or_app'
      and m.paid_at >= date_trunc('year', now() at time zone co.tz) at time zone co.tz), 0)
  from co left join mine m on true
  group by co.tz
$$;
revoke execute on function public.my_sub_pay_totals(uuid) from public, anon;
grant execute on function public.my_sub_pay_totals(uuid) to authenticated;

notify pgrst, 'reload schema';
