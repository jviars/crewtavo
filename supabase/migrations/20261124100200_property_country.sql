-- A property is in its business's country (companies.country, 20261124100100_business_country.sql)
-- unless it says otherwise. No form asks for a property's country, so until now every property came
-- in as the US, the column's default, and a Canadian or British business's addresses were looked up
-- on the map as American ones.
--
--   * A new property that comes in as the US takes its business's country when the business is
--     elsewhere: the release before this one, still running while the update goes in, makes them
--     without a country. Unless its client's billing address names a country: only Stripe's
--     customers have one, and the Stripe import gives the property that country
--     (stripe_import_invoice), the US included. A property that names another country keeps it.
--   * Properties made before this get the same, once, as does a business's when its country
--     changes (Settings → Company): those in the old country by default move to the new one. A
--     property the US Census found on the map is in the US and stays there.
--   * Those moved that never got a spot on the map wait in private.properties_to_find for the pins
--     task (apps/api/src/services/properties.ts relocatePins), which looks them up again in their
--     country: properties_to_find and property_found are its part.
--
-- supabase/tests/property_country_test.sql covers it.

-- Properties waiting to be looked up on the map again, in the country they were moved to.
create table private.properties_to_find (
  property_id uuid primary key references public.properties (id) on delete cascade,
  added_at timestamptz not null default now()
);

create function private.property_country() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_country text;
begin
  if nullif(trim(new.country), '') is not null and new.country <> 'US' then
    return new;
  end if;
  select c.country into v_country from public.companies c where c.id = new.company_id;
  if new.country = 'US' and (coalesce(v_country, 'US') = 'US' or exists (
    select 1 from public.clients cl where cl.id = new.client_id and nullif(trim(cl.billing_address ->> 'country'), '') is not null
  )) then
    return new;
  end if;
  new.country := coalesce(v_country, 'US');
  return new;
end $$;
create trigger property_country before insert on public.properties
  for each row execute function private.property_country();

-- A business's properties that are in p_from only by default move to its country as it is now: not
-- one the Census found in the US (unless they're moving there), nor one whose client's billing
-- address names a country. The ones with no spot are put on the list to look up. How many moved.
create function private.move_properties_to_business_country(p_company uuid, p_from text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_moved integer;
begin
  with moved as (
    update public.properties p set country = c.country
      from public.companies c
     where c.id = p_company and p.company_id = p_company and p.country = p_from and c.country <> p_from
       and (p.located_by is distinct from 'census' or c.country = 'US')
       and not exists (select 1 from public.clients cl where cl.id = p.client_id and nullif(trim(cl.billing_address ->> 'country'), '') is not null)
    returning p.id, p.lat, p.lng
  ), waiting as (
    insert into private.properties_to_find (property_id)
    select id from moved where lat is null or lng is null
    on conflict do nothing
  )
  select count(*) into v_moved from moved;
  return v_moved;
end $$;

create function private.company_country_moved() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.move_properties_to_business_country(new.id, old.country);
  return null;
end $$;
create trigger country_moved after update of country on public.companies
  for each row when (old.country is distinct from new.country) execute function private.company_country_moved();

-- Every business outside the US so far was taken to be in it.
select private.move_properties_to_business_country(id, 'US') from public.companies where country <> 'US';

-- The properties waiting to be looked up, after p_after (the pins task goes through them in id
-- order), with their address as it is now. One that got a spot meanwhile leaves the list.
create function public.properties_to_find(p_after uuid default null, p_limit integer default 12)
returns table (id uuid, company_id uuid, line1 text, line2 text, city text, region text, postal_code text, country text)
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.properties_to_find q using public.properties p
   where p.id = q.property_id and p.lat is not null and p.lng is not null;
  return query
  select p.id, p.company_id, p.line1, p.line2, p.city, p.region, p.postal_code, p.country
    from private.properties_to_find q
    join public.properties p on p.id = q.property_id
   where p_after is null or q.property_id > p_after
   order by q.property_id
   limit least(greatest(coalesce(p_limit, 12), 1), 100);
end $$;

-- What looking a waiting property up said: where it is (saved only while it still has no spot), or
-- nothing when the geocoder doesn't know the address. Either way it leaves the list. True when the
-- spot was saved.
create function public.property_found(p_property uuid, p_lat double precision default null, p_lng double precision default null, p_source text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_saved boolean := false;
begin
  if (p_lat is null) <> (p_lng is null) or (p_lat is not null and p_source is distinct from 'census' and p_source is distinct from 'openstreetmap') then
    raise exception 'A property''s spot has lat, lng and the geocoder that found it' using errcode = '22023';
  end if;
  if p_lat is not null then
    update public.properties set lat = p_lat, lng = p_lng, located_by = p_source
     where id = p_property and (lat is null or lng is null);
    v_saved := found;
  end if;
  delete from private.properties_to_find where property_id = p_property;
  return v_saved;
end $$;

revoke all on table private.properties_to_find from public, anon, authenticated;
revoke all on function private.property_country(), private.move_properties_to_business_country(uuid, text), private.company_country_moved() from public;
revoke execute on function public.properties_to_find(uuid, integer), public.property_found(uuid, double precision, double precision, text) from public, anon, authenticated;
grant execute on function public.properties_to_find(uuid, integer), public.property_found(uuid, double precision, double precision, text) to service_role;

notify pgrst, 'reload schema';
