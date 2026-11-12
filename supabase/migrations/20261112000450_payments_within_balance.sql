-- A payment recorded by hand is no more than the invoice still owes. Only the browser checked that
-- (core paymentProblem), against the balance it had loaded, so two people in the office recording
-- the same check, or one form sent twice, both went in and the invoice went below $0. Now the
-- database checks it too, one payment at a time for an invoice.
--
-- It holds signed-in people only, as the other payment guards do (stripe_payment_guard,
-- autopay_payment_guard): the office, the field app and an AI assistant acting for someone. What
-- Stripe records comes from the server with the service key and mirrors money that has already
-- moved (a payment, a refund, a dispute, an invoice marked paid there), so it's never turned down,
-- whatever the balance. Refunds (negative amounts) and tips (kept beside the amount) aren't counted
-- either: neither can overpay an invoice. A move from Jobber records at most an invoice's total.
--
-- A payment sent twice: the app now makes the payment's id before it sends it, so a second tap, or
-- a retry after the answer was lost, is the same row and the primary key turns it down (the app
-- takes that as "already recorded"). That one is let through to the key here rather than told
-- "nothing is left to pay", which is what its own first copy would otherwise make it look like.
--
-- Payments already recorded aren't changed or checked: an invoice that's already overpaid stays as
-- it is, and its refund can still be recorded. The app before this one sends no id and keeps
-- working: it made the same check in the browser, so it only ever meets this for the second of two
-- payments that crossed.
create function private.payment_balance_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_balance numeric;
  v_more numeric;
begin
  if (select auth.uid()) is null or new.invoice_id is null or new.amount <= 0 then
    return new;
  end if;
  -- A change that doesn't add to what its invoice has been paid.
  if tg_op = 'UPDATE' and new.invoice_id is not distinct from old.invoice_id and new.amount <= old.amount then
    return new;
  end if;
  -- One at a time for an invoice: a payment recorded a moment before this one, and still being
  -- saved, is waited for here and counted in the balance. Stripe's own payments don't wait on this.
  select balance_due into v_balance from public.invoices
   where id = new.invoice_id and company_id = new.company_id
     for no key update;
  if not found then
    return new;
  end if;
  -- Sent twice with the id the form made: the primary key turns it down.
  if tg_op = 'INSERT' and exists (select 1 from public.payments where id = new.id) then
    return new;
  end if;
  v_more := new.amount - case when tg_op = 'UPDATE' and new.invoice_id is not distinct from old.invoice_id then greatest(old.amount, 0) else 0 end;
  if v_balance <= 0 then
    raise exception 'Nothing is left to pay on this invoice. Check its payments: this one may already be recorded' using errcode = '22023';
  elsif v_more > v_balance then
    raise exception 'That''s more than the % still owed on this invoice. Check its payments: one may have just been recorded',
      to_char(v_balance, 'FM999,999,990.00') using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function private.payment_balance_guard() from public;
create trigger balance_guard before insert or update of invoice_id, amount on public.payments
  for each row execute function private.payment_balance_guard();
