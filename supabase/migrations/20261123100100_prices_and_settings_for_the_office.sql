-- The company's money settings are read only by the people who see prices.
--
-- companies.settings holds the minimum charge, late fees, tax, payment terms, storm prices and the
-- profit alert beside the time clock and branding, and every member read all of it. The selling
-- prices and targets already moved apart (company_private_settings,
-- 20261122000200_price_settings_only_for_those_who_sell.sql); the rest are read all over the
-- database's billing (minimum charges, late fees, invoices, autopay, the Hub's deposit invoices,
-- price changes, profit alerts), so they stay where they are, and the browser stops reading the
-- column instead, as with pay rates (20261017000800_pay_rate_privacy.sql). It reads every other
-- column of the company, and a column added later needs its own grant:
--
--   public.company_settings()   the company's settings: all of them for the roles that read a
--                               job's lines (owner, admin, office, estimator) and the server; for
--                               crew leads and field crew only what their screens use
--                               (private.field_settings). Subs keep company_basics().
--
-- What a visit bills (visits.price) stays as 20261122000100_prices_and_own_pay_stay_with_their_roles.sql
-- has it: private.visit_billed decides who reads it. It now answers the server too (autopay bills a
-- job's finished visits as the server, and a storm's visit at its price), and the office's screens
-- read it through public.visit_prices(), by the same rule.
--
-- Writing either is as before. create_invoice_for_job and duplicate_quote, which run as the person
-- asking, read the settings as saved through a private helper the browser can't reach;
-- merge_company_settings, which merged into the settings it read, checks for an owner or admin
-- itself and runs as the database.
--
-- supabase/tests/prices_and_settings_for_the_office_test.sql covers it.

-- ---------------------------------------------------------------------------------------------
-- What the browser reads
-- ---------------------------------------------------------------------------------------------

revoke select on public.companies from anon, authenticated;
grant select (id, name, slug, trade_preset, timezone, currency, phone, email, website, address, created_at, updated_at)
  on public.companies to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Reading them
-- ---------------------------------------------------------------------------------------------

-- As 20261122000100_prices_and_own_pay_stay_with_their_roles.sql (the office with Invoices and
-- payments), and the server: autopay invoices a job's finished visits as the server
-- (public.autopay_bill), and a visit with its own price is billed at it.
create or replace function private.visit_billed(p_visit uuid) returns table (price numeric, price_note text)
language sql stable security definer set search_path = '' as $$
  select v.price, v.price_note from public.visits v
   where v.id = p_visit
     and (coalesce((select auth.role()), 'service_role') = 'service_role'
          or (private.has_role(v.company_id, '{owner,admin,office}') and private.has_perm(v.company_id, 'invoices')))
$$;

revoke all on function private.visit_billed(uuid) from public;
grant execute on function private.visit_billed(uuid) to authenticated, service_role;

