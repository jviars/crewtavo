-- Database tests for contract sections and quotes that offer options (20261025000100_contracts_and_options):
-- contract sections are written by the office with the Settings area and read by estimators too;
-- packages keep a sane tier, picture, highlights and warranty; options are read and written like a
-- quote's lines, and only the shown option's lines count, whatever writes them (added, moved,
-- switched, its add-ons starting over); the option and the status never change in one go, a signed
-- quote keeps its options, a quote offers 3 at most, the package follows the shown option and a
-- price set on site goes when the option changes; the locked functions add, replace, fill in,
-- remove and copy options, put one package on an estimate, and sign on the iPad; a package's
-- contract sections are on the quote for a single estimate and on each option once it offers them;
-- lines saved the old way become add-ons without moving a total; a line written during an option
-- switch or an approval waits for it; a signed quote keeps its approval; the Client Hub approves with
-- the option picked (add-ons only from it or the shared lines, at the total the client saw, with a
-- promo code's minimum met) and says yes to a range with a favourite; deleting a quote or a business
-- takes its options along; and contract sections named anywhere are the business's own.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_options;
grant usage on schema t_options to anon, authenticated, service_role;
create function t_options.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_options.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- Like expect_error, for an error with this SQLSTATE (the server answers some of them its own way).
create function t_options.expect_state(p_sql text, p_state text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlstate <> p_state then raise exception 'FAIL (expected %, got %: %): %', p_state, sqlstate, sqlerrm, p_what; end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- Whether a session is waiting for a lock another holds (checked for up to 10 seconds).
create function t_options.waits(p_pid integer) returns boolean language plpgsql as $$
begin
  for i in 1 .. 200 loop
    if cardinality(pg_blocking_pids(p_pid)) > 0 then return true; end if;
    perform pg_sleep(0.05);
  end loop;
  return false;
end $$;
-- What a quote's lines come to when only the shared lines and the shown option's count.
create function t_options.counted(p_quote uuid) returns numeric language sql as $$
  select coalesce(sum(round(l.quantity * l.unit_price, 2)), 0)
  from public.quote_line_items l join public.quotes q on q.id = l.quote_id
  where l.quote_id = p_quote and (l.option_id is null or l.option_id = q.option_id) and (not l.optional or l.selected)
$$;
-- No line of an option that isn't shown is selected.
create function t_options.others_unselected(p_quote uuid) returns boolean language sql as $$
  select not exists (
    select 1 from public.quote_line_items l join public.quotes q on q.id = l.quote_id
    where l.quote_id = p_quote and l.option_id is not null and l.option_id is distinct from q.option_id and l.selected)
$$;
grant execute on all functions in schema t_options to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c0de0000-0000-0000-0000-000000000001', 'owner@summit.test', '{"full_name": "Sam Summit"}'),
  ('c0de0000-0000-0000-0000-000000000002', 'office@summit.test', '{"full_name": "Olive Office"}'),
  ('c0de0000-0000-0000-0000-000000000003', 'estimator@summit.test', '{"full_name": "Evan Estimator"}'),
  ('c0de0000-0000-0000-0000-000000000004', 'crew@summit.test', '{"full_name": "Cal Crew"}'),
  ('c0de0000-0000-0000-0000-000000000005', 'ops@summit.test', '{"full_name": "Oren Ops"}'),
  ('c0de0000-0000-0000-0000-000000000006', 'owner@valley.test', '{"full_name": "Vera Valley"}');

-- ===== Two businesses ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Summit Exteriors', 'roofing_exteriors') as co \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'c0de0000-0000-0000-0000-000000000002', 'office', null),
  (:'co', 'c0de0000-0000-0000-0000-000000000003', 'estimator', null),
  (:'co', 'c0de0000-0000-0000-0000-000000000004', 'field_crew', null),
  -- Office level, but the Settings area is off (the starter "Operations manager" role).
  (:'co', 'c0de0000-0000-0000-0000-000000000005', 'office', :'ops_role');
insert into public.services (company_id, name, unit, unit_price, unit_cost, formula) values (:'co', 'Architectural shingle roof', 'square', 400, 250, 'squares') returning id as shingle \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost, formula) values (:'co', 'Designer shingle roof', 'square', 550, 330, 'squares') returning id as designer \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost, formula) values (:'co', 'Standing-seam metal roof', 'square', 1000, 640, 'squares') returning id as metal \gset
insert into public.clients (company_id, display_name) values (:'co', 'Dana Homeowner') returning id as client \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select public.create_company('Valley Roofing', 'roofing_exteriors') as other \gset
insert into public.contract_sections (company_id, title) values (:'other', 'Their payment terms') returning id as other_section \gset
insert into public.roof_packages (company_id, name) values (:'other', 'Their shingles') returning id as other_pkg \gset
commit;

-- ===== Contract sections: the office writes them, estimators read them ==========================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.contract_sections (company_id, title, body) values (:'co', 'Payment', '<p>Half to start, half when it''s done.</p>') returning id as s_pay \gset
select t_options.check((select place = 'terms' and not initials and sort = 0 and created_by = 'c0de0000-0000-0000-0000-000000000001' from public.contract_sections where id = :'s_pay'),
  'a section goes on the terms pages without initials unless it says otherwise, and remembers who wrote it');
insert into public.contract_sections (company_id, title, body, sort) values (:'co', 'Warranty', '<p>{Warranty}</p>', 1) returning id as s_warranty \gset
insert into public.contract_sections (company_id, title, body, place, initials, sort)
  values (:'co', 'Your right to cancel', '<p>You may cancel within 3 business days of signing.</p>', 'signatures', true, 2) returning id as s_cancel \gset
select t_options.check((select place = 'signatures' and initials from public.contract_sections where id = :'s_cancel'), 'the owner puts the right to cancel above the signatures, to be initialed');
select t_options.expect_error(format('insert into public.contract_sections (company_id, title) values (%L, %L)', :'co', ' '), 'a section needs a title');
select t_options.expect_error(format('insert into public.contract_sections (company_id, title) values (%L, %L)', :'co', repeat('x', 121)), 'of 120 characters at most');
update public.contract_sections set title = repeat('x', 120) where id = :'s_warranty';
update public.contract_sections set title = 'Warranty' where id = :'s_warranty';
select t_options.expect_error(format('update public.contract_sections set body = %L where id = %L', repeat('x', 20001), :'s_pay'), 'its words fit in 20,000 characters');
select t_options.expect_error(format('update public.contract_sections set place = %L where id = %L', 'footer', :'s_pay'), 'it goes above the signatures or on the terms pages');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.contract_sections (company_id, title, sort) values (:'co', 'Cleanup', 3) returning id as s_cleanup \gset
update public.contract_sections set body = '<p>Half to start, the rest when it''s done.</p>' where id = :'s_pay';
select t_options.check((select body like '%the rest%' and updated_at > created_at from public.contract_sections where id = :'s_pay'), 'the office changes a section, and it notes when');
delete from public.contract_sections where id = :'s_cleanup';
select t_options.check((select count(*) = 3 from public.contract_sections), 'and deletes one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t_options.check((select count(*) = 3 from public.contract_sections), 'Operations reads the sections');
select t_options.expect_error(format('insert into public.contract_sections (company_id, title) values (%L, %L)', :'co', 'Ops terms'), 'but without Settings can''t add one');
update public.contract_sections set title = 'Ops rename' where id = :'s_pay';
delete from public.contract_sections where id = :'s_warranty';
select t_options.check((select count(*) = 3 and bool_and(title <> 'Ops rename') from public.contract_sections), 'or change or delete one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t_options.check((select count(*) = 3 from public.contract_sections), 'the estimator reads the sections, to sign with the homeowner');
select t_options.expect_error(format('insert into public.contract_sections (company_id, title) values (%L, %L)', :'co', 'My terms'), 'but can''t add one');
update public.contract_sections set body = '<p>No refunds.</p>' where id = :'s_pay';
select t_options.check((select body not like '%No refunds%' from public.contract_sections where id = :'s_pay'), 'or change one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_options.check((select count(*) = 0 from public.contract_sections), 'field crew don''t see the sections');
select t_options.expect_error(format('insert into public.contract_sections (company_id, title) values (%L, %L)', :'co', 'Crew terms'), 'or add one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t_options.check((select count(*) = 0 from public.contract_sections where company_id = :'co'), 'another business sees none of them');
select t_options.expect_error(format('insert into public.contract_sections (company_id, title) values (%L, %L)', :'co', 'Planted'), 'or adds one to this business');
update public.contract_sections set title = 'Taken over' where id = :'s_pay';
commit;
select t_options.check((select title = 'Payment' from public.contract_sections where id = :'s_pay'), 'or changes one');

begin;
set local role anon;
select t_options.expect_error('select count(*) from public.contract_sections', 'nobody without an account reads them');
select t_options.expect_error('select count(*) from public.quote_options', 'or a quote''s options');
rollback;

-- ===== Packages for every trade: tier, picture, highlights, warranty, sections ==================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select format('%s/packages/%s.jpg', :'co', gen_random_uuid()) as good_picture \gset
insert into public.roof_packages (company_id, name, style, roof_service_id, is_default, tier, picture, picture_width, picture_height, highlights, warranty, section_ids)
  values (:'co', 'Architectural shingle', 'shingle', :'shingle', true, 'Good', :'good_picture', 1600, 1200,
          array['30-year shingles', 'Ridge vent included'], '10-year workmanship warranty', array[:'s_warranty']::uuid[])
  returning id as pkg_good \gset
insert into public.roof_packages (company_id, name, style, roof_service_id, tier, sort) values (:'co', 'Designer shingle', 'designer', :'designer', 'Better', 1) returning id as pkg_better \gset
insert into public.roof_packages (company_id, name, style, roof_service_id, tier, sort) values (:'co', 'Standing-seam metal', 'metal', :'metal', 'Best', 2) returning id as pkg_best \gset
insert into public.roof_packages (company_id, name, style, sort) values (:'co', 'Seasonal special', 'other', 3) returning id as pkg_temp \gset
insert into public.roof_packages (company_id, name, style, sort) values (:'co', 'Garage special', 'other', 4) returning id as pkg_gone \gset
select t_options.check((select tier is null and picture is null and highlights = '{}' and warranty = '' and section_ids = '{}' from public.roof_packages where id = :'pkg_temp'),
  'a package starts with no tier, picture, highlights, warranty or sections');
select t_options.check((select tier = 'Good' and picture = :'good_picture' and picture_width = 1600 and cardinality(highlights) = 2 and section_ids = array[:'s_warranty']::uuid[]
                          from public.roof_packages where id = :'pkg_good'), 'the owner gives the shingle package its tier, picture, highlights, warranty and sections');
select t_options.expect_error(format('update public.roof_packages set picture = %L where id = %L', format('%s/packages/%s.jpg', :'other', gen_random_uuid()), :'pkg_good'), 'a package''s picture is in the business''s own folder');
select t_options.expect_error(format('update public.roof_packages set picture = %L where id = %L', format('%s/logo/%s.jpg', :'co', gen_random_uuid()), :'pkg_good'), 'its packages folder');
select t_options.expect_error(format('update public.roof_packages set picture = %L where id = %L', format('%s/packages/%s.png', :'co', gen_random_uuid()), :'pkg_good'), 'as a JPEG');
select t_options.expect_error(format('update public.roof_packages set picture_width = null where id = %L', :'pkg_good'), 'with its size');
select t_options.expect_error(format('update public.roof_packages set picture_width = 4001 where id = %L', :'pkg_good'), 'of 4000 pixels at most');
select t_options.expect_error(format('update public.roof_packages set picture_height = 0 where id = %L', :'pkg_good'), 'and at least one');
select t_options.expect_error(format('update public.roof_packages set picture_width = 10, picture_height = 10 where id = %L', :'pkg_temp'), 'and no size without a picture');
select t_options.expect_error(format('update public.roof_packages set highlights = %L where id = %L', array['1', '2', '3', '4', '5', '6', '7', '8', '9'], :'pkg_good'), 'up to 8 highlights');
select t_options.expect_error(format('update public.roof_packages set highlights = %L where id = %L', array[repeat('x', 601), repeat('y', 600)], :'pkg_good'), 'of 1200 characters in all');
select t_options.expect_error(format('update public.roof_packages set highlights = array[%L, null] where id = %L', 'Ridge vent', :'pkg_good'), 'with no blanks');
select t_options.expect_error(format('update public.roof_packages set warranty = %L where id = %L', repeat('x', 401), :'pkg_good'), 'a warranty in 400 characters');
select t_options.expect_error(format('update public.roof_packages set tier = %L where id = %L', ' ', :'pkg_good'), 'a tier isn''t blank');
select t_options.expect_error(format('update public.roof_packages set tier = %L where id = %L', repeat('x', 41), :'pkg_good'), 'and is 40 characters at most');
update public.roof_packages set section_ids = array[:'s_cancel', :'other_section', :'s_warranty', :'s_cancel', gen_random_uuid()]::uuid[] where id = :'pkg_better';
select t_options.check((select section_ids = array[:'s_cancel', :'s_warranty']::uuid[] from public.roof_packages where id = :'pkg_better'),
  'a package keeps only this business''s sections, once each, in order');
insert into public.promo_codes (company_id, code, kind, value) values (:'co', 'SPRING-250', 'amount', 250);
commit;

-- ===== Options by hand: only the shown option's lines count =====================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'New roof') returning id as qa \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qa', 'Tear-off', 1000);
insert into public.quote_options (company_id, quote_id, package_id, name, tier, sort) values (:'co', :'qa', :'pkg_good', 'Architectural shingle', 'Good', 0) returning id as oa1 \gset
select t_options.check((select option_id = :'oa1' and roof_package_id = :'pkg_good' from public.quotes where id = :'qa'), 'a quote''s first option is the one shown, with its package');
insert into public.quote_options (company_id, quote_id, package_id, name, tier, sort) values (:'co', :'qa', :'pkg_better', 'Designer shingle', 'Better', 1) returning id as oa2 \gset
select t_options.check((select option_id = :'oa1' from public.quotes where id = :'qa'), 'adding another doesn''t change which is shown');
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qa', :'oa1', 'Shingle roof', 5000) returning id as oa1_roof \gset
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price, optional, selected) values (:'co', :'qa', :'oa1', 'Seamless gutters', 600, true, true) returning id as oa1_gutters \gset
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price, selected) values (:'co', :'qa', :'oa2', 'Designer roof', 8000, true) returning id as oa2_roof \gset
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price, optional, selected) values (:'co', :'qa', :'oa2', 'Snow guards', 300, true, true) returning id as oa2_snow \gset
select t_options.check((select bool_and(not selected) from public.quote_line_items where id in (:'oa2_roof', :'oa2_snow')),
  'lines of an option that isn''t shown never count, even sent as selected');
