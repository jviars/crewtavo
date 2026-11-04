-- Recurring billing asks Jobber's two questions (the job details dialog, packages/core/src/jobBilling.ts):
--   How is it priced?    jobs.pricing: per_visit, or fixed (the job's lines are the price for each
--                        invoice, however many visits)
--   When do you invoice? jobs.invoice_schedule: after_visit, monthly (on jobs.invoice_day, 1 to 28,
--                        or the last day of the month when it's null, as Jobber does), or as_needed
--                        (no reminders)
-- Both are null on a job invoiced when the job is done, or by progress billing.
--
-- jobs.billing_mode stays, kept in step by align_billing for the SQL that reads it, autopay above
-- all: per_visit still means invoiced after each visit, so autopay's per-visit rules see exactly the
-- jobs they did. Any other recurring choice is fixed_schedule (invoiced on a schedule, not visit by
-- visit). billing_mode written alone (an older screen, the API) answers the questions as jobs had
-- them: per_visit is per visit after each visit, fixed_schedule a fixed price monthly, on_completion
-- and progress neither. Existing jobs are moved across the same way, with no change in what they do.
--
-- Monthly. On the invoice day, from 8 in the morning where the company is, the hourly upkeep
-- (emit_invoice_reminders) makes one invoice_reminders row for each monthly job with something to
-- bill, and tells the office once. While the month isn't invoiced (due_invoices) the job reads
-- Requires invoicing (job_state), Home counts it and batch invoicing offers it; nothing is sent by
-- itself. The month's invoice (create_invoice_for_job with p_month) bills a per-visit job's finished
-- visits from that month not yet invoiced, or a fixed-price job's lines once, and
-- invoices.billing_month holds each job to one invoice a month. As needed never reminds.

-- ---------------------------------------------------------------------------------------------
-- The two questions
-- ---------------------------------------------------------------------------------------------

alter table public.jobs
  add column pricing text constraint jobs_pricing_check check (pricing in ('per_visit', 'fixed')),
  add column invoice_schedule text constraint jobs_invoice_schedule_check check (invoice_schedule in ('after_visit', 'monthly', 'as_needed')),
  add column invoice_day smallint constraint jobs_invoice_day_check check (invoice_day between 1 and 28),
  -- Both answered or neither, and a fixed price isn't invoiced visit by visit (that's per visit).
  add constraint jobs_billing_check check ((pricing is null) = (invoice_schedule is null) and not (pricing = 'fixed' and invoice_schedule = 'after_visit'));
comment on column public.jobs.pricing is 'How a recurring job is priced: per_visit, or fixed (its lines are the price for each invoice). Null: invoiced when the job is done, or by progress.';
comment on column public.jobs.invoice_schedule is 'When a recurring job is invoiced: after_visit, monthly (on invoice_day) or as_needed (no reminders). billing_mode is kept in step (private.align_billing).';
comment on column public.jobs.invoice_day is 'The day of the month a monthly job is invoiced, 1 to 28; null is the last day of the month.';

-- Existing jobs, as they were billed. No trigger: nothing about them changes but the new columns.
alter table public.jobs disable trigger user;
update public.jobs set pricing = 'per_visit', invoice_schedule = 'after_visit' where billing_mode = 'per_visit';
update public.jobs set pricing = 'fixed', invoice_schedule = 'monthly' where billing_mode = 'fixed_schedule';
alter table public.jobs enable trigger user;

