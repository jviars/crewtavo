-- Weather rules a business changes itself (Settings → Weather rules). They stay where sign-up puts
-- the trade preset's, settings.weather_rules: a list of {applies_to, max_rain_pct, min_temp_f,
-- max_temp_f, max_wind_mph, requires_dry_hours}, where applies_to is a price list item's name (none:
-- every job). The weather task warns about visits whose job has that work (packages/core/src/weather.ts);
-- nothing is moved by itself. A job's own jobs.weather_rules, when it has any, still come first.
--
-- Company settings are the owners' and admins' to change, but these are set like the price list and
-- checklists: by the office with the Settings area too, through set_weather_rules, which checks and
-- tidies them. AI assistants set them the same way, as a change to the price list.

/**
 * Replace the business's weather rules with `p_rules`, checked and tidied: each needs at least one
 * limit, in range, and only the known fields are kept. Returns what was saved.
 */
create function public.set_weather_rules(p_company uuid, p_rules jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rule jsonb;
  v_name text;
  v_clean jsonb;
  v_limit record;
  v_saved jsonb := '[]';
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'settings')) then
    raise exception 'Your role can''t change weather rules.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rules) is distinct from 'array' then
    raise exception 'Weather rules are a list of up to 50.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rules) > 50 then
    raise exception 'Weather rules are a list of up to 50.' using errcode = '22023';
  end if;
  for v_rule in select value from jsonb_array_elements(p_rules) loop
    if jsonb_typeof(v_rule) <> 'object' then
      raise exception 'Each weather rule is a set of limits.' using errcode = '22023';
    end if;
    v_name := nullif(trim(v_rule ->> 'applies_to'), '');
    if length(v_name) > 200 then
      raise exception 'The work a weather rule is for is 200 characters at most.' using errcode = '22023';
    end if;
    v_clean := case when v_name is null then '{}' else jsonb_build_object('applies_to', v_name) end;
    for v_limit in
      select * from (values
        ('max_rain_pct', 0, 100, 'The most rain chance is 0 to 100%.'),
        ('min_temp_f', -40, 130, 'The lowest temperature is -40°F to 130°F.'),
        ('max_temp_f', -40, 130, 'The highest temperature is -40°F to 130°F.'),
        ('max_wind_mph', 0, 100, 'The most wind is 0 to 100 mph.'),
        ('requires_dry_hours', 1, 168, 'Dry hours after are 1 to 168.')) l(field, low, high, message)
    loop
      continue when coalesce(jsonb_typeof(v_rule -> v_limit.field), 'null') = 'null';
      if jsonb_typeof(v_rule -> v_limit.field) <> 'number' then
        raise exception '%', v_limit.message using errcode = '22023';
      end if;
      if (v_rule ->> v_limit.field)::numeric not between v_limit.low and v_limit.high then
        raise exception '%', v_limit.message using errcode = '22023';
      end if;
      v_clean := v_clean || jsonb_build_object(v_limit.field, v_rule -> v_limit.field);
    end loop;
    if v_clean - 'applies_to' = '{}' then
      raise exception 'A weather rule needs at least one limit: rain, temperature, wind or dry hours.' using errcode = '22023';
    end if;
    if (v_clean ->> 'min_temp_f')::numeric > (v_clean ->> 'max_temp_f')::numeric then
      raise exception 'A weather rule''s lowest temperature has to be below its highest.' using errcode = '22023';
    end if;
    v_saved := v_saved || jsonb_build_array(v_clean);
  end loop;
  update public.companies set settings = jsonb_set(coalesce(settings, '{}'), '{weather_rules}', v_saved) where id = p_company;
  return v_saved;
end $$;
revoke execute on function public.set_weather_rules(uuid, jsonb) from public, anon;
grant execute on function public.set_weather_rules(uuid, jsonb) to authenticated;

-- An AI assistant sets them with the function above, as a change to the price list (as in
-- 20261103000300_checklists_by_service.sql, with that one added).
create or replace function private.assistant_rpc_area(p_function text) returns text
language sql immutable set search_path = '' as $$
  select case p_function
    when 'convert_quote_to_job' then 'quotes'
    when 'create_invoice_for_job' then 'invoices'
    when 'set_checklist_services' then 'checklists'
    when 'set_weather_rules' then 'prices'
  end
$$;

-- As in 20261104000100_trip_fee_minimum.sql, with weather_rules added, so the function above works
-- for an assistant too (one that may change the price list, as assistant_rpc_area says).
create or replace function private.assistant_company_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  details constant text[] := array['name', 'phone', 'email', 'website', 'address', 'timezone', 'settings', 'updated_at'];
  settings constant text[] := array['payment_terms_days', 'default_tax_rate', 'quote_valid_days', 'working_hours', 'branding', 'hub_tips', 'depot',
                                    'minimum_charge', 'late_fee', 'weather_rules'];
begin
  if private.assistant_client() is null then return new; end if;
  if to_jsonb(new) - details is distinct from to_jsonb(old) - details
    or coalesce(new.settings, '{}') - settings is distinct from coalesce(old.settings, '{}') - settings
    or coalesce(new.settings -> 'branding', '{}') - 'color' is distinct from coalesce(old.settings -> 'branding', '{}') - 'color' then
    raise exception 'An AI assistant can change the company''s details and the settings on Settings → Company, nothing else.' using errcode = '42501';
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