select t_options.check((select bool_and(selected) from public.quote_line_items where id in (:'oa1_roof', :'oa1_gutters')), 'the shown option''s lines count, with the add-on picked');
select t_options.check((select subtotal = 6600 and total = 6600 and subtotal = t_options.counted(:'qa') from public.quotes where id = :'qa'),
  'the quote comes to the shown option: $1,000 shared, $5,000 and the $600 add-on');
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price, selected) values (:'co', :'qa', :'oa1', 'Ridge vent', 400, false) returning id as ridge \gset
select t_options.check((select selected from public.quote_line_items where id = :'ridge') and (select subtotal = 7000 from public.quotes where id = :'qa'),
  'a required line added to the shown option counts, even sent as unselected');
update public.quote_line_items set option_id = :'oa2' where id = :'ridge';
select t_options.check((select not selected from public.quote_line_items where id = :'ridge') and (select subtotal = 6600 from public.quotes where id = :'qa'),
  'moved onto an option that isn''t shown, it stops counting');
update public.quote_line_items set option_id = null where id = :'ridge';
select t_options.check((select selected from public.quote_line_items where id = :'ridge') and (select subtotal = 7000 from public.quotes where id = :'qa'),
  'moved onto every option, it counts again');
update public.quote_line_items set selected = true where id = :'oa2_snow';
select t_options.check((select not selected from public.quote_line_items where id = :'oa2_snow'), 'an add-on of an option that isn''t shown can''t be picked');

-- Showing the other option.
update public.quotes set option_id = :'oa2' where id = :'qa';
select t_options.check((select not selected from public.quote_line_items where id = :'oa1_roof') and (select not selected from public.quote_line_items where id = :'oa1_gutters')
                   and (select selected from public.quote_line_items where id = :'oa2_roof') and (select not selected from public.quote_line_items where id = :'oa2_snow'),
  'showing the Better option: its required lines count, its add-ons start unpicked, and the Good option''s lines stop counting');
select t_options.check((select subtotal = 9400 and subtotal = t_options.counted(:'qa') and roof_package_id = :'pkg_better' from public.quotes where id = :'qa') and t_options.others_unselected(:'qa'),
  'the quote comes to the Better option ($1,000 and $400 shared, $8,000), with its package');
update public.quote_line_items set selected = true where id = :'oa2_snow';
update public.quotes set option_id = :'oa1' where id = :'qa';
select t_options.check((select not selected from public.quote_line_items where id = :'oa1_gutters') and (select not selected from public.quote_line_items where id = :'oa2_snow')
                   and (select subtotal = 6400 and roof_package_id = :'pkg_good' from public.quotes where id = :'qa'),
  'showing Good again starts its add-on over, unpicked, and lets go of Better''s');
update public.quote_line_items set optional = false where id = :'oa1_gutters';
select t_options.check((select selected from public.quote_line_items where id = :'oa1_gutters') and (select subtotal = 7000 from public.quotes where id = :'qa'),
  'an add-on made required counts, though it wasn''t picked');
update public.quote_line_items set optional = true, selected = false where id = :'oa1_gutters';
update public.quote_options set package_id = :'pkg_best' where id = :'oa1';
select t_options.check((select roof_package_id = :'pkg_best' from public.quotes where id = :'qa'), 'pointing the shown option at another package points the quote at it too');
update public.quote_options set package_id = :'pkg_good' where id = :'oa2';
select t_options.check((select roof_package_id = :'pkg_best' from public.quotes where id = :'qa'), 'pointing another option at one doesn''t');
update public.quote_options set package_id = :'pkg_good' where id = :'oa1';
update public.quote_options set package_id = :'pkg_better' where id = :'oa2';
select t_options.check((select roof_package_id = :'pkg_good' and subtotal = 6400 from public.quotes where id = :'qa'), 'and back as they were');

-- One change at a time, and always one option shown.
select t_options.expect_error(format('update public.quotes set option_id = %L, status = %L where id = %L', :'oa2', 'sent', :'qa'), 'the option and the status don''t change in the same go');
select t_options.check((select option_id = :'oa1' and status = 'draft' from public.quotes where id = :'qa'), 'so neither changed');
select t_options.expect_error(format('update public.quotes set option_id = null where id = %L', :'qa'), 'a quote with options always shows one of them');
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Garage roof') returning id as qb \gset
insert into public.quote_options (company_id, quote_id, package_id, name, sort) values (:'co', :'qb', :'pkg_gone', 'Garage special', 0) returning id as ob1 \gset
select t_options.expect_error(format('update public.quotes set option_id = %L where id = %L', :'ob1', :'qa'), 'a quote can''t show another quote''s option');
select t_options.expect_error(format('insert into public.quote_line_items (company_id, quote_id, option_id, name) values (%L, %L, %L, %L)', :'co', :'qa', :'ob1', 'Stray'), 'or have lines on it');
select t_options.expect_error(format('update public.quote_options set quote_id = %L where id = %L', :'qb', :'oa2'), 'an option stays on the quote it was made for');
select t_options.check((select count(*) = 1 from public.quote_options where quote_id = :'qb') and (select option_id = :'ob1' from public.quotes where id = :'qb'),
  'so the other quote still shows its own');
commit;

-- ===== A price set on site belongs to its option =================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qa', :'oa1', 'Price adjustment', 250) returning id as adjustment \gset
update public.quotes set priced_on_site_at = now() where id = :'qa';
select t_options.check((select subtotal = 6650 and priced_on_site_at is not null from public.quotes where id = :'qa'), 'the estimator sets the Good option''s price on site');
update public.quotes set option_id = :'oa2' where id = :'qa';
select t_options.check((select priced_on_site_at is null and subtotal = 9400 from public.quotes where id = :'qa')
                   and not exists (select 1 from public.quote_line_items where id = :'adjustment'),
  'showing another option lets go of the price set on site, and its adjustment');
update public.quotes set option_id = :'oa1' where id = :'qa';
update public.quotes set priced_on_site_at = now() where id = :'qa';
update public.quotes set title = 'New roof and gutters' where id = :'qa';
select t_options.check((select priced_on_site_at is not null from public.quotes where id = :'qa'), 'other changes to the quote keep it');
update public.quotes set priced_on_site_at = null where id = :'qa';
commit;

-- Priced on site before there were options: the price stays with the estimate it was set on.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'client', 'Site-priced roof', 0.05) returning id as qs \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qs', 'Shingle roof', 10000);
-- As setSitePrice writes $9,000 on a single estimate: a $1,000 discount.
update public.quotes set discount_amount = 1000, priced_on_site_at = now() where id = :'qs';
select t_options.check((select total = 9450 from public.quotes where id = :'qs'), 'the estimator prices a $10,000 shingle roof at $9,000 on site ($9,450 with tax)');
select public.apply_quote_options(:'qs', jsonb_build_array(
  jsonb_build_object('name', 'Standing-seam metal', 'tier', 'Best', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Metal roof', 'unit_price', 20000)))),
  'add', '{}', '{"name": "Architectural shingle", "tier": "Good", "sort": 0}');
select id as os1 from public.quote_options where quote_id = :'qs' and name = 'Architectural shingle' \gset
select id as os2 from public.quote_options where quote_id = :'qs' and name = 'Standing-seam metal' \gset
select t_options.check((select tier = 'Good' and sort = 0 from public.quote_options where id = :'os1') and (select tier = 'Best' and sort = 1 from public.quote_options where id = :'os2'),
  'adding metal makes the estimate the Good option, named, tiered and placed as the server says');
select t_options.check((select option_id = :'os1' and total = 9450 and discount_amount = 0 and priced_on_site_at is not null from public.quotes where id = :'qs')
                   and (select count(*) = 1 and bool_and(option_id = :'os1' and unit_price = -1000 and selected) from public.quote_line_items where quote_id = :'qs' and name = 'Price adjustment'),
  'its price set on site stays on it, as a price adjustment instead of a discount off every option');
update public.quotes set option_id = :'os2' where id = :'qs';
select t_options.check((select subtotal = 20000 and total = 21000 and discount_amount = 0 and priced_on_site_at is null from public.quotes where id = :'qs')
                   and not exists (select 1 from public.quote_line_items where quote_id = :'qs' and name = 'Price adjustment'),
  'so showing metal comes to metal''s own $20,000, and lets go of the shingle price');
update public.quotes set option_id = :'os1' where id = :'qs';
select t_options.check((select total = 10500 and total = t_options.counted(:'qs') * 1.05 from public.quotes where id = :'qs'), 'and the shingle option is its estimate again');

-- Above the estimate, the price is a line of its own; it goes onto option 1 even when it's sent as shared.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Priced up roof') returning id as qt \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qt', 'Shingle roof', 10000);
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qt', 'Price adjustment', 500) returning id as qt_adjustment \gset
update public.quotes set priced_on_site_at = now() where id = :'qt';
select public.apply_quote_options(:'qt', jsonb_build_array(jsonb_build_object('name', 'Metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Metal roof', 'unit_price', 20000)))),
  'add', array[:'qt_adjustment']::uuid[]);
select t_options.check((select o.sort = 0 and o.name = 'Option 1' and o.tier is null and l.selected from public.quote_line_items l join public.quote_options o on o.id = l.option_id where l.id = :'qt_adjustment')
                   and (select total = 10500 and priced_on_site_at is not null from public.quotes where id = :'qt'),
  'a price set above the estimate stays on it as option 1, at $10,500');

-- An option made by hand does the same.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Hand-made options') returning id as qv \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qv', 'Shingle roof', 8000);
update public.quotes set discount_amount = 500, priced_on_site_at = now() where id = :'qv';
insert into public.quote_options (company_id, quote_id, name) values (:'co', :'qv', 'Shingles') returning id as ov1 \gset
select t_options.check((select option_id = :'ov1' and total = 7500 and discount_amount = 0 from public.quotes where id = :'qv')
                   and (select bool_and(option_id = :'ov1' and unit_price = -500) from public.quote_line_items where quote_id = :'qv' and name = 'Price adjustment'),
  'and so does a first option made by hand');

