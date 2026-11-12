-- Database tests for delivering notifications: one is delivered only once it has gone out, two
-- workers never hold the same one, a claim that runs out is picked up again, what went by one channel
-- isn't sent by it twice, a failed one waits and is tried again up to 8 times or until it's too old,
-- and the release before this one keeps working next to it without sending anything twice.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1154;
grant usage on schema t1154 to authenticated, service_role;
create function t1154.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1154.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t1154 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c5000000-0000-0000-0000-000000000001', 'owner@november.test', '{"full_name": "Nia Owner"}'),
  ('c5000000-0000-0000-0000-000000000002', 'cal@november.test', '{"full_name": "Cal Crew"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('November Lawn', 'lawn') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'c5000000-0000-0000-0000-000000000002', 'field_crew');
commit;

-- Other tests' notifications are out of the way: a claim takes the oldest first, whoever's they are.
update public.notifications set delivered_at = now() where delivered_at is null;

-- What's there when the update arrives: history already marked delivered, and one waiting.
insert into public.notifications (company_id, user_id, kind, title, created_at, delivered_at)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'quote', 'Sent last week', now() - interval '7 days', now() - interval '7 days') returning id as history \gset
insert into public.notifications (company_id, user_id, kind, title, created_at)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'quote', 'Quote approved', now() - interval '2 minutes') returning id as n1 \gset
insert into public.notifications (company_id, user_id, kind, title, created_at)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'invoice', 'Invoice paid', now() - interval '2 minutes') returning id as n2 \gset
insert into public.notifications (company_id, user_id, kind, title)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'quote', 'Made just now') returning id as fresh \gset

-- ===== Claimed isn't delivered, and two workers never hold the same one ========================
set role service_role;
select delivery_token as w1 from public.claim_notification_deliveries(45, 200) where id = :'n1' \gset
select t1154.check((select count(*) = 2 from public.notifications where delivery_token = :'w1'), 'a worker claims what''s waiting, and nothing already delivered or made a moment ago');
select t1154.check((select delivered_at is null and delivery_locked_until > now() + interval '4 minutes' and delivery_attempts = 0 from public.notifications where id = :'n1'),
  'a claimed notification isn''t delivered yet: it''s held for five minutes');
select t1154.check((select count(*) = 0 from public.claim_notification_deliveries(45, 200)), 'a second worker claiming at the same moment gets none of them');
select t1154.check((select count(*) = 0 from public.claim_notifications(45, 200)), 'and neither does the release before this one, still running during an update');
select t1154.check((select delivered_at is null from public.notifications where id = :'n1'), 'which leaves them undelivered');

-- ===== Started, sent by one channel, then the rest =============================================
select t1154.check((select count(*) = 0 from public.start_notification_deliveries(gen_random_uuid(), array[:'n1', :'n2']::uuid[])), 'a worker with some other claim can''t start them');
select t1154.check((select count(*) = 2 from public.start_notification_deliveries(:'w1', array[:'n1', :'n2', :'history']::uuid[])), 'the worker that claimed them starts them right before sending');
select t1154.check((select delivery_attempts = 1 from public.notifications where id = :'n1'), 'which is the first attempt');
select t1154.check(public.note_notification_channel(:'w1', array[:'n1', :'n2']::uuid[], 'push', 'sent') = 2, 'a push that went is written down as it goes');
select t1154.expect_error(format('select public.note_notification_channel(%L, array[%L]::uuid[], %L, %L)', :'w1', :'n1', 'fax', 'sent'), 'only by a channel there is');
select t1154.check(public.settle_notification_deliveries(:'w1', array[:'n2']::uuid[]) = 1, 'one with nothing left to send is settled');
select t1154.check((select delivered_at is not null and delivery_token is null and delivery = '{"push": "sent"}' from public.notifications where id = :'n2'), 'and only then is it delivered');

-- ===== One that failed waits and is tried again, only by what's missing ========================
select t1154.check(public.settle_notification_deliveries(:'w1', '{}', array[:'n1']::uuid[], '{}', 'Email: Couldn''t connect to smtp.example.com on port 465.') = 1, 'one whose email didn''t go is put back to try again');
select t1154.check((select delivered_at is null and delivery_failed_at is null and delivery_token is null and delivery_error like 'Email: Couldn''t connect%'
    and deliver_after between now() + interval '1 minute' and now() + interval '3 minutes' from public.notifications where id = :'n1'),
  'it isn''t delivered and isn''t failed: it waits two minutes, with the reason on it');
