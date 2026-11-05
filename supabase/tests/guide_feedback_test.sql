-- Database tests for knowing whether guides work (20261108000300_guide_feedback_quizzes.sql):
-- votes and suggested changes, searches that found nothing, and quizzes before "I've read this".
-- Readers send and see only their own; the office sees it all; nobody reads a quiz's answers but
-- the office, and a guide with a quiz is only confirmed with its answers right.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tgf;
grant usage on schema tgf to authenticated, service_role;
create function tgf.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tgf.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tgf to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('9d000000-0000-4000-8000-000000000001', 'owner@mike.test', '{"full_name": "Mo Owner"}'),
  ('9d000000-0000-4000-8000-000000000002', 'office@mike.test', '{"full_name": "Meg Office"}'),
  ('9d000000-0000-4000-8000-000000000003', 'crew@mike.test', '{"full_name": "Max Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9d000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select public.create_company('Mike Paving', 'paving') as co \gset
insert into public.sop_pages (company_id, title, owner_id) values (:'co', 'Mix sealer', '9d000000-0000-4000-8000-000000000002') returning id as mix \gset
insert into public.sop_pages (company_id, title, status) values (:'co', 'Draft guide', 'draft') returning id as draft \gset
insert into public.sop_pages (company_id, title, required) values (:'co', 'Traffic safety', true) returning id as safety \gset
insert into public.sop_pages (company_id, title, required) values (:'co', 'Fuel the truck', true) returning id as fuel \gset
commit;
reset role;
insert into public.memberships (company_id, user_id, role) values
  (:'co', '9d000000-0000-4000-8000-000000000002', 'office'),
  (:'co', '9d000000-0000-4000-8000-000000000003', 'field_crew');

-- ===== Votes and suggestions, as the crew ======================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9d000000-0000-4000-8000-000000000003", "role": "authenticated"}', true);
select public.guide_feedback(:'mix', true);
select public.guide_feedback(:'mix', false);
select tgf.check((select count(*) = 1 and bool_and(not helpful) from public.sop_feedback where page_id = :'mix' and message is null), 'voting again changes the vote, it doesn''t add one');
select public.guide_feedback(:'mix', p_message => '  Step 3 says 20 gallons; we use 30.  ');
select tgf.check((select message from public.sop_feedback where page_id = :'mix' and message is not null) = 'Step 3 says 20 gallons; we use 30.', 'a suggestion is kept, trimmed');
select tgf.expect_error(format('select public.guide_feedback(%L, true)', :'draft'), 'the crew can''t send feedback on a draft they can''t see');
select tgf.expect_error(format('select public.guide_feedback(%L, true, %L)', :'mix', 'both'), 'a vote and a suggestion aren''t sent as one');
select tgf.expect_error(format('insert into public.sop_feedback (company_id, page_id, revision, helpful) values (%L, %L, 1, true)', :'co', :'mix'), 'feedback only goes through guide_feedback');
update public.sop_feedback set resolved_at = now() where page_id = :'mix';
commit;
reset role;
select tgf.check((select count(*) from public.sop_feedback where resolved_at is not null) = 0, 'the crew can''t mark suggestions done');
select tgf.check((select array_agg(u.email) from public.notifications n join auth.users u on u.id = n.user_id where n.kind = 'guide_feedback') = array['office@mike.test'], 'a suggestion tells the guide''s reviewer');
select tgf.check((select title from public.notifications where kind = 'guide_feedback') = 'Max Crew suggested a change to “Mix sealer”', 'saying who suggested what');

-- ===== The office handles it ===================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9d000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
select tgf.check((select count(*) from public.sop_feedback where page_id = :'mix') = 2, 'the office sees everyone''s feedback');
update public.sop_feedback set resolved_at = now(), resolved_by = '9d000000-0000-4000-8000-000000000002' where page_id = :'mix' and message is not null;
select tgf.check((select resolved_at is not null from public.sop_feedback where page_id = :'mix' and message is not null), 'the office marks a suggestion done');
select tgf.expect_error(format('update public.sop_feedback set message = %L where page_id = %L', 'changed', :'mix'), 'but can''t change what someone said');
commit;

-- ===== Searches that found nothing =============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9d000000-0000-4000-8000-000000000003", "role": "authenticated"}', true);
insert into public.sop_search_misses (company_id, query) values (:'co', 'crack filler');
select tgf.check((select count(*) from public.sop_search_misses) = 0, 'the crew can note a search but not read them');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9d000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
select tgf.check((select query from public.sop_search_misses where company_id = :'co') = 'crack filler', 'the office reads them');
delete from public.sop_search_misses where company_id = :'co';
select tgf.check((select count(*) from public.sop_search_misses where company_id = :'co') = 0, 'and clears them');
-- A quiz: one question, the second answer right.
insert into public.sop_quizzes (company_id, page_id, questions) values
  (:'co', :'safety', '[{"question": "Where do you stand?", "options": ["In the lane", "Behind the cones"], "answer": 1}]');
select tgf.expect_error(format('insert into public.sop_quizzes (company_id, page_id, questions) values (%L, %L, %L)', :'co', :'fuel', '[{"question": "Q", "options": ["a", "b"], "answer": 2}]'), 'a quiz''s right answer has to be one of its answers');
commit;

-- ===== Quizzes, as the crew ====================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9d000000-0000-4000-8000-000000000003", "role": "authenticated"}', true);
select tgf.check((select count(*) from public.sop_quizzes) = 0, 'the crew can''t read a quiz''s answers');
select tgf.check(public.guide_quiz(:'safety') = '[{"options": ["In the lane", "Behind the cones"], "question": "Where do you stand?"}]'::jsonb, 'they get its questions without them');
select tgf.check(public.guide_quiz(:'fuel') is null, 'a guide without a quiz has none');
select tgf.check(public.acknowledge_guide(:'safety', array[0]) = array[0], 'a wrong answer comes back');
select tgf.check(public.acknowledge_guide(:'safety') = array[0], 'so does none');
select tgf.check((select count(*) from public.sop_acknowledgements where page_id = :'safety') = 0, 'and it isn''t confirmed');
select tgf.expect_error(format('insert into public.sop_acknowledgements (company_id, page_id, revision) values (%L, %L, 1)', :'co', :'safety'), 'a guide with a quiz can''t be confirmed around it');
select tgf.check(public.acknowledge_guide(:'safety', array[1]) = '{}', 'the right answers confirm it');
select tgf.check((select count(*) from public.sop_acknowledgements where page_id = :'safety' and user_id = '9d000000-0000-4000-8000-000000000003') = 1, 'confirmed, for the revision they read');
select tgf.check(public.acknowledge_guide(:'fuel') = '{}', 'a guide without a quiz is confirmed as before');
insert into public.sop_acknowledgements (company_id, page_id, revision) values (:'co', :'mix', 1);
select tgf.check((select count(*) from public.sop_acknowledgements where page_id = :'mix') = 1, 'and one without a quiz still can be confirmed directly');
commit;