-- A discount comes off taxed and untaxed work in proportion, and so does the adjustment it becomes.
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'client', 'Roof and permit', 0.08) returning id as qx \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qx', 'Shingle roof', 10000);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, taxable) values (:'co', :'qx', 'Permit', 500, false);
update public.quotes set discount_amount = 1000, priced_on_site_at = now() where id = :'qx';
select t_options.check((select total = 10223.81 from public.quotes where id = :'qx'),
  'a $10,000 taxed roof and a $500 untaxed permit, priced at $9,500 on site, come to $10,223.81 with 8% tax');
select public.apply_quote_options(:'qx', jsonb_build_array(jsonb_build_object('name', 'Metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Metal roof', 'unit_price', 20000)))), 'add');
select t_options.check((select total = 10223.81 and discount_amount = 0 and option_id is not null from public.quotes where id = :'qx')
                   and (select count(*) = 2 and sum(unit_price) filter (where taxable) = -952.38 and sum(unit_price) filter (where not taxable) = -47.62
                               and bool_and(selected and option_id = (select option_id from public.quotes where id = :'qx'))
                          from public.quote_line_items where quote_id = :'qx' and name = 'Price adjustment'),
  'made option 1, its $1,000 off is a taxed and an untaxed price adjustment on it, so the price agreed on site doesn''t move');
commit;

-- ===== Lines the client picks one of, and add-ons made required ==================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Roof choices') returning id as qq \gset
-- As the assistant writes Good, Better and Best: a group of add-ons with the first one picked.
insert into public.quote_line_items (company_id, quote_id, name, unit_price, optional, selected, option_group, sort) values
  (:'co', :'qq', 'Good roof', 5000, true, true, 'Roof', 1),
  (:'co', :'qq', 'Better roof', 8000, true, false, 'Roof', 2),
  (:'co', :'qq', 'Best roof', 12000, true, false, 'Roof', 3);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, optional, selected, sort) values (:'co', :'qq', 'Gutters', 600, true, false, 4) returning id as qq_gutters \gset
select t_options.check((select total = 5000 from public.quotes where id = :'qq'), 'a group the client picks one of comes to the one picked, the Good roof''s $5,000');
insert into public.quote_line_items (company_id, quote_id, name, unit_price, selected, sort) values (:'co', :'qq', 'Tear-off', 1000, false, 5) returning id as qq_tear \gset
select t_options.check((select total = 6000 from public.quotes where id = :'qq'), 'a required line counts even when it''s sent unselected, as every screen shows it');
update public.quote_line_items set selected = false where id = :'qq_tear';
select t_options.check((select selected from public.quote_line_items where id = :'qq_tear') and (select total = 6000 from public.quotes where id = :'qq'),
  'or unselected later');
update public.quote_line_items set optional = false where id = :'qq_gutters';
select t_options.check((select selected from public.quote_line_items where id = :'qq_gutters') and (select total = 6600 from public.quotes where id = :'qq'),
  'and so does an add-on made required, though it wasn''t picked');
select public.apply_quote_options(:'qq', jsonb_build_array(jsonb_build_object('name', 'Metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Metal roof', 'unit_price', 15000)))), 'add');
select t_options.check((select total = 6600 from public.quotes where id = :'qq')
                   and (select array_agg(name order by sort) = array['Good roof', 'Gutters', 'Tear-off'] from public.quote_line_items where quote_id = :'qq' and selected),
  'turned into option 1, the estimate keeps the roof that was picked, and its price');
commit;

-- ===== Lines saved the old way ===================================================================
-- Before this, the assistant wrote Good, Better and Best as required lines with only the first one
-- selected (or made only some of them add-ons), and a required line could be left unselected. Every
-- screen counts a required line, so the Client Hub showed and sent all of them, and approving was
-- turned down every time. The migration makes them add-ons; here its statement runs again, on
-- lines saved that way.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Old roof choices') returning id as ql \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, option_group, sort) values (:'co', :'ql', 'Good roof', 5000, 'Roof', 1) returning id as ql_good \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, option_group, sort) values (:'co', :'ql', 'Better roof', 8000, 'Roof', 2) returning id as ql_better \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, option_group, sort) values (:'co', :'ql', 'Best roof', 12000, 'Roof', 3) returning id as ql_best \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, sort) values (:'co', :'ql', 'Tear-off', 1000, 4);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, sort) values (:'co', :'ql', 'Haul-away', 300, 5) returning id as ql_haul \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Old mixed choices') returning id as qlm \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, option_group, sort) values (:'co', :'qlm', 'Good roof', 5000, 'Roof', 1);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, optional, selected, option_group, sort) values
  (:'co', :'qlm', 'Better roof', 8000, true, false, 'Roof', 2), (:'co', :'qlm', 'Best roof', 12000, true, false, 'Roof', 3);
commit;
alter table public.quote_line_items disable trigger option_line;
update public.quote_line_items set selected = false where id in (:'ql_better', :'ql_best', :'ql_haul');
alter table public.quote_line_items enable trigger option_line;
select t_options.check((select total = 6000 from public.quotes where id = :'ql') and (select total = 5000 from public.quotes where id = :'qlm'),
  'quotes saved the old way come to their selected lines: $6,000 with the Good roof and the tear-off, and $5,000');
select updated_at as ql_updated from public.quotes where id = :'ql' \gset

-- The migration's statement, for these two quotes (it ran before there were options; the lines of
-- an option that isn't shown, here, are required and unselected the new way).
alter table public.quote_line_items disable trigger touch_quote;
update public.quote_line_items set optional = true where not optional and (option_group is not null or not selected)
   and quote_id in (:'ql', :'qlm');
alter table public.quote_line_items enable trigger touch_quote;
select t_options.check((select total = 6000 and updated_at = :'ql_updated' from public.quotes where id = :'ql') and (select total = 5000 from public.quotes where id = :'qlm'),
  'making them add-ons moves no total, and doesn''t work one out again');
select t_options.check((select array_agg(name || ': ' || case when not optional then 'included' when selected then 'picked' else 'not picked' end order by sort)
                          from public.quote_line_items where quote_id = :'ql')
                       = array['Good roof: picked', 'Better roof: not picked', 'Best roof: not picked', 'Tear-off: included', 'Haul-away: not picked'],
  'the roofs are add-ons the client picks one of, with the Good one picked, and the haul-away an add-on left unpicked');
select t_options.check((select array_agg(name || ': ' || case when not optional then 'included' when selected then 'picked' else 'not picked' end order by sort)
                          from public.quote_line_items where quote_id = :'qlm')
                       = array['Good roof: picked', 'Better roof: not picked', 'Best roof: not picked'],
  'a group with only some add-ons is a group of add-ons too, so the Good roof can be chosen alone');
select t_options.check(t_options.counted(:'ql') = 6000 and t_options.counted(:'qlm') = 5000, 'and what every screen counts is the quote''s total');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.quotes set status = 'sent', sent_at = now() where id = :'ql';
select public.apply_quote_options(:'qlm', jsonb_build_array(jsonb_build_object('name', 'Metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Metal roof', 'unit_price', 15000)))), 'add');
select t_options.check((select total = 5000 and total = t_options.counted(:'qlm') from public.quotes where id = :'qlm')
                   and (select array_agg(name order by sort) = array['Good roof'] from public.quote_line_items where quote_id = :'qlm' and selected),
  'offering another package keeps option 1 at $5,000, with the Good roof picked');
commit;
set role service_role;
select t_options.check(public.approve_hub_quote(:'co', :'ql', array[:'ql_good']::uuid[], '{"name": "Dana Homeowner"}', null, 6000),
  'the client approves the old quote online with the Good roof, at the $6,000 the Client Hub shows');
reset role;
select t_options.check((select status = 'approved' and total = 6000 and (approval ->> 'total')::numeric = 6000 from public.quotes where id = :'ql'), 'and it''s approved at that price');

-- ===== 3 options at most, and a signed quote keeps its options ===================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quote_options (company_id, quote_id, package_id, name, sort) values (:'co', :'qa', :'pkg_temp', 'Seasonal special', 2) returning id as oa3 \gset
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qa', :'oa3', 'Seasonal roof', 4500);
select t_options.expect_error(format('insert into public.quote_options (company_id, quote_id, name) values (%L, %L, %L)', :'co', :'qa', 'A fourth'), 'a quote offers up to 3 options');
update public.quotes set status = 'approved', approved_at = now(), approval = '{"name": "Dana Homeowner", "method": "manual"}' where id = :'qa';
select t_options.expect_error(format('update public.quote_options set name = %L where id = %L', 'Renamed', :'oa1'), 'once it''s approved, its options don''t change');
select t_options.expect_error(format('delete from public.quote_options where id = %L', :'oa2'), 'or go');
select t_options.expect_error(format('update public.quotes set option_id = %L where id = %L', :'oa2', :'qa'), 'and the option chosen stays');
delete from public.roof_packages where id = :'pkg_temp';
select t_options.check((select package_id is null and name = 'Seasonal special' from public.quote_options where id = :'oa3'),
  'deleting a package still lets go of it on a signed quote''s option, which keeps its name');
