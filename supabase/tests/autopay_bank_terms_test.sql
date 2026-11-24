-- Database tests for 20261113001820_autopay_bank_account_terms.sql, with the bank account paragraph
-- as 20261116000100_bank_charges_over_the_limit_go_to_the_client.sql has it: the starter words say
-- "card or bank account"; what a client agrees to ends with what happens for a bank account (up to
-- the business's limit it's taken, and an invoice for more is sent to them to pay); the words
-- changed, so the version did, and a new limit is a new version; an agreement keeps the words and
-- version it was made with; and someone part way through agreeing is asked to read the terms again.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tabt;
grant usage on schema tabt to authenticated, service_role;
create sequence tabt.checks;
grant usage on sequence tabt.checks to authenticated, service_role;
create function tabt.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  perform nextval('tabt.checks');
  raise notice 'ok - %', p_what;
end $$;
create function tabt.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function tabt.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlerrm;
end $$;
create function tabt.settings(p_max numeric default 500, p_terms text default 'We charge the card or bank account on file after each visit is done.', p_timing text default 'end_of_day') returns jsonb language sql as $$
  select jsonb_build_object('enabled', true, 'terms', p_terms, 'timing', p_timing, 'days', null, 'max_amount', p_max, 'receipts', true, 'jobs_default', true, 'card_required', false)
$$;
grant execute on all functions in schema tabt to authenticated, service_role;

\set ora 'ba4c0000-0000-0000-0000-000000000001'
\set bank 'If you pay from a bank account: '

-- Everything below is rolled back at the end.
begin;
insert into auth.users (id, email, raw_user_meta_data) values (:'ora', 'ora@bank.test', '{"full_name": "Ora Owner"}');
set local role authenticated;
select tabt.as_user(:'ora');
select public.create_company('Bank Lawn', 'lawn_exterior') as co \gset
reset role;

\o
\echo 'The starter words'
\o /dev/null
select tabt.check((select bool_and(private.autopay_starter_terms(t) like 'We charge the card or bank account on file %') from unnest(array['lawn_exterior', 'cleaning', 'pool_service', 'pest_control', 'paving', 'roofing_exteriors', 'general', 'snow', null]) t),
  'every trade''s starter words say the card or bank account on file');
select tabt.check(private.autopay_covers_monthly(private.autopay_starter_terms('lawn_exterior')) and not private.autopay_covers_monthly(private.autopay_starter_terms('paving')),
  'and still say a monthly plan where they did');
select tabt.check(private.autopay_terms_version(:'co') = 'starter-lawn_exterior-3', 'a company that never saved its own is on the starter words'' third version');

\o
\echo 'What a bank account agrees to'
\o /dev/null
select tabt.check(private.autopay_bank_text('{"max_amount": 500}') = :'bank' || 'charges of $500.00 or less are taken automatically. An invoice for more than $500.00 is not taken from your bank account: we send it to you to pay.',
  'up to the business''s limit a charge is taken, and an invoice for more is sent to them to pay');
select tabt.check(private.autopay_bank_text('{"max_amount": 1250.5}') like '%charges of $1,250.50 or less%more than $1,250.50 is not taken%', 'the amount is written as money');
select tabt.check(private.autopay_bank_text('{"max_amount": null}') = :'bank' || 'each charge is for the invoice it pays, and is taken automatically whatever its amount.',
  'with no limit saved every charge is taken, and it says so');
select tabt.check(private.autopay_bank_text('{"max_amount": 500}') !~* 'notice|10 days|told' and private.autopay_bank_text('{"max_amount": null}') !~* 'notice|10 days|told',
  'neither promises notice ahead of a charge');
select tabt.check(private.autopay_bank_text('{}') = private.autopay_bank_text('{"max_amount": 500}') and private.autopay_bank_text('{"max_amount": "lots"}') = private.autopay_bank_text('{"max_amount": 500}')
  and private.autopay_cap('{"max_amount": -4}') = 500 and private.autopay_cap('{"max_amount": null}') is null,
  'a limit never saved, or not a number, reads as the starter $500 (as core autopaySettings reads it)');
select tabt.check(private.autopay_terms_shown(:'co') = private.autopay_starter_terms('lawn_exterior') || E'\n\nWe charge at the end of the day of each visit.' || E'\n\n' || private.autopay_bank_text('{}'),
  'it is the last paragraph of what a client agrees to, after the terms and when charges go');

\o
\echo 'A new limit is a new version, and an agreement keeps what it was made with'
\o /dev/null
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'stripe', 'connected', '{"autopay": true, "refunds": true}');
set local role authenticated;
select tabt.as_user(:'ora');
select public.autopay_set_settings(:'co', tabt.settings()) ->> 'terms_version' as v1 \gset
reset role;
-- A version from before: only what's saved next can change it.
select set_config('crewtavo.autopay', 'on', true);
update public.companies set settings = jsonb_set(settings, '{autopay,terms_version}', '"v-old"') where id = :'co';
select set_config('crewtavo.autopay', 'off', true);
set local role authenticated;
select tabt.as_user(:'ora');
select public.autopay_set_settings(:'co', tabt.settings()) ->> 'terms_version' as v_same \gset
select tabt.check(:'v_same' = 'v-old', 'saving the same limit again keeps the version');
-- A client agrees at $500.
reset role;
insert into public.clients (company_id, display_name) values (:'co', 'Bea Bank') returning id as bea \gset
insert into public.client_payment_methods (company_id, client_id, stripe_payment_method_id, stripe_customer_id, livemode, type, bank_name, last4, is_default)
values (:'co', :'bea', 'pm_bank_bea', 'cus_bank_bea', false, 'us_bank_account', 'Chase', '6789', true) returning id as pm \gset
select public.autopay_record_authorization(:'co', :'bea', :'pm', 'hub', 'v-old', '203.0.113.9', 'Test browser', 'client', 'client') as agreed \gset
select tabt.check((select terms like '%more than $500.00 is not taken%' and terms like 'We charge the card or bank account on file after each visit is done.%' and terms_version = 'v-old'
  from public.autopay_authorizations where id = :'agreed'), 'the agreement keeps every word they agreed to, the bank account paragraph and its $500 included');
