-- Database tests for 20261019001020_send_claims.sql: automation runs and campaign recipients are
-- claimed with a token and an expiry on the database's clock; a worker renews its claim before each
-- email and can't once another has claimed the row since; finishing, failing, skipping and putting
-- rows back only touch rows the worker still holds; and an older release's campaign run can't mark
-- a campaign sent while recipients are still waiting.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t83;
grant usage on schema t83 to anon, authenticated, service_role;
create function t83.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t83.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t83 to anon, authenticated, service_role;
-- A second connection, to claim at the same time as this one (dblink may already be installed).
set client_min_messages = warning;
create extension if not exists dblink schema t83;
reset client_min_messages;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset
create table t83.claims (claimer text not null, id bigint not null, token uuid not null);
grant all on t83.claims to service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d8300000-0000-0000-0000-000000000001', 'owner@tango.test', '{"full_name": "Tia Tango"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d8300000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Tango Tree Care', 'general') as co \gset
insert into public.clients (company_id, display_name, email)
select :'co', 'Client ' || n, 'client' || n || '@example.com' from generate_series(1, 6) n;
insert into public.campaigns (company_id, name, subject, body) values (:'co', 'Spring pruning', 'Book your pruning', 'Hi {{client.first_name}}, spring is here.') returning id as camp \gset
commit;
insert into public.automation_rules (company_id, name, trigger, actions)
values (:'co', 'Say thanks', 'invoice.paid', '[{"type": "send_email", "subject": "Thanks", "body": "Thank you"}, {"type": "add_note", "body": "Thanked"}]') returning id as rule \gset
insert into public.automation_runs (company_id, rule_id, run_after)
select :'co', :'rule', now() - interval '1 minute' from generate_series(1, 6);

-- ===== Automation runs: two workers at once ====================================================
-- The other connection claims two runs and is still doing them (uncommitted) while this one claims.
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select :"dbl".dblink_exec('other', 'begin; set role service_role');
insert into t83.claims select 'other', id, token
  from :"dbl".dblink('other', format('select id, claim_token from public.claim_automation_runs(2, %L)', :'co')) as t(id bigint, token uuid);
set role service_role;
insert into t83.claims select 'this', id, claim_token from public.claim_automation_runs(2, :'co');
reset role;
select :"dbl".dblink_exec('other', 'commit');
select :"dbl".dblink_disconnect('other');
select t83.check((select count(*) from t83.claims where claimer = 'other') = 2 and (select count(*) from t83.claims where claimer = 'this') = 2, 'two workers claiming at once each get their own runs');
select t83.check((select count(distinct id) from t83.claims) = 4, 'never the same run');
select t83.check((select count(distinct token) from t83.claims where claimer = 'this') = 1 and (select count(distinct token) from t83.claims) = 2,
  'each claim has its own token, shared by the runs it took');
select t83.check((select bool_and(r.locked_until > now() + interval '4 minutes' and r.locked_until <= now() + interval '5 minutes' and r.attempts = 0)
                  from public.automation_runs r join t83.claims c on c.id = r.id),
  'and lasts five minutes on the database''s clock; claiming isn''t an attempt');

select id as run, token as claim from t83.claims where claimer = 'this' order by id limit 1 \gset
select id as other_run, token as other_claim from t83.claims where claimer = 'other' order by id limit 1 \gset

-- ===== Starting and renewing ===================================================================
set role service_role;
select t83.check(not public.start_automation_run(:'run', :'other_claim'), 'a worker can''t start a run another worker claimed');
select t83.check(public.start_automation_run(:'run', :'claim'), 'the worker that claimed it can');
select t83.check((select attempts = 1 from public.automation_runs where id = :'run'), 'which counts an attempt');
select t83.check(public.renew_automation_run(:'run', :'claim', '[{"type": "send_email", "ok": true, "detail": "Emailed"}]'), 'before its next action the worker renews its claim');
select t83.check((select result -> 0 ->> 'detail' = 'Emailed' and attempts = 1 and locked_until > now() + interval '4 minutes' from public.automation_runs where id = :'run'),
  'which keeps what''s done so far and gives five more minutes, without another attempt');
select t83.check(not public.renew_automation_run(:'run', :'other_claim', '[]'), 'another worker can''t renew it');
select t83.check((select result -> 0 ->> 'detail' = 'Emailed' from public.automation_runs where id = :'run'), 'or overwrite what was done');

-- ===== A claim that ran out ====================================================================
-- The worker's email took longer than its claim, and another worker claimed the run since.
reset role;
update public.automation_runs set locked_until = now() - interval '1 second' where id = :'run';
set role service_role;
select claim_token as second_claim from public.claim_automation_runs(10, :'co') where id = :'run' \gset
select t83.check(:'second_claim' <> :'claim', 'another worker claims a run whose claim ran out, with a new token');
select t83.check((select result -> 0 ->> 'detail' = 'Emailed' from public.automation_runs where id = :'run'), 'and sees what the first one did, so it isn''t done again');
select t83.check(not public.renew_automation_run(:'run', :'claim', '[]'), 'the first worker can''t renew its claim any more');
select t83.check(not public.finish_automation_run(:'run', :'claim', 'done', '[]'), 'or finish the run');
select t83.check((select status = 'running' and claim_token = :'second_claim' and attempts = 1 and finished_at is null from public.automation_runs where id = :'run'),
  'which stays the second worker''s, its attempts as they were');
select t83.check(public.start_automation_run(:'run', :'second_claim'), 'the second worker starts it');
select t83.check(public.finish_automation_run(:'run', :'second_claim', 'failed', '[{"type": "add_note", "ok": false, "detail": "No client"}]', 'No client'),
  'and finishes it');
select t83.check((select status = 'failed' and error = 'No client' and finished_at is not null and claim_token is null and locked_until is null from public.automation_runs where id = :'run'),
  'with its outcome');
select t83.check(not public.finish_automation_run(:'run', :'second_claim', 'done', '[]'), 'which is only recorded once');
select t83.expect_error(format('select public.finish_automation_run(%L, %L, %L, %L)', :'other_run', :'other_claim', 'pending', '[]'), 'a run finishes as done, skipped or failed');

-- ===== Runs a stopped batch didn't get to ======================================================
select t83.check(public.release_automation_runs(:'other_claim', (select array_agg(id) from t83.claims where claimer = 'this')) = 0,
  'a worker can''t put back runs another worker holds');
select t83.check(public.release_automation_runs(:'other_claim', (select array_agg(id) from t83.claims where claimer = 'other')) = 2,
  'the one holding them puts back the runs it didn''t start');
select t83.check((select bool_and(status = 'pending' and claim_token is null and locked_until is null and attempts = 0) from public.automation_runs
                  where id in (select id from t83.claims where claimer = 'other')),
  'they wait again without using an attempt');
select t83.check((select count(*) = 2 from public.claim_automation_runs(10, :'co') where id in (select id from t83.claims where claimer = 'other')),
  'and the next batch takes them right away');
reset role;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d8300000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t83.expect_error(format('select public.renew_automation_run(%L, %L, %L)', :'other_run', :'other_claim', '[]'), 'only the engine renews claims');
select t83.expect_error(format('select public.finish_automation_run(%L, %L, %L, %L)', :'other_run', :'other_claim', 'done', '[]'), 'or finishes runs');
select t83.expect_error(format('select public.release_automation_runs(%L, array[%s]::bigint[])', :'other_claim', :'other_run'), 'or puts them back');
commit;
delete from public.automation_runs where company_id = :'co';

-- ===== Campaign recipients =====================================================================
insert into public.campaign_recipients (company_id, campaign_id, client_id, email, name)
select company_id, :'camp', id, email, display_name from public.clients where company_id = :'co';
update public.campaigns set status = 'sending', recipients_count = 6 where id = :'camp';
delete from t83.claims;

set role service_role;
insert into t83.claims select 'first', id, claim_token from public.claim_campaign_recipients(:'camp', 3);
insert into t83.claims select 'second', id, claim_token from public.claim_campaign_recipients(:'camp', 3);
select t83.check((select count(distinct id) = 6 and count(distinct token) = 2 from t83.claims), 'two runs each claim their own recipients, each with a token');
select t83.check((select bool_and(r.status = 'sending' and r.locked_until > now() + interval '4 minutes' and r.locked_until <= now() + interval '5 minutes')
                  from public.campaign_recipients r where r.campaign_id = :'camp'),
  'claims last five minutes on the database''s clock');
select id as r1, token as first_claim from t83.claims where claimer = 'first' order by id limit 1 \gset
select id as r2 from t83.claims where claimer = 'first' order by id offset 1 limit 1 \gset
select id as r3 from t83.claims where claimer = 'first' order by id offset 2 limit 1 \gset
select id as r4, token as second_claim from t83.claims where claimer = 'second' order by id limit 1 \gset

select t83.check(public.renew_campaign_recipient(:'r1', :'first_claim'), 'right before an email the run renews its claim on that recipient');
select t83.check(not public.renew_campaign_recipient(:'r4', :'first_claim'), 'it can''t on a recipient another run claimed');
select t83.check(public.finish_campaign_recipients(:'first_claim', array[:'r1']::bigint[], 'sent') = 1, 'the run records the email it sent');
select t83.check((select status = 'sent' and sent_at is not null and error is null and claim_token is null from public.campaign_recipients where id = :'r1'), 'as sent');
select t83.check(public.finish_campaign_recipients(:'second_claim', array[:'r1', :'r2']::bigint[], 'failed', 'Not sent') = 0, 'another run can''t record them');
select t83.check(not public.renew_campaign_recipient(:'r1', :'first_claim'), 'and a recipient once recorded isn''t emailed again');

-- The first run's mail server is slow: by r2 its claim has run out and a third run claimed it.
reset role;
update public.campaign_recipients set locked_until = now() - interval '1 second' where id in (:'r2', :'r3');
set role service_role;
select claim_token as third_claim from public.claim_campaign_recipients(:'camp', 25) where id = :'r2' \gset
select t83.check((select count(*) = 2 from public.campaign_recipients where claim_token = :'third_claim'), 'a third run claims the recipients whose claims ran out, and only those');
select t83.check(not public.renew_campaign_recipient(:'r2', :'first_claim'), 'so the slow run can''t renew them');
select t83.check(public.finish_campaign_recipients(:'first_claim', array[:'r2']::bigint[], 'sent') = 0, 'or record them');
select t83.check((select status = 'sending' and claim_token = :'third_claim' from public.campaign_recipients where id = :'r2'), 'they stay the third run''s');
select t83.check(public.release_campaign_recipients(:'first_claim', array[:'r2', :'r3']::bigint[]) = 0, 'nor can it put them back');
select t83.check(public.release_campaign_recipients(:'third_claim', array[:'r3']::bigint[]) = 1, 'the run holding one it didn''t email puts it back');
select t83.check((select status = 'pending' and claim_token is null and locked_until is null and claimed_at is null from public.campaign_recipients where id = :'r3'), 'for the next run');

-- Stop is pressed while r2's email is going out: the email that went is still recorded.
reset role;
update public.campaign_recipients set status = 'skipped', error = 'Campaign stopped' where campaign_id = :'camp' and status in ('pending', 'sending');
set role service_role;
select t83.check(not public.renew_campaign_recipient(:'r4', :'second_claim'), 'after Stop no further email starts');
select t83.check(public.finish_campaign_recipients(:'third_claim', array[:'r2']::bigint[], 'sent') = 1, 'but the one already going is recorded');
select t83.check((select status = 'sent' and sent_at is not null and error is null from public.campaign_recipients where id = :'r2'), 'as sent');
select t83.check((select status = 'skipped' from public.campaign_recipients where id = :'r3'), 'while one nobody held stays skipped');
select t83.expect_error(format('select public.finish_campaign_recipients(%L, array[%s]::bigint[], %L)', :'second_claim', :'r4', 'pending'), 'a recipient is sent, failed or skipped');
reset role;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d8300000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t83.expect_error(format('select public.renew_campaign_recipient(%L, %L)', :'r4', :'second_claim'), 'only the server renews a claim');
select t83.expect_error(format('select public.finish_campaign_recipients(%L, array[%s]::bigint[], %L)', :'second_claim', :'r4', 'sent'), 'or records an email');
select t83.expect_error(format('select public.release_campaign_recipients(%L, array[%s]::bigint[])', :'second_claim', :'r4'), 'or puts a recipient back');
commit;
begin;
set local role anon;
select t83.expect_error(format('select public.renew_campaign_recipient(%L, %L)', :'r4', :'second_claim'), 'nor can anyone signed out');
commit;

-- ===== Next to an older release's run ==========================================================
-- 0.1.1 emails 'pending' recipients without claiming them, then marks the campaign sent once none
-- are 'pending'.
update public.campaign_recipients set status = 'pending', error = null, sent_at = null, claimed_at = null, locked_until = null, claim_token = null where campaign_id = :'camp';
update public.campaigns set status = 'sending', finished_at = null where id = :'camp';
set role service_role;
select claim_token as new_claim from public.claim_campaign_recipients(:'camp', 2) limit 1 \gset
update public.campaign_recipients set status = 'sent', sent_at = now() where campaign_id = :'camp' and status = 'pending';
update public.campaigns set sent_count = 4, failed_count = 0, status = 'sent', finished_at = now() where id = :'camp' and status = 'sending';
select t83.check((select status = 'sending' and finished_at is null and sent_count = 4 from public.campaigns where id = :'camp'),
  'an older run can''t mark a campaign sent while this release is still emailing some of it (its counts still go in)');
select t83.check(public.renew_campaign_recipient((select id from public.campaign_recipients where claim_token = :'new_claim' order by id limit 1), :'new_claim'),
  'so the newer run carries on');

-- After going back to 0.1.1, claims a stopped newer run left behind go back to the queue it reads.
reset role;
update public.campaign_recipients set locked_until = now() - interval '1 second' where claim_token = :'new_claim';
set role service_role;
update public.campaigns set sent_count = 4, failed_count = 0, status = 'sent', finished_at = now() where id = :'camp' and status = 'sending';
select t83.check((select count(*) = 2 from public.campaign_recipients where campaign_id = :'camp' and status = 'pending' and claim_token is null),
  'claims that ran out are put back when a run refreshes the campaign''s counts');
select t83.check((select status = 'sending' from public.campaigns where id = :'camp'), 'and the campaign keeps sending');
update public.campaign_recipients set status = 'sent', sent_at = now() where campaign_id = :'camp' and status = 'pending';
update public.campaigns set sent_count = 6, failed_count = 0, status = 'sent', finished_at = now() where id = :'camp' and status = 'sending';
select t83.check((select status = 'sent' and finished_at is not null and sent_count = 6 from public.campaigns where id = :'camp'), 'until everyone''s been emailed');
reset role;

delete from public.companies where id = :'co';
\echo 'All send claim tests passed.'
