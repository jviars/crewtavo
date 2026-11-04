-- A weather rule names its price list item by id as well as by name (settings.weather_rules[].service_id),
-- so renaming the item keeps its rule. The weather task matches the id first, and the name only for
-- a rule without one (packages/core/src/weather.ts).
--
--   * set_weather_rules keeps a rule's service_id when it's one of the business's items, and saves
--     the item's name with it as it's called now. A rule sent by name alone (an AI assistant, say),
--     or for an item since removed, gets the id and name of the item of that name, if there is one.
--   * Rules saved before this get the id of the item of their name, where one matches.

/**
 * As in 20261105000200_weather_rules.sql, with service_id: replace the business's weather rules
 * with `p_rules`, checked and tidied: each needs at least one limit, in range, and only the known
 * fields are kept. Returns what was saved.
 */
create or replace function public.set_weather_rules(p_company uuid, p_rules jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rule jsonb;
  v_name text;
  v_service uuid;
  v_found text;
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
    v_service := null;
    v_found := null;
    if coalesce(jsonb_typeof(v_rule -> 'service_id'), 'null') <> 'null' then
      if jsonb_typeof(v_rule -> 'service_id') = 'string' and pg_catalog.pg_input_is_valid(v_rule ->> 'service_id', 'uuid') then
        select s.id, s.name into v_service, v_found from public.services s where s.company_id = p_company and s.id = (v_rule ->> 'service_id')::uuid;
      end if;
      -- An item that's gone (or was never this business's) falls back to the rule's name; without
      -- one, the rule would be for every job.
      if v_service is null and v_name is null then
        raise exception 'A weather rule is for an item that isn''t on your price list.' using errcode = '22023';
      end if;
    end if;
    if v_service is null and v_name is not null then
      -- By name: the item of that name, an active one first.
      select s.id, s.name into v_service, v_found from public.services s
      where s.company_id = p_company and lower(trim(s.name)) = lower(v_name)
      order by s.active desc, s.created_at, s.id limit 1;
    end if;
    -- The item's name as it's called now goes with its id.
    v_name := coalesce(v_found, v_name);
    if length(v_name) > 200 then
      raise exception 'The work a weather rule is for is 200 characters at most.' using errcode = '22023';
    end if;
    v_clean := case when v_name is null then '{}' else jsonb_build_object('applies_to', v_name) end
            || case when v_service is null then '{}' else jsonb_build_object('service_id', v_service) end;
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
    if v_clean - 'applies_to' - 'service_id' = '{}' then
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

-- Rules saved before ids: the id of the item of their name, an active one first, where one matches.
-- Kept, so the database tests can run it on rules saved the old way.
create function private.fill_weather_rule_ids() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update public.companies c
  set settings = jsonb_set(c.settings, '{weather_rules}', (
    select jsonb_agg(case when jsonb_typeof(e.r) <> 'object' or e.r ? 'service_id' or s.id is null then e.r
                          else e.r || jsonb_build_object('service_id', s.id) end order by e.n)
    from jsonb_array_elements(c.settings -> 'weather_rules') with ordinality as e(r, n)
    left join lateral (
      select sv.id from public.services sv
      where sv.company_id = c.id and jsonb_typeof(e.r) = 'object' and lower(trim(sv.name)) = lower(trim(e.r ->> 'applies_to'))
      order by sv.active desc, sv.created_at, sv.id limit 1) s on true))
  where jsonb_typeof(c.settings -> 'weather_rules') = 'array'
    and exists (select 1 from jsonb_array_elements(c.settings -> 'weather_rules') r
                join public.services sv on sv.company_id = c.id and lower(trim(sv.name)) = lower(trim(r ->> 'applies_to'))
                where jsonb_typeof(r) = 'object' and not r ? 'service_id');
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.fill_weather_rule_ids() from public;
select private.fill_weather_rule_ids();

notify pgrst, 'reload schema';
