-- Database tests for website analytics: page views count only while the app is installed and only
-- from the business's own website, a visitor is a daily hash that never holds an address or a
-- browser, a visit starts where it came from, only people with Marketing read the numbers, finished
-- days roll up into web_daily without changing them, old salts go, and a booking request finds the
-- visit that brought it in.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema wat;
grant usage on schema wat to authenticated, service_role;
create function wat.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function wat.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema wat to authenticated, service_role;

-- Ana owns Pine Lawn (in Chicago); Bo is office; Cy is an estimator; Di is on the field crew; Flo is
-- at the front desk (an office role without Marketing). Ed owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('aa110000-0000-0000-0000-000000000001', 'ana@pine.test', '{"full_name": "Ana Pine"}'),
  ('aa110000-0000-0000-0000-000000000002', 'bo@pine.test', '{"full_name": "Bo Rivers"}'),
  ('aa110000-0000-0000-0000-000000000003', 'cy@pine.test', '{"full_name": "Cy Grant"}'),
  ('aa110000-0000-0000-0000-000000000004', 'di@pine.test', '{"full_name": "Di Moss"}'),
  ('aa110000-0000-0000-0000-000000000005', 'flo@pine.test', '{"full_name": "Flo Hart"}'),
  ('aa110000-0000-0000-0000-000000000009', 'ed@oak.test', '{"full_name": "Ed Oak"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Oak Snow', 'general') as other \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Pine Lawn', 'lawn_care', 'America/Chicago') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Front desk', 'office', '{sales,schedule}') returning id as desk \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'aa110000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'aa110000-0000-0000-0000-000000000003', 'estimator'),
  (:'co', 'aa110000-0000-0000-0000-000000000004', 'field_crew');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', 'aa110000-0000-0000-0000-000000000005', 'office', :'desk');
commit;

select slug from public.companies where id = :'co' \gset
select (now() at time zone 'America/Chicago')::date as today \gset

-- ===== Off until it's installed, and only owners and admins install it ======================
begin;
set local role service_role;
select wat.check(not public.web_record_hit('203.0.113.5', 'Mozilla/5.0 Phone', 'pinelawn.com', '/', 'phone', :'slug', null, null, null, null),
  'nothing counts before the app is installed');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select wat.expect_error(format('select public.web_analytics_save(%L, %L)', :'co', '{"enabled": true}'), 'the office can''t install it');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select wat.check((public.web_analytics_save(:'co', '{"enabled": true, "site": "https://www.pinelawn.com", "host": "www.pinelawn.com", "nope": 1}') -> 'enabled') = 'true',
  'the owner installs it');
select wat.check((select not (settings -> 'website_analytics' ? 'nope') and settings -> 'website_analytics' ? 'changed_at' from public.companies where id = :'co'),
  'only its own settings are kept, with when it was turned on');
select wat.expect_error(format('select public.web_analytics_save(%L, %L)', :'co', '{"enabled": "yes"}'), 'enabled is true or false');
select wat.expect_error(format('select public.web_analytics_save(%L, %L)', :'other', '{"enabled": true}'), 'nobody installs it for another business');
select wat.expect_error('select public.web_record_hit(''192.0.2.1'', ''ua'', ''pinelawn.com'', ''/'', ''phone'', null, null, null, null, null)',
  'people can''t count page views themselves');
commit;

-- ===== Counting =============================================================================
begin;
set local role service_role;
select wat.check(public.web_record_hit('203.0.113.5', 'Mozilla/5.0 Phone', 'pinelawn.com', '/', 'phone', :'slug', 'Google', 'search', null, 'www.google.com'),
  'a page view from Google counts');
select wat.check(public.web_record_hit('203.0.113.5', 'Mozilla/5.0 Phone', 'www.pinelawn.com', '/services', 'phone', :'slug', null, null, null, null),
  'the next page counts, with www. or without');
select wat.check(public.web_record_hit('203.0.113.5', 'Mozilla/5.0 Phone', 'blog.pinelawn.com', '/tips', 'phone', :'slug', null, null, null, null),
  'a page on a subdomain counts');
select wat.check(not public.web_record_hit('203.0.113.5', 'Mozilla/5.0 Phone', 'copy-of-pinelawn.net', '/', 'phone', :'slug', null, null, null, null),
  'a copy of the site somewhere else doesn''t');
select wat.check(not public.web_record_hit('203.0.113.5', 'Mozilla/5.0 Phone', 'notpinelawn.com', '/', 'phone', :'slug', null, null, null, null),
  'nor does a name that only ends the same');
select wat.check(public.web_record_hit('198.51.100.7', 'Mozilla/5.0 Desktop', 'pinelawn.com', '/', 'computer', :'slug', 'Newsletter', 'email', 'spring-cleanup', null),
  'a second visitor counts');
