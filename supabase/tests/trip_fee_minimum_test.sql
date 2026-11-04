-- Database tests for trip fees and the minimum charge (20261104000100_trip_fee_minimum.sql): an
-- "Add to every job" item goes on a new job and a quote's first lines once (not on a copy that has
-- it, a job from a quote or a change order, nor back after it's taken off), and an invoice under the
-- minimum gets a Minimum charge line kept right while it's a draft, on every way an invoice is made;
-- another business sees and changes none of it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tfm;
grant usage on schema tfm to authenticated, service_role;
create function tfm.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tfm.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tfm to authenticated, service_role;

-- Tia owns Tern Plumbing; Ned owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c4110000-0000-0000-0000-000000000001', 'tia@tern.test', '{"full_name": "Tia Tern"}'),
  ('c4110000-0000-0000-0000-000000000009', 'ned@nook.test', '{"full_name": "Ned Nook"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Nook Repair', 'general') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Olga Other') returning id as olga \gset
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Tern Plumbing', 'general') as co \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost, taxable, add_to_every_job)
values (:'co', 'Truck fee', 'visit', 45, 10, false, true) returning id as trip \gset
insert into public.clients (company_id, display_name) values (:'co', 'Paul Pipe') returning id as paul \gset
commit;

-- ===== Add to every job ========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.jobs (company_id, client_id, title) values (:'co', :'paul', 'Leaky faucet') returning id as job \gset
-- Another job made with the truck fee on it already.
insert into public.jobs (company_id, client_id, title) values (:'co', :'paul', 'Water heater') returning id as job2 \gset
insert into public.job_line_items (company_id, job_id, service_id, name, quantity, unit, unit_price) values (:'co', :'job2', :'trip', 'Truck fee', 1, 'visit', 40);
insert into public.quotes (company_id, client_id, title) values (:'co', :'paul', 'Repipe') returning id as quote \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tfm.check((select count(*) = 1 and min(name) = 'Truck fee' and min(unit_price) = 45 and not bool_or(taxable) from public.job_line_items where job_id = :'job' and service_id = :'trip'),
  'a new job gets the truck fee, at its price list price');
select tfm.check((select count(*) = 1 and min(unit_price) = 40 from public.job_line_items where job_id = :'job2' and service_id = :'trip'), 'a job made with it already keeps its own, once');
select tfm.check((select count(*) = 0 from public.quote_line_items where quote_id = :'quote'), 'a new quote with no lines yet has nothing on it');
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'quote', 'PEX run', 40, 'ft', 6);
commit;
select tfm.check((select count(*) = 1 from public.quote_line_items where quote_id = :'quote' and service_id = :'trip'), 'its first lines bring the truck fee');
select tfm.check((select sort from public.quote_line_items where quote_id = :'quote' and service_id = :'trip') > (select sort from public.quote_line_items where quote_id = :'quote' and name = 'PEX run'), 'after them');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- A copy has it already; the original keeps its one.
select public.duplicate_quote(:'quote') as copy \gset
commit;
select tfm.check((select count(*) = 1 from public.quote_line_items where quote_id = :'copy' and service_id = :'trip'), 'a copy of the quote has the truck fee once');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- The office takes it off the quote: more lines don't bring it back.
delete from public.quote_line_items where quote_id = :'quote' and service_id = :'trip';
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'quote', 'Shutoff valve', 2, 'ea', 30);
commit;
select tfm.check((select count(*) = 0 from public.quote_line_items where quote_id = :'quote' and service_id = :'trip'), 'taken off, it stays off');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.convert_quote_to_job(:'copy') as from_quote \gset
insert into public.quotes (company_id, client_id, title, change_order_for) values (:'co', :'paul', 'Change order: one more valve', :'job') returning id as change \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'change', 'Valve', 1, 'ea', 30);
commit;
select tfm.check((select count(*) = 1 from public.job_line_items where job_id = :'from_quote' and service_id = :'trip'), 'a job from a quote has the quote''s truck fee, not a second one');
select tfm.check((select count(*) = 0 from public.quote_line_items where quote_id = :'change' and service_id = :'trip'), 'a change order doesn''t get it');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select tfm.check((select count(*) = 0 from public.services where id = :'trip'), 'another business can''t see the item');
update public.services set add_to_every_job = false where id = :'trip';
insert into public.jobs (company_id, client_id, title) values (:'other', :'olga', 'Door hinge') returning id as other_job \gset
commit;
select tfm.check((select add_to_every_job from public.services where id = :'trip'), 'or change it');
select tfm.check((select count(*) = 0 from public.job_line_items where job_id = :'other_job'), 'and its own jobs don''t get Tern''s truck fee');

