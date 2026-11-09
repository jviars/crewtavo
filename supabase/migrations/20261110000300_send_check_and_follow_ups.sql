-- Before a roof estimate goes out, and after: what's kept, what Home asks about, and the follow-up.
--
--   quotes.left_out          What the estimate's packages left off when it went out, and how the
--                            office chose to show each (services/sendCheck.ts): shown ones print as
--                            "Not included" on the estimate; the rest are office only.
--   dashboard() attention    As in 20261105000130_dashboard_monthly_invoices.sql, plus: requests
--                            nobody has picked up in 2 days (with whose they are), a homeowner's yes
--                            to the range with no price set on site, and an exact price out 3 days
--                            and not signed.
--   quote_exact_sent()       The exact price going out after the homeowner's yes to the range (or a
--                            price set on site) starts the quote follow-up again: the yes cancelled
--                            it (accept_hub_range), and the quote was already "sent".

alter table public.quotes add column left_out jsonb not null default '[]' check (jsonb_typeof(left_out) = 'array');
comment on column public.quotes.left_out is 'What its packages left off when it went out: [{service_id, option_id, name, reason, shown}]. Shown ones print as Not included.';

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
        'invoiced', coalesce((select sum(total) from public.invoices where company_id = p_company and status not in ('draft', 'void') and issued_on >= b.month_start::date), 0),
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

create function public.quote_exact_sent(p_quote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes;
begin
  select * into q from public.quotes where id = p_quote;
  if not found or not (private.has_role(q.company_id, '{owner,admin,office,estimator}') and private.has_perm(q.company_id, 'sales')) then
    raise exception 'Quote not found' using errcode = '42501';
  end if;
  if q.status <> 'sent' or (q.range_accepted_at is null and q.priced_on_site_at is null) then
    return;
  end if;
  -- One follow-up for the price to sign: any still waiting goes first.
  update public.automation_runs r
     set status = 'cancelled', finished_at = now(), error = 'The exact price went out again.'
    from public.automation_rules rule
   where rule.id = r.rule_id and rule.trigger = 'quote.sent'
     and r.company_id = q.company_id and r.subject_type = 'quote' and r.subject_id = q.id and r.status = 'pending';
  perform private.emit(q.company_id, 'quote.sent', 'quote', q.id,
    format('Exact price for quote #%s sent to %s (%s)', q.number, private.client_name(q.client_id), private.money(q.total)),
    jsonb_build_object('number', q.number, 'total', q.total));
end $$;
revoke execute on function public.quote_exact_sent(uuid) from public, anon;
grant execute on function public.quote_exact_sent(uuid) to authenticated;

notify pgrst, 'reload schema';
