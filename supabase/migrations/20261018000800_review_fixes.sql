-- Fixes from a review of the audit fixes (supabase/tests/review_fixes_test.sql covers each):
--   * people can only be given the areas the person giving them has (owners give anything);
--   * crews don't read the job emails and texts we send (they can carry the contract total);
--   * a price-list service can be deleted when sent invoices or approved quotes use it;
--   * a change order approved again replaces what it added to the job;
--   * document number sequences start past numbers that were picked by hand.

-- ---------------------------------------------------------------------------------------------
-- Giving people access: no more than you have
-- ---------------------------------------------------------------------------------------------

-- The areas the signed-in person has here: their custom role's, or everything their level allows.
create function private.my_permissions(p_company uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when r.id is null then private.level_permissions(m.role) else r.permissions end
    from public.memberships m left join public.company_roles r on r.id = m.role_id
    where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active
  ), '{}')
$$;
revoke execute on function private.my_permissions(uuid) from public;
grant execute on function private.my_permissions(uuid) to authenticated, service_role;

-- An admin whose custom role has only "team" could make another account (their own second one) a
-- plain admin, with every area. A non-owner now gives a role, or access back, only when everything
-- it reaches is within their own areas. (Only owners and admins manage the team, and only owners
-- make owners, so the level stays within theirs.) Deleting a custom role clears it from the people
-- who have it, which gives them every area of their level, so that's checked here too. Creating a
-- business (its first owner) and the server aren't affected.
create function private.membership_grant_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_areas text[];
begin
  if (select auth.uid()) is null or not private.is_member(new.company_id) or private.has_role(new.company_id, '{owner}') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.role is not distinct from old.role and new.role_id is not distinct from old.role_id
     and not (new.active and not old.active) then
    return new;
  end if;
  v_areas := case when new.role_id is null then private.level_permissions(new.role)
                  else (select r.permissions from public.company_roles r where r.id = new.role_id and r.company_id = new.company_id) end;
  if not coalesce(v_areas, '{}') <@ private.my_permissions(new.company_id) then
    raise exception 'That would give someone areas your own role doesn''t have. Ask an owner to do it.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger grant_guard before insert or update on public.memberships
  for each row execute function private.membership_grant_guard();

-- Likewise a non-owner gives a custom role only areas they have, since everyone with it gets them.
-- (Renaming a role, or changing nothing about its areas, is fine. A new business's starter roles
-- are made before it has members.)
create function private.company_role_grant_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and private.is_member(new.company_id) and not private.has_role(new.company_id, '{owner}')
     and (tg_op = 'INSERT' or new.permissions is distinct from old.permissions)
     and not new.permissions <@ private.my_permissions(new.company_id) then
    raise exception 'A role can only get areas your own role has. Ask an owner to add the others.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger grant_guard before insert or update on public.company_roles
  for each row execute function private.company_role_grant_guard();

-- ---------------------------------------------------------------------------------------------
-- Messages: job emails and texts carry the contract total
-- ---------------------------------------------------------------------------------------------

-- As before, plus: what we send about a job (automations can put its total in) is read by the
-- people who see job totals, and Stripe's notes about a payment with no invoice (internal notes it
-- keys by external_id, with the amount) by the office with the invoices area. What clients write
-- in, notes the team adds and messages about visits and requests are visible as before.
drop policy messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (
  private.is_member(company_id) and case
    when direction <> 'in' and (related_type = 'invoice' or (related_type is null and channel = 'note' and external_id is not null)) then
      private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'invoices')
    when direction <> 'in' and related_type in ('quote', 'job') then
      private.has_role(company_id, '{owner,admin,office,estimator}')
    else
      private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
      or (client_id is not null and private.crew_sees_client(client_id))
  end
);

-- ---------------------------------------------------------------------------------------------
-- Deleting a price-list service
-- ---------------------------------------------------------------------------------------------

-- Deleting a service clears it from the lines that used it (the foreign key's own action). That
-- update alone goes through on an approved quote or a sent invoice; every other change is refused
-- as before.
create or replace function private.quote_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.service_id is not null and new.service_id is null
     and to_jsonb(new) - 'service_id' = to_jsonb(old) - 'service_id' then
    return new;
  end if;
  if (select auth.uid()) is not null and exists (
    select 1 from public.quotes q
    where q.id in (case when tg_op <> 'DELETE' then new.quote_id end, case when tg_op <> 'INSERT' then old.quote_id end)
      and q.status in ('approved', 'converted')
  ) then
    raise exception 'This quote was approved, so its line items can''t change. Make a change order or a new quote instead' using errcode = '22023';
  end if;
  return coalesce(new, old);
end $$;

create or replace function private.invoice_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.service_id is not null and new.service_id is null
     and to_jsonb(new) - 'service_id' = to_jsonb(old) - 'service_id' then
    return new;
  end if;
  if exists (
    select 1 from public.invoices i
    where i.id in (case when tg_op <> 'DELETE' then new.invoice_id end, case when tg_op <> 'INSERT' then old.invoice_id end)
      and i.status <> 'draft'
  ) then
    raise exception 'Move the invoice back to draft to change its line items' using errcode = '22023';
  end if;
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Change orders approved again
-- ---------------------------------------------------------------------------------------------

-- A change order that's re-opened, changed and approved again used to leave the job with what it
-- added the first time. What it added (lines and discount) is now replaced with its chosen lines,
-- so the job and its total match what the client approved last.
create or replace function private.apply_change_order(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_sort integer;
begin
  select * into q from public.quotes where id = p_quote for update;
  if not found or q.change_order_for is null or q.status = 'converted' then
    return q.change_order_for;
  end if;
  -- Already on the job (it was re-opened and approved again): take off what it added before.
  delete from public.job_line_items where source_quote_id = q.id;
  select coalesce(max(sort), 0) into v_sort from public.job_line_items where job_id = q.change_order_for;
  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort, source_quote_id)
  select company_id, q.change_order_for, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, v_sort + sort + 1, q.id
  from public.quote_line_items where quote_id = q.id and selected;
  perform private.carry_quote_discount(q.id, q.change_order_for, 'Change order discount');
  update public.job_line_items set source_quote_id = q.id
  where job_id = q.change_order_for and source_quote_id is null and name = 'Change order discount';
  -- The job's total (job_financials) follows its line items.
  update public.jobs set updated_at = now() where id = q.change_order_for;
  update public.quotes set status = 'converted', converted_at = now() where id = q.id;
  return q.change_order_for;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Document numbers past the ones picked by hand
-- ---------------------------------------------------------------------------------------------

-- Before numbers came only from the sequence, a document could be given one ahead of it, and now
-- nothing in the app can move past it: the next document would take a number that's in use. Each
-- company's sequences start after its highest number (never going back).
create function private.catch_up_number_sequences() returns void
language sql security definer set search_path = '' as $$
  insert into public.number_sequences as s (company_id, kind, next_value)
  select company_id, 'requests', max(number) + 1 from public.requests where number is not null group by company_id
  union all
  select company_id, 'quotes', max(number) + 1 from public.quotes where number is not null group by company_id
  union all
  select company_id, 'jobs', max(number) + 1 from public.jobs where number is not null group by company_id
  union all
  select company_id, 'invoices', max(number) + 1 from public.invoices where number is not null group by company_id
  on conflict (company_id, kind) do update set next_value = greatest(s.next_value, excluded.next_value)
$$;
revoke execute on function private.catch_up_number_sequences() from public;

select private.catch_up_number_sequences();
