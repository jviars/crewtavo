-- A sub's offers, pay notices and paperwork reminders go to the phone and email the office keeps for
-- them, as their sign-in codes do.
--
-- Notices beyond the bell go to the account's email and the profile's phone
-- (apps/api/src/services/delivery.ts). A sign-in Crewtavo makes for a sub is on a stand-in address and
-- carries no phone of the office's (apps/api/src/services/subAccess.ts): the sub's real phone and
-- email live only on the office's record, which the office keeps up to date (Subs → the sub). So a
-- sub given an email later never got offers by email, and a corrected number or address never
-- reached the sign-in, which could leave offers with prices going to an old number or someone else's.
--
--   sub_notice_contacts()   for the server's key: for each of these sign-ins that Crewtavo made for
--                           a sub (marked crewtavo_sub for that sub, and nobody's sign-in elsewhere),
--                           the email (never a stand-in) and phone on the sub's record as it is now.
--                           Email goes there; a text goes to the phone the sub put on their own
--                           profile, if any, else the record's. Someone's own account they sign in to
--                           as a sub keeps getting notices as that account always has.

create function public.sub_notice_contacts(p_users uuid[])
returns table (user_id uuid, company_id uuid, email text, phone text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.company_id,
    case when private.email_key(s.email) not like '%.invalid' then private.email_key(s.email) end,
    nullif(btrim(s.phone), '')
  from public.memberships m
  join public.subcontractors s on s.company_id = m.company_id and s.id = m.subcontractor_id
  join auth.users u on u.id = m.user_id
  where m.user_id = any (p_users) and m.role = 'subcontractor'
    and u.raw_app_meta_data ->> 'crewtavo_sub' = s.company_id::text || ':' || s.id::text
    and not exists (select 1 from public.memberships o where o.user_id = m.user_id and o.company_id <> m.company_id)
$$;
revoke execute on function public.sub_notice_contacts(uuid[]) from public, anon, authenticated;
grant execute on function public.sub_notice_contacts(uuid[]) to service_role;

notify pgrst, 'reload schema';
