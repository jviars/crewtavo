-- Switching the Stripe key. Each Stripe invoice now says which Stripe account it's in, so when a
-- company switches to a key for another account (or from a test key to a live one), or
-- disconnects, the old account's invoices stop being used: the new key can't void them, and
-- Crewtavo no longer hears when they're paid (apps/api/src/integrations/stripe.ts, leaveAccount).

alter table public.stripe_invoices
  -- acct_...: the account it's in. Null when Crewtavo couldn't tell: made before this, or with a key
  -- that can't read its account (the API then checks with Stripe before handing out its page).
  add column stripe_account text,
  -- When Crewtavo stopped following it, because the key in use can't reach it. Its status is the
  -- last one Crewtavo saw, and it no longer counts as live.
  add column detached_at timestamptz;

-- At most one live Stripe invoice per invoice, among the ones Crewtavo still follows: the old
-- account's open one doesn't stop the new key from making its own.
drop index public.stripe_invoices_live_idx;
create unique index stripe_invoices_live_idx on public.stripe_invoices (invoice_id)
  where status in ('creating', 'open', 'processing') and detached_at is null;

notify pgrst, 'reload schema';
