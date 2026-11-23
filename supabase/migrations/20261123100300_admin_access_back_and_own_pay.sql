-- Two changes to the team that went around the rules for them.
--
-- 1. Admin access given back. Giving someone admin-level access asks for the giver's password
--    (20261101000200_admin_grants.sql), but turning a removed admin's access back on didn't: the
--    guard looked only at new memberships and changed roles. Restoring a membership that is (or
--    whose custom role has since become) admin-level is now giving admin access, through the same
--    open minute the server gives once the password checks out (POST /api/team/:id/restore).
--
-- 2. Your own pay. Only an owner sets their own pay rate, piece rates or job pay
--    (20261122000100_prices_and_own_pay_stay_with_their_roles.sql: membership_self_guard,
--    pay_rate_defaults and handles_pay, which the job pay functions ask). The browser could still
--    write a job's pay and its lines straight to the tables for oneself, and delete one's own piece
--    rate. Those writes are held to the same rule here, the way that migration holds price changes
--    to Quotes and sales (prices_need_sales): only a person's own writes are checked, so the
--    database's own functions that keep pay up to date as visits are finished go through.
--
-- supabase/tests/admin_access_back_and_own_pay_test.sql covers both.

-- ---------------------------------------------------------------------------------------------
-- Admin access given back
-- ---------------------------------------------------------------------------------------------

-- As 20261101000200_admin_grants.sql, with access turned back on counted as giving it.
create or replace function private.membership_admin_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_role public.member_role;
  v_perms text[];
begin
  if current_user <> 'authenticated' then return new; end if;
  -- A custom role sets the level (role_level did, before this); its areas are its own.
  select r.base_role, r.permissions into v_role, v_perms
  from public.company_roles r where new.role_id is not null and r.id = new.role_id and r.company_id = new.company_id;
  v_role := coalesce(v_role, new.role);
  if private.admin_level(v_role, v_perms)
     and (tg_op = 'INSERT' or new.user_id <> old.user_id or new.company_id <> old.company_id
          or v_role <> old.role or new.role_id is distinct from old.role_id
          or (new.active and not old.active))
     and not private.admin_grant_open(new.company_id, new.user_id) then
    raise exception 'Give admin access from Settings → People' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Your own pay
-- ---------------------------------------------------------------------------------------------

-- Whose pay a pay on a job is (a team member's user_id; null for a sub's).
create function private.job_pay_user(p_pay uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select p.user_id from public.job_pay p where p.id = p_pay
$$;
revoke all on function private.job_pay_user(uuid) from public;
grant execute on function private.job_pay_user(uuid) to authenticated, service_role;

-- Pay on a job and its lines written from the browser for the person writing them, and their own
-- piece rates deleted: only an owner's, with the words pay_rate_defaults uses for a rate's insert
-- and update. Not security definer: it asks who's writing, so the database's own functions (which
-- keep pay up to date as visits are finished, whoever finished them) go through.
create function private.own_pay_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_company uuid := (v_row ->> 'company_id')::uuid;
  v_user uuid;
begin
  if current_user <> 'authenticated' then return coalesce(new, old); end if;
  v_user := case when tg_table_name = 'job_pay_lines' then private.job_pay_user((v_row ->> 'job_pay_id')::uuid)
                 else (v_row ->> 'user_id')::uuid end;
  if v_user = (select auth.uid()) and not private.has_role(v_company, '{owner}') then
    raise exception 'Ask an owner to set your own pay' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function private.own_pay_guard() from public;
-- A rate's insert and update are pay_rate_defaults' to hold (20261122000100_prices_and_own_pay_stay_with_their_roles.sql); its delete is this one's.
create trigger own_pay_guard before delete on public.pay_rates
  for each row execute function private.own_pay_guard();
create trigger own_pay_guard before insert or update or delete on public.job_pay
  for each row execute function private.own_pay_guard();
create trigger own_pay_guard before insert or update or delete on public.job_pay_lines
  for each row execute function private.own_pay_guard();

notify pgrst, 'reload schema';