-- The answers and billing_mode in step. The answers written win; billing_mode written alone (an
-- older screen, the API) sets them as it always billed. A fixed price kept with its schedule left at
-- after each visit becomes monthly. Named to run before autopay_guard, which reads billing_mode.
create function private.align_billing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' and (new.pricing is not null or new.invoice_schedule is not null))
     or (tg_op = 'UPDATE' and (new.pricing, new.invoice_schedule) is distinct from (old.pricing, old.invoice_schedule)) then
    if new.pricing is null and new.invoice_schedule is null then
      -- Both taken off: invoiced when the job is done, unless progress billing was written with it.
      if new.billing_mode in ('per_visit', 'fixed_schedule') then new.billing_mode := 'on_completion'; end if;
      return new;
    end if;
    new.pricing := coalesce(new.pricing, 'per_visit');
    if new.pricing = 'fixed' and new.invoice_schedule = 'after_visit' and tg_op = 'UPDATE' and old.invoice_schedule = 'after_visit' then
      new.invoice_schedule := 'monthly';
    end if;
    new.invoice_schedule := coalesce(new.invoice_schedule, case when new.pricing = 'fixed' then 'monthly' else 'after_visit' end);
    new.billing_mode := case when new.pricing = 'per_visit' and new.invoice_schedule = 'after_visit' then 'per_visit' else 'fixed_schedule' end;
  elsif tg_op = 'INSERT' or new.billing_mode is distinct from old.billing_mode then
    new.pricing := case new.billing_mode when 'per_visit' then 'per_visit' when 'fixed_schedule' then 'fixed' end;
    new.invoice_schedule := case new.billing_mode when 'per_visit' then 'after_visit' when 'fixed_schedule' then 'monthly' end;
  end if;
  return new;
end $$;
create trigger align_billing before insert or update on public.jobs
  for each row execute function private.align_billing();

-- ---------------------------------------------------------------------------------------------
-- Months
-- ---------------------------------------------------------------------------------------------

-- The days a month's invoice covers (core invoicePeriod): from the day after last month's invoice
-- day to this month's. The invoice day is p_day, or the month's last day when it's null.
create function private.invoice_period(p_day integer, p_month date, out period_start date, out period_end date)
language sql immutable set search_path = '' as $$
  select case when p_day is null then date_trunc('month', p_month::timestamp)::date else (date_trunc('month', p_month::timestamp) - interval '1 month')::date + p_day end,
         case when p_day is null then (date_trunc('month', p_month::timestamp) + interval '1 month')::date - 1 else date_trunc('month', p_month::timestamp)::date + p_day - 1 end
$$;

-- A visit's day (core visitDay): the day it was scheduled for, or the day it was finished in the
-- company's time zone.
create function private.visit_day(p_scheduled date, p_completed timestamptz, p_tz text) returns date
language sql stable set search_path = '' as $$
  select coalesce(p_scheduled, (p_completed at time zone coalesce(p_tz, 'UTC'))::date)
$$;

-- The month a monthly invoice bills (its first day). One a month for a job, unless it's voided.
alter table public.invoices add column billing_month date constraint invoices_billing_month_check check (extract(day from billing_month) = 1);
comment on column public.invoices.billing_month is 'The month (its first day) a recurring job''s monthly invoice bills: create_invoice_for_job with p_month. One a job a month, unless voided.';
create unique index invoices_billing_month_idx on public.invoices (job_id, billing_month) where billing_month is not null and status <> 'void';

-- One for a job and month, made on the invoice day (emit_invoice_reminders). The period is kept as
-- it was then, so changing the day afterwards doesn't move what the month's invoice covers.
create table public.invoice_reminders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  job_id uuid not null,
  month date not null check (extract(day from month) = 1),
  period_start date not null,
  period_end date not null,
  created_at timestamptz not null default now(),
  constraint invoice_reminders_job_fkey foreign key (company_id, job_id) references public.jobs (company_id, id) on delete cascade,
  constraint invoice_reminders_job_month_key unique (job_id, month),
  check (period_start <= period_end)
);
comment on table public.invoice_reminders is 'A monthly job''s month needing its invoice, made once on the invoice day. due_invoices lists the ones not invoiced yet.';
create index invoice_reminders_company_idx on public.invoice_reminders (company_id, month);

-- Read by the office with the invoices area, as invoices are; only the server writes them.
alter table public.invoice_reminders enable row level security;
create policy invoice_reminders_read on public.invoice_reminders for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('invoice_reminders', 'invoices', true);
revoke insert, update, delete, truncate on public.invoice_reminders from authenticated;
revoke all on public.invoice_reminders from anon;

