-- Database tests for automation run claims: a worker starts a run it claimed right before doing it,
-- and can't once another worker has claimed the run since; only runs started count as attempts.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t25;
grant usage on schema t25 to authenticated, service_role;
create function t25.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t25.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t25 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b8000000-0000-0000-0000-000000000001', 'owner@sierra.test', '{"full_name": "Sid Sierra"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b8000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Sierra Roofing', 'roofing') as co \gset
commit;
insert into public.automation_rules (company_id, name, trigger, actions)
values (:'co', 'Thank them', 'invoice.paid', '[{"type": "add_note", "body": "Thanked"}]') returning id as rule \gset
insert into public.automation_runs (company_id, rule_id, run_after) values (:'co', :'rule', now() - interval '1 minute') returning id as run \gset
insert into public.automation_runs (company_id, rule_id, run_after) values (:'co', :'rule', now() - interval '1 minute') returning id as other_run \gset

-- ===== The worker that claimed a run keeps it ==================================================
set role service_role;
select claim_token as first_claim from public.claim_automation_runs(5, :'co') where id = :'run' \gset
reset role;
update public.automation_runs set locked_until = now() + interval '1 minute' where id = :'run';
set role service_role;
select t25.check(public.start_automation_run(:'run', :'first_claim'), 'the worker that claimed a run confirms it still has it');
select t25.check((select locked_until > now() + interval '4 minutes' from public.automation_runs where id = :'run'), 'and gets another five minutes from now');
select t25.check(not public.start_automation_run(:'run', gen_random_uuid()), 'a worker with some other claim doesn''t get it');

-- ===== A slow batch whose claim ran out ========================================================
reset role;
update public.automation_runs set locked_until = now() - interval '1 second' where id in (:'run', :'other_run');
set role service_role;
select claim_token as other_claim from public.automation_runs where id = :'other_run' \gset
select t25.check(public.start_automation_run(:'other_run', :'other_claim'), 'a worker whose claim ran out still gets the run if nobody claimed it since');
select claim_token as second_claim from public.claim_automation_runs(5, :'co') where id = :'run' \gset
select t25.check((select status = 'running' and attempts = 1 and claim_token = :'second_claim' and claim_token <> :'first_claim' from public.automation_runs where id = :'run'),
  'another worker claims a run whose claim ran out (claiming it isn''t an attempt; starting it was)');
select t25.check(not public.start_automation_run(:'run', :'first_claim'), 'then the first worker can''t take it back, so the run isn''t done twice');
select t25.check(public.start_automation_run(:'run', :'second_claim'), 'while the second worker can');

-- ===== Finished runs can't be revived ==========================================================
select t25.check(public.finish_automation_run(:'run', :'second_claim', 'done', '[]'), 'the worker holding a run finishes it');
select t25.check(not public.start_automation_run(:'run', :'second_claim'), 'a finished run can''t be picked up again');
reset role;

-- ===== Waiting out a claim doesn't use up attempts =============================================
-- A run tried twice is claimed a third time, and the claim runs out before its turn in the batch.
update public.automation_runs set status = 'pending', attempts = 2, locked_until = null, claim_token = null where id = :'other_run';
set role service_role;
select claim_token as waited_claim from public.claim_automation_runs(5, :'co') where id = :'other_run' \gset
reset role;
update public.automation_runs set locked_until = now() - interval '1 second' where id = :'other_run';
set role service_role;
select t25.check((select count(*) = 1 from public.claim_automation_runs(5, :'co') where id = :'other_run'),
  'a run whose claim ran out before it was started is claimed again, not stopped after 3 attempts');
select claim_token as next_claim from public.automation_runs where id = :'other_run' \gset
select t25.check(not public.start_automation_run(:'other_run', :'waited_claim'), 'the worker that waited too long leaves it');
select t25.check(public.start_automation_run(:'other_run', :'next_claim'), 'and the one that has it now starts it');
select t25.check((select attempts = 3 from public.automation_runs where id = :'other_run'), 'which is its third attempt');
reset role;
update public.automation_runs set locked_until = now() - interval '1 second' where id = :'other_run';
set role service_role;
select t25.check((select count(*) = 0 from public.claim_automation_runs(5, :'co') where id = :'other_run'), 'a run started three times that never finished isn''t claimed again');
select t25.check((select status = 'failed' and error = 'Stopped after 3 attempts' and claim_token is null from public.automation_runs where id = :'other_run'), 'it''s stopped');
reset role;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b8000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t25.expect_error(format('select public.start_automation_run(%L, gen_random_uuid())', :'other_run'), 'only the engine can start a run');
commit;

-- Nothing left for other tests' workers to claim.
delete from public.automation_runs where company_id = :'co';

\echo 'All automation claim tests passed.'
