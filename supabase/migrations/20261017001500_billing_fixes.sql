-- Billing fixes:
--   * a quote's discount lowers the taxable amount, and comes along to the job (and so to its
--     invoices) as a credit line, so the client is billed what they approved;
--   * invoices can carry a discount too (promo codes use it), taken before tax;
--   * invoices use the quote's tax rate and the company's local date;
--   * a one-off job gets one final invoice, and deposits plus progress billing can't pass the contract;
--   * retainage held back on a job's invoices can be billed once the work is accepted;
--   * an invoice that credits cover completely counts as paid;
--   * line items lock once an invoice is sent, invoices with payments can't be voided, and
--     payments that came through Stripe can't be edited or deleted by hand.

alter table public.invoices add column discount_amount numeric(12, 2) not null default 0 check (discount_amount >= 0);
alter table public.invoices drop constraint invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check
  check (kind in ('standard', 'deposit', 'progress', 'visits', 'retainage'));

-- ---------------------------------------------------------------------------------------------
-- Totals. The discount is spread over the taxable and non-taxable charges in proportion, and
-- only the taxable share reduces the tax.
-- ---------------------------------------------------------------------------------------------

create or replace function private.quote_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_sub numeric; v_taxable numeric; v_base numeric; v_base_taxable numeric; v_discount numeric;
begin
  select coalesce(sum(round(quantity * unit_price, 2)) filter (where selected), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and taxable), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and unit_price > 0), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and taxable and unit_price > 0), 0)
    into v_sub, v_taxable, v_base, v_base_taxable
  from public.quote_line_items where quote_id = new.id;
  v_discount := least(new.discount_amount, greatest(v_sub, 0));
  new.subtotal := v_sub;
  new.tax_amount := round(greatest(v_taxable - case when v_base > 0 then v_discount * v_base_taxable / v_base else 0 end, 0) * new.tax_rate, 2);
  new.total := greatest(v_sub - v_discount, 0) + new.tax_amount;
  return new;
end $$;

create or replace function private.invoice_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sub numeric; v_taxable numeric; v_base numeric; v_base_taxable numeric; v_lines integer;
  v_discount numeric; v_paid numeric; v_today date;
begin
  select coalesce(sum(round(quantity * unit_price, 2)), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable and unit_price > 0), 0),
         count(*)
    into v_sub, v_taxable, v_base, v_base_taxable, v_lines
  from public.invoice_line_items where invoice_id = new.id;
  select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = new.id;
  select (now() at time zone coalesce(c.timezone, 'UTC'))::date into v_today from public.companies c where c.id = new.company_id;

  v_discount := least(new.discount_amount, greatest(v_sub, 0));
  new.subtotal := v_sub;
  new.tax_amount := round(greatest(v_taxable - case when v_base > 0 then v_discount * v_base_taxable / v_base else 0 end, 0) * new.tax_rate, 2);
  new.total := v_sub - v_discount + new.tax_amount;
  new.retainage_amount := round(greatest(new.total, 0) * new.retainage_pct / 100, 2);
  new.amount_paid := v_paid;
  new.balance_due := new.total - new.retainage_amount - v_paid;

  if new.status not in ('draft', 'void') then
    new.status := case
      when v_lines > 0 and new.balance_due <= 0 then 'paid'
      when new.due_on is not null and new.due_on < coalesce(v_today, current_date) then 'overdue'
      when v_paid > 0 then 'partially_paid'
      else 'sent'
    end;
  end if;
  if new.status <> 'draft' and new.sent_at is null then
    new.sent_at := now();
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------

-- Line items change only while the invoice is a draft (and freely when the invoice itself is
-- being deleted, when the parent row is already gone).
create function private.invoice_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from public.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Move the invoice back to draft to change its line items' using errcode = '22023';
  end if;
  return coalesce(new, old);
end $$;
create trigger lines_guard before insert or update or delete on public.invoice_line_items
  for each row execute function private.invoice_lines_guard();

create function private.invoice_void_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'void' and old.status <> 'void'
     and coalesce((select sum(amount) from public.payments where invoice_id = new.id), 0) <> 0 then
    raise exception 'This invoice has payments. Refund or remove them before voiding it' using errcode = '22023';
  end if;
  if new.status = 'draft' and old.status <> 'draft'
     and exists (select 1 from public.payments where invoice_id = new.id) then
    raise exception 'This invoice has payments, so it can''t go back to draft' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger void_guard before update on public.invoices
  for each row execute function private.invoice_void_guard();

