-- Money figures added up here instead of in the browser. Home's collected bars, the Invoices
-- tiles, Deposits' Stripe fees and the jobs ready to invoice each read rows into the browser and
-- worked from those, but the API hands over 1,000 rows a request at most, whichever rows it likes
-- unless told an order. Past that many payments or finished visits, a business saw figures from
-- part of its rows, with nothing to say so.
--
-- Each of these runs as the person asking, so it works from only the rows they could read
-- themselves: someone without the invoices area, the crew, a sub or another business gets zeros
-- or nothing, as they do from the tables.
--
--   collected_by_day()             What came in on each day of the company's own calendar (Home's
--                                  weekly bars, and this month against the same days of last).
--   invoice_summary()              Owed and past due now and 30 days ago, and what came in over
--                                  the past 30 days and the 30 before (the Invoices tiles).
--   stripe_fees()                  What Stripe kept on payments received since a time (Deposits).
--   jobs_with_visits_to_invoice()  Jobs invoiced after each visit, with finished visits not on an
--                                  invoice yet (Invoices, ready to invoice).

-- Payments are asked for by when they came in, here and for Home's month (dashboard): a company's
-- recent ones are found from this rather than by reading every payment it ever took.
create index payments_company_received_idx on public.payments (company_id, received_at);

-- One row for each day with payments, the day being the company's own (core localDate): a payment
-- at 11pm in Los Angeles is that day's, though it's already tomorrow in UTC. Refunds take away.
create function public.collected_by_day(p_company uuid, p_from date, p_to date)
returns table (day date, collected numeric, payments bigint)
language plpgsql stable security invoker set search_path = '' as $$
begin
  -- A row a day, and the API hands over 1,000 rows at most: a longer span would lose days quietly.
  if p_to - p_from >= 1000 then
    raise exception 'Ask for fewer than 1,000 days at a time' using errcode = '22023';
  end if;
  return query
    with co as (
      select coalesce(c.timezone, 'UTC') as tz from public.companies c where c.id = p_company
    )
    select d.on_day, sum(p.amount), count(*)
    from public.payments p
    cross join co
    cross join lateral (select (p.received_at at time zone co.tz)::date as on_day) d
    where p.company_id = p_company
      -- A day's slack either side, so the index narrows them down; the day itself decides.
      and p.received_at >= (p_from - 1)::timestamp at time zone co.tz
      and p.received_at < (p_to + 2)::timestamp at time zone co.tz
      and d.on_day between p_from and p_to
    group by d.on_day
    order by d.on_day;
end $$;
revoke execute on function public.collected_by_day(uuid, date, date) from public, anon;
grant execute on function public.collected_by_day(uuid, date, date) to authenticated;

-- The Invoices tiles, as the screen worked them out (apps/web/src/lib/trends.ts receivablesTrend).
-- p_today is the company's date. Balances 30 days ago are walked back from today's: an invoice
-- owed its balance now plus whatever was paid on it since, and nothing before it was issued.
-- Credits and voids aren't replayed, so those are close rather than exact.
create function public.invoice_summary(p_company uuid, p_today date)
returns table (owed numeric, owed_count bigint, past_due numeric, past_due_count bigint, collected numeric, payments bigint,
               owed_before numeric, past_due_before numeric, collected_before numeric)
language sql stable security invoker set search_path = '' as $$
  with co as (
    select coalesce(timezone, 'UTC') as tz from public.companies where id = p_company
  ),
  -- Everything received in the past 60 days, and a day more for time zones as the screen asked
  -- for it, each on its day in the company's zone.
  paid as (
    select p.invoice_id, p.amount, (p.received_at at time zone co.tz)::date as day
    from public.payments p cross join co
    where p.company_id = p_company and p.received_at >= (p_today - 61)::timestamp at time zone 'UTC'
  ),
  -- Open invoices, and ones paid on since then: those aren't open any more but were owed 30 days ago.
  inv as (
    select i.status, i.balance_due, i.issued_on, i.due_on,
           coalesce((select sum(x.amount) from paid x where x.invoice_id = i.id and x.day > p_today - 30), 0) as paid_since
    from public.invoices i
    where i.company_id = p_company
      and (i.status in ('sent', 'partially_paid', 'overdue')
           or (i.status not in ('draft', 'void') and exists (select 1 from paid x where x.invoice_id = i.id)))
  ),
  was as (
    select greatest(0, i.balance_due + i.paid_since) as balance, i.due_on from inv i where i.issued_on <= p_today - 30
  )
  select
    coalesce((select sum(i.balance_due) from inv i where i.status in ('sent', 'partially_paid', 'overdue')), 0),
    (select count(*) from inv i where i.status in ('sent', 'partially_paid', 'overdue')),
    coalesce((select sum(i.balance_due) from inv i where i.status = 'overdue'), 0),
    (select count(*) from inv i where i.status = 'overdue'),
    coalesce((select sum(x.amount) from paid x where x.day > p_today - 30 and x.day <= p_today), 0),
    -- Payments, not refunds.
    (select count(*) from paid x where x.amount > 0 and x.day > p_today - 30),
    coalesce((select sum(w.balance) from was w), 0),
    coalesce((select sum(w.balance) from was w where w.due_on < p_today - 30), 0),
    coalesce((select sum(x.amount) from paid x where x.day > p_today - 60 and x.day <= p_today - 30), 0)
$$;
revoke execute on function public.invoice_summary(uuid, date) from public, anon;
grant execute on function public.invoice_summary(uuid, date) to authenticated;

-- What Stripe kept on the payments received since p_since.
create function public.stripe_fees(p_company uuid, p_since timestamptz) returns numeric
language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(fee_amount), 0) from public.payments
  where company_id = p_company and processor = 'stripe' and received_at >= p_since
$$;
revoke execute on function public.stripe_fees(uuid, timestamptz) from public, anon;
grant execute on function public.stripe_fees(uuid, timestamptz) to authenticated;

-- Active jobs invoiced after each visit that have a finished visit not on an invoice yet. The
-- screen read every finished visit without an invoice to find these, and a monthly plan's visits
-- never get one, so a few years of those crowded the per-visit jobs out of its 1,000 rows.
create function public.jobs_with_visits_to_invoice(p_company uuid) returns setof public.jobs
language sql stable security invoker set search_path = '' as $$
  select j.* from public.jobs j
  where j.company_id = p_company and j.status = 'active' and j.billing_mode = 'per_visit'
    and exists (select 1 from public.visits v
                where v.job_id = j.id and v.company_id = p_company and v.status = 'completed' and v.kind = 'job' and v.invoice_id is null)
$$;
revoke execute on function public.jobs_with_visits_to_invoice(uuid) from public, anon;
grant execute on function public.jobs_with_visits_to_invoice(uuid) to authenticated;

notify pgrst, 'reload schema';
