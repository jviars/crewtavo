-- Database tests for finding and merging duplicate clients (20261106000100_client_merge.sql):
-- clients who share an email, a phone or a street and postal code show as pairs, with why; a pair
-- marked "not duplicates" stays hidden; merging moves every kind of record to the kept client,
-- fills in what it lacked, leaves invoice totals and payments as they were, settles what can only
-- be one per client, and deletes the other; another business, the crew and estimators are refused.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema cmt;
grant usage on schema cmt to authenticated, service_role;
create function cmt.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function cmt.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema cmt to authenticated, service_role;

-- Mo owns Maple Merge Lawn; Olive is in the office, Eve estimates and Cal is on the crew. Ed owns
-- another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c3e90000-0000-0000-0000-000000000001', 'mo@maple-merge.test', '{"full_name": "Mo Maple"}'),
  ('c3e90000-0000-0000-0000-000000000002', 'olive@maple-merge.test', '{"full_name": "Olive Office"}'),
  ('c3e90000-0000-0000-0000-000000000003', 'eve@maple-merge.test', '{"full_name": "Eve Estimator"}'),
  ('c3e90000-0000-0000-0000-000000000004', 'cal@maple-merge.test', '{"full_name": "Cal Crew"}'),
  ('c3e90000-0000-0000-0000-000000000009', 'ed@elm-merge.test', '{"full_name": "Ed Elm"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c3e90000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Elm Merge Snow', 'general') as other \gset
select set_config('request.jwt.claims', '{"sub": "c3e90000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Maple Merge Lawn', 'general') as co \gset
commit;
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c3e90000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'c3e90000-0000-0000-0000-000000000003', 'estimator'),
  (:'co', 'c3e90000-0000-0000-0000-000000000004', 'field_crew');

-- Kay is on file twice: Kay Keep (a tax-exempt lead) and Kay K. (active, with all her work). Pat
-- is on file twice by phone; Zed was referred by Kay K.; Nia is someone else Kay K. was marked not
-- the same as. Two clients with a placeholder address, and Elm's own Kay, match nothing here.
begin;
insert into public.clients (company_id, display_name, email, phone, tags, custom_fields, status, notes, tax_exempt)
values (:'co', 'Kay Keep', 'kay@maple-merge.test', '(540) 555-0100', '{VIP}', '{"gate": "blue", "pets": ""}', 'lead', 'Likes mornings', true)
returning id as keep \gset
insert into public.clients (company_id, display_name, email, phone, company_name, tags, custom_fields, status, notes, lead_source, billing_address, marketing_opt_out, sms_opt_out_at)
values (:'co', 'Kay K.', ' KAY@Maple-Merge.test ', '(540) 555-0142', 'Kay Lawns LLC', '{vip,Spring}', '{"gate": "red", "pets": "Rex"}', 'active',
  'Back gate sticks', 'Website form', '{"line1": "5 Bill St", "city": "Roanoke"}', true, now() - interval '1 day')
returning id as dupe \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Pat Pair', '+1 540 555 0177') returning id as pat1 \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Pat Again', '540-555-0177') returning id as pat2 \gset
insert into public.clients (company_id, display_name, referred_by) values (:'co', 'Zed Referred', :'dupe') returning id as zed \gset
insert into public.clients (company_id, display_name) values (:'co', 'Nia Neighbor') returning id as nia \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'No Email One', 'none@maple-merge.invalid'), (:'co', 'No Email Two', 'none@maple-merge.invalid');
insert into public.clients (company_id, display_name, email) values (:'other', 'Kay Elsewhere', 'kay@maple-merge.test') returning id as elsewhere \gset
insert into public.client_duplicate_dismissals (company_id, client_a, client_b) values (:'co', least(:'dupe'::uuid, :'nia'::uuid), greatest(:'dupe'::uuid, :'nia'::uuid));