-- The months still to invoice: the job is still active and monthly, the month has no invoice that
-- isn't void, and a per-visit job still has finished visits from it not yet invoiced (invoiced by
-- hand, it's done). Runs as the caller, so it's the office's with the invoices area.
create view public.due_invoices with (security_invoker = true) as
select r.id, r.company_id, r.job_id, r.month, r.period_start, r.period_end, r.created_at
from public.invoice_reminders r
join public.jobs j on j.id = r.job_id
join public.companies c on c.id = r.company_id
where j.kind = 'recurring' and j.status = 'active' and j.invoice_schedule = 'monthly'
  and not exists (select 1 from public.invoices i where i.job_id = r.job_id and i.billing_month = r.month and i.status <> 'void')
  and (j.pricing = 'fixed' or exists (
    select 1 from public.visits v
    where v.job_id = r.job_id and v.kind = 'job' and v.status = 'completed' and v.invoice_id is null
      and private.visit_day(v.scheduled_on, v.completed_at, c.timezone) between r.period_start and r.period_end));
comment on view public.due_invoices is 'Monthly jobs'' months that still need their invoice (invoice_reminders not yet invoiced).';
revoke all on public.due_invoices from anon, authenticated;
grant select on public.due_invoices to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The month's invoice
-- ---------------------------------------------------------------------------------------------

