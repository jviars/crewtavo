-- Cleaning, pool service and pest control sell plans billed by the visit, like lawn care, so their
-- autopay starter terms say "after each cleaning" and the like instead of the general words. Core
-- starterAutopayTerms has the same words (packages/core/test/autopay.test.ts holds them to these).
-- Their new recurring jobs start on autopay by default too: that default is the one Settings →
-- Payments starts from (core autopaySettings jobs_default), saved by autopay_set_settings, so
-- private.autopay_job_default, which reads the saved setting, stays as it is.

-- As in 20261101000300_manual_charges.sql, plus the three plan trades.
create or replace function private.autopay_starter_terms(p_trade text) returns text
language sql immutable security definer set search_path = '' as $$
  select case
    when p_trade = 'lawn_exterior' then
      'We charge the card on file after each visit is done, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade = 'cleaning' then
      'We charge the card on file after each cleaning, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade = 'pool_service' then
      'We charge the card on file after each pool service visit, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade = 'pest_control' then
      'We charge the card on file after each treatment, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade in ('paving', 'roofing_exteriors') then
      'We charge the card on file when the work on your job is done, and for other invoices we send you. Charges over the amount we agreed wait until we''ve talked with you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    else
      'We charge the card on file when each visit or job is done, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
  end
$$;
