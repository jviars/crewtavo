-- Quote templates, as Jobber has them (Quotes → Quote templates): a quote saved without its client,
-- its lines, options, sections and message, to start new quotes from. Not the paper's look: that's a
-- document style (document_templates, quotes.template_id).
--
-- A template is a quote row (quotes.is_template) rather than a table of its own, so "Save as
-- template" and "New from template" are the copy "Copy as new draft" already makes (duplicate_quote),
-- and a template's page, lines, options and sections are edited with the quote editor as they are.
-- It's always a draft with no client, no property and no number, so it can't be sent, approved or
-- made a job (each of those needs a client and changes the status); and with no client, nothing
-- listed by client finds one: the client's page, the Client Hub, search. The lists and counts that
-- take every draft leave templates out by the flag: Home here, and the Quotes list, the sales board,
-- the export and the assistant in the app.

alter table public.quotes
  add column is_template boolean not null default false,
  alter column client_id drop not null,
  add constraint quotes_template_check check (
    case when is_template
      then client_id is null and property_id is null and request_id is null and change_order_for is null
           and promo_code_id is null and number is null and status = 'draft'
      else client_id is not null end);

comment on column public.quotes.is_template is 'A quote template: a draft without a client or number that new quotes are copied from (duplicate_quote). Never sent, counted or listed with quotes.';

create index quotes_templates_idx on public.quotes (company_id, title) where is_template;

-- A template takes no number: numbers are the quotes a client gets, without gaps for templates.
drop trigger assign_number on public.quotes;
create trigger assign_number before insert on public.quotes
  for each row when (not new.is_template) execute function private.assign_number();

-- ---------------------------------------------------------------------------------------------
-- Copying a quote: as a new draft, as a template, or from a template for a client
-- ---------------------------------------------------------------------------------------------

-- As in 20261025000100_contracts_and_options.sql ("Copy as new draft"), and it makes and uses quote
-- templates. With p_template_name the copy is a template by that name: no client, property or end
-- date, with its custom field values kept. With p_client the copy is that client's quote, at
-- p_property, titled p_title and with the custom field values p_custom_fields when they're given
-- (the new-quote form's); made from a template, it's valid for the business's usual days
-- (settings.quote_valid_days) and has the template's custom field values unless given others. A
-- template copied without a client is another template. Its lines, options and the option shown,
-- sections, message, discount, tax, deposit and how often it repeats come along every way, with
-- the add-ons unpicked. Returns the copy's id.
drop function public.duplicate_quote(uuid);
create function public.duplicate_quote(p_quote uuid, p_template_name text default null, p_client uuid default null,
  p_property uuid default null, p_title text default null, p_custom_fields jsonb default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes;
  o public.quote_options;
  v_template boolean;
  v_new uuid;
  v_id uuid;
  v_map jsonb := '{}';
begin
  select * into q from public.quotes where id = p_quote;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if p_template_name is not null and p_client is not null then
    raise exception 'A quote template has no client.' using errcode = '22023';
  end if;
  if p_template_name is not null and btrim(p_template_name) = '' then
    raise exception 'Give the template a name.' using errcode = '22023';
  end if;
  v_template := p_template_name is not null or (q.is_template and p_client is null);

  insert into public.quotes (company_id, client_id, property_id, is_template, title, message, discount_amount, tax_rate, deposit_amount,
                             valid_until, roof_package_id, section_ids, recurrence_rule, active_months, starts_on, ends_on, custom_fields)
  select q.company_id,
         case when not v_template then coalesce(p_client, q.client_id) end,
         case when v_template then null when p_client is not null then p_property else q.property_id end,
         v_template,
         left(coalesce(nullif(btrim(p_template_name), ''), nullif(btrim(p_title), ''),
                       case when q.is_template and not v_template then q.title else q.title || ' (copy)' end), 200),
         q.message, q.discount_amount, q.tax_rate, q.deposit_amount,
         case when v_template then null
              when q.is_template then (now() at time zone coalesce(c.timezone, 'UTC'))::date
                                      + coalesce((c.settings ->> 'quote_valid_days')::numeric::integer, 30)
              when q.valid_until > (now() at time zone coalesce(c.timezone, 'UTC'))::date then q.valid_until end,
         q.roof_package_id, q.section_ids, q.recurrence_rule, q.active_months, q.starts_on, q.ends_on,
         case when p_client is not null and p_custom_fields is not null then p_custom_fields
              when v_template or q.is_template then q.custom_fields else '{}' end
    from public.companies c where c.id = q.company_id
  returning id into v_new;

  for o in select * from public.quote_options where quote_id = p_quote order by sort, id loop
    insert into public.quote_options (company_id, quote_id, package_id, name, tier, picture, picture_width, picture_height,
                                      style, highlights, warranty, section_ids, sort)
    values (o.company_id, v_new, o.package_id, o.name, o.tier, o.picture, o.picture_width, o.picture_height,
            o.style, o.highlights, o.warranty, o.section_ids, o.sort)
    returning id into v_id;
    v_map := v_map || jsonb_build_object(o.id::text, v_id);
  end loop;
  if q.option_id is not null then
    update public.quotes set option_id = (v_map ->> q.option_id::text)::uuid
     where id = v_new and option_id is distinct from (v_map ->> q.option_id::text)::uuid;
  end if;

  insert into public.quote_line_items (company_id, quote_id, option_id, service_id, name, description, quantity, unit, unit_price,
                                       unit_cost, taxable, optional, selected, option_group, formula, sort, materials, material_cost)
  select l.company_id, v_new, (v_map ->> l.option_id::text)::uuid, l.service_id, l.name, l.description, l.quantity, l.unit, l.unit_price,
         l.unit_cost, l.taxable, l.optional, not l.optional, l.option_group, l.formula, l.sort, l.materials, l.material_cost
    from public.quote_line_items l where l.quote_id = p_quote
   order by l.sort;
  return v_new;
end $$;
revoke execute on function public.duplicate_quote(uuid, text, uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.duplicate_quote(uuid, text, uuid, uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Home
-- ---------------------------------------------------------------------------------------------

-- As in 20261101000100_autopay.sql, and quote templates aren't drafts on Home.
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
        limit 10
      ) a), '[]')
  )
$$;
