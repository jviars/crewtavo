
-- Dates, times and amounts in what clients, subs and the crew read, written the way the business's
-- country writes them and in its currency (20261125100100_dates_in_the_business_country.sql): the
-- lines of an invoice ("Visit on 6 Oct 2026", a late fee's "The invoice was due 6 October 2026"),
-- a promo code's and the client hub's words, a sub's offers, pay and paperwork, the crew's schedule
-- and clock, and a snow visit's notes.
--
-- Each function below is its newest definition, copied as it is, with only these changes: a date
-- or time that to_char wrote with a US pattern is written by private.date_text with the business's
-- country, an amount private.money or to_char 'FM$999,999,990.00' wrote is in the business's
-- currency, and the country and currency are read with the company. A time that ends a sentence
-- and ends in a full stop itself (5:00 p.m., in Canada) isn't given a second one. A US business in
-- dollars reads every word as before.
--
-- The release before this one keeps working with it: no function's arguments change. Where a
-- function had no business to read the country from (private.visit_when), there's a new one with a
-- country beside it, and the old one stays as it was.
--
-- supabase/tests/dates_in_the_business_country_test.sql covers it.

-- As in 20261123100100_prices_and_settings_for_the_office.sql, with a visit's day on its invoice
-- lines and the amounts in its descriptions and errors in the business's country's way and
-- currency.
CREATE OR REPLACE FUNCTION public.create_invoice_for_job(p_job uuid, p_kind text DEFAULT 'standard'::text, p_amount numeric DEFAULT NULL::numeric, p_month date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  j public.jobs;
  v_invoice uuid;
  v_terms integer;
  v_tax numeric;
  v_today date;
  v_tz text;
  v_country text;
  v_currency text;
  v_deposit numeric;
  v_amount numeric;
  v_contract numeric;
  v_prebilled numeric;
  v_existing bigint;
  v_month date := date_trunc('month', p_month::timestamp)::date;
  v_start date;
  v_end date;
  v_sort integer := 0;
  v_job_total numeric;
  v_job_taxable numeric;
  v_taxed numeric;
  v_was text := coalesce(current_setting('crewtavo.job_discounts', true), '');
  v_extras_was text := coalesce(current_setting('crewtavo.visit_extras', true), '');
  v_inst_was text := coalesce(current_setting('crewtavo.installment', true), '');
  v_inst uuid;
  v_inst_name text;
  v_inst_amount numeric;
  v_full numeric;
  v_wait text;
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
  -- Visit by visit only for a job priced that way: anything else would bill the whole job once
  -- for each visit.
  if p_kind = 'visits' and j.kind = 'recurring' and j.pricing is not distinct from 'fixed' then
    raise exception 'This job is a fixed price, so it isn''t invoiced visit by visit. Invoice the job''s price instead' using errcode = '22023';
  elsif p_kind = 'visits' and j.kind <> 'recurring' and j.billing_mode is distinct from 'per_visit' then
    raise exception 'This job is billed as one job, not visit by visit. Make its final invoice instead' using errcode = '22023';
  end if;
  -- A payment of the job's schedule: private.make_installment says which. Or the job's own Invoice
  -- button on a job whose "when the work is done" payment has others after it still to come: that
  -- payment is what's made, on account, and the later ones wait for their moment. Or its Deposit
  -- button, which makes the payment due at approval as it always did.
  v_inst := nullif(v_inst_was, '')::uuid;
  if v_inst is null and p_kind = 'standard' and p_month is null and j.kind <> 'recurring' then
    v_inst := private.installment_for_invoice(j.id);
    if v_inst is not null then
      p_kind := 'progress';
      p_amount := null;
    end if;
  elsif v_inst is null and p_kind = 'deposit' and j.kind <> 'recurring' then
    v_inst := private.installment_for_deposit(j.id);
  end if;
  -- A final invoice bills everything left. When all that's left is payments that have a day still
  -- to come, each is invoiced by itself on its day, so the button doesn't bill them early by habit
  -- (or a batch of finished jobs by accident): Invoice now, on the payment, is how that's chosen.
  if v_inst is null and p_kind = 'standard' and p_month is null and j.kind <> 'recurring' then
    v_wait := private.installments_wait_for_their_day(j.id);
    if v_wait is not null then
      raise exception '%', v_wait using errcode = '22023';
    end if;
  end if;
  if v_inst is not null then
    select b.name, b.amount into v_inst_name, v_inst_amount from private.installment_billing(v_inst) b where b.job_id = j.id;
    if not found then
      v_inst := null;
    elsif p_kind = 'progress' then
      p_amount := coalesce(p_amount, v_inst_amount);
    end if;
  end if;
  select contract_total into v_contract from public.job_financials where job_id = j.id;
  select coalesce((s.settings ->> 'payment_terms_days')::integer, 30), coalesce((s.settings ->> 'default_tax_rate')::numeric, 0),
         (now() at time zone coalesce(c.timezone, 'UTC'))::date, coalesce(c.timezone, 'UTC'), c.country, c.currency
    into v_terms, v_tax, v_today, v_tz, v_country, v_currency
  from public.companies c cross join lateral (select private.saved_settings(c.id) as settings) s
  where c.id = j.company_id;
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

  -- A schedule's payment is part of the quote's total, tax and all, so it's held to what the job
  -- comes to with its tax (v_full); any other deposit or progress invoice to the contract before it.
  if v_inst is not null then
    select coalesce(v_contract, 0) + round(greatest(coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable), 0), 0) * v_tax, 2)
      into v_full
    from public.job_line_items where job_id = j.id;
  end if;
  if p_kind in ('deposit', 'progress') and j.kind <> 'recurring' and v_prebilled + v_amount > coalesce(v_full, v_contract, 0) + 0.005 then
    raise exception 'That''s more than what''s left to bill on this job (%)',
      to_char(greatest(coalesce(v_full, v_contract, 0) - v_prebilled, 0), private.money_pattern(v_currency)) using errcode = '22023';
  end if;

  -- The invoice is the payment's from the moment it exists (private.invoice_bills_installment).
  perform set_config('crewtavo.installment', coalesce(v_inst::text, ''), true);

  insert into public.invoices (company_id, client_id, job_id, kind, subject, issued_on, due_on, tax_rate, retainage_pct, pay_app_number, billing_month)
  values (
    j.company_id, j.client_id, j.id, p_kind,
    case when p_month is not null then j.title || ' (' || to_char(v_month, 'FMMonth YYYY') || ')'
         when v_inst is not null and p_kind <> 'deposit' then left(v_inst_name || ': ' || j.title, 200)
         else case p_kind when 'deposit' then 'Deposit: ' || j.title when 'visits' then j.title || ' (completed visits)'
                          when 'retainage' then 'Retainage: ' || j.title else j.title end end,
    v_today, v_today + v_terms,
    case when p_kind in ('deposit', 'retainage') then 0 else v_tax end,
    case when p_kind in ('standard', 'progress') then j.retainage_pct else 0 end,
    case when p_kind = 'progress' then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end,
    v_month
  )
  returning id into v_invoice;
  perform set_config('crewtavo.installment', v_inst_was, true);

  -- All the lines go in first; the promo discounts are placed once they're there.
  perform set_config('crewtavo.job_discounts', 'on', true);
  -- Only here does extra work go on an invoice (private.visit_extras_guard).
  perform set_config('crewtavo.visit_extras', 'billing', true);

  if p_kind = 'deposit' then
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Deposit for ' || j.title, 1, 'ea', v_amount, false, 0);

  elsif p_kind = 'retainage' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Retainage release: ' || j.title, 'Amount held back on earlier invoices for this job', 1, 'ea', v_amount, false, 0);

  elsif p_kind = 'progress' and v_inst is not null then
    -- A schedule's payment on account: the amount signed, tax included, so no tax of its own. The
    -- final invoice takes it off and carries the job's tax.
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, v_inst_name || ' for ' || j.title,
            case when v_full > 0 then 'Part of the ' || to_char(v_full, private.money_pattern(v_currency)) || ' total' || case when v_full > coalesce(v_contract, 0) then ', tax included' else '' end end,
            1, 'ea', v_amount, false, 0);

  elsif p_kind = 'progress' then
    -- How much of what's billed is taxed (v_taxed): all of it on a fully taxable job (and on one
    -- with no priced lines to go by), as before. Otherwise the job's taxable share of it, and no
    -- more than the job's taxable work that earlier progress invoices haven't taxed already, so the
    -- final invoice's taxable amount never has to go below $0.
    select coalesce(sum(round(quantity * unit_price, 2)), 0), coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable), 0)
      into v_job_total, v_job_taxable
    from public.job_line_items where job_id = j.id;
    if v_job_total <= 0 or v_job_taxable >= v_job_total then
      v_taxed := v_amount;
    else
      select coalesce(sum(round(l.quantity * l.unit_price, 2)), 0) into v_taxed
      from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id
      where i.job_id = j.id and i.kind = 'progress' and i.status <> 'void' and l.taxable;
      v_taxed := greatest(least(round(v_amount * v_job_taxable / v_job_total, 2), v_job_taxable - v_taxed), 0);
    end if;
    if v_taxed >= v_amount or v_taxed <= 0 then
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
      values (j.company_id, v_invoice, 'Progress billing: ' || j.title,
              case when v_contract > 0 then round(v_amount / v_contract * 100, 1) || '% of the ' || to_char(v_contract, private.money_pattern(v_currency)) || ' contract' end,
              1, 'ea', v_amount, v_taxed > 0, 0);
    else
      -- A line is taxed or it isn't, so a partly taxed amount is two lines.
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice, 'Progress billing: ' || j.title,
             p.part || case when v_contract > 0 then ' of ' || round(v_amount / v_contract * 100, 1) || '% of the ' || to_char(v_contract, private.money_pattern(v_currency)) || ' contract' else '' end,
             1, 'ea', p.amount, p.taxable, p.sort
      from (values ('Taxed part', v_taxed, true, 0), ('Untaxed part', v_amount - v_taxed, false, 1)) p (part, amount, taxable, sort);
    end if;

  elsif p_kind = 'visits' then
    for r in
      select v.id, vp.price, vp.price_note, coalesce(private.visit_day(null, v.completed_at, v_tz), v.scheduled_on) as day
      from public.visits v left join lateral private.visit_billed(v.id) vp on true
      where v.job_id = j.id and v.status = 'completed' and v.invoice_id is null and v.kind = 'job'
        and (p_month is null or private.visit_day(v.scheduled_on, v.completed_at, v_tz) between v_start and v_end)
      order by coalesce(private.visit_day(null, v.completed_at, v_tz), v.scheduled_on)
    loop
      if r.price is not null then
        -- A visit with its own price (a snow storm billed by its depth) is one line at that price, as
        -- the job's first line is named and taxed, in place of the job's lines.
        insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort)
        select j.company_id, v_invoice, li.service_id, coalesce(li.name, j.title),
               'Visit on ' || private.date_text(r.day, 'Mon DD, YYYY', v_country) || coalesce(': ' || r.price_note, ''), 1, 'ea', r.price, coalesce(li.taxable, true), v_sort
        from (select 1) one
        left join lateral (select l.service_id, l.name, l.taxable from public.job_line_items l where l.job_id = j.id order by l.sort, l.id limit 1) li on true;
      else
        insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
        select j.company_id, v_invoice, li.service_id, li.name, 'Visit on ' || private.date_text(r.day, 'Mon DD, YYYY', v_country), li.quantity, li.unit, li.unit_price, li.taxable, v_sort + li.sort, li.discount_key
        from public.job_line_items li where li.job_id = j.id and li.discount_billing is distinct from 'once';
      end if;
      update public.visits set invoice_id = v_invoice where id = r.id;
      -- Extra work on this visit alone: on its invoice once, after the visit's own lines.
      insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice, e.service_id, e.name,
             concat_ws(E'\n', 'Extra work, visit on ' || private.date_text(r.day, 'Mon DD, YYYY', v_country), nullif(btrim(e.description), '')),
             e.quantity, e.unit, e.unit_price, e.taxable, v_sort + 900000 + row_number() over (order by e.created_at, e.id)
      from public.visit_extras e where e.visit_id = r.id and e.invoice_id is null;
      update public.visit_extras set invoice_id = v_invoice where visit_id = r.id and invoice_id is null;
      v_sort := v_sort + 1000000;
    end loop;

  else
    insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
    select company_id, v_invoice, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_key
    from public.job_line_items where job_id = j.id and discount_billing is distinct from 'once';
    -- A fixed price is the price whatever the visits, so the extra work on its finished visits that
    -- no invoice has yet goes on this one, each once, as an addition to the price (a month's
    -- invoice: on visits up to the end of its days; later ones wait for their month's).
    if j.kind = 'recurring' and j.pricing is not distinct from 'fixed' then
      with billed as (
        update public.visit_extras e set invoice_id = v_invoice
        from public.visits v
        where e.job_id = j.id and e.invoice_id is null and v.id = e.visit_id and v.kind = 'job' and v.status = 'completed'
          and (p_month is null or private.visit_day(v.scheduled_on, v.completed_at, v_tz) <= v_end)
        returning e.id, e.service_id, e.name, e.description, e.quantity, e.unit, e.unit_price, e.taxable, e.created_at,
                  coalesce(private.visit_day(null, v.completed_at, v_tz), v.scheduled_on) as day
      )
      insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice, b.service_id, b.name,
             concat_ws(E'\n', 'Extra work, visit on ' || private.date_text(b.day, 'Mon DD, YYYY', v_country), nullif(btrim(b.description), '')),
             b.quantity, b.unit, b.unit_price, b.taxable, 100000 + row_number() over (order by b.day, b.created_at, b.id)
      from billed b;
    end if;
    -- Credit what was already billed as deposits and progress payments (not on a month's invoice:
    -- it isn't the job's last).
    if p_month is null then
      -- A progress invoice's credit reduces the taxable amount by what that invoice's own lines
      -- taxed (t.taxed, between nothing and all of it): one taxed line when all of it was, as
      -- before, and a taxed and an untaxed line when part of it was. A deposit's is untaxed.
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice,
             case when n.payment is not null then 'Less ' || n.payment || ' (invoice #' || i.number || ')'
                  when i.kind = 'deposit' then 'Less deposit (invoice #' || i.number || ')' else 'Less progress billing (invoice #' || i.number || ')' end,
             case when t.taxed > 0 and t.taxed < i.subtotal then case when p.taxable then 'Taxed part' else 'Untaxed part' end end,
             1, 'ea', -p.amount, p.taxable, 200000 + row_number() over (order by i.number, p.taxable desc)
      from public.invoices i
      cross join lateral (
        select case when i.kind <> 'progress' then 0
                    when i.subtotal <= 0 then i.subtotal
                    else least(greatest(coalesce((select sum(round(l.quantity * l.unit_price, 2)) from public.invoice_line_items l
                                                   where l.invoice_id = i.id and l.taxable), 0), 0), i.subtotal) end as taxed
      ) t
      cross join lateral (values (true, t.taxed), (false, i.subtotal - t.taxed)) p (taxable, amount)
      -- A payment of the job's schedule is taken off by its name.
      cross join lateral (select private.installment_of_invoice(i.id) as payment) n
      where i.job_id = j.id and i.kind in ('deposit', 'progress') and i.status <> 'void' and i.id <> v_invoice
        -- An invoice that comes to $0 keeps its one $0 line, as before.
        and (p.amount <> 0 or (i.subtotal = 0 and p.taxable = (i.kind = 'progress')));
    end if;
    -- A one-off job's final invoice bills the whole job, so the visits finished by now are on it.
    if j.kind <> 'recurring' then
      update public.visits set invoice_id = v_invoice
      where job_id = j.id and kind = 'job' and status = 'completed' and invoice_id is null;
    end if;
  end if;

  if p_kind in ('standard', 'visits') then
    perform private.place_job_discounts(j.id);
    perform private.fit_job_discounts(v_invoice);
  end if;
  perform set_config('crewtavo.job_discounts', v_was, true);
  perform set_config('crewtavo.visit_extras', v_extras_was, true);

  -- Touch the invoice so totals include the lines just added.
  update public.invoices set updated_at = now() where id = v_invoice;

  if j.status = 'requires_invoicing' and p_kind in ('standard', 'visits') then
    update public.jobs set status = 'completed' where id = j.id;
  end if;
  return v_invoice;
end $function$;

-- As in 20261113000430_owed_again_without_chasing.sql, with the day the invoice was due, on the
-- late fee's line, in the business's country's way.
create or replace function public.add_late_fees() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_fee numeric;
  v_count integer := 0;
  v_was text := coalesce(current_setting('crewtavo.late_fee', true), '');
begin
  for r in
    select i.id, i.company_id, i.balance_due, i.due_on, c.settings -> 'late_fee' as fee, c.country
      from public.invoices i
      join public.companies c on c.id = i.company_id
     where jsonb_typeof(c.settings -> 'late_fee') = 'object'
       and c.settings -> 'late_fee' ->> 'type' in ('flat', 'percent')
       and jsonb_typeof(c.settings -> 'late_fee' -> 'amount') = 'number'
       and coalesce(jsonb_typeof(c.settings -> 'late_fee' -> 'grace_days'), 'number') = 'number'
       and i.status in ('sent', 'partially_paid', 'overdue')
       and i.kind <> 'deposit'
       and not i.no_late_fee
       and i.balance_due > 0
       and i.late_fee_at is null
       -- The grace days count from the due date, or from the day it was owed again if that's later.
       and greatest(i.due_on, coalesce((i.owed_again_at at time zone c.timezone)::date, i.due_on))
           + coalesce((c.settings -> 'late_fee' ->> 'grace_days')::numeric::integer, 0) < (now() at time zone c.timezone)::date
       and not exists (select 1 from public.stripe_invoices s where s.invoice_id = i.id and (s.origin = 'stripe' or s.status = 'processing'))
       and not exists (select 1 from public.autopay_charges a where a.invoice_id = i.id and a.status in ('charging', 'processing'))
     for update of i skip locked
  loop
    v_fee := case r.fee ->> 'type'
      when 'flat' then round((r.fee ->> 'amount')::numeric, 2)
      else round(r.balance_due * (r.fee ->> 'amount')::numeric / 100, 2) end;
    update public.invoices set late_fee_at = now() where id = r.id and late_fee_at is null;
    if found and v_fee > 0 then
      perform set_config('crewtavo.late_fee', 'on', true);
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort, kind)
      values (r.company_id, r.id, 'Late fee', 'The invoice was due ' || private.date_text(r.due_on, 'FMMonth FMDD, YYYY', r.country), 1, 'ea', v_fee, false,
              coalesce((select max(sort) from public.invoice_line_items where invoice_id = r.id), 0) + 1, 'late_fee');
      perform set_config('crewtavo.late_fee', v_was, true);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- As in 20261017001600_promo_codes.sql, with the days a code starts and ends, and the order it