insert into public.properties (company_id, client_id, line1, postal_code) values (:'co', :'keep', '12 Oak St', '24015');
insert into public.properties (company_id, client_id, line1, postal_code) values (:'co', :'dupe', ' 12 oak st ', '24 015') returning id as home \gset
insert into public.client_contacts (company_id, client_id, name) values (:'co', :'dupe', 'Kay''s son');
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'dupe', :'home', 'Spring cleanup') returning id as req \gset
insert into public.quotes (company_id, client_id, property_id, title, tax_rate) values (:'co', :'dupe', :'home', 'Mulch', 0.05) returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'quote', 'Mulch', 4, 60, true);
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'dupe', :'home', 'Weekly mowing') returning id as job \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'job', :'home', 'Mow', current_date + 2) returning id as visit \gset
insert into public.invoices (company_id, client_id, job_id, tax_rate, status, due_on) values (:'co', :'dupe', :'job', 0.05, 'draft', current_date + 30) returning id as sent_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable) values (:'co', :'sent_inv', 'Mowing', 4, 45, true);
update public.invoices set status = 'sent' where id = :'sent_inv';
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'dupe', :'sent_inv', 100, 'check') returning id as payment \gset
insert into public.invoices (company_id, client_id, tax_rate) values (:'co', :'dupe', 0.05) returning id as draft_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable) values (:'co', :'draft_inv', 'Edging', 1, 80, true);
insert into public.messages (company_id, client_id, channel, direction, body) values (:'co', :'dupe', 'note', 'internal', 'Dog is friendly');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name)
values (:'co', 'client', :'dupe', :'co' || '/client/' || :'dupe' || '/c3e90000-0000-0000-0000-0000000000a1.pdf', 'agreement.pdf');
insert into public.reviews (company_id, location_id, review_id, external_name, reviewer_name, rating, posted_at, google_updated_at, client_id, match)
values (:'co', 'locations/cm1', 'cm-r1', 'accounts/cm1/locations/cm1/reviews/cm-r1', 'Kay K.', 5, now(), now(), :'dupe', 'hand');
insert into public.review_match_choices (company_id, location_id, review_id, client_id) values (:'co', 'locations/cm1', 'cm-r1', :'dupe');
insert into public.review_requests (company_id, client_id) values (:'co', :'dupe');
insert into public.referral_asks (company_id, client_id) values (:'co', :'dupe');
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name) values (:'co', :'zed', :'dupe', 'Kay K.') returning id as ref_in \gset
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name) values (:'co', :'dupe', :'keep', 'Kay Keep') returning id as ref_self \gset
insert into public.campaigns (company_id, name) values (:'co', 'Spring mulch') returning id as campaign \gset
insert into public.campaign_recipients (company_id, campaign_id, client_id, email) values (:'co', :'campaign', :'dupe', 'kay@maple-merge.test') returning id as recipient \gset
insert into public.campaign_bookings (company_id, campaign_id, recipient_id, client_id, kind, record_id, chain_id)
values (:'co', :'campaign', :'recipient', :'dupe', 'request', :'req', gen_random_uuid());
insert into public.automation_rules (company_id, name, trigger, actions)
values (:'co', 'Win them back', 'client.inactive', '[{"type": "add_note", "body": "Called"}]') returning id as rule \gset
insert into public.inactive_client_marks (company_id, rule_id, client_id, last_visit_at) values
  (:'co', :'rule', :'keep', '2026-06-01'), (:'co', :'rule', :'dupe', '2026-06-01'), (:'co', :'rule', :'dupe', '2026-07-01');
