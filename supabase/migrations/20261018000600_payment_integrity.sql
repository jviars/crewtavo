-- Payments that add up, and edit rights that stay where they were given
-- (supabase/tests/payment_integrity_test.sql covers each):
--   * a payment can't be moved onto a void invoice, any more than added to one;
--   * a payment on an invoice is from that invoice's client, and the invoice keeps its client
--     once it has payments;
--   * a tip goes the same way as its payment: added with a payment, given back with a refund;
--   * the person who logged material can't move its time later to keep editing it past the day;
--   * only the office moves a time entry to someone else or to another company.

-- ---------------------------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------------------------

-- No payments on a void invoice (payments_not_void covers adding one): one can't be moved onto a
-- void invoice, and one already there stays as it is.
create policy payments_not_void_update on public.payments as restrictive for update to authenticated
  using (invoice_id is null or not exists (select 1 from public.invoices i where i.id = invoice_id and i.status = 'void'))
  with check (invoice_id is null or not exists (select 1 from public.invoices i where i.id = invoice_id and i.status = 'void'));

-- A payment on an invoice is from that invoice's client (the app and Stripe copy it from the
-- invoice), so it shows on the right client and in their Hub. One on record that doesn't match
-- (its invoice was moved to another client after it was paid) goes with its invoice, so Stripe
-- refunds, which copy the payment's client, still go through.
update public.payments p set client_id = i.client_id
from public.invoices i
where i.id = p.invoice_id and p.client_id <> i.client_id;

create function private.payment_client_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.invoice_id is not null and new.client_id is distinct from (
    select i.client_id from public.invoices i where i.id = new.invoice_id and i.company_id = new.company_id
  ) then
    raise exception 'A payment on an invoice has to be from that invoice''s client' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger client_guard before insert or update of client_id, invoice_id on public.payments
  for each row execute function private.payment_client_guard();

-- And an invoice with payments keeps its client, so its payments still match it.
create function private.invoice_client_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.client_id is distinct from old.client_id and exists (select 1 from public.payments where invoice_id = new.id) then
    raise exception 'This invoice has payments, so its client can''t change' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger client_guard before update of client_id on public.invoices
  for each row execute function private.invoice_client_guard();

-- A tip goes the same way as its payment: a payment adds one, a refund gives one back (Stripe
-- refunds record the tip they returned as a negative tip). The app never recorded a tip the other
-- way round, so one that came in through the API has its sign backwards: turn it around first.
update public.payments set tip_amount = -tip_amount where tip_amount <> 0 and sign(tip_amount) <> sign(amount);
alter table public.payments add constraint payments_tip_amount_check check (tip_amount = 0 or sign(tip_amount) = sign(amount));

-- ---------------------------------------------------------------------------------------------
-- Materials: the day to fix your own entry counts from when it was logged
-- ---------------------------------------------------------------------------------------------

-- job_materials_update lets the person who logged an entry fix it for a day after logged_at, so
-- moving logged_at later (or logging an entry ahead of time) kept it open for good. Only the people
-- who can fix any entry (the office and crew leads) change when one was logged.
create function private.job_material_time_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and not private.has_role(new.company_id, '{owner,admin,office,crew_lead}') then
    if tg_op = 'INSERT' and new.logged_at > now() then
      raise exception 'That time is in the future' using errcode = '22023';
    end if;
    if tg_op = 'UPDATE' and new.logged_at is distinct from old.logged_at then
      raise exception 'The office or a crew lead changes when material was logged' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger time_guard before insert or update of logged_at on public.job_materials
  for each row execute function private.job_material_time_guard();

-- ---------------------------------------------------------------------------------------------
-- Time: an entry stays with its person and company
-- ---------------------------------------------------------------------------------------------

-- time_entries_update lets people fix their own unapproved time and crew leads their crew's, and
-- that let them hand an entry to anyone (or to another company they're in). Only the office moves
-- time to someone else.
create function private.time_entry_owner_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and (new.user_id is distinct from old.user_id or new.company_id is distinct from old.company_id)
     and not private.has_role(old.company_id, '{owner,admin,office}') then
    raise exception 'Only the office can move time to someone else' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger owner_guard before update of user_id, company_id on public.time_entries
  for each row execute function private.time_entry_owner_guard();

-- ---------------------------------------------------------------------------------------------
-- Formulas: only what a measurement supplies
-- ---------------------------------------------------------------------------------------------

-- The General preset gave its Labor service the formula `hours`, which no measurement supplies, so
-- every quote line added from it said 'Unknown value "hours"'. Services that still have it go
-- without a formula. (Quote lines already made from it are left alone: touching them reworks their
-- quote's totals.)
update public.services set formula = null where formula = 'hours';

notify pgrst, 'reload schema';
