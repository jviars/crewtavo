-- AI assistants can be given the rest of Crewtavo (packages/core/src/assistants.ts has the areas):
-- clients and properties, jobs and recurring services, the schedule, clocks and timesheets, people
-- and roles, and money: quotes, invoices and payments, and pay. And a fourth level, full access
-- without money, that changes and deletes everything else.
--
-- The database checks it as before (20261019001900_assistant_areas.sql): every Data API write an
-- assistant makes has to be in an area its connection may change. Two functions that write are
-- now allowed for an assistant with their area (turning a quote into a job, invoicing a job);
-- every other function it calls still runs in a transaction that can't write. Whatever it's been
-- given, an assistant never refunds or deletes a payment, changes a pay rate without the pay area,
-- or changes the team without the owners hearing about it.

alter table public.assistant_connections drop constraint assistant_connections_level_check;
alter table public.assistant_connections add constraint assistant_connections_level_check
  check (level in ('read', 'areas', 'full', 'full_no_money'));
alter table public.assistant_connections drop constraint assistant_connections_areas_check;
alter table public.assistant_connections add constraint assistant_connections_areas_check
  check (areas <@ array['clients', 'records', 'jobs', 'schedule', 'time', 'quotes', 'invoices', 'pay',
    'company', 'prices', 'crews', 'checklists', 'booking', 'guides', 'automations', 'team']);

/** The area a table's rows are in, for an assistant writing to it; null for every other table. */
create or replace function private.assistant_table_area(p_table text) returns text
language sql immutable set search_path = '' as $$
  select case p_table
    when 'clients' then 'clients'
    when 'client_contacts' then 'clients'
    when 'properties' then 'clients'
    when 'property_access' then 'clients'
    when 'requests' then 'records'
    when 'messages' then 'records'
    when 'jobs' then 'jobs'
    when 'job_line_items' then 'jobs'
    when 'visits' then 'schedule'
    when 'visit_assignees' then 'schedule'
    when 'visit_equipment' then 'schedule'
    when 'routes' then 'schedule'
    when 'time_entries' then 'time'
    when 'quotes' then 'quotes'
    when 'quote_line_items' then 'quotes'
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
  end
$$;

/** Quotes, invoices and payments, and pay: what full access without money leaves out. */
create function private.assistant_money_area(p_area text) returns boolean
language sql immutable set search_path = '' as $$
  select p_area in ('quotes', 'invoices', 'pay')
$$;

/** The area of a function that may write for an assistant; null for every other function. */
create function private.assistant_rpc_area(p_function text) returns text
language sql immutable set search_path = '' as $$
  select case p_function
    when 'convert_quote_to_job' then 'quotes'
    when 'create_invoice_for_job' then 'invoices'
  end
$$;

/**
 * Whether the request may change things in `p_area` (deleting, with `p_delete`). Always true for an
 * ordinary sign-in. An assistant needs full access, full access without money outside the money
 * areas, or the area chosen and not deleting.
 */