select t1154.check((select count(*) = 0 from public.claim_notification_deliveries(45, 200)), 'nobody claims it while it waits');
select t1154.check((select count(*) = 0 from public.claim_notifications(0, 200) where id = :'n1'), 'and the release before this one leaves it alone, so its push doesn''t go twice');
reset role;
update public.notifications set deliver_after = now() - interval '1 second' where id = :'n1';
set role service_role;
select delivery_token as w2 from public.claim_notification_deliveries(45, 200) where id = :'n1' \gset
select t1154.check((select delivery = '{"push": "sent"}' from public.start_notification_deliveries(:'w2', array[:'n1']::uuid[])), 'when its wait is over it''s claimed again, and starting it says its push already went');
select t1154.check(public.settle_notification_deliveries(:'w2', '{}', array[:'n1']::uuid[], '{}', 'Email: still down') = 1, 'a second failure');
select t1154.check((select deliver_after between now() + interval '3 minutes' and now() + interval '5 minutes' and delivery_attempts = 2 from public.notifications where id = :'n1'), 'waits four minutes');

-- ===== A worker that died partway: its claim runs out =========================================
reset role;
update public.notifications set deliver_after = now() - interval '1 second' where id = :'n1';
set role service_role;
select delivery_token as w3 from public.claim_notification_deliveries(45, 200) where id = :'n1' \gset
select t1154.check((select count(*) = 1 from public.start_notification_deliveries(:'w3', array[:'n1']::uuid[])), 'a worker starts it');
select t1154.check((select count(*) = 0 from public.claim_notification_deliveries(45, 200)), 'and while its five minutes last, nobody else can claim it');
reset role;
update public.notifications set delivery_locked_until = now() - interval '1 second' where id = :'n1';
set role service_role;
select delivery_token as w4 from public.claim_notification_deliveries(45, 200) where id = :'n1' \gset
select t1154.check(:'w4' <> :'w3', 'once its claim runs out (the server was restarted mid-batch), another worker claims it');
reset role;
update public.notifications set delivery_locked_until = now() + interval '1 minute' where id = :'n1';
set role service_role;
select t1154.check(public.note_notification_channel(:'w3', array[:'n1']::uuid[], 'email', 'sent') = 1, 'if the first worker was only slow, the email it got out is still written down');
select t1154.check((select delivery_locked_until < now() + interval '2 minutes' from public.notifications where id = :'n1'), 'without giving the second worker''s claim more time');
select t1154.check(public.note_notification_channel(:'w4', array[:'n1']::uuid[], 'push', 'sent') = 1, 'while for the worker that holds it, writing one down');
select t1154.check((select delivery_locked_until > now() + interval '4 minutes' from public.notifications where id = :'n1'), 'gives it five more minutes');
select t1154.check((select count(*) = 0 from public.start_notification_deliveries(:'w3', array[:'n1']::uuid[])), 'the first worker can''t start it again');
select t1154.check(public.settle_notification_deliveries(:'w3', array[:'n1']::uuid[]) = 0, 'or settle it over the second worker');
select t1154.check((select delivery = '{"push": "sent", "email": "sent"}' from public.start_notification_deliveries(:'w4', array[:'n1']::uuid[])), 'and the second worker is told the email went, so it doesn''t send it again');
select t1154.check(public.settle_notification_deliveries(:'w4', array[:'n1']::uuid[]) = 1, 'it has nothing left to send, and settles it');
select t1154.check((select delivered_at is not null and delivery_error is null from public.notifications where id = :'n1'), 'delivered');
select t1154.check((select count(*) = 0 from public.claim_notification_deliveries(0, 200) where id in (:'n1', :'n2', :'history')), 'and a delivered notification is never claimed again');

