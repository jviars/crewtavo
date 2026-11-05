-- Database tests for pictures in guides (20261108000400_guide_pictures.sql): every saved version's
-- pictures count as in use, so the daily sweep never takes one a version shows; only the guide's own
-- company's kb/ files count; and deleting a guide puts the pictures no other guide shows in the Trash.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tgp;
create function tgp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('9e000000-0000-4000-8000-000000000001', 'owner@nova.test', '{"full_name": "Nan Owner"}'),
  ('9e000000-0000-4000-8000-000000000002', 'owner@oslo.test', '{"full_name": "Oz Owner"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9e000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
select public.create_company('Oslo Paving', 'paving') as other \gset
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9e000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select public.create_company('Nova Paving', 'paving') as co \gset
commit;
reset role;

-- Its own kb/ picture counts; another company's, and one outside kb/, don't.
\set cones :co'/kb/7c0a0000-0000-4000-8000-000000000001.jpg'
\set board :co'/kb/7c0a0000-0000-4000-8000-000000000002.jpg'
\set theirs :other'/kb/7c0a0000-0000-4000-8000-000000000003.jpg'
\set receipt :co'/receipts/7c0a0000-0000-4000-8000-000000000004.jpg'
insert into public.sop_pages (company_id, title, body, body_html) values (:'co', 'Working near traffic', '{}',
  format('<p>Set the cones.</p><img data-path="%s" alt="Cones"><img data-path="%s"><img data-path="%s"><img src="https://example.com/x.png">', :'cones', :'theirs', :'receipt'))
  returning id as traffic \gset
select tgp.check((select array_agg(path) from private.sop_pictures where page_id = :'traffic') = array[:'cones'], 'a version''s own kb/ pictures are recorded, nothing else');
select tgp.check(private.stored_path_in_use(:'co', :'cones'), 'so the sweep leaves them');
select tgp.check(not private.stored_path_in_use(:'co', :'board'), 'a picture nothing shows isn''t in use');

-- Taken out of the guide: the older version still shows it.
update public.sop_pages set body = '{"v": 2}', body_html = format('<p>Set the cones.</p><img data-path="%s">', :'board') where id = :'traffic';
select tgp.check(private.stored_path_in_use(:'co', :'cones') and private.stored_path_in_use(:'co', :'board'), 'a picture taken out stays for the version that shows it, and the new one counts');

-- A copy shows the same picture.
insert into public.sop_pages (company_id, title, body, body_html) values (:'co', 'Working near traffic (copy)', '{}', format('<img data-path="%s">', :'board'))
  returning id as copy \gset

delete from public.sop_pages where id = :'traffic';
select tgp.check((select count(*) from private.sop_pictures where page_id = :'traffic') = 0, 'a deleted guide''s pictures stop counting as its');
select tgp.check((select array_agg(path order by path) from public.trashed_files where company_id = :'co') = array[:'cones'], 'the pictures only it showed go to the Trash, not one a copy still shows');
select tgp.check((select label from public.trashed_files where path = :'cones') = 'Guide picture · Working near traffic', 'labelled as the guide''s picture');
select tgp.check(private.stored_path_in_use(:'co', :'board'), 'the copy''s picture is still in use');

delete from public.sop_pages where id = :'copy';
select tgp.check(exists (select 1 from public.trashed_files where path = :'board'), 'and goes to the Trash with the last guide that shows it');
