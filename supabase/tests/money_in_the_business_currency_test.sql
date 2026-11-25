-- Database tests for 20261124100300_money_in_the_business_currency.sql: the symbol for each currency
-- (core moneyPrefix); a business in dollars reads exactly as before; what a client paying from a bank
-- account agrees to names the limit in the business's currency, and the limit is read back out of it
-- in any of them; and a sub's offer, owed and paid notices say the business's money.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmbc;
grant usage on schema tmbc to authenticated, service_role;
create function tmbc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tmbc.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- The 'jobs' notices someone has about a pay, oldest first.
create function tmbc.told(p_user uuid, p_pay uuid) returns text[] language sql security definer as $$
  select coalesce(array_agg(title order by created_at, id), '{}') from public.notifications where user_id = p_user and kind = 'jobs' and link = '/field/jobs/' || p_pay
$$;
grant execute on all functions in schema tmbc to authenticated, service_role;

\set bank 'If you pay from a bank account: '

-- ===== The symbol ===============================================================================
select tmbc.check(private.money_prefix('USD') = '$' and private.money_prefix('CAD') = '$' and private.money_prefix('AUD') = '$' and private.money_prefix('NZD') = '$',
  'every dollar is "$", as people there write it');
select tmbc.check(private.money_prefix('GBP') = '£' and private.money_prefix('eur') = '€' and private.money_prefix(' ZAR ') = 'R ', 'pounds, euros and rand have their own');
select tmbc.check(private.money_prefix(null) = '$' and private.money_prefix('') = '$' and private.money_prefix('JPY') = '$', 'anything else is "$", as before');

select tmbc.check((select bool_and(private.money_in(n, 'USD') = private.money(n) and private.money_in(n, 'CAD') = private.money(n))
  from unnest(array[0, 0.07, 500, 1250.5, 1234567.891, null]::numeric[]) n), 'an amount in dollars is written as private.money writes it');
select tmbc.check(private.money_in(1250.5, 'GBP') = '£1,250.50' and private.money_in(1250.5, 'EUR') = '€1,250.50' and private.money_in(1250.5, 'ZAR') = 'R 1,250.50',
  'and in the business''s own currency');

select tmbc.check((select bool_and(private.money_short(n, 'USD') = private.money_short(n) and private.money_short(n, 'NZD') = private.money_short(n))
  from unnest(array[2040, 2040.5, 0.07, 1234567.891, null, -5]::numeric[]) n), 'a sub''s money in dollars reads as before');
select tmbc.check(private.money_short(2040, 'GBP') = '£2,040' and private.money_short(2040.5, 'EUR') = '€2,040.50' and private.money_short(2040, 'ZAR') = 'R 2,040',
  'and in the business''s own currency, cents only when there are some');

-- ===== What a bank account agrees to ===========================================================
select tmbc.check((select bool_and(private.autopay_bank_text(a, 'USD') = private.autopay_bank_text(a) and private.autopay_bank_text(a, 'CAD') = private.autopay_bank_text(a)
    and private.autopay_bank_text(a, null) = private.autopay_bank_text(a))
  from unnest(array['{"max_amount": 500}', '{"max_amount": 1250.5}', '{"max_amount": null}', '{}', '{"max_amount": "lots"}']::jsonb[]) a),
  'a business in dollars agrees to exactly the words it did');
select tmbc.check(private.autopay_bank_text('{"max_amount": 1250.5}', 'GBP') = :'bank' || 'charges of £1,250.50 or less are taken automatically. An invoice for more than £1,250.50 is not taken from your bank account: we send it to you to pay.',
  'one in pounds names its limit in pounds');
select tmbc.check(private.autopay_bank_text('{"max_amount": null}', 'EUR') = private.autopay_bank_text('{"max_amount": null}'), 'and with no limit there''s no money to name');
select tmbc.check(private.autopay_agreed_cap('Our words.' || E'\n\n' || private.autopay_bank_text('{"max_amount": 1250.5}', 'GBP')) = 1250.5
    and private.autopay_agreed_cap('Our words.' || E'\n\n' || private.autopay_bank_text('{"max_amount": 300}', 'EUR')) = 300
    and private.autopay_agreed_cap('Our words.' || E'\n\n' || private.autopay_bank_text('{"max_amount": 75}', 'ZAR')) = 75
    and private.autopay_agreed_cap('Our words.' || E'\n\n' || private.autopay_bank_text('{"max_amount": 500}', 'USD')) = 500,
  'the limit a client agreed to is read back out of the words in any currency');