-- The business raises its limit.
set local role authenticated;
select tabt.as_user(:'ora');
select public.autopay_set_settings(:'co', tabt.settings(p_max => 800)) ->> 'terms_version' as v_limit \gset
select tabt.check(:'v_limit' <> 'v-old' and :'v_limit' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$', 'a new limit makes a new version, as new words do');
reset role;
select tabt.check(private.autopay_terms_shown(:'co') like '%more than $800.00 is not taken%', 'and the words clients agree to from then on name the new limit');
select tabt.check((select terms like '%more than $500.00 is not taken%' and terms_version = 'v-old' and revoked_at is null from public.autopay_authorizations where id = :'agreed'),
  'the agreement already made is as it was: nobody is asked again, and its record says what they agreed to');
-- Part way through agreeing with the page loaded before the change: asked to read them again.
select tabt.check(tabt.error_of(format('select public.autopay_record_authorization(%L, %L, %L, ''hub'', ''v-old'')', :'co', :'bea', :'pm')) = 'The terms changed. Read them again and agree',
  'someone agreeing with the earlier version is asked to read the terms again, not recorded against words they didn''t see');
set local role authenticated;
select tabt.as_user(:'ora');
select public.autopay_set_settings(:'co', tabt.settings(p_max => null)) as no_limit \gset
reset role;
select tabt.check((:'no_limit'::jsonb) -> 'max_amount' = 'null' and private.autopay_terms_shown(:'co') like '%is taken automatically whatever its amount.',
  'taking the limit off changes the words to say every charge is taken');

rollback;

\o
\echo 'Versions saved before the change'
\o /dev/null
-- Each migration's own step, as it ran: a saved version got "+bank" once, then "+bank2" in its place
-- when the paragraph changed again; a starter one is left to the function.
begin;
insert into auth.users (id, email, raw_user_meta_data) values (:'ora', 'ora@bank.test', '{"full_name": "Ora Owner"}');
set local role authenticated;
select tabt.as_user(:'ora');
select public.create_company('Saved Lawn', 'lawn_exterior') as saved \gset
select public.create_company('Starter Lawn', 'lawn_exterior') as starter \gset
reset role;
select set_config('crewtavo.autopay', 'on', true);
update public.companies set settings = jsonb_set(settings, '{autopay}', '{"enabled": true, "terms": "Our words.", "terms_version": "2026-10-31T14:05:09", "timing": "end_of_day", "max_amount": 500}') where id = :'saved';
update public.companies c
set settings = jsonb_set(c.settings, '{autopay,terms_version}', to_jsonb(left(c.settings -> 'autopay' ->> 'terms_version', 35) || '+bank'))
where jsonb_typeof(c.settings -> 'autopay' -> 'terms_version') = 'string'
  and nullif(c.settings -> 'autopay' ->> 'terms_version', '') is not null
  and c.settings -> 'autopay' ->> 'terms_version' not like '%+bank'
  and c.id in (:'saved', :'starter');
select tabt.check(private.autopay_terms_version(:'saved') = '2026-10-31T14:05:09+bank' and length(private.autopay_terms_version(:'saved')) <= 40,
  'a version saved before the first change is a new one after it, short enough to be kept with an agreement');
update public.companies set settings = jsonb_set(settings, '{autopay}', '{"enabled": true, "terms": "Long words.", "terms_version": "a-version-that-is-as-long-as-a-version-i", "timing": "end_of_day", "max_amount": 500}') where id = :'starter';
update public.companies c
set settings = jsonb_set(c.settings, '{autopay,terms_version}',
  to_jsonb(left(regexp_replace(c.settings -> 'autopay' ->> 'terms_version', '\+bank$', ''), 34) || '+bank2'))
where jsonb_typeof(c.settings -> 'autopay' -> 'terms_version') = 'string'
  and nullif(c.settings -> 'autopay' ->> 'terms_version', '') is not null
  and c.settings -> 'autopay' ->> 'terms_version' not like '%+bank2'
  and c.id in (:'saved', :'starter');
select tabt.check(private.autopay_terms_version(:'saved') = '2026-10-31T14:05:09+bank2',
  'and a new one again once the paragraph says an invoice over the limit is sent to them to pay');
select tabt.check(private.autopay_terms_version(:'starter') = 'a-version-that-is-as-long-as-a-ver+bank2' and length(private.autopay_terms_version(:'starter')) = 40,
  'the longest version a company can have saved still fits');
update public.companies set settings = settings - 'autopay' where id = :'starter';
select set_config('crewtavo.autopay', 'off', true);
select tabt.check(private.autopay_terms_version(:'starter') = 'starter-lawn_exterior-3' and (select settings -> 'autopay' -> 'terms_version' is null from public.companies where id = :'starter'),
  'a company with none saved has nothing written into its settings');
-- With the one in the business's currency beside it (20261124100300_money_in_the_business_currency.sql).
select tabt.check((select array_agg(pg_get_function_identity_arguments(p.oid) order by p.pronargs) = array['p_autopay jsonb', 'p_autopay jsonb, p_currency text']
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'autopay_bank_text'), 'the function is there');
rollback;

select last_value as checks from tabt.checks \gset
\o
\echo 'All autopay bank account terms tests passed (':checks' checks).'