commit;
set role service_role;
update public.quotes set option_id = :'oa2' where id = :'qa';
reset role;
select t_options.check((select option_id = :'oa2' and subtotal = 9400 and roof_package_id = :'pkg_better' from public.quotes where id = :'qa'), 'the server can still change it');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Carport roof') returning id as qm \gset
select public.apply_quote_options(:'qm', jsonb_build_array(
  jsonb_build_object('name', 'Architectural shingle', 'sort', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Carport shingles', 'unit_price', 1500))),
  jsonb_build_object('name', 'Standing-seam metal', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Carport metal', 'unit_price', 3500)))), 'replace');
select id as om1 from public.quote_options where quote_id = :'qm' and sort = 0 \gset
select id as om2 from public.quote_options where quote_id = :'qm' and sort = 1 \gset
update public.quotes set option_id = :'om2' where id = :'qm';
select t_options.expect_error(format('select public.convert_quote_to_job(%L)', :'qm'), 'Mark it approved with the option they chose first');
update public.quotes set status = 'approved', approved_at = now(), approval = '{"name": "Dana Homeowner", "method": "manual"}' where id = :'qm';
select public.convert_quote_to_job(:'qm') as qm_job \gset
select t_options.check((select status = 'converted' from public.quotes where id = :'qm')
                   and (select array_agg(name || ' ' || unit_price) = array['Carport metal 3500.00'] from public.job_line_items where job_id = :'qm_job'),
  'the office picks the metal option, then approves it and makes the job, which has only metal''s lines');
select t_options.expect_error(format('update public.quote_options set name = %L where id = %L', 'Renamed', :'om1'), 'a quote that''s a job keeps its options');
select t_options.expect_error(format('delete from public.quote_options where id = %L', :'om2'), 'every one of them');
select t_options.expect_error(format('update public.quotes set option_id = %L where id = %L', :'om1', :'qm'), 'and the option chosen');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- The garage: its package goes, then it's lost, then the shown option is deleted.
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qb', :'ob1', 'Garage roof', 3000);
insert into public.quote_options (company_id, quote_id, package_id, name, sort) values (:'co', :'qb', :'pkg_best', 'Metal garage roof', 1) returning id as ob2 \gset
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qb', :'ob2', 'Metal garage roof', 6000);
select t_options.check((select roof_package_id = :'pkg_gone' from public.quotes where id = :'qb'), 'the garage shows its special');
delete from public.roof_packages where id = :'pkg_gone';
select t_options.check((select roof_package_id is null from public.quotes where id = :'qb') and (select package_id is null from public.quote_options where id = :'ob1'),
  'when the shown option''s package is deleted, the quote has no package either');
update public.quotes set status = 'lost' where id = :'qb';
select t_options.expect_error(format('update public.quotes set option_id = %L where id = %L', :'ob2', :'qb'), 'a lost quote''s option stays as it was');
select t_options.expect_error(format('delete from public.quote_options where id = %L', :'ob1'), 'even when the one shown would be deleted');
select t_options.expect_error(format('update public.quote_options set name = %L where id = %L', 'Renamed', :'ob2'), 'and so do its options');
update public.quotes set status = 'archived' where id = :'qb';
select t_options.expect_error(format('update public.quotes set option_id = %L where id = %L', :'ob2', :'qb'), 'an archived quote''s option stays as it was too');
select t_options.expect_error(format('delete from public.quote_options where id = %L', :'ob2'), 'and its options');
select t_options.check((select option_id = :'ob1' and subtotal = 3000 from public.quotes where id = :'qb') and (select count(*) = 2 from public.quote_options where quote_id = :'qb'),
  'so it still shows the special at its price');
update public.quotes set status = 'draft' where id = :'qb';
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qb', :'ob1', 'Price adjustment', -200);
update public.quotes set priced_on_site_at = now() where id = :'qb';
delete from public.quote_options where id = :'ob1';
select t_options.check((select option_id = :'ob2' and roof_package_id = :'pkg_best' and subtotal = 6000 and priced_on_site_at is null from public.quotes where id = :'qb'),
  'deleting the shown option shows the next one, with its lines, its package and no price set on site');
commit;

-- ===== Who reads and writes a quote's options ====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.quote_options (company_id, quote_id, name, sort) values (:'co', :'qb', 'Shingle garage roof', 2) returning id as ob3 \gset
update public.quote_options set tier = 'Good' where id = :'ob3';
select t_options.check((select count(*) = 2 from public.quote_options where quote_id = :'qb') and (select tier = 'Good' from public.quote_options where id = :'ob3'),
  'the estimator adds an option and names its tier');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.quote_options set highlights = array['Matches the house'] where id = :'ob3';
select t_options.check((select highlights = array['Matches the house'] from public.quote_options where id = :'ob3'), 'the office gives it a highlight');
delete from public.quote_options where id = :'ob3';
select t_options.check((select count(*) = 1 from public.quote_options where quote_id = :'qb'), 'and takes it off');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_options.check((select count(*) = 0 from public.quote_options), 'field crew don''t see options or their prices');
select t_options.expect_error(format('insert into public.quote_options (company_id, quote_id, name) values (%L, %L, %L)', :'co', :'qb', 'Crew option'), 'or add one');
update public.quote_options set name = 'Crew rename' where id = :'ob2';
delete from public.quote_options where id = :'ob2';
commit;
select t_options.check((select name = 'Metal garage roof' from public.quote_options where id = :'ob2'), 'or change or delete one');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t_options.check((select count(*) = 0 from public.quote_options where company_id = :'co'), 'another business sees none of them');
select t_options.expect_error(format('insert into public.quote_options (company_id, quote_id, name) values (%L, %L, %L)', :'co', :'qb', 'Planted'), 'or adds one to this business''s quote');
select t_options.expect_error(format('insert into public.quote_options (company_id, quote_id, name) values (%L, %L, %L)', :'other', :'qb', 'Borrowed'), 'or to it from their own');
update public.quote_options set name = 'Taken over' where id = :'ob2';
commit;
select t_options.check((select name = 'Metal garage roof' from public.quote_options where id = :'ob2'), 'or changes one');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t_options.expect_error(format('insert into public.quote_options (company_id, quote_id, package_id, name) values (%L, %L, %L, %L)', :'co', :'qb', :'other_pkg', 'Borrowed'),
  'an option can''t come from another business''s package');
select t_options.expect_error(format('insert into public.quote_options (company_id, quote_id, name, picture, picture_width, picture_height) values (%L, %L, %L, %L, 10, 10)',
  :'co', :'qb', 'Their picture', format('%s/packages/%s.jpg', :'other', gen_random_uuid())), 'or show a picture from another business''s folder');
select t_options.expect_error(format('insert into public.quote_options (company_id, quote_id, name, style) values (%L, %L, %L, %L)', :'co', :'qb', 'Slate', 'slate'), 'its drawing is one of the styles');
select t_options.expect_error(format('insert into public.quote_options (company_id, quote_id, name) values (%L, %L, %L)', :'co', :'qb', ' '), 'and it has a name');
rollback;

-- ===== apply_quote_options: an estimate becomes option 1, and more are added =====================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, roof_package_id) values (:'co', :'client', 'Dana''s roof', :'pkg_good') returning id as qc \gset
insert into public.quote_line_items (company_id, quote_id, service_id, name, quantity, unit, unit_price, formula, sort)
  values (:'co', :'qc', :'shingle', 'Architectural shingle roof', 20, 'square', 400, 'squares', 0) returning id as qc_roof \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, optional, selected, sort) values (:'co', :'qc', 'Seamless gutters', 600, true, true, 1) returning id as qc_gutters \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price, sort) values (:'co', :'qc', 'Dumpster', 450, 2) returning id as qc_dumpster \gset
select t_options.check((select total = 9050 from public.quotes where id = :'qc'), 'Dana''s estimate from the shingle package comes to $9,050');
select public.apply_quote_options(:'qc', jsonb_build_array(
  jsonb_build_object('package_id', :'pkg_better', 'name', 'Designer shingle', 'tier', 'Better', 'style', 'designer', 'sort', 1,
    'highlights', jsonb_build_array('Lifetime shingles', 'Algae resistant'), 'warranty', '50-year shingle warranty',
    'section_ids', jsonb_build_array(:'s_cancel', :'other_section'),
    'lines', jsonb_build_array(jsonb_build_object('service_id', :'designer', 'name', 'Designer shingle roof', 'quantity', 20, 'unit', 'square',
      'unit_price', 550, 'unit_cost', 330, 'taxable', true, 'formula', 'squares', 'sort', 0))),
  jsonb_build_object('package_id', :'pkg_best', 'name', 'Standing-seam metal', 'tier', 'Best', 'style', 'metal', 'sort', 2,
    'lines', jsonb_build_array(
      jsonb_build_object('service_id', :'metal', 'name', 'Standing-seam metal roof', 'quantity', 20, 'unit', 'square', 'unit_price', 1000, 'formula', 'squares'),
      jsonb_build_object('name', 'Snow guards', 'unit_price', 300, 'optional', true)))
), 'add', array[:'qc_dumpster']::uuid[]) as added \gset
select id as oc1 from public.quote_options where quote_id = :'qc' and package_id = :'pkg_good' \gset
select id as oc2 from public.quote_options where quote_id = :'qc' and package_id = :'pkg_better' \gset
select id as oc3 from public.quote_options where quote_id = :'qc' and package_id = :'pkg_best' \gset
select t_options.check(jsonb_array_length(:'added'::jsonb) = 3
                   and (select array_agg(o ->> 'name' order by n) from jsonb_array_elements(:'added'::jsonb) with ordinality x(o, n)) = array['Architectural shingle', 'Designer shingle', 'Standing-seam metal'],
  'adding two packages to an estimate makes three options, the estimate as it was first');
select t_options.check((select name = 'Architectural shingle' and tier = 'Good' and style = 'shingle' and picture = :'good_picture' and picture_width = 1600 and picture_height = 1200
                               and highlights = array['30-year shingles', 'Ridge vent included'] and warranty = '10-year workmanship warranty' and section_ids = array[:'s_warranty']::uuid[]
                          from public.quote_options where id = :'oc1'), 'option 1 is a copy of the estimate''s package');
select t_options.check((select option_id = :'oc1' and total = 9050 and roof_package_id = :'pkg_good' from public.quotes where id = :'qc'), 'it''s the one shown, and the price hasn''t moved');
select t_options.check((select option_id = :'oc1' and selected from public.quote_line_items where id = :'qc_roof') and (select option_id = :'oc1' and selected from public.quote_line_items where id = :'qc_gutters')
                   and (select option_id is null and selected from public.quote_line_items where id = :'qc_dumpster'),
  'its lines are on it, with the add-on still picked, and the dumpster stays on every option');
select t_options.check((select tier = 'Better' and style = 'designer' and highlights = array['Lifetime shingles', 'Algae resistant'] and warranty = '50-year shingle warranty'
                               and section_ids = array[:'s_cancel']::uuid[] from public.quote_options where id = :'oc2'),
  'the Better option has what the server sent, and only this business''s sections');
select t_options.check((select count(*) = 1 and bool_and(not selected and quantity = 20 and unit_cost = 330 and formula = 'squares') from public.quote_line_items where option_id = :'oc2')
                   and (select count(*) = 2 and bool_and(not selected) from public.quote_line_items where option_id = :'oc3'),
  'the new options'' lines are there, not counting');
select t_options.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'qc', jsonb_build_array(jsonb_build_object('name', 'Fourth')), 'add'), 'and a fourth is one too many');
select t_options.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'qc', '[]', 'sideways'), 'options are added, replaced or filled in');
select t_options.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'qc', '{"name": "One"}', 'add'), 'from a list');
select t_options.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'qc', '[]', 'add'), 'of at least one');
select t_options.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'qa', jsonb_build_array(jsonb_build_object('name', 'Late')), 'add'), 'a signed quote''s options don''t change');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_options.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'qc', '[]', 'fill'), 'field crew can''t change a quote''s options');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t_options.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'qc', '[]', 'fill'), 'nor can another business');
rollback;

-- ===== Options made before measuring, filled in after; starting over ============================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Cottage roof') returning id as qd \gset
select public.apply_quote_options(:'qd', jsonb_build_array(
  jsonb_build_object('package_id', :'pkg_good', 'name', 'Architectural shingle', 'tier', 'Good'),
  jsonb_build_object('package_id', :'pkg_best', 'name', 'Standing-seam metal', 'tier', 'Best')), 'replace') as made \gset
select (:'made'::jsonb) -> 0 ->> 'id' as od1, (:'made'::jsonb) -> 1 ->> 'id' as od2 \gset
select t_options.check((select count(*) = 2 from public.quote_options where quote_id = :'qd') and not exists (select 1 from public.quote_line_items where quote_id = :'qd')
                   and (select option_id = :'od1' and roof_package_id = :'pkg_good' from public.quotes where id = :'qd'),
  'two options can be made before the roof is measured, with no lines yet');
select public.apply_quote_options(:'qd', jsonb_build_array(
  jsonb_build_object('id', :'od1', 'lines', jsonb_build_array(jsonb_build_object('service_id', :'shingle', 'name', 'Architectural shingle roof', 'quantity', 15, 'unit', 'square', 'unit_price', 400))),
  jsonb_build_object('id', :'od2', 'lines', jsonb_build_array(jsonb_build_object('service_id', :'metal', 'name', 'Standing-seam metal roof', 'quantity', 15, 'unit', 'square', 'unit_price', 1000))),
  jsonb_build_object('id', :'od1', 'lines', jsonb_build_array(jsonb_build_object('name', 'Architectural shingle roof', 'quantity', 15, 'unit', 'square', 'unit_price', 400))),
  jsonb_build_object('id', :'oc2', 'lines', jsonb_build_array(jsonb_build_object('name', 'Stray', 'unit_price', 1)))), 'fill');
select t_options.check((select count(*) = 1 from public.quote_line_items where option_id = :'od1') and (select count(*) = 1 from public.quote_line_items where option_id = :'od2')
                   and (select total = 6000 from public.quotes where id = :'qd'),
  'once it''s measured, each option gets its lines, once even when it''s sent twice, and the quote comes to the shown one');
select t_options.check((select count(*) = 1 from public.quote_line_items where option_id = :'oc2'), 'filling in leaves another quote''s options alone');
select public.apply_quote_options(:'qd', jsonb_build_array(
  jsonb_build_object('id', :'od1', 'lines', jsonb_build_array(jsonb_build_object('name', 'Twice', 'unit_price', 1)))), 'fill');
select t_options.check((select count(*) = 2 from public.quote_line_items where quote_id = :'qd'), 'and an option that has its lines isn''t filled in twice');

update public.quotes set discount_amount = 100, priced_on_site_at = now(), exact_sent_at = now() where id = :'qd';
select t_options.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'qd', jsonb_build_array(
  jsonb_build_object('name', 'One'), jsonb_build_object('name', 'Two'), jsonb_build_object('name', 'Three'), jsonb_build_object('name', 'Four')), 'replace'),
  'starting over offers 3 options at most');