insert into public.automation_runs (company_id, rule_id, subject_type, subject_id) values (:'co', :'rule', 'client', :'dupe');
insert into public.client_payment_methods (company_id, client_id, stripe_payment_method_id, stripe_customer_id, livemode, type, brand, last4, exp_month, exp_year, is_default)
values (:'co', :'keep', 'pm_cm_keep', 'cus_cm_keep', false, 'card', 'visa', '4242', 8, 2030, true) returning id as keep_card \gset
insert into public.client_payment_methods (company_id, client_id, stripe_payment_method_id, stripe_customer_id, livemode, type, brand, last4, exp_month, exp_year, is_default)
values (:'co', :'dupe', 'pm_cm_dupe', 'cus_cm_dupe', false, 'card', 'visa', '1881', 9, 2031, true) returning id as dupe_card \gset
insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source, revoked_at, revoked_via)
values (:'co', :'dupe', :'dupe_card', 'An old agreement.', 'cm-1', 'hub', now() - interval '30 days', 'client');
insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source) values
  (:'co', :'keep', :'keep_card', 'We charge the card on file after each visit.', 'cm-1', 'hub'),
  (:'co', :'dupe', :'dupe_card', 'We charge the card on file after each visit.', 'cm-1', 'hub');
insert into public.autopay_charges (company_id, client_id, job_id, bill, invoice_id, payment_method_id, due_at, status)
values (:'co', :'dupe', :'job', 'standard', :'sent_inv', :'dupe_card', now() + interval '3 days', 'needs_approval');
insert into public.visit_change_requests (company_id, visit_id, client_id, kind, reason) values (:'co', :'visit', :'dupe', 'cancel', 'Away that week');
insert into public.sync_links (company_id, provider, entity, local_id, external_id) values
  (:'co', 'quickbooks', 'client', :'keep', 'qb-keep'), (:'co', 'quickbooks', 'client', :'dupe', 'qb-dupe'), (:'co', 'stripe', 'client', :'dupe', 'cus_cm_dupe');
insert into public.notifications (company_id, user_id, kind, title, link)
values (:'co', 'c3e90000-0000-0000-0000-000000000002', 'clients', 'Kay K. booked online', '/clients/' || :'dupe');
commit;

-- What the money was before.
create table cmt.before as
select i.id, i.subtotal, i.discount_amount, i.credit_amount, i.tax_rate, i.tax_amount, i.total, i.amount_paid, i.balance_due
from public.invoices i where i.company_id = :'co' and i.client_id = :'dupe';
select cmt.check((select count(*) = 2 and bool_and(tax_rate = 0.05) and sum(total) > 0 from cmt.before), 'Kay K.''s two invoices are taxed');