-- needs, in the business's country's way and currency.
create or replace function private.find_promo(p_company uuid, p_client uuid, p_code text, p_base numeric, p_except uuid default null)
returns public.promo_codes
language plpgsql stable security definer set search_path = '' as $$
declare p public.promo_codes; v_today date;
begin
  -- Signed-in callers only see their own company's codes (the server calls with no user).
  if auth.uid() is not null and not private.is_member(p_company) then
    raise exception 'That code isn''t valid. Check the spelling and try again.' using errcode = '22023';
  end if;
  select * into p from public.promo_codes
  where company_id = p_company and code = upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  if not found or not p.active then
    raise exception 'That code isn''t valid. Check the spelling and try again.' using errcode = '22023';
  end if;
  select (now() at time zone coalesce(timezone, 'UTC'))::date into v_today from public.companies where id = p_company;
  if p.starts_on is not null and v_today < p.starts_on then
    raise exception 'That code starts on %.', private.date_text(p.starts_on, 'FMMonth FMDD', private.company_country(p_company)) using errcode = '22023';
  end if;
  if p.ends_on is not null and v_today > p.ends_on then
    raise exception 'That code expired on %.', private.date_text(p.ends_on, 'FMMonth FMDD', private.company_country(p_company)) using errcode = '22023';
  end if;
  if p.max_uses is not null and private.promo_uses(p.id, null, p_except) >= p.max_uses then
    raise exception 'That code has already been used up.' using errcode = '22023';
  end if;
  if p_client is not null and p.once_per_client and private.promo_uses(p.id, p_client, p_except) > 0 then
    raise exception 'That code has already been used for this account.' using errcode = '22023';
  end if;
  if p_client is not null and p.new_clients_only and (
    exists (select 1 from public.invoices i where i.client_id = p_client and i.status = 'paid')
    or exists (select 1 from public.jobs j where j.client_id = p_client)
  ) then
    raise exception 'That code is for new customers.' using errcode = '22023';
  end if;
  if p_base is not null and p_base < p.min_subtotal then
    raise exception 'That code needs an order of at least %.', to_char(p.min_subtotal, private.money_pattern(private.company_currency(p_company))) using errcode = '22023';
  end if;
  return p;
