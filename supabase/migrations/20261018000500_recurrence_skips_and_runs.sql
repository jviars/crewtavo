-- Recurring visits someone deleted stay deleted, an automation run is done by one worker, and
-- accounting changes made while the app needs reconnecting wait for it.
--
-- The recurrence task (and saving a recurring job) adds any visit missing from the next 60 days,
-- matched on the job and the date it's for (visits.recurrence_key). Deleting a generated visit left
-- no trace, so the next run put it back on the default crew. Now a person deleting one leaves its
-- date here, and the API skips remembered dates. The API's own clean-up of dates a schedule no
-- longer has runs with the service key (no auth.uid()), so it isn't remembered.

create table public.recurrence_skips (
  company_id uuid not null,
  job_id uuid not null,
  recurrence_key text not null, -- the deleted visit's recurrence_key: the local date it was for
  deleted_by uuid references auth.users (id) on delete set null default auth.uid(),
  deleted_at timestamptz not null default now(),
  primary key (job_id, recurrence_key),
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete cascade
);
alter table public.recurrence_skips enable row level security;
create policy recurrence_skips_read on public.recurrence_skips for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}'));
-- Rows come only from deleting visits (below); the API reads them with the service key.
revoke insert, update, delete on public.recurrence_skips from authenticated;
revoke all on public.recurrence_skips from anon;

create function private.remember_deleted_occurrence() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Not the API's own clean-up, and not when the job itself is being deleted (its visits go with it).
  if old.recurrence_key is not null and (select auth.uid()) is not null
     and exists (select 1 from public.jobs where id = old.job_id) then
    insert into public.recurrence_skips (company_id, job_id, recurrence_key)
    values (old.company_id, old.job_id, old.recurrence_key)
    on conflict do nothing;
  end if;
  return null;
end $$;
create trigger remember_deleted_occurrence after delete on public.visits
  for each row execute function private.remember_deleted_occurrence();

-- The engine claims up to 50 automation runs for five minutes and does them one after another, so
-- a slow batch can outlast its claim and another worker can claim the rest and do them too. Right
-- before each run the engine confirms it still holds the claim (the run is still 'running' with the
-- locked_until it was claimed with) and extends it. False means someone else has it now.
--
-- That's also when the attempt counts. Claiming used to count it, so a run whose claim ran out
-- while it waited its turn in a slow batch used an attempt without being tried, and on its third
-- claim could be stopped "after 3 attempts" without ever being done.
create function public.extend_automation_run(p_id bigint, p_locked_until timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_runs
     set locked_until = now() + interval '5 minutes', attempts = attempts + 1
   where id = p_id and status = 'running' and locked_until = p_locked_until;
  return found;
end $$;
revoke execute on function public.extend_automation_run(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.extend_automation_run(bigint, timestamptz) to service_role;

-- As in 20261017000200_automations.sql, except claiming no longer counts an attempt
-- (extend_automation_run does).
create or replace function public.claim_automation_runs(p_limit integer default 25, p_company uuid default null)
returns setof public.automation_runs language plpgsql security definer set search_path = '' as $$
begin
  -- Runs that crashed three times stop retrying.
  update public.automation_runs
     set status = 'failed', finished_at = now(), locked_until = null, error = coalesce(error, 'Stopped after 3 attempts')
   where status = 'running' and locked_until < now() and attempts >= 3;

  return query
  update public.automation_runs r
     set status = 'running', locked_until = now() + interval '5 minutes'
   where r.id in (
     select x.id from public.automation_runs x
      where ((x.status = 'pending' and x.run_after <= now()) or (x.status = 'running' and x.locked_until < now()))
        and (p_company is null or x.company_id = p_company)
      order by x.run_after
      limit least(greatest(p_limit, 1), 100)
      for update skip locked)
  returning r.*;
end $$;

-- An accounting app whose sign-in the provider refused (status 'error') is waiting for someone to
-- reconnect it. Invoices and payments from that time weren't queued at all, so they never reached
-- the books, even after reconnecting; and changes already queued failed until they gave up. Now
-- they're queued as usual and wait while the app does, then go once it's reconnected. A person
-- disconnecting the app still stops syncing.
create or replace function private.enqueue_accounting() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Quiet (crewtavo.quiet = on, see 20261018000300_stripe.sql) as before; otherwise queued while the
  -- app is connected or waiting to be reconnected.
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' or not exists (
    select 1 from public.integrations
    where company_id = new.company_id and provider in ('quickbooks', 'zoho_books') and status in ('connected', 'error')
  ) then
    return null;
  end if;

  if tg_table_name = 'invoices' then
    if new.status not in ('draft', 'void') and (tg_op = 'INSERT' or old.status = 'draft') then
      insert into public.outbox (company_id, topic, payload)
      values (new.company_id, 'accounting.invoice', jsonb_build_object('invoice_id', new.id));
    end if;
  elsif tg_table_name = 'payments' then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'accounting.payment', jsonb_build_object('payment_id', new.id));
  end if;
  return null;
end $$;

create or replace function public.claim_outbox(p_limit integer default 25) returns setof public.outbox
language sql security definer set search_path = '' as $$
  update public.outbox o
  set locked_until = now() + interval '5 minutes', attempts = o.attempts + 1
  where o.id in (
    select x.id from public.outbox x
    where x.done_at is null and x.dead_at is null and x.run_after <= now()
      and (x.locked_until is null or x.locked_until < now())
      -- Accounting changes wait while the company's accounting app is waiting to be reconnected (and
      -- none is connected); calendar and Stripe work goes on.
      and (x.topic not like 'accounting.%'
           or exists (select 1 from public.integrations i
                    where i.company_id = x.company_id and i.provider in ('quickbooks', 'zoho_books') and i.status = 'connected')
           or not exists (select 1 from public.integrations i
                           where i.company_id = x.company_id and i.provider in ('quickbooks', 'zoho_books') and i.status = 'error'))
    order by x.id
    limit p_limit
    for update of x skip locked
  )
  returning o.*
$$;

notify pgrst, 'reload schema';