select t_options.check((select count(*) = 2 from public.quote_options where quote_id = :'qd') and (select discount_amount = 100 from public.quotes where id = :'qd'), 'and changes nothing when it can''t');
select public.apply_quote_options(:'qd', jsonb_build_array(
  jsonb_build_object('package_id', :'pkg_better', 'name', 'Designer shingle', 'tier', 'Better',
    'lines', jsonb_build_array(jsonb_build_object('service_id', :'designer', 'name', 'Designer shingle roof', 'quantity', 15, 'unit', 'square', 'unit_price', 550)))), 'replace') as restarted \gset
select t_options.check((select count(*) = 1 and bool_and(name = 'Designer shingle') from public.quote_options where quote_id = :'qd')
                   and (select count(*) = 1 from public.quote_line_items where quote_id = :'qd')
                   and (select option_id = ((:'restarted'::jsonb) -> 0 ->> 'id')::uuid and roof_package_id = :'pkg_better' and total = 8250
                               and discount_amount = 0 and priced_on_site_at is null and exact_sent_at is null from public.quotes where id = :'qd'),
  'starting over replaces every option and line, and the price set on site, the exact price sent and the discount');
select public.apply_promo_code('quote', :'qd', 'SPRING-250');
update public.quotes set priced_on_site_at = now(), exact_sent_at = now() where id = :'qd';
select public.apply_quote_options(:'qd', jsonb_build_array(
  jsonb_build_object('package_id', :'pkg_good', 'name', 'Architectural shingle', 'tier', 'Good',
    'lines', jsonb_build_array(jsonb_build_object('service_id', :'shingle', 'name', 'Architectural shingle roof', 'quantity', 15, 'unit', 'square', 'unit_price', 400)))), 'replace');
select t_options.check((select promo_code_id is not null and discount_amount = 250 and total = 5750 and priced_on_site_at is null and exact_sent_at is null from public.quotes where id = :'qd'),
  'a promo code keeps its own discount when it starts over');
commit;

-- ===== remove_quote_option: down to one option is back to a single estimate =====================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.remove_quote_option(:'qc', :'oc1') as left_two \gset
select t_options.check(jsonb_array_length(:'left_two'::jsonb) = 2 and not exists (select 1 from public.quote_line_items where id in (:'qc_roof', :'qc_gutters')),
  'taking off the shown option takes its lines with it');
select t_options.check((select option_id = :'oc2' and roof_package_id = :'pkg_better' and total = 11450 and total = t_options.counted(:'qc') from public.quotes where id = :'qc'),
  'and shows the next one: $11,000 and the $450 dumpster');
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qc', :'oc2', 'Price adjustment', -500);
update public.quotes set priced_on_site_at = now() where id = :'qc';
select public.remove_quote_option(:'qc', :'oc3') as left_none \gset
select t_options.check(:'left_none'::jsonb = '[]'::jsonb and not exists (select 1 from public.quote_options where quote_id = :'qc'), 'taking off another leaves a single estimate');
select t_options.check((select option_id is null and roof_package_id = :'pkg_better' and total = 10950 and priced_on_site_at is not null from public.quotes where id = :'qc')
                   and (select count(*) = 3 and bool_and(option_id is null and selected) from public.quote_line_items where quote_id = :'qc'),
  'with the Better option''s lines on it as they were, the price set on site included');
select t_options.check(public.remove_quote_option(:'qc', :'oc3') = '[]'::jsonb and (select total = 10950 from public.quotes where id = :'qc'), 'taking off one that''s gone changes nothing');
select t_options.expect_error(format('select public.remove_quote_option(%L, %L)', :'qa', :'oa1'), 'a signed quote keeps its options');

insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'One option') returning id as qr \gset
select (public.apply_quote_options(:'qr', jsonb_build_array(jsonb_build_object('name', 'Only', 'lines', jsonb_build_array(jsonb_build_object('name', 'Roof', 'unit_price', 5000)))), 'replace') -> 0 ->> 'id') as or1 \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qr', 'Dumpster', 400);
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qr', 'Price adjustment', -300);
update public.quotes set discount_amount = 100, priced_on_site_at = now() where id = :'qr';
select t_options.check((select total = 5000 from public.quotes where id = :'qr'), 'a quote with one option, priced on site, with the office''s $100 off, comes to $5,000');
select public.remove_quote_option(:'qr', :'or1');
select t_options.check((select option_id is null and roof_package_id is null and priced_on_site_at is null and discount_amount = 100 and total = 300 from public.quotes where id = :'qr')
                   and (select array_agg(name) = array['Dumpster'] from public.quote_line_items where quote_id = :'qr'),
  'taking off its only option lets go of the price set on site, an adjustment on every option too, and keeps the office''s discount');
commit;

-- ===== put_quote_package: one package prices an estimate that offers no options ================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Garage roof') returning id as qp \gset
select t_options.check(public.put_quote_package(:'qp', :'pkg_good', jsonb_build_array(jsonb_build_object('name', 'Garage shingles', 'quantity', 10, 'unit_price', 400, 'sort', 0))),
  'one package puts its lines on an empty estimate');
select t_options.check((select roof_package_id = :'pkg_good' and section_ids = array[:'s_warranty']::uuid[] and option_id is null and total = 4000 from public.quotes where id = :'qp')
                   and (select bool_and(option_id is null and selected) from public.quote_line_items where quote_id = :'qp'),
  'on every option, with the package remembered and its contract sections on the quote');
-- The office adds a section for this job (QuoteSections) while the estimator changes the package.
update public.quotes set section_ids = section_ids || :'s_pay'::uuid where id = :'qp';
select public.put_quote_package(:'qp', :'pkg_better', jsonb_build_array(jsonb_build_object('name', 'Designer shingles', 'unit_price', 6000))) as put_again \gset
select t_options.check(not :'put_again'::boolean
                   and (select roof_package_id = :'pkg_better' and total = 4000 from public.quotes where id = :'qp'),
  'an estimate with lines keeps them, and remembers the new package');
select t_options.check((select section_ids = array[:'s_warranty', :'s_pay', :'s_cancel']::uuid[] from public.quotes where id = :'qp'),
  'whose sections come on, as the old one''s go (the warranty stays, the new one has it too), and the job''s own section isn''t lost');
select public.apply_quote_options(:'qp', jsonb_build_array(jsonb_build_object('name', 'Metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Garage metal', 'unit_price', 9000)))), 'add');
select id as op_metal from public.quote_options where quote_id = :'qp' and name = 'Metal' \gset
select t_options.check((select section_ids = array[:'s_pay']::uuid[] from public.quotes where id = :'qp')
                   and (select section_ids = array[:'s_cancel', :'s_warranty']::uuid[] from public.quote_options where quote_id = :'qp' and package_id = :'pkg_better')
                   and (select section_ids = '{}' from public.quote_options where id = :'op_metal'),
  'offering metal makes the estimate option 1, with the package''s sections on it, not on the quote, where they''d print on metal too');
select t_options.expect_error(format('select public.put_quote_package(%L, %L, %L)', :'qp', :'pkg_good', '[]'), 'an estimate that offers options is changed from the options bar');
select public.remove_quote_option(:'qp', :'op_metal');
select t_options.check((select option_id is null and roof_package_id = :'pkg_better' and total = 4000 and section_ids = array[:'s_pay', :'s_cancel', :'s_warranty']::uuid[]
                          from public.quotes where id = :'qp'),
  'taking metal off again leaves a single estimate with the designer option''s lines and sections, after the job''s own');
select public.apply_quote_options(:'qp', jsonb_build_array(jsonb_build_object('name', 'Metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Garage metal', 'unit_price', 9000)))), 'add');
update public.quotes set priced_on_site_at = now(), discount_amount = 250 where id = :'qp';
select public.put_quote_package(:'qp', :'pkg_good', jsonb_build_array(jsonb_build_object('name', 'Garage shingles', 'quantity', 10, 'unit_price', 400)), true) as put_over \gset
select t_options.check(:'put_over'::boolean
                   and not exists (select 1 from public.quote_options where quote_id = :'qp')
                   and (select option_id is null and roof_package_id = :'pkg_good' and priced_on_site_at is null and discount_amount = 0 and total = 4000 from public.quotes where id = :'qp')
                   and (select array_agg(name) = array['Garage shingles'] from public.quote_line_items where quote_id = :'qp'),
  'starting over takes every option, line and price off first, in the same step');
select t_options.check((select section_ids = array[:'s_pay', :'s_warranty']::uuid[] from public.quotes where id = :'qp'),
  'and the job''s own section stays, with the new package''s');
select t_options.expect_error(format('select public.put_quote_package(%L, %L, %L, true)', :'qa', :'pkg_good', '[]'), 'a signed quote''s lines don''t change');
select t_options.expect_error(format('select public.put_quote_package(%L, %L, %L)', :'qp', :'pkg_good', '{"name": "One"}'), 'the lines are a list');
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_options.expect_error(format('select public.put_quote_package(%L, %L, %L, true)', :'qp', :'pkg_good', '[]'), 'the field crew can''t price an estimate');
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t_options.expect_error(format('select public.put_quote_package(%L, %L, %L, true)', :'qp', :'pkg_good', '[]'), 'nor can another business');
commit;

-- ===== A package's contract sections move with it to the options and back =======================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
-- Picked before the roof is measured: remembered with its sections, and no lines yet.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Barn roof') returning id as qy \gset
select public.put_quote_package(:'qy', :'pkg_better', null);
update public.quotes set section_ids = section_ids || :'s_pay'::uuid where id = :'qy';
select t_options.check((select section_ids = array[:'s_cancel', :'s_warranty', :'s_pay']::uuid[] and roof_package_id = :'pkg_better' from public.quotes where id = :'qy'),
  'a package picked before measuring brings its sections, and the office adds one for the job');
select public.apply_quote_options(:'qy', jsonb_build_array(
  jsonb_build_object('package_id', :'pkg_good', 'name', 'Architectural shingle', 'section_ids', jsonb_build_array(:'s_warranty')),
  jsonb_build_object('package_id', :'pkg_best', 'name', 'Standing-seam metal')), 'add');
select t_options.check((select section_ids = array[:'s_pay']::uuid[] and roof_package_id = :'pkg_good' from public.quotes where id = :'qy'),
  'offering two other packages instead takes the remembered one''s sections off the quote, and keeps the job''s');
-- Started over from a single estimate.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Shop roof') returning id as qz \gset
select public.put_quote_package(:'qz', :'pkg_better', jsonb_build_array(jsonb_build_object('name', 'Designer shingles', 'unit_price', 8000)));
update public.quotes set section_ids = section_ids || :'s_pay'::uuid where id = :'qz';
select public.apply_quote_options(:'qz', jsonb_build_array(
  jsonb_build_object('package_id', :'pkg_good', 'name', 'Architectural shingle', 'section_ids', jsonb_build_array(:'s_warranty'), 'lines', jsonb_build_array(jsonb_build_object('name', 'Shop shingles', 'unit_price', 6000))),
  jsonb_build_object('package_id', :'pkg_best', 'name', 'Standing-seam metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Shop metal', 'unit_price', 12000)))), 'replace');
select t_options.check((select section_ids = array[:'s_pay']::uuid[] from public.quotes where id = :'qz'), 'starting over from a single estimate takes its package''s sections off the quote');
-- With options, the quote's own sections are only the job's: starting over again keeps them all.
update public.quotes set section_ids = array[:'s_pay', :'s_warranty']::uuid[] where id = :'qz';
select public.apply_quote_options(:'qz', jsonb_build_array(
  jsonb_build_object('package_id', :'pkg_better', 'name', 'Designer shingle', 'section_ids', jsonb_build_array(:'s_cancel', :'s_warranty'), 'lines', jsonb_build_array(jsonb_build_object('name', 'Shop designer', 'unit_price', 9000))),
  jsonb_build_object('package_id', :'pkg_best', 'name', 'Standing-seam metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Shop metal', 'unit_price', 12000)))), 'replace');
select t_options.check((select section_ids = array[:'s_pay', :'s_warranty']::uuid[] from public.quotes where id = :'qz'), 'starting over a quote that offers options keeps the sections added for the job');
commit;
select t_options.check(private.section_list(array[:'s_pay', :'s_cancel', :'s_pay', null, :'s_warranty', :'s_cancel']::uuid[]) = array[:'s_pay', :'s_cancel', :'s_warranty']::uuid[]
                   and cardinality(private.section_list(array(select gen_random_uuid() from generate_series(1, 60)))) = 50,
  'a list of sections put together keeps each once, in order, 50 at most');

