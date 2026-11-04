-- A booking form finds the client Crewtavo already has, as a website form does
-- (20261031000620_website_form_promo.sql): by email, else by phone, and their property by its
-- street. Until now every booking made a new client, so a returning customer showed up twice. A
-- matched client's details are never changed from the form: anyone can type someone's email.

create function public.booking_form_client(
  p_company uuid, p_name text, p_email text default null, p_phone text default null, p_address jsonb default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  -- A whole address only, as emailKey() in packages/core/src/email.ts takes them.
  v_email text := (select k from private.email_key(p_email) k where k ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(k) <= 254);
  v_phone text := private.phone_e164(p_phone);
  v_line1 text := nullif(trim(p_address ->> 'line1'), '');
  v_client uuid;
  v_property uuid;
  v_matched boolean;
begin
  select c.id into v_client
  from public.clients c
  where c.company_id = p_company
    and ((v_email is not null and private.email_key(c.email) = v_email) or (v_phone is not null and private.phone_e164(c.phone) = v_phone))
  order by (v_email is not null and private.email_key(c.email) = v_email) desc, c.status = 'archived', c.created_at
  limit 1;
  v_matched := v_client is not null;

  if not v_matched then
    insert into public.clients (company_id, status, display_name, email, phone, lead_source)
    values (p_company, 'lead', left(trim(p_name), 200), nullif(left(trim(p_email), 254), ''), nullif(left(trim(p_phone), 30), ''), 'Website form')
    returning id into v_client;
  elsif v_line1 is not null then
    select p.id into v_property from public.properties p
    where p.client_id = v_client and lower(trim(p.line1)) = lower(v_line1)
    order by p.created_at limit 1;
  end if;

  if v_property is null and v_line1 is not null then
    insert into public.properties (company_id, client_id, line1, city, postal_code)
    values (p_company, v_client, left(v_line1, 200), nullif(left(trim(p_address ->> 'city'), 100), ''), nullif(left(trim(p_address ->> 'postal_code'), 12), ''))
    returning id into v_property;
    return jsonb_build_object('client_id', v_client, 'property_id', v_property, 'matched', v_matched, 'new_property', true);
  end if;
  return jsonb_build_object('client_id', v_client, 'property_id', v_property, 'matched', v_matched, 'new_property', false);
end $$;

revoke execute on function public.booking_form_client(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.booking_form_client(uuid, text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
