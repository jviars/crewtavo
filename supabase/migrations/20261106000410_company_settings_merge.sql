-- Saving a screen's settings changes only its own. Settings → Company, Settings → Schedule and the AI
-- assistant's company tool used to save the whole companies.settings as they read it, so a page open
-- since before a newer change (a weather rule, an app turned on) put the old one back.
--
-- merge_company_settings merges the keys given into settings and leaves the rest: a key's value
-- replaces the one saved, except an object given for an object saved, whose keys are merged in (so
-- {"branding": {"color": ...}} keeps the logo). It runs as the caller, so row-level security and
-- the settings guards decide as they do for any change to the company: owners and admins.

create function public.merge_company_settings(p_company uuid, p_settings jsonb) returns void
language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(p_settings) is distinct from 'object' then
    raise exception 'Settings are a set of names and values.' using errcode = '22023';
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
revoke execute on function public.merge_company_settings(uuid, jsonb) from public, anon;
grant execute on function public.merge_company_settings(uuid, jsonb) to authenticated;

-- An AI assistant merges settings as a change to company details, which assistant_company_guard
-- then holds to the settings on Settings → Company (as in 20261106000100_client_merge.sql, with that
-- one added).
create or replace function private.assistant_rpc_area(p_function text) returns text
language sql immutable set search_path = '' as $$
  select case p_function
    when 'convert_quote_to_job' then 'quotes'
    when 'create_invoice_for_job' then 'invoices'
    when 'merge_clients' then 'invoices'
    when 'merge_company_settings' then 'company'
    when 'set_checklist_services' then 'checklists'
    when 'set_weather_rules' then 'prices'
  end
$$;

notify pgrst, 'reload schema';