create or replace function private.assistant_may_change(p_area text, p_delete boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.assistant_client() is null or exists (
    select 1 from public.assistant_connections a
    where a.user_id = (select auth.uid()) and a.client_id = private.assistant_client()
      and (a.level = 'full'
        or (a.level = 'full_no_money' and not private.assistant_money_area(p_area))
        or (a.level = 'areas' and not p_delete and p_area = any (a.areas)))
  )
$$;

revoke all on function private.assistant_money_area(text), private.assistant_rpc_area(text) from public;
grant execute on function private.assistant_money_area(text), private.assistant_rpc_area(text) to authenticated, service_role;

create or replace function hooks.before_request() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_method text := current_setting('request.method', true);
  v_path text := coalesce(current_setting('request.path', true), '');
  v_table text := ltrim(v_path, '/');
  v_area text;
  v_level text;
  -- Taking someone off a crew or a visit, or a machine off a visit, is a change, not deleting.
  v_delete boolean := v_method = 'DELETE' and ltrim(v_path, '/') not in ('crew_members', 'visit_assignees', 'visit_equipment');
begin
  if private.assistant_client() is null then return; end if;
  if v_method in ('GET', 'HEAD') then
    perform set_config('transaction_read_only', 'on', true);
    return;
  end if;
  if v_path like '/rpc/%' then
    -- A function that writes for its area, or one that answers but can't write.
    v_area := private.assistant_rpc_area(substr(v_path, 6));
    if v_area is null or not private.assistant_may_change(v_area, false) then
      perform set_config('transaction_read_only', 'on', true);
    end if;
    return;
  end if;
  v_area := private.assistant_table_area(v_table);
  if v_area is not null and private.assistant_may_change(v_area, v_delete) then return; end if;
  select a.level into v_level from public.assistant_connections a
  where a.user_id = (select auth.uid()) and a.client_id = private.assistant_client();
  raise exception using errcode = 'PT403', message = case
    when v_area is null then 'An AI assistant can''t change this. Do it in Crewtavo itself.'
    when v_level = 'full_no_money' and private.assistant_money_area(v_area) then
      'This assistant can''t change money: quotes, invoices, payments or pay. To let it, give it Full access in Crewtavo, under Settings → AI assistants.'
    when v_delete and v_level = 'areas' then
      'This assistant can''t delete things. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants.'
    else format('This assistant can''t change %s. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.', case v_area
      when 'clients' then 'clients and properties' when 'records' then 'requests and notes' when 'jobs' then 'jobs'
      when 'schedule' then 'the schedule' when 'time' then 'clocks and timesheets' when 'quotes' then 'quotes'
      when 'invoices' then 'invoices and payments' when 'pay' then 'pay' when 'company' then 'company details'
      when 'prices' then 'the price list' when 'crews' then 'crews' when 'checklists' then 'checklists'
      when 'booking' then 'booking forms' when 'guides' then 'guides' when 'team' then 'people and roles' else 'automations' end)
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Payments: an assistant records them, and fixes their details, but never refunds or deletes one.
-- ---------------------------------------------------------------------------------------------

create function private.assistant_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    raise exception 'An AI assistant can''t delete a payment. Do it in Crewtavo itself.' using errcode = '42501';
  end if;
  if new.amount < 0 then
    raise exception 'An AI assistant can''t record a refund. Do it in Crewtavo itself.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger assistant_guard before insert or update or delete on public.payments
  for each row execute function private.assistant_payment_guard();

-- ---------------------------------------------------------------------------------------------
-- Pay rates need the pay area, whatever else the assistant may change about the team.
-- ---------------------------------------------------------------------------------------------

create function private.assistant_pay_rate_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return new; end if;
  if ((tg_op = 'INSERT' and new.labor_rate is not null) or (tg_op = 'UPDATE' and new.labor_rate is distinct from old.labor_rate))
    and not private.assistant_may_change('pay', false) then
    raise exception 'This assistant can''t change pay rates. To let it, give it the Pay area or Full access in Crewtavo, under Settings → AI assistants.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger assistant_pay_rate_guard before insert or update on public.memberships
  for each row execute function private.assistant_pay_rate_guard();

-- ---------------------------------------------------------------------------------------------
-- The owners hear about every change an assistant makes to the team, and it's on record.
-- ---------------------------------------------------------------------------------------------

create function private.assistant_team_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := coalesce(new.company_id, old.company_id);
  v_actor text := coalesce((select full_name from public.profiles where user_id = (select auth.uid())), 'Someone');
  v_subject uuid;
  v_name text;
  -- A level as people read it (packages/core/src/roles.ts ROLE_LABELS).
  v_level text;
  v_what text[] := '{}';
  v_summary text;
begin
  if private.assistant_client() is null then return null; end if;
  -- Each statement only reads the columns of the table it runs for.
  if tg_table_name = 'memberships' then
    v_subject := coalesce(new.user_id, old.user_id);
    v_name := coalesce((select coalesce(full_name, email) from public.profiles where user_id = v_subject), 'someone');
    if tg_op <> 'DELETE' then
      v_level := coalesce((select name from public.company_roles where id = new.role_id), case new.role::text
        when 'owner' then 'Owner' when 'admin' then 'Admin' when 'office' then 'Office' when 'estimator' then 'Estimator'
        when 'crew_lead' then 'Crew lead' else 'Field crew' end);
    end if;
    if tg_op = 'INSERT' then
      v_what := array[format('added %s as %s', v_name, v_level)];
    elsif tg_op = 'DELETE' then
      v_what := array[format('removed %s', v_name)];
    else
      if new.role is distinct from old.role or new.role_id is distinct from old.role_id then
        v_what := v_what || format('changed %s''s role to %s', v_name, v_level);
      end if;
      if new.active is distinct from old.active then
        v_what := v_what || case when new.active then format('gave %s access back', v_name) else format('took away %s''s access', v_name) end;
      end if;
      if new.labor_rate is distinct from old.labor_rate then
        v_what := v_what || format('changed %s''s pay rate', v_name);
      end if;
    end if;
  elsif tg_op = 'DELETE' then
    v_subject := old.id;
    v_what := array[format('deleted the %s role', old.name)];
  else
    v_subject := new.id;
    v_what := array[format('saved the %s role', new.name)];
  end if;
  if cardinality(v_what) = 0 then return null; end if;
  v_summary := format('%s''s AI assistant %s', v_actor, array_to_string(v_what, ', '));
  perform private.emit(v_company, 'assistant.team', tg_table_name, v_subject, v_summary);
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select v_company, m.user_id, 'security', 'An AI assistant changed your team', v_summary, '/settings?tab=team'
  from public.memberships m where m.company_id = v_company and m.role = 'owner' and m.active;
  return null;
end $$;
create trigger assistant_team_notice after insert or update or delete on public.memberships
  for each row execute function private.assistant_team_notice();
create trigger assistant_team_notice after insert or update or delete on public.company_roles
  for each row execute function private.assistant_team_notice();

-- ---------------------------------------------------------------------------------------------
-- Time an assistant adds, changes, approves or deletes is on record.
-- ---------------------------------------------------------------------------------------------

create function private.assistant_time_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.time_entries := coalesce(new, old);
  v_name text := coalesce((select full_name from public.profiles where user_id = v_row.user_id), 'someone');
  v_what text;
begin
  if private.assistant_client() is null then return null; end if;
  v_what := case
    when tg_op = 'INSERT' then format('added time for %s', v_name)
    when tg_op = 'DELETE' then format('deleted time for %s', v_name)
    when new.approved_at is not null and old.approved_at is null then format('approved %s''s time', v_name)
    when new.approved_at is null and old.approved_at is not null then format('took back approval of %s''s time', v_name)
    else format('changed %s''s time', v_name)
  end;
  perform private.emit(v_row.company_id, 'assistant.time', 'time_entry', v_row.id,
    format('%s''s AI assistant %s', coalesce((select full_name from public.profiles where user_id = (select auth.uid())), 'Someone'), v_what),
    jsonb_build_object('user_id', v_row.user_id, 'started_at', v_row.started_at, 'ended_at', v_row.ended_at));
  return null;
end $$;
create trigger assistant_time_notice after insert or update or delete on public.time_entries
  for each row execute function private.assistant_time_notice();

notify pgrst, 'reload schema';
