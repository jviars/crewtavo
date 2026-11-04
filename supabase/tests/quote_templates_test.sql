-- Database tests for quote templates (20261104000400_quote_templates): a quote saved as a template
-- keeps its lines, options, sections, message and deposit but not its client, number or end date;
-- it's never sent, approved or made a job, and Home and search don't count it; a quote made from it
-- for a client has its contents, a number and the usual valid-for days; only the business's office
-- and estimators see or use one.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tqt;
grant usage on schema tqt to authenticated, service_role;
create function tqt.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tqt.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tqt to authenticated, service_role;

-- Tess owns Thistle Lawn, with Cal on a crew; Owen owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c4400000-0000-0000-0000-000000000001', 'tess@thistle.test', '{"full_name": "Tess Thistle"}'),
  ('c4400000-0000-0000-0000-000000000002', 'cal@thistle.test', '{"full_name": "Cal Crew"}'),
  ('c4400000-0000-0000-0000-000000000009', 'owen@oak.test', '{"full_name": "Owen Oak"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4400000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Oak Snow', 'general') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Olive Elsewhere') returning id as other_client \gset
select set_config('request.jwt.claims', '{"sub": "c4400000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Thistle Lawn', 'landscaping', 'America/Chicago') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'c4400000-0000-0000-0000-000000000002', 'field_crew');
update public.companies set settings = settings || '{"quote_valid_days": 14}' where id = :'co';
insert into public.clients (company_id, display_name) values (:'co', 'Ada Thistlewood') returning id as ada \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'ada', '4 Fern Ct') returning id as ada_home \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bo Thistlewood') returning id as bo \gset

-- Ada's spring cleanup: two options, a shared add-on she picked, a message, a deposit and a field.
insert into public.quotes (company_id, client_id, property_id, title, message, deposit_amount, valid_until, custom_fields)
  values (:'co', :'ada', :'ada_home', 'Spring cleanup', 'Thanks for having us out.', 50, '2000-01-01', '{"gate": "Side gate"}')
  returning id as quote \gset
insert into public.quote_options (company_id, quote_id, name, sort) values (:'co', :'quote', 'Basic', 1) returning id as basic \gset
insert into public.quote_options (company_id, quote_id, name, sort) values (:'co', :'quote', 'Full', 2) returning id as full_opt \gset
update public.quotes set option_id = :'full_opt' where id = :'quote';
insert into public.quote_line_items (company_id, quote_id, option_id, name, quantity, unit_price, sort) values
  (:'co', :'quote', :'basic', 'Leaf pickup', 1, 120, 1),
  (:'co', :'quote', :'full_opt', 'Leaf pickup and mulch', 1, 300, 2);
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, optional, selected, sort)
  values (:'co', :'quote', 'Gutter clean', 1, 80, true, true, 3);

-- ===== Saved as a template ======================================================================
select public.duplicate_quote(:'quote', ' Spring cleanup (small yard) ') as tmpl \gset
select tqt.check((select is_template and client_id is null and property_id is null and number is null and status = 'draft'
                    and title = 'Spring cleanup (small yard)' and valid_until is null from public.quotes where id = :'tmpl'),
  'a template has no client, property, number or end date, and is a draft with the name given');
select tqt.check((select message = 'Thanks for having us out.' and deposit_amount = 50 and custom_fields = '{"gate": "Side gate"}' from public.quotes where id = :'tmpl'),
  'it keeps the message, the deposit and the custom field values');
select tqt.check((select count(*) = 2 from public.quote_options where quote_id = :'tmpl')
  and (select o.name = 'Full' from public.quotes q join public.quote_options o on o.id = q.option_id where q.id = :'tmpl'),
  'and its options, with the same one shown');
select tqt.check((select count(*) = 3 from public.quote_line_items where quote_id = :'tmpl')
  and (select not selected from public.quote_line_items where quote_id = :'tmpl' and name = 'Gutter clean')
  and (select o.name = 'Basic' from public.quote_line_items l join public.quote_options o on o.id = l.option_id where l.quote_id = :'tmpl' and l.name = 'Leaf pickup'),
  'and its lines on their options, with the add-on unpicked');
select tqt.check((select total = 300 from public.quotes where id = :'tmpl'), 'its total is the option shown, as any quote''s');
select tqt.expect_error(format('select public.duplicate_quote(%L, %L)', :'quote', '  '), 'a template needs a name');
select tqt.expect_error(format('select public.duplicate_quote(%L, %L, %L)', :'quote', 'Both', :'bo'), 'and has no client');

