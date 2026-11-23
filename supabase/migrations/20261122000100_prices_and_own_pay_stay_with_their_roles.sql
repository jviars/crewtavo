-- Gaps a role audit found (2026-11-22), each closed the way the rest of the schema already does it.

-- 1. What a visit bills (visits.price, price_note, the Snow app's) is the office's. Crews, crew leads
-- and subs read their visits, and could read those two columns with them. Now nobody reads them
-- directly, as with pay rates (20261018000700_time_entry_pay_privacy.sql): the server and the
-- database's own functions read them, and the office still sets them (visit_price_guard).
revoke select on public.visits from anon, authenticated;
-- Every other column stays readable (a column added later needs its own grant).
grant select (id, company_id, job_id, request_id, property_id, kind, title, scheduled_on, starts_at, ends_at, status, crew_id,
              route_order, recurrence_key, hold_reason, notes, completed_at, completed_by, created_at, updated_at, invoice_id,
              series_id, series_day, series_total, time_fixed, eta_at, address)
  on public.visits to authenticated;

-- Invoicing a job visit by visit (create_invoice_for_job, which runs as the person) still bills a
-- priced visit at its price: it reads it here, for the office with Invoices and payments.
create function private.visit_billed(p_visit uuid) returns table (price numeric, price_note text)
language sql stable security definer set search_path = '' as $$
  select v.price, v.price_note from public.visits v
   where v.id = p_visit and private.has_role(v.company_id, '{owner,admin,office}') and private.has_perm(v.company_id, 'invoices')
$$;
revoke all on function private.visit_billed(uuid) from public;
grant execute on function private.visit_billed(uuid) to authenticated;

-- create_invoice_for_job as it stood (20261115000100_priced_visits_with_the_newer_invoices.sql), reading a visit's price as above.
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

  -- A schedule's payment is part of the quote's total, tax and all, so it's held to what the job
  -- comes to with its tax (v_full); any other deposit or progress invoice to the contract before it.
  if v_inst is not null then
    select coalesce(v_contract, 0) + round(greatest(coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable), 0), 0) * v_tax, 2)
      into v_full
    from public.job_line_items where job_id = j.id;
  end if;
  if p_kind in ('deposit', 'progress') and j.kind <> 'recurring' and v_prebilled + v_amount > coalesce(v_full, v_contract, 0) + 0.005 then
    raise exception 'That''s more than what''s left to bill on this job (%)',
      to_char(greatest(coalesce(v_full, v_contract, 0) - v_prebilled, 0), 'FM$999,999,990.00') using errcode = '22023';
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
            case when v_full > 0 then 'Part of the ' || to_char(v_full, 'FM$999,999,990.00') || ' total' || case when v_full > coalesce(v_contract, 0) then ', tax included' else '' end end,
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
              case when v_contract > 0 then round(v_amount / v_contract * 100, 1) || '% of the ' || to_char(v_contract, 'FM$999,999,990.00') || ' contract' end,
              1, 'ea', v_amount, v_taxed > 0, 0);
    else
      -- A line is taxed or it isn't, so a partly taxed amount is two lines.
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice, 'Progress billing: ' || j.title,
             p.part || case when v_contract > 0 then ' of ' || round(v_amount / v_contract * 100, 1) || '% of the ' || to_char(v_contract, 'FM$999,999,990.00') || ' contract' else '' end,
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
               'Visit on ' || to_char(r.day, 'Mon DD, YYYY') || coalesce(': ' || r.price_note, ''), 1, 'ea', r.price, coalesce(li.taxable, true), v_sort
        from (select 1) one
        left join lateral (select l.service_id, l.name, l.taxable from public.job_line_items l where l.job_id = j.id order by l.sort, l.id limit 1) li on true;
      else
        insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
        select j.company_id, v_invoice, li.service_id, li.name, 'Visit on ' || to_char(r.day, 'Mon DD, YYYY'), li.quantity, li.unit, li.unit_price, li.taxable, v_sort + li.sort, li.discount_key
        from public.job_line_items li where li.job_id = j.id and li.discount_billing is distinct from 'once';
      end if;
      update public.visits set invoice_id = v_invoice where id = r.id;
      -- Extra work on this visit alone: on its invoice once, after the visit's own lines.
      insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice, e.service_id, e.name,
             concat_ws(E'\n', 'Extra work, visit on ' || to_char(r.day, 'Mon DD, YYYY'), nullif(btrim(e.description), '')),
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
             concat_ws(E'\n', 'Extra work, visit on ' || to_char(b.day, 'Mon DD, YYYY'), nullif(btrim(b.description), '')),
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

-- 2. A job's prices, its extra work's and the paving worksheets take Quotes and sales, as quotes do
-- (quotes_area_*): an office role with Sales switched off could rewrite the lines invoices bill.
-- A trigger, not a policy, so only the price columns are held: invoicing still marks extra work
-- billed (create_invoice_for_job runs as the person), and a promo code still sets how a discount
-- bills. Only a person's own writes are checked (the browser, or a function that runs as them);
-- the database's own functions, like the crew's Add work (add_field_line), run as their owner.
-- Below the levels that write these tables, the tables' own policies refuse first, as before.
create function private.prices_need_sales() returns trigger
language plpgsql set search_path = '' as $$
declare v_company uuid := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
begin
  if current_user = 'authenticated' and v_company = any (private.role_companies('{owner,admin,office,estimator}'))
     and not (v_company = any (private.perm_companies('sales'))) then
    raise exception 'Changing prices takes the Quotes and sales area. Ask an admin if you need it.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger prices_need_sales before insert or delete or update of service_id, quantity, unit, unit_price, unit_cost, unit_labor_cost, taxable, parts
  on public.job_line_items for each row execute function private.prices_need_sales();
