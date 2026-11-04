-- Monthly plans charged automatically: a recurring job at a fixed price, invoiced monthly, with
-- autopay on (cleaning, pool and pest plans). On its invoice day emit_invoice_reminders queues the
-- month's charge (autopay_charges.bill 'month', billing_month) instead of telling the office, and
-- the 5-minute autopay task bills and charges it as it does a visit's: autopay_bill makes the
-- month's invoice (create_invoice_for_job with p_month), then the cap and the office's OK, and the
-- same Stripe calls, receipts, retries, failure notices and calling off follow.
--
-- Waits for the office's OK, as visits from before autopay started do:
--   * a month that began before autopay was in force for the client and the plan (the client
--     agreed, autopay went on for the job or it became a monthly plan, or it was resumed);
--   * a client whose agreement doesn't mention a monthly plan. The terms clients agreed to so far
--     say each visit, and once a month for a set price isn't that, so the starter terms now say "or
--     once a month for a monthly plan" (core starterAutopayTerms has the same words). Clients who
--     agreed to words without it are charged only with the office's OK until they agree to ones
--     with it. A business with terms of its own adds a monthly plan to them in Settings → Payments.
--
-- Per-visit and one-off autopay are as they were: billing_mode per_visit still means invoiced after
-- each visit (20261104000800_recurring_billing.sql keeps it in step), so their queueing, checks and
-- words don't change.

-- ---------------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------------

alter table public.autopay_charges drop constraint autopay_charges_bill_check;
alter table public.autopay_charges add constraint autopay_charges_bill_check check (bill in ('visits', 'standard', 'month'));
-- The month a 'month' charge bills (its first day), and only for those.
alter table public.autopay_charges add column billing_month date;
alter table public.autopay_charges add constraint autopay_charges_month_check check ((bill is distinct from 'month') = (billing_month is null));
comment on column public.autopay_charges.billing_month is 'For a monthly plan''s charge (bill month): the month it bills, made into its invoice by create_invoice_for_job with p_month.';

-- ---------------------------------------------------------------------------------------------
-- The terms
-- ---------------------------------------------------------------------------------------------

-- As in 20261104000700_autopay_plan_trades.sql, with "or once a month for a monthly plan" for the
-- trades that sell plans and the general words. Paving and roofing don't. Only the words a company
-- starts from: one with autopay on has saved terms of its own (autopay_set_settings), and its
-- clients' agreements keep the words they agreed to.
create or replace function private.autopay_starter_terms(p_trade text) returns text
language sql immutable security definer set search_path = '' as $$
  select case
    when p_trade = 'lawn_exterior' then
      'We charge the card on file after each visit is done, or once a month for a monthly plan, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade = 'cleaning' then
      'We charge the card on file after each cleaning, or once a month for a monthly plan, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade = 'pool_service' then
      'We charge the card on file after each pool service visit, or once a month for a monthly plan, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade = 'pest_control' then
      'We charge the card on file after each treatment, or once a month for a monthly plan, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade in ('paving', 'roofing_exteriors') then
      'We charge the card on file when the work on your job is done, and for other invoices we send you. Charges over the amount we agreed wait until we''ve talked with you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    else
      'We charge the card on file when each visit or job is done, or once a month for a monthly plan, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
  end
$$;

-- Whether the words a client agreed to cover a monthly plan's charge (core autopayCoversMonthly).
create function private.autopay_covers_monthly(p_terms text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_terms ~* 'monthly plan', false)
$$;

-- ---------------------------------------------------------------------------------------------
-- Which jobs
-- ---------------------------------------------------------------------------------------------

-- As in 20261101000100_autopay.sql, plus monthly plans (core autopayAllowed): recurring, a fixed
-- price, invoiced monthly. Becoming one counts as autopay starting for it (autopay_since), so a
-- month that began before isn't charged without the office's OK. The default for new jobs is still
-- only recurring per-visit ones.
create or replace function private.autopay_job_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_plan boolean := new.kind = 'recurring' and new.pricing is not distinct from 'fixed' and new.invoice_schedule is not distinct from 'monthly';
  v_allowed boolean := (new.kind = 'recurring' and new.billing_mode = 'per_visit') or (new.kind = 'one_off' and new.billing_mode = 'on_completion') or v_plan;
  v_signed_in boolean := (select auth.uid()) is not null;