-- ===== Who may =================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c3e90000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select cmt.expect_error(format('select * from public.client_duplicates(%L)', :'co'), 'the crew can''t look for duplicates');
select cmt.expect_error(format('select public.merge_clients(%L, %L, %L)', :'co', :'keep', :'dupe'), 'or merge clients');
select set_config('request.jwt.claims', '{"sub": "c3e90000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select cmt.expect_error(format('select * from public.client_duplicates(%L)', :'co'), 'nor can an estimator (no invoices)');
select cmt.expect_error(format('select public.dismiss_client_duplicate(%L, %L, %L)', :'co', :'pat1', :'pat2'), 'or mark a pair not duplicates');
select cmt.expect_error(format('select public.client_merge_preview(%L, %L, %L)', :'co', :'keep', :'dupe'), 'or see what a merge would move');
select set_config('request.jwt.claims', '{"sub": "c3e90000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select cmt.expect_error(format('select * from public.client_duplicates(%L)', :'co'), 'another business''s owner can''t look');
select cmt.expect_error(format('select public.merge_clients(%L, %L, %L)', :'co', :'keep', :'dupe'), 'or merge its clients');
select cmt.expect_error(format('select public.merge_clients(%L, %L, %L)', :'other', :'elsewhere', :'dupe'), 'or pull its client into their own');
commit;
select cmt.check((select count(*) = 2 from public.clients where id in (:'keep', :'dupe')), 'and both Kays are still there');

-- ===== Finding them ============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c3e90000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select cmt.check((select d.reasons @> '[{"kind": "email"}, {"kind": "address"}]' and jsonb_array_length(d.reasons) = 2
  and d.clients @> '[{"display_name": "Kay Keep", "status": "lead"}, {"display_name": "Kay K.", "status": "active"}]'
  from public.client_duplicates(:'co') d where least(d.client_id, d.other_id) = least(:'keep'::uuid, :'dupe'::uuid) and greatest(d.client_id, d.other_id) = greatest(:'keep'::uuid, :'dupe'::uuid)),
  'the Kays are a pair, who they are and why: the same email spelled differently, and the same street and postal code');
select cmt.check((select d.reasons @> '[{"kind": "phone"}]' and jsonb_array_length(d.reasons) = 1
  from public.client_duplicates(:'co') d where :'pat1' in (d.client_id, d.other_id) and :'pat2' in (d.client_id, d.other_id)),
  'the Pats are a pair by phone, written two ways');
select cmt.check(not exists (select 1 from public.client_duplicates(:'co') d join public.clients c on c.id in (d.client_id, d.other_id) where c.email like '%.invalid'),
  'a placeholder address matches nothing');
select cmt.check(not exists (select 1 from public.client_duplicates(:'co') d where :'elsewhere' in (d.client_id, d.other_id)), 'and another business''s Kay isn''t in it');
select cmt.check(not exists (select 1 from public.client_duplicates(:'co') d where :'nia' in (d.client_id, d.other_id)), 'nor anyone with nothing in common');
select public.dismiss_client_duplicate(:'co', :'pat2', :'pat1');
select public.dismiss_client_duplicate(:'co', :'pat1', :'pat2');
select cmt.check(not exists (select 1 from public.client_duplicates(:'co') d where :'pat1' in (d.client_id, d.other_id)), 'marked not duplicates (twice, either way round), the Pats stop showing');
select cmt.expect_error(format('select public.dismiss_client_duplicate(%L, %L, %L)', :'co', :'pat1', :'elsewhere'), 'another business''s client can''t be in a pair');

-- ===== The preview =============================================================================
select public.client_merge_preview(:'co', :'keep', :'dupe') as preview \gset
select cmt.check((:'preview'::jsonb -> 'moves') @> '{"properties": 1, "contacts": 1, "requests": 1, "quotes": 1, "jobs": 1, "invoices": 2, "payments": 1, "messages": 1, "files": 1, "cards": 1, "reviews": 1, "referrals": 2}',
  'the preview counts what moves: ' || (:'preview'::jsonb -> 'moves')::text);
select cmt.check((:'preview'::jsonb -> 'fills') = '["company_name", "billing_address", "lead_source", "notes"]', 'what Kay Keep lacks comes from Kay K.: ' || (:'preview'::jsonb -> 'fills')::text);
select cmt.check((:'preview'::jsonb -> 'fields') = '["pets"]' and (:'preview'::jsonb -> 'tags') = '["Spring"]' and (:'preview'::jsonb ->> 'autopay_off')::boolean,
  'with her empty custom field and a new tag, and her second autopay agreement ends');
select cmt.check((select count(*) = 2 from public.clients where id in (:'keep', :'dupe')), 'a preview changes nothing');
commit;

-- ===== The merge ===============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c3e90000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select cmt.expect_error(format('select public.merge_clients(%L, %L, %L)', :'co', :'keep', :'keep'), 'a client can''t be merged into itself');
select cmt.expect_error(format('select public.merge_clients(%L, %L, %L)', :'co', :'keep', :'elsewhere'), 'or with another business''s');
select public.merge_clients(:'co', :'keep', :'dupe') as merged \gset
commit;
select cmt.check((:'merged'::jsonb ->> 'client_id')::uuid = :'keep', 'the merge says which client was kept');

select cmt.check(not exists (select 1 from public.clients where id = :'dupe'), 'Kay K. is gone');
select cmt.check((select count(*) = 2 from public.properties where client_id = :'keep') and (select client_id = :'keep' from public.properties where id = :'home'), 'her property is Kay Keep''s');
select cmt.check((select client_id = :'keep' from public.requests where id = :'req') and (select client_id = :'keep' from public.quotes where id = :'quote')
  and (select client_id = :'keep' from public.jobs where id = :'job') and (select property_id = :'home' and job_id = :'job' from public.visits where id = :'visit'),
  'her request, quote and job, with the job''s visit');
select cmt.check((select count(*) = 2 from public.invoices where id in (:'sent_inv', :'draft_inv') and client_id = :'keep')
  and (select client_id = :'keep' and amount = 100 and invoice_id = :'sent_inv' from public.payments where id = :'payment'), 'her invoices, and her payment, for the same amount');
select cmt.check(not exists (
  select 1 from cmt.before b join public.invoices i on i.id = b.id
  where (i.subtotal, i.discount_amount, i.credit_amount, i.tax_rate, i.tax_amount, i.total, i.amount_paid, i.balance_due)
    is distinct from (b.subtotal, b.discount_amount, b.credit_amount, b.tax_rate, b.tax_amount, b.total, b.amount_paid, b.balance_due)),
  'every invoice''s totals are as they were, taxed though Kay Keep is tax exempt');
select cmt.check((select tax_rate = 0.05 from public.quotes where id = :'quote'), 'and so is the quote''s tax');
select cmt.check((select count(*) = 1 from public.messages where client_id = :'keep' and body = 'Dog is friendly')
  and (select owner_id = :'keep' from public.attachments where company_id = :'co' and file_name = 'agreement.pdf'), 'her notes and files');
select cmt.check((select client_id = :'keep' from public.reviews where company_id = :'co' and review_id = 'cm-r1')
  and (select client_id = :'keep' from public.review_match_choices where company_id = :'co' and review_id = 'cm-r1')
  and (select count(*) = 1 from public.review_requests where client_id = :'keep') and (select count(*) = 1 from public.referral_asks where client_id = :'keep'),
  'her review, how it was matched, and the review and referral asks she was sent');
select cmt.check((select referred_client_id = :'keep' from public.referrals where id = :'ref_in')
  and (select referrer_client_id = :'keep' and referred_client_id = :'keep' and reward_status = 'none' and no_reward_reason = 'self' from public.referrals where id = :'ref_self')
  and (select referred_by = :'keep' from public.clients where id = :'zed'),
  'who referred her, and whom she referred: her referral of herself earns nothing');
select cmt.check((select client_id = :'keep' from public.campaign_recipients where id = :'recipient')
  and (select count(*) = 1 from public.campaign_bookings where client_id = :'keep'), 'her campaign, and the request it brought in');
select cmt.check((select array_agg(last_visit_at::date order by last_visit_at) = '{2026-06-01,2026-07-01}' from public.inactive_client_marks where client_id = :'keep'),
  'one inactive mark per rule and last visit: hers for the same visit gave way');
select cmt.check((select count(*) = 1 from public.automation_runs where subject_type = 'client' and subject_id = :'keep'), 'her automation run');
select cmt.check((select count(*) = 2 from public.client_payment_methods where client_id = :'keep')
  and (select array_agg(id) = array[:'keep_card']::uuid[] from public.client_payment_methods where client_id = :'keep' and is_default),
  'her card, with Kay Keep''s still the default');
select cmt.check((select count(*) = 3 from public.autopay_authorizations where client_id = :'keep')
  and (select array_agg(payment_method_id) = array[:'keep_card']::uuid[] from public.autopay_authorizations where client_id = :'keep' and revoked_at is null)
  and (select count(*) = 1 from public.autopay_authorizations where client_id = :'keep' and revoked_via = 'replaced' and payment_method_id = :'dupe_card'),
  'her agreements, kept as made: one in force (Kay Keep''s), hers ended as replaced');
select cmt.check((select client_id = :'keep' and status = 'needs_approval' from public.autopay_charges where invoice_id = :'sent_inv'), 'her charge waits as it did');
select cmt.check((select count(*) = 1 from public.visit_change_requests where client_id = :'keep'), 'and her visit change request');
select cmt.check((select array_agg(provider || ':' || external_id order by provider) = '{quickbooks:qb-keep,stripe:cus_cm_dupe}' from public.sync_links where company_id = :'co' and entity = 'client' and local_id = :'keep')
  and not exists (select 1 from public.sync_links where local_id = :'dupe'), 'one link per app: Kay Keep''s QuickBooks customer, and Kay K.''s Stripe customer');
select cmt.check((select link = '/clients/' || :'keep' from public.notifications where company_id = :'co' and title = 'Kay K. booked online'), 'a notification about her opens Kay Keep');
select cmt.check(not exists (select 1 from public.activity where subject_type = 'client' and subject_id = :'dupe')
  and (select count(*) = 2 from public.activity where company_id = :'co' and subject_type = 'client' and subject_id = :'keep' and verb = 'client.created'),
  'her history is Kay Keep''s');
select cmt.check((select actor_id = 'c3e90000-0000-0000-0000-000000000002' and summary = 'Kay K. merged into Kay Keep' and data ->> 'merged_email' = ' KAY@Maple-Merge.test '
  and (data -> 'moved' ->> 'invoices')::int = 2 from public.activity where company_id = :'co' and verb = 'client.merged' and subject_id = :'keep'),
  'and it says Olive merged her in, with her email and what moved');

select cmt.check((select email = 'kay@maple-merge.test' and phone = '(540) 555-0100' and company_name = 'Kay Lawns LLC' and billing_address ->> 'line1' = '5 Bill St'
  and lead_source = 'Website form' and status = 'active' from public.clients where id = :'keep'), 'Kay Keep keeps her email and phone, gets the company, billing address and lead source, and is active');
select cmt.check((select tags = '{VIP,Spring}' and custom_fields = '{"gate": "blue", "pets": "Rex"}' and notes = E'Likes mornings\n\nBack gate sticks' from public.clients where id = :'keep'),
  'their tags together, her own custom values kept and the empty one filled, both notes');
select cmt.check((select marketing_opt_out and sms_opt_out_at is not null and tax_exempt from public.clients where id = :'keep'), 'Kay K. had stopped marketing and texts: so has Kay Keep');
select cmt.check((select count(*) = 2 from public.client_contacts where client_id = :'keep')
  and (select phone = '(540) 555-0142' and not notify_email and not notify_sms from public.client_contacts where client_id = :'keep' and name = 'Kay K.'),
  'her son, and her other phone as a contact who isn''t sent anything');

-- ===== After ===================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c3e90000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select cmt.check(not exists (select 1 from public.client_duplicates(:'co') d where :'pat1' in (d.client_id, d.other_id)), 'the Pats stay dismissed');
select cmt.check(not exists (select 1 from public.client_duplicate_dismissals), 'nobody reads the pairs marked not duplicates but through the functions');
select cmt.expect_error(format('select public.merge_clients(%L, %L, %L)', :'co', :'keep', :'dupe'), 'merging her again finds no one');
commit;
select cmt.check((select count(*) = 1 from public.client_duplicate_dismissals where company_id = :'co' and :'keep' in (client_a, client_b) and :'nia' in (client_a, client_b)),
  'Nia, marked not the same as Kay K., is marked not the same as Kay Keep');
select cmt.expect_error(format('update public.invoices set client_id = %L where id = %L', :'zed', :'sent_inv'), 'outside a merge, an invoice with payments still keeps its client');
select cmt.expect_error(format('update public.autopay_authorizations set client_id = %L where client_id = %L', :'zed', :'keep'), 'and an agreement its client');

\echo 'All client merge tests passed.'
