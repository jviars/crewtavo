-- Database tests for automation run claims: a worker extends its claim on a run right before doing
-- it, and can't once another worker has claimed the run since. Run with scripts/test-db.sh (plain
-- Postgres + prelude.sql). Any failed check stops with an error.
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
select locked_until as first_claim from public.claim_automation_runs(5, :'co') where id = :'run' \gset
select t25.check(public.extend_automation_run(:'run', :'first_claim'), 'the worker that claimed a run confirms it still has it');
select t25.check((select locked_until > :'first_claim' from public.automation_runs where id = :'run'), 'and gets another five minutes from now');
select t25.check(not public.extend_automation_run(:'run', :'first_claim'), 'the claim it was given is spent once extended');

-- ===== A slow batch whose claim ran out ========================================================
reset role;
update public.automation_runs set locked_until = now() - interval '1 second' where id in (:'run', :'other_run');
set role service_role;
select locked_until as other_claim from public.automation_runs where id = :'other_run' \gset
select t25.check(public.extend_automation_run(:'other_run', :'other_claim'), 'a worker whose claim ran out still gets the run if nobody claimed it since');
select locked_until as stale_claim from public.automation_runs where id = :'run' \gset
select locked_until as second_claim from public.claim_automation_runs(5, :'co') where id = :'run' \gset
select t25.check((select status = 'running' and attempts = 2 and locked_until = :'second_claim' from public.automation_runs where id = :'run'),
  'another worker claims a run whose claim ran out');
select t25.check(not public.extend_automation_run(:'run', :'stale_claim'), 'then the first worker can''t take it back, so the run isn''t done twice');
select t25.check(public.extend_automation_run(:'run', :'second_claim'), 'while the second worker can');

-- ===== Finished runs can't be revived ==========================================================
update public.automation_runs set status = 'done', locked_until = null, finished_at = now() where id = :'run';
select t25.check(not public.extend_automation_run(:'run', :'second_claim'), 'a finished run can''t be picked up again');
reset role;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b8000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t25.expect_error(format('select public.extend_automation_run(%L, now())', :'other_run'), 'only the engine can extend a claim');
commit;

-- Nothing left for other tests' workers to claim.
delete from public.automation_runs where company_id = :'co';

\echo 'All automation claim tests passed.'
