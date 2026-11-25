
-- Dates, times and amounts in what the office reads, written the way the business's country
-- writes them and in its currency (20261124100500_dates_in_the_business_country.sql): Activity,
-- the office's notifications, and the errors its pages show: invoices, quotes, payments, autopay,
-- referral credits, price changes, payment schedules, equipment, pay, snow, postcards, automatic
-- social posts and the dashboard.
--
-- As in 20261124100510_words_for_clients_subs_and_crew.sql: each function is its newest definition,
-- copied as it is, with only its dates and amounts written by private.date_text and the business's
-- currency, and the country and currency read with the company. A US business in dollars reads every
-- word as before, and no function's arguments change: the payment schedule's problems and the time
-- an automatic post goes out have new functions beside the old ones, which stay.
--
-- supabase/tests/dates_in_the_business_country_test.sql covers it.

-- As in 20261017000100_activity_notifications_search.sql, with the amounts in the business's
-- currency.
create or replace function private.activity_quotes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_data jsonb := jsonb_build_object('number', new.number, 'total', new.total);
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    case new.status
      when 'sent' then
        perform private.emit(new.company_id, 'quote.sent', 'quote', new.id, format('Quote #%s sent to %s (%s)', new.number, v_client, private.money_in(new.total, private.company_currency(new.company_id))), v_data);
      when 'approved' then
        perform private.emit(new.company_id, 'quote.approved', 'quote', new.id,
          format('Quote #%s approved%s (%s)', new.number, coalesce(' by ' || (new.approval ->> 'name'), ''), private.money_in(new.total, private.company_currency(new.company_id))), v_data);
      when 'changes_requested' then
        perform private.emit(new.company_id, 'quote.changes_requested', 'quote', new.id, format('%s asked for changes to quote #%s', v_client, new.number), v_data);
      when 'lost' then
        perform private.emit(new.company_id, 'quote.lost', 'quote', new.id, format('Quote #%s for %s marked lost', new.number, v_client), v_data);
      when 'converted' then
        perform private.emit(new.company_id, 'quote.converted', 'quote', new.id, format('Quote #%s converted to a job', new.number), v_data);
      else null;
    end case;
  end if;
  return null;
end $$;

-- As in 20261113000430_owed_again_without_chasing.sql, with the amounts in the business's currency.
create or replace function private.activity_invoices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_data jsonb := jsonb_build_object('number', new.number, 'total', new.total, 'balance_due', new.balance_due,
    'autopay', exists (select 1 from public.autopay_charges a where a.invoice_id = new.id and a.status <> 'called_off'));
  v_credit boolean := coalesce(new.amount_paid, 0) = 0 and coalesce(new.credit_amount, 0) > 0;
begin
  if (tg_op = 'INSERT' and new.status <> 'draft') or (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    case new.status
      when 'sent' then
        if tg_op = 'INSERT' or old.status = 'draft' then
          perform private.emit(new.company_id, 'invoice.sent', 'invoice', new.id, format('Invoice #%s sent to %s (%s)', new.number, v_client, private.money_in(new.total, private.company_currency(new.company_id))), v_data);
        end if;
      when 'paid' then
        perform private.emit(new.company_id, 'invoice.paid', 'invoice', new.id,
          case
            when v_credit then format('Invoice #%s for %s covered by a referral credit', new.number, v_client)
            when coalesce(new.amount_paid, 0) = 0 then format('Invoice #%s for %s had nothing to pay', new.number, v_client)
            else format('Invoice #%s paid by %s (%s)', new.number, v_client, private.money_in(new.total, private.company_currency(new.company_id))) end,
          v_data || jsonb_build_object('amount_paid', coalesce(new.amount_paid, 0), 'covered_by_credit', v_credit));
      when 'overdue' then
        -- Not for one owed again after being paid: the hourly run raises it the next day.
        if (tg_op = 'INSERT' or old.status <> 'written_off') and not new.past_due_notice_pending then
          perform private.emit(new.company_id, 'invoice.overdue', 'invoice', new.id, format('Invoice #%s for %s is past due (%s owing)', new.number, v_client, private.money_in(new.balance_due, private.company_currency(new.company_id))), v_data);
        end if;
      when 'written_off' then
        perform private.emit(new.company_id, 'invoice.written_off', 'invoice', new.id, format('Invoice #%s for %s written off (%s)', new.number, v_client, private.money_in(new.balance_due, private.company_currency(new.company_id))), v_data);
      else null;
    end case;
  end if;
  return null;
end $$;

-- As in 20261017000100_activity_notifications_search.sql, with the amount in the business's
-- currency.
create or replace function private.activity_payments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.amount > 0 then
    perform private.emit(new.company_id, 'payment.received', 'invoice', new.invoice_id,
      format('%s payment received from %s', private.money_in(new.amount, private.company_currency(new.company_id)), private.client_name(new.client_id)),
      jsonb_build_object('amount', new.amount, 'method', new.method, 'client_id', new.client_id));
  end if;
  return null;
end $$;

-- As in 20261025000100_contracts_and_options.sql, with the range in the business's currency.
create or replace function public.accept_hub_range(p_company uuid, p_quote uuid, p_option uuid default null)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes;
  v_option text;
begin
  select * into q from public.quotes
   where company_id = p_company and id = p_quote and status in ('sent', 'changes_requested')
     and range_low is not null and range_accepted_at is null and priced_on_site_at is null and exact_sent_at is null
   for update;
  if not found then
    return null;
  end if;
  if p_option is not null then
    select name into v_option from public.quote_options where quote_id = p_quote and id = p_option;
    if not found then
      return null;
    end if;
  end if;
  update public.quotes set range_accepted_at = now(), option_id = coalesce(p_option, option_id) where id = p_quote;
  -- Following up on the quote ("any questions about it?") would ask what they've just answered.
  update public.automation_runs r
     set status = 'cancelled', finished_at = now(), error = 'The client said yes to the price range.'
    from public.automation_rules rule
   where rule.id = r.rule_id and rule.trigger = 'quote.sent'
     and r.company_id = p_company and r.subject_type = 'quote' and r.subject_id = p_quote and r.status = 'pending';
  perform private.emit(p_company, 'quote.range_accepted', 'quote', p_quote,
    format('%s said yes to %s to %s for quote #%s', private.client_name(q.client_id),
      private.money_in(q.range_low, private.company_currency(p_company)), private.money_in(q.range_high, private.company_currency(p_company)), q.number)
      || case when v_option is not null then format(', leaning toward %s', v_option) else '' end,
    jsonb_build_object('number', q.number, 'range_low', q.range_low, 'range_high', q.range_high)
      || case when v_option is not null then jsonb_build_object('option_id', p_option, 'option', v_option) else '{}' end);
  return now();
end $$;

-- As in 20261110000300_send_check_and_follow_ups.sql, with the price in the business's currency.
create or replace function public.quote_exact_sent(p_quote uuid) returns void
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
    format('Exact price for quote #%s sent to %s (%s)', q.number, private.client_name(q.client_id), private.money_in(q.total, private.company_currency(q.company_id))),
    jsonb_build_object('number', q.number, 'total', q.total));
end $$;

-- As in 20261113001660_quote_alerts_skip_who_did_it.sql, with the amounts in the business's
-- currency.
create or replace function private.quote_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_over numeric;
  v_event text;
  v_client text;
  v_title text;
begin
  v_event := case
    when new.status = 'sent' then 'sent'
    when new.status = 'changes_requested' then 'changes_requested'
    -- Converted straight from sent (the office heard yes another way) is approved too.
    when new.status in ('approved', 'converted') and old.status not in ('approved', 'converted') then 'approved'
  end;
  if v_event is null or new.is_template or new.client_id is null then
    return null;
  end if;
  v_over := private.quote_alert_over(new.company_id);
  if v_over is null or new.total < v_over then
    return null;
  end if;
  insert into public.quote_alerts (company_id, quote_id, event, total) values (new.company_id, new.id, v_event, new.total)
  on conflict do nothing;
  if not found then
    return null;
  end if;
  v_client := private.client_name(new.client_id);
  v_title := case v_event
    when 'sent' then format('Quote #%s for %s was sent to %s', new.number, private.money_in(new.total, private.company_currency(new.company_id)), v_client)
    when 'approved' then format('%s approved quote #%s for %s', v_client, new.number, private.money_in(new.total, private.company_currency(new.company_id)))
    else format('%s asked for changes to quote #%s for %s', v_client, new.number, private.money_in(new.total, private.company_currency(new.company_id))) end;
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, u.user_id, 'quote', left(v_title, 300),
         left(format('%s. It''s at or above the %s you asked to hear about.', new.title, private.money_in(v_over, private.company_currency(new.company_id))), 1000),
         '/quotes/' || new.id
  from (
    select m.user_id from public.memberships m
     where m.company_id = new.company_id and m.active and m.role in ('owner', 'admin')
    union
    select m.user_id from public.memberships m
     where m.company_id = new.company_id and m.active and m.user_id = new.salesperson_id
  ) u
  -- Not whoever did it: they know. (The client, in the Client Hub, is nobody here.)
  where u.user_id is distinct from (select auth.uid());
  return null;
end $$;

-- As in 20261113000430_owed_again_without_chasing.sql, with the amount owing in the business's
-- currency.
create or replace function public.raise_past_due_notices() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select i.id, i.company_id, i.client_id, i.number, i.total, i.balance_due, c.currency
      from public.invoices i
      join public.companies c on c.id = i.company_id
     where i.past_due_notice_pending and i.status = 'overdue' and i.balance_due > 0
       and (i.owed_again_at at time zone coalesce(c.timezone, 'UTC'))::date < (now() at time zone coalesce(c.timezone, 'UTC'))::date
     for update of i skip locked
  loop
    update public.invoices set past_due_notice_pending = false where id = r.id;
    perform private.emit(r.company_id, 'invoice.overdue', 'invoice', r.id,
      format('Invoice #%s for %s is past due (%s owing)', r.number, private.client_name(r.client_id), private.money_in(r.balance_due, r.currency)),
      jsonb_build_object('number', r.number, 'total', r.total, 'balance_due', r.balance_due,
        'autopay', exists (select 1 from public.autopay_charges a where a.invoice_id = r.id and a.status <> 'called_off')));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- As in 20261113000440_edit_sent_invoices.sql, with the amounts in its errors and activity in the