-- ===== duplicate_quote: "Copy as new draft" =====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, message, tax_rate, deposit_amount, valid_until, section_ids)
  values (:'co', :'client', 'Whole house', 'Thanks for having us out.', 0.08, 1000, current_date + 30, array[:'s_pay']::uuid[]) returning id as qf \gset
select public.apply_quote_options(:'qf', jsonb_build_array(
  jsonb_build_object('package_id', :'pkg_good', 'name', 'Architectural shingle', 'tier', 'Good', 'sort', 0,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Architectural shingle roof', 'quantity', 30, 'unit', 'square', 'unit_price', 400),
                               jsonb_build_object('name', 'Ice and water shield', 'unit_price', 700, 'optional', true))),
  jsonb_build_object('package_id', :'pkg_better', 'name', 'Designer shingle', 'tier', 'Better', 'sort', 1,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Designer shingle roof', 'quantity', 30, 'unit', 'square', 'unit_price', 550, 'taxable', false),
                               jsonb_build_object('name', 'Copper valleys', 'unit_price', 1200, 'optional', true))),
  jsonb_build_object('package_id', :'pkg_best', 'name', 'Standing-seam metal', 'tier', 'Best', 'sort', 2,
    'lines', jsonb_build_array(jsonb_build_object('name', 'Standing-seam metal roof', 'quantity', 30, 'unit', 'square', 'unit_price', 1000)))), 'replace');
insert into public.quote_line_items (company_id, quote_id, name, unit_price, sort) values (:'co', :'qf', 'Permit', 150, 5);
select id as of2 from public.quote_options where quote_id = :'qf' and tier = 'Better' \gset
update public.quotes set option_id = :'of2' where id = :'qf';
update public.quotes set discount_amount = 100 where id = :'qf';
select public.duplicate_quote(:'qf') as qf_copy \gset
select t_options.check((select status = 'draft' and title = 'Whole house (copy)' and client_id = :'client' and message = 'Thanks for having us out.' and tax_rate = 0.08
                               and discount_amount = 100 and deposit_amount = 1000 and valid_until = current_date + 30 and section_ids = array[:'s_pay']::uuid[]
                               and roof_package_id = :'pkg_better' and approval is null
                          from public.quotes where id = :'qf_copy'), 'the copy is a draft for the same client, with the same terms, package and sections');
select t_options.check((select count(*) = 3 from public.quote_options where quote_id = :'qf_copy')
                   and not exists (select 1 from public.quote_options c join public.quote_options o on o.id = c.id where c.quote_id = :'qf_copy' and o.quote_id = :'qf')
                   and (select array_agg(name || '/' || tier || '/' || sort order by sort) from public.quote_options where quote_id = :'qf_copy')
                     = (select array_agg(name || '/' || tier || '/' || sort order by sort) from public.quote_options where quote_id = :'qf'),
  'it has its own copy of each option');
select t_options.check((select o.tier = 'Better' from public.quotes q join public.quote_options o on o.id = q.option_id where q.id = :'qf_copy'), 'and shows the same one');
select t_options.check((select array_agg(coalesce(o.name, 'every option') || ': ' || l.name order by l.name) from public.quote_line_items l left join public.quote_options o on o.id = l.option_id where l.quote_id = :'qf_copy')
                     = (select array_agg(coalesce(o.name, 'every option') || ': ' || l.name order by l.name) from public.quote_line_items l left join public.quote_options o on o.id = l.option_id where l.quote_id = :'qf'),
  'every line is on its option''s copy, the permit on every option');
select t_options.check((select (c.subtotal, c.discount_amount, c.tax_amount, c.total) = (o.subtotal, o.discount_amount, o.tax_amount, o.total) and c.total = 16561.93
                          from public.quotes c, public.quotes o where c.id = :'qf_copy' and o.id = :'qf') and t_options.others_unselected(:'qf_copy'),
  'and the copy comes to the same total as the original ($16,561.93)');
commit;

-- ===== sign_quote: signing on the iPad ===========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Porch roof') returning id as qg \gset
select public.apply_quote_options(:'qg', jsonb_build_array(
  jsonb_build_object('name', 'Architectural shingle', 'lines', jsonb_build_array(jsonb_build_object('name', 'Porch shingles', 'unit_price', 2000))),
  jsonb_build_object('name', 'Standing-seam metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Porch metal', 'unit_price', 4000)))), 'replace');
select id as og1 from public.quote_options where quote_id = :'qg' and name = 'Architectural shingle' \gset
select id as og2 from public.quote_options where quote_id = :'qg' and name = 'Standing-seam metal' \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'qg';
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Shed roof') returning id as qh \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qh', 'Shed shingles', 900);
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_options.check(public.sign_quote(:'qg', '{"name": "Dana Homeowner"}', :'og1', 2000) is null, 'field crew can''t sign an estimate');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t_options.check(public.sign_quote(:'qg', '{"name": "Dana Homeowner"}', :'og2', 4000) is null, 'signing for an option that isn''t the one shown signs nothing');
select t_options.check(public.sign_quote(:'qg', '{"name": "Dana Homeowner"}', null, 2000) is null, 'nor does signing with no option on a quote that offers them');
select t_options.check(public.sign_quote(:'qg', '{"name": "Dana Homeowner"}', :'og1', 2001) is null, 'nor at a total other than the one they saw');
select t_options.check((select status = 'sent' and approval is null from public.quotes where id = :'qg'), 'so it''s still waiting');
select public.sign_quote(:'qg', '{"name": "Dana Homeowner", "method": "in_person"}', :'og1', 2000) as signed \gset
select t_options.check((:'signed'::jsonb ->> 'total')::numeric = 2000 and (:'signed'::jsonb ->> 'subtotal')::numeric = 2000
                   and (:'signed'::jsonb ->> 'discount_amount')::numeric = 0 and (:'signed'::jsonb ->> 'tax_amount')::numeric = 0,
  'Dana signs the shingle option on the iPad, and gets the amounts back');
select t_options.check((select status = 'approved' and approved_at is not null and option_id = :'og1' and approval ->> 'name' = 'Dana Homeowner' and approval ->> 'method' = 'in_person'
                               and (approval ->> 'total')::numeric = 2000 and salesperson_id = 'c0de0000-0000-0000-0000-000000000003'
                          from public.quotes where id = :'qg'), 'it''s approved with the amounts, and the estimator is its salesperson');
select t_options.check(public.sign_quote(:'qg', '{"name": "Second Tab"}', :'og1', 2000) is null and (select approval ->> 'name' = 'Dana Homeowner' from public.quotes where id = :'qg'),
  'signing again changes nothing');
select t_options.check(public.sign_quote(:'qh', '{"name": "Dana Homeowner"}', :'og1') is null, 'a quote without options isn''t signed for an option');
select t_options.check((public.sign_quote(:'qh', '{"name": "Dana Homeowner"}') ->> 'total')::numeric = 900, 'and is signed as before, without one');
select t_options.check((select status = 'approved' and (approval ->> 'total')::numeric = 900 from public.quotes where id = :'qh'), 'at its price');
commit;

-- ===== approve_hub_quote: the Client Hub approves the option the client picked ===================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Main house') returning id as qi \gset
select public.apply_quote_options(:'qi', jsonb_build_array(
  jsonb_build_object('name', 'Architectural shingle', 'sort', 0, 'lines', jsonb_build_array(
    jsonb_build_object('name', 'Shingle roof', 'unit_price', 8000), jsonb_build_object('name', 'Ice and water shield', 'unit_price', 700, 'optional', true))),
  jsonb_build_object('name', 'Designer shingle', 'sort', 1, 'lines', jsonb_build_array(
    jsonb_build_object('name', 'Designer roof', 'unit_price', 11000), jsonb_build_object('name', 'Snow guards', 'unit_price', 300, 'optional', true)))), 'replace');
select id as oi1 from public.quote_options where quote_id = :'qi' and sort = 0 \gset
select id as oi2 from public.quote_options where quote_id = :'qi' and sort = 1 \gset
select id as ice from public.quote_line_items where quote_id = :'qi' and name = 'Ice and water shield' \gset
select id as snow from public.quote_line_items where quote_id = :'qi' and name = 'Snow guards' \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qi', 'Tear-off', 1500);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, optional, selected) values (:'co', :'qi', 'Gutter guards', 400, true, false) returning id as guards \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'qi';
-- And one without options, the way it was.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Fence') returning id as qn \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qn', 'Fence', 2000);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, optional, selected) values (:'co', :'qn', 'Gate', 400, true, false) returning id as gate \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'qn';
select t_options.expect_error(format('select public.approve_hub_quote(%L, %L, %L, %L, %L, %L)', :'co', :'qi', '{}', '{}', :'oi1', 9500), 'a signed-in member can''t call the Client Hub''s approval');
commit;

set role service_role;
select t_options.expect_error(format('select public.approve_hub_quote(%L, %L, %L, %L)', :'co', :'qi', '{}', '{"name": "Dana Homeowner"}'), 'a quote that offers options needs one picked');
select t_options.check(not public.approve_hub_quote(:'co', :'qi', '{}', '{"name": "Dana Homeowner"}', :'og2'), 'another quote''s option approves nothing');
select t_options.check(not public.approve_hub_quote(:'co', :'qi', array[:'guards', :'snow']::uuid[], '{"name": "Dana Homeowner"}', :'oi2', 13199), 'nor a total other than the one the client saw');
reset role;
select t_options.check((select status = 'sent' and option_id = :'oi1' and total = 9500 from public.quotes where id = :'qi')
                   and (select not selected from public.quote_line_items where id = :'guards') and (select not selected from public.quote_line_items where id = :'snow'),
  'and neither changes the quote, its option or its add-ons');
set role service_role;
select t_options.check(public.approve_hub_quote(:'co', :'qi', array[:'guards', :'snow', :'ice']::uuid[], '{"name": "Dana Homeowner", "ip": "203.0.113.7"}', :'oi2', 13200),
  'Dana approves the Designer option with gutter guards and snow guards, at $13,200');
reset role;
select t_options.check((select status = 'approved' and option_id = :'oi2' and total = 13200 and (approval ->> 'total')::numeric = 13200 and approval ->> 'name' = 'Dana Homeowner'
                          from public.quotes where id = :'qi'), 'it''s approved, showing the option chosen, at the total agreed');
select t_options.check((select selected from public.quote_line_items where id = :'guards') and (select selected from public.quote_line_items where id = :'snow')
                   and (select not selected from public.quote_line_items where id = :'ice') and t_options.others_unselected(:'qi'),
  'with the add-ons from the shared lines and that option only, and the other option''s lines left out');
set role service_role;
select t_options.check(public.approve_hub_quote(:'co', :'qn', array[:'gate']::uuid[], '{"name": "Dana Homeowner"}'), 'a quote without options is approved as before');
reset role;
select t_options.check((select status = 'approved' and total = 2400 from public.quotes where id = :'qn'), 'with the gate she picked');

