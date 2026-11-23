-- What an AI assistant (Claude, ChatGPT over MCP) may change about what clients pay, and who it
-- may let onto the team.
--
-- "Full access, no money" left out quotes, invoices, payments, pay and promo codes, but what clients
-- pay was in areas that weren't money: a job's lines and extra work on a visit were Jobs, changing
-- prices across jobs too, and the price list (whose "Add to every job" items go on every new job by
-- themselves) was Setup. Now the Prices area ("Price list and job prices", packages/core/src/assistants.ts)
-- is money, and holds all of it:
--
--   job_line_items, visit_extras          a job's lines and a visit's extra work: Prices
--   apply_price_change, undo_price_change  price changes across jobs: Prices
--   jobs' billing_mode, pricing, invoice_schedule, invoice_day   how a job is billed: Prices
--
-- Weather rules (set_weather_rules), which change no price, move to the Schedule: they warn about
-- visits. A client's tax exemption and payment terms, and the company's payment terms, sales tax,
-- minimum charge, late fees and tips, go with Invoices and payments.
--
-- And an assistant gives no one more than crew lead access: office and estimators see every client,
-- the prices and the money, so a note or a website form an assistant reads can't have it invite
-- someone as one, move someone to one, or give one their access back. (Admin access already needs
-- the person's password, 20261101000200_admin_grants.sql.) Those are done on Settings → People.
--
-- The MCP tools check the same (apps/api/src/assistant-tools). Ordinary sign-ins are unaffected.
--
-- supabase/tests/assistant_prices_are_money_test.sql covers it.

-- ---------------------------------------------------------------------------------------------
-- Prices are money
-- ---------------------------------------------------------------------------------------------

/** Prices, quotes, invoices and payments, pay, and promo codes: what full access without money leaves out. */
create or replace function private.assistant_money_area(p_area text) returns boolean
language sql immutable set search_path = '' as $$
  select p_area in ('prices', 'quotes', 'invoices', 'pay', 'promos')
$$;

-- As in 20261113000900_visit_extras.sql, with a job's lines and a visit's extra work under Prices.
create or replace function private.assistant_table_area(p_table text) returns text
language sql immutable set search_path = '' as $$
  select case p_table
    when 'clients' then 'clients'
    when 'client_contacts' then 'clients'
    when 'properties' then 'clients'
    when 'property_access' then 'clients'
    when 'property_assets' then 'clients'
    when 'requests' then 'records'
    when 'messages' then 'records'
    when 'jobs' then 'jobs'
    when 'job_line_items' then 'prices'
    when 'visit_extras' then 'prices'
    when 'visits' then 'schedule'
    when 'visit_assignees' then 'schedule'
    when 'visit_equipment' then 'schedule'
    when 'routes' then 'schedule'
    when 'time_entries' then 'time'
    when 'quotes' then 'quotes'
    when 'quote_line_items' then 'quotes'
    when 'quote_options' then 'quotes'
    when 'invoices' then 'invoices'
    when 'invoice_line_items' then 'invoices'
    when 'payments' then 'invoices'
    when 'pay_periods' then 'pay'
    when 'pay_period_lines' then 'pay'
    when 'companies' then 'company'
    when 'services' then 'prices'
    when 'crews' then 'crews'
    when 'crew_members' then 'crews'
    when 'checklist_templates' then 'checklists'
    when 'intake_forms' then 'booking'
    when 'sop_pages' then 'guides'
    when 'sop_categories' then 'guides'
    when 'automation_rules' then 'automations'
    when 'memberships' then 'team'
    when 'company_roles' then 'team'
    when 'document_templates' then 'templates'
    when 'contract_sections' then 'templates'
    when 'campaigns' then 'marketing'
    when 'promo_codes' then 'promos'
  end
$$;

-- As in 20261113000950_price_changes.sql, with price changes under Prices and weather rules under
-- the Schedule.
create or replace function private.assistant_rpc_area(p_function text) returns text
language sql immutable set search_path = '' as $$
  select case p_function
    when 'apply_price_change' then 'prices'
    when 'convert_quote_to_job' then 'quotes'
    when 'create_invoice_for_job' then 'invoices'
    when 'duplicate_quote' then 'quotes'
    when 'edit_invoice' then 'invoices'
    when 'merge_clients' then 'invoices'
    when 'merge_company_settings' then 'company'
    when 'quote_exact_sent' then 'quotes'
    when 'remove_late_fee' then 'invoices'
    when 'set_checklist_services' then 'checklists'
    when 'set_weather_rules' then 'schedule'
    when 'undo_price_change' then 'prices'
  end
$$;

-- As in 20261112000530_assistants_off_everywhere.sql, with prices in what full access without money
-- leaves out, and called what the refusal calls them.
create or replace function hooks.before_request() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_method text := current_setting('request.method', true);
  v_path text := coalesce(current_setting('request.path', true), '');
  v_table text := ltrim(v_path, '/');
  v_area text;
  v_level text;
  v_switch jsonb;
  -- Taking someone off a crew or a visit, or a machine off a visit, is a change, not deleting.
  v_delete boolean := v_method = 'DELETE' and ltrim(v_path, '/') not in ('crew_members', 'visit_assignees', 'visit_equipment');
begin
  if private.assistant_client() is null then return; end if;
  v_switch := private.assistant_switch();
  if v_path = '/rpc/assistant_switch' then
    perform set_config('transaction_read_only', 'on', true);
    return;
  end if;
  if v_switch ->> 'state' = 'off' then
    raise exception using errcode = 'PT403', message = format(
      'AI assistants are turned off for %s. An owner or admin can turn them on in Crewtavo, under Settings → AI assistants.', v_switch ->> 'company');
  end if;
  if v_method in ('GET', 'HEAD') then
    perform set_config('transaction_read_only', 'on', true);
    return;
  end if;
  if v_path like '/rpc/%' then
    -- A function that writes for its area, or one that answers but can't write. One that removes
    -- something for good (merging two clients deletes one) needs what deleting a row needs.
    v_area := private.assistant_rpc_area(substr(v_path, 6));
    v_delete := v_area is not null and private.assistant_rpc_deletes(substr(v_path, 6));
    if v_delete and not private.assistant_may_change(v_area, true) and private.assistant_may_change(v_area, false) then
      raise exception using errcode = 'PT403',
        message = 'This assistant can''t delete things. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants.';
    end if;
    if v_area is null or not private.assistant_may_change(v_area, v_delete) then
      perform set_config('transaction_read_only', 'on', true);
    end if;
    return;
  end if;
  v_area := private.assistant_table_area(v_table);
  if v_area is not null and private.assistant_may_change(v_area, v_delete) then return; end if;
  select a.level into v_level from public.assistant_connections a
  where a.user_id = (select auth.uid()) and a.client_id = private.assistant_client();
  raise exception using errcode = 'PT403', message = case
    when v_switch ->> 'state' = 'read_only' then format(
      'Assistants can only look things up for %s, not make changes. An owner or admin can change this in Crewtavo, under Settings → AI assistants.', v_switch ->> 'company')
    when v_area is null then 'An AI assistant can''t change this. Do it in Crewtavo itself.'
    when v_level = 'full_no_money' and private.assistant_money_area(v_area) then
      'This assistant can''t change money: prices, quotes, invoices, payments, pay or promo codes. To let it, give it Full access in Crewtavo, under Settings → AI assistants.'
    when v_delete and v_level = 'areas' then
      'This assistant can''t delete things. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants.'
    else format('This assistant can''t change %s. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.', case v_area
      when 'clients' then 'clients and properties' when 'records' then 'requests and notes' when 'jobs' then 'jobs'
      when 'schedule' then 'the schedule' when 'time' then 'clocks and timesheets' when 'quotes' then 'quotes'
      when 'invoices' then 'invoices and payments' when 'pay' then 'pay' when 'company' then 'company details'
      when 'prices' then 'prices' when 'crews' then 'crews' when 'checklists' then 'checklists'
      when 'booking' then 'booking forms' when 'guides' then 'guides' when 'team' then 'people and roles'
      when 'templates' then 'document styles and contract terms' when 'marketing' then 'campaigns, reviews and social posts'
      when 'promos' then 'promo codes' else 'automations' end)
  end;
end $$;

-- How a job is billed (per visit or a fixed price, after each visit or monthly, and on which day)
-- decides what an invoice asks for, and when autopay charges it: Prices too. Only a request that
-- names them sets it off, and align_billing, which runs first, only follows a change the request
-- made to them, so any difference from the row before is the request's.
create function private.assistant_job_billing_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return new; end if;
  if (new.billing_mode, new.pricing, new.invoice_schedule, new.invoice_day) is distinct from (old.billing_mode, old.pricing, old.invoice_schedule, old.invoice_day)
    and not private.assistant_may_change('prices', false) then
    raise exception 'This assistant can''t change how a job is priced or billed. To let it, choose Price list and job prices for it, or give it Full access, in Crewtavo, under Settings → AI assistants.'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.assistant_job_billing_guard() from public;
create trigger assistant_billing_guard before update of billing_mode, pricing, invoice_schedule, invoice_day on public.jobs
  for each row execute function private.assistant_job_billing_guard();

-- A client's tax exemption and payment terms: what they pay, and when it's due.
create function private.assistant_client_money_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return new; end if;
  if ((tg_op = 'INSERT' and (new.tax_exempt or new.tax_exempt_note is not null or new.payment_terms_days is not null))
      or (tg_op = 'UPDATE' and (new.tax_exempt, new.tax_exempt_note, new.payment_terms_days) is distinct from (old.tax_exempt, old.tax_exempt_note, old.payment_terms_days)))
    and not private.assistant_may_change('invoices', false) then
    raise exception 'This assistant can''t change a client''s tax exemption or payment terms: they go with invoices. To let it, choose Invoices and payments for it, or give it Full access, in Crewtavo, under Settings → AI assistants.'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.assistant_client_money_guard() from public;
create trigger assistant_money_guard before insert or update on public.clients
  for each row execute function private.assistant_client_money_guard();

-- As in 20261105000200_weather_rules.sql, and the settings that decide what clients pay go with
-- invoices.
create or replace function private.assistant_company_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  details constant text[] := array['name', 'phone', 'email', 'website', 'address', 'timezone', 'settings', 'updated_at'];
  settings constant text[] := array['payment_terms_days', 'default_tax_rate', 'quote_valid_days', 'working_hours', 'branding', 'hub_tips', 'depot',
                                    'minimum_charge', 'late_fee', 'weather_rules'];
  -- What decides what clients pay, of those: money, which goes with invoices.
  v_money constant text[] := array['payment_terms_days', 'default_tax_rate', 'hub_tips', 'minimum_charge', 'late_fee'];
begin
  if private.assistant_client() is null then return new; end if;
  if to_jsonb(new) - details is distinct from to_jsonb(old) - details
    or coalesce(new.settings, '{}') - settings is distinct from coalesce(old.settings, '{}') - settings
    or coalesce(new.settings -> 'branding', '{}') - 'color' is distinct from coalesce(old.settings -> 'branding', '{}') - 'color' then
    raise exception 'An AI assistant can change the company''s details and the settings on Settings → Company, nothing else.' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(v_money) k where coalesce(new.settings, '{}') -> k is distinct from coalesce(old.settings, '{}') -> k)
    and not private.assistant_may_change('invoices', false) then
    raise exception 'This assistant can''t change payment terms, sales tax, the minimum charge, late fees or tips: they go with invoices. To let it, choose Invoices and payments for it, or give it Full access, in Crewtavo, under Settings → AI assistants.'
      using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Crew leads and field crew only
-- ---------------------------------------------------------------------------------------------

-- A member an assistant adds, moves to another role or gives their access back to has crew lead or
-- field crew access, as a level or a custom role based on one (worked out here: the trigger that sets
-- the level from a custom role may not have run yet). Changing a custom role's level moves everyone
-- who has it (private.sync_role_level), so making a crew role an office one stops here too. Taking
-- access away, and any change that leaves the role and access as they were, is left alone.
create function private.assistant_level_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_level text;
begin
  if private.assistant_client() is null or not new.active then return new; end if;
  if tg_op = 'UPDATE' and old.active and new.role is not distinct from old.role and new.role_id is not distinct from old.role_id then return new; end if;
  v_level := coalesce((select r.base_role::text from public.company_roles r where r.id = new.role_id and r.company_id = new.company_id), new.role::text);
  if v_level not in ('crew_lead', 'field_crew') then
    raise exception 'An AI assistant only gives crew lead or field crew access. Give office or estimator access from Settings → People in Crewtavo.'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.assistant_level_guard() from public;
create trigger assistant_level_guard before insert or update on public.memberships
  for each row execute function private.assistant_level_guard();

notify pgrst, 'reload schema';
