-- Website forms (Apps → Crewtavo - Website Forms): the business keeps its own form on its own
-- website, in its own HTML, and points the form's action at its Crewtavo, the way Formspree works:
--
--   <form action="https://crm.example.com/f/3fa9c2d71b" method="POST">
--
-- Each message becomes a request (source web_form, website_form_id set) on the client it's from,
-- found by email or phone, or on a new lead; the people the form names get an email right away.
-- The address is a random key, not the company's or the form's name, so renaming either never
-- breaks a website, and a key bots have found can be swapped for a new one.
--
--   * Owners and admins who connect apps install it and manage its forms (the app's page).
--   * Messages come in only while the app is installed (settings.website_forms.enabled), through
--     the server (apps/api/src/routes/websiteForms.ts), as the service role: website_form_request.
--   * A message never changes the client it's matched to: what was typed stays on the request.

create table public.website_forms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  key text not null unique default substr(md5(gen_random_uuid()::text), 1, 10) check (key ~ '^[a-z0-9]{8,32}$'),
  name text not null check (char_length(name) between 1 and 80),
  -- Who's emailed each message (up to 5). Empty: nobody; it's still in Requests.
  email_to text[] not null default '{}' check (cardinality(email_to) <= 5),
  -- Where people go after sending: null is Crewtavo's own thank-you page.
  redirect_url text check (redirect_url ~ '^https?://' and char_length(redirect_url) <= 500),
  -- Only these websites may send to it, by host name (greenlawn.com); empty is any website.
  allowed_sites text[] not null default '{}' check (cardinality(allowed_sites) <= 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index website_forms_company_idx on public.website_forms (company_id, created_at);

comment on table public.website_forms is 'Forms on the business''s own website that post to /f/<key> on its Crewtavo (Apps → Crewtavo - Website Forms).';

select private.apply_policies('website_forms', '{owner,admin}', '{owner,admin}');
select private.restrict_area('website_forms', 'apps', true);
select private.add_touch_triggers(array['website_forms']);

alter table public.requests add column website_form_id uuid;
alter table public.requests add constraint requests_website_form_fkey
  foreign key (company_id, website_form_id) references public.website_forms (company_id, id) on delete set null (website_form_id);
create index requests_website_form_idx on public.requests (website_form_id, created_at desc) where website_form_id is not null;
comment on column public.requests.website_form_id is 'The website form a request came from (Apps → Crewtavo - Website Forms); its answers are keyed by the form''s own field names.';

-- Finding the client a message is from without reading every client.
create index clients_email_key_idx on public.clients (company_id, private.email_key(email)) where email is not null;
create index clients_phone_e164_idx on public.clients (company_id, private.phone_e164(phone)) where phone is not null;

-- ---------------------------------------------------------------------------------------------
-- Install and Uninstall
-- ---------------------------------------------------------------------------------------------

-- Installing the first time makes a form, emailing the business's own address (or, without one,
-- whoever installed it), so there's an address to paste right away. Uninstalling keeps every form
-- and its address; they take messages again once it's installed again.
create function public.website_forms_set_enabled(p_company uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can install website forms' using errcode = '42501';
  end if;
  update public.companies
  set settings = jsonb_set(coalesce(settings, '{}'), '{website_forms}', coalesce(settings -> 'website_forms', '{}') || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
  where id = p_company;
  if p_enabled and not exists (select 1 from public.website_forms where company_id = p_company) then
    select coalesce(nullif(trim(c.email), ''), nullif(trim(u.email), '')) into v_email
    from public.companies c left join auth.users u on u.id = (select auth.uid())
    where c.id = p_company;
    insert into public.website_forms (company_id, name, email_to)
    values (p_company, 'Contact form', case when v_email is null then '{}' else array[v_email] end);
  end if;
  return p_enabled;
end $$;

-- ---------------------------------------------------------------------------------------------
-- A message from a website form
-- ---------------------------------------------------------------------------------------------

-- The request for a message, on the client it's from: the one with this email, or else this phone
-- number (the oldest that isn't archived first), or a new lead. A matched client keeps their saved
-- name, email and phone (anyone can type anyone's email into a form): what was typed (p_contact)
-- goes on the request with the rest of the answers. The address is the client's property with the
-- same first line, or a new one. Returns the request, and whether the property is new (to locate).
create function public.website_form_request(
  p_form uuid, p_name text default null, p_email text default null, p_phone text default null, p_company_name text default null,
  p_address jsonb default '{}', p_title text default null, p_details text default null, p_answers jsonb default '{}',
  p_contact jsonb default '{}', p_web_visit jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.website_forms;
  -- A whole address only, as emailKey() in packages/core/src/email.ts takes them.
  v_email text := (select k from private.email_key(p_email) k where k ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(k) <= 254);
  v_phone text := private.phone_e164(p_phone);
  v_line1 text := nullif(trim(p_address ->> 'line1'), '');
  v_client uuid;
  v_property uuid;
  v_new_property boolean := false;
  v_matched boolean := false;
  v_request public.requests;
begin
  select * into f from public.website_forms where id = p_form;
  if not found then
    raise exception 'Form not found' using errcode = 'P0002';
  end if;
  if v_email is null and v_phone is null and nullif(trim(p_phone), '') is null then
    raise exception 'An email or phone number is needed' using errcode = '22023';
  end if;

  select c.id into v_client
  from public.clients c
  where c.company_id = f.company_id
    and ((v_email is not null and private.email_key(c.email) = v_email) or (v_phone is not null and private.phone_e164(c.phone) = v_phone))
  order by (v_email is not null and private.email_key(c.email) = v_email) desc, c.status = 'archived', c.created_at
  limit 1;
  v_matched := v_client is not null;

  if not v_matched then
    insert into public.clients (company_id, status, display_name, company_name, email, phone, lead_source)
    values (
      f.company_id, 'lead',
      left(coalesce(nullif(trim(p_name), ''), nullif(trim(p_company_name), ''), v_email, nullif(trim(p_phone), '')), 200),
      nullif(left(trim(p_company_name), 200), ''), v_email, nullif(left(trim(p_phone), 30), ''), 'Website form'
    )
    returning id into v_client;
  end if;

  if v_line1 is not null then
    if v_matched then
      select p.id into v_property from public.properties p
      where p.client_id = v_client and lower(trim(p.line1)) = lower(v_line1)
      order by p.created_at limit 1;
    end if;
    if v_property is null then
      insert into public.properties (company_id, client_id, line1, line2, city, region, postal_code)
      values (
        f.company_id, v_client, left(v_line1, 200), nullif(left(trim(p_address ->> 'line2'), 200), ''),
        nullif(left(trim(p_address ->> 'city'), 100), ''), nullif(left(trim(p_address ->> 'region'), 100), ''), nullif(left(trim(p_address ->> 'postal_code'), 12), '')
      )
      returning id into v_property;
      v_new_property := true;
    end if;
  end if;

  insert into public.requests (company_id, client_id, property_id, website_form_id, source, title, details, answers, web_visit, created_by)
  values (
    f.company_id, v_client, v_property, f.id, 'web_form', left(coalesce(nullif(trim(p_title), ''), f.name), 200), nullif(trim(p_details), ''),
    coalesce(p_answers, '{}') || case when v_matched then coalesce(p_contact, '{}') else '{}' end, p_web_visit, null
  )
  returning * into v_request;

  return jsonb_build_object(
    'request_id', v_request.id, 'number', v_request.number, 'client_id', v_client, 'property_id', v_property,
    'new_property', v_new_property, 'matched', v_matched
  );
end $$;

revoke execute on function public.website_forms_set_enabled(uuid, boolean),
  public.website_form_request(uuid, text, text, text, text, jsonb, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.website_forms_set_enabled(uuid, boolean) to authenticated;
revoke execute on function public.website_form_request(uuid, text, text, text, text, jsonb, text, text, jsonb, jsonb, jsonb) from authenticated;
grant execute on function public.website_form_request(uuid, text, text, text, text, jsonb, text, text, jsonb, jsonb, jsonb) to service_role;

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();

notify pgrst, 'reload schema';