-- business's currency.
create or replace function public.edit_invoice(p_invoice uuid, p_lines jsonb, p_preview boolean default false, p_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  n public.invoices;
  v_job uuid;
  v_job_kind text;
  v_contract numeric;
  v_number bigint;
  v_count integer;
  v_gone integer;
  v_made integer;
  v_changed integer;
  v_pre_before numeric := 0; v_held_before numeric := 0; v_kept_before numeric := 0;
  v_pre numeric := 0; v_held numeric := 0; v_kept numeric := 0;
  v_credits numeric;
  v_quote_total numeric;
  v_result jsonb;
  v_was text := coalesce(current_setting('crewtavo.invoice_edit', true), '');
begin
  -- One change to a job's invoices at a time, as when one is made (create_invoice_for_job).
  select job_id into v_job from public.invoices where id = p_invoice;
  if v_job is not null then
    perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || v_job::text, 0));
  end if;
  select * into i from public.invoices where id = p_invoice for update;
  if not found or not (private.has_role(i.company_id, '{owner,admin,office}') and private.has_perm(i.company_id, 'invoices')) then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;

  if p_updated_at is not null and i.updated_at is distinct from p_updated_at then
    raise exception 'This invoice changed while you were editing it. Close this, look at it again and make your changes once more' using errcode = '22023';
  end if;
  if i.status = 'void' then
    raise exception 'A void invoice stays as it is' using errcode = '22023';
  elsif i.status = 'written_off' then
    raise exception 'Undo the write-off before changing this invoice' using errcode = '22023';
  end if;
  if private.stripe_collects(i.id) then
    raise exception 'This invoice was made in Stripe. Make changes there' using errcode = '22023';
  end if;
  if exists (select 1 from public.autopay_charges a where a.invoice_id = i.id and a.status = 'charging' and a.claim_token is not null) then
    raise exception 'This invoice is being charged automatically right now. Try again in a few minutes' using errcode = '22023';
  end if;
  if private.bank_payment_clearing(i.id) or private.autopay_clearing(i.id) then
    raise exception 'A bank payment for this invoice is on its way. Change it once it clears or bounces' using errcode = '22023';
  end if;
  -- The job's final invoice took this one off as it stood.
  if i.status <> 'draft' and i.kind in ('deposit', 'progress') and i.job_id is not null then
    select x.number into v_number from public.invoices x
    where x.job_id = i.job_id and x.kind = 'standard' and x.status <> 'void' and x.billing_month is null and x.id <> i.id and x.created_at >= i.created_at
    order by x.number limit 1;
    if found then
      raise exception 'Invoice #% already takes this one off the job''s total. Void that invoice to change this one', v_number using errcode = '22023';
    end if;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Give the invoice''s lines' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_lines);
  if v_count > 200 then
    raise exception 'An invoice takes up to 200 lines' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where jsonb_typeof(l) <> 'object' or btrim(coalesce(l ->> 'name', '')) = '') then
    raise exception 'Every line needs a name' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l
             where length(l ->> 'name') > 300 or length(l ->> 'description') > 2000 or length(l ->> 'unit') > 30
                or abs(coalesce((l ->> 'quantity')::numeric, 1)) >= 100000000 or abs(coalesce((l ->> 'unit_price')::numeric, 0)) >= 100000000) then
    raise exception 'One of the lines is too long or too large' using errcode = '22023';
  end if;
  -- Every line named is one of this invoice's that can change, once.
  if exists (select 1 from jsonb_array_elements(p_lines) l where l ->> 'id' is not null
             and not exists (select 1 from public.invoice_line_items x where x.id = (l ->> 'id')::uuid and x.invoice_id = i.id and not private.invoice_line_locked(x)))
     or (select count(*) <> count(distinct l ->> 'id') from jsonb_array_elements(p_lines) l where l ->> 'id' is not null) then
    raise exception 'One of those lines isn''t on this invoice, or can''t be changed here. Open the invoice again and try once more' using errcode = '22023';
  end if;
  if v_count = 0 and not exists (select 1 from public.invoice_line_items x where x.invoice_id = i.id and private.invoice_line_locked(x)) then
    raise exception 'An invoice needs at least one line' using errcode = '22023';
  end if;

  if i.job_id is not null then
    select j.kind, f.contract_total into v_job_kind, v_contract
    from public.jobs j left join public.job_financials f on f.job_id = j.id where j.id = i.job_id;
    select coalesce(sum(x.subtotal) filter (where x.kind in ('deposit', 'progress')), 0),
           coalesce(sum(x.retainage_amount) filter (where x.kind <> 'retainage'), 0),
           coalesce(sum(x.subtotal) filter (where x.kind = 'retainage'), 0)
      into v_pre_before, v_held_before, v_kept_before
    from public.invoices x where x.job_id = i.job_id and x.status <> 'void';
  end if;

  -- Everything from here is undone again for a preview.
  begin
    -- How many of the lines kept change in what they say (their place aside).
    select count(*) into v_changed
    from jsonb_array_elements(p_lines) l
    join public.invoice_line_items x on x.id = (l ->> 'id')::uuid
    where (x.name, coalesce(x.description, ''), x.quantity, x.unit, x.unit_price, x.taxable)
          is distinct from (btrim(l ->> 'name'), btrim(coalesce(l ->> 'description', '')), coalesce((l ->> 'quantity')::numeric, 1)::numeric(14, 3),
                            coalesce(nullif(btrim(coalesce(l ->> 'unit', '')), ''), 'ea'), coalesce((l ->> 'unit_price')::numeric, 0)::numeric(12, 2),
                            coalesce((l ->> 'taxable')::boolean, true));

    -- One statement, so the invoice's totals and status are worked out from the lines as they end
    -- up, never from a state in between (the lines' triggers run once it's done).
    perform set_config('crewtavo.invoice_edit', 'on', true);
    with want as (
      select (x.ord - 1)::integer as sort, (x.l ->> 'id')::uuid as id, btrim(x.l ->> 'name') as name,
             nullif(btrim(coalesce(x.l ->> 'description', '')), '') as description,
             coalesce((x.l ->> 'quantity')::numeric, 1) as quantity,
             coalesce(nullif(btrim(coalesce(x.l ->> 'unit', '')), ''), 'ea') as unit,
             coalesce((x.l ->> 'unit_price')::numeric, 0) as unit_price,
             coalesce((x.l ->> 'taxable')::boolean, true) as taxable,
             (x.l ->> 'service_id')::uuid as service_id
      from jsonb_array_elements(p_lines) with ordinality x(l, ord)
    ),
    gone as (
      delete from public.invoice_line_items l
      where l.invoice_id = i.id and not private.invoice_line_locked(l) and not exists (select 1 from want w where w.id = l.id)
      returning l.id
    ),
    kept as (
      update public.invoice_line_items l
      set name = w.name, description = w.description, quantity = w.quantity, unit = w.unit, unit_price = w.unit_price, taxable = w.taxable, sort = w.sort
      from want w
      where l.id = w.id and l.invoice_id = i.id
        and (l.name, l.description, l.quantity, l.unit, l.unit_price, l.taxable, l.sort)
            is distinct from (w.name, w.description, w.quantity::numeric(14, 3), w.unit, w.unit_price::numeric(12, 2), w.taxable, w.sort)
      returning l.id
    ),
    made as (
      insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort)
      select i.company_id, i.id, w.service_id, w.name, w.description, w.quantity, w.unit, w.unit_price, w.taxable, w.sort
      from want w where w.id is null
      returning id
    ),
    -- The locked lines follow the others, in the order they were in.
    last as (
      update public.invoice_line_items l set sort = v_count + r.place
      from (select x.id, (row_number() over (order by x.sort, x.id) - 1)::integer as place
            from public.invoice_line_items x where x.invoice_id = i.id and private.invoice_line_locked(x)) r
      where l.id = r.id and l.sort is distinct from v_count + r.place
      returning l.id
    )
    select (select count(*) from gone), (select count(*) from made) into v_gone, v_made;
    perform set_config('crewtavo.invoice_edit', v_was, true);
    v_changed := v_changed + v_gone + v_made;

    select * into n from public.invoices where id = i.id;

    if n.status <> 'draft' then
      if n.amount_paid > 0 and n.balance_due < 0 and n.balance_due < i.balance_due then
        raise exception 'This invoice has % paid on it, so its total can''t go below that. Refund the difference first.', private.money_in(n.amount_paid, private.company_currency(i.company_id))
          using errcode = '22023';
      end if;
      select coalesce(sum(amount), 0) into v_credits from public.referral_credits where invoice_id = i.id;
      if v_credits > n.credit_amount and n.credit_amount < i.credit_amount then
        raise exception 'This invoice has a % referral credit on it, so its lines can''t come to less than that', private.money_in(v_credits, private.company_currency(i.company_id)) using errcode = '22023';
      end if;
      if i.job_id is not null then
        select coalesce(sum(x.subtotal) filter (where x.kind in ('deposit', 'progress')), 0),
               coalesce(sum(x.retainage_amount) filter (where x.kind <> 'retainage'), 0),
               coalesce(sum(x.subtotal) filter (where x.kind = 'retainage'), 0)
          into v_pre, v_held, v_kept
        from public.invoices x where x.job_id = i.job_id and x.status <> 'void';
        -- As create_invoice_for_job holds a new deposit or progress invoice to what's left on the job.
        if i.kind in ('deposit', 'progress') and v_job_kind <> 'recurring' and v_pre > coalesce(v_contract, 0) + 0.005 and v_pre > v_pre_before then
          raise exception 'That''s more than what''s left to bill on this job (%)',
            to_char(greatest(coalesce(v_contract, 0) - (v_pre - n.subtotal), 0), private.money_pattern(private.company_currency(i.company_id))) using errcode = '22023';
        end if;
        if v_kept > v_held + 0.005 and v_kept - v_held > v_kept_before - v_held_before then
          if i.kind = 'retainage' then
            raise exception 'That''s more than the retainage held back on this job (%)',
              to_char(greatest(v_held - (v_kept - n.subtotal), 0), private.money_pattern(private.company_currency(i.company_id))) using errcode = '22023';
          end if;
          raise exception 'This job''s retainage invoice bills what this one holds back, so its total can''t go that low. Change the retainage invoice first'
            using errcode = '22023';
        end if;
      elsif i.kind = 'deposit' then
        -- Made as the client approved, before there's a job: never more than the quote comes to.
        select q.total into v_quote_total from public.quotes q where q.deposit_invoice_id = i.id;
        if found and n.subtotal > v_quote_total + 0.005 and n.subtotal > i.subtotal then
          raise exception 'A deposit can''t be more than the quote comes to (%)', to_char(v_quote_total, private.money_pattern(private.company_currency(i.company_id))) using errcode = '22023';
        end if;
      end if;
    end if;

    v_result := jsonb_build_object('id', n.id, 'status', n.status, 'subtotal', n.subtotal, 'discount_amount', n.discount_amount, 'credit_amount', n.credit_amount,
      'tax_amount', n.tax_amount, 'total', n.total, 'retainage_amount', n.retainage_amount, 'amount_paid', n.amount_paid, 'balance_due', n.balance_due,
      'changed', v_changed, 'old_total', i.total, 'old_status', i.status);

    if p_preview then
      raise exception using errcode = 'CTPRV', message = 'preview';
    end if;

    if v_changed > 0 and n.status <> 'draft' then
      perform private.emit(i.company_id, 'invoice.edited', 'invoice', i.id,
        case when n.total = i.total
          then format('Invoice #%s for %s edited (total still %s)', i.number, private.client_name(i.client_id), private.money_in(n.total, private.company_currency(i.company_id)))
          else format('Invoice #%s for %s edited: total %s, was %s', i.number, private.client_name(i.client_id), private.money_in(n.total, private.company_currency(i.company_id)), private.money_in(i.total, private.company_currency(i.company_id))) end,
        jsonb_build_object('number', i.number, 'old_total', i.total, 'new_total', n.total, 'total', n.total, 'balance_due', n.balance_due,
          'lines_added', v_made, 'lines_removed', v_gone));
      perform private.queue_invoice_for_books(i.id);
    end if;
  exception when sqlstate 'CTPRV' then
    -- A preview: the lines are as they were, and v_result says what they'd have come to.
    null;
  end;
  return v_result;
