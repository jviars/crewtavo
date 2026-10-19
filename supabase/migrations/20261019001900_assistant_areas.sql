-- AI assistants (Claude, ChatGPT over MCP) get more than one switch. Each connection is Read only
-- (the default), may change chosen areas (the price list, crews, booking forms...), or has full
-- access, which also lets it delete. The person who connected it picks in Settings → AI assistants
-- (packages/core/src/assistants.ts has the areas; the MCP tools check the same rules).
--
-- "Allow changes" let an assistant log requests and add notes, the only things its tools could
-- change, so a connection that had it keeps exactly that: the "records" area.
--
-- The database checks it again for every Data API write an assistant makes: the table has to be
-- in an area the connection may change, and deleting needs full access. A table outside every area
-- (people and roles, connected apps and keys, its own access...) is never written by an assistant,
-- whatever it's been given. Functions it calls answer, but can't write. Files need full access.

alter table public.assistant_connections
  add column level text not null default 'read' check (level in ('read', 'areas', 'full')),
  add column areas text[] not null default '{}'
    check (areas <@ array['records', 'company', 'prices', 'crews', 'checklists', 'booking', 'guides', 'automations']);

update public.assistant_connections set level = 'areas', areas = '{records}' where allow_changes;

/** The area a table's rows are in, for an assistant writing to it; null for every other table. */
create function private.assistant_table_area(p_table text) returns text
language sql immutable set search_path = '' as $$
  select case p_table
    when 'requests' then 'records'
    when 'messages' then 'records'
    when 'companies' then 'company'
    when 'services' then 'prices'
    when 'crews' then 'crews'
    when 'crew_members' then 'crews'
    when 'checklist_templates' then 'checklists'
    when 'intake_forms' then 'booking'
    when 'sop_pages' then 'guides'
    when 'sop_categories' then 'guides'
    when 'automation_rules' then 'automations'
  end
$$;

/**
 * Whether the request may change things in `p_area` (deleting, with `p_delete`). Always true for an
 * ordinary sign-in. An assistant needs full access, or the area chosen and not deleting.
 */
create function private.assistant_may_change(p_area text, p_delete boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.assistant_client() is null or exists (
    select 1 from public.assistant_connections a
    where a.user_id = (select auth.uid()) and a.client_id = private.assistant_client()
      and (a.level = 'full' or (a.level = 'areas' and not p_delete and p_area = any (a.areas)))
  )
$$;

revoke all on function private.assistant_table_area(text), private.assistant_may_change(text, boolean) from public;
grant execute on function private.assistant_table_area(text), private.assistant_may_change(text, boolean) to authenticated, service_role;

create or replace function hooks.before_request() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_method text := current_setting('request.method', true);
  v_path text := coalesce(current_setting('request.path', true), '');
  v_area text;
  -- Taking someone off a crew is a change to the crew, not deleting anything.
  v_delete boolean := v_method = 'DELETE' and v_path <> '/crew_members';
begin
  if private.assistant_client() is null then return; end if;
  if v_method in ('GET', 'HEAD') or v_path like '/rpc/%' then
    perform set_config('transaction_read_only', 'on', true);
    return;
  end if;
  v_area := private.assistant_table_area(ltrim(v_path, '/'));
  if v_area is not null and private.assistant_may_change(v_area, v_delete) then return; end if;
  raise exception using errcode = 'PT403', message = case
    when v_area is null then 'An AI assistant can''t change this. Do it in Crewtavo itself.'
    when v_delete then 'This assistant can''t delete things. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants.'
    else format('This assistant can''t change %s. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.', case v_area
      when 'records' then 'requests and notes' when 'company' then 'company details' when 'prices' then 'the price list' when 'crews' then 'crews'
      when 'checklists' then 'checklists' when 'booking' then 'booking forms' when 'guides' then 'guides' else 'automations' end)
  end;
end $$;

-- Files: only with full access.
drop policy files_assistant_insert on storage.objects;
drop policy files_assistant_update on storage.objects;
drop policy files_assistant_delete on storage.objects;
create policy files_assistant_insert on storage.objects as restrictive for insert to authenticated
  with check ((select private.assistant_may_change('files', false)));
create policy files_assistant_update on storage.objects as restrictive for update to authenticated
  using ((select private.assistant_may_change('files', false))) with check ((select private.assistant_may_change('files', false)));
create policy files_assistant_delete on storage.objects as restrictive for delete to authenticated
  using ((select private.assistant_may_change('files', true)));

drop function private.assistant_may_change();
alter table public.assistant_connections drop column allow_changes;

-- ---------------------------------------------------------------------------------------------
-- The company: an assistant changes its details and the settings on Settings → Company, nothing
-- else. Above all not settings.assistants, the owner's own limits on assistants.
-- ---------------------------------------------------------------------------------------------

create function private.assistant_company_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  details constant text[] := array['name', 'phone', 'email', 'website', 'address', 'timezone', 'settings', 'updated_at'];
  settings constant text[] := array['payment_terms_days', 'default_tax_rate', 'quote_valid_days', 'working_hours', 'branding', 'hub_tips', 'depot'];
begin
  if private.assistant_client() is null then return new; end if;
  if to_jsonb(new) - details is distinct from to_jsonb(old) - details
    or coalesce(new.settings, '{}') - settings is distinct from coalesce(old.settings, '{}') - settings
    or coalesce(new.settings -> 'branding', '{}') - 'color' is distinct from coalesce(old.settings -> 'branding', '{}') - 'color' then
    raise exception 'An AI assistant can change the company''s details and the settings on Settings → Company, nothing else.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger assistant_guard before update on public.companies for each row execute function private.assistant_company_guard();

notify pgrst, 'reload schema';