select tmbc.check(private.autopay_agreed_cap('Jobs of more than £50.00 need a deposit.' || E'\n\n' || private.autopay_bank_text('{"max_amount": null}', 'GBP')) is null,
  'never from the business''s own words before the paragraph');

\set olive 'b1240000-0000-4000-8000-000000000001'
\set sid 'b1240000-0000-4000-8000-000000000002'
\set una 'b1240000-0000-4000-8000-000000000003'
\set slate 'b1240000-0000-4000-8000-0000000000c1'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@thames.test', '{"full_name": "Olive Owner"}'),
  (:'sid', 'sid@slate.test', '{"full_name": "Sid Slate"}'),
  (:'una', 'una@usa.test', '{"full_name": "Una Owner"}');

begin;
set local role authenticated;
select tmbc.as_user(:'olive');
select public.create_company('Thames Roofing', 'roofing', 'Europe/London') as co \gset
select tmbc.as_user(:'una');
select public.create_company('Union Roofing', 'roofing', 'America/New_York') as us \gset
commit;
-- The same autopay settings for both (as autopay_set_settings saves them, which this stands in for).
begin;
select set_config('crewtavo.autopay', 'on', true);
update public.companies set currency = case when id = :'co' then 'GBP' else currency end, country = case when id = :'co' then 'GB' else country end,
  settings = settings || jsonb_build_object('autopay', jsonb_build_object('enabled', true, 'terms', 'Our words.', 'timing', 'end_of_day', 'max_amount', 400))
  where id in (:'co', :'us');
commit;

select tmbc.check(private.autopay_terms_shown(:'co') = 'Our words.' || E'\n\nWe charge at the end of the day of each visit.\n\n' || private.autopay_bank_text('{"max_amount": 400}', 'GBP')
  and private.autopay_terms_shown(:'co') like '%more than £400.00 is not taken%', 'what a client of a business in pounds agrees to names its limit in pounds');
select tmbc.check(private.autopay_terms_shown(:'us') = 'Our words.' || E'\n\nWe charge at the end of the day of each visit.\n\n' || private.autopay_bank_text('{"max_amount": 400}'),
  'a US business''s clients agree to the words they did');

-- ===== A sub's offer, owed and paid ============================================================
begin;
set local role authenticated;
select tmbc.as_user(:'olive');
insert into public.subcontractors (id, company_id, name, contact_name) values (:'slate', :'co', 'Slate & Sons', 'Sid Slate');
insert into public.clients (company_id, display_name) values (:'co', 'Ann Smith') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Smith roof') returning id as job \gset
select public.job_pay_start(:'job', :'slate', null, '{}') as pay \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, rate) values (:'co', :'pay', 'Re-roof', 2040.5);
commit;
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sid', 'subcontractor', :'slate');

select tmbc.check(private.sub_offer_line(:'pay') = 'Smith roof, £2,040.50', 'the offer in one line says pounds');
begin;
set local role authenticated;
select tmbc.as_user(:'olive');
select public.send_sub_offer(:'pay');
commit;
select tmbc.check(tmbc.told(:'sid', :'pay') = array['Smith roof, £2,040.50. Open Crewtavo to accept or decline.'], 'and so does the offer the sub gets');
begin;
set local role authenticated;
select tmbc.as_user(:'sid');
select tmbc.check(public.answer_sub_offer(:'pay', true), 'Sid takes it');
commit;
update public.job_pay set status = 'done', earned_on = current_date where id = :'pay';
select tmbc.check(tmbc.told(:'sid', :'pay') @> array['Owed: £2,040.50 for Smith roof'], 'what he''s owed is in pounds');
begin;
set local role authenticated;
select tmbc.as_user(:'olive');
select public.job_pay_mark_paid(array[:'pay']::uuid[], 'check', current_date);
commit;
select tmbc.check(exists (select 1 from unnest(tmbc.told(:'sid', :'pay')) t where t like 'Paid £2,040.50 on %'), 'and what he''s paid');

\echo 'All tests of money in the business''s currency passed.'