end $$;

-- As in 20261113000420_late_fee_off_for_an_invoice.sql, with the amounts in the business's
-- currency.
create or replace function public.remove_late_fee(p_invoice uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_fee numeric;
  v_was text := coalesce(current_setting('crewtavo.late_fee', true), '');
begin
  select * into i from public.invoices where id = p_invoice for update;
  if not found or not (private.has_role(i.company_id, '{owner,admin,office}') and private.has_perm(i.company_id, 'invoices')) then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if i.status = 'void' then
    raise exception 'A void invoice stays as it is' using errcode = '22023';
  elsif i.status = 'written_off' then
    raise exception 'Undo the write-off before changing this invoice' using errcode = '22023';
  end if;
  select coalesce(sum(round(quantity * unit_price, 2)), 0) into v_fee
  from public.invoice_line_items where invoice_id = i.id and kind = 'late_fee';
  if v_fee <> 0 then
    -- The client is paying the amount with the fee in it right now.
    if exists (select 1 from public.autopay_charges a where a.invoice_id = i.id and a.status = 'charging' and a.claim_token is not null) then
      raise exception 'This invoice is being charged automatically right now. Try again in a few minutes' using errcode = '22023';
    end if;
    if private.bank_payment_clearing(i.id) or private.autopay_clearing(i.id) then
      raise exception 'A bank payment for this invoice is on its way. Remove the late fee once it clears or bounces' using errcode = '22023';
    end if;
    perform set_config('crewtavo.late_fee', 'on', true);
    delete from public.invoice_line_items where invoice_id = i.id and kind = 'late_fee';
    perform set_config('crewtavo.late_fee', v_was, true);
  end if;
  -- Its totals are worked out again with this (the line's own touch did too).
  update public.invoices set no_late_fee = true where id = i.id returning * into i;
  if v_fee <> 0 then
    if i.balance_due < 0 then
      raise exception 'This invoice has % paid on it, so its total can''t go below that. Refund the difference first.', private.money_in(i.amount_paid, private.company_currency(i.company_id))
        using errcode = '22023';
    end if;
    perform private.emit(i.company_id, 'invoice.late_fee_removed', 'invoice', i.id,
      format('%s late fee taken off invoice #%s for %s', private.money_in(v_fee, private.company_currency(i.company_id)), i.number, private.client_name(i.client_id)),
      jsonb_build_object('number', i.number, 'late_fee', v_fee, 'total', i.total, 'balance_due', i.balance_due));
  end if;
  return v_fee;
end $$;

-- As in 20261031000100_referral_credits.sql, with the credit in the business's currency.
create or replace function private.earn_referral(p_referral uuid, p_invoice uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r public.referrals;
  i public.invoices;
  v_referrer uuid;
  v_reason text;
  v_base numeric;
  v_amount numeric;
  v_applied numeric;
  v_numbers text;
  v_on_id uuid;
  v_on bigint;
  v_where text;
begin
  select referrer_client_id into v_referrer from public.referrals where id = p_referral;
  if not found then return false; end if;
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || v_referrer::text));
  select * into r from public.referrals where id = p_referral for update;
  if not found then return false; end if;
  select * into i from public.invoices where id = p_invoice;
  if not found or i.status <> 'paid' or i.client_id is distinct from r.referred_client_id then
    return false;
  end if;
  if r.status in ('new', 'quoted', 'lost') or (r.reward_status = 'none' and r.no_reward_reason = 'lost') then
    update public.referrals
       set status = 'won', lost_at = null,
           reward_status = case when reward_status = 'none' and no_reward_reason = 'lost' then 'pending' else reward_status end,
           no_reward_reason = case when reward_status = 'none' and no_reward_reason = 'lost' then null else no_reward_reason end
     where id = r.id
    returning * into r;
  end if;
  if r.reward_status <> 'pending' or i.kind not in ('standard', 'visits') then
    return false;
  end if;

  v_reason := private.referral_no_credit(r.id);
  if v_reason is not null then
    update public.referrals set reward_status = 'none', no_reward_reason = v_reason, status = 'won', lost_at = null where id = r.id;
    return false;
  end if;
  -- History brought in quietly from Stripe isn't news, and doesn't earn.
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' then
    return false;
  end if;
  v_base := coalesce(private.referral_base(i.id), 0);
  -- Nothing was charged (a promo or credit covered it all): the next paid invoice is their first.
  if v_base <= 0 then
    return false;
  end if;
  v_amount := case r.reward_kind when 'percent' then round(v_base * r.reward_value / 100, 2) else r.reward_value end;
  if v_amount <= 0 then
    update public.referrals set reward_status = 'none', no_reward_reason = 'not_set', status = 'won', lost_at = null where id = r.id;
    return false;
  end if;
  update public.referrals
     set reward_status = 'earned', reward_amount = v_amount, earned_at = now(), earned_invoice_id = i.id,
         status = 'won', lost_at = null, no_reward_reason = null
   where id = r.id;
  begin
    perform private.apply_referral_credits(r.company_id, r.referrer_client_id);
  exception when others then
    raise warning 'Referral credit % wasn''t put on an invoice: %', r.id, sqlerrm;
  end;
  -- Where it went: all of it, part of it (the rest waits for their next invoice), or none yet.
  select coalesce(sum(c.amount), 0), string_agg('#' || x.number, ', ' order by c.created_at, x.number)
    into v_applied, v_numbers
    from public.referral_credits c join public.invoices x on x.id = c.invoice_id where c.referral_id = r.id;
  select c.invoice_id, x.number into v_on_id, v_on from public.referral_credits c join public.invoices x on x.id = c.invoice_id
   where c.referral_id = r.id order by c.created_at, x.number limit 1;
  v_where := case
    when v_applied >= v_amount then format('It went on %s %s.', case when v_numbers like '%,%' then 'invoices' else 'invoice' end, v_numbers)
    when v_applied > 0 then format('%s went on %s %s, and %s goes on their next one.', private.money_in(v_applied, private.company_currency(r.company_id)),
      case when v_numbers like '%,%' then 'invoices' else 'invoice' end, v_numbers, private.money_in(v_amount - v_applied, private.company_currency(r.company_id)))
    when (select auto_apply from public.referrals where id = r.id) then 'It goes on their next invoice.'
    else 'It''s kept off invoices until someone applies it.' end;
  -- invoice_id and invoice_number are the referrer's invoice it went on first; friend_invoice_id is the one the friend paid.
  perform private.emit(r.company_id, 'referral.earned', 'client', r.referrer_client_id,
    format('%s earned a %s referral credit: %s paid their first invoice. %s', private.client_name(r.referrer_client_id), private.money_in(v_amount, private.company_currency(r.company_id)),
      coalesce(nullif(trim(r.referred_name), ''), private.client_name(r.referred_client_id)), v_where),
    jsonb_build_object('referral_id', r.id, 'friend_name', r.referred_name, 'credit', v_amount, 'applied', v_applied,
      'friend_invoice_id', i.id, 'invoice_id', v_on_id, 'invoice_number', v_on));
  return true;
end $$;

-- As in 20261031000100_referral_credits.sql, with the credit in the business's currency.
create or replace function private.unearn_referral(p_referral uuid, p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.referrals;
  v_referrer uuid;
  v_next uuid;
  c record;
  v_used numeric;
  v_used_on bigint;
  v_number bigint;
  v_friend text;
begin
  select referrer_client_id into v_referrer from public.referrals where id = p_referral;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || v_referrer::text));
  select * into r from public.referrals where id = p_referral for update;
  if not found or r.earned_invoice_id is distinct from p_invoice or r.reward_status not in ('earned', 'applied') then
    return;
  end if;
  select i.id into v_next from public.invoices i
   where i.client_id = r.referred_client_id and i.id <> p_invoice and i.status = 'paid' and i.kind in ('standard', 'visits')
     and coalesce(private.referral_base(i.id), 0) > 0
   order by i.issued_on, i.number limit 1;
  if v_next is not null then
    update public.referrals set earned_invoice_id = v_next where id = r.id;
    return;
  end if;

  v_used := r.given_amount;
  for c in
    select rc.id, rc.amount, rc.invoice_id, i.number from public.referral_credits rc join public.invoices i on i.id = rc.invoice_id
     where rc.referral_id = r.id order by rc.invoice_id
  loop
    perform 1 from public.invoices where id = c.invoice_id for update skip locked;
    if found and private.referral_credits_changeable(c.invoice_id) then
      delete from public.referral_credits where id = c.id;
    else
      v_used := v_used + c.amount;
      v_used_on := coalesce(v_used_on, c.number);
    end if;
  end loop;

  select number into v_number from public.invoices where id = p_invoice;
  v_friend := coalesce(nullif(trim(r.referred_name), ''), private.client_name(r.referred_client_id));
  if v_used <= 0 then
    update public.referrals
       set reward_status = 'pending', reward_amount = 0, earned_at = null, earned_invoice_id = null, applied_at = null
     where id = r.id;
    perform private.emit(r.company_id, 'referral.unpaid', 'client', r.referrer_client_id,
      format('%s''s invoice #%s isn''t paid anymore, so %s''s %s referral credit waits for them to pay again.',
        v_friend, v_number, private.client_name(r.referrer_client_id), private.money_in(r.reward_amount, private.company_currency(r.company_id))),
      jsonb_build_object('referral_id', r.id, 'friend_name', r.referred_name, 'credit', r.reward_amount, 'friend_invoice_id', p_invoice, 'kept', 0));
  else
    update public.referrals set auto_apply = false where id = r.id;
    perform private.emit(r.company_id, 'referral.unpaid', 'client', r.referrer_client_id,
      format('%s''s invoice #%s isn''t paid anymore, but %s of %s''s %s referral credit is used already (%s). Anything left is kept off invoices until you decide.',
        v_friend, v_number, private.money_in(v_used, private.company_currency(r.company_id)), private.client_name(r.referrer_client_id), private.money_in(r.reward_amount, private.company_currency(r.company_id)),
        case when v_used_on is not null then format('on invoice #%s', v_used_on) else 'given outside Crewtavo' end),
      jsonb_build_object('referral_id', r.id, 'friend_name', r.referred_name, 'credit', r.reward_amount, 'friend_invoice_id', p_invoice, 'kept', v_used));
  end if;
end $$;

