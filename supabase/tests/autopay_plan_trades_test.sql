-- Database tests for the plan trades' autopay terms (20261104000700_autopay_plan_trades): cleaning,
-- pool service and pest control talk about each visit, like lawn care; the other new trades and any
-- trade we don't know get the general words, and paving and roofing keep theirs. A cleaning company
-- that never saved terms has clients agree to its own. (apps/api/test/autopay.test.ts holds core's
-- words to these.)
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema apt;
grant usage on schema apt to authenticated, service_role;
create function apt.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema apt to authenticated, service_role;

\set tail ', and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
-- Plans billed by the month too (20261104000900_monthly_plan_autopay.sql).
\set monthly ', or once a month for a monthly plan'

select apt.check(private.autopay_starter_terms('cleaning') = 'We charge the card on file after each cleaning' || :'monthly' || :'tail', 'cleaning: after each cleaning');
select apt.check(private.autopay_starter_terms('pool_service') = 'We charge the card on file after each pool service visit' || :'monthly' || :'tail', 'pool service: after each pool service visit');
select apt.check(private.autopay_starter_terms('pest_control') = 'We charge the card on file after each treatment' || :'monthly' || :'tail', 'pest control: after each treatment');
select apt.check(private.autopay_starter_terms('lawn_exterior') = 'We charge the card on file after each visit is done' || :'monthly' || :'tail', 'lawn care keeps its words');
select apt.check(private.autopay_starter_terms('paving') like 'We charge the card on file when the work on your job is done, %'
    and private.autopay_starter_terms('roofing_exteriors') = private.autopay_starter_terms('paving'), 'paving and roofing keep theirs');
select apt.check((select bool_and(private.autopay_starter_terms(t) = 'We charge the card on file when each visit or job is done' || :'monthly' || :'tail')
    from unnest(array['general', 'plumbing', 'hvac', 'electrical', 'handyman', 'landscaping', 'snow']) t), 'the other trades get the general words');

-- Sky owns Sky Clean, which never saved terms of its own.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ab670000-0000-0000-0000-000000000001', 'sky@sky-clean.test', '{"full_name": "Sky Clean"}');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "ab670000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Sky Clean', 'cleaning') as co \gset
commit;
select apt.check(private.autopay_terms_shown(:'co') = private.autopay_starter_terms('cleaning') || E'\n\nWe charge at the end of the day of each visit.',
  'a cleaning company''s clients agree to its own starter words');
select apt.check(private.autopay_terms_version(:'co') = 'starter-cleaning-1', 'under its own starter version');

\echo 'All autopay plan trade tests passed.'