create trigger prices_need_sales before insert or delete or update of service_id, quantity, unit, unit_price, unit_cost, unit_labor_cost, taxable
  on public.visit_extras for each row execute function private.prices_need_sales();
create trigger prices_need_sales before insert or delete or update
  on public.paving_worksheets for each row execute function private.prices_need_sales();

-- 3. Nobody but an owner sets their own pay: not their member rate, not a pay rate, not a job's pay.
create or replace function private.membership_self_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and old.user_id = (select auth.uid())
     and not private.has_role(old.company_id, '{owner}')
     and (new.role is distinct from old.role or new.role_id is distinct from old.role_id or new.active is distinct from old.active
          or new.user_id is distinct from old.user_id or new.company_id is distinct from old.company_id
          or new.subcontractor_id is distinct from old.subcontractor_id or new.labor_rate is distinct from old.labor_rate) then
    raise exception 'Ask an owner to change your own role, access or pay' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function private.handles_pay(p_company uuid, p_subcontractor uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_company, '{owner,admin,office}')
    and ((p_subcontractor is not null and p_user is null and private.has_perm(p_company, 'subs'))
      or (p_user is not null and p_subcontractor is null and private.has_perm(p_company, 'job_costs')
          and (p_user is distinct from (select auth.uid()) or private.has_role(p_company, '{owner}'))))
$$;

create or replace function private.pay_rate_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.company_id <> old.company_id or new.subcontractor_id is distinct from old.subcontractor_id
     or new.user_id is distinct from old.user_id) then
    raise exception 'A rate stays with whoever it''s for. Add a new one instead.' using errcode = '22023';
  end if;
  if new.user_id is not null and new.user_id = (select auth.uid()) and not private.has_role(new.company_id, '{owner}') then
    raise exception 'Ask an owner to set your own pay' using errcode = '42501';
  end if;
  if new.user_id is not null and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) and not private.on_team(new.company_id, new.user_id) then
    raise exception 'Pay rates are for subs and people on your team.' using errcode = '22023';
  end if;
  if new.basis = 'per_unit' then
    select s.unit into new.unit from public.services s where s.company_id = new.company_id and s.id = new.service_id;
  else
    new.service_id := null;
    new.unit := case new.basis when 'per_day' then 'day' else 'job' end;
    new.squares_basis := 'job';
  end if;
  if new.squares_basis = 'roof_no_waste' and not private.is_square_unit(new.unit) then
    raise exception 'Roof squares without waste is only for a rate per square.' using errcode = '22023';
  end if;
  return new;
end $$;

-- 4. Marking a photo postable takes being able to see it (attachments_read): a field crew member
-- could mark any photo in the business by its id, ones on jobs they don't work included.
create or replace function public.set_photo_shareable(p_attachment uuid, p_shareable boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.attachments;
  v_problem text;
begin
  select * into a from public.attachments where id = p_attachment for update;
  if not found or not (
    private.has_role(a.company_id, '{owner,admin,office,estimator,crew_lead}')
    or (private.has_role(a.company_id, '{field_crew}') and (
      a.created_by = (select auth.uid())
      or (a.owner_type = 'visit' and a.owner_id in (select private.my_assigned_visits()))
      or (a.owner_type = 'job' and a.owner_id in (select private.crew_jobs()))
      or (a.owner_type = 'quote' and a.owner_id in (select private.crew_quotes()))
      or (a.owner_type = 'property' and a.owner_id in (select private.crew_properties()))
      or (a.owner_type = 'request' and a.owner_id in (select private.crew_requests()))
      or (a.owner_type = 'client' and a.owner_id in (select private.crew_clients()))))) then
    raise exception 'You can''t change this photo' using errcode = '42501';
  end if;
  if p_shareable then
    v_problem := private.photo_share_problem(a.company_id, a.owner_type, a.owner_id, a.content_type);
    if v_problem = 'format' then
      raise exception 'Only JPEG and PNG photos can be posted. Save this one as a JPEG and add it again.' using errcode = '22023';
    elsif v_problem = 'no_client' then
      raise exception 'This photo isn''t on a job, visit or client anymore, so it can''t be posted.' using errcode = '22023';
    elsif v_problem = 'client_opt_out' then
      raise exception 'This client asked us not to post photos of their property.' using errcode = '22023';
    end if;
  end if;
  perform set_config('crewtavo.share', 'on', true);
  update public.attachments
     set shareable = p_shareable,
         shareable_by = case when not p_shareable then null when a.shareable then a.shareable_by else (select auth.uid()) end,
         shareable_at = case when not p_shareable then null when a.shareable then a.shareable_at else now() end
   where id = p_attachment
  returning * into a;
  perform set_config('crewtavo.share', '', true);
  return jsonb_build_object('shareable', a.shareable, 'shareable_at', a.shareable_at, 'shareable_by', a.shareable_by);
end $$;
