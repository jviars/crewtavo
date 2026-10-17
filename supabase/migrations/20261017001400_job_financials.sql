-- A job's money lives in its own table so crews, who need jobs for titles and instructions, can't read
-- what the job is worth. public.job_financials is kept up to date from job_line_items and is readable
-- by owners, admins, office and estimators only.

-- One row per job (company_id is copied from the job by the trigger below).
create table public.job_financials (
  job_id uuid primary key references public.jobs (id) on delete cascade,
  company_id uuid not null,
  contract_total numeric(12, 2) not null default 0,
  updated_at timestamptz not null default now()
);
create index job_financials_company on public.job_financials (company_id);
alter table public.job_financials enable row level security;
create policy job_financials_read on public.job_financials for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'));
-- Written only by the trigger below.
revoke insert, update, delete on public.job_financials from authenticated;

create or replace function private.refresh_job_financials(p_job uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.job_financials (job_id, company_id, contract_total, updated_at)
  select j.id, j.company_id,
         coalesce((select sum(round(li.quantity * li.unit_price, 2)) from public.job_line_items li where li.job_id = j.id), 0),
         now()
  from public.jobs j where j.id = p_job
  on conflict (job_id) do update set contract_total = excluded.contract_total, updated_at = now()
$$;

-- Jobs get a row when created; line item changes keep it current (they already touch the job row).
create function private.job_financials_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.refresh_job_financials(new.id);
  return null;
end $$;
create trigger financials after insert or update on public.jobs
  for each row execute function private.job_financials_sync();

insert into public.job_financials (job_id, company_id, contract_total)
select id, company_id, contract_total from public.jobs
on conflict (job_id) do nothing;

-- The old column and its trigger go away.
drop trigger job_totals on public.jobs;
drop function private.job_totals();
alter table public.jobs drop column contract_total;

-- Functions that read the total now read it from job_financials.
create or replace function private.activity_jobs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client text := private.client_name(new.client_id);
begin
  if tg_op = 'INSERT' then
    perform private.emit(new.company_id, 'job.created', 'job', new.id, format('Job #%s created for %s: %s', new.number, v_client, new.title),
      jsonb_build_object('number', new.number, 'kind', new.kind));
  elsif new.status is distinct from old.status and old.status = 'active' and new.status in ('requires_invoicing', 'completed') then
    perform private.emit(new.company_id, 'job.completed', 'job', new.id, format('Job #%s for %s is complete', new.number, v_client),
      jsonb_build_object('number', new.number, 'total', (select contract_total from public.job_financials where job_id = new.id)));
  end if;
  return null;
end $$;

-- The dashboard and invoice creation run as the caller and read totals from job_financials.
create or replace function public.dashboard(p_company uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with co as (
    select coalesce(timezone, 'UTC') as tz from public.companies where id = p_company
  ),
  bounds as (
    select (date_trunc('day', now() at time zone co.tz)) at time zone co.tz as day_start,
           (date_trunc('day', now() at time zone co.tz) + interval '1 day') at time zone co.tz as day_end,
           (now() at time zone co.tz)::date as today,
           (date_trunc('month', now() at time zone co.tz)) at time zone co.tz as month_start,
           (date_trunc('month', now() at time zone co.tz) - interval '1 month') at time zone co.tz as last_month_start
    from co
  ),
  today_visits as (
    select v.id, v.title, v.kind, v.status, v.starts_at, v.ends_at, v.scheduled_on, v.job_id, v.hold_reason,
           c.id as client_id, c.display_name as client, cr.name as crew, cr.color as crew_color,
           p.line1 as address
    from public.visits v
    cross join bounds b
    left join public.jobs j on j.id = v.job_id
    left join public.requests r on r.id = v.request_id
    left join public.clients c on c.id = coalesce(j.client_id, r.client_id)
    left join public.crews cr on cr.id = v.crew_id
    left join public.properties p on p.id = v.property_id
    where v.company_id = p_company and v.status <> 'cancelled'
      and ((v.starts_at >= b.day_start and v.starts_at < b.day_end) or (v.starts_at is null and v.scheduled_on = b.today))
  ),
  owing as (
    select c.id as client_id, c.display_name as client, sum(i.balance_due) as owed
    from public.invoices i join public.clients c on c.id = i.client_id
    where i.company_id = p_company and i.status in ('sent', 'partially_paid', 'overdue') and i.balance_due > 0
    group by c.id, c.display_name
  )
  select jsonb_build_object(
    'workflow', jsonb_build_object(
      'requests', (
        select jsonb_build_object(
          'new', count(*) filter (where status = 'new'),
          'assessment_complete', count(*) filter (where status = 'assessment_complete'),
          'overdue', count(*) filter (where status = 'new' and created_at < now() - interval '2 days'))
        from public.requests where company_id = p_company),
      'quotes', (
        select jsonb_build_object(
          'awaiting', count(*) filter (where status in ('sent', 'changes_requested')),
          'awaiting_value', coalesce(sum(total) filter (where status in ('sent', 'changes_requested')), 0),
          'approved', count(*) filter (where status = 'approved'),
          'approved_value', coalesce(sum(total) filter (where status = 'approved'), 0),
          'draft', count(*) filter (where status = 'draft'),
          'draft_value', coalesce(sum(total) filter (where status = 'draft'), 0))
        from public.quotes where company_id = p_company),
      'jobs', (
        select jsonb_build_object(
          'to_invoice', count(*) filter (where j.status = 'requires_invoicing'),
          'to_invoice_value', coalesce(sum(f.contract_total) filter (where j.status = 'requires_invoicing'), 0),
          'active', count(*) filter (where j.status = 'active'))
        from public.jobs j left join public.job_financials f on f.job_id = j.id where j.company_id = p_company),
      'invoices', (
        select jsonb_build_object(
          'awaiting', count(*) filter (where status in ('sent', 'partially_paid', 'overdue')),
          'awaiting_value', coalesce(sum(balance_due) filter (where status in ('sent', 'partially_paid', 'overdue')), 0),
          'past_due', count(*) filter (where status = 'overdue'),
          'past_due_value', coalesce(sum(balance_due) filter (where status = 'overdue'), 0),
          'draft', count(*) filter (where status = 'draft'))
        from public.invoices where company_id = p_company)
    ),
    'today', jsonb_build_object(
      'total', (select count(*) from today_visits),
      'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from today_visits group by status) s), '{}'),
      'visits', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'title', title, 'kind', kind, 'status', status, 'starts_at', starts_at, 'ends_at', ends_at,
          'scheduled_on', scheduled_on, 'job_id', job_id, 'client_id', client_id, 'client', client,
          'crew', crew, 'crew_color', crew_color, 'address', address, 'hold_reason', hold_reason)
          order by starts_at nulls last, title)
        from today_visits), '[]')
    ),
    'receivables', jsonb_build_object(
      'clients_owing', (select count(*) from owing),
      'total', coalesce((select sum(owed) from owing), 0),
      'top', coalesce((select jsonb_agg(jsonb_build_object('client_id', client_id, 'client', client, 'owed', owed) order by owed desc)
                       from (select * from owing order by owed desc limit 5) t), '[]')
    ),
    'month', (
      select jsonb_build_object(
        'collected', coalesce((select sum(amount) from public.payments where company_id = p_company and received_at >= b.month_start), 0),
        'collected_last', coalesce((select sum(amount) from public.payments where company_id = p_company and received_at >= b.last_month_start and received_at < b.month_start), 0),
        'invoiced', coalesce((select sum(total) from public.invoices where company_id = p_company and status not in ('draft', 'void') and issued_on >= b.month_start::date), 0),
        'won', coalesce((select sum(total) from public.quotes where company_id = p_company and approved_at >= b.month_start), 0),
        'won_count', (select count(*) from public.quotes where company_id = p_company and approved_at >= b.month_start)
      ) from bounds b
    ),
    'attention', coalesce((
      select jsonb_agg(item) from (
        select jsonb_build_object('kind', 'quote', 'title', 'Quote #' || number || ': changes requested',
                                  'detail', title, 'link', '/quotes/' || id) as item
        from public.quotes where company_id = p_company and status = 'changes_requested'
        union all
        select jsonb_build_object('kind', 'quote', 'title', 'Quote #' || number || ' approved: convert to a job',
                                  'detail', title, 'link', '/quotes/' || id)
        from public.quotes where company_id = p_company and status = 'approved'
        union all
        select jsonb_build_object('kind', 'visit', 'title', 'Weather hold: ' || title,
                                  'detail', hold_reason, 'link', '/schedule')
        from public.visits where company_id = p_company and hold_reason is not null and status = 'scheduled'
        union all
        select jsonb_build_object('kind', 'invoice', 'title', 'Invoice #' || number || ' is past due',
                                  'detail', '$' || to_char(balance_due, 'FM999,999,990.00') || ' owing', 'link', '/invoices/' || id)
        from public.invoices where company_id = p_company and status = 'overdue'
        limit 10
      ) a), '[]')
  )
