-- Settings calls estimate templates "Document style" now, so the assistant's refusal says so too.
-- As in 20261101000500_assistant_templates_and_marketing.sql, with that one name changed.
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
