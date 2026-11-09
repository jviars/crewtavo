-- Database tests for what a roof estimate keeps when it goes out and what Home asks about after:
-- quotes.left_out, the dashboard's leads nobody picked up and estimates waiting on a visit or a
-- signature, and the follow-up starting again when the exact price goes out after a yes to the range.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1150;
grant usage on schema t1150 to authenticated, service_role;
create function t1150.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1150.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The dashboard's attention items whose title is like this.
create function t1150.attention(p_company uuid, p_title text) returns setof jsonb language sql as $$
  select item from jsonb_array_elements(public.dashboard(p_company) -> 'attention') item where item ->> 'title' like p_title
$$;
grant execute on all functions in schema t1150 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('fb000000-0000-0000-0000-000000000001', 'owner@lima.test', '{"full_name": "Lee Owner"}'),
  ('fb000000-0000-0000-0000-000000000002', 'mike@lima.test', '{"full_name": "Mike North"}'),
  ('fb000000-0000-0000-0000-000000000003', 'crew@lima.test', '{"full_name": "Cal Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fb000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Lima Roofing', 'roofing') as co \gset
commit;

-- The rest is set up as it would be after days of work (dates in the past), without the app's guards.
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'fb000000-0000-0000-0000-000000000002', 'estimator'),
  (:'co', 'fb000000-0000-0000-0000-000000000003', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Alan Park') returning id as client \gset
insert into public.requests (company_id, client_id, title, assigned_to, created_at) values (:'co', :'client', 'Hail damage', 'fb000000-0000-0000-0000-000000000002', now() - interval '3 days 1 hour') returning number as stale_number \gset
insert into public.requests (company_id, client_id, title, created_at) values (:'co', :'client', 'Gutter leak', now() - interval '5 days') returning number as nobody_number \gset
insert into public.requests (company_id, client_id, title) values (:'co', :'client', 'Came in today');
insert into public.quotes (company_id, client_id, title, status, range_low, range_high, range_sent_at, range_accepted_at, salesperson_id)
  values (:'co', :'client', 'Roof at 4 Ash Ct', 'sent', 18000, 21000, now() - interval '2 days', now() - interval '1 day', 'fb000000-0000-0000-0000-000000000002')
  returning id as yes_quote, number as yes_number \gset
insert into public.quotes (company_id, client_id, title, status, range_low, range_high, range_sent_at, range_accepted_at, exact_sent_at)
  values (:'co', :'client', 'Roof at 8 Oak Ln', 'sent', 15000, 17000, now() - interval '9 days', now() - interval '6 days', now() - interval '4 days')
  returning id as exact_quote, number as exact_number \gset
insert into public.quotes (company_id, client_id, title, status, priced_on_site_at)
  values (:'co', :'client', 'Roof at 2 Elm St', 'sent', now() - interval '1 day') returning number as fresh_number \gset
insert into public.quotes (company_id, client_id, title, status) values (:'co', :'client', 'Plain quote', 'sent') returning id as plain_quote \gset

-- ===== What an estimate keeps when it goes out ==================================================
select t1150.check((select left_out = '[]'::jsonb from public.quotes where id = :'yes_quote'), 'an estimate starts with nothing left off');
select t1150.expect_error(format('update public.quotes set left_out = %L where id = %L', '{"name": "Drip edge"}', :'yes_quote'), 'what was left off is a list');

-- ===== Home: what needs someone ================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fb000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t1150.check((select count(*) from t1150.attention(:'co', 'Request #' || :'stale_number' || ' waiting 3 days') item where item ->> 'detail' = 'Hail damage · Mike North' and item ->> 'kind' = 'request') = 1, 'a request waiting over 2 days needs attention, with whose it is');
select t1150.check((select count(*) from t1150.attention(:'co', 'Request #' || :'nobody_number' || ' waiting 5 days') item where item ->> 'detail' = 'Gutter leak · Nobody has it yet') = 1, 'one nobody has says so');
select t1150.check((select count(*) from t1150.attention(:'co', 'Request #% waiting%')) = 2, 'a request that came in today doesn''t');
select t1150.check((select count(*) from t1150.attention(:'co', 'Estimate #' || :'yes_number' || ': book the site visit') item where item ->> 'detail' = 'Alan Park said yes to the range · Mike North' and item ->> 'link' = '/roofing/' || :'yes_quote') = 1, 'a yes to the range with no price set on site needs a visit booked');
select t1150.check((select count(*) from t1150.attention(:'co', 'Estimate #' || :'exact_number' || ': not signed yet') item where item ->> 'detail' like 'Alan Park · exact price out 4 days%') = 1, 'an exact price out 3 days and not signed needs a nudge');
select t1150.check((select count(*) from t1150.attention(:'co', 'Estimate #' || :'fresh_number' || '%')) = 0, 'one priced on site yesterday doesn''t yet');
commit;

-- ===== The follow-up starts again when the exact price goes out ================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fb000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.quote_exact_sent(:'exact_quote');
select public.quote_exact_sent(:'exact_quote');
select public.quote_exact_sent(:'plain_quote');
commit;
select t1150.check((select count(*) from public.activity where subject_id = :'exact_quote' and verb = 'quote.sent' and summary like 'Exact price for quote #% sent to Alan Park%') = 2, 'the exact price going out after a yes counts as sent again');
select t1150.check((select count(*) from public.automation_runs r join public.automation_rules rule on rule.id = r.rule_id where rule.trigger = 'quote.sent' and r.subject_id = :'exact_quote' and r.status = 'pending') = 1, 'with one follow-up waiting, however many times it goes out');
select t1150.check((select count(*) from public.automation_runs r join public.automation_rules rule on rule.id = r.rule_id where rule.trigger = 'quote.sent' and r.subject_id = :'exact_quote' and r.status = 'cancelled') = 1, 'the one before it is cancelled');
select t1150.check((select count(*) from public.activity where subject_id = :'plain_quote' and verb = 'quote.sent') = 0, 'a quote that never had a yes or a site price isn''t sent again');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "fb000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t1150.expect_error(format('select public.quote_exact_sent(%L)', :'exact_quote'), 'the crew can''t send a quote''s follow-up');
commit;

\o
