-- Spare keys: one-time codes the owner saves when they set up Crewtavo (like two-factor backup
-- codes), for getting back in after forgetting their password while the company can't send email
-- yet. The API decides when they may be used (apps/api/src/routes/recovery.ts); this stores them.
--
--   private.spare_keys           one row per code: a keyed hash, never the code itself
--   public.spare_keys_replace()  a new set for an account; the old ones stop working  (service key only)
--   public.spare_key_use()       use one: true the first time, false ever after       (service key only)
--   public.spare_keys_left()     how many are still unused                            (service key only)
--
-- The hash is an HMAC with a secret only the server holds, so a copy of the database alone can't
-- be used to find the codes.

create table private.spare_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key_hash text not null check (length(key_hash) = 64),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  unique (user_id, key_hash)
);
alter table private.spare_keys enable row level security;
revoke all on private.spare_keys from public, anon, authenticated, service_role;

create function public.spare_keys_replace(p_user uuid, p_hashes text[]) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or p_hashes is null or cardinality(p_hashes) not between 1 and 20 then
    raise exception 'A set of spare keys is 1 to 20 codes for one account.' using errcode = '22023';
  end if;
  delete from private.spare_keys where user_id = p_user;
  insert into private.spare_keys (user_id, key_hash) select p_user, h from unnest(p_hashes) as h;
  return cardinality(p_hashes);
end $$;

-- One statement, so two tries with the same code at the same moment can't both succeed: the second
-- waits for the first's row lock, then finds it used.
create function public.spare_key_use(p_user uuid, p_hash text) returns boolean
language sql security definer set search_path = '' as $$
  with used as (
    update private.spare_keys set used_at = now()
    where user_id = p_user and key_hash = p_hash and used_at is null
    returning 1
  )
  select exists (select 1 from used)
$$;

create function public.spare_keys_left(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.spare_keys where user_id = p_user and used_at is null
$$;

revoke execute on function public.spare_keys_replace(uuid, text[]) from public, anon, authenticated;
revoke execute on function public.spare_key_use(uuid, text) from public, anon, authenticated;
revoke execute on function public.spare_keys_left(uuid) from public, anon, authenticated;
grant execute on function public.spare_keys_replace(uuid, text[]) to service_role;
grant execute on function public.spare_key_use(uuid, text) to service_role;
grant execute on function public.spare_keys_left(uuid) to service_role;
