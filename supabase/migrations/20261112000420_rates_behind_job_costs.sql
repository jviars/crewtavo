-- Pay rates and costs stay behind "Job costs and profit". Two places they got past it in the
-- database (a third, GET /api/team handing pay rates to the office without job costs, is fixed
-- in the server in this release):
--
--   * Time entries. The office level (owner, admin, office) could write time_entries.labor_rate
--     with any number, on anyone's time, their own included, with or without job costs: the guard
--     only threw away a rate typed by the crew. Nothing in Crewtavo types a rate on an entry, so
--     now nobody's is taken: time is costed at the person's pay rate when it's approved, read here
--     from their membership, and keeps that rate until it's approved again. Timesheets sends the
--     rate it was shown along with an approval (the previous app version too); that still works,
--     the number is just read here instead of trusted. The server's own writes are as before.
--   * Price-list costs on lines. The quote and job editors no longer ask for an item's cost
--     (services.unit_cost) for someone without job costs, so the line they add arrives without
--     one. It takes the item's cost here instead, so the job's costs are the same whoever adds it.
--
-- The cost columns themselves (services.unit_cost and labor_cost, and unit_cost on quote and job
-- lines) are still readable through the Data API by anyone who can read the row, estimators
-- included. Taking the columns away, as memberships.labor_rate was, would fail every query that
-- names them, and the previous app version names them on the quote, job, roofing and paving
-- pages. That needs two releases: first one where no screen asks for them without job costs, then
-- one that revokes them and serves costs through a function for the people who may see them.
--
-- No existing rows are changed.

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
      if new.approved_at is not null and new.user_id = (select auth.uid()) and private.has_role(new.company_id, '{crew_lead}') then
        raise exception 'The office approves your own time.' using errcode = '22023';
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

-- A price-list item put on a quote or job by someone who isn't shown costs takes the item's cost.
-- Only then: a line from anyone who sees costs, or from the server, keeps what it was given.
create function private.line_cost_from_price_list() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.unit_cost is null and new.service_id is not null and (select auth.uid()) is not null and not private.has_perm(new.company_id, 'job_costs') then
    select s.unit_cost into new.unit_cost from public.services s where s.company_id = new.company_id and s.id = new.service_id;
  end if;
  return new;
end $$;
create trigger price_list_cost before insert on public.quote_line_items for each row execute function private.line_cost_from_price_list();
create trigger price_list_cost before insert on public.job_line_items for each row execute function private.line_cost_from_price_list();

notify pgrst, 'reload schema';