-- A price set on site was for the option it was set on: approving another one leaves it behind.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Front roof') returning id as qsp \gset
select public.apply_quote_options(:'qsp', jsonb_build_array(
  jsonb_build_object('name', 'Architectural shingle', 'sort', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Front shingles', 'unit_price', 7000))),
  jsonb_build_object('name', 'Standing-seam metal', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Front metal', 'unit_price', 15000)))), 'replace');
select id as osp1 from public.quote_options where quote_id = :'qsp' and sort = 0 \gset
select id as osp2 from public.quote_options where quote_id = :'qsp' and sort = 1 \gset
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qsp', :'osp1', 'Price adjustment', -500);
update public.quotes set priced_on_site_at = now(), status = 'sent', sent_at = now() where id = :'qsp';
commit;
set role service_role;
select t_options.check(not public.approve_hub_quote(:'co', :'qsp', '{}', '{"name": "Dana Homeowner"}', :'osp2', 6500), 'the shingle price set on site isn''t metal''s');
reset role;
select t_options.check((select status = 'sent' and option_id = :'osp1' and priced_on_site_at is not null and total = 6500 from public.quotes where id = :'qsp')
                   and exists (select 1 from public.quote_line_items where quote_id = :'qsp' and name = 'Price adjustment'),
  'so that changes nothing, the price set on site included');
set role service_role;
select t_options.check(public.approve_hub_quote(:'co', :'qsp', '{}', '{"name": "Dana Homeowner"}', :'osp2', 15000), 'Dana approves metal online at its own $15,000');
reset role;
select t_options.check((select status = 'approved' and option_id = :'osp2' and priced_on_site_at is null and total = 15000 and (approval ->> 'total')::numeric = 15000
                          from public.quotes where id = :'qsp')
                   and not exists (select 1 from public.quote_line_items where quote_id = :'qsp' and name = 'Price adjustment'),
  'without the shingle price set on site or its adjustment');

-- A change order that offers options joins its job with the chosen one's lines.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, change_order_for) values (:'co', :'client', 'Change order: carport gutters', :'qm_job') returning id as qco \gset
select public.apply_quote_options(:'qco', jsonb_build_array(
  jsonb_build_object('name', 'Aluminum gutters', 'sort', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Aluminum gutters', 'unit_price', 800))),
  jsonb_build_object('name', 'Copper gutters', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Copper gutters', 'unit_price', 2400)))), 'replace');
select id as oco2 from public.quote_options where quote_id = :'qco' and sort = 1 \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qco', 'Downspout', 200);
update public.quotes set status = 'sent', sent_at = now() where id = :'qco';
commit;
set role service_role;
select t_options.check(public.approve_hub_quote(:'co', :'qco', '{}', '{"name": "Dana Homeowner"}', :'oco2', 2600), 'Dana approves the change order''s copper gutters online');
reset role;
select t_options.check((select status = 'converted' and (approval ->> 'total')::numeric = 2600 from public.quotes where id = :'qco')
                   and (select array_agg(name order by name) = array['Copper gutters', 'Downspout'] from public.job_line_items where job_id = :'qm_job' and source_quote_id = :'qco'),
  'it joins its job with copper''s lines and the shared one, not aluminum''s');

-- ===== A promo code's minimum order holds for the option the client picks =======================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.promo_codes (company_id, code, kind, value, min_subtotal, once_per_client) values (:'co', 'BIG-1500', 'amount', 1500, 15000, false);
-- Best is shown (offered first); Good has a skylight to add.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Big roof') returning id as qpm \gset
select public.apply_quote_options(:'qpm', jsonb_build_array(
  jsonb_build_object('name', 'Standing-seam metal', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Best roof', 'unit_price', 20000))),
  jsonb_build_object('name', 'Architectural shingle', 'sort', 0, 'lines', jsonb_build_array(
    jsonb_build_object('name', 'Good roof', 'unit_price', 10000), jsonb_build_object('name', 'Skylight', 'unit_price', 6000, 'optional', true)))), 'replace');
select id as opm_best from public.quote_options where quote_id = :'qpm' and sort = 1 \gset
select id as opm_good from public.quote_options where quote_id = :'qpm' and sort = 0 \gset
select id as skylight from public.quote_line_items where quote_id = :'qpm' and name = 'Skylight' \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'qpm';
-- Good is shown; Best is the one to pick.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Big garage roof') returning id as qpr \gset
select public.apply_quote_options(:'qpr', jsonb_build_array(
  jsonb_build_object('name', 'Architectural shingle', 'sort', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Good garage roof', 'unit_price', 10000))),
  jsonb_build_object('name', 'Standing-seam metal', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Best garage roof', 'unit_price', 20000)))), 'replace');
select id as opr_best from public.quote_options where quote_id = :'qpr' and sort = 1 \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'qpr';
-- And one without options, with an add-on picked.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Big fence') returning id as qpn \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qpn', 'Cedar fence', 12000);
insert into public.quote_line_items (company_id, quote_id, name, unit_price, optional, selected) values (:'co', :'qpn', 'Double gate', 4000, true, true) returning id as qpn_gate \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'qpn';
commit;

set role service_role;
select t_options.expect_error(format('select public.apply_promo_code(%L, %L, %L, %L)', 'quote', :'qpm', 'BIG-1500', :'opm_good'),
  'with Best shown, the $15,000 code is checked against the Good option the client picked, at $10,000');
select t_options.expect_error(format('select public.apply_promo_code(%L, %L, %L, %L)', 'quote', :'qpm', 'BIG-1500', :'opr_best'), 'an option of another quote isn''t one to check against');
select public.apply_promo_code('quote', :'qpm', 'BIG-1500', :'opm_good', array[:'skylight']::uuid[]);
select t_options.check((select promo_code_id is not null and option_id = :'opm_best' from public.quotes where id = :'qpm'), 'with the skylight they''ve ticked it comes to $16,000, and the code goes on');
select t_options.expect_state(format('select public.approve_hub_quote(%L, %L, %L, %L, %L, %L)', :'co', :'qpm', '{}', '{"name": "Dana Homeowner"}', :'opm_good', 8500), 'CX412',
  'approving Good without the skylight, at $8,500 with the code, is turned down: it''s under the code''s minimum');
reset role;
select t_options.check((select status = 'sent' and option_id = :'opm_best' and promo_code_id is not null and approval is null from public.quotes where id = :'qpm')
                   and (select not selected from public.quote_line_items where id = :'skylight'),
  'and nothing changed, the option shown included');
set role service_role;
select t_options.check(public.approve_hub_quote(:'co', :'qpm', array[:'skylight']::uuid[], '{"name": "Dana Homeowner"}', :'opm_good', 14500),
  'Good with the skylight meets it, and is approved at $14,500');
select t_options.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'qpr', 'BIG-1500'), 'with Good shown, the code isn''t for Good''s $10,000');
select public.apply_promo_code('quote', :'qpr', 'BIG-1500', :'opr_best');
select t_options.check(public.approve_hub_quote(:'co', :'qpr', '{}', '{"name": "Dana Homeowner"}', :'opr_best', 18500),
  'but the client picking Best ($20,000) gets it, and approves Best at $18,500');
select public.apply_promo_code('quote', :'qpn', 'BIG-1500');
select t_options.expect_state(format('select public.approve_hub_quote(%L, %L, %L, %L, null, %L)', :'co', :'qpn', '{}', '{"name": "Dana Homeowner"}', 10500), 'CX412',
  'a quote without options whose add-on is unticked at approval, under the minimum, isn''t approved either');
reset role;
select t_options.check((select status = 'sent' and total = 14500 from public.quotes where id = :'qpn') and (select selected from public.quote_line_items where id = :'qpn_gate'),
  'and keeps its add-on');
set role service_role;
select t_options.check(public.approve_hub_quote(:'co', :'qpn', array[:'qpn_gate']::uuid[], '{"name": "Dana Homeowner"}', null, 14500), 'with the gate it is');
reset role;

-- ===== A promo code doesn't go on a price agreed on site ========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.promo_codes (company_id, code, kind, value, once_per_client) values (:'co', 'SITE-100', 'amount', 100, false);
-- Priced on site below the estimate, without options: the discount it set.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Porch roof') returning id as qsite1 \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qsite1', 'Porch roof', 3000);
update public.quotes set status = 'sent', sent_at = now(), discount_amount = 200, priced_on_site_at = now() where id = :'qsite1';
select t_options.expect_state(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'qsite1', 'SITE-100'), '22023', 'a code doesn''t replace the discount a price set on site gave');
-- With options: its adjustment line on the option shown.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Shed roof') returning id as qsite2 \gset
select public.apply_quote_options(:'qsite2', jsonb_build_array(
  jsonb_build_object('name', 'Shingles', 'sort', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Shingle shed roof', 'unit_price', 2000))),
  jsonb_build_object('name', 'Metal', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Metal shed roof', 'unit_price', 4000)))), 'replace');
select id as osite_good from public.quote_options where quote_id = :'qsite2' and sort = 0 \gset
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (:'co', :'qsite2', :'osite_good', 'Price adjustment', -150);
update public.quotes set status = 'sent', sent_at = now(), priced_on_site_at = now() where id = :'qsite2';
select t_options.expect_state(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'qsite2', 'SITE-100'), '22023', 'or come off an option''s price agreed on site');
-- A visit that kept the estimate's price set neither, so a code still goes on.
update public.quotes set discount_amount = 0 where id = :'qsite1';
select public.apply_promo_code('quote', :'qsite1', 'SITE-100');
select t_options.check((select promo_code_id is not null and total = 2900 from public.quotes where id = :'qsite1'), 'a visit that kept the estimate''s price still takes a code');
rollback;

-- ===== Pictures only the server writes ===========================================================
insert into storage.objects (bucket_id, name, owner) values
  ('files', :'co' || '/packages/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e21.jpg', null),
  ('files', :'co' || '/logo/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e22.png', null),
  ('files', :'co' || '/letterhead/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e23.png', null);
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t_options.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/packages/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e31.jpg', 'c0de0000-0000-0000-0000-000000000001'),
  'the owner can''t put a package picture in storage directly');
select t_options.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/logo/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e32.png', 'c0de0000-0000-0000-0000-000000000001'),
  'or a logo');
select t_options.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/letterhead/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e33.png', 'c0de0000-0000-0000-0000-000000000001'),
  'or a letterhead picture');
delete from storage.objects where name like :'co' || '/packages/%' or name like :'co' || '/logo/%' or name like :'co' || '/letterhead/%';
update storage.objects set name = name || '.old' where name like :'co' || '/packages/%';
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/quote/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e34.jpg', 'c0de0000-0000-0000-0000-000000000001');
select t_options.check((select count(*) = 3 from storage.objects where name in (
    :'co' || '/packages/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e21.jpg', :'co' || '/logo/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e22.png', :'co' || '/letterhead/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e23.png'))
                   and exists (select 1 from storage.objects where name = :'co' || '/quote/0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e34.jpg'),
  'nor delete or rename the ones the server keeps, though other folders take uploads as before');
rollback;
delete from storage.objects where name like :'co' || '/%';

-- ===== A signed quote keeps its approval =========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t_options.expect_error(format('update public.quotes set approval = %L where id = %L', '{"name": "Assistant", "method": "manual", "contract": null}', :'qi'),
  'nobody replaces what the client signed online');
select t_options.expect_error(format('update public.quotes set status = %L, approved_at = now(), approval = %L where id = %L', 'approved', '{"name": "Office", "method": "manual"}', :'qi'),
  'not even marking it approved again, with the option it shows');
select t_options.expect_error(format('update public.quotes set approved_at = now() where id = %L', :'qi'), 'or changes when it was approved');
update public.quotes set approval = approval || '{"company": {"name": "Sam Summit", "signature": "data:image/png;base64,AAAA"}}' where id = :'qi';
select t_options.check((select approval -> 'company' ->> 'name' = 'Sam Summit' and approval ->> 'name' = 'Dana Homeowner' and (approval ->> 'total')::numeric = 13200
                          from public.quotes where id = :'qi'), 'the business signs under the client''s signature');
select t_options.expect_error(format('update public.quotes set approval = approval || %L where id = %L', '{"company": {"name": "Olive Office"}}', :'qi'), 'once');
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Deck roof') returning id as qds \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qds', 'Deck roof', 2500);
select public.sign_quote(:'qds', '{"name": "Dana Homeowner", "method": "in_person", "company": null}');
update public.quotes set approval = approval || '{"company": {"name": "Sam Summit", "signature": "data:image/png;base64,AAAA"}}' where id = :'qds';
select t_options.check((select approval -> 'company' ->> 'name' = 'Sam Summit' and approval ->> 'method' = 'in_person' from public.quotes where id = :'qds'),
  'and on one signed on the iPad without the business''s signature');
select t_options.expect_error(format('update public.quotes set status = %L where id = %L', 'approved', :'qm'), 'a quote that''s a job isn''t approved again');
commit;

-- ===== accept_hub_range: saying yes to a range, leaning toward an option ========================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Back roof') returning id as qj \gset
select public.apply_quote_options(:'qj', jsonb_build_array(
  jsonb_build_object('name', 'Architectural shingle', 'sort', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Back shingles', 'unit_price', 6000))),
  jsonb_build_object('name', 'Standing-seam metal', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Back metal', 'unit_price', 12000)))), 'replace');
select id as oj2 from public.quote_options where quote_id = :'qj' and sort = 1 \gset
update public.quotes set range_low = 5800, range_high = 13900, range_sent_at = now(), range_lines = '[]', status = 'sent', sent_at = now() where id = :'qj';
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Side roof') returning id as qk \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'qk', 'Side shingles', 3000);
update public.quotes set range_low = 2900, range_high = 3500, range_sent_at = now(), range_lines = '[]', status = 'sent', sent_at = now() where id = :'qk';
commit;
select number as qj_number from public.quotes where id = :'qj' \gset

set role service_role;
select t_options.check(public.accept_hub_range(:'co', :'qj', :'og2') is null, 'leaning toward another quote''s option says yes to nothing');
reset role;
select t_options.check((select range_accepted_at is null from public.quotes where id = :'qj'), 'so the range is still waiting');
set role service_role;
select t_options.check(public.accept_hub_range(:'co', :'qj', :'oj2') is not null, 'Dana says yes to the range, leaning toward metal');
select t_options.check(public.accept_hub_range(:'co', :'qk') is not null, 'a range without options is said yes to as before');
reset role;
select t_options.check((select range_accepted_at is not null and option_id = :'oj2' and total = 12000 from public.quotes where id = :'qj'), 'the option she leans toward is the one shown');
select t_options.check((select summary = format('Dana Homeowner said yes to $5,800.00 to $13,900.00 for quote #%s, leaning toward Standing-seam metal', :'qj_number')
                               and data ->> 'option' = 'Standing-seam metal' and data ->> 'option_id' = :'oj2'
                          from public.activity where subject_id = :'qj' and verb = 'quote.range_accepted'), 'and the office hears which');
select t_options.check((select summary not like '%leaning%' and not (data ? 'option') from public.activity where subject_id = :'qk' and verb = 'quote.range_accepted'),
  'without one, the message is as it was');

-- ===== A line written while the option changes, or the quote is approved, waits for it ===========
-- A second connection (dblink may already be installed) writes a line as the estimator while this
-- one shows another option, then approves one, each held open until the line is waiting.
create extension if not exists dblink schema t_options;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Busy roof') returning id as qw \gset
select public.apply_quote_options(:'qw', jsonb_build_array(
  jsonb_build_object('name', 'Architectural shingle', 'sort', 0, 'lines', jsonb_build_array(jsonb_build_object('name', 'Good roof', 'unit_price', 5000))),
  jsonb_build_object('name', 'Standing-seam metal', 'sort', 1, 'lines', jsonb_build_array(jsonb_build_object('name', 'Best roof', 'unit_price', 12000)))), 'replace');
select id as ow_good from public.quote_options where quote_id = :'qw' and sort = 0 \gset
select id as ow_best from public.quote_options where quote_id = :'qw' and sort = 1 \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'qw';
commit;
select :"dbl".dblink_connect('race', 'dbname=' || current_database());
select pid as race_pid from :"dbl".dblink('race', 'select pg_backend_pid()') as t(pid integer) \gset

begin;
update public.quotes set option_id = :'ow_best' where id = :'qw';
select :"dbl".dblink_exec('race', format('begin; set local role authenticated; set local request.jwt.claims = %L',
  '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}'));
select :"dbl".dblink_send_query('race', format('insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (%L, %L, %L, %L, 400)',
  :'co', :'qw', :'ow_good', 'Ridge vent'));
select t_options.check(t_options.waits(:race_pid), 'a ridge vent added to the Good option while the office shows Best waits for it');
commit;
select * from :"dbl".dblink_get_result('race') as t(status text);
select * from :"dbl".dblink_get_result('race') as t(status text);
select :"dbl".dblink_exec('race', 'commit');
select t_options.check((select not selected from public.quote_line_items where quote_id = :'qw' and name = 'Ridge vent')
                   and (select option_id = :'ow_best' and total = 12000 from public.quotes where id = :'qw') and t_options.others_unselected(:'qw'),
  'then goes on Good as it is now, not shown, so the quote still comes to Best''s $12,000');

begin;
select t_options.check(public.approve_hub_quote(:'co', :'qw', '{}', '{"name": "Dana Homeowner"}', :'ow_good', 5400), 'Dana approves Good online, ridge vent and all');
select :"dbl".dblink_exec('race', format('begin; set local role authenticated; set local request.jwt.claims = %L',
  '{"sub": "c0de0000-0000-0000-0000-000000000003", "role": "authenticated"}'));
select :"dbl".dblink_send_query('race', format('insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price) values (%L, %L, %L, %L, 600)',
  :'co', :'qw', :'ow_good', 'Gutters'));
select t_options.check(t_options.waits(:race_pid), 'gutters added to Good while it''s being approved wait for the approval');
commit;
select t_options.expect_error(format('select * from %s.dblink_get_result(%L) as t(status text)', :'dbl', 'race'), 'then can''t go on the approved quote');
select * from :"dbl".dblink_get_result('race') as t(status text);
select :"dbl".dblink_exec('race', 'rollback');
select :"dbl".dblink_disconnect('race');
select t_options.check((select status = 'approved' and option_id = :'ow_good' and total = 5400 and (approval ->> 'total')::numeric = 5400 from public.quotes where id = :'qw')
                   and not exists (select 1 from public.quote_line_items where quote_id = :'qw' and name = 'Gutters'),
  'so the approved quote comes to what Dana approved');

-- ===== The Client Hub's functions: one of each, for the server only ==============================
select t_options.check((select count(*) = 1 from pg_proc where proname = 'approve_hub_quote') and (select count(*) = 1 from pg_proc where proname = 'accept_hub_range'),
  'there''s one approve_hub_quote and one accept_hub_range');
select t_options.check((select count(*) = 1 from pg_proc where proname = 'sign_quote') and (select count(*) = 1 from pg_proc where proname = 'apply_quote_options'),
  'and one sign_quote and one apply_quote_options');
select t_options.check(not has_function_privilege('anon', 'public.approve_hub_quote(uuid, uuid, uuid[], jsonb, uuid, numeric)', 'execute')
                   and not has_function_privilege('authenticated', 'public.approve_hub_quote(uuid, uuid, uuid[], jsonb, uuid, numeric)', 'execute')
                   and has_function_privilege('service_role', 'public.approve_hub_quote(uuid, uuid, uuid[], jsonb, uuid, numeric)', 'execute'),
  'only the server approves for the Client Hub');
select t_options.check(not has_function_privilege('anon', 'public.accept_hub_range(uuid, uuid, uuid)', 'execute')
                   and not has_function_privilege('authenticated', 'public.accept_hub_range(uuid, uuid, uuid)', 'execute')
                   and has_function_privilege('service_role', 'public.accept_hub_range(uuid, uuid, uuid)', 'execute'),
  'and says yes to a range');
-- (put_quote_package runs as the caller, under their access, so this guards who may call it, not
-- what it can reach.)
select t_options.check((select bool_and(not has_function_privilege('anon', f, 'execute') and has_function_privilege('authenticated', f, 'execute'))
                          from unnest(array['public.apply_quote_options(uuid, jsonb, text, uuid[], jsonb)', 'public.remove_quote_option(uuid, uuid)',
                                            'public.duplicate_quote(uuid)', 'public.put_quote_package(uuid, uuid, jsonb, boolean)',
                                            'public.sign_quote(uuid, jsonb, uuid, numeric)']) f),
  'the options functions, pricing from a package and signing are for people signed in, not for anyone without an account');
select t_options.check((select count(*) = 1 from pg_proc where proname = 'apply_promo_code') and (select count(*) = 1 from pg_proc where proname = 'put_quote_package')
                   and not has_function_privilege('anon', 'public.apply_promo_code(text, uuid, text, uuid, uuid[])', 'execute')
                   and has_function_privilege('authenticated', 'public.apply_promo_code(text, uuid, text, uuid, uuid[])', 'execute')
                   and has_function_privilege('service_role', 'public.apply_promo_code(text, uuid, text, uuid, uuid[])', 'execute'),
  'there''s one apply_promo_code, for the office and the server, and one put_quote_package');
begin;
set local role anon;
select t_options.expect_error(format('select public.accept_hub_range(%L, %L, %L)', :'co', :'qj', :'oj2'), 'nobody without an account says yes to a range');
select t_options.expect_error(format('select public.sign_quote(%L, %L)', :'qh', '{}'), 'or signs a quote');
select t_options.expect_error(format('select public.put_quote_package(%L, %L, %L)', :'qp', :'pkg_good', '[]'), 'or prices one from a package');
rollback;

-- ===== The links the app's queries name ===========================================================
select t_options.check((select count(*) = 5 from pg_constraint where conname in
  ('quote_options_quote_fkey', 'quote_options_package_fkey', 'quote_options_quote_id_id_key', 'quotes_option_fkey', 'quote_line_items_option_fkey')),
  'the options'' links have the names the app''s queries use');

-- ===== Contract sections named on a quote or an option are the business's own ===================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.quotes set section_ids = array[:'s_cancel', :'other_section', :'s_pay', :'s_cancel', gen_random_uuid()]::uuid[] where id = :'qd';
select t_options.check((select section_ids = array[:'s_cancel', :'s_pay']::uuid[] from public.quotes where id = :'qd'), 'a quote keeps only this business''s sections, once each, in order');
update public.quote_options set section_ids = array[:'other_section', :'s_warranty']::uuid[] where quote_id = :'qd';
select t_options.check((select bool_and(section_ids = array[:'s_warranty']::uuid[]) from public.quote_options where quote_id = :'qd'), 'and so does an option');
insert into public.contract_sections (company_id, title, sort) select :'co', 'Clause ' || g, 10 + g from generate_series(1, 51) g;
select t_options.expect_error(format('update public.quotes set section_ids = (select array_agg(id) from public.contract_sections where company_id = %L) where id = %L', :'co', :'qd'),
  'a quote adds 50 sections at most');
rollback;

-- ===== Deleting a quote, or a business, takes the options with it ===============================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0de0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.quotes where id = :'qa';
select t_options.check(not exists (select 1 from public.quote_options where quote_id = :'qa') and not exists (select 1 from public.quote_line_items where quote_id = :'qa'),
  'deleting a signed quote with options deletes its options and lines');
delete from public.quotes where id = :'qf';
select t_options.check(not exists (select 1 from public.quote_options where quote_id = :'qf') and (select count(*) = 3 from public.quote_options where quote_id = :'qf_copy'),
  'deleting the original leaves its copy alone');
select public.create_company('Short-lived Roofing', 'roofing_exteriors') as gone \gset
insert into public.clients (company_id, display_name) values (:'gone', 'Lee Leaving') returning id as gone_client \gset
insert into public.contract_sections (company_id, title) values (:'gone', 'Payment') returning id as gone_section \gset
insert into public.roof_packages (company_id, name, section_ids) values (:'gone', 'Shingles', array[:'gone_section']::uuid[]) returning id as gone_pkg \gset
insert into public.quotes (company_id, client_id, title) values (:'gone', :'gone_client', 'Signed roof') returning id as gone_signed \gset
select public.apply_quote_options(:'gone_signed', jsonb_build_array(
  jsonb_build_object('package_id', :'gone_pkg', 'name', 'Shingles', 'lines', jsonb_build_array(jsonb_build_object('name', 'Roof', 'unit_price', 5000))),
  jsonb_build_object('name', 'Metal', 'lines', jsonb_build_array(jsonb_build_object('name', 'Metal roof', 'unit_price', 9000)))), 'replace');
update public.quotes set status = 'approved', approved_at = now() where id = :'gone_signed';
insert into public.quotes (company_id, client_id, title) values (:'gone', :'gone_client', 'Open roof') returning id as gone_open \gset
select public.apply_quote_options(:'gone_open', jsonb_build_array(jsonb_build_object('name', 'Shingles'), jsonb_build_object('name', 'Metal')), 'replace');
commit;
delete from public.companies where id = :'gone';
select t_options.check(not exists (select 1 from public.quote_options where company_id = :'gone') and not exists (select 1 from public.quote_line_items where company_id = :'gone')
                   and not exists (select 1 from public.quotes where company_id = :'gone') and not exists (select 1 from public.contract_sections where company_id = :'gone'),
  'deleting a business deletes its quotes, their options and lines, and its contract sections');

\o
\echo 'All contract section and option tests passed.'
