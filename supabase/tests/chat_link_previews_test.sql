-- Database tests for team chat's link previews (20261129102200_chat_link_previews.sql): only the
-- server reads and writes them, so nobody signed in can read another business's, or dress up a
-- link with a preview of their own making.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema clp;
grant usage on schema clp to authenticated, service_role;
create function clp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function clp.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema clp to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c8ea0000-0000-0000-0000-000000000001', 'kit@birch.test', '{"full_name": "Kit Lowe"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c8ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Birch Tree Care', 'landscaping') as co \gset
commit;

-- The server keeps one.
begin;
set local role service_role;
insert into public.chat_link_previews (company_id, url, ok, title, site_name, image)
values (:'co', 'https://news.example.com/spring', true, 'Spring aeration', 'Lawn News', 'data:image/jpeg;base64,/9j/');
select clp.check((select count(*) from public.chat_link_previews where company_id = :'co') = 1, 'the server keeps a preview');
select clp.expect_error(format('insert into public.chat_link_previews (company_id, url, ok, image) values (%L, %L, true, %L)', :'co', 'https://a.example/', 'https://tracker.example/pixel.gif'),
  'a picture is kept only as a small JPEG of its own, never a link to the site''s');
commit;

-- The owner, signed in, can neither read nor write them.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c8ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select clp.expect_error('select count(*) from public.chat_link_previews', 'nobody signed in reads previews');
select clp.expect_error(format('insert into public.chat_link_previews (company_id, url, ok, title) values (%L, %L, true, %L)', :'co', 'https://bank.example/', 'Your invoice is overdue'), 'or writes one');
select clp.expect_error(format('update public.chat_link_previews set title = %L', 'Changed'), 'or changes one');
select clp.expect_error('delete from public.chat_link_previews', 'or deletes one');
commit;

select clp.check((select title from public.chat_link_previews where company_id = :'co') = 'Spring aeration', 'the kept preview is as the server wrote it');
