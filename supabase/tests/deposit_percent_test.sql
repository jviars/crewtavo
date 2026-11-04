-- Database tests for deposits as a percent (20261104000500_deposit_percent): a percent sets the
-- deposit amount from the total and follows it as lines and the client's choices change, an amount
-- stays as typed, and copies and templates keep the percent. As the client approves in the Client
-- Hub, the server makes the deposit's invoice once (sent, due on the payment terms, untaxed), it joins the job made
-- from the quote, and the job's last invoice takes it off. Only the server makes that invoice.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tdp;
grant usage on schema tdp to anon, authenticated, service_role;
create function tdp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tdp.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tdp to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d5500000-0000-0000-0000-000000000001', 'pia@pine-decks.test', '{"full_name": "Pia Pine"}'),
  ('d5500000-0000-0000-0000-000000000002', 'cy@pine-decks.test', '{"full_name": "Cy Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d5500000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Pine Decks', 'general', 'America/Denver') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'd5500000-0000-0000-0000-000000000002', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Rae Pinecrest') returning id as rae \gset

-- A deck at 25% down: $1,000 and a $333.33 add-on she hasn't picked, taxed at 10%.
insert into public.quotes (company_id, client_id, title, tax_rate, deposit_percent) values (:'co', :'rae', 'Back deck', 0.10, 25) returning id as deck \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'deck', 'Deck', 1000);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, optional, selected) values (:'co', :'deck', 'Lighting', 333.33, true, false) returning id as lighting \gset

-- ===== The percent follows the total ============================================================
select tdp.check((select total = 1100 and deposit_amount = 275 from public.quotes where id = :'deck'), 'a percent sets the deposit from the total, tax and all');
update public.quote_line_items set unit_price = 1200 where quote_id = :'deck' and name = 'Deck';
select tdp.check((select total = 1320 and deposit_amount = 330 from public.quotes where id = :'deck'), 'and follows it as a line changes');
update public.quotes set deposit_percent = 33.33 where id = :'deck';
select tdp.check((select deposit_amount = 439.96 from public.quotes where id = :'deck'), 'to the cent (33.33% of $1,320.00)');
update public.quotes set deposit_amount = 1 where id = :'deck';
select tdp.check((select deposit_amount = 439.96 from public.quotes where id = :'deck'), 'an amount written over a percent is worked out again');
update public.quotes set deposit_percent = null, deposit_amount = 200 where id = :'deck';
update public.quote_line_items set unit_price = 1000 where quote_id = :'deck' and name = 'Deck';
select tdp.check((select deposit_percent is null and deposit_amount = 200 from public.quotes where id = :'deck'), 'an amount stays as typed when the total changes');
update public.quotes set deposit_percent = 25 where id = :'deck';
select tdp.expect_error(format('update public.quotes set deposit_percent = 101 where id = %L', :'deck'), 'a percent is at most 100');
select tdp.expect_error(format('update public.quotes set deposit_percent = -1 where id = %L', :'deck'), 'and never below 0');

select public.duplicate_quote(:'deck') as copy \gset
select public.duplicate_quote(:'deck', 'Deck at 25% down') as tmpl \gset
select tdp.check((select deposit_percent = 25 and deposit_amount = 275 from public.quotes where id = :'copy')
  and (select deposit_percent = 25 and deposit_amount = 275 from public.quotes where id = :'tmpl'), 'a copy and a template keep the percent');
update public.quotes set status = 'sent', sent_at = now() where id = :'deck';
commit;

-- ===== Paid as the client approves ==============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d5500000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tdp.expect_error(format('select public.hub_deposit_invoice(%L, %L)', :'co', :'deck'), 'the office can''t make the Client Hub''s deposit invoice');
select set_config('request.jwt.claims', '{"sub": "d5500000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tdp.check(not exists (select 1 from public.quotes where id = :'deck'), 'the crew don''t see the quote or its deposit');
select tdp.expect_error(format('select public.hub_deposit_invoice(%L, %L)', :'co', :'deck'), 'or make its invoice');
rollback;
set role anon;
select tdp.expect_error(format('select public.hub_deposit_invoice(%L, %L)', :'co', :'deck'), 'nor can anyone signed out');
reset role;

set role service_role;
select tdp.check(public.hub_deposit_invoice(:'co', :'deck') is null, 'a quote not approved yet owes no deposit');
-- She picks the lighting as she approves: the deposit is 25% of what she chose.
select tdp.check(public.approve_hub_quote(:'co', :'deck', array[:'lighting']::uuid[], '{"name": "Rae Pinecrest"}'), 'she approves the quote');
select public.hub_deposit_invoice(:'co', :'deck') as deposit \gset
select tdp.check(public.hub_deposit_invoice(gen_random_uuid(), :'deck') is null, 'another company''s link makes nothing');
reset role;
select tdp.check((select total = 1466.66 and deposit_amount = 366.67 and deposit_invoice_id = :'deposit' from public.quotes where id = :'deck'),
  'the deposit is 25% of the total she approved, and the quote has its invoice');
select tdp.check((select kind = 'deposit' and status = 'sent' and client_id = :'rae' and job_id is null and tax_rate = 0 and total = 366.67 and balance_due = 366.67
                    and due_on = (now() at time zone 'America/Denver')::date + 30 and number is not null and subject = 'Deposit: Back deck'
                    from public.invoices where id = :'deposit'), 'an untaxed deposit invoice for it, sent and due in the business''s 30 days');
select tdp.check(exists (select 1 from public.activity where subject_id = :'deposit' and verb = 'invoice.sent' and (data ->> 'total')::numeric = 366.67),
  'sent with its amount, as any invoice');
set role service_role;
select tdp.check(public.hub_deposit_invoice(:'co', :'deck') = :'deposit', 'asked again, it''s the same invoice');
reset role;
select tdp.check((select count(*) = 1 from public.invoices where company_id = :'co' and kind = 'deposit'), 'so there''s only one');

-- ===== Taken off the job's last invoice =========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d5500000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.convert_quote_to_job(:'deck') as job \gset
select tdp.check((select job_id = :'job' from public.invoices where id = :'deposit'), 'the deposit invoice joins the job made from the quote');
select public.create_invoice_for_job(:'job') as final \gset
select tdp.check(exists (select 1 from public.invoice_line_items where invoice_id = :'final' and name like 'Less deposit%' and unit_price = -366.67),
  'and the job''s last invoice takes the deposit off');
commit;

-- ===== Nothing owed, nothing made ===============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d5500000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'rae', 'Railing repair') returning id as railing \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'railing', 'Railing', 250);
update public.quotes set status = 'sent', sent_at = now() where id = :'railing';
commit;
set role service_role;
select tdp.check(public.approve_hub_quote(:'co', :'railing', '{}', '{"name": "Rae Pinecrest"}'), 'a quote without a deposit is approved');
select tdp.check(public.hub_deposit_invoice(:'co', :'railing') is null, 'and has no deposit invoice');
reset role;

\echo 'All deposit percent tests passed.'
