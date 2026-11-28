-- Database tests for searching team chat (20261129102000_chat_search.sql): words match whole, at
-- their start and inside others, in files' names and a voice note's words too; filters by channel,
-- person, what a message has and date; best or newest first; deleted messages never show; and nobody
-- finds anything in a channel they can't read, or in another business. Ctrl+K finds messages too and
-- leaves direct conversations out of its channels.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema csr;
grant usage on schema csr to authenticated, service_role;
create function csr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- What a search finds, in its order: the messages' bodies.
create function csr.found(p_company uuid, p_query text, p_channel uuid default null, p_author uuid default null, p_has text[] default '{}',
  p_after timestamptz default null, p_before timestamptz default null, p_order text default 'newest') returns text[]
language sql as $$
  select coalesce(array_agg(m.body order by s.n), '{}')
  from public.chat_search(p_company, p_query, p_channel, p_author, p_has, p_after, p_before, p_order) with ordinality s (id, channel_id, rank, n)
  join public.chat_messages m on m.id = s.id
$$;
-- Post as someone (the claims must already be theirs), a minute after the last message.
create function csr.post(p_company uuid, p_channel uuid, p_body text, p_attachments jsonb default '[]', p_job uuid default null) returns uuid
language sql as $$
  insert into public.chat_messages (company_id, channel_id, author_id, body, attachments, job_id)
  values (p_company, p_channel, (select auth.uid()), p_body, p_attachments, p_job) returning id
$$;
grant execute on all functions in schema csr to authenticated, service_role;

-- Ana owns Mesa Paving; Omar is office, Lee leads East crew, Kai is on East, Rio is on West. Zed
-- owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c5ea0000-0000-0000-0000-000000000001', 'ana@mesa.test', '{"full_name": "Ana Flores"}'),
  ('c5ea0000-0000-0000-0000-000000000002', 'omar@mesa.test', '{"full_name": "Omar Haddad"}'),
  ('c5ea0000-0000-0000-0000-000000000003', 'lee@mesa.test', '{"full_name": "Lee Chen"}'),
  ('c5ea0000-0000-0000-0000-000000000004', 'kai@mesa.test', '{"full_name": "Kai Moana"}'),
  ('c5ea0000-0000-0000-0000-000000000005', 'rio@mesa.test', '{"full_name": "Rio Santos"}'),
  ('c5ea0000-0000-0000-0000-000000000009', 'zed@other.test', '{"full_name": "Zed Other"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Other Paving', 'paving') as other \gset
select public.chat_set_enabled(:'other', true);
select csr.post(:'other', (select id from public.chat_channels where company_id = :'other' and name = 'general'), 'Gate code and driveway sealcoat at Oak St');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Mesa Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'c5ea0000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'c5ea0000-0000-0000-0000-000000000003', 'crew_lead'),
  (:'co', 'c5ea0000-0000-0000-0000-000000000004', 'field_crew'),
  (:'co', 'c5ea0000-0000-0000-0000-000000000005', 'field_crew');
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'East Crew', 'c5ea0000-0000-0000-0000-000000000003') returning id as east \gset
insert into public.crews (company_id, name) values (:'co', 'West Crew') returning id as west \gset
insert into public.crew_members (company_id, crew_id, user_id) values
  (:'co', :'east', 'c5ea0000-0000-0000-0000-000000000004'),
  (:'co', :'west', 'c5ea0000-0000-0000-0000-000000000005');
insert into public.clients (company_id, display_name) values (:'co', 'Pat Client') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Sealcoat driveway') returning id as job \gset
select csr.check(csr.found(:'co', 'gate') = '{}', 'nothing is found while chat is off');
select public.chat_set_enabled(:'co', true);
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
select id as east_ch from public.chat_channels where company_id = :'co' and name = 'east-crew' \gset
select id as west_ch from public.chat_channels where company_id = :'co' and name = 'west-crew' \gset
select id as office_ch from public.chat_channels where company_id = :'co' and name = 'office' \gset
commit;

