-- A UK postcode district is whole in a sales area. Areas match a property's postal code by its start
-- (20261110000200_sales_areas.sql), which is right for US ZIPs ("462" covers 46201) and Canada's
-- codes ("K1A"), but UK districts overlap that way: "SW1" caught SW10 to SW19, "M1" caught M11 to
-- M19, and "S" (Sheffield) caught every SW. So for a UK postcode the area also has to end where a
-- part of its outward code does: an area ending in a digit doesn't take a postcode whose outward code
-- goes on with another digit, nor one ending in a letter one that goes on with a letter. "SW1" still
-- takes SW1A 1AA, "M1" M1 1AE, "S" S1 1AA, and an area as long as the outward code (or a sector,
-- "SW1A1") is matched by its start as before. Canada's codes, whose letters and digits take turns,
-- and everything else, are as before.
--
-- packages/core/src/forms.ts postalInArea is the same, for booking forms' service areas.
-- supabase/tests/postcode_districts_test.sql covers it.

-- Whether a postal code is in an area, both as private.postal_key writes them ("SW1A1AA", "SW1").
-- The empty area is everywhere.
create function private.postal_in_area(p_key text, p_area text) returns boolean
language sql immutable set search_path = '' as $$
  select left(p_key, length(p_area)) = p_area and (
    p_area = ''
    or coalesce(length(p_area) >= length(o.outward), true)
    or (right(p_area, 1) ~ '[0-9]') <> (substr(o.outward, length(p_area) + 1, 1) ~ '[0-9]')
  )
  from (select case
    when p_key ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$' then left(p_key, -3)
    when p_key ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$' then p_key
  end as outward) o
$$;

-- As in 20261110000200_sales_areas.sql, with the area matched by private.postal_in_area.
create or replace function private.area_salesperson(p_company uuid, p_property uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.user_id
  from public.sales_areas a
  join public.memberships m on m.company_id = a.company_id and m.user_id = a.user_id and m.active
  where a.company_id = p_company
    and private.postal_in_area(private.postal_key((select p.postal_code from public.properties p where p.id = p_property and p.company_id = p_company)), a.zip)
  order by length(a.zip) desc
  limit 1
$$;

revoke all on function private.postal_in_area(text, text) from public;
