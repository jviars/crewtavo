-- Your own pay in a pay period, and your own time, are an owner's, as your pay rate and the pay on
-- a job for you are (20261122000100_prices_and_own_pay_stay_with_their_roles.sql and
-- 20261123100300_admin_access_back_and_own_pay.sql).
--
-- 1. A pay period's lines (pay_period_lines): what each person was paid for the period, and that
--    they were. Anyone who handles pay could write their own, and mark it paid. Now only an owner
--    writes, changes or removes their own line; the rest of the team's are written as before
--    (apps/api/src/services/pay.ts leaves the person's own out when they mark a period paid).
-- 2. Approving time decides the hours someone is paid for. A crew lead already couldn't approve their
--    own; now nobody but an owner does. Taking an approval back is left as it was.
--
-- supabase/tests/own_pay_in_pay_periods_test.sql covers both.

-- ---------------------------------------------------------------------------------------------
-- A pay period's lines
-- ---------------------------------------------------------------------------------------------

-- As 20261123100300_admin_access_back_and_own_pay.sql, and a line moved off someone counts as
-- theirs too, so a change can't carry it from their own to someone else's or back.
create or replace function private.own_pay_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_company uuid := (v_row ->> 'company_id')::uuid;
  v_users uuid[];
begin
  if current_user <> 'authenticated' then return coalesce(new, old); end if;
  if tg_table_name = 'job_pay_lines' then
    v_users := array[private.job_pay_user((to_jsonb(new) ->> 'job_pay_id')::uuid), private.job_pay_user((to_jsonb(old) ->> 'job_pay_id')::uuid)];
  else
    v_users := array[(to_jsonb(new) ->> 'user_id')::uuid, (to_jsonb(old) ->> 'user_id')::uuid];
  end if;
  if (select auth.uid()) = any (v_users) and not private.has_role(v_company, '{owner}') then
    raise exception 'Ask an owner to set your own pay' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create trigger own_pay_guard before insert or update or delete on public.pay_period_lines
  for each row execute function private.own_pay_guard();

-- ---------------------------------------------------------------------------------------------
-- Your own time
-- ---------------------------------------------------------------------------------------------

-- As 20261112000420_rates_behind_job_costs.sql, with your own time approved only by an owner.
create or replace function private.time_approval_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_changes_approval boolean := case when tg_op = 'INSERT' then new.approved_at is not null
                                     else new.approved_at is distinct from old.approved_at end;
  v_approves boolean := new.approved_at is not null and (tg_op = 'INSERT' or old.approved_at is null);
begin
  if (select auth.uid()) is not null then
    if v_changes_approval then
      if not private.has_perm(new.company_id, 'timesheets') then
        raise exception 'Your role can''t approve time' using errcode = '42501';
      end if;
      if new.approved_at is not null and new.user_id = (select auth.uid()) and not private.has_role(new.company_id, '{owner}') then
        raise exception '%', case when private.has_role(new.company_id, '{crew_lead}') then 'The office approves your own time.' else 'An owner approves your own time.' end
          using errcode = '22023';
      end if;
    end if;
    -- A rate somebody sends is never the rate: it's the person's own, as of the approval.
    new.labor_rate := case when tg_op = 'UPDATE' then old.labor_rate end;
    if v_approves then
      new.labor_rate := (select m.labor_rate from public.memberships m where m.company_id = new.company_id and m.user_id = new.user_id);
    end if;
  elsif v_approves and new.labor_rate is null then
    select m.labor_rate into new.labor_rate from public.memberships m where m.company_id = new.company_id and m.user_id = new.user_id;
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