-- What was said, each a minute after the one before (backdated below).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select csr.post(:'co', :'office_ch', 'The gate code for the Hill job is 4411, office only') as m_office \gset
select csr.post(:'co', :'general', 'Old words about the yard') as m_edit \gset
select csr.post(:'co', :'general', 'Scanned the permit', jsonb_build_array(jsonb_build_object('path', :'co' || '/chat/' || :'general' || '/5e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b.pdf', 'name', 'invoice-scan.pdf', 'type', 'application/pdf'))) as m_file \gset
select csr.post(:'co', :'general', 'Price list at https://example.com/prices for everyone') as m_link \gset
select csr.post(:'co', :'general', 'This one gets deleted: sealcoat') as m_deleted \gset
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select csr.post(:'co', :'east_ch', 'Sealcoat sealcoat sealcoat, three coats of sealcoat') as m_best \gset
select csr.post(:'co', :'east_ch', 'Fences at **Maple Ct** need a second coat <@c5ea0000-0000-0000-0000-000000000004>') as m_fence \gset
select csr.post(:'co', :'east_ch', 'Driveway crack fill before the sealcoat', '[]', :'job') as m_job \gset
select csr.post(:'co', :'east_ch', '', jsonb_build_array(jsonb_build_object('path', :'co' || '/chat/' || :'east_ch' || '/6e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b.jpg', 'name', 'cracks.jpg'))) as m_photo \gset
select csr.post(:'co', :'east_ch', 'Voice note', jsonb_build_array(jsonb_build_object('path', :'co' || '/chat/' || :'east_ch' || '/7e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b.m4a', 'name', 'Voice note.m4a', 'words', 'Bring the blue tarp tomorrow'))) as m_voice \gset
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select csr.post(:'co', :'west_ch', 'West crew sealcoat is done') as m_west \gset
commit;

-- Spread them out: a minute apart, the office's message a week ago.
set session_replication_role = replica;
update public.chat_messages m set created_at = now() - interval '1 minute' * (20 - array_position(x.ids, m.id))
from (select array[:'m_office', :'m_edit', :'m_file', :'m_link', :'m_deleted', :'m_best', :'m_fence', :'m_job', :'m_photo', :'m_voice', :'m_west']::uuid[] as ids) x
where m.id = any (x.ids);
update public.chat_messages set created_at = now() - interval '7 days' where id = :'m_office';
set session_replication_role = origin;

-- Omar edits one message and deletes another.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.chat_messages set body = 'New words about the yard' where id = :'m_edit';
update public.chat_messages set deleted_at = now() where id = :'m_deleted';
commit;

-- ===== The owner finds everything, by whole words and parts of them ==========================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select csr.check(csr.found(:'co', 'gate') = array['The gate code for the Hill job is 4411, office only'], 'a whole word');
select csr.check(csr.found(:'co', 'GATE CODE') = array['The gate code for the Hill job is 4411, office only'], 'in any case, every word');
select csr.check(csr.found(:'co', 'fenc') = array['Fences at **Maple Ct** need a second coat <@c5ea0000-0000-0000-0000-000000000004>'], 'the start of a word');
select csr.check(csr.found(:'co', 'fence') = csr.found(:'co', 'fences') and cardinality(csr.found(:'co', 'fence')) = 1, 'one word or more of it');
select csr.check(csr.found(:'co', 'riveway') = array['Driveway crack fill before the sealcoat'], 'the middle of a word');
select csr.check(csr.found(:'co', 'maple ct') = array['Fences at **Maple Ct** need a second coat <@c5ea0000-0000-0000-0000-000000000004>'], 'words in bold, as typed');
select csr.check(csr.found(:'co', 'c5ea0000') = '{}', 'not a mention''s hidden id');
select csr.check(csr.found(:'co', 'invoice-scan') = array['Scanned the permit'], 'a file''s name');
select csr.check(csr.found(:'co', 'blue tarp') = array['Voice note'], 'a voice note''s words');
select csr.check(csr.found(:'co', 'cracks') = array['', 'Driveway crack fill before the sealcoat'], 'a photo''s name, newest first');
select csr.check(csr.found(:'co', 'new words') = array['New words about the yard'] and csr.found(:'co', 'old words') = '{}', 'an edited message by what it says now');
select csr.check(not ('This one gets deleted: sealcoat' = any (csr.found(:'co', 'deleted'))) and csr.found(:'co', 'deleted') = '{}', 'never a deleted message');
select csr.check(csr.found(:'co', 'oak') = '{}', 'nothing from another business');
select csr.check(csr.found(:'co', '   ') = '{}' and csr.found(:'co', '%') = '{}', 'nothing for nothing');

