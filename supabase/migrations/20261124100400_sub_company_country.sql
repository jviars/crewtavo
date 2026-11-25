-- A sub's company basics say which country the business works in (companies.country,
-- 20261124100100_business_country.sql), as the team's company row does: the field app asks a sub
-- for the paperwork the business's country goes by (a W-9 only in the US) and shows a 1099 only
-- there, instead of guessing the country from the time zone.
--
-- As in 20261025002003_sub_field_app.sql, with country added at the end. A function's columns
-- can't change in place, so it's made again with the same grants. The release before this one reads
-- the same columns, and the extra one is left alone.
--
-- supabase/tests/sub_company_country_test.sql covers it.

drop function public.company_basics(uuid);

/**
 * The company as the field app needs it, for anyone with a sign-in for it (the team and subs): its
 * name, logo, time zone, currency, phone and country, and of its settings only the time clock's,
 * its branding and its working hours. The companies row also holds the AI assistant, maps, tax and
 * review settings, and a sub can't read it.
 */
create function public.company_basics(p_company uuid)
returns table (id uuid, name text, timezone text, currency text, phone text, logo text, settings jsonb, country text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.timezone, c.currency, c.phone,
    case when c.settings -> 'branding' ->> 'logo' ~ ('^' || c.id::text || '/logo/[0-9a-f-]{36}\.png$') then c.settings -> 'branding' ->> 'logo' end,
    (select coalesce(jsonb_object_agg(e.key, e.value), '{}') from jsonb_each(coalesce(c.settings, '{}')) e
     where e.key in ('clock', 'branding', 'working_hours')),
    c.country
  from public.companies c
  where c.id = p_company and p_company = any (private.worker_companies())
$$;

revoke execute on function public.company_basics(uuid) from public, anon;
grant execute on function public.company_basics(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
