-- Signing in with a code by text, for a sub on a new phone (docs/subcontractors-plan.md, phase E:
-- "Sign-in without a password"). The sign-in page offers Text me a code: the sub types their phone
-- number, gets a 6-digit code from the instance's number, and types it in. It's Crewtavo's own
-- (apps/api/src/services/signInCodes.ts), not Auth's phone sign-in, which stays off.
--
--   private.sign_in_codes          one row per code asked for: keyed hashes of the number, the code
--                                  (tied to the account it was texted for) and the visitor's address,
--                                  never any of them as they are; when it runs out (10 minutes), the
--                                  tries made (5 at most) and when it was used (once). A number with no
--                                  sign-in gets a row too, with nobody's account and a code nobody
--                                  has, so its tries answer exactly as a real one's do ("isn't right",
--                                  then "has run out") and nobody learns which numbers have a sign-in.
--                                  Only the visitor who asked hears that a code ran out or was used
--                                  up; anyone else hears "isn't right", as for a number nobody asked
--                                  a code for.
--   sign_in_code_save()            a new code; any older one for the account or the number stops working
--   sign_in_code_check()           one try: 'ok' (now used), 'wrong', or for the visitor who asked,
--                                  'expired', 'dead' (5 wrong tries) or 'locked' (15 in a day)
--   tidy_sign_in_codes()           clears codes over a day old (the hourly upkeep)
--   sub_sign_ins_for_phone()       the sub sign-ins a number belongs to
--     (these four for the server's key only)
--   set_sub_sign_in_countries()    the countries, besides the US and Canada, whose numbers get codes
--                                  (companies.settings.subs.sign_in_countries, as calling codes); the
--                                  office with the subs area keeps it, as it does remind_subs
--
-- A number belongs to a sign-in only through the number the office keeps for the sub
-- (subcontractors.phone), never the one on the person's profile, which they can change themselves.
-- Both are compared in one spelling (private.phone_e164, the same rules as phoneE164 in
-- packages/core/src/phone.ts). And only a sign-in Crewtavo made for that sub (marked crewtavo_sub in
-- its app_metadata, by services/subAccess.ts), while it and the sub are both on, and that isn't also
-- someone's sign-in for another business: whoever has the code gets into the whole account.

-- ---------------------------------------------------------------------------------------------
-- Phone numbers in one spelling
-- ---------------------------------------------------------------------------------------------

-- E.164 ("+15405550101"), or null when it isn't a whole phone number. Mirrors phoneE164() in
-- packages/core/src/phone.ts: anything but digits and a leading + is left out; 10 digits, or 11
-- starting with 1, are the US and Canada (an area code doesn't start with 0 or 1); any other
-- country's number starts with + (or 00, or 011 as dialed from the US), 7 to 15 digits in all.
create function private.phone_e164(p_phone text) returns text
language sql immutable strict parallel safe set search_path = '' as $$
  select case
    when d like '1%' then case when d ~ '^1[2-9][0-9]{9}$' then '+' || d end
    when d ~ '^[2-9][0-9]{6,14}$' then '+' || d
  end
  from (
    select case
      when s !~ '^\+?[0-9]+$' then null
      when s like '+%' then substr(s, 2)
      when s like '011%' then substr(s, 4)
      when s like '00%' then substr(s, 3)
      when length(s) = 10 then '1' || s
      when length(s) = 11 and s like '1%' then s
    end as d
    from (select regexp_replace(p_phone, '[^0-9+]', '', 'g') as s) typed
  ) digits
$$;
-- Whoever adds or changes a sub works it out for the index below.
revoke all on function private.phone_e164(text) from public;
grant execute on function private.phone_e164(text) to authenticated, service_role;

-- Finding a sub by their number without reading every sub.
create index subcontractors_phone_idx on public.subcontractors (private.phone_e164(phone)) where active;

-- ---------------------------------------------------------------------------------------------
-- The codes
-- ---------------------------------------------------------------------------------------------

create table private.sign_in_codes (
  id uuid primary key default gen_random_uuid(),
  -- The account it signs in to; null for a number with no sign-in (a code nobody has).
  user_id uuid references auth.users (id) on delete cascade,
  phone_hash text not null check (length(phone_hash) = 64),
  code_hash text not null check (length(code_hash) = 64),
  ip_hash text check (length(ip_hash) = 64),
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index sign_in_codes_phone_idx on private.sign_in_codes (phone_hash, created_at desc);
create index sign_in_codes_user_idx on private.sign_in_codes (user_id) where user_id is not null;
create index sign_in_codes_created_idx on private.sign_in_codes (created_at);
alter table private.sign_in_codes enable row level security;
revoke all on private.sign_in_codes from public, anon, authenticated, service_role;

-- A new code for a number, and the account it's texted for (none for a number with no sign-in),
-- working for 10 minutes. Any older one for the account or the number stops working. One at a time
-- per number, so the newest is always the one asked for last.
create function public.sign_in_code_save(p_phone_hash text, p_code_hash text, p_user uuid default null, p_ip_hash text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz;
begin
  if p_phone_hash is null or p_code_hash is null then
    raise exception 'A code needs the number and the code.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sign_in_code:' || p_phone_hash, 0));
  v_now := clock_timestamp();
  update private.sign_in_codes set expires_at = v_now
  where (phone_hash = p_phone_hash or user_id = p_user) and used_at is null and expires_at > v_now;
  insert into private.sign_in_codes (user_id, phone_hash, code_hash, ip_hash, created_at, expires_at)
  values (p_user, p_phone_hash, p_code_hash, p_ip_hash, v_now, v_now + interval '10 minutes');
end $$;

-- One try at the number's newest code: the code's hash for the account the number belongs to now
-- (p_user, none when it has no sign-in), from the visitor p_ip_hash. 'ok' once, and the code is used.
-- Otherwise 'wrong', and the try counts: a code for another account (a number moved, or a sign-in
-- turned off since) is wrong too. Only the visitor who asked for the code hears more, since only they
-- know a code was asked for: 'expired' once it has run out (10 minutes, or a newer one was asked for
-- elsewhere), 'dead' once 5 wrong tries have used it up (the 5th included), and 'locked' when the
-- number, or the account, has had 15 wrong tries in a day, across all its codes (each new code
-- would otherwise start the guessing over). Anyone else gets 'wrong' for those, as they do for a
-- number nobody asked a code for, so a try never shows that someone asked for one. The row is
-- locked, so two tries at the same moment take turns: the second finds it used.
create function public.sign_in_code_check(p_phone_hash text, p_code_hash text, p_user uuid default null, p_ip_hash text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r private.sign_in_codes;
  v_ok boolean;
  v_asker boolean;
begin
  select * into r from private.sign_in_codes c
  where c.phone_hash = p_phone_hash
  order by c.created_at desc, c.id desc
  limit 1
  for update;
  if not found then return 'wrong'; end if;
  v_asker := r.ip_hash is not null and r.ip_hash = p_ip_hash;
  if r.expires_at <= clock_timestamp() then return case when v_asker then 'expired' else 'wrong' end; end if;
  if r.used_at is not null then return 'wrong'; end if;
  if r.attempts >= 5 then return case when v_asker then 'dead' else 'wrong' end; end if;
  -- Wrong tries in the last day, across the number's codes and the account's (a right one isn't wrong).
  if (select coalesce(sum(c.attempts - (c.used_at is not null)::integer), 0) from private.sign_in_codes c
      where (c.phone_hash = p_phone_hash or (p_user is not null and c.user_id = p_user))
        and c.created_at > clock_timestamp() - interval '1 day') >= 15 then
    return case when v_asker then 'locked' else 'wrong' end;
  end if;
  v_ok := r.user_id is not null and r.user_id = p_user and r.code_hash = p_code_hash;
  update private.sign_in_codes set attempts = attempts + 1, used_at = case when v_ok then clock_timestamp() end where id = r.id;
  if v_ok then return 'ok'; end if;
  return case when v_asker and r.attempts + 1 >= 5 then 'dead' else 'wrong' end;
end $$;

-- Codes over a day old, kept until then for looking into a run of requests. Run hourly.
create function public.tidy_sign_in_codes() returns integer
language sql security definer set search_path = '' as $$
  with gone as (delete from private.sign_in_codes where created_at < now() - interval '1 day' returning 1)
  select count(*)::integer from gone
$$;

revoke execute on function public.sign_in_code_save(text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.sign_in_code_check(text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.tidy_sign_in_codes() from public, anon, authenticated;
grant execute on function public.sign_in_code_save(text, text, uuid, text) to service_role;
grant execute on function public.sign_in_code_check(text, text, uuid, text) to service_role;
grant execute on function public.tidy_sign_in_codes() to service_role;

-- ---------------------------------------------------------------------------------------------
-- Whose number it is
-- ---------------------------------------------------------------------------------------------

-- The sub sign-ins a number (as typed, any spelling) belongs to: by the number the office keeps for
-- the sub, for an active sub with an active sign-in Crewtavo made for it, that isn't anyone's sign-in
-- at another business. A number outside the US and Canada counts only where the sub's company lists
-- its calling code. More than one row means the number is on more than one sign-in, and the server
-- sends no code.
create function public.sub_sign_ins_for_phone(p_phone text)
returns table (user_id uuid, company_id uuid, subcontractor_id uuid, company_name text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, s.company_id, s.id, c.name
  from public.subcontractors s
  join public.companies c on c.id = s.company_id
  join public.memberships m on m.company_id = s.company_id and m.subcontractor_id = s.id
  join auth.users u on u.id = m.user_id
  where s.active and private.phone_e164(s.phone) = private.phone_e164(p_phone)
    and m.active and m.role = 'subcontractor'
    and (starts_with(private.phone_e164(p_phone), '+1') or exists (
      select 1
      from jsonb_array_elements_text(case when jsonb_typeof(c.settings -> 'subs' -> 'sign_in_countries') = 'array'
        then c.settings -> 'subs' -> 'sign_in_countries' else '[]' end) as code
      where code ~ '^[1-9][0-9]{0,2}$' and starts_with(private.phone_e164(p_phone), '+' || code)
    ))
    and u.raw_app_meta_data ->> 'crewtavo_sub' = s.company_id::text || ':' || s.id::text
    and not exists (select 1 from public.memberships o where o.user_id = m.user_id and o.company_id <> s.company_id)
$$;
revoke execute on function public.sub_sign_ins_for_phone(text) from public, anon, authenticated;
grant execute on function public.sub_sign_ins_for_phone(text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The company's setting: which other countries' numbers get codes
-- ---------------------------------------------------------------------------------------------

-- Calling codes ("44", "+52"), each once, in order; 1 (the US and Canada) is always on and isn't
-- kept. Returns what was saved. The office with the subs area keeps it, as it does remind_subs
-- (set_sub_reminders); the rest of the company's settings stay with owners and admins.
create function public.set_sub_sign_in_countries(p_company uuid, p_countries text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare v_codes text[];
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'subs')) then
    raise exception 'Your role can''t change where subs get sign-in codes' using errcode = '42501';
  end if;
  v_codes := array(select distinct ltrim(btrim(x), '+') from unnest(coalesce(p_countries, '{}')) as x);
  if exists (select 1 from unnest(v_codes) as x where x !~ '^[1-9][0-9]{0,2}$') then
    raise exception 'A country''s calling code is 1 to 3 digits, like 44 for the UK.' using errcode = '22023';
  end if;
  v_codes := array(select x from unnest(v_codes) as x where x <> '1' order by x::integer);
  if cardinality(v_codes) > 20 then
    raise exception 'Add up to 20 countries.' using errcode = '22023';
  end if;
  update public.companies
  set settings = jsonb_set(coalesce(settings, '{}'), '{subs}',
    case when jsonb_typeof(settings -> 'subs') = 'object' then settings -> 'subs' else '{}' end || jsonb_build_object('sign_in_countries', to_jsonb(v_codes)))
  where id = p_company;
  return v_codes;
end $$;
revoke execute on function public.set_sub_sign_in_countries(uuid, text[]) from public, anon;
grant execute on function public.set_sub_sign_in_countries(uuid, text[]) to authenticated;

notify pgrst, 'reload schema';