select wat.check(not public.web_record_hit('198.51.100.7', 'Mozilla/5.0 Desktop', 'pinelawn.com', '/', 'computer', null, null, null, null, null),
  'without the business''s name, a server with several can''t tell whose it is');
select wat.check(not public.web_record_hit('198.51.100.7', 'Mozilla/5.0 Desktop', 'pinelawn.com', '/', 'computer', 'no-such-business', null, null, null, null),
  'an unknown business counts nothing');
commit;

select private.web_visitor(:'co', :'today', '203.0.113.5', 'Mozilla/5.0 Phone') as phone \gset
select wat.check((select count(*) from public.web_hits where company_id = :'co') = 4, 'four page views were kept');
select wat.check((select count(distinct visitor) from public.web_hits where company_id = :'co') = 2, 'from two visitors');
select wat.check((select bool_and(day = :'today') from public.web_hits where company_id = :'co'), 'on the business''s own day');
select wat.check(not exists (select 1 from public.web_hits where company_id = :'co' and (visitor ~ '203\.0|198\.51|Mozilla' or length(visitor) <> 32)),
  'a visitor is a hash, not their address or browser');
select wat.check(private.web_visitor(:'co', :'today', '203.0.113.5', 'Mozilla/5.0 Phone') <> private.web_visitor(:'co', :'today'::date + 1, '203.0.113.5', 'Mozilla/5.0 Phone'),
  'the same person is someone new the next day');
select wat.check(private.web_visitor(:'co', :'today', '203.0.113.5', 'Mozilla/5.0 Phone') <> private.web_visitor(:'other', :'today', '203.0.113.5', 'Mozilla/5.0 Phone'),
  'and someone else to another business');
select wat.check((select array_agg(entry order by id) from public.web_hits where visitor = :'phone') = array[true, false, false], 'a visit starts once');
select wat.check((select source || ' ' || channel || ' ' || referrer from public.web_hits where visitor = :'phone' order by id limit 1) = 'Google search www.google.com',
  'its first page says where it came from');
select wat.check((select count(*) from public.web_hits where visitor = :'phone' and source is not null) = 1, 'later pages don''t');

begin;
set local role service_role;
select public.web_record_hit('203.0.113.5', 'Mozilla/5.0 Phone', 'pinelawn.com', '/lawn-care', 'phone', :'slug', 'Facebook', 'social', null, 'l.facebook.com');
select public.web_record_hit('203.0.113.5', 'Mozilla/5.0 Phone', 'pinelawn.com', '/lawn-care', 'phone', :'slug', 'Facebook', 'social', null, 'l.facebook.com');
commit;
select wat.check((select array_agg(entry order by id) from public.web_hits where visitor = :'phone') = array[true, false, false, true, false],
  'coming back from somewhere else starts a new visit, and a reload doesn''t');

