-- A missed invoice day is caught up. When the server was down all of a monthly job's invoice day,
-- the hourly runs of the next 7 days make that month's reminder (or queue a monthly plan's charge),
-- as the day itself would have. Only when the month has no invoice yet, and only when the job was
-- already monthly before the invoice day began (jobs.monthly_since), so a job switched to monthly
-- afterwards never has a month billed again that its visits were billed for. The reminder is one a
-- job a month, so running twice (or late and on time) makes one.

alter table public.jobs add column monthly_since timestamptz;
comment on column public.jobs.monthly_since is 'When the job was last switched to being invoiced monthly (null while it isn''t). A missed invoice day is caught up only for a job monthly before it.';

-- Jobs already monthly count from now: an invoice day before this is never caught up.
alter table public.jobs disable trigger user;
update public.jobs set monthly_since = now() where invoice_schedule = 'monthly';
alter table public.jobs enable trigger user;

-- Kept by the server: set when the job becomes monthly, cleared when it stops. Named to run after
-- align_billing, which settles invoice_schedule.
create function private.job_monthly_since() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.monthly_since := case
    when new.invoice_schedule is distinct from 'monthly' then null
    when tg_op = 'INSERT' or old.invoice_schedule is distinct from 'monthly' then now()
    else old.monthly_since end;
  return new;
end $$;
create trigger monthly_since before insert or update on public.jobs
  for each row execute function private.job_monthly_since();
revoke all on function private.job_monthly_since() from public;

-- As in 20261104000900_monthly_plan_autopay.sql, plus: an invoice day up to 7 days ago that has no
-- reminder yet gets it now (any hour), when the job was monthly before that day began.
create or replace function public.emit_invoice_reminders(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_count integer := 0;
  v_told jsonb := '{}';
begin
  for r in
    with due as (
      select j.company_id, j.id as job_id, p.period_start, p.period_end, date_trunc('month', p.period_end::timestamp)::date as month
      from public.jobs j
      join public.companies c on c.id = j.company_id
      cross join lateral (select p_now at time zone coalesce(c.timezone, 'UTC') as at) l
      cross join lateral (select l.at::date as today) n
      -- This month's invoice day, or last month's while it's within the week.
      cross join lateral (values (n.today), ((n.today - interval '1 month')::date)) m (day)
      cross join lateral private.invoice_period(j.invoice_day, m.day) p
      where j.kind = 'recurring' and j.status = 'active' and j.invoice_schedule = 'monthly'
        and p.period_end between n.today - 7 and n.today
        and (p.period_end < n.today or extract(hour from l.at) >= 8)   -- in the morning, not at midnight
        -- A day gone by: only for a job that was monthly before it began.
        and (p.period_end = n.today or j.monthly_since < p.period_end::timestamp at time zone coalesce(c.timezone, 'UTC'))
        and (j.starts_on is null or j.starts_on <= p.period_end)
        and (j.ends_on is null or j.ends_on >= p.period_start)
        and (j.active_months is null or extract(month from p.period_start)::integer = any (j.active_months)
             or extract(month from p.period_end)::integer = any (j.active_months))
        and not exists (select 1 from public.invoices i where i.job_id = j.id and i.billing_month = date_trunc('month', p.period_end::timestamp)::date and i.status <> 'void')
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
    continue when private.autopay_queue_month(r.job_id, r.month);
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

notify pgrst, 'reload schema';
