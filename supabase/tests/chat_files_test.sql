-- Database tests for documents in team chat (20261129100000_chat_files_and_audio.sql, with the
-- Trash and "files in use" of 20261028000300_drive.sql and 20261113001220_files_in_use_both.sql):
-- a message carries a PDF or a spreadsheet from its own channel's folder like a photo, only people
-- who can read the channel open it, it counts as in use while a message has it, and deleting the
-- message keeps it in the Trash's store for 30 days, unlisted, as a chat photo is.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema cfl;
grant usage on schema cfl to authenticated, service_role;
create function cfl.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function cfl.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema cfl to authenticated, service_role;

-- Uma owns Elm Lawn; Vic leads Elm's North crew; Wes is on South.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c7ea0000-0000-0000-0000-000000000001', 'uma@elm.test', '{"full_name": "Uma Diaz"}'),
  ('c7ea0000-0000-0000-0000-000000000002', 'vic@elm.test', '{"full_name": "Vic Hale"}'),
  ('c7ea0000-0000-0000-0000-000000000003', 'wes@elm.test', '{"full_name": "Wes Ito"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Elm Lawn', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c7ea0000-0000-0000-0000-000000000002', 'crew_lead'),
  (:'co', 'c7ea0000-0000-0000-0000-000000000003', 'field_crew');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'North', 'c7ea0000-0000-0000-0000-000000000002') returning id as north \gset
insert into public.crews (company_id, name) values (:'co', 'South') returning id as south \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'south', 'c7ea0000-0000-0000-0000-000000000003');
select public.chat_set_enabled(:'co', true);
select id as north_ch from public.chat_channels where company_id = :'co' and name = 'north' \gset
commit;

select :'co' || '/chat/' || :'north_ch' || '/8e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b.pdf' as pdf \gset
select :'co' || '/chat/' || :'north_ch' || '/9e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b.xlsx' as sheet \gset

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7ea0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into storage.objects (bucket_id, name, owner) values ('files', :'pdf', 'c7ea0000-0000-0000-0000-000000000002'), ('files', :'sheet', 'c7ea0000-0000-0000-0000-000000000002');
insert into public.chat_messages (company_id, channel_id, author_id, body, attachments)
values (:'co', :'north_ch', 'c7ea0000-0000-0000-0000-000000000002', 'Site plan and the mulch order',
  jsonb_build_array(
    jsonb_build_object('path', :'pdf', 'name', 'Site plan.pdf', 'type', 'application/pdf', 'size', 1258291),
    jsonb_build_object('path', :'sheet', 'name', 'Mulch order.xlsx', 'type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'size', 20480)))
returning id as msg \gset
select cfl.check(:'msg' is not null, 'a message carries a PDF and a spreadsheet from its channel''s folder');
select cfl.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, attachments) values (%L, %L, %L, %L)', :'co', :'north_ch', 'c7ea0000-0000-0000-0000-000000000002',
  jsonb_build_array(jsonb_build_object('path', :'co' || '/chat/' || :'north_ch' || '/ae1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b.exe'))), 'but not a program');
select cfl.check((select count(*) from storage.objects where name in (:'pdf', :'sheet')) = 2, 'Vic opens the files in his channel');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7ea0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select cfl.check((select count(*) from storage.objects where name in (:'pdf', :'sheet')) = 0, 'Wes (South) can''t open North''s files');
commit;

select cfl.check(private.stored_path_in_use(:'co', :'pdf') and private.stored_path_in_use(:'co', :'sheet'), 'a file on a message is in use');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c7ea0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.chat_messages set deleted_at = now() where id = :'msg';
commit;

select cfl.check(not private.stored_path_in_use(:'co', :'pdf'), 'once its message is deleted it''s not');
select cfl.check((select count(*) from public.trashed_files where path in (:'pdf', :'sheet') and source = 'chat_file' and source_id = :'msg') = 2, 'and both files are kept in the Trash''s store');
select cfl.check((select size_bytes = 1258291 and content_type = 'application/pdf' and file_name = 'Site plan.pdf' from public.trashed_files where path = :'pdf'), 'with their name, kind and size');
-- Asked for the owner, who sees the most of the Trash.
begin;
select set_config('request.jwt.claims', '{"sub": "c7ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select cfl.check(private.is_member(:'co') and (select bool_and(not private.trashed_file_visible(t)) from public.trashed_files t where path in (:'pdf', :'sheet')), 'unlisted, like a chat photo');
commit;
