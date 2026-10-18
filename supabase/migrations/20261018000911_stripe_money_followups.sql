-- After 20261018000910_stripe_money_fixes.sql (supabase/tests/stripe_money_test.sql covers it): a
-- draft that can't be deleted while Stripe still has its invoice open says what to do when that
-- doesn't change.

-- As in 20261018000910_stripe_money_fixes.sql. The Stripe sync voids the Stripe invoice a few
-- minutes after the invoice goes back to draft, but it can't once Stripe stops answering Crewtavo
-- (a key revoked in Stripe, or the server's taken away), and the draft then stayed with no way
-- out. Voiding it still works, and the sync voids the Stripe one too when it can.
create or replace function private.invoice_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_live text;
begin
  if (select auth.uid()) is null then
    return old;
  end if;
  if old.status <> 'draft' or exists (select 1 from public.payments where invoice_id = old.id) then
    raise exception 'Only a draft invoice without payments can be deleted. Void it instead' using errcode = '22023';
  end if;
  select status into v_live from public.stripe_invoices
  where invoice_id = old.id and status in ('creating', 'open', 'processing') and detached_at is null
  limit 1;
  if v_live = 'processing' then
    raise exception 'A bank payment for this invoice is on its way through Stripe, so it can''t be deleted until that''s settled' using errcode = '22023';
  elsif v_live is not null then
    raise exception 'Stripe still has this invoice open. It''s voided there within a few minutes of going back to draft, and then it can be deleted. If it isn''t, void this invoice instead' using errcode = '22023';
  end if;
  return old;
end $$;