-- ===== Never sent, approved, made a job or counted ==============================================
select tqt.expect_error(format('update public.quotes set status = %L, sent_at = now() where id = %L', 'sent', :'tmpl'), 'a template can''t be sent');
select tqt.expect_error(format('update public.quotes set status = %L, approved_at = now() where id = %L', 'approved', :'tmpl'), 'or approved');
insert into public.quotes (company_id, client_id, title) values (:'co', :'ada', 'Weekly mow') returning id as mow \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (:'co', :'mow', 'Mow', 1, 45);
select public.duplicate_quote(:'mow', 'Weekly mow') as mow_tmpl \gset
select tqt.expect_error(format('select public.convert_quote_to_job(%L)', :'mow_tmpl'), 'or made a job');
select tqt.check(not exists (select 1 from public.jobs where company_id = :'co'), 'so no job is made from it');
select tqt.expect_error(format('update public.quotes set client_id = %L where id = %L', :'bo', :'tmpl'), 'or given a client');
select tqt.expect_error(format('insert into public.quotes (company_id, title) values (%L, %L)', :'co', 'No client'), 'a quote that isn''t a template needs a client');
select tqt.expect_error(format('insert into public.quotes (company_id, client_id, title, is_template) values (%L, %L, %L, true)', :'co', :'ada', 'Mine'),
  'and a template can''t be made with one');
update public.quotes set message = 'Hi there.', deposit_amount = 75 where id = :'tmpl';
select tqt.check((select message = 'Hi there.' and deposit_amount = 75 from public.quotes where id = :'tmpl'), 'it''s edited as a quote is');
select tqt.check((select (public.dashboard(:'co') -> 'workflow' -> 'quotes' ->> 'draft')::int = 2), 'Home counts only the quotes among the drafts, not the templates');
select tqt.check(not exists (select 1 from public.global_search(:'co', 'small yard')), 'search doesn''t find it');

-- ===== A quote from it ==========================================================================
select public.duplicate_quote(:'tmpl', null, :'bo', null, 'Cleanup for Bo') as bos \gset
select tqt.check((select not is_template and client_id = :'bo' and property_id is null and number is not null and status = 'draft' and title = 'Cleanup for Bo'
                    and message = 'Hi there.' and deposit_amount = 75 and custom_fields = '{"gate": "Side gate"}' from public.quotes where id = :'bos'),
  'a quote from the template is the client''s, numbered, with its contents');
select tqt.check((select valid_until = (now() at time zone 'America/Chicago')::date + 14 from public.quotes where id = :'bos'), 'valid for the business''s usual days');
select tqt.check((select count(*) = 3 from public.quote_line_items where quote_id = :'bos') and (select count(*) = 2 from public.quote_options where quote_id = :'bos')
  and (select total = 300 from public.quotes where id = :'bos'), 'with its lines and options');
select public.duplicate_quote(:'tmpl', null, :'ada', :'ada_home') as adas \gset
select tqt.check((select title = 'Spring cleanup (small yard)' and property_id = :'ada_home' from public.quotes where id = :'adas'), 'without a title it''s the template''s name, at the property picked');
select public.duplicate_quote(:'tmpl', null, :'bo', null, null, '{"gate": "Back gate"}') as bos_gate \gset
select tqt.check((select custom_fields = '{"gate": "Back gate"}' from public.quotes where id = :'bos_gate'), 'or with the custom field values the new-quote form gave');
select public.duplicate_quote(:'tmpl') as again \gset
select tqt.check((select is_template and title = 'Spring cleanup (small yard) (copy)' from public.quotes where id = :'again'), 'a template copied without a client is another template');
select public.duplicate_quote(:'quote') as copy \gset
select tqt.check((select not is_template and client_id = :'ada' and title = 'Spring cleanup (copy)' and valid_until is null and custom_fields = '{}' from public.quotes where id = :'copy'),
  '"Copy as new draft" still copies a quote for its client as before');
select tqt.expect_error(format('select public.duplicate_quote(%L, null, %L)', :'tmpl', :'other_client'), 'another business''s client can''t get it');
select tqt.check((select (public.dashboard(:'co') -> 'workflow' -> 'quotes' ->> 'draft')::int = 6), 'the quotes made from it count on Home');
commit;

-- ===== Who sees and uses templates ==============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4400000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tqt.check(not exists (select 1 from public.quotes where id = :'tmpl'), 'the crew don''t see a template');
select tqt.expect_error(format('select public.duplicate_quote(%L, null, %L)', :'tmpl', :'bo'), 'or make a quote from it');
select set_config('request.jwt.claims', '{"sub": "c4400000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select tqt.check(not exists (select 1 from public.quotes where id = :'tmpl'), 'another business doesn''t see it');
select tqt.expect_error(format('select public.duplicate_quote(%L, null, %L)', :'tmpl', :'other_client'), 'or use it');
select tqt.expect_error(format('select public.duplicate_quote(%L, %L)', :'quote', 'Stolen'), 'or save one from this business''s quotes');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c4400000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.quotes where id = :'again';
select tqt.check(not exists (select 1 from public.quotes where id = :'again') and not exists (select 1 from public.quote_line_items where quote_id = :'again'),
  'a template is deleted with its lines');
commit;

\echo 'All quote template tests passed.'