-- Newest or best first.
select csr.check(csr.found(:'co', 'sealcoat') = array['West crew sealcoat is done', 'Driveway crack fill before the sealcoat', 'Sealcoat sealcoat sealcoat, three coats of sealcoat'], 'newest first');
select csr.check((csr.found(:'co', 'sealcoat', p_order := 'best'))[1] = 'Sealcoat sealcoat sealcoat, three coats of sealcoat', 'or the best match first');

-- Filters, alone or with words.
select csr.check(csr.found(:'co', 'sealcoat', p_channel := :'east_ch') = array['Driveway crack fill before the sealcoat', 'Sealcoat sealcoat sealcoat, three coats of sealcoat'], 'in one channel');
select csr.check(csr.found(:'co', 'sealcoat', p_author := 'c5ea0000-0000-0000-0000-000000000005') = array['West crew sealcoat is done'], 'from one person');
select csr.check(csr.found(:'co', null, p_has := '{photo}') = array[''], 'with a photo');
select csr.check(csr.found(:'co', null, p_has := '{file}') = array['Scanned the permit'], 'with a file (not a photo or a voice note)');
select csr.check(csr.found(:'co', null, p_has := '{job}') = array['Driveway crack fill before the sealcoat'], 'with a linked job');
select csr.check(csr.found(:'co', null, p_has := '{link}') = array['Price list at https://example.com/prices for everyone'], 'with a link');
select csr.check(csr.found(:'co', 'gate', p_after := now() - interval '1 day') = '{}' and cardinality(csr.found(:'co', 'gate', p_before := now() - interval '1 day')) = 1, 'before or after a day');
select csr.check(cardinality(csr.found(:'co', null, p_author := 'c5ea0000-0000-0000-0000-000000000003')) = 5, 'everything one person said');
select csr.check((select count(*) from public.chat_search(:'co', 'sealcoat', p_limit := 1, p_offset := 1)) = 1
  and (select m.body from public.chat_search(:'co', 'sealcoat', p_limit := 1, p_offset := 1) s join public.chat_messages m on m.id = s.id) = 'Driveway crack fill before the sealcoat', 'a page at a time');
commit;

-- ===== Field crew find only what they can read =================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select csr.check(csr.found(:'co', 'gate') = '{}', 'Kai doesn''t find the office''s gate code');
select csr.check(csr.found(:'co', 'gate', p_channel := :'office_ch') = '{}', 'not even by asking for the office''s channel');
select csr.check((select count(*) from private.chat_search_hits(:'co', 'gate', :'office_ch', null, '{}', null, null, false, 30, 0)) = 0, 'nor by asking the search underneath');
select csr.check(csr.found(:'co', 'sealcoat') = array['Driveway crack fill before the sealcoat', 'Sealcoat sealcoat sealcoat, three coats of sealcoat'], 'his own crew''s, not West''s');
select csr.check(csr.found(:'co', 'permit') = array['Scanned the permit'], 'and the whole team''s');
select csr.check((select count(*) from public.global_search(:'co', 'gate code') where kind = 'chat') = 0, 'Ctrl+K doesn''t show him the office''s message either');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select csr.check(csr.found(:'co', 'gate') = '{}' and csr.found(:'co', null, p_has := '{photo}') = '{}', 'another business finds nothing here');
select csr.check(csr.found(:'other', 'gate') = array['Gate code and driveway sealcoat at Oak St'], 'only its own');
commit;

-- ===== Ctrl+K ===================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select csr.check((select count(*) from public.global_search(:'co', 'gate code') where kind = 'chat' and id = :'m_office' and parent_id = :'office_ch'
  and title = 'The gate code for the Hill job is 4411, office only' and subtitle = '#office · Omar Haddad') = 1, 'Ctrl+K finds a message, with its channel to open it in');
select csr.check((select title from public.global_search(:'co', 'maple') where kind = 'chat') = 'Fences at Maple Ct need a second coat @Kai Moana', 'shown as words, a mention by name');
select csr.check((select count(*) from public.global_search(:'co', 'east') where kind = 'channel') = 1, 'channels are still found');
commit;

-- A direct conversation (once there are any) isn't a channel to jump to.
begin;
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.chat_channels'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.chat_channels drop constraint %I', c);
  end loop;
end $$;
insert into public.chat_channels (company_id, kind, name, category) values (:'co', 'direct', 'east-and-ana', 'Direct') returning id as dm \gset
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5ea0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select csr.check((select count(*) from public.global_search(:'co', 'east') where kind = 'channel' and id = :'dm') = 0, 'Ctrl+K leaves direct conversations out of its channels');
rollback;
