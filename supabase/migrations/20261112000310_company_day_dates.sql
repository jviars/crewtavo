-- Two dates read off a time in UTC instead of in the company's own zone.
--
--   create_invoice_for_job()  A visit's invoice lines say "Visit on" the day it was finished. That
--                             day was UTC's, so a visit finished at 6pm in Los Angeles on Oct 31
--                             was billed as "Visit on Nov 01", on an invoice whose month was worked
--                             out on the company's calendar. Now it's the company's day.
--   dashboard()               Home's "Invoiced this month" started from the UTC date of the
--                             company's midnight on the 1st, which east of UTC is still the last
--                             day of the month before: that day's invoices were counted in too. Now
--                             it starts on the 1st of the company's month.
--
-- Invoices already made keep the lines they have.

-- As in 20261106000530_visit_lines_keep_service.sql, except that the day a visit was finished is
-- the company's (private.visit_day's reading of it). Which day a line names is as before: the day
-- it was finished, or failing that the day it was scheduled for.
create or replace function public.create_invoice_for_job(p_job uuid, p_kind text default 'standard', p_amount numeric default null, p_month date default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
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
  v_was text := coalesce(current_setting('crewtavo.job_discounts', true), '');
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

  if p_kind in ('deposit', 'progress') and j.kind <> 'recurring' and v_prebilled + v_amount > coalesce(v_contract, 0) + 0.005 then
    raise exception 'That''s more than what''s left to bill on this job (%)',
      to_char(greatest(coalesce(v_contract, 0) - v_prebilled, 0), 'FM$999,999,990.00') using errcode = '22023';
  end if;

  insert into public.invoices (company_id, client_id, job_id, kind, subject, issued_on, due_on, tax_rate, retainage_pct, pay_app_number, billing_month)
  values (
    j.company_id, j.client_id, j.id, p_kind,
    case when p_month is not null then j.title || ' (' || to_char(v_month, 'FMMonth YYYY') || ')'
         else case p_kind when 'deposit' then 'Deposit: ' || j.title when 'visits' then j.title || ' (completed visits)'
                          when 'retainage' then 'Retainage: ' || j.title else j.title end end,
    v_today, v_today + v_terms,
    case when p_kind in ('deposit', 'retainage') then 0 else v_tax end,
    case when p_kind in ('standard', 'progress') then j.retainage_pct else 0 end,
    case when p_kind = 'progress' then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end,
    v_month
  )
  returning id into v_invoice;

  -- All the lines go in first; the promo discounts are placed once they're there.
  perform set_config('crewtavo.job_discounts', 'on', true);

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
      select v.id, coalesce(private.visit_day(null, v.completed_at, v_tz), v.scheduled_on) as day
      from public.visits v
      where v.job_id = j.id and v.status = 'completed' and v.invoice_id is null and v.kind = 'job'
        and (p_month is null or private.visit_day(v.scheduled_on, v.completed_at, v_tz) between v_start and v_end)
      order by coalesce(private.visit_day(null, v.completed_at, v_tz), v.scheduled_on)
    loop
      insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
      select j.company_id, v_invoice, li.service_id, li.name, 'Visit on ' || to_char(r.day, 'Mon DD, YYYY'), li.quantity, li.unit, li.unit_price, li.taxable, v_sort + li.sort, li.discount_key
      from public.job_line_items li where li.job_id = j.id and li.discount_billing is distinct from 'once';
      update public.visits set invoice_id = v_invoice where id = r.id;
      v_sort := v_sort + 1000000;
    end loop;

  else
    insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
    select company_id, v_invoice, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_key
    from public.job_line_items where job_id = j.id and discount_billing is distinct from 'once';
    -- Credit what was already billed as deposits and progress payments (not on a month's invoice:
    -- it isn't the job's last).
    if p_month is null then
      insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice,
             case i.kind when 'deposit' then 'Less deposit (invoice #' || i.number || ')' else 'Less progress billing (invoice #' || i.number || ')' end,
             -- Progress invoices were taxed, so their credit reduces the taxable amount too.
             1, 'ea', -i.subtotal, i.kind = 'progress', 200000 + row_number() over (order by i.number)
      from public.invoices i
      where i.job_id = j.id and i.kind in ('deposit', 'progress') and i.status <> 'void' and i.id <> v_invoice;
    end if;
  end if;

  if p_kind in ('standard', 'visits') then
    perform private.place_job_discounts(j.id);
    perform private.fit_job_discounts(v_invoice);
  end if;
  perform set_config('crewtavo.job_discounts', v_was, true);

  -- Touch the invoice so totals include the lines just added.
  update public.invoices set updated_at = now() where id = v_invoice;

  if j.status = 'requires_invoicing' and p_kind in ('standard', 'visits') then
    update public.jobs set status = 'completed' where id = j.id;
  end if;
  return v_invoice;
end $$;
revoke execute on function public.create_invoice_for_job(uuid, text, numeric, date) from public, anon;
grant execute on function public.create_invoice_for_job(uuid, text, numeric, date) to authenticated, service_role;

-- As in 20261110000300_send_check_and_follow_ups.sql, except that "invoiced" this month starts on
-- the 1st of the company's month.
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
  autopay_failed as (
    select a.invoice_id, a.client_id, a.last_error from public.autopay_charges a
    where a.company_id = p_company and a.status in ('failed', 'needs_client')
      and not exists (select 1 from public.stripe_invoices s where s.invoice_id = a.invoice_id and s.status = 'processing' and s.detached_at is null)
  ),
  owing as (
    select c.id as client_id, c.display_name as client, sum(i.balance_due) as owed
    from public.invoices i join public.clients c on c.id = i.client_id
    where i.company_id = p_company and i.status in ('sent', 'partially_paid', 'overdue') and i.balance_due > 0
    group by c.id, c.display_name
  ),
  -- Monthly jobs' months waiting for their invoice (empty for anyone without the invoices area).
  due as (
    select d.job_id, count(*) as months from public.due_invoices d where d.company_id = p_company group by d.job_id
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
        from public.quotes where company_id = p_company and not is_template),
      'jobs', (
        select jsonb_build_object(
          'to_invoice', count(*) filter (where j.status = 'requires_invoicing' or d.job_id is not null),
          'to_invoice_value', coalesce(sum(f.contract_total) filter (where j.status = 'requires_invoicing'), 0)
                              + coalesce(sum(f.contract_total * d.months) filter (where j.pricing = 'fixed'), 0),
          'active', count(*) filter (where j.status = 'active'))
        from public.jobs j left join public.job_financials f on f.job_id = j.id left join due d on d.job_id = j.id
        where j.company_id = p_company),
      'invoices', (
        select jsonb_build_object(
          'awaiting', count(*) filter (where status in ('sent', 'partially_paid', 'overdue')),
          'awaiting_value', coalesce(sum(balance_due) filter (where status in ('sent', 'partially_paid', 'overdue')), 0),
          'past_due', count(*) filter (where status = 'overdue'),
          'past_due_value', coalesce(sum(balance_due) filter (where status = 'overdue'), 0),
          'draft', count(*) filter (where status = 'draft'),
          'autopay_failed', (select count(*) from autopay_failed),
          'autopay_failed_value', coalesce((select sum(i.balance_due) from autopay_failed a join public.invoices i on i.id = a.invoice_id), 0),
          'autopay_approval', (select count(*) from public.autopay_charges a where a.company_id = p_company and a.status = 'needs_approval'))
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
        'invoiced', coalesce((select sum(total) from public.invoices where company_id = p_company and status not in ('draft', 'void') and issued_on >= date_trunc('month', b.today::timestamp)::date), 0),
        'won', coalesce((select sum(total) from public.quotes where company_id = p_company and approved_at >= b.month_start), 0),
        'won_count', (select count(*) from public.quotes where company_id = p_company and approved_at >= b.month_start)
      ) from bounds b
    ),
    'attention', coalesce((
      select jsonb_agg(item) from (
        select jsonb_build_object('kind', 'autopay_failed', 'title', 'Autopay failed: ' || c.display_name,
                                  'detail', 'Invoice #' || i.number || coalesce(' · ' || a.last_error, ''), 'link', '/invoices/' || i.id) as item
        from autopay_failed a join public.invoices i on i.id = a.invoice_id join public.clients c on c.id = a.client_id
        union all
        -- Why it waits: the reason autopay_bill gave (visits it didn't queue), else the cap.
        select jsonb_build_object('kind', 'autopay_approval', 'title', 'Charge needs your OK: Invoice #' || i.number,
                                  'detail', coalesce(a.last_error, '$' || to_char(i.balance_due, 'FM999,999,990.00') || ' is over your autopay limit'),
                                  'link', '/invoices/' || i.id)
        from public.autopay_charges a join public.invoices i on i.id = a.invoice_id
        where a.company_id = p_company and a.status = 'needs_approval'
        union all
        select jsonb_build_object('kind', 'quote', 'title', 'Quote #' || number || ': changes requested',
                                  'detail', title, 'link', '/quotes/' || id)
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
        union all
        -- A request nobody has picked up in 2 days, and whose it is (Settings → Sales areas).
        (select jsonb_build_object('kind', 'request', 'title', 'Request #' || r.number || ' waiting ' || extract(day from now() - r.created_at)::int || ' days',
                                   'detail', concat_ws(' · ', r.title, coalesce(p.full_name, 'Nobody has it yet')), 'link', '/requests/' || r.id)
         from public.requests r left join public.profiles p on p.user_id = r.assigned_to
         where r.company_id = p_company and r.status = 'new' and r.created_at < now() - interval '2 days'
         order by r.created_at limit 3)
        union all
        -- Said yes to the range, and nobody has priced it on site yet.
        (select jsonb_build_object('kind', 'roof', 'title', 'Estimate #' || q.number || ': book the site visit',
                                   'detail', concat_ws(' · ', c.display_name || ' said yes to the range', p.full_name), 'link', '/roofing/' || q.id)
         from public.quotes q left join public.clients c on c.id = q.client_id left join public.profiles p on p.user_id = q.salesperson_id
         where q.company_id = p_company and q.status in ('sent', 'changes_requested') and q.range_accepted_at is not null
           and q.priced_on_site_at is null and q.exact_sent_at is null
         order by q.range_accepted_at limit 3)
        union all
        -- The exact price is out (sent, or set on site) and still not signed 3 days on.
        (select jsonb_build_object('kind', 'quote', 'title', 'Estimate #' || q.number || ': not signed yet',
                                   'detail', concat_ws(' · ', c.display_name, 'exact price out ' || extract(day from now() - coalesce(q.exact_sent_at, q.priced_on_site_at))::int || ' days', p.full_name),
                                   'link', '/roofing/' || q.id)
         from public.quotes q left join public.clients c on c.id = q.client_id left join public.profiles p on p.user_id = q.salesperson_id
         where q.company_id = p_company and q.status = 'sent' and coalesce(q.exact_sent_at, q.priced_on_site_at) < now() - interval '3 days'
         order by coalesce(q.exact_sent_at, q.priced_on_site_at) limit 3)
        limit 10
      ) a), '[]')
  )
$$;

notify pgrst, 'reload schema';
