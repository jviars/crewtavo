-- The company's own switch for AI assistants (Settings → AI assistants: off, or look things up
-- only; companies.settings.assistants) was only checked by the MCP tools. An assistant's token is
-- the person's own, so one already connected kept reading through the Data API after an owner
-- turned assistants off, and kept writing as far as the person had let it. Now the database holds
-- to the switch before every Data API request, and wherever it decides what an assistant may
-- change (files and the guards on tables included):
--
--   off         an assistant's token reads and writes nothing
--   read only   it reads, and writes nothing, whatever the person gave it
--
-- A token is a person's, not a company's, and a request doesn't say which business it's for. So
-- for someone on the team of several businesses the strictest of their settings holds for their
-- assistants everywhere, and the refusal names the business that set it.
--
-- Owners can also see every assistant their team has connected, and end any of them
-- (company_assistant_connections, end_assistant_connection: asked by the server, which checks the
-- role first). People still see and set only their own.

-- ---------------------------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------------------------

-- What the businesses the person is on the team of let an assistant do: {state: on | read_only |
-- off}, with the business that set it (company, company_id) when it isn't on. Off comes before
-- read only. Always on for an ordinary sign-in. A sub's sign-in doesn't count: an assistant gets
-- nothing through one anyway (private.my_subs).
create function private.assistant_switch() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when private.assistant_client() is null then '{"state": "on"}'::jsonb else coalesce((
    select jsonb_build_object('state', s.state, 'company', s.name, 'company_id', s.id)
    from (
      select c.id, c.name, case
        when c.settings -> 'assistants' -> 'enabled' = 'false'::jsonb then 'off'
        when c.settings -> 'assistants' -> 'read_only' = 'true'::jsonb then 'read_only'
      end as state
      from public.memberships m
      join public.companies c on c.id = m.company_id
      where m.user_id = (select auth.uid()) and m.active and m.role <> 'subcontractor'
    ) s
    where s.state is not null
    order by (s.state = 'off') desc, s.name, s.id
    limit 1
  ), '{"state": "on"}'::jsonb) end
$$;

-- The same, for the server to ask with the person's token (the gateway and the API refuse an
-- assistant by it too, apps/api/src/lib/assistants.ts). An assistant may always ask.
create function public.assistant_switch() returns jsonb
language sql stable set search_path = '' as $$
  select private.assistant_switch()
$$;

revoke all on function private.assistant_switch(), public.assistant_switch() from public, anon;
grant execute on function private.assistant_switch(), public.assistant_switch() to authenticated, service_role;