$$;

create or replace function public.create_invoice_for_job(p_job uuid, p_kind text default 'standard', p_amount numeric default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  j public.jobs;
  v_invoice uuid;
  v_terms integer;
  v_tax numeric;
  v_deposit numeric;
  v_amount numeric;
  v_sort integer := 0;
  v_contract numeric;
  r record;
begin
  select * into j from public.jobs where id = p_job;
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  select contract_total into v_contract from public.job_financials where job_id = j.id;
  if p_kind not in ('standard', 'deposit', 'progress', 'visits') then
    raise exception 'Unknown invoice type' using errcode = '22023';
  end if;
  select coalesce((settings ->> 'payment_terms_days')::integer, 30), coalesce((settings ->> 'default_tax_rate')::numeric, 0)
    into v_terms, v_tax
  from public.companies where id = j.company_id;

  if p_kind = 'visits' and not exists (
    select 1 from public.visits where job_id = j.id and status = 'completed' and invoice_id is null and kind = 'job'
  ) then
    raise exception 'There are no completed visits waiting to be invoiced' using errcode = '22023';
  end if;

  if p_kind = 'deposit' then
    select deposit_amount into v_deposit from public.quotes where id = j.quote_id;
    v_amount := coalesce(p_amount, nullif(v_deposit, 0));
    if v_amount is null or v_amount <= 0 then
      raise exception 'Enter the deposit amount' using errcode = '22023';
    end if;
  elsif p_kind = 'progress' then
    if p_amount is null or p_amount <= 0 then
      raise exception 'Enter how much to bill' using errcode = '22023';
    end if;
    v_amount := p_amount;
  end if;

  insert into public.invoices (company_id, client_id, job_id, kind, subject, due_on, tax_rate, retainage_pct, pay_app_number)
  values (
    j.company_id, j.client_id, j.id, p_kind,
    case p_kind when 'deposit' then 'Deposit: ' || j.title when 'visits' then j.title || ' (completed visits)' else j.title end,
    current_date + v_terms,
    case when p_kind in ('deposit') then 0 else v_tax end,
    case when p_kind in ('standard', 'progress') then j.retainage_pct else 0 end,
    case when p_kind = 'progress' then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end
  )
  returning id into v_invoice;

  if p_kind = 'deposit' then
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Deposit for ' || j.title, 1, 'ea', round(v_amount, 2), false, 0);

  elsif p_kind = 'progress' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Progress billing: ' || j.title,
            case when v_contract > 0 then round(v_amount / v_contract * 100, 1) || '% of the ' || to_char(v_contract, 'FM$999,999,990.00') || ' contract' end,
            1, 'ea', round(v_amount, 2), true, 0);

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
      v_sort := v_sort + 100;
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
           1, 'ea', -i.subtotal, i.kind = 'progress', 10000 + row_number() over (order by i.number)
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