end $$;

-- As in 20261017001600_promo_codes.sql, with an amount off in the business's currency.
create or replace function public.check_promo_code(p_company uuid, p_code text) returns text
language plpgsql stable security invoker set search_path = '' as $$
declare p public.promo_codes;
begin
  p := private.find_promo(p_company, null, p_code, null);
  return case when p.kind = 'percent' then trim(trailing '.' from trim(trailing '0' from p.value::text)) || '% off'
              else to_char(p.value, private.money_pattern(private.company_currency(p_company))) || ' off' end
         || coalesce(': ' || p.description, '');
end $$;

-- As in 20261025000100_contracts_and_options.sql, with the order a code needs in the business's
-- currency.
create or replace function public.approve_hub_quote(p_company uuid, p_quote uuid, p_selected uuid[], p_approval jsonb,
  p_option uuid default null, p_expected_total numeric default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_selected uuid[] := coalesce(p_selected, '{}');
  v_minimum numeric;
begin
  -- A second approval waits here for the first, then finds the quote approved and leaves it alone.
  perform 1 from public.quotes
   where company_id = p_company and id = p_quote and status in ('sent', 'changes_requested')
   for update;
  if not found then
    return false;
  end if;
  if p_option is not null and not exists (select 1 from public.quote_options where quote_id = p_quote and id = p_option) then
    return false;
  end if;
  if p_option is null and exists (select 1 from public.quote_options where quote_id = p_quote) then
    raise exception 'Pick one of the options first.' using errcode = '22023';
  end if;

  begin
    if p_option is not null then
      update public.quotes set option_id = p_option where id = p_quote and option_id is distinct from p_option;
    end if;
    -- Add-ons follow the client's choices; required lines stay selected.
    update public.quote_line_items set selected = (id = any(v_selected))
     where quote_id = p_quote and optional and (option_id is null or option_id = p_option)
       and selected is distinct from (id = any(v_selected));
    if p_expected_total is not null and (select total from public.quotes where id = p_quote) <> p_expected_total then
      raise exception 'The price changed.' using errcode = 'CX409';
    end if;
  exception when sqlstate 'CX409' then
    return false;
  end;

  select p.min_subtotal into v_minimum
    from public.quotes q join public.promo_codes p on p.id = q.promo_code_id
   where q.id = p_quote;
  if v_minimum > 0 and (select coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and unit_price > 0), 0)
                          from public.quote_line_items where quote_id = p_quote) < v_minimum then
    raise exception 'That code needs an order of at least %. Remove the code, or change your choices.',
      to_char(v_minimum, private.money_pattern(private.company_currency(p_company))) using errcode = 'CX412';
  end if;

  -- The lines re-ran the quote's totals, so these are the amounts with those choices: the approval
  -- shows the price that was agreed to.
  update public.quotes q
     set status = 'approved', approved_at = now(),
         approval = coalesce(p_approval, '{}') || jsonb_build_object(
           'subtotal', q.subtotal, 'discount_amount', q.discount_amount, 'tax_amount', q.tax_amount, 'total', q.total)
   where q.id = p_quote;
  return true;
