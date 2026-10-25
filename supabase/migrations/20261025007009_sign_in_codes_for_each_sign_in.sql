-- A phone number or email address that's on more than one business's sub sign-in gets a code for each.
--
-- A tradesman who subs for two businesses usually gives both his own phone and email. Each business
-- now gets a sign-in of its own for him (apps/api/src/services/subAccess.ts makes a sub's sign-in on
-- its stand-in address, never on another business's sub sign-in), since whoever has a code or link
-- gets into the whole account, and neither business may hand out the other's. So one number or
-- address can belong to two sign-ins. Until now that sent no code at all (20261025005001_sign_in_codes.sql,
-- 20261025006001_email_sign_in_codes.sql), so on a new phone he could sign in at neither.
--
-- Now one ask makes a code for each of the sign-ins (each tied to its own account, as before), sent
-- one message per business ("123456 is your sign-in code for Oscar Roofing…"), and the code typed in
-- signs in whichever account it was made for. The codes of one ask share everything else: they run
-- out together (10 minutes, or a newer ask), one right try uses them all, and their tries are counted
-- once (5 a code, 15 a day for the address; 15 a day for each account, by either way, as before).
-- Two of one business's subs sharing a number or address still get none: the server leaves those
-- out, and the office's Sign-in card says so.
--
--   sign_in_codes.ask       which ask a code was made in (the codes for one number or address made at
--                           once); older codes are each their own
--   sign_in_codes_save()    a new ask: one code hash for each account (or one for nobody's), saved together
--   sign_in_codes_check()   one try at the address's newest ask: 'ok' and the account it signs in to,
--                           or as before 'wrong', and for the visitor who asked 'expired', 'dead' or 'locked'
--     (both for the server's key only)
--
-- sign_in_code_save() and sign_in_code_check(), for one account, now go through these.

alter table private.sign_in_codes add column ask uuid;
comment on column private.sign_in_codes.ask is 'The ask this code was made in: the codes for one number or address made at once. Null: its own.';

-- Codes for one address, and for the accounts they go to, take turns: the address first, then each
-- account in order, so no two ever wait on each other in a circle.
create function private.sign_in_code_turns(p_address_hash text, p_users uuid[]) returns void
language plpgsql set search_path = '' as $$
declare u uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('sign_in_code:' || p_address_hash, 0));
  for u in select distinct x from unnest(coalesce(p_users, '{}')) x where x is not null order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('sign_in_code_user:' || u::text, 0));
  end loop;
end $$;
revoke all on function private.sign_in_code_turns(text, uuid[]) from public;

/**
 * A new ask for an address ('text': a number; 'email': an email address): a code for each account it
 * belongs to (p_users[i] gets p_code_hashes[i]), or, for an address with no sign-in, one code for
 * nobody (p_users empty), working for 10 minutes. Any older code for the address runs out, and any
 * for these accounts at their other addresses is stopped (as 20261025006001_email_sign_in_codes.sql).
 */
create function public.sign_in_codes_save(p_channel text, p_address_hash text, p_users uuid[], p_code_hashes text[], p_ip_hash text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_ask uuid := gen_random_uuid(); v_users uuid[] := coalesce(p_users, '{}');
begin
  if p_channel is null or p_channel not in ('text', 'email') or p_address_hash is null or p_code_hashes is null
     or cardinality(p_code_hashes) <> greatest(cardinality(v_users), 1) or array_position(p_code_hashes, null) is not null
     or array_position(v_users, null) is not null or cardinality(v_users) > 10
     or cardinality(v_users) <> (select count(distinct x) from unnest(v_users) x) then
    raise exception 'A code needs the way it goes, the address, and a code for each account (or one for nobody).' using errcode = '22023';
  end if;
  perform private.sign_in_code_turns(p_address_hash, v_users);
  v_now := clock_timestamp();
  update private.sign_in_codes set expires_at = v_now
  where channel = p_channel and address_hash = p_address_hash and used_at is null and expires_at > v_now;
  update private.sign_in_codes set stopped_at = v_now
  where user_id = any (v_users) and not (channel = p_channel and address_hash = p_address_hash)
    and used_at is null and stopped_at is null and expires_at > v_now;
  insert into private.sign_in_codes (channel, ask, user_id, address_hash, code_hash, ip_hash, created_at, expires_at)
  select p_channel, v_ask, k.u, p_address_hash, k.h, p_ip_hash, v_now, v_now + interval '10 minutes'
  from unnest(case when cardinality(v_users) = 0 then array[null::uuid] else v_users end, p_code_hashes) as k(u, h);
end $$;

/**
 * One try at the address's newest ask: the code typed, hashed for each account the address belongs to
 * now (p_users[i] with p_code_hashes[i]; none when it has no sign-in), from the visitor p_ip_hash.
 * 'ok' and the account whose code it is, and the ask is used. Otherwise, as sign_in_code_check did:
 * 'wrong', and the try counts; only the visitor who asked hears 'expired' (10 minutes, or a newer
 * ask), 'dead' (5 wrong tries) or 'locked' (15 wrong tries at the address in a day). A code stopped by
 * a newer one at its account's other address, or for an account with 15 wrong tries in a day by
 * either way, is never right, and otherwise answers as a wrong try.
 */
create function public.sign_in_codes_check(p_channel text, p_address_hash text, p_users uuid[], p_code_hashes text[], p_ip_hash text default null)
returns table (result text, user_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r private.sign_in_codes;
  v_users uuid[] := coalesce(p_users, '{}');
  v_ask uuid;
  v_asker boolean;
  v_tries integer;
  v_used boolean;
  v_user uuid;
begin
  if p_channel is null or p_address_hash is null or cardinality(v_users) <> cardinality(coalesce(p_code_hashes, '{}')) and cardinality(v_users) > 0 then
    return query select 'wrong'::text, null::uuid;
    return;
  end if;
  perform private.sign_in_code_turns(p_address_hash, v_users);
  select * into r from private.sign_in_codes c
  where c.channel = p_channel and c.address_hash = p_address_hash
  order by c.created_at desc, c.id desc
  limit 1;
  if not found then
    return query select 'wrong'::text, null::uuid;
    return;
  end if;
  v_ask := coalesce(r.ask, r.id);
  -- The ask's codes, locked together: they stand or fall as one.
  select coalesce(bool_or(c.used_at is not null), false), max(c.attempts) into v_used, v_tries
  from (select * from private.sign_in_codes c
        where c.channel = p_channel and c.address_hash = p_address_hash and coalesce(c.ask, c.id) = v_ask
        for update) c;
  v_asker := r.ip_hash is not null and r.ip_hash = p_ip_hash;
  if r.expires_at <= clock_timestamp() then
    return query select case when v_asker then 'expired' else 'wrong' end, null::uuid;
    return;
  end if;
  if v_used then
    return query select 'wrong'::text, null::uuid;
    return;
  end if;
  if v_tries >= 5 then
    return query select case when v_asker then 'dead' else 'wrong' end, null::uuid;
    return;
  end if;
  -- Wrong tries in the last day at the address, an ask's counted once (a right one isn't wrong).
  if (select coalesce(sum(t.n), 0) from (
        select max(c.attempts) - bool_or(c.used_at is not null)::integer as n
        from private.sign_in_codes c
        where c.channel = p_channel and c.address_hash = p_address_hash and c.created_at > clock_timestamp() - interval '1 day'
        group by coalesce(c.ask, c.id)) t) >= 15 then
    return query select case when v_asker then 'locked' else 'wrong' end, null::uuid;
    return;
  end if;
  -- The code typed is one of the ask's, for the account it was made for, not stopped, and that
  -- account hasn't had 15 wrong tries today by either way.
  select c.user_id into v_user
  from private.sign_in_codes c
  join unnest(v_users, p_code_hashes) as k(u, h) on k.u = c.user_id and k.h = c.code_hash
  where c.channel = p_channel and c.address_hash = p_address_hash and coalesce(c.ask, c.id) = v_ask and c.stopped_at is null
    and (select coalesce(sum(o.attempts - (o.used_at is not null)::integer), 0) from private.sign_in_codes o
         where o.user_id = c.user_id and o.created_at > clock_timestamp() - interval '1 day') < 15
  order by c.id
  limit 1;
  update private.sign_in_codes c set attempts = c.attempts + 1, used_at = case when v_user is not null then clock_timestamp() end
  where c.channel = p_channel and c.address_hash = p_address_hash and coalesce(c.ask, c.id) = v_ask;
  if v_user is not null then
    return query select 'ok'::text, v_user;
    return;
  end if;
  return query select case when v_asker and v_tries + 1 >= 5 then 'dead' else 'wrong' end, null::uuid;
end $$;

-- For one account (or nobody's), as before: an ask of one.
create or replace function public.sign_in_code_save(p_channel text, p_address_hash text, p_code_hash text, p_user uuid default null, p_ip_hash text default null) returns void
language sql security definer set search_path = '' as $$
  select public.sign_in_codes_save(p_channel, p_address_hash, case when p_user is null then '{}'::uuid[] else array[p_user] end, array[p_code_hash], p_ip_hash)
$$;

create or replace function public.sign_in_code_check(p_channel text, p_address_hash text, p_code_hash text, p_user uuid default null, p_ip_hash text default null) returns text
language sql security definer set search_path = '' as $$
  select c.result from public.sign_in_codes_check(p_channel, p_address_hash, case when p_user is null then '{}'::uuid[] else array[p_user] end, array[p_code_hash], p_ip_hash) c
$$;

revoke execute on function public.sign_in_codes_save(text, text, uuid[], text[], text), public.sign_in_codes_check(text, text, uuid[], text[], text)
  from public, anon, authenticated;
grant execute on function public.sign_in_codes_save(text, text, uuid[], text[], text), public.sign_in_codes_check(text, text, uuid[], text[], text)
  to service_role;

notify pgrst, 'reload schema';