-- As in 20261113000950_price_changes.sql, with an amount a line in the business's currency.
create or replace function private.price_change_summary(p_company uuid, p_change jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select case when (p_change ->> 'value')::numeric > 0 then 'Up ' else 'Down ' end
    || case p_change ->> 'kind'
         when 'percent' then trim(trailing '.' from trim(trailing '0' from to_char(abs((p_change ->> 'value')::numeric), 'FM999990.0000'))) || '%'
         else private.money_in(abs((p_change ->> 'value')::numeric), private.company_currency(p_company)) || ' a line' end
    || case p_change ->> 'round' when 'dollar' then ', rounded to the dollar' when 'half' then ', rounded to 50 cents' else '' end
    || coalesce(', on ' || (select s.name from public.services s where s.company_id = p_company and s.id = nullif(p_change ->> 'line_service_id', '')::uuid) || ' lines', '')
$$;

-- As in 20261113000950_price_changes.sql, with the prices in the business's currency.
create or replace function public.apply_price_change(p_company uuid, p_id uuid, p_change jsonb, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_what jsonb := p_change - 'jobs';
  v_currency text := (select c.currency from public.companies c where c.id = p_company);
  v_jobs uuid[];
  v_given integer;
  v_done integer;
  v_change public.price_changes;
  v_new uuid[];
  v_bad bigint;
  v_summary text;
  r record;
begin
  perform private.price_change_allowed(p_company);
  perform private.price_change_checked(p_change);
  if p_id is null or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Preview the change first' using errcode = '22023';
  end if;
  -- One change at a time for a company, so two people's changes don't cross.
  perform pg_advisory_xact_lock(hashtextextended('price-change:' || p_company::text, 0));

  select * into v_change from public.price_changes where id = p_id;
  if found and (v_change.company_id <> p_company or v_change.undone_at is not null or v_change.change <> v_what) then
    raise exception 'That change was already made or undone. Preview it again' using errcode = '22023';
  end if;

  select count(*), count(*) filter (where exists (select 1 from public.price_change_lines l where l.change_id = p_id and l.line_id = g.line_id))
    into v_given, v_done
  from jsonb_to_recordset(p_lines) g (line_id uuid, old_price numeric, new_price numeric);
  if v_done > 0 and v_done = v_given then
    -- This group, sent again after its answer was lost.
    return jsonb_build_object('jobs', (select count(distinct l.job_id) from public.price_change_lines l where l.change_id = p_id
                                        and l.line_id in (select g.line_id from jsonb_to_recordset(p_lines) g (line_id uuid))),
                              'lines', v_done, 'again', true);
  end if;

  select array_agg(distinct li.job_id) into v_jobs
  from jsonb_to_recordset(p_lines) g (line_id uuid, old_price numeric, new_price numeric)
  join public.job_line_items li on li.id = g.line_id
  join public.jobs j on j.id = li.job_id and j.company_id = p_company;
  if v_jobs is null then
    raise exception 'Something changed since the preview. Preview again, then apply' using errcode = '22023';
  end if;
  -- Held while they're compared and changed.
  perform 1 from public.job_line_items li where li.job_id = any (v_jobs) for update;

  select max(coalesce(j.number, 0)) into v_bad
  from private.price_change_reach(p_company, p_change, v_jobs) e
  full join jsonb_to_recordset(p_lines) g (line_id uuid, old_price numeric, new_price numeric) on g.line_id = e.line_id
  left join public.jobs j on j.id = e.job_id
  where e.line_id is null or g.line_id is null or g.old_price is distinct from e.old_price or g.new_price is distinct from e.new_price;
  if v_bad is not null then
    raise exception 'Something changed since the preview%. Preview again, then apply',
      case when v_bad > 0 then ' (job #' || v_bad || ')' else '' end using errcode = '22023';
  end if;

  v_summary := private.price_change_summary(p_company, p_change);
  insert into public.price_changes (id, company_id, change, summary, created_by)
  values (p_id, p_company, v_what, v_summary, (select auth.uid()))
  on conflict (id) do nothing;

  with added as (
    insert into public.price_change_lines (company_id, change_id, job_id, line_id, name, quantity, old_price, new_price)
    select p_company, p_id, e.job_id, e.line_id, e.name, e.quantity, e.old_price, e.new_price
    from private.price_change_reach(p_company, p_change, v_jobs) e
    returning id
  )
  select array_agg(id) into v_new from added;
  update public.job_line_items li set unit_price = l.new_price
  from public.price_change_lines l where l.id = any (v_new) and li.id = l.line_id;
  update public.price_changes set jobs = jobs + cardinality(v_jobs), lines = lines + cardinality(v_new) where id = p_id;

  -- Each job's activity: what its price was and is, and each line's.
  for r in
    select j.id, j.number, j.client_id, case when j.pricing = 'fixed' then 'a month' else 'a visit' end as per,
           (select coalesce(sum(round(li.quantity * li.unit_price, 2)), 0) from public.job_line_items li
             where li.job_id = j.id and li.discount_billing is distinct from 'once') as now_price,
           sum(round(l.quantity * l.new_price, 2) - round(l.quantity * l.old_price, 2)) as delta,
           string_agg(l.name || ' ' || private.money_in(l.old_price, v_currency) || ' to ' || private.money_in(l.new_price, v_currency), ', ' order by l.name) as lines_text,
           jsonb_agg(jsonb_build_object('line_id', l.line_id, 'name', l.name, 'old_price', l.old_price, 'new_price', l.new_price) order by l.name) as lines
    from public.price_change_lines l join public.jobs j on j.id = l.job_id
    where l.id = any (v_new)
    group by j.id
  loop
    perform private.emit(p_company, 'job.prices_changed', 'job', r.id,
      format('Prices changed on job #%s for %s: %s to %s %s (%s)', r.number, private.client_name(r.client_id),
             private.money_in(r.now_price - r.delta, v_currency), private.money_in(r.now_price, v_currency), r.per, r.lines_text),
      jsonb_build_object('number', r.number, 'change_id', p_id, 'change', v_summary, 'old_price', r.now_price - r.delta, 'new_price', r.now_price, 'lines', r.lines));
  end loop;
  return jsonb_build_object('jobs', cardinality(v_jobs), 'lines', cardinality(v_new));
end $$;

-- As in 20261113000950_price_changes.sql, with the price in the business's currency.
create or replace function public.undo_price_change(p_company uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_change public.price_changes;
  v_currency text := (select c.currency from public.companies c where c.id = p_company);
  v_invoice bigint;
  v_restored integer;
  v_lines integer;
  r record;
begin
  perform private.price_change_allowed(p_company);
  perform pg_advisory_xact_lock(hashtextextended('price-change:' || p_company::text, 0));
  select * into v_change from public.price_changes where id = p_id and company_id = p_company for update;
  if not found then
    raise exception 'That price change wasn''t found' using errcode = 'P0002';
  end if;
  if v_change.undone_at is not null then
    raise exception 'That price change was already undone' using errcode = '22023';
  end if;
  v_invoice := private.price_change_invoiced(p_id);
  if v_invoice is not null then
    raise exception 'Invoice #% was made at the new prices, so this change can''t be undone. Change prices again to move them back', v_invoice using errcode = '22023';
  end if;

  with back as (
    update public.job_line_items li set unit_price = l.old_price
    from public.price_change_lines l
    where l.change_id = p_id and li.id = l.line_id and li.unit_price = l.new_price
    returning l.id
  ),
  marked as (
    update public.price_change_lines l set restored_at = now() where l.id in (select id from back) returning 1
  )
  select count(*) into v_restored from marked;
  select count(*) into v_lines from public.price_change_lines where change_id = p_id;
  update public.price_changes set undone_at = now(), undone_by = (select auth.uid()) where id = p_id;

  for r in
    select j.id, j.number, j.client_id, case when j.pricing = 'fixed' then 'a month' else 'a visit' end as per,
           (select coalesce(sum(round(li.quantity * li.unit_price, 2)), 0) from public.job_line_items li
             where li.job_id = j.id and li.discount_billing is distinct from 'once') as now_price
    from public.jobs j
    where j.id in (select l.job_id from public.price_change_lines l where l.change_id = p_id and l.restored_at is not null)
  loop
    perform private.emit(p_company, 'job.prices_changed', 'job', r.id,
      format('Price change undone on job #%s for %s: back to %s %s', r.number, private.client_name(r.client_id), private.money_in(r.now_price, v_currency), r.per),
      jsonb_build_object('number', r.number, 'change_id', p_id, 'undone', true, 'new_price', r.now_price));
  end loop;
  return jsonb_build_object('restored', v_restored, 'left', v_lines - v_restored);
end $$;

-- As in 20261116000100_bank_charges_over_the_limit_go_to_the_client.sql, with the amounts in the
-- business's currency.
create or replace function public.request_manual_charges(p_company uuid, p_invoices uuid[], p_amounts numeric[])
returns table (invoice_id uuid, outcome text, reason text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_currency text := (select c.currency from public.companies c where c.id = p_company);
  v_on boolean;
  v_id uuid;
  v_amount numeric;
  v_live text;
  v_detail text;
  v_pm uuid;
  v_charge uuid;
  v_bank_limit numeric;
  i public.invoices;
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'invoices')) then
    raise exception 'Only the office with the invoices area can do that' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_invoices), 0) > 50 then
    raise exception 'Choose up to 50 invoices at a time' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_amounts), 0) <> coalesce(cardinality(p_invoices), 0) then
    raise exception 'Send the amount you saw for each invoice' using errcode = '22023';
  end if;
  v_on := private.manual_charges_on(p_company);

  for v_id, v_amount in
    select x.u, x.a from (
      select distinct on (t.u) t.u, t.a, t.n from unnest(p_invoices, p_amounts) with ordinality t(u, a, n) where t.u is not null order by t.u, t.n
    ) x order by x.n
  loop
    invoice_id := v_id;
    reason := null;
    -- Locked, so two presses at once queue one charge.
    select * into i from public.invoices x where x.id = v_id and x.company_id = p_company for update;
    if not found then
      outcome := 'not_found';
      reason := 'Invoice not found';
    elsif not v_on then
      outcome := 'autopay_off';
      reason := case when exists (select 1 from public.companies c where c.id = p_company and private.autopay_of(c.settings) -> 'enabled' = 'true'::jsonb)
        then 'Update your Stripe key on the Apps page' else 'Turn on autopay in Settings → Payments' end;
    elsif i.status not in ('draft', 'sent', 'partially_paid', 'overdue') or i.balance_due <= 0 then
      outcome := 'not_owed';
      reason := case i.status when 'paid' then 'It''s paid' when 'void' then 'It was voided' when 'written_off' then 'It was written off' else 'Nothing is owed on it' end;
    elsif private.stripe_collects(i.id) then
      outcome := 'not_owed';
      reason := 'It was made in Stripe. Charge it there';
    else
      select l.live_status, l.live_detail into v_live, v_detail from private.live_charge(i.id) l;
      v_pm := private.autopay_ready(p_company, i.client_id);
      v_bank_limit := private.autopay_bank_limit(p_company, i.client_id, v_pm);
      if v_live is not null then
        outcome := 'in_progress';
        reason := v_detail;
      elsif v_pm is null then
        outcome := 'no_card';
        reason := case
          when exists (select 1 from public.autopay_authorizations a where a.company_id = p_company and a.client_id = i.client_id and a.revoked_at is null and a.paused_at is not null)
            then 'Autopay is paused for this client'
          when exists (select 1 from public.autopay_authorizations a where a.company_id = p_company and a.client_id = i.client_id and a.revoked_at is null)
            then 'The client''s card needs updating'
          else 'No saved card the client agreed to' end;
      -- A bank account is never charged more than its limit, whoever asks.
      elsif i.balance_due > v_bank_limit then
        outcome := 'bank_limit';
        reason := format('It''s over the %s limit for their bank account, so it isn''t taken from it. Send it to them to pay', private.money_in(v_bank_limit, v_currency));
      -- The office confirmed an amount: a line changed since (or a payment) asks them again.
      elsif round(v_amount, 2) is distinct from i.balance_due then
        outcome := 'changed';
        reason := format('The amount changed to %s. Check it and try again', private.money_in(i.balance_due, v_currency));
      else
        insert into public.autopay_charges (company_id, client_id, source, invoice_id, payment_method_id, due_at, status,
          approved_by, approved_at, approved_amount, requested_by)
        values (p_company, i.client_id, 'manual', i.id, v_pm, now(), 'waiting', v_user, now(), i.balance_due, v_user)
        returning id into v_charge;
        perform private.emit(p_company, 'autopay.charge_requested', 'invoice', i.id,
          format('Charging %s to %s''s %s for invoice #%s', private.money_in(i.balance_due, v_currency), private.client_name(i.client_id), private.method_label_of(v_pm), i.number),
          jsonb_build_object('charge_id', v_charge, 'number', i.number, 'amount', i.balance_due, 'card', private.method_label_of(v_pm),
            'client_id', i.client_id, 'requested_by', v_user));
        outcome := 'queued';
      end if;
    end if;
    return next;
  end loop;