-- ===== Up to 8 tries ==========================================================================
reset role;
update public.notifications set delivered_at = now() where id = :'fresh';
insert into public.notifications (company_id, user_id, kind, title, created_at, delivery_attempts)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'quote', 'Tried seven times', now() - interval '3 hours', 7) returning id as tired \gset
insert into public.notifications (company_id, user_id, kind, title, created_at)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'quote', 'Bad address', now() - interval '2 minutes') returning id as bad \gset
set role service_role;
select delivery_token as w5 from public.claim_notification_deliveries(45, 200) where id = :'tired' \gset
select t1154.check((select count(*) = 2 from public.start_notification_deliveries(:'w5', array[:'tired', :'bad']::uuid[])), 'the eighth try starts');
select t1154.check(public.settle_notification_deliveries(:'w5', '{}', array[:'tired']::uuid[], array[:'bad']::uuid[], 'Email: The mail server didn''t accept the email address and password (535).') = 2, 'and fails like the others');
select t1154.check((select delivery_failed_at is not null and delivered_at is null and deliver_after is null and delivery_error like 'Email: The mail server didn''t accept%' from public.notifications where id = :'tired'),
  'after 8 tries it''s recorded as failed, with the reason, and not delivered');
select t1154.check((select delivery_failed_at is not null and delivery_attempts = 1 from public.notifications where id = :'bad'), 'one that can''t go at all (an address that doesn''t exist) is failed on the first try');
select t1154.check((select count(*) = 0 from public.claim_notification_deliveries(0, 200)), 'failed ones are never claimed again');
select t1154.check((select count(*) = 0 from public.claim_notifications(0, 200) where id in (:'tired', :'bad')), 'by the release before this one either');
reset role;
-- A server that dies every time it starts one: the eighth start never finished.
insert into public.notifications (company_id, user_id, kind, title, created_at, delivery_attempts, delivery_token, delivery_locked_until)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'quote', 'Crashes the worker', now() - interval '1 hour', 8, gen_random_uuid(), now() - interval '1 second') returning id as crashy \gset
set role service_role;
select t1154.check((select count(*) = 0 from public.claim_notification_deliveries(0, 200)), 'one started 8 times that never finished isn''t claimed again');
select t1154.check((select delivery_failed_at is not null and delivery_error = 'Stopped after 8 attempts' from public.notifications where id = :'crashy'), 'it''s recorded as failed');

-- ===== Not absurdly late ======================================================================
reset role;
insert into public.notifications (company_id, user_id, kind, title, created_at) values
  (:'co', 'c5000000-0000-0000-0000-000000000002', 'time', 'Your clock has been running 10 hours', now() - interval '3 hours'),
  (:'co', 'c5000000-0000-0000-0000-000000000002', 'schedule', 'You''re on Smith mowing: Thu Nov 12, 7:00 AM', now() - interval '7 hours'),
  (:'co', 'c5000000-0000-0000-0000-000000000002', 'visit', 'Visit tomorrow: Smith mowing', now() - interval '7 hours'),
  (:'co', 'c5000000-0000-0000-0000-000000000002', 'invoice', 'Invoice paid two days ago', now() - interval '2 days');
insert into public.notifications (company_id, user_id, kind, title, created_at)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'invoice', 'Invoice paid this morning', now() - interval '7 hours') returning id as morning \gset
insert into public.notifications (company_id, user_id, kind, title, created_at)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'time', 'Your clock has been running 11 hours', now() - interval '110 minutes') returning id as clock \gset
set role service_role;
select delivery_token as w6 from public.claim_notification_deliveries(45, 200) where id = :'morning' \gset
select t1154.check((select count(*) = 2 from public.notifications where delivery_token = :'w6'), 'after the server was off for hours, only what''s still worth sending is claimed');
select t1154.check((select count(*) = 4 from public.notifications where company_id = :'co' and delivery_failed_at is not null and delivered_at is null and delivery_error = 'Too old to send'),
  'a clock reminder after 2 hours, a schedule change or visit reminder after 6, and anything after a day are recorded as failed, not sent');
