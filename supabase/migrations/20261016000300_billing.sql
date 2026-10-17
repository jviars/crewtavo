-- Invoices, payments, and the triggers that keep every total honest.
-- Accounting (ledger, chart of accounts) stays in QuickBooks, Xero or Zoho; see integrations.

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number bigint,
  client_id uuid not null,
  job_id uuid,
  kind text not null default 'standard' check (kind in ('standard', 'deposit', 'progress')),
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void')),
  issued_on date not null default current_date,
  due_on date,
  subject text,
  notes text,
  pay_app_number integer,   -- progress billing (pay applications)
  retainage_pct numeric(5, 2) not null default 0 check (retainage_pct between 0 and 100),
  -- Maintained by triggers:
  subtotal numeric(12, 2) not null default 0,
  tax_rate numeric(6, 4) not null default 0 check (tax_rate >= 0 and tax_rate < 1),
  tax_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  retainage_amount numeric(12, 2) not null default 0,
  amount_paid numeric(12, 2) not null default 0,
  balance_due numeric(12, 2) not null default 0,
  sent_at timestamptz,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id)
);
create index invoices_company_status_idx on public.invoices (company_id, status, due_on);
create index invoices_client_idx on public.invoices (company_id, client_id);

create table public.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  invoice_id uuid not null,
  service_id uuid,
  name text not null,
  description text,
  quantity numeric(14, 3) not null default 1,
  unit text not null default 'ea',
  unit_price numeric(12, 2) not null default 0,
  taxable boolean not null default true,
  sort integer not null default 0,
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete cascade,
  foreign key (company_id, service_id) references public.services (company_id, id) on delete set null (service_id)
);
create index invoice_line_items_invoice_idx on public.invoice_line_items (invoice_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  invoice_id uuid,
  client_id uuid not null,
  amount numeric(12, 2) not null check (amount <> 0), -- negative = refund
  tip_amount numeric(12, 2) not null default 0,
  method text not null default 'card' check (method in ('card', 'ach', 'cash', 'check', 'other')),
  received_at timestamptz not null default now(),
  processor text,              -- 'stripe'
  processor_ref text unique,   -- payment intent id; makes webhooks idempotent
  notes text,
  recorded_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete set null (invoice_id)
);
create index payments_invoice_idx on public.payments (invoice_id);

create trigger assign_number before insert on public.invoices for each row execute function private.assign_number();
select private.add_touch_triggers(array['invoices']);

-- ---------------------------------------------------------------------------------------------
-- Totals. Parent BEFORE triggers recompute from children on every write; child triggers touch the
-- parent so that happens. Numbers sent by the browser are always replaced.
-- ---------------------------------------------------------------------------------------------

create function private.quote_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_sub numeric; v_taxable numeric;
begin
  select coalesce(sum(round(quantity * unit_price, 2)) filter (where selected), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and taxable), 0)
    into v_sub, v_taxable
  from public.quote_line_items where quote_id = new.id;
  new.subtotal := v_sub;
  new.tax_amount := round(v_taxable * new.tax_rate, 2);
  new.total := greatest(v_sub - new.discount_amount, 0) + new.tax_amount;
  return new;
end $$;
create trigger quote_totals before insert or update on public.quotes
  for each row execute function private.quote_totals();

create function private.job_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select coalesce(sum(round(quantity * unit_price, 2)), 0) into new.contract_total
  from public.job_line_items where job_id = new.id;
  return new;
end $$;
create trigger job_totals before insert or update on public.jobs
  for each row execute function private.job_totals();

create function private.invoice_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_sub numeric; v_taxable numeric; v_paid numeric;
begin
  select coalesce(sum(round(quantity * unit_price, 2)), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable), 0)
    into v_sub, v_taxable
  from public.invoice_line_items where invoice_id = new.id;
  select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = new.id;

  new.subtotal := v_sub;
  new.tax_amount := round(v_taxable * new.tax_rate, 2);
  new.total := v_sub + new.tax_amount;
  new.retainage_amount := round(new.total * new.retainage_pct / 100, 2);
  new.amount_paid := v_paid;
  new.balance_due := new.total - new.retainage_amount - v_paid;

  if new.status not in ('draft', 'void') then
    new.status := case
      when new.total > 0 and new.balance_due <= 0 then 'paid'
      when v_paid > 0 then 'partially_paid'
      when new.due_on is not null and new.due_on < current_date then 'overdue'
      else 'sent'
    end;
  end if;
  if new.status <> 'draft' and new.sent_at is null then
    new.sent_at := now();
  end if;
  return new;
