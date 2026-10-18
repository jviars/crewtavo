-- Database tests for approving a quote in the Client Hub: the quote is claimed before the options
-- are picked, so only the approval that counts picks them, and what runs on approval sees them.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t53;
grant usage on schema t53 to authenticated, service_role;
create function t53.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t53.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t53 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b5000000-0000-0000-0000-000000000001', 'owner@quebec.test', '{"full_name": "Quinn Owner"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b5000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Quebec Decks', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ana Smith') returning id as client \gset

-- A quote with a required line and two options, waiting for the client's answer.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'New deck') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, taxable) values (:'co', :'quote', 'Deck', 1000, false);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, taxable, optional, selected) values (:'co', :'quote', 'Railing', 300, false, true, true) returning id as railing \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, taxable, optional, selected) values (:'co', :'quote', 'Lighting', 200, false, true, false) returning id as lighting \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'quote';

-- Another quote the office takes back to change it.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Fence') returning id as fence \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, taxable, optional, selected) values (:'co', :'fence', 'Gate', 400, false, true, true) returning id as gate \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'fence';

-- And a change order to a job, with an option.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Old deck') returning id as old_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, taxable) values (:'co', :'old_quote', 'Repair', 500, false);
select public.convert_quote_to_job(:'old_quote') as job \gset
insert into public.quotes (company_id, client_id, title, change_order_for) values (:'co', :'client', 'Change order: stairs', :'job') returning id as change \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, taxable) values (:'co', :'change', 'Stairs', 600, false);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, taxable, optional, selected) values (:'co', :'change', 'Handrail', 150, false, true, false) returning id as handrail \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'change';
commit;

-- ===== Only the server approves ===============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b5000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t53.expect_error(format('select public.approve_hub_quote(%L, %L, %L, %L)', :'co', :'quote', '{}', '{}'), 'a signed-in member can''t call the Client Hub''s approval');
rollback;

-- ===== The approval that counts picks the options =============================================
set role service_role;
select t53.check(not public.approve_hub_quote(gen_random_uuid(), :'quote', array[:'lighting']::uuid[], '{"name": "Mallory"}'), 'another company''s link approves nothing');
select t53.check(public.approve_hub_quote(:'co', :'quote', array[:'lighting']::uuid[], '{"name": "Ana Smith", "ip": "203.0.113.9"}'), 'the client approves the quote');
reset role;
select t53.check((select status = 'approved' and approved_at is not null from public.quotes where id = :'quote'), 'it''s approved');
select t53.check((select not selected from public.quote_line_items where id = :'railing') and (select selected from public.quote_line_items where id = :'lighting'), 'with the options the client picked');
select t53.check((select total = 1200 from public.quotes where id = :'quote'), 'and the total those options come to');
select t53.check((select approval ->> 'name' = 'Ana Smith' and approval ->> 'ip' = '203.0.113.9' and (approval ->> 'subtotal')::numeric = 1200
                         and (approval ->> 'discount_amount')::numeric = 0 and (approval ->> 'tax_amount')::numeric = 0 and (approval ->> 'total')::numeric = 1200
                    from public.quotes where id = :'quote'), 'the approval keeps who approved it and the amounts with their options');
select t53.check((select (data ->> 'total')::numeric = 1200 from public.activity where subject_id = :'quote' and verb = 'quote.approved'), 'the activity feed shows the approved total');

-- A second approval at the same time waits for the first, then finds the quote approved.
set role service_role;
select t53.check(not public.approve_hub_quote(:'co', :'quote', array[:'railing']::uuid[], '{"name": "Second Tab"}'), 'a second approval doesn''t count');
reset role;
select t53.check((select selected from public.quote_line_items where id = :'railing') = false and (select selected from public.quote_line_items where id = :'lighting'), 'and doesn''t change the options that were approved');
select t53.check((select approval ->> 'name' = 'Ana Smith' and total = 1200 from public.quotes where id = :'quote'), 'or the approval and its total');

-- The office took the quote back while the client had it open.
update public.quotes set status = 'draft' where id = :'fence';
set role service_role;
select t53.check(not public.approve_hub_quote(:'co', :'fence', '{}', '{"name": "Ana Smith"}'), 'a quote the office took back can''t be approved');
reset role;
select t53.check((select selected from public.quote_line_items where id = :'gate'), 'and its options stay as the office left them');
select t53.check((select status = 'draft' and approval is null from public.quotes where id = :'fence'), 'and it stays a draft');

-- ===== A change order joins its job with the options picked ===================================
set role service_role;
select t53.check(public.approve_hub_quote(:'co', :'change', array[:'handrail']::uuid[], '{"name": "Ana Smith"}'), 'the client approves a change order');
reset role;
select t53.check((select status = 'converted' from public.quotes where id = :'change'), 'it''s added to its job');
select t53.check((select count(*) = 2 and sum(unit_price) = 750 from public.job_line_items where job_id = :'job' and source_quote_id = :'change'), 'with the option the client picked');
select t53.check((select contract_total = 1250 from public.job_financials where job_id = :'job'), 'and the job''s total includes it');
select t53.check(((select approval from public.quotes where id = :'change') ->> 'total')::numeric = 750, 'its approval shows the price with that option');

\echo 'All Client Hub approval tests passed.'