-- As in 20261031000600_promo_once_per_job.sql, plus p_month: a recurring job's invoice for that
-- month, once (billing_month). A per-visit job's ('visits') bills the month's finished visits not
-- yet invoiced; a fixed-price job's ('standard') bills its lines once, with no credit for deposits
-- or progress payments (it isn't the job's last). The period is the reminder's when there is one.
drop function public.create_invoice_for_job(uuid, text, numeric);
create function public.create_invoice_for_job(p_job uuid, p_kind text default 'standard', p_amount numeric default null, p_month date default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  j public.jobs;
  v_invoice uuid;
  v_terms integer;
  v_tax numeric;
  v_today date;
  v_tz text;
  v_deposit numeric;
  v_amount numeric;
  v_contract numeric;
  v_prebilled numeric;
  v_existing bigint;
  v_month date := date_trunc('month', p_month::timestamp)::date;
  v_start date;
  v_end date;
  v_sort integer := 0;
  v_was text := coalesce(current_setting('crewtavo.job_discounts', true), '');
  r record;
begin
  -- One invoice at a time for a job, so the checks below see each other's invoices.
  perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || p_job::text, 0));
  select * into j from public.jobs where id = p_job;
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  if p_kind not in ('standard', 'deposit', 'progress', 'visits', 'retainage') then
    raise exception 'Unknown invoice type' using errcode = '22023';
  end if;
  select contract_total into v_contract from public.job_financials where job_id = j.id;
  select coalesce((settings ->> 'payment_terms_days')::integer, 30), coalesce((settings ->> 'default_tax_rate')::numeric, 0),
         (now() at time zone coalesce(timezone, 'UTC'))::date, coalesce(timezone, 'UTC')
    into v_terms, v_tax, v_today, v_tz
  from public.companies where id = j.company_id;
  -- The rate the client approved on the quote wins over the company default, which a job without
  -- a quote keeps.
  v_tax := coalesce((select q.tax_rate from public.quotes q where q.id = j.quote_id), v_tax, 0);

  if p_month is not null then
    if j.kind <> 'recurring' or p_kind not in ('standard', 'visits') then
      raise exception 'Only a recurring job''s visits or price are invoiced by the month' using errcode = '22023';
    end if;
    select x.period_start, x.period_end into v_start, v_end from public.invoice_reminders x where x.job_id = j.id and x.month = v_month;
    if not found then
      select x.period_start, x.period_end into v_start, v_end from private.invoice_period(j.invoice_day, v_month) x;
    end if;
    select number into v_existing from public.invoices
    where job_id = j.id and billing_month = v_month and status <> 'void' order by number limit 1;
    if found then
      raise exception 'This job already has its % invoice (#%)', to_char(v_month, 'FMMonth YYYY'), v_existing using errcode = '22023';
    end if;
  end if;

  select coalesce(sum(subtotal), 0) into v_prebilled
  from public.invoices where job_id = j.id and kind in ('deposit', 'progress') and status <> 'void';

  if p_kind = 'standard' and j.kind <> 'recurring' then
    select number into v_existing from public.invoices
    where job_id = j.id and kind = 'standard' and status <> 'void' order by number limit 1;
    if found then
      raise exception 'This job already has its final invoice (#%). Void it first to bill the job again', v_existing using errcode = '22023';
    end if;
  end if;

  if p_kind = 'visits' and not exists (
    select 1 from public.visits v where v.job_id = j.id and v.status = 'completed' and v.invoice_id is null and v.kind = 'job'
      and (p_month is null or private.visit_day(v.scheduled_on, v.completed_at, v_tz) between v_start and v_end)
  ) then
    if p_month is not null then
      raise exception 'There are no completed visits from % waiting to be invoiced', to_char(v_month, 'FMMonth') using errcode = '22023';
    end if;
    raise exception 'There are no completed visits waiting to be invoiced' using errcode = '22023';
  end if;

  if p_kind = 'deposit' then
    select deposit_amount into v_deposit from public.quotes where id = j.quote_id;
    v_amount := round(coalesce(p_amount, nullif(v_deposit, 0)), 2);
    if v_amount is null or v_amount <= 0 then
      raise exception 'Enter the deposit amount' using errcode = '22023';
    end if;
  elsif p_kind = 'progress' then
    if p_amount is null or p_amount <= 0 then
      raise exception 'Enter how much to bill' using errcode = '22023';
    end if;
    v_amount := round(p_amount, 2);
  elsif p_kind = 'retainage' then
    select coalesce(sum(retainage_amount), 0) into v_amount
    from public.invoices where job_id = j.id and kind <> 'retainage' and status <> 'void';
    v_amount := v_amount - coalesce((select sum(subtotal) from public.invoices where job_id = j.id and kind = 'retainage' and status <> 'void'), 0);
    if v_amount <= 0 then
      raise exception 'There''s no retainage left to bill on this job' using errcode = '22023';
    end if;
  end if;

  if p_kind in ('deposit', 'progress') and j.kind <> 'recurring' and v_prebilled + v_amount > coalesce(v_contract, 0) + 0.005 then
    raise exception 'That''s more than what''s left to bill on this job (%)',
      to_char(greatest(coalesce(v_contract, 0) - v_prebilled, 0), 'FM$999,999,990.00') using errcode = '22023';
  end if;

  insert into public.invoices (company_id, client_id, job_id, kind, subject, issued_on, due_on, tax_rate, retainage_pct, pay_app_number, billing_month)
  values (
    j.company_id, j.client_id, j.id, p_kind,
    case when p_month is not null then j.title || ' (' || to_char(v_month, 'FMMonth YYYY') || ')'
         else case p_kind when 'deposit' then 'Deposit: ' || j.title when 'visits' then j.title || ' (completed visits)'
                          when 'retainage' then 'Retainage: ' || j.title else j.title end end,
    v_today, v_today + v_terms,
    case when p_kind in ('deposit', 'retainage') then 0 else v_tax end,
    case when p_kind in ('standard', 'progress') then j.retainage_pct else 0 end,
    case when p_kind = 'progress' then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end,
    v_month
  )
  returning id into v_invoice;

  -- All the lines go in first; the promo discounts are placed once they're there.
  perform set_config('crewtavo.job_discounts', 'on', true);

  if p_kind = 'deposit' then
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Deposit for ' || j.title, 1, 'ea', v_amount, false, 0);

  elsif p_kind = 'retainage' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Retainage release: ' || j.title, 'Amount held back on earlier invoices for this job', 1, 'ea', v_amount, false, 0);

  elsif p_kind = 'progress' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Progress billing: ' || j.title,
            case when v_contract > 0 then round(v_amount / v_contract * 100, 1) || '% of the ' || to_char(v_contract, 'FM$999,999,990.00') || ' contract' end,
            1, 'ea', v_amount, true, 0);

  elsif p_kind = 'visits' then
    for r in
      select v.id, coalesce(v.completed_at::date, v.scheduled_on) as day
      from public.visits v
      where v.job_id = j.id and v.status = 'completed' and v.invoice_id is null and v.kind = 'job'
        and (p_month is null or private.visit_day(v.scheduled_on, v.completed_at, v_tz) between v_start and v_end)
      order by coalesce(v.completed_at::date, v.scheduled_on)
    loop
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
      select j.company_id, v_invoice, li.name, 'Visit on ' || to_char(r.day, 'Mon DD, YYYY'), li.quantity, li.unit, li.unit_price, li.taxable, v_sort + li.sort, li.discount_key
      from public.job_line_items li where li.job_id = j.id and li.discount_billing is distinct from 'once';
      update public.visits set invoice_id = v_invoice where id = r.id;
      v_sort := v_sort + 1000000;
    end loop;

  else
    insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
    select company_id, v_invoice, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_key
    from public.job_line_items where job_id = j.id and discount_billing is distinct from 'once';
    -- Credit what was already billed as deposits and progress payments (not on a month's invoice:
    -- it isn't the job's last).
    if p_month is null then
      insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice,
             case i.kind when 'deposit' then 'Less deposit (invoice #' || i.number || ')' else 'Less progress billing (invoice #' || i.number || ')' end,
             -- Progress invoices were taxed, so their credit reduces the taxable amount too.
             1, 'ea', -i.subtotal, i.kind = 'progress', 200000 + row_number() over (order by i.number)
      from public.invoices i
      where i.job_id = j.id and i.kind in ('deposit', 'progress') and i.status <> 'void' and i.id <> v_invoice;
    end if;
  end if;

  if p_kind in ('standard', 'visits') then
    perform private.place_job_discounts(j.id);
    perform private.fit_job_discounts(v_invoice);
  end if;
  perform set_config('crewtavo.job_discounts', v_was, true);

  -- Touch the invoice so totals include the lines just added.
  update public.invoices set updated_at = now() where id = v_invoice;

  if j.status = 'requires_invoicing' and p_kind in ('standard', 'visits') then
    update public.jobs set status = 'completed' where id = j.id;
  end if;
  return v_invoice;