end $$;

-- As in 20261124100300_money_in_the_business_currency.sql, with the visits' days in the business's
-- country's way (core offerLine writes the same words).
create or replace function private.sub_offer_line(p_pay uuid) returns text
language sql stable security definer set search_path = '' as $$
  select concat_ws(', ', j.title, d.days, q.words, private.money_short(p.total, (select c.currency from public.companies c where c.id = p.company_id)))
  from public.job_pay p
  join public.jobs j on j.id = p.job_id
  left join lateral (
    select case
      when count(v.scheduled_on) = 0 then null
      when min(v.scheduled_on) = max(v.scheduled_on) then private.date_text(min(v.scheduled_on), 'Dy Mon FMDD', private.company_country(p.company_id))
      else private.date_text(min(v.scheduled_on), 'Dy Mon FMDD', private.company_country(p.company_id)) || ' to ' || private.date_text(max(v.scheduled_on), 'Dy Mon FMDD', private.company_country(p.company_id))
    end as days
    from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
    where jv.job_pay_id = p.id and v.status <> 'cancelled'
  ) d on true
  left join lateral (
    select private.amount_words(l.quantity, l.unit) as words from public.job_pay_lines l
    where l.job_pay_id = p.id and l.basis = 'per_unit' and l.quantity > 0
    order by l.amount desc, l.sort, l.created_at, l.id limit 1
  ) q on true
  where p.id = p_pay
$$;

-- As in 20261025004001_sub_offers.sql, in the business's country's way: the day, then the time as
-- the country keeps it (core offerTimeWords writes the same words).
create or replace function private.local_time_words(p_company uuid, p_at timestamptz) returns text
language sql stable security definer set search_path = '' as $$
  select (private.date_text(p_at at time zone coalesce((select c.timezone from public.companies c where c.id = p_company), 'UTC'), 'Dy Mon FMDD', private.company_country(p_company)) || ', ' || private.date_text(p_at at time zone coalesce((select c.timezone from public.companies c where c.id = p_company), 'UTC'), 'FMHH12:MI AM', private.company_country(p_company)))
$$;

-- As in 20261124100300_money_in_the_business_currency.sql, with one full stop after the time to
-- answer by when it ends in one (5:00 p.m.), as private.local_time_words now writes it the
-- business's country's way (core answerByWords writes the same words).
create or replace function private.sub_offer_told(p public.job_pay, p_event text, p_change boolean, p_offered numeric default null, p_was numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job text := (select j.title from public.jobs j where j.id = p.job_id);
  v_sub text := (select s.name from public.subcontractors s where s.id = p.subcontractor_id);
  v_offered numeric := coalesce(p_offered, p.total);
  v_was numeric := case when p_change then coalesce(p_was, (p.accepted_snapshot ->> 'total')::numeric) end;
  v_currency text := (select c.currency from public.companies c where c.id = p.company_id);
  v_price text := private.money_short(v_offered, v_currency);
  v_agreed text := private.money_short((p.accepted_snapshot ->> 'total')::numeric, v_currency);
  v_mine text := '/field/jobs/' || p.id;
  v_job_page text := '/jobs/' || p.job_id;
  -- In the title too, as a text carries only the title.
  v_by text := case when p.respond_by is not null then 'Answer by ' || rtrim(private.local_time_words(p.company_id, p.respond_by), '.') || '.' end;
  v_data jsonb := jsonb_build_object('job_pay_id', p.id, 'subcontractor_id', p.subcontractor_id, 'sub_name', v_sub, 'total', v_offered,
    'change', p_change, 'round', p.offer_round) || case when p_change then jsonb_build_object('was', v_was) else '{}'::jsonb end;
begin
  if p_event = 'sent' then
    if p_change then
      perform private.tell_sub(p.company_id, p.subcontractor_id,
        concat_ws(' ', format('New price for %s: %s (was %s).', v_job, v_price, private.money_short(v_was, v_currency)), v_by, 'Open Crewtavo to accept or decline.'),
        'If you don''t accept it, the price you agreed stands.', v_mine);
      perform private.emit(p.company_id, 'sub_offer.sent', 'job', p.job_id, format('New price for %s sent to %s (%s, was %s)', v_job, v_sub, v_price, private.money_short(v_was, v_currency)),
        v_data || jsonb_build_object('insurance_warning', p.insurance_warning is not null));
    else
      perform private.tell_sub(p.company_id, p.subcontractor_id, concat_ws(' ', private.sub_offer_line(p.id) || '.', v_by, 'Open Crewtavo to accept or decline.'),
        'New job offer.', v_mine);
      perform private.emit(p.company_id, 'sub_offer.sent', 'job', p.job_id, format('%s offered to %s (%s)', v_job, v_sub, v_price),
        v_data || jsonb_build_object('insurance_warning', p.insurance_warning is not null));
    end if;
  elsif p_event = 'accepted' then
    perform private.emit(p.company_id, 'sub_offer.accepted', 'job', p.job_id,
      case when p_change then format('%s accepted the new price for %s (%s, was %s)', v_sub, v_job, v_price, private.money_short(v_was, v_currency)) else format('%s accepted %s (%s)', v_sub, v_job, v_price) end, v_data);
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('%s accepted the new price for %s', v_sub, v_job) else format('%s accepted %s', v_sub, v_job) end,
      case when p_change then format('Now %s.', v_price) else format('%s. They''re on its visits now.', v_price) end, v_job_page);
  elsif p_event = 'declined' then
    perform private.emit(p.company_id, 'sub_offer.declined', 'job', p.job_id,
      case when p_change then format('%s declined the new price for %s (%s)', v_sub, v_job, v_price) else format('%s declined %s (%s)', v_sub, v_job, v_price) end
        || coalesce(': ' || p.decline_reason, ''),
      v_data || jsonb_build_object('reason', p.decline_reason));
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('%s declined the new price for %s', v_sub, v_job) else format('%s declined %s', v_sub, v_job) end,
      concat_ws(' ', '“' || p.decline_reason || '”',
        case when p_change then format('The price they agreed (%s) stands.', v_agreed) else 'You can offer it to another sub from the job.' end), v_job_page);
  elsif p_event = 'expired' then
    perform private.emit(p.company_id, 'sub_offer.expired', 'job', p.job_id,
      case when p_change then format('The new price for %s (%s) ran out before %s answered', v_job, v_price, v_sub) else format('%s didn''t answer the offer for %s in time', v_sub, v_job) end,
      v_data);
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('The new price for %s ran out', v_job) else format('%s didn''t answer in time: %s', v_sub, v_job) end,
      case when p_change then format('%s didn''t answer. The price they agreed (%s) stands.', v_sub, v_agreed)
        else 'The offer ran out. You can offer it again, or to another sub, from the job.' end, v_job_page);
  elsif p_event = 'withdrawn' then
    perform private.tell_sub(p.company_id, p.subcontractor_id,
      case when p_change then format('The new price for %s was withdrawn', v_job) else format('The offer for %s was withdrawn', v_job) end,
      case when p_change then format('The price you agreed (%s) stands.', v_agreed) else 'You don''t need to do anything.' end, v_mine);
  elsif p_event = 'agreed' then
    -- The office agreed an offer for them (they said yes on the phone): it's theirs at that price.
    perform private.tell_sub(p.company_id, p.subcontractor_id,
      case when p_change then format('Your price for %s is now %s (was %s)', v_job, v_price, private.money_short(v_was, v_currency))
        else format('%s is yours at %s', v_job, v_price) end,
      case when p_change then 'The office agreed the new price with you.' else 'The office agreed it with you. It''s on My day.' end, v_mine);
  end if;