end $$;

-- As in 20261116000100_bank_charges_over_the_limit_go_to_the_client.sql, with the day of the next
-- try and the amount in the business's country's way and currency.
create or replace function private.autopay_charge_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_link text := case when new.invoice_id is not null then '/invoices/' || new.invoice_id else '/clients/' || new.client_id end;
  v_tz text;
  v_card text := private.method_label_of(new.payment_method_id);
  v_bank boolean;
  v_body text;
  i public.invoices;
begin
  if new.invoice_id is not null then
    select * into i from public.invoices where id = new.invoice_id;
  end if;
  select coalesce(c.timezone, 'UTC') into v_tz from public.companies c where c.id = new.company_id;

  if new.status = 'paid' and (old.status = 'processing'
                              or (old.status = 'charging' and (old.claim_token is not null or old.busy_since is null))) then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'autopay.receipt', jsonb_build_object('charge_id', new.id));

  elsif new.status in ('failed', 'needs_client')
        and (new.failures > old.failures or (new.status = 'needs_client' and old.status in ('charging', 'processing'))) then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'autopay.notice', jsonb_build_object('charge_id', new.id, 'status', new.status, 'failures', new.failures));
    if new.status = 'failed' then
      perform private.autopay_notify(new.company_id, format('Autopay failed: %s', v_client),
        format('Invoice #%s · %s. We''ll try again on %s.', i.number, rtrim(coalesce(new.last_error, 'The card was declined'), '.'),
               private.date_text(new.due_at at time zone v_tz, 'Mon FMDD', private.company_country(new.company_id))),
        v_link);
    else
      v_bank := old.status = 'processing'
        or exists (select 1 from public.client_payment_methods pm where pm.id = new.payment_method_id and pm.type = 'us_bank_account');
      v_body := case
        when new.failures > old.failures and v_bank then 'Their bank payment didn''t go through, so autopay is paused until they update it.'
        when new.failures > old.failures and new.source = 'manual' then 'The card was declined, so they were sent the Pay link and a way to update their card.'
        when new.failures > old.failures then 'The card was declined twice, so autopay is paused until they update it.'
        when new.last_error is null or new.decline_code in ('authentication_required', 'invoice_payment_intent_requires_action', 'requires_action')
          then 'Their bank wants them to confirm the payment.'
        else new.last_error
      end;
      perform private.autopay_notify(new.company_id, format('Autopay needs %s', v_client), v_body, v_link);
    end if;
    if new.invoice_id is not null then
      perform private.emit(new.company_id, 'autopay.failed', 'invoice', new.invoice_id,
        format('Autopay failed for invoice #%s (%s)', i.number, v_client),
        jsonb_build_object('client_id', new.client_id, 'card', v_card, 'reason', new.last_error, 'status', new.status));
    end if;

  elsif new.status = 'needs_approval' then
    perform private.autopay_notify(new.company_id, format('Approve a %s charge for %s', private.money_in(i.balance_due, private.company_currency(new.company_id)), v_client),
      coalesce(new.last_error, 'It''s over your autopay limit, so it waits for your OK.'), v_link);

  elsif new.status = 'called_off' and new.bank_limit is not null then
    if i.id is not null and i.balance_due > 0 and i.status in ('draft', 'sent', 'partially_paid', 'overdue') then
      perform private.autopay_enqueue_stripe(new.company_id, new.invoice_id);
    end if;

  elsif new.status = 'called_off' and new.invoice_id is not null and i.id is not null
        and new.last_error is distinct from 'The invoice was deleted' then
    if i.status = 'draft' then
      perform private.autopay_enqueue_stripe(new.company_id, new.invoice_id);
      if new.last_error is null or new.last_error not in ('Called off by the office', 'The invoice went back to draft') then
        perform private.autopay_notify(new.company_id, format('Send invoice #%s to %s the usual way', i.number, v_client), new.last_error, v_link);
      end if;
    elsif i.status in ('sent', 'partially_paid', 'overdue') and i.balance_due > 0 and new.last_error is distinct from 'Paid another way' then
      perform private.autopay_enqueue_stripe(new.company_id, new.invoice_id);
      if new.last_error is null or new.last_error not in ('Called off by the office', 'Sent the usual way') then
        perform private.autopay_notify(new.company_id, format('Invoice #%s for %s wasn''t charged', i.number, v_client),
          format('%s. It''s owed as usual; send a reminder if they need the Pay link.', rtrim(coalesce(new.last_error, 'Autopay was called off'), '.')), v_link);
      end if;
    end if;
  end if;
  return null;
end $$;