-- ===== The minimum charge ======================================================================
update public.companies set settings = settings || '{"minimum_charge": 150}' where id = :'co';

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable) values (:'co', :'job', 'Cartridge', 1, 'ea', 55, true);
select public.create_invoice_for_job(:'job') as inv \gset
select tfm.check((select minimum_charge = 150 and subtotal = 150 from public.invoices where id = :'inv'), 'an invoice from a $100 job is topped up to the $150 minimum');
select tfm.check((select count(*) = 1 and min(unit_price) = 50 and bool_and(taxable) and min(name) = 'Minimum charge' from public.invoice_line_items where invoice_id = :'inv' and kind = 'minimum'),
  'by a taxed $50 Minimum charge line');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'inv', 'Extra part', 1, 'ea', 30);
select tfm.check((select unit_price = 20 from public.invoice_line_items where invoice_id = :'inv' and kind = 'minimum') and (select subtotal = 150 from public.invoices where id = :'inv'),
  'a line added to the draft shrinks the top-up');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'inv', 'Discount', 1, 'ea', -25);
select tfm.check((select unit_price = 20 from public.invoice_line_items where invoice_id = :'inv' and kind = 'minimum'), 'a discount doesn''t count against the minimum');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'inv', 'Second faucet', 1, 'ea', 90);
select tfm.check((select count(*) = 0 from public.invoice_line_items where invoice_id = :'inv' and kind = 'minimum'), 'past the minimum, the line goes');
delete from public.invoice_line_items where invoice_id = :'inv' and name = 'Second faucet';
select tfm.check((select unit_price = 20 from public.invoice_line_items where invoice_id = :'inv' and kind = 'minimum'), 'and comes back when it''s short again');
-- The office takes the line off: that invoice isn't topped up again.
delete from public.invoice_line_items where invoice_id = :'inv' and kind = 'minimum';
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'inv', 'Tape', 1, 'ea', 2);
select tfm.check((select minimum_charge is null from public.invoices where id = :'inv')
  and (select count(*) = 0 from public.invoice_line_items where invoice_id = :'inv' and kind = 'minimum'), 'taken off by hand, it stays off');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- A deposit isn't topped up, and the final invoice's credit for it doesn't make it short.
insert into public.jobs (company_id, client_id, title) values (:'co', :'paul', 'Sewer line') returning id as big \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'big', 'Trench and replace', 1, 'ea', 955);
set constraints all immediate;
select public.create_invoice_for_job(:'big', 'deposit', 900) as deposit \gset
select tfm.check((select minimum_charge is null and subtotal = 900 from public.invoices where id = :'deposit'), 'a deposit has no minimum');
select public.create_invoice_for_job(:'big') as final \gset
select tfm.check((select subtotal = 100 from public.invoices where id = :'final')
  and not exists (select 1 from public.invoice_line_items where invoice_id = :'final' and kind = 'minimum'), 'the final invoice, $100 after the deposit, isn''t topped up: the work was $1,000');
-- New invoice, not from a job: lines over the minimum, then under it.
insert into public.invoices (company_id, client_id, subject) values (:'co', :'paul', 'Parts sale') returning id as blank \gset
select tfm.check((select minimum_charge = 150 from public.invoices where id = :'blank')
  and not exists (select 1 from public.invoice_line_items where invoice_id = :'blank'), 'a new invoice with no lines has nothing to top up');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'blank', 'Hose bib', 2, 'ea', 20);
select tfm.check((select subtotal = 150 from public.invoices where id = :'blank'), 'its first line under the minimum is topped up');
commit;

-- Autopay makes invoices as the server (autopay_bill runs as its owner, no one signed in): topped
-- up the same way. Something brought in from Stripe isn't.
begin;
select set_config('request.jwt.claims', '', true);
insert into public.jobs (company_id, client_id, title) values (:'co', :'paul', 'Drain clean') returning id as auto_job \gset
set constraints all immediate;
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'auto_job', 'Snake drain', 1, 'ea', 60);
select public.create_invoice_for_job(:'auto_job') as auto_inv \gset
select tfm.check((select subtotal = 150 from public.invoices where id = :'auto_inv'), 'an invoice made by the server for a job is topped up (autopay)');
insert into public.invoices (company_id, client_id, subject) values (:'co', :'paul', 'From Stripe') returning id as stripe_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable) values (:'co', :'stripe_inv', 'Item', 1, 'ea', 10, false);
select tfm.check((select minimum_charge is null and subtotal = 10 from public.invoices where id = :'stripe_inv'), 'one brought in by the server without a job isn''t (Stripe''s own)');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4110000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
-- The minimum is Tern's alone.
insert into public.invoices (company_id, client_id) values (:'other', :'olga') returning id as theirs \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'other', :'theirs', 'Hinge', 1, 'ea', 10);
select tfm.check((select minimum_charge is null and subtotal = 10 from public.invoices where id = :'theirs'), 'off by default: another business''s invoice isn''t topped up');
select tfm.check((select count(*) = 0 from public.invoice_line_items where invoice_id = :'inv'), 'another business can''t see the Minimum charge line');
update public.invoices set minimum_charge = 1 where id = :'blank';
commit;
select tfm.check((select minimum_charge = 150 from public.invoices where id = :'blank'), 'or change an invoice''s minimum');

\echo 'All trip fee and minimum charge tests passed.'
