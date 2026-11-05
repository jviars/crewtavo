-- Database tests for guides on a review schedule (20261108000200_guide_reviews.sql): putting one on
-- a schedule or saving a change counts as a review, it comes due that many months later, and its
-- reviewer hears once, then weekly while it stays due (the office instead, when the reviewer can't
-- edit guides). Drafts and guides off a schedule never come due.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tgr;
grant usage on schema tgr to authenticated, service_role;
create function tgr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- Who heard about a guide's review, in order.
create function tgr.heard(p_page uuid) returns text[] language sql as $$
  select coalesce(array_agg(u.email order by u.email), '{}') from public.notifications n join auth.users u on u.id = n.user_id
  where n.kind = 'guide_review' and n.link = '/kb/' || p_page
$$;
grant execute on all functions in schema tgr to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('9c000000-0000-4000-8000-000000000001', 'owner@lima.test', '{"full_name": "Lu Owner"}'),
  ('9c000000-0000-4000-8000-000000000002', 'office@lima.test', '{"full_name": "Liv Office"}'),
  ('9c000000-0000-4000-8000-000000000003', 'crew@lima.test', '{"full_name": "Lev Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select public.create_company('Lima Paving', 'paving') as co \gset
commit;
reset role;
insert into public.memberships (company_id, user_id, role) values
  (:'co', '9c000000-0000-4000-8000-000000000002', 'office'),
  (:'co', '9c000000-0000-4000-8000-000000000003', 'field_crew');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
insert into public.sop_pages (company_id, title, review_months, owner_id) values (:'co', 'Request a COI', 6, '9c000000-0000-4000-8000-000000000002') returning id as coi \gset
insert into public.sop_pages (company_id, title) values (:'co', 'Restock supplies') returning id as off \gset
insert into public.sop_pages (company_id, title, status, review_months) values (:'co', 'Draft bonds', 'draft', 1) returning id as draft \gset
select tgr.check((select reviewed_at is not null from public.sop_pages where id = :'coi'), 'a guide put on a schedule counts as reviewed now');
select tgr.check((select reviewed_at is null from public.sop_pages where id = :'off'), 'one off a schedule isn''t');
commit;

-- Seven months on, nothing reviewed.
reset role;
update public.sop_pages set reviewed_at = now() - interval '7 months' where company_id = :'co';
select tgr.check(public.emit_guide_reviews() = 1, 'the guide that came due is the one reminded about');
select tgr.check(tgr.heard(:'coi') = array['office@lima.test'], 'its reviewer hears, and only them');
select tgr.check(tgr.heard(:'draft') = '{}' and tgr.heard(:'off') = '{}', 'drafts and guides off a schedule don''t');
select tgr.check(public.emit_guide_reviews() = 0, 'not again the same week');
update private.sop_review_notices set noticed_at = now() - interval '8 days' where page_id = :'coi';
select tgr.check(public.emit_guide_reviews() = 1 and cardinality(tgr.heard(:'coi')) = 2, 'again a week later while it''s still due');

-- The reviewer saves a change: that's a review.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
update public.sop_pages set body = '{"type": "html", "html": "<p>Email the agent.</p>"}', body_html = '<p>Email the agent.</p>' where id = :'coi';
select tgr.check((select reviewed_at > now() - interval '1 minute' from public.sop_pages where id = :'coi'), 'saving a change counts as a review');
commit;
reset role;
select tgr.check(public.emit_guide_reviews() = 0, 'so it isn''t due any more');

-- Due again, with a reviewer who can't edit guides: the office hears.
delete from public.notifications where kind = 'guide_review';
update public.sop_pages set reviewed_at = now() - interval '7 months', owner_id = '9c000000-0000-4000-8000-000000000003' where id = :'coi';
select tgr.check(public.emit_guide_reviews() = 1, 'a guide due after its last review is reminded about again');
select tgr.check(tgr.heard(:'coi') = array['office@lima.test', 'owner@lima.test'], 'with a reviewer who can''t edit guides, everyone who can hears');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c000000-0000-4000-8000-000000000003", "role": "authenticated"}', true);
select tgr.check((select count(*) from public.notifications where kind = 'guide_review') = 0, 'the crew never sees them');
commit;

-- Pinning (20261108000500_pinned_guides.sql), and "Updated": only a change to what a guide says moves it.
reset role;
select revised_at as before from public.sop_pages where id = :'coi' \gset
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
update public.sop_pages set pinned_at = now(), reviewed_at = now() where id = :'coi';
select tgr.check((select pinned_at is not null and revised_at = :'before' from public.sop_pages where id = :'coi'), 'the office pins a guide, and pinning or marking it reviewed isn''t an update');
update public.sop_pages set body = '{"type": "html", "html": "<p>Email the agent today.</p>"}', body_html = '<p>Email the agent today.</p>' where id = :'coi';
select tgr.check((select revised_at > :'before' from public.sop_pages where id = :'coi'), 'changing what it says is');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c000000-0000-4000-8000-000000000003", "role": "authenticated"}', true);
update public.sop_pages set pinned_at = null where id = :'coi';
commit;
reset role;
select tgr.check((select pinned_at is not null from public.sop_pages where id = :'coi'), 'the crew can''t unpin it');