-- Stripe payments mirror real card and bank transactions: refund them in Stripe instead.
create policy payments_processor_update on public.payments as restrictive for update to authenticated using (processor is null);
create policy payments_processor_delete on public.payments as restrictive for delete to authenticated using (processor is null);
-- No payments on a void invoice.
create policy payments_not_void on public.payments as restrictive for insert to authenticated with check (
  invoice_id is null or not exists (select 1 from public.invoices i where i.id = invoice_id and i.status = 'void')
);

-- ---------------------------------------------------------------------------------------------
-- Quote to job: the discount comes along as credit lines (taxable share first).
-- ---------------------------------------------------------------------------------------------

create or replace function private.carry_quote_discount(p_quote uuid, p_job uuid, p_label text) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_base numeric; v_base_taxable numeric; v_discount numeric; v_taxable_part numeric;
begin
  select * into q from public.quotes where id = p_quote;
  if not found or q.discount_amount <= 0 then
    return;
  end if;
  -- Called from convert_quote_to_job as the user (the backfill below runs as the owner).
  if auth.uid() is not null and not private.has_role(q.company_id, '{owner,admin,office,estimator}') then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  select coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable and unit_price > 0), 0)
    into v_base, v_base_taxable
  from public.quote_line_items where quote_id = q.id and selected;
  v_discount := least(q.discount_amount, greatest(q.subtotal, 0));
  if v_discount <= 0 or v_base <= 0 then
    return;
  end if;
  v_taxable_part := round(v_discount * v_base_taxable / v_base, 2);
  if v_taxable_part > 0 then
    insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort)
    values (q.company_id, p_job, p_label, 1, 'ea', -v_taxable_part, true, 100000);
  end if;
  if v_discount - v_taxable_part > 0 then
    insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort)
    values (q.company_id, p_job, p_label, 1, 'ea', -(v_discount - v_taxable_part), false, 100001);
  end if;
end $$;
revoke execute on function private.carry_quote_discount(uuid, uuid, text) from public;
grant execute on function private.carry_quote_discount(uuid, uuid, text) to authenticated;

create or replace function public.convert_quote_to_job(p_quote uuid) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare q public.quotes; v_job uuid;
begin
  select * into q from public.quotes where id = p_quote for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if q.status in ('converted', 'lost', 'archived') then
    raise exception 'This quote is already %', q.status using errcode = '22023';
  end if;

  insert into public.jobs (company_id, client_id, property_id, quote_id, title, instructions)
  values (q.company_id, q.client_id, q.property_id, q.id, q.title, q.message)
  returning id into v_job;

  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort)
  select company_id, v_job, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort
  from public.quote_line_items where quote_id = q.id and selected;
  perform private.carry_quote_discount(q.id, v_job, 'Discount');

  update public.quotes set status = 'converted', converted_at = now() where id = q.id;
  if q.request_id is not null then
    update public.requests set status = 'converted' where id = q.request_id;
  end if;
  update public.clients set status = 'active' where id = q.client_id and status = 'lead';
  return v_job;
end $$;

-- Jobs converted before this fix, that haven't been billed in full yet, get their discount now.
do $$
declare r record;
begin
  for r in
    select j.id as job_id, j.quote_id from public.jobs j join public.quotes q on q.id = j.quote_id
    where q.discount_amount > 0
      and not exists (select 1 from public.job_line_items li where li.job_id = j.id and li.unit_price < 0)
      and not exists (select 1 from public.invoices i where i.job_id = j.id and i.kind in ('standard', 'visits') and i.status <> 'void')
  loop
    perform private.carry_quote_discount(r.quote_id, r.job_id, 'Discount');
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Invoicing a job
-- ---------------------------------------------------------------------------------------------

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
  -- The rate the client approved on the quote wins over the company default.
  select coalesce(q.tax_rate, v_tax) into v_tax from public.quotes q where q.id = j.quote_id;
  v_tax := coalesce(v_tax, 0);

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