-- As in 20261116000100_bank_charges_over_the_limit_go_to_the_client.sql, with the amounts in the
-- business's currency.
create or replace function private.autopay_to_client(p_charge uuid, p_limit numeric, p_look text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
  i public.invoices;
begin
  select * into r from public.autopay_charges where id = p_charge;
  select * into i from public.invoices where id = r.invoice_id and balance_due > 0 and status in ('draft', 'sent', 'partially_paid', 'overdue');
  update public.autopay_charges a
  set status = 'called_off', last_error = private.autopay_bank_limit_reason(), bank_limit = p_limit, bank_limit_at = now(),
      send_state = case when i.id is null then null when p_look is not null then 'held' else 'waiting' end,
      send_draft = i.status = 'draft', send_error = left(rtrim(btrim(p_look), '.'), 500),
      send_claimed_at = null, claim_token = null, locked_until = null, busy_since = null
  where a.id = p_charge;
  if i.id is not null and p_look is not null then
    perform private.autopay_notify(r.company_id, format('Send invoice #%s to %s', i.number, private.client_name(r.client_id)),
      format('%s is over the %s limit for their bank account, so it wasn''t taken from it. Look it over before you send it: %s.',
             private.money_in(i.balance_due, private.company_currency(r.company_id)), private.money_in(p_limit, private.company_currency(r.company_id)), rtrim(btrim(p_look), '.')),
      '/invoices/' || i.id);
  end if;
  return jsonb_build_object('outcome', 'called_off', 'reason', private.autopay_bank_limit_reason(), 'invoice_id', r.invoice_id, 'to_client', true);
end $$;

-- As in 20261116000100_bank_charges_over_the_limit_go_to_the_client.sql, with the amounts in the
-- business's currency.
create or replace function public.autopay_sent(p_charge uuid, p_sent boolean, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
  i public.invoices;
  v_why text;
begin
  update public.autopay_charges
  set send_state = case when p_sent then 'sent' else 'failed' end,
      send_error = case when p_sent then null else left(coalesce(nullif(rtrim(btrim(p_error), '.'), ''), 'It couldn''t be sent'), 500) end
  where id = p_charge and send_state = 'sending'
  returning * into r;
  if not found then
    return;
  end if;
  select * into i from public.invoices where id = r.invoice_id;
  if i.id is null then
    return;
  end if;
  v_why := format('%s is over the %s limit for their bank account, so it wasn''t taken from it.', private.money_in(i.balance_due, private.company_currency(r.company_id)), private.money_in(r.bank_limit, private.company_currency(r.company_id)));
  if p_sent then
    perform private.autopay_notify(r.company_id, format('Invoice #%s went to %s to pay', i.number, private.client_name(r.client_id)),
      v_why || ' They were sent the invoice to pay themselves.', '/invoices/' || i.id);
  else
    perform private.autopay_notify(r.company_id, format('Send invoice #%s to %s', i.number, private.client_name(r.client_id)),
      v_why || format(' It couldn''t be sent to them (%s), so send it from the invoice.', r.send_error), '/invoices/' || i.id);
  end if;
end $$;

-- As in 20261113000410_deposit_invoice_at_every_approval.sql, with the deposit in the business's
-- currency.
create or replace function private.deposit_unpaid_notify(p_quote uuid, p_title text, p_body text) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select q.company_id, u, 'invoice',
         left(format(p_title, coalesce(nullif(private.client_name(q.client_id), ''), 'The client'), private.money_in(i.balance_due, c.currency), q.number), 300),
         format(p_body, i.number), '/invoices/' || i.id
  from public.quotes q
  join public.invoices i on i.id = q.deposit_invoice_id
  join public.companies c on c.id = q.company_id
  cross join lateral private.money_office(q.company_id) u
  where q.id = p_quote
$$;

-- As in 20261113001630_schedule_or_visit_by_visit.sql, with the amount in the business's currency.
create or replace function private.make_installment(p_installment uuid, p_by_hand boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.job_installments;
  j public.jobs;
  v_invoice uuid;
  v_existing bigint;
  v_name text;
  v_total numeric;
  v_number bigint;
  v_kind text;
begin
  select * into s from public.job_installments where id = p_installment for update;
  if not found then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  select * into j from public.jobs where id = s.job_id;
  v_name := private.installment_name(s.position, s.count);
  select i.number into v_existing from public.invoices i where i.id = s.invoice_id and i.status <> 'void';
  if found then
    if p_by_hand then
      raise exception '% is on invoice #% already', v_name, v_existing using errcode = '22023';
    end if;
    return null;
  end if;
  if not p_by_hand and s.made_at is not null then
    return null;
  end if;
  -- A job invoiced visit by visit, or by the month, bills its work that way: a payment of the old
  -- schedule on top would bill it twice. (private.job_billing_keeps_schedule doesn't let a job get
  -- here with payments to come; this is for one that did before it.)
  if j.kind = 'recurring' or j.billing_mode in ('per_visit', 'fixed_schedule') then
    if p_by_hand then
      raise exception 'This job is invoiced %, so its payment schedule no longer applies', case when j.billing_mode = 'per_visit' then 'after each visit' else 'as repeating work' end
        using errcode = '22023';
    end if;
    update public.job_installments set made_at = now(), problem = 'Not made: this job is invoiced visit by visit now' where id = s.id;
    return null;
  end if;
  -- A final invoice bills everything left as it's made, so nothing follows it. (A payment without an
  -- invoice here had one of its own that was voided after: the final invoice took that one off.)
  select i.number into v_existing from public.invoices i where i.job_id = j.id and i.kind = 'standard' and i.status <> 'void' order by i.number limit 1;
  if found then
    if p_by_hand then
      raise exception 'This job has its final invoice (#%), which bills what''s left. Void it first to invoice % by itself', v_existing, lower(left(v_name, 1)) || substr(v_name, 2)
        using errcode = '22023';
    end if;
    update public.job_installments set made_at = now() where id = s.id;
    return null;
  end if;

  -- The last payment without an invoice is the job's final invoice, which takes off the others and
  -- carries the tax, so it comes to what's left of the quote's total: its own amount. Any other is
  -- an invoice on account for exactly its amount: a deposit for the one due at approval, as always.
  v_kind := case when not exists (select 1 from private.unbilled_installments(j.id) x where x.id <> s.id) then 'standard'
                 when s.due = 'approval' then 'deposit' else 'progress' end;
  begin
    if v_kind <> 'standard' and s.amount <= 0 then
      raise exception 'It comes to $0.00, so there''s nothing to invoice' using errcode = '22023';
    end if;
    perform set_config('crewtavo.installment', s.id::text, true);
    v_invoice := public.create_invoice_for_job(j.id, v_kind, case when v_kind <> 'standard' then s.amount end);
    perform set_config('crewtavo.installment', '', true);
  exception when sqlstate '22023' or sqlstate 'P0002' then
    if p_by_hand then
      raise;
    end if;
    update public.job_installments set made_at = now(), problem = left(sqlerrm, 500) where id = s.id;
    perform private.job_notify(j.company_id, j.id, format('%s for job #%s couldn''t be invoiced', v_name, j.number),
      left(sqlerrm, 300) || '. Invoice it from the job when it''s sorted out.');
    return null;
  end;
  update public.invoices set subject = left(v_name || ': ' || j.title, 200) where id = v_invoice
  returning total, number into v_total, v_number;
  update public.job_installments
     set invoice_id = v_invoice, made_at = coalesce(made_at, now()), problem = null, send_error = null, send_claimed_at = null,
         send_state = case when not p_by_hand and private.sends_installments(j.company_id) then 'waiting' end
   where id = s.id;
  if not p_by_hand and not private.sends_installments(j.company_id) then
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select j.company_id, u, 'invoice', left(format('%s for job #%s is ready to send', v_name, j.number), 300),
           format('Invoice #%s for %s to %s is in Drafts.', v_number, private.money_in(v_total, private.company_currency(j.company_id)), private.client_name(j.client_id)),
           '/invoices/' || v_invoice
    from private.money_office(j.company_id) u;
  end if;
  return v_invoice;
end $$;

-- As in 20261113001630_schedule_or_visit_by_visit.sql, with the amounts in the business's currency.
create or replace function private.unmade_installments_text(p_job uuid) returns text
language sql stable security definer set search_path = '' as $$
  select string_agg(private.installment_name(s.position, s.count) || ' (' || private.money_in(s.amount, c.currency) || ')', ', ' order by s.position)
  from private.unbilled_installments(p_job) s
  join public.companies c on c.id = s.company_id
$$;

-- As in 20261113001690_dated_payments_wait_for_their_day.sql, with the payment's amount and day in
-- the business's currency and country's way.
create or replace function private.installments_wait_for_their_day(p_job uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when bool_and(s.due = 'date' and s.due_on > private.company_today(s.company_id))
              then (select format('%s (%s) is due on %s and is invoiced by itself that day. To bill it sooner, use Invoice now on the job''s payment schedule',
                                  private.installment_name(x.position, x.count), private.money_in(x.amount, private.company_currency(x.company_id)), private.date_text(x.due_on, 'Mon FMDD, YYYY', private.company_country(x.company_id)))
                      from private.unbilled_installments(p_job) x order by x.due_on, x.position limit 1) end
    from private.unbilled_installments(p_job) s
$$;

-- As in 20261113001100_payment_schedules.sql, in the business's currency (`p_currency`). The one
-- without a currency stays, as the release before this one has it.
create function private.schedule_problem(p_rows jsonb, p_total numeric, p_currency text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_problem text := private.schedule_shape_problem(p_rows);
  v_left numeric;
begin
  if v_problem is not null or p_rows is null or jsonb_array_length(p_rows) = 0 then
    return v_problem;
  end if;
  v_left := private.schedule_left(p_rows, p_total);
  if p_rows -> -1 ->> 'kind' = 'rest' then
    return case when v_left >= 0.005 then null
      else 'The payments before the last come to the whole total, so nothing is left for the rest.' end;
  end if;
  if abs(v_left) < 0.005 then
    return null;
  end if;
  return case when v_left > 0 then 'The payments come to ' || private.money_in(round(v_left, 2), p_currency) || ' less than the total.'
    else 'The payments come to ' || private.money_in(round(-v_left, 2), p_currency) || ' more than the total.' end;
end $$;
revoke all on function private.schedule_problem(jsonb, numeric, text) from public;
grant execute on function private.schedule_problem(jsonb, numeric, text) to authenticated, service_role;

-- As in 20261113001640_schedule_dates.sql, with the day in the business's country's way
-- (`p_country`). The one without a country stays, as the release before this one has it.
create function private.schedule_date_problem(p_rows jsonb, p_today date, p_country text) returns text
language sql stable set search_path = '' as $$
  select case when coalesce(e.value ->> 'on', '') = '' then 'Payment ' || e.i || ' needs its date.'
              else 'Payment ' || e.i || ' is due on ' || private.date_text((e.value ->> 'on')::date, 'Mon FMDD, YYYY', p_country) || ', which has already passed. Give it a new date.' end
    from jsonb_array_elements(case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end) with ordinality e (value, i)
   where e.value ->> 'due' = 'date'
     and (e.value -> 'after' is null or jsonb_typeof(e.value -> 'after') = 'null')
     and (coalesce(e.value ->> 'on', '') = '' or (p_today is not null and (e.value ->> 'on')::date < p_today))
   order by e.i limit 1
$$;
revoke all on function private.schedule_date_problem(jsonb, date, text) from public;
grant execute on function private.schedule_date_problem(jsonb, date, text) to authenticated, service_role;

-- private.schedule_problem is the signed-in person's to call (20261113001100_payment_schedules.sql),
-- and so are the checks it makes with: they only read the schedule they're given. (The quote's
-- trigger, which runs as the database, used to call it first in the same transaction, which is all
-- that let a person's own call through.)
grant execute on function private.schedule_shape_problem(jsonb), private.schedule_left(jsonb, numeric) to authenticated, service_role;

-- As in 20261113001640_schedule_dates.sql, with its problems in the business's currency and
-- country's way.
create or replace function private.quote_payment_schedule() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_problem text;
  v_first jsonb;
  v_amounts jsonb;
  v_today date;
begin
  if jsonb_typeof(new.payment_schedule) = 'array' and jsonb_array_length(new.payment_schedule) = 0 then
    new.payment_schedule := null;
  end if;
  if tg_op = 'INSERT' or new.payment_schedule is distinct from old.payment_schedule then
    if tg_op = 'UPDATE' and old.status in ('approved', 'converted') then
      raise exception 'This quote was approved, so its payment schedule stays as it was signed.' using errcode = '22023';
    end if;
    if new.payment_schedule is not null then
      v_problem := private.schedule_shape_problem(new.payment_schedule);
      if v_problem is not null then
        raise exception '%', v_problem using errcode = '22023';
      end if;
      if new.change_order_for is not null then
        raise exception 'A change order is billed with its job, so it has no payment schedule of its own.' using errcode = '22023';
      end if;
      if new.recurrence_rule is not null then
        raise exception 'Repeating work is billed by the visit or the month, so it has no payment schedule.' using errcode = '22023';
      end if;
      -- A new quote has no lines yet (a copy gets its lines after): its total is checked once it's edited.
      if tg_op = 'UPDATE' then
        v_problem := private.schedule_problem(new.payment_schedule, new.total, private.company_currency(new.company_id));
        if v_problem is not null then
          raise exception '%', v_problem using errcode = '22023';
        end if;
      end if;
    end if;
  end if;
  if new.payment_schedule is not null and (new.recurrence_rule is not null or new.change_order_for is not null) then
    raise exception 'A quote with a payment schedule is for one-time work. Take the schedule off first.' using errcode = '22023';
  end if;

  -- Going to the client (sent, or sent again after changes, or its schedule changed while it's with
  -- them): every dated payment has its date, and none is a day already gone.
  if new.payment_schedule is not null and new.status = 'sent' and not new.is_template
     and (tg_op = 'INSERT' or old.status is distinct from 'sent' or new.payment_schedule is distinct from old.payment_schedule) then
    v_problem := private.schedule_date_problem(new.payment_schedule, private.company_today(new.company_id), private.company_country(new.company_id));
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '22023';
    end if;
  end if;

  if new.payment_schedule is not null then
    v_amounts := private.schedule_amounts(new.payment_schedule, new.total);
    -- The deposit is the payment due at approval: as a percent when it's one, so it follows the
    -- total as the client picks options; none without one.
    select e.value into v_first from jsonb_array_elements(v_amounts) e where e.value ->> 'due' = 'approval' limit 1;
    if v_first is null then
      new.deposit_amount := 0;
      new.deposit_percent := null;
    else
      new.deposit_amount := (v_first ->> 'amount')::numeric;
      new.deposit_percent := case when v_first ->> 'kind' = 'percent' and jsonb_array_length(v_amounts) > 1 then round((v_first ->> 'value')::numeric, 2) end;
    end if;
    -- Approved (by any path, any server): each payment's amount for the total signed is kept.
    -- A payment due so many days after approval gets its day now, counted from today where the
    -- company is; one whose date was never set can't be signed. (A date that has passed since the
    -- quote was sent stays as the client saw it: it's due at once.)
    if tg_op = 'UPDATE' and new.status in ('approved', 'converted') and old.status not in ('approved', 'converted') then
      v_today := private.company_today(new.company_id);
      v_problem := private.schedule_date_problem(new.payment_schedule, null, private.company_country(new.company_id));
      if v_problem is not null then
        raise exception '%', v_problem using errcode = '22023';
      end if;
      select jsonb_agg(case when e.value ->> 'due' = 'date' and jsonb_typeof(e.value -> 'after') = 'number'
                            then e.value || jsonb_build_object('on', (v_today + (e.value ->> 'after')::integer)::text) else e.value end order by e.i)
        into v_amounts from jsonb_array_elements(v_amounts) with ordinality e (value, i);
      new.approval := coalesce(new.approval, '{}') || jsonb_build_object('payment_schedule', v_amounts);
    end if;
  end if;
  return new;
end $$;

-- As in 20261113001640_schedule_dates.sql, with the day in the business's country's way.
create or replace function public.quote_send_problem(p_quote uuid) returns text
language sql stable security invoker set search_path = '' as $$
  select private.schedule_date_problem(q.payment_schedule, private.company_today(q.company_id), private.company_country(q.company_id))
    from public.quotes q where q.id = p_quote and q.payment_schedule is not null and q.status not in ('approved', 'converted')
$$;

-- As in 20261017001900_equipment.sql, with the day it's due in the business's country's way.
create or replace function public.emit_equipment_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; v_sent integer := 0; v_title text; v_body text; v_at text;
begin
  -- Schedules back to "ok" without service (say the interval changed) can alert again later.
  update public.equipment_plans p set alerted_state = null
  where p.alerted_state is not null
    and not exists (select 1 from public.equipment_due d where d.plan_id = p.id and d.state <> 'ok');

  for r in
    select d.*, p.alerted_state
    from public.equipment_due d
    join public.equipment_plans p on p.id = d.plan_id
    where d.equipment_status = 'active' and d.state <> 'ok'
      and (p.alerted_state is null or (d.state = 'overdue' and p.alerted_state <> 'overdue'))
    for update of p skip locked
  loop
    v_title := format('%s is %s on %s', r.name, case r.state when 'overdue' then 'overdue' else 'coming due' end, r.equipment_name);
    -- "Due Oct 20 or at 1,250 hours (now 1,262)"
    v_at := case when r.next_due_meter is not null then format('at %s %s', rtrim(to_char(r.next_due_meter, 'FM999,999,990.9'), '.'), r.meter) end;
    v_body := 'Due ' || concat_ws(' or ', private.date_text(r.next_due_on, 'Mon FMDD', private.company_country(r.company_id)), v_at)
      || case when v_at is not null and r.meter_reading is not null then format(' (now %s)', rtrim(to_char(r.meter_reading, 'FM999,999,990.9'), '.')) else '' end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select r.company_id, m.user_id, 'equipment', v_title, v_body, '/equipment/' || r.equipment_id
    from public.memberships m
    left join public.company_roles cr on cr.id = m.role_id
    where m.company_id = r.company_id and m.active
      and 'equipment' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
      and (m.role in ('owner', 'admin', 'office', 'estimator')
           or (m.role = 'crew_lead' and r.crew_id is not null
               and exists (select 1 from public.crew_members cm where cm.crew_id = r.crew_id and cm.user_id = m.user_id)));
    update public.equipment_plans set alerted_state = r.state where id = r.plan_id;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;

-- As in 20261109000100_equipment_paperwork.sql, with the day it's good through in the business's
-- country's way.
create or replace function public.emit_equipment_document_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_sent integer := 0;
  v_when text;
begin
  for r in
    select d.id, d.company_id, d.equipment_id, d.kind, d.name, d.expires_on, x.days_left, private.sub_alert_due(x.days_left) as due,
           e.name as equipment_name, e.crew_id, c.country
    from public.equipment_documents d
    join public.equipment e on e.id = d.equipment_id
    join public.companies c on c.id = d.company_id
    cross join lateral (select d.expires_on - (now() at time zone coalesce(c.timezone, 'UTC'))::date as days_left) x
    where e.status <> 'retired' and d.expires_on is not null
      and d.expires_on <= current_date + 32 -- every time zone's today is within a day of the server's
      and extract(hour from now() at time zone coalesce(c.timezone, 'UTC')) >= 8
      and private.sub_alert_rank(private.sub_alert_due(x.days_left)) > private.sub_alert_rank(d.alerted_state)
    for update of d skip locked
  loop
    v_when := case
      when r.days_left < 0 then 'ran out'
      when r.days_left = 0 then 'runs out today'
      when r.days_left = 1 then 'runs out tomorrow'
      else format('runs out in %s days', r.days_left)
    end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select r.company_id, w, 'equipment',
      format('%s''s %s %s', r.equipment_name, private.equipment_document_words(r.kind, r.name), v_when),
      format('%s %s.', case when r.days_left < 0 then 'It was good through' else 'It''s good through' end, private.date_text(r.expires_on, 'Mon FMDD, YYYY', r.country)),
      '/equipment/' || r.equipment_id
    from private.equipment_watchers(r.company_id, r.crew_id) as w;
    update public.equipment_documents set alerted_state = r.due where id = r.id;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;

-- As in 20261109000100_equipment_paperwork.sql, with the day it's good through in the business's
-- country's way.
create or replace function public.renew_equipment_document(p_document uuid, p_expires_on date, p_notes text default null, p_expense uuid default null)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  d public.equipment_documents;
  v_what text;
  v_log uuid;
begin
  update public.equipment_documents set expires_on = p_expires_on where id = p_document returning * into d;
  if d.id is null then
    raise exception 'That paperwork is gone, or your role can''t renew it' using errcode = '42501';
  end if;
  v_what := private.equipment_document_words(d.kind, d.name);
  insert into public.equipment_logs (company_id, equipment_id, kind, title, notes, expense_id)
  values (d.company_id, d.equipment_id, 'service',
    left(upper(left(v_what, 1)) || substr(v_what, 2) || case when p_expires_on is null then ' renewed, doesn''t expire'
      else ' renewed, good through ' || private.date_text(p_expires_on, 'Mon FMDD, YYYY', private.company_country(d.company_id)) end, 120),
    nullif(trim(p_notes), ''), p_expense)
  returning id into v_log;
  return v_log;
end $$;

-- As in 20261113000900_visit_extras.sql, with the visit's day in the business's country's way.
create or replace function private.visit_extras_lose_visit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_names text;
  v_job public.jobs;
  v_day date;
begin
  if tg_op = 'UPDATE' and not (new.status = 'cancelled' and old.status is distinct from 'cancelled') then
    return new;
  end if;
  begin
    select string_agg(e.name, ', ' order by e.created_at, e.id) into v_names
    from public.visit_extras e where e.visit_id = old.id and e.invoice_id is null;
    select coalesce(old.scheduled_on, (old.starts_at at time zone coalesce(c.timezone, 'UTC'))::date) into v_day
    from public.companies c where c.id = old.company_id;
    if tg_op = 'DELETE' then
      update public.visit_extras set visit_was_on = v_day where visit_id = old.id;
    end if;
    if v_names is not null then
      select * into v_job from public.jobs where id = old.job_id;
      if found then
        insert into public.notifications (company_id, user_id, kind, title, body, link)
        select old.company_id, u, 'invoice',
          left(format('Extra work wasn''t billed: its visit was %s', case when tg_op = 'DELETE' then 'removed' else 'cancelled' end), 300),
          left(format('%s, on %s%s. Put it on another visit from the job, or remove it.', v_names,
            coalesce(nullif(private.client_name(v_job.client_id), '') || ': ', '') || v_job.title,
            coalesce(', ' || private.date_text(v_day, 'FMMon FMDD', private.company_country(old.company_id)), '')), 1000),
          '/jobs/' || v_job.id
        from private.money_office(old.company_id) u;
      end if;
    end if;
  exception when others then
    raise warning 'extra work on a visit: %', sqlerrm;
  end;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- As in 20261112000400_paid_hours_once.sql, with the period's days in the business's country's way.
create or replace function private.pay_line_paid_once() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_left numeric;
  v_later record;
begin
  if new.paid_at is not null and (tg_op = 'INSERT' or old.paid_at is null) then
    -- One mark at a time in a company, so two at once over the same days see each other.
    perform pg_advisory_xact_lock(hashtextextended('pay_marks:' || new.company_id::text, 0));
    new.marked_at := clock_timestamp();
    if exists (
      select 1 from public.pay_period_lines l
      join public.pay_periods o on o.id = l.period_id
      join public.pay_periods mine on mine.id = new.period_id
      where l.company_id = new.company_id and l.user_id = new.user_id and l.paid_at is not null and l.period_id <> new.period_id
        and o.starts_on <= mine.ends_on and o.ends_on >= mine.starts_on
    ) then
      v_left := private.hours_left_to_pay(new.period_id, new.user_id);
      if new.hours > v_left + 0.01 then
        raise exception 'Some of their hours in this period have already been paid with another period (% h are left to pay). Look again, then mark them paid.', to_char(v_left, 'FM999,990.00')
          using errcode = '22023';
      end if;
    end if;
  elsif tg_op = 'UPDATE' and old.paid_at is not null and new.paid_at is null then
    select o.starts_on, o.ends_on into v_later
    from public.pay_period_lines l
    join public.pay_periods o on o.id = l.period_id
    join public.pay_periods mine on mine.id = old.period_id
    where l.company_id = old.company_id and l.user_id = old.user_id and l.paid_at is not null and l.period_id <> old.period_id
      and o.starts_on <= mine.ends_on and o.ends_on >= mine.starts_on
      and l.marked_at > coalesce(old.marked_at, '-infinity')
    order by l.marked_at desc limit 1;
    if found then
      raise exception '% was also marked paid for % to % after this, and that mark left out the days the two share as already paid. Take back that one first.',
        coalesce((select p.full_name from public.profiles p where p.user_id = old.user_id), 'Someone'), private.date_text(v_later.starts_on, 'FMMon FMDD', private.company_country(old.company_id)), private.date_text(v_later.ends_on, 'FMMon FMDD', private.company_country(old.company_id))
        using errcode = '22023';
    end if;
    new.marked_at := null;
  elsif tg_op = 'UPDATE' then
    new.marked_at := old.marked_at;
  else
    new.marked_at := null;
  end if;
  return new;
end $$;

-- As in 20261025003003_piece_pay_periods.sql, with the amount in the business's currency.
create or replace function private.pay_line_piece() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_piece numeric;
begin
  if new.paid_at is null then return new; end if;
  select coalesce(sum(x.total), 0) into v_piece from private.period_piece(new.period_id, new.user_id) x;
  if v_piece <> new.piece_amount then
    raise exception 'Their piece pay for this period has changed since you looked (it''s now %). Look again, then mark them paid.', private.money_prefix(private.company_currency(new.company_id)) || to_char(v_piece, 'FM999,999,990.00')
      using errcode = '22023';
  end if;
  return new;
end $$;

-- As in 20261025007005_per_unit_pay_shares.sql, with the visits' days in the business's country's
-- way.
create or replace function public.job_pay_suggest(p_job uuid, p_subcontractor uuid default null, p_user uuid default null, p_visits uuid[] default null)
returns table (pay_rate_id uuid, description text, basis text, unit text, service_id uuid, quantity numeric, rate numeric, amount numeric,
               note text, check_it boolean, sort integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  j public.jobs;
  r record;
  v_visits uuid[];
  v_qty numeric;
  v_lines integer;
  v_changes integer;
  v_waste numeric;
  v_days date[];
  v_taken numeric;
  v_n integer := 0;
begin
  select * into j from public.jobs x where x.id = p_job and x.company_id = any (private.role_companies('{owner,admin,office}'));
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  if not private.handles_pay(j.company_id, p_subcontractor, p_user) then
    raise exception 'Your role can''t set this pay' using errcode = '42501';
  end if;
  v_visits := private.job_pay_cover(p_job, p_subcontractor, p_user, p_visits);
  select m.waste_pct into v_waste from public.measurements m
  where j.quote_id is not null and m.company_id = j.company_id and m.quote_id = j.quote_id
  order by m.created_at desc, m.id desc limit 1;
  for r in
    select pr.id, pr.basis, pr.unit, pr.service_id, pr.squares_basis, pr.rate, pr.description, s.name as service_name
    from public.pay_rates pr left join public.services s on s.id = pr.service_id
    where pr.company_id = j.company_id and pr.active
      and (pr.subcontractor_id = p_subcontractor or pr.user_id = p_user)
    order by case pr.basis when 'per_unit' then 0 when 'per_day' then 1 else 2 end, s.sort, coalesce(pr.description, s.name), pr.created_at, pr.id
  loop
    v_n := v_n + 1;
    pay_rate_id := r.id;
    basis := r.basis;
    unit := r.unit;
    service_id := r.service_id;
    rate := r.rate;
    check_it := false;
    sort := v_n;
    description := coalesce(nullif(btrim(r.description), ''), r.service_name, case r.basis when 'per_day' then 'Day rate' else 'Price for the job' end);
    if r.basis = 'per_unit' then
      select coalesce(sum(li.quantity), 0), count(*), count(*) filter (where li.source_quote_id is not null)
        into v_qty, v_lines, v_changes
      from public.job_line_items li
      where li.job_id = p_job and li.service_id = r.service_id and li.unit_price >= 0;
      if v_lines = 0 then
        quantity := 0;
        check_it := true;
        note := format('There''s no %s on this job.', r.service_name);
      elsif r.squares_basis = 'roof_no_waste' and v_waste is not null then
        quantity := round(v_qty / (1 + v_waste / 100), 2);
        note := format('%s without the roof measurement''s %s%% waste. The job has %s.',
          private.amount_words(quantity, r.unit), trim_scale(v_waste), private.amount_words(v_qty, r.unit));
      elsif r.squares_basis = 'roof_no_waste' then
        quantity := v_qty;
        check_it := true;
        note := format('The job''s %s, waste included: its quote has no roof measurement to take the waste out. Check it.', private.amount_words(v_qty, r.unit));
      else
        quantity := v_qty;
        note := format('%s of %s on the job', private.amount_words(v_qty, r.unit), r.service_name)
          || case when v_changes > 0 then ', change orders included.' else '.' end;
      end if;
      -- Someone else's pay on the job (a sub's, or another person's piece pay) already counts some
      -- of it: each is paid their share, so this is what's left, flagged.
      select coalesce(sum(l.quantity), 0) into v_taken
      from public.job_pay p join public.job_pay_lines l on l.job_pay_id = p.id
      where p.job_id = p_job and private.job_pay_live(p.status) and l.basis = 'per_unit' and l.service_id = r.service_id
        and not (p.subcontractor_id is not distinct from p_subcontractor and p.user_id is not distinct from p_user);
      if v_lines > 0 and v_taken > 0 then
        note := case when v_taken >= quantity
          then format('Other pay on this job already counts %s, so none is left. Check it.', private.amount_words(v_taken, r.unit))
          else format('%s of %s are already on other pay on this job. Check it.', trim_scale(v_taken), private.amount_words(quantity, r.unit)) end;
        quantity := greatest(quantity - v_taken, 0);
        check_it := true;
      end if;
    elsif r.basis = 'per_day' then
      select coalesce(array_agg(distinct v.scheduled_on order by v.scheduled_on), '{}') into v_days
      from public.visits v where v.id = any (v_visits) and v.status <> 'cancelled' and v.scheduled_on is not null;
      quantity := cardinality(v_days);
      if quantity = 0 then
        check_it := true;
        note := 'Choose the visits it covers to count the days.';
      else
        note := format('%s on the visits it covers: %s.', private.amount_words(quantity, 'day'),
          (select string_agg(private.date_text(d, 'Mon FMDD', private.company_country(j.company_id)), ', ' order by d) from unnest(v_days) d));
      end if;
    else
      quantity := 1;
      note := 'Once for the job.';
    end if;
    amount := round(quantity * rate, 2);
    return next;
  end loop;
end $$;

-- As in 20261113001555_postcard_proofs_and_failures.sql, with the day in the business's country's
-- way.
create or replace function private.postcard_campaign_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  if (select auth.role()) is distinct from 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'sending' then
      raise exception 'A postcard campaign can''t be deleted while it''s being mailed' using errcode = '22023';
    end if;
    -- Lob fetches the front's picture from this server while it draws each card, and deleting the
    -- campaign takes the picture down. Kept for 7 days after the last card.
    select max(r.made_at) into v_last from public.postcard_recipients r where r.campaign_id = old.id and r.lob_id is not null;
    if v_last > now() - interval '7 days' then
      raise exception 'This campaign''s cards were made less than 7 days ago, and Lob may still need its picture. It can be deleted from %.', private.date_text(v_last + interval '7 days', 'FMMonth FMDD', private.company_country(old.company_id))
        using errcode = '22023';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    raise exception 'Only draft postcard campaigns can be changed' using errcode = '22023';
  end if;
  new.status := 'draft';
  new.mode := null;
  new.image_token := null;
  new.image_path := null;
  new.started_at := null;
  new.finished_at := null;
  new.stopped_reason := null;
  new.recipients_count := 0;
  new.made_count := 0;
  new.failed_count := 0;
  new.lob_checked_at := null;
  -- A photo of another company's isn't this card's front.
  if new.front_attachment_id is not null
     and not exists (select 1 from public.attachments a where a.id = new.front_attachment_id and a.company_id = new.company_id) then
    raise exception 'That photo isn''t one of yours' using errcode = '22023';
  end if;
  return new;
end $$;

-- As in 20261113000100_snow_app.sql, with the day in the business's country's way.
create or replace function public.snow_answer(p_company uuid, p_date date, p_can boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_was boolean; v_name text;
begin
  if p_can is null then raise exception 'Say yes or no.' using errcode = '22023'; end if;
  select can into v_was from public.snow_availability
   where company_id = p_company and snow_date = p_date and user_id = (select auth.uid()) for update;
  if not found then raise exception 'Nobody asked you about that day.' using errcode = '42501'; end if;
  update public.snow_availability set can = p_can, answered_at = now()
   where company_id = p_company and snow_date = p_date and user_id = (select auth.uid());
  if not p_can and v_was is distinct from false then
    select coalesce(nullif(trim(full_name), ''), 'Someone') into v_name from public.profiles where user_id = (select auth.uid());
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select p_company, o, 'snow', left(coalesce(v_name, 'Someone') || ' can''t go out for snow on ' || (private.date_text(p_date, 'Dy', private.company_country(p_company)) || ', ' || private.date_text(p_date, 'Mon FMDD', private.company_country(p_company))), 300),
           'They answered no on My day. Their snow customers are on the Snow page.', '/snow'
      from private.schedule_office(p_company) o where o <> (select auth.uid());
  end if;
  return p_can;
end $$;

-- As private.auto_post_when (20261031000450_social_post_words.sql), for a business in `p_country`:
-- the day past tomorrow as the country writes it (private.date_text 'Mon FMDD'), and the time as
-- the country keeps it with ":00" left out before AM or PM: "6 Nov at 17:30" in the UK, "tomorrow at
-- 5 p.m." in Canada, "today at 5:30 pm" in Australia. In the US (and with no country) it says what
-- the one without a country says; that one stays, as the release before this one has it. Core
-- autoPostWhen writes the same words.
create function private.auto_post_when(p_at timestamptz, p_tz text, p_country text) returns text
language sql stable set search_path = '' as $$
  select case (p_at at time zone p_tz)::date - (now() at time zone p_tz)::date
           when 0 then 'today' when 1 then 'tomorrow' else private.date_text(p_at at time zone p_tz, 'Mon FMDD', p_country) end
         || ' at ' || replace(private.date_text(p_at at time zone p_tz, 'FMHH12:MI AM', p_country), ':00 ', ' ')
$$;
revoke all on function private.auto_post_when(timestamptz, text, text) from public;

-- As in 20261031000420_automatic_review_posts.sql, with when it posts in the business's country's
-- way (private.auto_post_when).
create or replace function private.auto_review_post() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  co public.companies;
  v_networks text[];
  v_key text := new.location_id || '/' || new.review_id;
  v_tz text;
  v_at timestamptz;
  v_id uuid;
begin
  begin
    if coalesce(new.comment, '') !~ '[A-Za-z0-9À-ɏ]' then return null; end if;
    select * into co from public.companies where id = new.company_id;
    if not found or not (co.settings -> 'marketing' ->> 'enabled' = 'true') then return null; end if;
    v_networks := array(select n from unnest(private.social_settings_auto(co.settings)) n where private.social_network_ready(co.id, n));
    if cardinality(v_networks) = 0 then return null; end if;
    perform pg_advisory_xact_lock(hashtextextended('social_auto:' || co.id::text, 0));
    if exists (select 1 from public.social_posts p
                where p.company_id = co.id and p.review_key = v_key
                  and (p.automatic or p.status in ('scheduled', 'posting', 'posted', 'partly_posted', 'check'))) then
      return null;
    end if;
    v_tz := coalesce(nullif(co.timezone, ''), 'UTC');
    v_at := private.next_auto_post_slot(co.id, v_tz);
    if v_at is null then return null; end if;
    insert into public.social_posts (company_id, source, review_id, review_key, caption, caption_by, networks, status, scheduled_for, automatic)
    values (co.id, 'review', new.id, v_key, private.default_review_caption(), 'default', v_networks, 'scheduled', v_at, true)
    on conflict (company_id, review_key) where automatic do nothing
    returning id into v_id;
    if v_id is null then return null; end if;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select co.id, o, 'social_scheduled', 'A 5-star review posts ' || private.auto_post_when(v_at, v_tz, co.country),
           'It goes to ' || private.network_words(v_networks) || '. Change or cancel it before then.', '/marketing?tab=social&post=' || v_id
      from private.marketing_office(co.id) o;
  exception when others then
    raise warning 'A 5-star review wasn''t scheduled to post: %', sqlerrm;
  end;
  return null;
end $$;

-- As in 20261112000310_company_day_dates.sql, with the amounts in what needs attention in the
-- business's currency.
create or replace function public.dashboard(p_company uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with co as (
    select coalesce(timezone, 'UTC') as tz, currency from public.companies where id = p_company
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
                                  'detail', coalesce(a.last_error, private.money_prefix((select co.currency from co)) || to_char(i.balance_due, 'FM999,999,990.00') || ' is over your autopay limit'),
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
                                  'detail', private.money_prefix((select co.currency from co)) || to_char(balance_due, 'FM999,999,990.00') || ' owing', 'link', '/invoices/' || id)
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
