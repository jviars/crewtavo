-- Signing in with a code by email, for a sub on a new phone when texting isn't there for them
-- (docs/subcontractors-plan.md §7: "Without Twilio, codes come by email", decided 25 October 2026).
-- The sign-in page offers Get a sign-in code by email: the sub types the email address the office
-- keeps for them, gets the same kind of 6-digit code, sent the way their company's other email goes
-- out (apps/api/src/services/signInCodes.ts), and types it in. Where the instance can text, text
-- comes first and email is there for a sub with no phone on file.
--
-- It's the text sign-in's machinery (20261025005001_sign_in_codes.sql) with a second way in, not a
-- copy of it:
--   private.sign_in_codes          one row per code, by text or by email (channel). phone_hash is now
--                                  address_hash: the keyed hash of the number or of the email address
--                                  (trimmed and lower-cased), never either as it is. The rest is as it
--                                  was: the code tied to the account it went to, a row with nobody's
--                                  account and a code nobody has for an address with no sign-in, the
--                                  visitor who asked, 10 minutes, 5 tries, one use, and 15 wrong tries
--                                  a day for an address, or for an account whichever way its codes went.
--   sign_in_code_save()            now says which way the code went; a new one runs out any older one
--                                  for the address, and stops any for the account at its other addresses
--   sign_in_code_check()           now says which way the code went; a stopped code is never right
--                                  again, but answers as a live one would (below)
--   sub_sign_ins_for_email()       the sub sign-ins an email address belongs to
--     (these three for the server's key only)
--
-- An address belongs to a sign-in only through the email the office keeps for the sub
-- (subcontractors.email), never the one on the person's profile or on their account, which they can
-- change themselves, and never a placeholder (.invalid) address, which nothing is sent to. The rest is
-- the number's rule: only a sign-in Crewtavo made for that sub (its crewtavo_sub mark), while it and
-- the sub are both on, and that isn't also someone's sign-in for another business.
--
-- One account now has two addresses, a number and an email, and nothing may show that they're the
-- same sub's. So the visitor who asked never hears anything different because of a code at the
-- account's other address: a code stopped by a newer one at the other address (stopped_at) keeps its
-- own 10 minutes and its tries, and only stops being right; and the 15 wrong tries a day across the
-- account stop it signing in without saying "too many" (that's said only for the address's own 15).

-- ---------------------------------------------------------------------------------------------
-- Email addresses in one spelling
-- ---------------------------------------------------------------------------------------------

-- Trimmed and lower-cased, or null when blank: how the sign-in page's address and the office's are
-- compared (the API hashes the typed one the same way, emailKey in packages/core/src/email.ts).
create function private.email_key(p_email text) returns text
language sql immutable strict parallel safe set search_path = '' as $$
  select nullif(lower(regexp_replace(p_email, '^\s+|\s+$', '', 'g')), '')
$$;
-- Whoever adds or changes a sub works it out for the index below.
revoke all on function private.email_key(text) from public;
grant execute on function private.email_key(text) to authenticated, service_role;

-- Finding a sub by their email without reading every sub.
create index subcontractors_email_key_idx on public.subcontractors (private.email_key(email)) where active;

-- ---------------------------------------------------------------------------------------------
-- The codes: by text or by email
-- ---------------------------------------------------------------------------------------------

alter table private.sign_in_codes rename column phone_hash to address_hash;
alter table private.sign_in_codes rename constraint sign_in_codes_phone_hash_check to sign_in_codes_address_hash_check;
-- Every code so far was texted.
alter table private.sign_in_codes add column channel text not null default 'text' check (channel in ('text', 'email'));
alter table private.sign_in_codes alter column channel drop default;
-- When a newer code for the same account, at its other address, stopped this one: it's never right
-- again, but runs out and counts tries as a live one does (sign_in_code_check).
alter table private.sign_in_codes add column stopped_at timestamptz;
drop index private.sign_in_codes_phone_idx;
create index sign_in_codes_address_idx on private.sign_in_codes (channel, address_hash, created_at desc);

-- They now say which way the code went, so they're made again under their new arguments.
drop function public.sign_in_code_save(text, text, uuid, text);
drop function public.sign_in_code_check(text, text, uuid, text);

-- Codes for one address, and for one account, take turns: saving and trying both wait for the
-- address, then the account, always in that order, so neither ever waits on the other in a circle.
create function private.sign_in_code_turn(p_address_hash text, p_user uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('sign_in_code:' || p_address_hash, 0));
  if p_user is not null then
    perform pg_advisory_xact_lock(hashtextextended('sign_in_code_user:' || p_user::text, 0));
  end if;
end $$;
revoke all on function private.sign_in_code_turn(text, uuid) from public;

-- A new code for an address ('text': a number; 'email': an email address), and the account it goes to
-- (none for an address with no sign-in), working for 10 minutes. Any older one for the address runs
-- out, and any for the account at its other address is stopped, so an account has one code that works
-- at a time: a code by text and one by email asked for at the same moment take turns, and the later one
-- is it. A stopped code isn't run out, since the visitor who asked for it would hear so, and learn that
-- the two addresses are one account's.
create function public.sign_in_code_save(p_channel text, p_address_hash text, p_code_hash text, p_user uuid default null, p_ip_hash text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz;
begin
  if p_channel is null or p_channel not in ('text', 'email') or p_address_hash is null or p_code_hash is null then
    raise exception 'A code needs the way it goes, the address and the code.' using errcode = '22023';
  end if;
  perform private.sign_in_code_turn(p_address_hash, p_user);
  v_now := clock_timestamp();
  update private.sign_in_codes set expires_at = v_now
  where channel = p_channel and address_hash = p_address_hash and used_at is null and expires_at > v_now;
  if p_user is not null then
    update private.sign_in_codes set stopped_at = v_now
    where user_id = p_user and not (channel = p_channel and address_hash = p_address_hash)
      and used_at is null and stopped_at is null and expires_at > v_now;
  end if;
  insert into private.sign_in_codes (channel, user_id, address_hash, code_hash, ip_hash, created_at, expires_at)
  values (p_channel, p_user, p_address_hash, p_code_hash, p_ip_hash, v_now, v_now + interval '10 minutes');
end $$;

-- One try at the address's newest code, as before (20261025005001_sign_in_codes.sql): the code's hash
-- for the account the address belongs to now (p_user, none when it has no sign-in), from the visitor
-- p_ip_hash. 'ok' once, and the code is used. Otherwise 'wrong', and the try counts. Only the visitor
-- who asked for the code hears more: 'expired' once it has run out (10 minutes, or a newer one was
-- asked for at this address), 'dead' once 5 wrong tries have used it up, and 'locked' when the address
-- has had 15 wrong tries in a day. A code stopped by a newer one at the account's other address, and
-- any code once the account has had 15 wrong tries in a day by either way, is never right, and
-- otherwise answers as any wrong try does: what the visitor hears depends only on this address's
-- codes. Tries at one address, or at one account's codes, take turns: the second finds the code used,
-- or the first's wrong try counted.
create function public.sign_in_code_check(p_channel text, p_address_hash text, p_code_hash text, p_user uuid default null, p_ip_hash text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r private.sign_in_codes;
  v_ok boolean;
  v_asker boolean;
begin
  if p_channel is null or p_address_hash is null then return 'wrong'; end if;
  perform private.sign_in_code_turn(p_address_hash, p_user);
  select * into r from private.sign_in_codes c
  where c.channel = p_channel and c.address_hash = p_address_hash
  order by c.created_at desc, c.id desc
  limit 1
  for update;
  if not found then return 'wrong'; end if;
  v_asker := r.ip_hash is not null and r.ip_hash = p_ip_hash;
  if r.expires_at <= clock_timestamp() then return case when v_asker then 'expired' else 'wrong' end; end if;
  if r.used_at is not null then return 'wrong'; end if;
  if r.attempts >= 5 then return case when v_asker then 'dead' else 'wrong' end; end if;
  -- Wrong tries in the last day at the address (a right one isn't wrong): past 15, no more are counted.
  if (select coalesce(sum(c.attempts - (c.used_at is not null)::integer), 0) from private.sign_in_codes c
      where c.channel = p_channel and c.address_hash = p_address_hash
        and c.created_at > clock_timestamp() - interval '1 day') >= 15 then
    return case when v_asker then 'locked' else 'wrong' end;
  end if;
  -- And across the account's codes, by either way: past 15, it doesn't sign in, but answers and counts
  -- as a wrong try, as it would for an address that isn't the account's.
  v_ok := r.user_id is not null and r.user_id = p_user and r.code_hash = p_code_hash and r.stopped_at is null
    and (select coalesce(sum(c.attempts - (c.used_at is not null)::integer), 0) from private.sign_in_codes c
         where c.user_id = p_user and c.created_at > clock_timestamp() - interval '1 day') < 15;
  update private.sign_in_codes set attempts = attempts + 1, used_at = case when v_ok then clock_timestamp() end where id = r.id;
  if v_ok then return 'ok'; end if;
  return case when v_asker and r.attempts + 1 >= 5 then 'dead' else 'wrong' end;
end $$;

revoke execute on function public.sign_in_code_save(text, text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.sign_in_code_check(text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.sign_in_code_save(text, text, text, uuid, text) to service_role;
grant execute on function public.sign_in_code_check(text, text, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Whose email address it is
-- ---------------------------------------------------------------------------------------------

-- The sub sign-ins an email address (as typed, in any case, with spaces around it) belongs to: by
-- the email the office keeps for the sub, never a placeholder, for an active sub with an active
-- sign-in Crewtavo made for it, that isn't anyone's sign-in at another business. More than one row
-- means the address is on more than one sign-in, and the server sends no code.
create function public.sub_sign_ins_for_email(p_email text)
returns table (user_id uuid, company_id uuid, subcontractor_id uuid, company_name text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, s.company_id, s.id, c.name
  from public.subcontractors s
  join public.companies c on c.id = s.company_id
  join public.memberships m on m.company_id = s.company_id and m.subcontractor_id = s.id
  join auth.users u on u.id = m.user_id
  where s.active and private.email_key(s.email) = private.email_key(p_email)
    and private.email_key(p_email) not like '%.invalid'
    and m.active and m.role = 'subcontractor'
    and u.raw_app_meta_data ->> 'crewtavo_sub' = s.company_id::text || ':' || s.id::text
    and not exists (select 1 from public.memberships o where o.user_id = m.user_id and o.company_id <> s.company_id)
$$;
revoke execute on function public.sub_sign_ins_for_email(text) from public, anon, authenticated;
grant execute on function public.sub_sign_ins_for_email(text) to service_role;

notify pgrst, 'reload schema';
