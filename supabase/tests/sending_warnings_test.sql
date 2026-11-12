-- Database tests for the warning that a company's email or texts have stopped going out: the owners
-- and admins are told once, at once when the sign-in is refused and after a few failures in a row
-- otherwise, and it clears when sending works again.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1155;
grant usage on schema t1155 to authenticated, service_role;
create function t1155.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1155.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t1155 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c6000000-0000-0000-0000-000000000001', 'owner@oscar.test', '{"full_name": "Olga Owner"}'),
  ('c6000000-0000-0000-0000-000000000002', 'admin@oscar.test', '{"full_name": "Ade Admin"}'),
  ('c6000000-0000-0000-0000-000000000003', 'crew@oscar.test', '{"full_name": "Cy Crew"}'),
  ('c6000000-0000-0000-0000-000000000004', 'gone@oscar.test', '{"full_name": "Gil Gone"}'),
  ('c6000000-0000-0000-0000-000000000005', 'owner@papa.test', '{"full_name": "Pat Owner"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c6000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Oscar Roofing', 'roofing') as co \gset
commit;
-- Admin access is given through the server (the admin_grants migration).
insert into public.memberships (company_id, user_id, role, active) values
  (:'co', 'c6000000-0000-0000-0000-000000000002', 'admin', true),
  (:'co', 'c6000000-0000-0000-0000-000000000003', 'field_crew', true),
  (:'co', 'c6000000-0000-0000-0000-000000000004', 'admin', false);
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c6000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select public.create_company('Papa Paving', 'paving') as other \gset
commit;

-- ===== A mail server having a bad minute isn't worth a warning =================================
set role service_role;
select t1155.check(public.note_sending(:'co', 'email', true) is null, 'email that works leaves nothing behind');
select t1155.check((select count(*) = 0 from public.sending_health), 'not even a row');
select t1155.check(public.note_sending(:'co', 'email', false, 'Couldn''t connect to smtp.example.com on port 465.', false, 'Emails aren''t going out', 'The last few emails didn''t go.') is null, 'one email that didn''t go warns nobody');
select t1155.check(public.note_sending(:'co', 'email', false, 'Couldn''t connect to smtp.example.com on port 465.', false, 'Emails aren''t going out', 'The last few emails didn''t go.') is null, 'nor a second');
select t1155.check(public.note_sending(:'co', 'email', false, 'Couldn''t connect to smtp.example.com on port 465.', false, 'Emails aren''t going out', 'The last few emails didn''t go.') is null, 'nor a third in the same minute');
select t1155.check((select failures = 3 and warned_at is null and last_error like 'Couldn''t connect%' from public.sending_health where company_id = :'co' and channel = 'email'), 'they''re counted');
select t1155.check((select count(*) = 0 from public.notifications where company_id = :'co' and kind = 'email_failing'), 'and nobody is told yet');

-- ===== Still failing a while later: the owners and admins are told, once =======================
reset role;
update public.sending_health set failing_since = now() - interval '20 minutes' where company_id = :'co';
set role service_role;
select t1155.check(public.note_sending(:'co', 'email', false, 'Couldn''t connect to smtp.example.com on port 465.', false, 'Emails aren''t going out', 'The last few emails didn''t go. Couldn''t connect to smtp.example.com on port 465. Check Settings → Email.') = 'warned',
  'the next failure, once it has been failing for 15 minutes, warns');
select t1155.check((select count(*) = 2 and count(*) filter (where user_id in ('c6000000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000002')) = 2
    from public.notifications where company_id = :'co' and kind = 'email_failing'),
  'the owner and the admin each get one notification; the crew and an admin who left get none');
select t1155.check((select bool_and(title = 'Emails aren''t going out' and body like 'The last few emails didn''t go. Couldn''t connect to smtp.example.com%' and link = '/settings?tab=email' and read_at is null and delivered_at is null)
    from public.notifications where company_id = :'co' and kind = 'email_failing'),
  'saying what''s wrong and leading to Settings → Email, on the bell and waiting to go out by push');
select t1155.check(public.note_sending(:'co', 'email', false, 'Couldn''t connect to smtp.example.com on port 465.', false, 'Emails aren''t going out', 'Again.') is null, 'the failures after that don''t warn again');
select t1155.check(public.note_sending(:'co', 'email', false, 'The mail server didn''t accept the email address and password (535).', true, 'Emails aren''t going out', 'Again.') is null, 'whatever they are');
select t1155.check((select count(*) = 2 from public.notifications where company_id = :'co' and kind = 'email_failing'), 'so it''s one warning, not one for each email that failed');
select t1155.check((select count(*) = 0 from public.notifications where company_id = :'other'), 'and another company hears nothing of it');

-- ===== It clears when sending works again ======================================================
select t1155.check(public.note_sending(:'co', 'email', true) = 'cleared', 'an email that goes clears it');
select t1155.check((select count(*) = 0 from public.sending_health where company_id = :'co'), 'the failures are forgotten');
select t1155.check((select bool_and(read_at is not null) from public.notifications where company_id = :'co' and kind = 'email_failing'), 'and the warning is marked read: there''s nothing left to fix');
select t1155.check(public.note_sending(:'co', 'email', true) is null, 'the emails after that have nothing to clear');

-- ===== A refused sign-in warns at once, and again the next time ================================
select t1155.check(public.note_sending(:'co', 'email', false, 'Google didn''t accept that sign-in.', true, 'Emails aren''t going out', 'Google didn''t accept that sign-in. Fix it in Settings → Email.') = 'warned',
  'a mailbox whose sign-in is refused warns on the first email');
select t1155.check((select count(*) = 2 from public.notifications where company_id = :'co' and kind = 'email_failing' and read_at is null), 'with a new notification for each of them');

-- ===== Texts are counted on their own ==========================================================
select t1155.check(public.note_sending(:'co', 'sms', true) is null, 'a text that goes doesn''t clear the warning about email');
select t1155.check((select warned_at is not null from public.sending_health where company_id = :'co' and channel = 'email'), 'which still stands');
select t1155.check(public.note_sending(:'co', 'sms', false, 'The text provider refused it (401: Authenticate).', true, null, 'Check the Twilio account.') = 'warned', 'texts that are refused warn too');
select t1155.check((select count(*) = 2 and bool_and(title = 'Texts aren''t going out' and link = '/apps/twilio') from public.notifications where company_id = :'co' and kind = 'texts_failing'),
  'as their own notification, leading to Twilio');
select t1155.expect_error(format('select public.note_sending(%L, %L, false)', :'co', 'fax'), 'only email and texts are kept track of');
reset role;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c6000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t1155.expect_error(format('select public.note_sending(%L, %L, false, null, true)', :'co', 'email'), 'people can''t raise the warning themselves');
select t1155.expect_error('select * from public.sending_health', 'or read how sending is going');
commit;

-- Nothing left for other tests' workers to claim.
delete from public.companies where id in (:'co', :'other');
select t1155.check((select count(*) = 0 from public.sending_health), 'a company that''s deleted takes its record with it');

\echo 'All sending warning tests passed.'