end $$;
revoke execute on function public.create_invoice_for_job(uuid, text, numeric, date) from public, anon;
grant execute on function public.create_invoice_for_job(uuid, text, numeric, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Requires invoicing
-- ---------------------------------------------------------------------------------------------

-- As in 20261103000400_job_states.sql, plus: an active job with a month still to invoice
-- (due_invoices) is requires_invoicing, as Jobber shows it, ahead of its visits. It runs as the
-- caller, so that's for the office with the invoices area; everyone else sees its visits' state.
create or replace function public.job_state(j public.jobs) returns text
language sql stable security invoker set search_path = '' as $$
  select case
    when j.status <> 'active' then j.status
    when exists (select 1 from public.due_invoices d where d.job_id = j.id) then 'requires_invoicing'
    else (
      select case
        when min(v.scheduled_on) is null then 'unscheduled'
        when min(v.scheduled_on) < private.company_today(j.company_id) then 'late'
        when min(v.scheduled_on) = private.company_today(j.company_id) then 'today'
        else 'upcoming' end
      from public.visits v
      where v.job_id = j.id and v.status not in ('completed', 'cancelled') and v.scheduled_on is not null
    ) end
$$;

/**
 * Hourly (tasks.ts): on a monthly job's invoice day, from 8 in the morning where the company is,
 * its reminder for the month, once (one a job a month, so another run makes none), when there's
 * something to bill: a fixed price with lines, or finished visits from the period not yet invoiced.
 * Not before the job starts or after it ends, out of its season, or once the month is invoiced. The
 * office (owners, admins and office staff with the invoices area) hears once about the ones each
 * run makes. Returns how many it made. p_now is the time it goes by (the tests give their own).
 */
create function public.emit_invoice_reminders(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_count integer := 0;
  v_told jsonb := '{}';
begin
  for r in
    with due as (
      select j.company_id, j.id as job_id, p.period_start, p.period_end, date_trunc('month', n.today::timestamp)::date as month
      from public.jobs j
      join public.companies c on c.id = j.company_id
      cross join lateral (select p_now at time zone coalesce(c.timezone, 'UTC') as at) l
      cross join lateral (select l.at::date as today) n
      cross join lateral private.invoice_period(j.invoice_day, n.today) p
      where j.kind = 'recurring' and j.status = 'active' and j.invoice_schedule = 'monthly'
        and p.period_end = n.today and extract(hour from l.at) >= 8   -- in the morning, not at midnight
        and (j.starts_on is null or j.starts_on <= p.period_end)
        and (j.ends_on is null or j.ends_on >= p.period_start)
        and (j.active_months is null or extract(month from p.period_start)::integer = any (j.active_months)
             or extract(month from p.period_end)::integer = any (j.active_months))
        and not exists (select 1 from public.invoices i where i.job_id = j.id and i.billing_month = date_trunc('month', n.today::timestamp)::date and i.status <> 'void')
        and case when j.pricing = 'fixed' then exists (select 1 from public.job_line_items li where li.job_id = j.id)
                 else exists (select 1 from public.visits v
                              where v.job_id = j.id and v.kind = 'job' and v.status = 'completed' and v.invoice_id is null
                                and private.visit_day(v.scheduled_on, v.completed_at, c.timezone) between p.period_start and p.period_end) end
    )
    insert into public.invoice_reminders (company_id, job_id, month, period_start, period_end)
    select company_id, job_id, month, period_start, period_end from due
    on conflict (job_id, month) do nothing
    returning company_id, job_id, month
  loop
    v_count := v_count + 1;
    v_told := jsonb_set(v_told, array[r.company_id::text], jsonb_build_object(
      'n', coalesce((v_told -> r.company_id::text ->> 'n')::integer, 0) + 1, 'job_id', r.job_id, 'month', r.month));
  end loop;

  -- One notification for each company's run: the job when it's one, Invoices when it's more.
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select t.key::uuid, u, 'invoice',
    left(case when (t.value ->> 'n')::integer = 1
           then format('%s needs its %s invoice', (select coalesce(nullif(private.client_name(j.client_id), '') || ': ', '') || j.title from public.jobs j where j.id = (t.value ->> 'job_id')::uuid),
                       to_char((t.value ->> 'month')::date, 'FMMonth'))
           else format('%s monthly jobs need their %s invoice', t.value ->> 'n', to_char((t.value ->> 'month')::date, 'FMMonth')) end, 300),
    'Review and send from Invoices. Nothing goes out by itself.',
    case when (t.value ->> 'n')::integer = 1 then '/jobs/' || (t.value ->> 'job_id') else '/invoices' end
  from jsonb_each(v_told) t
  cross join lateral private.money_office(t.key::uuid) u;
  return v_count;
end $$;

revoke all on function private.align_billing(), private.invoice_period(integer, date), private.visit_day(date, timestamptz, text) from public;
-- due_invoices runs as the caller.
grant execute on function private.visit_day(date, timestamptz, text) to authenticated, service_role;
revoke execute on function public.emit_invoice_reminders(timestamptz) from public, anon, authenticated;
grant execute on function public.emit_invoice_reminders(timestamptz) to service_role;

-- The policies above check the company the per-row way; rewrite them like the others (see
-- 20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
