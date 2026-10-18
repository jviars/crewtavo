-- Tax rates were numeric(6, 4): a fraction kept to four decimals. So New York City's 8.875% was
-- stored as 0.0888 and charged as 8.88%, and other rates with a third decimal (7.375%, 9.125%)
-- were rounded the same way. Rates now keep six decimals, steps of 0.0001%.
--
-- The rate is stored on quotes (change orders are quotes) and invoices; jobs take theirs from the
-- quote, and the company's default (settings ->> 'default_tax_rate') is JSON, which keeps what it
-- was given. Nothing else depends on these columns (no view, rule, policy or index), and the
-- functions that read them use plain numeric, so widening them is all it takes. Every stored rate
-- keeps its value (0.0825 stays 0.0825), and no total changes: the triggers that work totals out
-- don't run for a change of type. A rate that was already rounded (0.0888) stays as it was saved.
-- supabase/tests/tax_rate_precision_test.sql covers it.

-- Widening a column rewrites its table. Both are locked first, in the order the dashboard reads
-- them (invoices, then quotes), so a dashboard load that starts meanwhile waits for this instead of
-- holding one table while this holds the other.
do $$ begin lock table public.invoices, public.quotes in access exclusive mode; end $$;
alter table public.quotes alter column tax_rate type numeric(8, 6);
alter table public.invoices alter column tax_rate type numeric(8, 6);

-- As in 20261018000100_audit_fixes.sql, except that a job without a quote is taxed at the
-- company's default rate. Looking up the quote's rate with select ... into set the rate to null
-- when there was no quote, so those invoices had no tax at all.
create or replace function public.create_invoice_for_job(p_job uuid, p_kind text default 'standard', p_amount numeric default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  j public.jobs;
  v_invoice uuid;
  v_terms integer;
  v_tax numeric;
  v_today date;
  v_deposit numeric;
  v_amount numeric;
  v_contract numeric;
  v_prebilled numeric;
  v_existing bigint;
  v_sort integer := 0;
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
         (now() at time zone coalesce(timezone, 'UTC'))::date
    into v_terms, v_tax, v_today
  from public.companies where id = j.company_id;
  -- The rate the client approved on the quote wins over the company default, which a job without
  -- a quote keeps.
  v_tax := coalesce((select q.tax_rate from public.quotes q where q.id = j.quote_id), v_tax, 0);

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
    select 1 from public.visits where job_id = j.id and status = 'completed' and invoice_id is null and kind = 'job'
  ) then
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

  insert into public.invoices (company_id, client_id, job_id, kind, subject, issued_on, due_on, tax_rate, retainage_pct, pay_app_number)
  values (
    j.company_id, j.client_id, j.id, p_kind,
    case p_kind when 'deposit' then 'Deposit: ' || j.title when 'visits' then j.title || ' (completed visits)'
                when 'retainage' then 'Retainage: ' || j.title else j.title end,
    v_today, v_today + v_terms,
    case when p_kind in ('deposit', 'retainage') then 0 else v_tax end,
    case when p_kind in ('standard', 'progress') then j.retainage_pct else 0 end,
    case when p_kind = 'progress' then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end
  )
  returning id into v_invoice;

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
      order by coalesce(v.completed_at::date, v.scheduled_on)
    loop
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice, li.name, 'Visit on ' || to_char(r.day, 'Mon DD, YYYY'), li.quantity, li.unit, li.unit_price, li.taxable, v_sort + li.sort
      from public.job_line_items li where li.job_id = j.id;
      update public.visits set invoice_id = v_invoice where id = r.id;
      v_sort := v_sort + 1000000;
    end loop;

  else
    insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort)
    select company_id, v_invoice, service_id, name, description, quantity, unit, unit_price, taxable, sort
    from public.job_line_items where job_id = j.id;
    -- Credit what was already billed as deposits and progress payments.
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    select j.company_id, v_invoice,
           case i.kind when 'deposit' then 'Less deposit (invoice #' || i.number || ')' else 'Less progress billing (invoice #' || i.number || ')' end,
           -- Progress invoices were taxed, so their credit reduces the taxable amount too.
           1, 'ea', -i.subtotal, i.kind = 'progress', 200000 + row_number() over (order by i.number)
    from public.invoices i
    where i.job_id = j.id and i.kind in ('deposit', 'progress') and i.status <> 'void' and i.id <> v_invoice;
  end if;

  -- Touch the invoice so totals include the lines just added.
  update public.invoices set updated_at = now() where id = v_invoice;

  if j.status = 'requires_invoicing' and p_kind in ('standard', 'visits') then
    update public.jobs set status = 'completed' where id = j.id;
  end if;
  return v_invoice;
end $$;

notify pgrst, 'reload schema';