begin
  if tg_op = 'INSERT' then
    if new.autopay and (not v_allowed
        or (v_signed_in and not (private.has_role(new.company_id, '{owner,admin,office}') and private.has_perm(new.company_id, 'invoices')))) then
      new.autopay := false;
    end if;
    if not new.autopay and new.kind = 'recurring' and new.billing_mode = 'per_visit' and private.autopay_job_default(new.company_id, new.client_id) then
      new.autopay := true;
    end if;
    new.autopay_since := case when new.autopay then now() end;
    return new;
  end if;

  -- Who chose to switch it: checked before the job type or the default changes it.
  if new.autopay is distinct from old.autopay and v_signed_in
     and not (private.has_role(new.company_id, '{owner,admin,office}') and private.has_perm(new.company_id, 'invoices')) then
    raise exception 'Only the office with the invoices area can turn autopay on or off for a job' using errcode = '42501';
  end if;
  if not v_allowed then
    if new.autopay and not old.autopay then
      raise exception 'Autopay works with recurring jobs billed per visit or at a fixed price monthly, or one-off jobs billed when the work is done' using errcode = '22023';
    end if;
    new.autopay := false;
  elsif (new.kind, new.billing_mode) is distinct from (old.kind, old.billing_mode) and new.kind = 'recurring' and new.billing_mode = 'per_visit'
        and not old.autopay and not new.autopay and private.autopay_job_default(new.company_id, new.client_id) then
    new.autopay := true;
  end if;
  new.autopay_since := case
    when new.autopay and not old.autopay then now()
    when new.autopay and v_plan and not (old.kind = 'recurring' and old.pricing is not distinct from 'fixed' and old.invoice_schedule is not distinct from 'monthly') then now()
    else old.autopay_since end;
  return new;
end $$;

/**
 * A monthly plan's charge for the month (emit_invoice_reminders, on the invoice day): due now, when
 * the job is a monthly plan on autopay and the client can be charged. False when it isn't queued
 * (then the office is told to invoice it, as any monthly job). One waiting for the job at a time,
 * as every autopay charge.
 */
create function private.autopay_queue_month(p_job uuid, p_month date) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  v_pm uuid;
begin
  select * into j from public.jobs where id = p_job;
  if not found or not j.autopay or j.status <> 'active' or j.kind <> 'recurring'
     or j.pricing is distinct from 'fixed' or j.invoice_schedule is distinct from 'monthly' then
    return false;
  end if;
  v_pm := private.autopay_ready(j.company_id, j.client_id);
  if v_pm is null then return false; end if;
  insert into public.autopay_charges (company_id, client_id, job_id, bill, billing_month, payment_method_id, due_at)
  values (j.company_id, j.client_id, j.id, 'month', p_month, v_pm, now())
  on conflict (job_id) where status = 'waiting' and invoice_id is null do nothing;
  return found;
end $$;