-- ===== Who sees it ==========================================================================
insert into public.web_daily (company_id, day, kind, key, visitors, pageviews, visits) values (:'other', :'today', 'total', '', 9, 9, 9);

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select wat.expect_error('select count(*) from public.web_hits', 'nobody reads page views directly');
select wat.expect_error(format('insert into public.web_daily (company_id, day, kind, key) values (%L, %L, ''total'', '''')', :'co', :'today'), 'nor writes the counts');
select wat.check((select count(*) from public.web_daily) = 0, 'and another business''s counts are hidden');
select public.web_stats(:'co', :'today'::date - 6, :'today') as stats \gset
select wat.check((:'stats'::jsonb -> 'days' -> -1) @> jsonb_build_object('day', :'today', 'visitors', 2, 'pageviews', 6, 'visits', 3), 'the office sees today''s visitors, pages and visits');
select wat.check(:'stats'::jsonb -> 'pages' -> 0 @> '{"path": "/", "visitors": 2, "pageviews": 2, "entries": 2}', 'the home page leads, with where visits started');
select wat.check(:'stats'::jsonb -> 'sources' @> '[{"source": "Google", "channel": "search", "visitors": 1, "visits": 1}, {"source": "Facebook", "channel": "social", "visits": 1}]',
  'where visits came from');
select wat.check(:'stats'::jsonb -> 'campaigns' = '[{"campaign": "spring-cleanup", "visitors": 1, "visits": 1, "requests": 0}]', 'campaigns');
select wat.check(:'stats'::jsonb -> 'devices' @> '[{"device": "phone", "visitors": 1, "pageviews": 5}, {"device": "computer", "visitors": 1, "pageviews": 1}]', 'and devices');
select wat.expect_error(format('select public.web_stats(%L, %L, %L)', :'other', :'today', :'today'), 'not another business''s');
select wat.expect_error(format('select public.web_stats(%L, %L, %L)', :'co', :'today', :'today'::date - 1), 'a range ends after it starts');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select wat.expect_error(format('select public.web_stats(%L, %L, %L)', :'co', :'today', :'today'), 'an estimator doesn''t see them');
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select wat.expect_error(format('select public.web_stats(%L, %L, %L)', :'co', :'today', :'today'), 'nor does field crew');
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select wat.expect_error(format('select public.web_stats(%L, %L, %L)', :'co', :'today', :'today'), 'nor an office role without Marketing');
commit;

-- ===== A booking request remembers its visit ================================================
begin;
set local role service_role;
select public.web_record_hit('192.0.2.44', 'Mozilla/5.0 Tablet', 'pinelawn.com', '/aeration', 'tablet', :'slug', 'Yelp', 'directory', null, 'www.yelp.com');
select public.web_record_hit('192.0.2.44', 'Mozilla/5.0 Tablet', 'pinelawn.com', '/contact', 'tablet', :'slug', null, null, null, null);
select public.web_visit_for(:'co', '192.0.2.44', 'Mozilla/5.0 Tablet') as visit \gset
select wat.check(:'visit'::jsonb @> '{"landing_page": "/aeration", "page": "/contact", "source": "Yelp", "channel": "directory", "referrer": "www.yelp.com", "device": "tablet"}'
  and :'visit'::jsonb ? 'visited_at', 'a booking finds the page and source that brought them in');
select wat.check(public.web_visit_for(:'co', '192.0.2.99', 'Mozilla/5.0 Tablet') is null, 'someone who never visited has none');
select wat.check(public.web_visit_for(:'other', '192.0.2.44', 'Mozilla/5.0 Tablet') is null, 'and another business never sees this one''s visitors');
commit;

insert into public.clients (company_id, status, display_name, lead_source) values (:'co', 'lead', 'Lee Park', 'Website form') returning id as client \gset
insert into public.requests (company_id, client_id, source, title, web_visit, created_by) values (:'co', :'client', 'web_form', 'Aeration', :'visit', null);

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.web_stats(:'co', :'today'::date - 6, :'today') as stats \gset
select wat.check((:'stats'::jsonb -> 'days' -> -1 ->> 'requests')::integer = 1, 'the request counts on its day');
select wat.check(:'stats'::jsonb -> 'pages' @> '[{"path": "/aeration", "requests": 1}, {"path": "/", "requests": 0}]', 'for the page the visit started on');
select wat.check(:'stats'::jsonb -> 'sources' @> '[{"source": "Yelp", "channel": "directory", "visits": 1, "requests": 1}]', 'and the source it came from');
commit;

-- ===== Finished days roll up without changing the numbers ===================================
-- As though everything so far happened three days ago.
update public.web_hits set day = day - 3, at = at - interval '3 days' where company_id = :'co';
update public.requests set created_at = created_at - interval '3 days' where company_id = :'co';
insert into private.web_salts (day, salt) values (current_date - 5, '\x00'::bytea);

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.web_stats(:'co', :'today'::date - 6, :'today') as before_rollup \gset
commit;

begin;
set local role service_role;
select wat.check((public.web_rollup() ->> 'hits')::integer >= 8, 'finished days are rolled up');
commit;

select wat.check(not exists (select 1 from public.web_hits where company_id = :'co'), 'and their page views deleted');
select wat.check((select visitors from public.web_daily where company_id = :'co' and kind = 'total') = 3, 'into a day''s counts');
select wat.check(not exists (select 1 from private.web_salts where day = current_date - 5), 'old salts are deleted');
select wat.check(exists (select 1 from private.web_salts where day = :'today'), 'today''s stays');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select wat.check(public.web_stats(:'co', :'today'::date - 6, :'today') = :'before_rollup'::jsonb, 'the numbers are the same after rolling up');
select wat.check((select count(*) from public.web_daily where company_id = :'co') > 0, 'and the office can read the counts');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select wat.check((select count(*) from public.web_daily) = 0, 'without Marketing, nobody can');
commit;

-- ===== Uninstalling stops counting and keeps the numbers ====================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select wat.check((public.web_analytics_save(:'co', '{"enabled": false}') -> 'enabled') = 'false', 'the owner uninstalls it');
commit;

begin;
set local role service_role;
select wat.check(not public.web_record_hit('192.0.2.44', 'Mozilla/5.0 Tablet', 'pinelawn.com', '/', 'tablet', :'slug', null, null, null, null), 'page views stop counting');
select wat.check(public.web_visit_for(:'co', '192.0.2.44', 'Mozilla/5.0 Tablet') is null, 'and bookings stop looking for visits');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa110000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select wat.check(public.web_stats(:'co', :'today'::date - 6, :'today') = :'before_rollup'::jsonb, 'the numbers stay');
commit;

drop schema wat cascade;