select t1154.check((select count(*) = 2 from public.start_notification_deliveries(:'w6', array[:'morning', :'clock']::uuid[])), 'the two start');
select t1154.check(public.settle_notification_deliveries(:'w6', '{}', array[:'morning', :'clock']::uuid[], '{}', 'Text: Couldn''t reach the text provider. Try again.') = 2, 'and fail');
select t1154.check((select delivery_failed_at is null and deliver_after is not null from public.notifications where id = :'morning'), 'one with time left waits for another try');
reset role;
-- Its fifth try, 110 minutes in: the next would come 32 minutes later, past its 2 hours.
update public.notifications set delivery_failed_at = null, deliver_after = null, delivery_attempts = 4 where id = :'clock';
set role service_role;
select delivery_token as w7 from public.claim_notification_deliveries(45, 200) where id = :'clock' \gset
select t1154.check((select count(*) = 1 from public.start_notification_deliveries(:'w7', array[:'clock']::uuid[])), 'a clock reminder on its fifth try');
select t1154.check(public.settle_notification_deliveries(:'w7', '{}', array[:'clock']::uuid[], '{}', 'Push: Their phone''s push service didn''t answer.') = 1, 'fails again');
select t1154.check((select delivery_failed_at is not null and deliver_after is null from public.notifications where id = :'clock'), 'and is failed now: its next try would come after it''s too old to send');
reset role;

-- ===== The release before this one, during an update ===========================================
insert into public.notifications (company_id, user_id, kind, title, created_at)
values (:'co', 'c5000000-0000-0000-0000-000000000002', 'quote', 'Claimed by the old release', now() - interval '2 minutes') returning id as old1 \gset
set role service_role;
select t1154.check((select count(*) = 1 from public.claim_notifications(45, 200) where id = :'old1'), 'the release before this one still claims what nobody has touched, as it always did');
select t1154.check((select delivered_at is not null from public.notifications where id = :'old1'), 'marking it delivered as it claims it');
select t1154.check((select count(*) = 0 from public.claim_notification_deliveries(0, 200) where id = :'old1'), 'so this release never sends it too');
reset role;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t1154.expect_error('select public.claim_notification_deliveries(0, 10)', 'people can''t claim deliveries');
select t1154.expect_error(format('select public.start_notification_deliveries(gen_random_uuid(), array[%L]::uuid[])', :'morning'), 'or start them');
select t1154.expect_error(format('select public.note_notification_channel(gen_random_uuid(), array[%L]::uuid[], %L, %L)', :'morning', 'email', 'sent'), 'or say one went');
select t1154.expect_error(format('select public.settle_notification_deliveries(gen_random_uuid(), array[%L]::uuid[])', :'morning'), 'or settle them');
commit;

-- ===== A schedule change joins a notification only until it starts going out ===================
update public.notifications set delivered_at = now() where delivered_at is null and delivery_failed_at is null;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.visits (company_id, title, kind, starts_at, ends_at) values (:'co', 'Smith mowing', 'task', date_trunc('day', now()) + interval '3 days 12 hours', date_trunc('day', now()) + interval '3 days 14 hours') returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'c5000000-0000-0000-0000-000000000002');
update public.visits set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = :'visit';
commit;
select t1154.check((select count(*) = 1 and min(title) = '2 changes to your schedule' from public.notifications where company_id = :'co' and kind = 'schedule' and delivered_at is null and delivery_failed_at is null),
  'changes made before it starts going out still fold into one notification');
set role service_role;
select delivery_token as w8 from public.claim_notification_deliveries(0, 200) where kind = 'schedule' \gset
select id as folded from public.notifications where delivery_token = :'w8' \gset
select t1154.check((select count(*) = 1 from public.start_notification_deliveries(:'w8', array[:'folded']::uuid[])), 'it starts going out');
select t1154.check(public.note_notification_channel(:'w8', array[:'folded']::uuid[], 'push', 'sent') = 1, 'its push goes');
select t1154.check(public.settle_notification_deliveries(:'w8', '{}', array[:'folded']::uuid[], '{}', 'Email: Couldn''t connect.') = 1, 'and its email waits for another try');
reset role;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c5000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.visits set starts_at = starts_at + interval '2 hours', ends_at = ends_at + interval '2 hours' where id = :'visit';
commit;
select t1154.check((select count(*) = 1 from public.notifications where id = :'folded'), 'a change made after that leaves it be (replacing it would push the first two changes again)');
select t1154.check((select count(*) = 1 and min(body) like '%now starts%' from public.notifications where company_id = :'co' and kind = 'schedule' and id <> :'folded' and delivered_at is null and delivery_failed_at is null),
  'and starts a new notification of its own');

-- Nothing left for other tests' workers to claim.
delete from public.companies where id = :'co';

\echo 'All notification delivery tests passed.'