-- As in 20261104000800_recurring_billing.sql, plus: a monthly plan on autopay has the month's
-- charge queued instead of the office being told (autopay's own notices tell them when it needs them).
create or replace function public.emit_invoice_reminders(p_now timestamptz default now()) returns integer
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

-- ---------------------------------------------------------------------------------------------
-- Billing the charge
-- ---------------------------------------------------------------------------------------------

/**
 * As in 20261101000300_manual_charges.sql, plus monthly plans (bill 'month'): the job must still be
 * one when it's billed, its invoice is the month's (create_invoice_for_job with p_month, once a
 * month), and before charging without the office's OK the month must have begun once autopay was
 * in force for the client and the plan, and the client's agreement must mention a monthly plan.
 *
 * Bill a claimed charge: make its invoice (a draft) when it has none, then say what to do next.
 * Runs only while the caller holds the claim. Money stays in one transaction here.
 *
 * Returns {outcome: 'charge', invoice_id, invoice_status, balance_due, method: {id,
 * stripe_payment_method_id, stripe_customer_id, livemode, stripe_account, type}}, or {outcome:
 * 'called_off' | 'paid' | 'needs_approval' | 'lost', reason, invoice_id}. All but 'charge' and 'lost'
 * have already written the row and let go of the claim.
 */
create or replace function public.autopay_bill(p_charge uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
  j public.jobs;
  i public.invoices;
  m public.client_payment_methods;
  v_autopay jsonb;
  v_pm uuid;
  v_invoice uuid;
  v_accepted timestamptz;
  v_since timestamptz;
  v_begun timestamptz;
  v_reason text;
  v_max numeric;
begin
  select * into r from public.autopay_charges where id = p_charge for update;
  if not found or p_token is null or r.status <> 'charging' or r.claim_token is distinct from p_token then
    return jsonb_build_object('outcome', 'lost', 'reason', null, 'invoice_id', r.invoice_id);
  end if;

  -- 1. Billed already (a retry, an approved charge, or a manual one): what's become of the invoice.
  if r.invoice_id is not null then
    select * into i from public.invoices where id = r.invoice_id for update;
    if i.status = 'paid' then
      if private.autopay_paid_by_charge(i.id, r.created_at) then
        return private.autopay_bill_end(r.id, 'paid', null);   -- went through before its worker stopped
      end if;
      return private.autopay_bill_end(r.id, 'called_off', 'Paid another way');
    end if;
    -- Stripe credit paid its own Stripe invoice in full before it was marked sent (its worker stopped
    -- between): sent now, as finish_autopay_charge does, so invoice_totals makes it paid.
    if i.status = 'draft' and i.balance_due <= 0 and private.autopay_paid_by_charge(i.id, r.created_at) then
      update public.invoices set status = 'sent' where id = i.id and status = 'draft';
      -- Nothing on the card: a draft is only paid before /pay, so by credit.
      update public.autopay_charges set charged_amount = 0 where id = r.id;
      return private.autopay_bill_end(r.id, 'paid', null);
    end if;
    if i.status not in ('draft', 'sent', 'partially_paid', 'overdue') or i.balance_due <= 0 then
      return private.autopay_bill_end(r.id, 'called_off', case i.status when 'void' then 'The invoice was voided'
        when 'written_off' then 'The invoice was written off' else 'Nothing is owed on it' end);
    end if;
    -- Charge card is for the invoice as the office saw it.
    if r.source = 'manual' and i.client_id is distinct from r.client_id then
      return private.autopay_bill_end(r.id, 'called_off', 'The invoice is for another client now');
    end if;
    if r.source = 'manual' and i.balance_due > r.approved_amount then
      return private.autopay_bill_end(r.id, 'called_off', 'The invoice changed after Charge card was pressed. Charge it again');
    end if;
  elsif r.source = 'manual' then
    return private.autopay_bill_end(r.id, 'called_off', 'The invoice was deleted');
  end if;

  -- 2. Still on, on fresh data (the same checks billed or not; the status trigger tells the office
  -- when that leaves an invoice unpaid). A manual charge has no job or bill, so only the company's
  -- switch and the client's agreement apply to it.
  select * into j from public.jobs where id = r.job_id;
  select private.autopay_of(c.settings) into v_autopay from public.companies c where c.id = r.company_id;
  v_pm := private.autopay_ready(r.company_id, r.client_id);
  if r.source = 'autopay' and (j.id is null or not j.autopay or j.status = 'archived') then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is off for this job');
  end if;
  if v_autopay -> 'enabled' is distinct from 'true'::jsonb then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is turned off in Settings');
  end if;
  if v_pm is null then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is off for this client');
  end if;
  if r.bill = 'standard' and r.invoice_id is null and j.status <> 'requires_invoicing' then
    return private.autopay_bill_end(r.id, 'called_off', 'The job isn''t waiting to be billed');
  end if;
  if r.bill = 'month' and r.invoice_id is null
     and not (j.kind = 'recurring' and j.status = 'active' and j.pricing is not distinct from 'fixed' and j.invoice_schedule is not distinct from 'monthly') then
    return private.autopay_bill_end(r.id, 'called_off', 'The job isn''t a monthly plan anymore');
  end if;
  if r.bill = 'visits' and r.invoice_id is not null
     and exists (select 1 from public.visits v where v.invoice_id = r.invoice_id and v.status <> 'completed') then
    return private.autopay_bill_end(r.id, 'called_off', 'A visit on it was reopened');
  end if;
  update public.autopay_charges set payment_method_id = v_pm where id = r.id;

  -- 3. No invoice yet: make it, as the office's Invoice button would (this runs as the function's
  -- owner, past row-level security). It bills every finished visit of the job not yet billed (a
  -- monthly plan: the month's price, once). Those that queued another of the job's charges still
  -- gathering visits (one made while this was claimed) count as queued for this one too: that
  -- charge has nothing left to bill.
  if r.invoice_id is null then
    begin
      v_invoice := case when r.bill = 'month' then public.create_invoice_for_job(r.job_id, 'standard', null, r.billing_month)
                        else public.create_invoice_for_job(r.job_id, r.bill) end;
    exception when sqlstate '22023' or sqlstate 'P0002' then
      return private.autopay_bill_end(r.id, 'called_off', left(sqlerrm, 1000));
    end;
    update public.autopay_charges a
    set invoice_id = v_invoice,
        visit_ids = a.visit_ids || array(
          select distinct x
          from public.autopay_charges o cross join lateral unnest(o.visit_ids) x
          join public.visits v on v.id = x and v.invoice_id = v_invoice
          where o.job_id = r.job_id and o.id <> r.id and o.status in ('waiting', 'charging') and o.invoice_id is null
            and x <> all (a.visit_ids))
    where a.id = r.id
    returning a.visit_ids into r.visit_ids;
    r.invoice_id := v_invoice;
  end if;
  select * into i from public.invoices where id = r.invoice_id for update;

  -- 4. Asking first, only while the invoice is still a draft, and only for autopay's own charges.
  -- Autopay charges without the office's OK only for visits it queued itself (visit_ids: finished
  -- while autopay was in force for the client and the job). A visit freed by a voided or deleted
  -- invoice, or finished while autopay was paused, off in Settings or off for the job, wasn't, so
  -- the bill waits for Approve charge. The dates are checked too, for a visit finished offline (or
  -- marked done later) before autopay started, or while it was paused, and queued when it synced (an
  -- offline Complete keeps its tap time as completed_at: visit_defaults, visit_sub_guard): from the
  -- start of the client's unbroken run of agreements (a card changed, revoked_via 'replaced',
  -- doesn't break it), from when the job's autopay went on, and from when the office last resumed it
  -- (resumed_at). A monthly plan's month is checked the same way from the day it began, and the
  -- client's agreement in force must mention a monthly plan.
  if i.status = 'draft' and r.source = 'autopay' then
    -- Work an AI assistant marked done (autopay_queue): the office looks first, whatever the amount.
    if r.held is not null and r.approved_at is null then
      update public.autopay_charges
      set status = 'needs_approval', last_error = r.held, claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
      return jsonb_build_object('outcome', 'needs_approval', 'reason', r.held, 'invoice_id', i.id);
    end if;
    if r.bill in ('visits', 'month') and r.approved_at is null then
      select min(a.accepted_at) into v_accepted from public.autopay_authorizations a
      where a.company_id = r.company_id and a.client_id = r.client_id
        and a.accepted_at > coalesce((
          select max(b.revoked_at) from public.autopay_authorizations b
          where b.company_id = r.company_id and b.client_id = r.client_id and b.revoked_at is not null and b.revoked_via <> 'replaced'
        ), '-infinity'::timestamptz);
      select greatest(v_accepted, coalesce(j.autopay_since, '-infinity'::timestamptz), coalesce(a.resumed_at, '-infinity'::timestamptz))
      into v_since from public.autopay_authorizations a
      where a.company_id = r.company_id and a.client_id = r.client_id and a.revoked_at is null;
      if r.bill = 'month' then
        -- When the month began where the company is: the day after last month's invoice day.
        select coalesce(x.period_start, p.period_start)::timestamp at time zone coalesce(c.timezone, 'UTC') into v_begun
        from public.companies c
        cross join lateral private.invoice_period(j.invoice_day, r.billing_month) p
        left join public.invoice_reminders x on x.job_id = r.job_id and x.month = r.billing_month
        where c.id = r.company_id;
      end if;
      v_reason := case
        when r.bill = 'visits' and exists (select 1 from public.visits v where v.invoice_id = i.id and v.completed_at < v_since)
          then 'Includes visits from before autopay started'
        when r.bill = 'visits' and exists (select 1 from public.visits v where v.invoice_id = i.id and v.id <> all (r.visit_ids))
          then 'Includes visits autopay didn''t queue (finished while it was off, or from a voided invoice)'
        when r.bill = 'month' and v_begun < v_since
          then 'Covers days from before autopay started'
        when r.bill = 'month' and not exists (
            select 1 from public.autopay_authorizations a
            where a.company_id = r.company_id and a.client_id = r.client_id and a.revoked_at is null and private.autopay_covers_monthly(a.terms))
          then 'Their autopay terms don''t mention a monthly plan'
      end;
      if v_reason is not null then
        update public.autopay_charges
        set status = 'needs_approval', last_error = v_reason, claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
        return jsonb_build_object('outcome', 'needs_approval', 'reason', v_reason, 'invoice_id', i.id);
      end if;
    end if;
    v_max := case when jsonb_typeof(v_autopay -> 'max_amount') = 'number' then (v_autopay -> 'max_amount')::numeric end;
    if v_max is not null and i.balance_due > v_max and (r.approved_at is null or i.balance_due > r.approved_amount) then
      update public.autopay_charges
      set status = 'needs_approval', last_error = null, claim_token = null, locked_until = null, busy_since = null,
          approved_at = null, approved_by = null, approved_amount = null
      where id = r.id;
      return jsonb_build_object('outcome', 'needs_approval', 'reason', null, 'invoice_id', i.id);
    end if;
  end if;

  -- 5. Charge it: the claim is held for the Stripe calls.
  update public.autopay_charges set locked_until = now() + interval '5 minutes' where id = r.id;
  select * into m from public.client_payment_methods where id = v_pm;
  return jsonb_build_object(
    'outcome', 'charge', 'invoice_id', i.id, 'invoice_status', i.status, 'balance_due', i.balance_due,
    'method', jsonb_build_object('id', m.id, 'stripe_payment_method_id', m.stripe_payment_method_id,
      'stripe_customer_id', m.stripe_customer_id, 'livemode', m.livemode, 'stripe_account', m.stripe_account, 'type', m.type));
end $$;

revoke all on function private.autopay_covers_monthly(text), private.autopay_queue_month(uuid, date) from public;

notify pgrst, 'reload schema';