end $$;

-- As in 20261124100300_money_in_the_business_currency.sql, with the day a sub was paid in the
-- business's country's way.
create or replace function private.job_pay_sub_notices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_job text := (select j.title from public.jobs j where j.id = new.job_id);
  v_tz text := (select c.timezone from public.companies c where c.id = new.company_id);
  v_currency text := (select c.currency from public.companies c where c.id = new.company_id);
begin
  if new.status = 'done' and old.status = 'accepted' then
    perform private.tell_sub(new.company_id, new.subcontractor_id, format('Owed: %s for %s', private.money_short(new.total, v_currency), v_job),
      'The work''s done. We''ll let you know when it''s paid.', '/field/jobs/' || new.id, true);
  elsif new.status = 'paid' then
    perform private.tell_sub(new.company_id, new.subcontractor_id,
      format('Paid %s on %s', private.money_short(new.paid_amount, v_currency), private.date_text(new.paid_at at time zone coalesce(v_tz, 'UTC'), 'Mon FMDD', private.company_country(new.company_id))),
      v_job || case new.method
        when 'check' then ', by check.' when 'ach' then ', by bank transfer.' when 'cash' then ', in cash.'
        when 'card_or_app' then ', by card or payment app.' when 'payroll' then ', through payroll.' else '.' end,
      '/field/jobs/' || new.id, true);
  end if;
  return null;
end $$;