end $$;
create trigger invoice_totals before insert or update on public.invoices
  for each row execute function private.invoice_totals();

-- Child changes touch the parent row, which re-runs its totals trigger.
-- Arguments: parent table, foreign key column on the child.
create function private.touch_parent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  execute format('update public.%I set updated_at = now() where id = $1', tg_argv[0])
    using (to_jsonb(coalesce(new, old)) ->> tg_argv[1])::uuid;
  if tg_op = 'UPDATE' and (to_jsonb(old) ->> tg_argv[1]) is distinct from (to_jsonb(new) ->> tg_argv[1]) then
    execute format('update public.%I set updated_at = now() where id = $1', tg_argv[0])
      using (to_jsonb(old) ->> tg_argv[1])::uuid;
  end if;
  return null;
end $$;

create trigger touch_quote after insert or update or delete on public.quote_line_items
  for each row execute function private.touch_parent('quotes', 'quote_id');
create trigger touch_job after insert or update or delete on public.job_line_items
  for each row execute function private.touch_parent('jobs', 'job_id');
create trigger touch_invoice after insert or update or delete on public.invoice_line_items
  for each row execute function private.touch_parent('invoices', 'invoice_id');
create trigger touch_invoice after insert or update or delete on public.payments
  for each row execute function private.touch_parent('invoices', 'invoice_id');

-- ---------------------------------------------------------------------------------------------
-- RLS: money is office-and-up only.
-- ---------------------------------------------------------------------------------------------

select private.apply_policies('invoices', '{owner,admin,office}', '{owner,admin,office}');
select private.apply_policies('invoice_line_items', '{owner,admin,office}', '{owner,admin,office}');
select private.apply_policies('payments', '{owner,admin,office}', '{owner,admin,office}');

-- ---------------------------------------------------------------------------------------------
-- Workflow functions (run as the caller, so RLS applies)
-- ---------------------------------------------------------------------------------------------

create function public.convert_quote_to_job(p_quote uuid) returns uuid
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

  update public.quotes set status = 'converted', converted_at = now() where id = q.id;
  if q.request_id is not null then
    update public.requests set status = 'converted' where id = q.request_id;
  end if;
  update public.clients set status = 'active' where id = q.client_id and status = 'lead';
  return v_job;
end $$;

create function public.create_invoice_for_job(p_job uuid, p_kind text default 'standard') returns uuid
language plpgsql security invoker set search_path = '' as $$
declare j public.jobs; v_invoice uuid; v_terms integer; v_tax numeric;
begin
  select * into j from public.jobs where id = p_job;
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  select coalesce((settings ->> 'payment_terms_days')::integer, 30), coalesce((settings ->> 'default_tax_rate')::numeric, 0)
    into v_terms, v_tax
  from public.companies where id = j.company_id;

  insert into public.invoices (company_id, client_id, job_id, kind, subject, due_on, tax_rate, retainage_pct, pay_app_number)
  values (
    j.company_id, j.client_id, j.id, p_kind, j.title, current_date + v_terms, v_tax, j.retainage_pct,
    case when p_kind = 'progress'
      then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end
  )
  returning id into v_invoice;

  insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort)
  select company_id, v_invoice, service_id, name, description, quantity, unit, unit_price, taxable, sort
  from public.job_line_items where job_id = j.id;

  if j.status = 'requires_invoicing' then
    update public.jobs set status = 'completed' where id = j.id;
  end if;
  return v_invoice;
end $$;

revoke execute on function public.convert_quote_to_job(uuid), public.create_invoice_for_job(uuid, text) from public, anon;
grant execute on function public.convert_quote_to_job(uuid), public.create_invoice_for_job(uuid, text) to authenticated;
