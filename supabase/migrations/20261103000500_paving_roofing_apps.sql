-- Paving and Roofing become built-in apps (Apps → Crewtavo - Paving, Apps → Crewtavo - Roofing),
-- like Drive and Careers, instead of following the business's trade (companies.trade_preset), so a
-- business that does both can have both. The trade only picks starter prices and terms now.
--
--   settings.paving_app    installed or not ({enabled, changed_at}): the Paving section, and the
--                          paving items on the measuring map.
--   settings.roofing_app   the same for Roofing: the Roofing section, the roof tools on the measuring
--                          map, and packages priced as roofs. Not settings.roofing, which holds the
--                          price ranges: a save of the ranges can never install or uninstall it.
--
-- Every paving and roofing business has its app installed when this ships, so nothing changes for
-- them; signing up with either trade installs it too (apps/api/src/routes/account.ts). Changing the
-- trade later leaves the apps as they are.

-- Installs each business's app for its trade when it has never had the switch, and says how many. A
-- business that uninstalled it keeps it off.
create function private.install_trade_apps() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.companies c
     set settings = jsonb_set(coalesce(c.settings, '{}'), array[t.app], jsonb_build_object('enabled', true, 'changed_at', now()))
    from (values ('paving', 'paving_app'), ('roofing_exteriors', 'roofing_app')) as t(trade, app)
   where c.trade_preset = t.trade and jsonb_typeof(c.settings -> t.app) is distinct from 'object';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.install_trade_apps() from public;

select private.install_trade_apps();

-- Install and Uninstall (p_app 'paving' or 'roofing'), as careers_set_enabled. Nothing is deleted:
-- uninstalling hides the section, and every takeoff, estimate and package stays.
create function public.trade_app_set_enabled(p_company uuid, p_app text, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_key text := case p_app when 'paving' then 'paving_app' when 'roofing' then 'roofing_app' end;
begin
  if v_key is null then
    raise exception 'There''s no app called %', p_app using errcode = '22023';
  end if;
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can install %', initcap(p_app) using errcode = '42501';
  end if;
  update public.companies
     set settings = jsonb_set(coalesce(settings, '{}'), array[v_key],
       (case when jsonb_typeof(settings -> v_key) = 'object' then settings -> v_key else '{}'::jsonb end)
         || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
   where id = p_company;
  return p_enabled;
end $$;

revoke execute on function public.trade_app_set_enabled(uuid, text, boolean) from public, anon;
grant execute on function public.trade_app_set_enabled(uuid, text, boolean) to authenticated;

notify pgrst, 'reload schema';