-- As in 20261113000320_company_twilio.sql, with the day a sub's paperwork ends in the business's
-- country's way.
create or replace function public.emit_sub_document_alerts(p_can_text boolean default false, p_can_email boolean default false)
returns table (company_id uuid, subcontractor_id uuid, document_id uuid, kind text, expires_on date, days_left integer, alert text, remind_sub boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r record;
  v_when text;
  v_title text;
  v_body text;
  v_ends text;
begin
  for r in
    select d.id, d.company_id, d.subcontractor_id, d.kind, d.expires_on, x.days_left, private.sub_alert_due(x.days_left) as due,
           s.name, w.waiting, c.country,
           (c.settings -> 'subs' -> 'remind_subs') is distinct from 'false'::jsonb and not w.waiting
             and ((s.email is not null and (coalesce(p_can_email, false)
                   or exists (select 1 from public.integrations i where i.company_id = d.company_id and i.provider = 'email' and i.status <> 'disconnected')))
               or (s.phone is not null and (coalesce(p_can_text, false)
                   or exists (select 1 from public.integrations i where i.company_id = d.company_id and i.provider = 'twilio' and i.status <> 'disconnected' and i.external_account_id is not null)))) as remind,
           (c.settings -> 'subs' -> 'remind_subs') is distinct from 'false'::jsonb and not w.waiting as remind_sign_in
    from public.sub_documents d
    join public.subcontractors s on s.id = d.subcontractor_id
    join public.companies c on c.id = d.company_id
    cross join lateral (select d.expires_on - private.company_today(d.company_id) as days_left) x
    -- Something newer they sent, waiting for the office to check it.
    cross join lateral (
      select exists (
        select 1 from public.sub_documents n
        where n.subcontractor_id = d.subcontractor_id and n.id <> d.id and n.superseded_at is null and n.verified_at is null
          and private.sub_document_group(n.kind) = private.sub_document_group(d.kind) and (n.expires_on is null or n.expires_on >= d.expires_on)
      ) as waiting
    ) w
    where d.kind in ('liability', 'workers_comp', 'wc_exemption') and d.superseded_at is null and d.expires_on is not null
      and s.active
      and d.expires_on <= current_date + 32 -- every time zone's today is within a day of the server's
      and extract(hour from now() at time zone c.timezone) >= 8 -- sent in the morning, not at midnight
      and private.sub_alert_rank(private.sub_alert_due(x.days_left)) > private.sub_alert_rank(d.alerted_state)
      -- Only the one that counts: checked first, then the one that runs longest, then the newest.
      and not exists (
        select 1 from public.sub_documents e
        where e.subcontractor_id = d.subcontractor_id and e.id <> d.id and e.superseded_at is null
          and private.sub_document_group(e.kind) = private.sub_document_group(d.kind)
          and ((e.verified_at is not null), coalesce(e.expires_on, 'infinity'::date), e.created_at, e.id)
            > ((d.verified_at is not null), coalesce(d.expires_on, 'infinity'::date), d.created_at, d.id)
      )
    for update of d skip locked
  loop
    v_when := case
      when r.days_left < 0 then 'has run out'
      when r.days_left = 0 then 'ends today'
      when r.days_left = 1 then 'ends tomorrow'
      else format('ends in %s days', r.days_left)
    end;
    v_ends := format('%s %s.', case when r.days_left < 0 then 'It ended' else 'It ends' end, private.date_text(r.expires_on, 'Mon FMDD, YYYY', r.country));
    v_title := format('%s''s %s %s', r.name, private.sub_document_words(r.kind), v_when);
    v_body := v_ends
      || case
        when r.waiting then ' They''ve sent a new one. Have a look and verify it.'
        when r.remind then ' We''re sending them a link to send in a new one.'
        else ''
      end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select r.company_id, o.user_id, 'subs', v_title, v_body, '/subs/' || r.subcontractor_id
    from private.subs_office(r.company_id) as o(user_id);
    if r.remind_sign_in then
      insert into public.notifications (company_id, user_id, kind, title, body, link)
      select r.company_id, m.user_id, 'subs', format('Your %s %s', private.sub_document_words(r.kind), v_when),
        v_ends || ' Send us the new one under My paperwork.', '/field/paperwork'
      from public.memberships m
      where m.company_id = r.company_id and m.subcontractor_id = r.subcontractor_id and m.active;
    end if;
    update public.sub_documents set alerted_state = r.due where id = r.id;

    company_id := r.company_id;
    subcontractor_id := r.subcontractor_id;
    document_id := r.id;
    kind := r.kind;
    expires_on := r.expires_on;
    days_left := r.days_left;
    alert := r.due;
    remind_sub := r.remind;
    return next;
  end loop;
end $$;

-- As in 20261017002200_notification_delivery.sql, for a business in `p_country`: the day, then the
-- time as the country keeps it. The release before this one calls the one without a country, which
-- stays.
create function private.visit_when(p_starts timestamptz, p_day date, p_tz text, p_country text) returns text
language sql stable set search_path = '' as $$
  select case
    when p_starts is not null then (private.date_text(p_starts at time zone coalesce(p_tz, 'UTC'), 'Dy Mon FMDD', p_country) || ', ' || private.date_text(p_starts at time zone coalesce(p_tz, 'UTC'), 'FMHH12:MI AM', p_country))
    when p_day is not null then private.date_text(p_day, 'Dy Mon FMDD', p_country)
    else 'no date yet'
  end
$$;

-- As in 20261113000210_visit_people.sql, with the visit's day and time in the business's country's
-- way (private.visit_when).
create or replace function private.visit_change_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_country text; v_line text; r record;
begin
  if private.schedule_quiet() then return null; end if;
  select timezone, country into v_tz, v_country from public.companies where id = new.company_id;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if not private.visit_is_upcoming(old, v_tz) then return null; end if;
    v_line := format('%s on %s was cancelled', new.title, private.visit_when(old.starts_at, old.scheduled_on, v_tz, v_country));
  elsif (new.starts_at is distinct from old.starts_at or new.scheduled_on is distinct from old.scheduled_on)
        and (private.visit_is_upcoming(new, v_tz) or private.visit_is_upcoming(old, v_tz)) and new.status <> 'cancelled' then
    v_line := case
      when new.status = 'unscheduled' or (new.starts_at is null and new.scheduled_on is null)
        then format('%s is off the schedule for now (was %s)', new.title, private.visit_when(old.starts_at, old.scheduled_on, v_tz, v_country))
      when coalesce(new.scheduled_on, '-infinity') = coalesce(old.scheduled_on, '-infinity')
        then format('%s now starts %s', new.title, private.visit_when(new.starts_at, new.scheduled_on, v_tz, v_country))
      else format('%s moved to %s (was %s)', new.title, private.visit_when(new.starts_at, new.scheduled_on, v_tz, v_country), private.visit_when(old.starts_at, old.scheduled_on, v_tz, v_country))
    end;
  else
    return null;
  end if;
  for r in
    select p.user_id from private.visit_people(new.id) as p(user_id)
    where new.crew_id is not distinct from old.crew_id
       or not exists (select 1 from public.crew_members m where m.crew_id = new.crew_id and m.user_id = p.user_id)
       or exists (select 1 from public.crew_members m where m.crew_id = old.crew_id and m.user_id = p.user_id)
  loop
    perform private.notify_schedule(new.company_id, r.user_id, new.id, v_line);
  end loop;
  return null;
end $$;

-- As in 20261113000210_visit_people.sql, with the visit's day and time in the business's country's
-- way (private.visit_when).
create or replace function private.visit_delete_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_country text; r record;
begin
  if private.schedule_quiet() then return old; end if;
  select timezone, country into v_tz, v_country from public.companies where id = old.company_id;
  if not found or not private.visit_is_upcoming(old, v_tz) then
    return old; -- the company is being deleted, or it's old work
  end if;
  -- No link to the visit: it's about to be gone.
  for r in select p.user_id from private.visit_people(old.id) as p(user_id) loop
    perform private.notify_schedule(old.company_id, r.user_id, null,
      format('%s on %s was cancelled', old.title, private.visit_when(old.starts_at, old.scheduled_on, v_tz, v_country)));
  end loop;
  return old;
end $$;

-- As in 20261106000420_change_requests_tell_leads.sql, with the visit's day and time in the
-- business's country's way (private.visit_when), and one full stop after a time that ends in one
-- (5:00 p.m.).
create or replace function private.visit_change_requested() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v public.visits;
  v_tz text;
  v_country text;
  v_title text;
  v_body text;
begin
  select * into v from public.visits where id = new.visit_id;
  select timezone, country into v_tz, v_country from public.companies where id = new.company_id;
  v_title := format('%s asked to %s %s', private.client_name(new.client_id), case new.kind when 'cancel' then 'cancel' else 'move' end, v.title);
  v_body := 'Booked ' || rtrim(private.visit_when(v.starts_at, v.scheduled_on, v_tz, v_country), '.') || '. ' || case
    when new.kind = 'cancel' then coalesce('Reason: ' || new.reason, 'No reason given.')
    when new.scheduled_on is not null then 'Asked for ' || rtrim(private.visit_when(new.starts_at, new.scheduled_on, v_tz, v_country), '.') || '.'
    else '"' || left(new.message, 200) || '"'
  end;
  perform private.emit(new.company_id, 'visit.' || new.kind || '_requested', 'visit', new.visit_id, v_title, jsonb_build_object('request_id', new.id));
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, u, 'client', left(v_title, 300), v_body, '/schedule?date=' || coalesce(v.scheduled_on::text, '') || '&visit=' || v.id
  from (select o from private.schedule_office(new.company_id) o union select l from private.visit_crew_lead(new.company_id, new.visit_id) l) told(u);
  return null;
end $$;

-- As in 20261113000210_visit_people.sql, with the visit's day and time in the business's country's
-- way (private.visit_when).
create or replace function private.assignees_added_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; v public.visits; v_tz text; v_country text; v_crew uuid[]; u uuid;
begin
  if private.schedule_quiet() then return null; end if;
  for r in select n.visit_id, array_agg(n.user_id) as users from added n group by n.visit_id loop
    select * into v from public.visits where id = r.visit_id;
    continue when not found;
    select timezone, country into v_tz, v_country from public.companies where id = v.company_id;
    continue when not private.visit_is_upcoming(v, v_tz);
    -- Nobody was listed before these: the crew was on it.
    v_crew := '{}';
    if v.crew_id is not null and not exists (select 1 from public.visit_assignees a where a.visit_id = v.id and a.user_id <> all (r.users)) then
      v_crew := array(select m.user_id from public.crew_members m where m.crew_id = v.crew_id);
    end if;
    foreach u in array r.users loop
      if u <> all (v_crew) then
        perform private.notify_on_visit(v, u, true, private.visit_when(v.starts_at, v.scheduled_on, v_tz, v_country));
      end if;
    end loop;
    foreach u in array v_crew loop
      if u <> all (r.users) then
        perform private.notify_on_visit(v, u, false, private.visit_when(v.starts_at, v.scheduled_on, v_tz, v_country));
      end if;
    end loop;
  end loop;
  return null;
end $$;

-- As in 20261113000210_visit_people.sql, with the visit's day and time in the business's country's
-- way (private.visit_when).
create or replace function private.assignees_removed_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; v public.visits; v_tz text; v_country text; v_crew uuid[]; u uuid;
begin
  if private.schedule_quiet() then return null; end if;
  for r in select o.visit_id, array_agg(o.user_id) as users from removed o group by o.visit_id loop
    select * into v from public.visits where id = r.visit_id;
    continue when not found; -- the visit itself was deleted; visit_delete_notify told everyone
    select timezone, country into v_tz, v_country from public.companies where id = v.company_id;
    continue when not private.visit_is_upcoming(v, v_tz);
    -- Nobody is listed now: the crew is on it.
    v_crew := '{}';
    if v.crew_id is not null and not exists (select 1 from public.visit_assignees a where a.visit_id = v.id) then
      v_crew := array(select m.user_id from public.crew_members m where m.crew_id = v.crew_id);
    end if;
    foreach u in array r.users loop
      if u <> all (v_crew) then
        perform private.notify_on_visit(v, u, false, private.visit_when(v.starts_at, v.scheduled_on, v_tz, v_country));
      end if;
    end loop;
    foreach u in array v_crew loop
      if u <> all (r.users) then
        perform private.notify_on_visit(v, u, true, private.visit_when(v.starts_at, v.scheduled_on, v_tz, v_country));
      end if;
    end loop;
  end loop;
  return null;
end $$;

-- As in 20261113000210_visit_people.sql, with the visit's day and time in the business's country's
-- way (private.visit_when).
create or replace function private.visit_crew_people() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_country text; r record;
begin
  if exists (select 1 from public.visit_assignees a where a.visit_id = new.id) then
    if old.crew_id is not null and exists (
      select 1 from public.visit_assignees a join public.crew_members m on m.user_id = a.user_id and m.crew_id = old.crew_id
      where a.visit_id = new.id
    ) then
      -- The new crew's first, so the list is never empty in between (which would read as "the crew").
      insert into public.visit_assignees (company_id, visit_id, user_id)
      select new.company_id, new.id, m.user_id from public.crew_members m where m.crew_id = new.crew_id
      on conflict do nothing;
      delete from public.visit_assignees a
      where a.visit_id = new.id
        and exists (select 1 from public.crew_members m where m.crew_id = old.crew_id and m.user_id = a.user_id)
        and not exists (select 1 from public.crew_members m where m.crew_id = new.crew_id and m.user_id = a.user_id);
    end if;
    return null;
  end if;
  if private.schedule_quiet() then return null; end if;
  select timezone, country into v_tz, v_country from public.companies where id = new.company_id;
  if not private.visit_is_upcoming(new, v_tz) then return null; end if;
  for r in
    select m.user_id from public.crew_members m where m.crew_id = old.crew_id
      and not exists (select 1 from public.crew_members n where n.crew_id = new.crew_id and n.user_id = m.user_id)
  loop
    perform private.notify_on_visit(new, r.user_id, false, private.visit_when(old.starts_at, old.scheduled_on, v_tz, v_country));
  end loop;
  for r in
    select m.user_id from public.crew_members m where m.crew_id = new.crew_id
      and not exists (select 1 from public.crew_members o where o.crew_id = old.crew_id and o.user_id = m.user_id)
  loop
    perform private.notify_on_visit(new, r.user_id, true, private.visit_when(new.starts_at, new.scheduled_on, v_tz, v_country));
  end loop;
  return null;
end $$;

-- As in 20261113000210_visit_people.sql, with the visit's day and time in the business's country's
-- way (private.visit_when).
create or replace function private.visit_crew_told() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_country text; r record;
begin
  if private.schedule_quiet() then return null; end if;
  select timezone, country into v_tz, v_country from public.companies where id = new.company_id;
  if not private.visit_is_upcoming(new, v_tz) then return null; end if;
  for r in select m.user_id from public.crew_members m where m.crew_id = new.crew_id loop
    perform private.notify_on_visit(new, r.user_id, true, private.visit_when(new.starts_at, new.scheduled_on, v_tz, v_country));
  end loop;
  return null;
end $$;

-- As in 20261113000610_whole_day_clock.sql, with the clock's times in the business's country's way.
create or replace function public.clock_upkeep() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_reminded integer := 0; v_stopped integer := 0; v_end timestamptz; v_local text; v_since timestamptz;
begin
  for r in
    select te.id, te.company_id, te.user_id, te.started_at, c.timezone, c.country,
           coalesce(private.clock_hours(c.settings -> 'clock' ->> 'remind_after_hours'), 10) as remind_after,
           coalesce(private.clock_hours(c.settings -> 'clock' ->> 'stop_after_hours'), 16) as stop_after,
           -- The end of the working day, or 18:00 when it isn't a time.
           coalesce(case when pg_catalog.pg_input_is_valid(c.settings -> 'working_hours' ->> 'end', 'time')
                         then (c.settings -> 'working_hours' ->> 'end')::time end, '18:00') as day_end,
           coalesce(c.settings -> 'clock' ->> 'mode' = 'day', false) as whole_day
    from public.time_entries te
    join public.companies c on c.id = te.company_id
    -- On the whole-day clock the entry running now may be minutes old on a day that's hours long.
    where te.ended_at is null and (te.started_at < now() - interval '1 hour' or coalesce(c.settings -> 'clock' ->> 'mode' = 'day', false))
    for update of te skip locked
  loop
    -- How long they've been on the clock: this entry, or on the whole-day clock the run it ends.
    v_since := case when r.whole_day then coalesce(private.clock_run_start(r.id), r.started_at) else r.started_at end;
    continue when v_since >= now() - interval '1 hour';
    v_local := private.date_text(v_since at time zone coalesce(r.timezone, 'UTC'), 'FMHH12:MI AM', r.country);
    if v_since < now() - make_interval(secs => (r.stop_after * 3600)::int) then
      -- Stop it at the end of the working day it started on (or 8 hours in, if it started after that).
      v_end := ((r.started_at at time zone coalesce(r.timezone, 'UTC'))::date + r.day_end::time) at time zone coalesce(r.timezone, 'UTC');
      if v_end <= r.started_at then
        v_end := r.started_at + interval '8 hours';
      end if;
      if r.whole_day then
        -- The entry running now began well after the day did: never stopped later than now, nor before it began.
        v_end := greatest(least(v_end, now()), r.started_at + interval '1 second');
      end if;
      update public.time_entries set ended_at = v_end, auto_stopped_at = now() where id = r.id;
      insert into public.notifications (company_id, user_id, kind, title, body, link)
      values (r.company_id, r.user_id, 'time', 'Your clock was stopped for you',
              format(case when r.whole_day then 'It had been running since %s, so it was stopped at %s. Fix the end time on Timesheets if that''s wrong.'
                          else 'It started at %s and was still running, so it was stopped at %s. Fix the end time on Timesheets if that''s wrong.' end,
                     v_local, (private.date_text(v_end at time zone coalesce(r.timezone, 'UTC'), 'FMHH12:MI AM', r.country) || ' ' || private.date_text(v_end at time zone coalesce(r.timezone, 'UTC'), 'Dy', r.country))),
              '/timesheets');
      v_stopped := v_stopped + 1;
    elsif v_since < now() - make_interval(secs => (r.remind_after * 3600)::int)
          -- Once for the entry, and on the whole-day clock once for the run.
          and not exists (select 1 from public.time_entries t2 where t2.company_id = r.company_id and t2.user_id = r.user_id and t2.reminded_at is not null
                          and (t2.id = r.id or (r.whole_day and t2.started_at >= v_since and t2.started_at <= r.started_at))) then
      update public.time_entries set reminded_at = now() where id = r.id;
      insert into public.notifications (company_id, user_id, kind, title, body, link)
      select r.company_id, who.user_id, 'time',
             case when who.user_id = r.user_id then 'Your clock is still running' else format('%s''s clock is still running', coalesce(nullif(p.full_name, ''), 'A crew member')) end,
             format(case when r.whole_day then 'On the clock since %s, %s hours ago. Stop it if the day is done.' else 'Started at %s, %s hours ago. Stop it if the day is done.' end,
                    v_local, floor(extract(epoch from now() - v_since) / 3600)),
             case when who.user_id = r.user_id then '/field' else '/timesheets' end
      from (
        select r.user_id
        union
        -- Their crew lead, who can stop it for them.
        select c.lead_user_id from public.crews c
        join public.crew_members cm on cm.crew_id = c.id
        where cm.user_id = r.user_id and c.company_id = r.company_id and c.active and c.lead_user_id is not null and c.lead_user_id <> r.user_id
      ) who
      left join public.profiles p on p.user_id = r.user_id;
      v_reminded := v_reminded + 1;
    end if;
  end loop;
  return jsonb_build_object('reminded', v_reminded, 'stopped', v_stopped);
end $$;

-- As in 20261113001800_time_entry_changes.sql, with the times and the day in the business's
-- country's way, and one full stop after a time that ends in one (5:00 p.m.).
create or replace function private.time_entry_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.time_entries := coalesce(new, old);
  v_by uuid := (select auth.uid());
  v_reasons jsonb := coalesce(nullif(current_setting('crewtavo.time_change_reasons', true), ''), '{}')::jsonb;
  v_given boolean;
  v_reason text;
  v_stack text;
  v_source text;
  v_edit boolean;
  v_tz text;
  v_country text;
  v_body text;
begin
  -- Why, if this write said: once, for this entry.
  v_given := v_reasons ? v_row.id::text;
  if v_given then
    v_reason := nullif(v_reasons ->> v_row.id::text, '');
    perform set_config('crewtavo.time_change_reasons', (v_reasons - v_row.id::text)::text, true);
  end if;

  if tg_op = 'INSERT' then
    -- Their own clock-in, or time they added for themselves: the entry is the record.
    if v_by is not null and v_by = new.user_id then
      return null;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.started_at is not distinct from old.started_at and new.ended_at is not distinct from old.ended_at
       and new.category is not distinct from old.category and new.visit_id is not distinct from old.visit_id
       and new.job_id is not distinct from old.job_id and new.notes is not distinct from old.notes then
      return null;
    end if;
  elsif not exists (select 1 from public.companies c where c.id = old.company_id) then
    -- The whole company is being deleted, and its records with it.
    return null;
  end if;

  -- What did it. The database's own writers are known by being on the way here.
  get diagnostics v_stack = pg_context;
  v_source := case
    when v_stack ~ '\mfinished_visit_clock\M' then 'finished_visit'
    when v_stack ~ '\m(clock_upkeep|stop_doubled_clocks)\M' then 'auto_stop'
    when v_stack ~ '\mone_running_clock\M' then 'next_clock'
    when v_stack ~ '\m(end_sub_clocks|sub_clock_off_visit)\M' then 'sub_off_clock'
    when tg_op = 'UPDATE' and new.geofence_out and not old.geofence_out then 'geofence'
    when tg_op = 'INSERT' and new.geofence_in then 'geofence'
    -- Its visit or job was deleted, and came off the entry with it (the foreign keys' set null).
    when tg_op = 'UPDATE' and ((old.visit_id is not null and new.visit_id is null and not exists (select 1 from public.visits v where v.id = old.visit_id))
                               or (old.job_id is not null and new.job_id is null and not exists (select 1 from public.jobs j where j.id = old.job_id))) then 'system'
    when private.assistant_client() is not null then 'assistant'
    when v_by is null or pg_trigger_depth() > 1 then 'system'
    else 'person'
  end;

  -- The clock running its course: a running clock stopped or moved, its start as it was, by a tap
  -- or by the database. Anything Timesheets sends as an edit (a reason, even an empty one) is one.
  v_edit := not (tg_op = 'UPDATE' and not v_given and old.ended_at is null and new.started_at is not distinct from old.started_at);

  insert into public.time_entry_changes (company_id, entry_id, user_id, action, changed_by, source, reason,
    old_started_at, new_started_at, old_ended_at, new_ended_at, old_category, new_category,
    old_visit_id, new_visit_id, old_job_id, new_job_id, old_notes, new_notes, edit, entry_started_at)
  values (v_row.company_id, v_row.id, v_row.user_id,
    case tg_op when 'INSERT' then 'added' when 'UPDATE' then 'changed' else 'deleted' end, v_by, v_source, v_reason,
    old.started_at, new.started_at, old.ended_at, new.ended_at, old.category, new.category,
    old.visit_id, new.visit_id, old.job_id, new.job_id, old.notes, new.notes, v_edit, v_row.started_at);

  -- Told on the bell when someone else edits their time (its times or its type) or deletes it. A
  -- tap that stops their running clock (the crew clock, the office stopping it for them) is
  -- recorded above and not announced, and neither is a change to the note, visit or job alone.
  if v_by is not null and v_by <> v_row.user_id and v_source in ('person', 'assistant')
     and (tg_op = 'DELETE'
          or (tg_op = 'UPDATE' and v_edit and (v_given
                or new.started_at is distinct from old.started_at or new.ended_at is distinct from old.ended_at
                or new.category is distinct from old.category)))
     and exists (select 1 from public.memberships m where m.company_id = v_row.company_id and m.user_id = v_row.user_id and m.active) then
    select coalesce(c.timezone, 'UTC'), c.country into v_tz, v_country from public.companies c where c.id = v_row.company_id;
    v_body := case
      when old.ended_at is null then format('It was running since %s.', rtrim(private.date_text(old.started_at at time zone v_tz, 'FMHH12:MI AM', v_country), '.'))
      else format('It was %s to %s.', private.date_text(old.started_at at time zone v_tz, 'FMHH12:MI AM', v_country), rtrim(private.date_text(old.ended_at at time zone v_tz, 'FMHH12:MI AM', v_country), '.'))
    end;
    if tg_op = 'UPDATE' then
      v_body := v_body || E'\n' || case
        when new.ended_at is null then format('It''s now running since %s.', rtrim(private.date_text(new.started_at at time zone v_tz, 'FMHH12:MI AM', v_country), '.'))
        else format('It''s now %s to %s.', private.date_text(new.started_at at time zone v_tz, 'FMHH12:MI AM', v_country), rtrim(private.date_text(new.ended_at at time zone v_tz, 'FMHH12:MI AM', v_country), '.'))
      end;
      if new.category is distinct from old.category then
        v_body := v_body || E'\n' || format('It''s now marked as %s.', case new.category
          when 'visit' then 'a visit' when 'assessment' then 'an assessment' when 'drive' then 'driving'
          when 'shop' then 'shop time' when 'break' then 'a break' else 'other work' end);
      end if;
    end if;
    if v_reason is not null then
      -- One line, whatever they typed: the bell reads a body line by line.
      v_body := v_body || E'\n' || format('Why: %s', regexp_replace(v_reason, '\s+', ' ', 'g'));
    end if;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    values (v_row.company_id, v_row.user_id, 'time',
      left(format(case when tg_op = 'DELETE' then '%s deleted your time on %s' else '%s changed your time on %s' end,
        coalesce(nullif((select p.full_name from public.profiles p where p.user_id = v_by), ''), 'Someone'),
        private.date_text(old.started_at at time zone v_tz, 'Dy Mon FMDD', v_country)), 300),
      v_body, '/timesheets');
  end if;
  return null;
end $$;

-- As in 20261116000200_snow_auto_schedule.sql, with the time to clear a site by in the business's
-- country's way.
create or replace function private.snow_schedule_visits(p_company uuid, p_date date, p_plan jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  p record; s public.snow_sites; j public.jobs;
  v_has integer; v_pushes integer; v_visit uuid; v_made integer := 0; v_first boolean;
begin
  if p_date is null or p_date < private.company_today(p_company) then
    raise exception 'Pick today or a later day.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_plan) is distinct from 'array' or jsonb_array_length(p_plan) > 1000 then
    raise exception 'Say which snow customers to schedule.' using errcode = '22023';
  end if;
  for p in
    select (x ->> 'job_id')::uuid as job_id, (x ->> 'inches')::numeric as inches,
           least(12, greatest(1, coalesce((x ->> 'pushes')::integer, 1))) as pushes,
           case when x ->> 'kind' = 'salt' then 'salt' else 'plow' end as kind
      from jsonb_array_elements(p_plan) x
  loop
    select * into s from public.snow_sites where job_id = p.job_id and company_id = p_company;
    continue when not found;
    select * into j from public.jobs where id = p.job_id and company_id = p_company and status = 'active';
    continue when not found;
    v_first := not exists (select 1 from public.snow_visits where job_id = p.job_id and snow_date = p_date);
    insert into public.snow_events (company_id, job_id, snow_date, kind, forecast_in, pushes)
    values (p_company, p.job_id, p_date, p.kind, p.inches, p.pushes)
    on conflict (job_id, snow_date) do update
      set forecast_in = coalesce(excluded.forecast_in, public.snow_events.forecast_in),
          pushes = greatest(public.snow_events.pushes, excluded.pushes),
          kind = case when excluded.kind = 'plow' then 'plow' else public.snow_events.kind end
    returning pushes into v_pushes;
    -- What it has that day already: the storm's own visits, or one somebody made by hand.
    select greatest(
        (select count(*) from public.snow_visits sv join public.visits v on v.id = sv.visit_id
          where sv.job_id = p.job_id and sv.snow_date = p_date and v.status <> 'cancelled'),
        (select least(1, count(*)) from public.visits v where v.job_id = p.job_id and v.scheduled_on = p_date and v.status <> 'cancelled'))
      into v_has;
    for n in v_has + 1 .. v_pushes loop
      insert into public.visits (company_id, job_id, property_id, title, scheduled_on, crew_id, notes)
      values (p_company, j.id, j.property_id,
              left(case p.kind when 'salt' then 'Salt: ' else '' end || j.title || case when v_pushes > 1 then format(' (push %s of %s)', n, v_pushes) else '' end, 200),
              p_date, j.default_crew_id,
              nullif(concat_ws(E'\n',
                case when s.clear_by is not null then 'Clear by ' || trim(private.date_text(s.clear_by, 'FMHH12:MI AM', private.company_country(p_company))) end,
                case s.priority when 1 then 'First priority' when 3 then 'After the others' end), ''))
      returning id into v_visit;
      insert into public.snow_visits (company_id, visit_id, job_id, snow_date) values (p_company, v_visit, j.id, p_date);
      insert into public.visit_assignees (company_id, visit_id, user_id)
      select p_company, v_visit, r.user_id from public.snow_recipients(array[j.id]) r where not r.office;
      if v_first and s.tell_client and n = v_has + 1 then
        perform private.emit(p_company, 'snow.scheduled', 'visit', v_visit, 'Snow service scheduled: ' || j.title,
          jsonb_build_object('client_id', j.client_id, 'kind', p.kind));
      end if;
      v_made := v_made + 1;
    end loop;
    perform private.snow_price(p.job_id, p_date);
  end loop;
  return v_made;
end $$;
