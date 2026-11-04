-- Work added on site: the crew on a visit adds a line to its job from the price list (extra work,
-- or a part), picking an item and a quantity. The office's price applies, and the crew never sees
-- it: they can't read job lines (20261017001200_crew_job_privacy.sql), so add_field_line() writes
-- the line for them and answers with its id alone. The line says who added it and when, so the
-- office can review it on the job page.
--
-- Not on a repeating job: its lines bill again on every visit (or every month), and extra work
-- done once would too. Not on a closed job, whose lines are no longer billed. Never a sub's: the
-- job's prices are the client's, not theirs.
--
-- Invoicing and recording cash or check on site need nothing new: they go through
-- create_invoice_for_job() and the payments table as the office's do, and the rules there (the
-- invoices area, owners, admins and office only) already turn crews away.

alter table public.job_line_items
  add column added_in_field_by uuid references auth.users (id) on delete set null,
  add column added_in_field_at timestamptz;
comment on column public.job_line_items.added_in_field_at is 'When the crew added this line on site (add_field_line), for the office to review. Null for the office''s own lines.';

/**
 * Adds `p_quantity` of a price list item to the visit's job, at the item's price. For the team on
 * the visit (or crew leads and up). `p_id` is made on the phone, so a line sent again after no
 * signal is added once.
 */
create function public.add_field_line(p_visit uuid, p_service uuid, p_quantity numeric, p_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v public.visits;
  j public.jobs;
  s public.services;
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  select * into v from public.visits where id = p_visit;
  if not found or not private.is_member(v.company_id)
     or not (private.has_role(v.company_id, '{owner,admin,office,estimator,crew_lead}') or private.works_visit(v.id)) then
    raise exception 'That visit wasn''t found.' using errcode = 'P0002';
  end if;
  select * into j from public.jobs where id = v.job_id;
  if not found then
    raise exception 'This visit isn''t for a job.' using errcode = '22023';
  end if;
  if j.kind = 'recurring' then
    raise exception 'This job repeats, so a line would bill on every visit. Tell the office about the extra work in the notes.' using errcode = '22023';
  end if;
  if j.status not in ('active', 'requires_invoicing') or v.status = 'cancelled' then
    raise exception 'This job is closed. Tell the office about the extra work in the notes.' using errcode = '22023';
  end if;
  select * into s from public.services where id = p_service and company_id = j.company_id and active;
  if not found then
    raise exception 'That item isn''t on the price list anymore.' using errcode = 'P0002';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 100000 then
    raise exception 'Enter how many.' using errcode = '22023';
  end if;

  insert into public.job_line_items (id, company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort, added_in_field_by, added_in_field_at)
  values (v_id, j.company_id, j.id, s.id, s.name, s.description, round(p_quantity, 3), s.unit, s.unit_price, s.unit_cost, s.taxable,
          (select coalesce(max(sort), -1) + 1 from public.job_line_items where job_id = j.id and discount_key is null),
          (select auth.uid()), now())
  on conflict (id) do nothing;
  return v_id;
end $$;
revoke execute on function public.add_field_line(uuid, uuid, numeric, uuid) from public, anon;
grant execute on function public.add_field_line(uuid, uuid, numeric, uuid) to authenticated;

notify pgrst, 'reload schema';