-- What the visits given bill, for whoever private.visit_billed answers (the Snow app's storm log).
-- Others get no rows.
create function public.visit_prices(p_visits uuid[])
returns table (id uuid, price numeric, price_note text)
language sql stable security definer set search_path = '' as $$
  select v.id, b.price, b.price_note
  from public.visits v cross join lateral private.visit_billed(v.id) b
  where v.id = any (coalesce(p_visits, '{}'))
$$;

-- What of the company's settings crew leads and field crew read: the time clock, branding, working
-- hours, the schedule's own settings and the shop, arrival windows, maps, how files are kept, contact
-- messages, receipt reading, and whether each app is on (only that). Nothing about money. Mirrors
-- fieldSettings in packages/core/src/companySettings.ts.
create function private.field_settings(p_settings jsonb) returns jsonb
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(jsonb_object_agg(e.key,
           case when e.key = any (array['team_chat', 'drive', 'marketing', 'paving_app', 'roofing_app', 'snow_app', 'careers', 'website'])
                then jsonb_build_object('enabled', case when jsonb_typeof(e.value) = 'object' then e.value -> 'enabled' end)
                else e.value end), '{}')
  from jsonb_each(case when jsonb_typeof(p_settings) = 'object' then p_settings else '{}' end) e
  where e.key = any (array['clock', 'branding', 'working_hours', 'schedule', 'depot', 'arrival_window_min', 'maps', 'files',
                           'contact_messages', 'receipt_reading',
                           'team_chat', 'drive', 'marketing', 'paving_app', 'roofing_app', 'snow_app', 'careers', 'website'])
$$;

-- The company's settings, for someone on its team: all of them for the roles that see prices (and
-- the server), what private.field_settings keeps for everyone else. Null for anyone not on the team.
create function public.company_settings(p_company uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when (select auth.role()) is distinct from 'authenticated' or private.has_role(c.id, '{owner,admin,office,estimator}')
              then c.settings
              else private.field_settings(c.settings) end
  from public.companies c
  where c.id = p_company and ((select auth.role()) is distinct from 'authenticated' or private.is_member(c.id))
$$;

-- The settings as saved, for the database's own functions that run as the person asking (below).
-- They decide who may do what themselves (an invoice is only made by those who may make one), and a
-- crew finishing a job's last visit can set off its invoice, so this doesn't ask who it is. The
-- browser can't call into the private schema.
create function private.saved_settings(p_company uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select c.settings from public.companies c where c.id = p_company
$$;

revoke all on function private.field_settings(jsonb), private.saved_settings(uuid) from public;
grant execute on function private.field_settings(jsonb), private.saved_settings(uuid) to authenticated, service_role;
revoke execute on function public.visit_prices(uuid[]), public.company_settings(uuid) from public, anon;
grant execute on function public.visit_prices(uuid[]), public.company_settings(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The functions that read them as the person asking
-- ---------------------------------------------------------------------------------------------

-- As 20261122000100_prices_and_own_pay_stay_with_their_roles.sql, with the company's terms and tax
-- read through private.saved_settings().
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
  select coalesce((s.settings ->> 'payment_terms_days')::integer, 30), coalesce((s.settings ->> 'default_tax_rate')::numeric, 0),
         (now() at time zone coalesce(c.timezone, 'UTC'))::date, coalesce(c.timezone, 'UTC')
    into v_terms, v_tax, v_today, v_tz
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

-- As 20261113001640_schedule_dates.sql, with how long a quote is good for read through
-- private.saved_settings().
create or replace function public.duplicate_quote(p_quote uuid, p_template_name text default null, p_client uuid default null,
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

  insert into public.quotes (company_id, client_id, property_id, is_template, title, message, discount_amount, tax_rate, deposit_amount, deposit_percent,
                             valid_until, roof_package_id, section_ids, recurrence_rule, active_months, starts_on, ends_on, custom_fields,
                             every_job_items_left_off, payment_schedule)
  select q.company_id,
         case when not v_template then coalesce(p_client, q.client_id) end,
         case when v_template then null when p_client is not null then p_property else q.property_id end,
         v_template,
         left(coalesce(nullif(btrim(p_template_name), ''), nullif(btrim(p_title), ''),
                       case when q.is_template and not v_template then q.title else q.title || ' (copy)' end), 200),
         q.message, q.discount_amount, q.tax_rate, q.deposit_amount, q.deposit_percent,
         case when v_template then null
              when q.is_template then (now() at time zone coalesce(c.timezone, 'UTC'))::date
                                      + coalesce((private.saved_settings(c.id) ->> 'quote_valid_days')::numeric::integer, 30)
              when q.valid_until > (now() at time zone coalesce(c.timezone, 'UTC'))::date then q.valid_until end,
         q.roof_package_id, q.section_ids, q.recurrence_rule, q.active_months, q.starts_on, q.ends_on,
         case when p_client is not null and p_custom_fields is not null then p_custom_fields
              when v_template or q.is_template then q.custom_fields else '{}' end,
         case when q.is_template then q.every_job_items_left_off else '{}' end,
         private.schedule_for_copy(q.payment_schedule)
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
-- As 20261106000410_company_settings_merge.sql, run as the database: it merges into the settings it
-- reads, which the browser no longer reads itself. Owners and admins, as the companies_update rule
-- says, and the settings guards still decide as they do for any change to the company (they ask
-- who's signed in, not who runs the change).
create or replace function public.merge_company_settings(p_company uuid, p_settings jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_typeof(p_settings) is distinct from 'object' then
    raise exception 'Settings are a set of names and values.' using errcode = '22023';
  end if;
  if (select auth.role()) = 'authenticated' and not private.has_role(p_company, '{owner,admin}') then
    raise exception 'Only owners and admins can change the company''s settings.' using errcode = '42501';
  end if;
  -- The row as it is when it's locked, so a change saved meanwhile is merged with, not undone.
  update public.companies c
  set settings = coalesce(c.settings, '{}') || coalesce((
    select jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'object' and jsonb_typeof(c.settings -> e.key) = 'object'
                                        then (c.settings -> e.key) || e.value else e.value end)
    from jsonb_each(p_settings) e), '{}')
  where c.id = p_company;
  if not found then
    raise exception 'Only owners and admins can change the company''s settings.' using errcode = '42501';
  end if;
end $$;

notify pgrst, 'reload schema';