-- As in 20261019002000_assistant_more_areas.sql, and only while the person's businesses let
-- assistants change things.
create or replace function private.assistant_may_change(p_area text, p_delete boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.assistant_client() is null or (exists (
    select 1 from public.assistant_connections a
    where a.user_id = (select auth.uid()) and a.client_id = private.assistant_client()
      and (a.level = 'full'
        or (a.level = 'full_no_money' and not private.assistant_money_area(p_area))
        or (a.level = 'areas' and not p_delete and p_area = any (a.areas)))
  ) and private.assistant_switch() ->> 'state' = 'on')
$$;

-- ---------------------------------------------------------------------------------------------
-- What only an assistant with full access may do, and the functions its tools call
-- ---------------------------------------------------------------------------------------------

-- "Deleting needs full access" only looked at DELETE requests. Three other things an assistant's
-- tools mark the same way (apps/api/src/assistant-tools: void_invoice, write_off_invoice,
-- merge_clients) could be done through the Data API by one given only the Invoices area: voiding or
-- writing off an invoice is a change to its status, and merging two clients is a function. Now
-- they need full access here too.

-- The functions an assistant may call that remove something for good.
create function private.assistant_rpc_deletes(p_function text) returns boolean
language sql immutable set search_path = '' as $$
  select p_function in ('merge_clients')
$$;
revoke all on function private.assistant_rpc_deletes(text) from public;
grant execute on function private.assistant_rpc_deletes(text) to authenticated, service_role;

-- Voiding an invoice, or writing it off, is the office giving up on being paid for it.
create function private.assistant_invoice_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return new; end if;
  if new.status in ('void', 'written_off') and new.status is distinct from old.status and not private.assistant_may_change('invoices', true) then
    raise exception 'This assistant can''t void or write off an invoice. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants.'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.assistant_invoice_guard() from public;
create trigger assistant_guard before update of status on public.invoices
  for each row execute function private.assistant_invoice_guard();

-- Two functions the assistant's tools call weren't here, so they ran in a request that can't write
-- and always failed for a real assistant: duplicate_quote (create_quote from a quote template) and
-- quote_exact_sent (send_quote, when the exact price follows a yes to the range). As in
-- 20261106000410_company_settings_merge.sql, with those two added under quotes.
create or replace function private.assistant_rpc_area(p_function text) returns text
language sql immutable set search_path = '' as $$
  select case p_function
    when 'convert_quote_to_job' then 'quotes'
    when 'create_invoice_for_job' then 'invoices'
    when 'duplicate_quote' then 'quotes'
    when 'merge_clients' then 'invoices'
    when 'merge_company_settings' then 'company'
    when 'quote_exact_sent' then 'quotes'
    when 'set_checklist_services' then 'checklists'
    when 'set_weather_rules' then 'prices'
  end
$$;

-- As in 20261103000200_assistant_document_styles.sql, with the company's switch first: off refuses
-- every request (but the one that asks about the switch), and read only refuses every change. And
-- a function that removes something for good is held to what deleting needs.
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
      'This assistant can''t change money: quotes, invoices, payments, pay or promo codes. To let it, give it Full access in Crewtavo, under Settings → AI assistants.'
    when v_delete and v_level = 'areas' then
      'This assistant can''t delete things. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants.'
    else format('This assistant can''t change %s. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.', case v_area
      when 'clients' then 'clients and properties' when 'records' then 'requests and notes' when 'jobs' then 'jobs'
      when 'schedule' then 'the schedule' when 'time' then 'clocks and timesheets' when 'quotes' then 'quotes'
      when 'invoices' then 'invoices and payments' when 'pay' then 'pay' when 'company' then 'company details'
      when 'prices' then 'the price list' when 'crews' then 'crews' when 'checklists' then 'checklists'
      when 'booking' then 'booking forms' when 'guides' then 'guides' when 'team' then 'people and roles'
      when 'templates' then 'document styles and contract terms' when 'marketing' then 'campaigns, reviews and social posts'
      when 'promos' then 'promo codes' else 'automations' end)
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- An owner sees their team's connections, and can end one
-- ---------------------------------------------------------------------------------------------

-- Every assistant the team of p_company has connected, newest first: who, which app (as it named
-- itself when it signed up with Auth's OAuth server), since when, and what the person let it
-- change (read only without a row). A connection is the person's, so one made by someone on two
-- teams shows for both. Nothing where Auth has no OAuth server. For the server only.
create function public.company_assistant_connections(p_company uuid)
returns table (user_id uuid, full_name text, client_id text, name text, logo text, connected_at timestamptz, level text, areas text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if to_regclass('auth.oauth_consents') is null or to_regclass('auth.oauth_clients') is null then return; end if;
  return query
    select g.user_id, p.full_name, g.client_id::text, o.client_name, o.logo_uri, g.granted_at, coalesce(a.level, 'read'), coalesce(a.areas, '{}')
    from auth.oauth_consents g
    join auth.oauth_clients o on o.id = g.client_id
    join public.memberships m on m.user_id = g.user_id and m.company_id = p_company and m.active and m.role <> 'subcontractor'
    left join public.profiles p on p.user_id = g.user_id
    left join public.assistant_connections a on a.user_id = g.user_id and a.client_id = g.client_id::text
    where g.revoked_at is null and o.deleted_at is null
    order by g.granted_at desc, g.user_id;
end $$;

-- Ends one, as the person's own Disconnect does: what it could change goes first (so it only
-- reads whatever happens next), then Auth's record that the person approved it and the sign-ins it
-- holds, so it can't get a new token. True when there was something to end. The person must be on
-- p_company's team, now or before. For the server only.
create function public.end_assistant_connection(p_company uuid, p_user uuid, p_client text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid;
  v_ended boolean;
begin
  if not exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = p_user) then
    raise exception 'That person isn''t on this team' using errcode = 'P0002';
  end if;
  delete from public.assistant_connections a where a.user_id = p_user and a.client_id = p_client;
  v_ended := found;
  if to_regclass('auth.oauth_consents') is null then return v_ended; end if;
  begin
    v_client := p_client::uuid;
  exception when invalid_text_representation then
    return v_ended;
  end;
  update auth.oauth_consents g set revoked_at = now() where g.user_id = p_user and g.client_id = v_client and g.revoked_at is null;
  v_ended := v_ended or found;
  delete from auth.sessions s where s.user_id = p_user and s.oauth_client_id = v_client;
  return v_ended or found;
end $$;

revoke all on function public.company_assistant_connections(uuid), public.end_assistant_connection(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.company_assistant_connections(uuid), public.end_assistant_connection(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
