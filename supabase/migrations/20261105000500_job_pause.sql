-- Pausing a recurring job, for seasonal clients and vacations. jobs.paused_at says it's paused (and
-- since when), jobs.resume_on the day it starts again by itself (null: until someone resumes it).
-- The status stays active, so everything that reads "status = 'active'" means what it always did;
-- the pause is beside it, and job_state reads it as paused.
--
-- While paused (tasks.ts materializeJob): no new visits are made, and the upcoming ones that haven't
-- started come off, as a schedule change takes off the dates it no longer has (not ones job pay
-- whose work is done covers, or with work logged on them). The nightly run resumes it on its resume
-- date, and resuming (by hand or then) makes its visits again from that day.
--
-- Billing. Per visit, the visits done are billed as ever: a paused stretch has none, so a month paused
-- all through has no reminder, and one paused partway bills the visits it had. A fixed price (and a
-- monthly plan's charge) is billed in full for a month the job was active any of, and not at all for
-- one it was paused all of: paused before the month began and not back by its invoice day. A missed
-- invoice day isn't caught up once the job has resumed since it (it was paused that day).

alter table public.jobs
  add column paused_at timestamptz,
  add column resume_on date,
  add column resumed_at timestamptz;
comment on column public.jobs.paused_at is 'When a recurring job was paused (null while it isn''t): no visits, and no fixed-price month billed that it''s paused all of. Set by the server.';
comment on column public.jobs.resume_on is 'The day a paused job starts again by itself (the nightly run); null until someone resumes it.';
comment on column public.jobs.resumed_at is 'When the job was last resumed. A missed invoice day from before isn''t caught up. Set by the server.';

-- Only a recurring job pauses, and resume_on goes with the pause. When it was paused and resumed are
-- the server's times, since billing goes by them.
create function private.job_pause() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind <> 'recurring' then new.paused_at := null; end if;
  if new.paused_at is null then
    new.resume_on := null;
  elsif tg_op = 'INSERT' or old.paused_at is null then
    new.paused_at := now();
  else
    new.paused_at := old.paused_at;
  end if;
  new.resumed_at := case
    when tg_op = 'INSERT' then null
    when old.paused_at is not null and new.paused_at is null then now()
    else old.resumed_at end;
  return new;
end $$;
create trigger job_pause before insert or update on public.jobs
  for each row execute function private.job_pause();
revoke all on function private.job_pause() from public;

-- As in 20261104000800_recurring_billing.sql, plus paused: an active job that's paused reads paused,
-- after requires_invoicing (a month it was billed for still waits for its invoice).
create or replace function public.job_state(j public.jobs) returns text
language sql stable security invoker set search_path = '' as $$
  select case
    when j.status <> 'active' then j.status
    when exists (select 1 from public.due_invoices d where d.job_id = j.id) then 'requires_invoicing'
    when j.paused_at is not null then 'paused'
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

-- As in 20261105000110_invoice_day_catch_up.sql, plus: a fixed price isn't billed (no reminder, no
-- monthly plan charge) for a month it was paused all of, or caught up once it has resumed since.
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
        -- Paused all month: paused before it began and not back by the invoice day. A day gone by
        -- after a resume: it was paused that day.
        and not coalesce(j.pricing = 'fixed' and (
              (j.paused_at < p.period_start::timestamp at time zone coalesce(c.timezone, 'UTC') and (j.resume_on is null or j.resume_on > p.period_end))
           or (p.period_end < n.today and j.resumed_at >= p.period_end::timestamp at time zone coalesce(c.timezone, 'UTC'))), false)
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
