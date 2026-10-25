-- Database tests for what the whole subcontractors feature needed once its phases worked together
-- (20261025007001_sub_offer_rules.sql to 20261025007010_sub_notice_contacts.sql):
--   - rules about subs' offers are for the office with the subs area, and only notify the office or make a task
--   - pay periods never take a sub
--   - a sub's reason for turning a job down is kept on one line
--   - agreed pay whose visits were cancelled after it was agreed isn't finished by itself
--   - per-unit pay suggests each payee's share of the squares
--   - a sub taken off a visit has their clock on it stopped
--   - what a sub was paid this year says how much counts toward their 1099
--   - one ask gets a code for each business's sign-in a number or address belongs to
--   - a sub's notices go to the office's record for them
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1120;
grant usage on schema t1120 to authenticated, service_role;
create function t1120.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises ("<sqlstate>: <message>"), or 'none'.
create function t1120.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1120.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- A 64-character keyed hash stand-in.
create function t1120.h(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
grant execute on all functions in schema t1120 to authenticated, service_role;

\set oz 'd1120000-0000-0000-0000-000000000001'
\set opal 'd1120000-0000-0000-0000-000000000002'
\set ona 'd1120000-0000-0000-0000-000000000003'
\set cy 'd1120000-0000-0000-0000-000000000004'
\set al 'd1120000-0000-0000-0000-000000000005'
\set pat 'd1120000-0000-0000-0000-000000000006'
\set dan 'd1120000-0000-0000-0000-000000000007'
\set ex 'd1120000-0000-0000-0000-000000000008'
\set sid 'd1120000-0000-0000-0000-000000000009'
\set apex 'd1120000-0000-0000-0000-0000000000c1'
\set birch 'd1120000-0000-0000-0000-0000000000c2'
\set papasub 'd1120000-0000-0000-0000-0000000000c9'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'oz', 'oz@oscar.test', '{"full_name": "Oz Owner"}'),
  (:'opal', 'opal@oscar.test', '{"full_name": "Opal Office"}'),
  (:'ona', 'ona@oscar.test', '{"full_name": "Ona Clerk"}'),
  (:'cy', 'cy@oscar.test', '{"full_name": "Cy Crew"}'),
  (:'al', 'sub-' || :'apex' || '@subs.invalid', '{"full_name": "Al Apex"}'),
  (:'pat', 'pat@papa.test', '{"full_name": "Pat Papa"}'),
  (:'dan', 'sub-' || :'papasub' || '@subs.invalid', '{"full_name": "Al Apex"}'),
  (:'ex', 'ex@oscar.test', '{"full_name": "Ex Employee"}'),
  (:'sid', 'sid@own.test', '{"full_name": "Sid Own"}');

-- ===== Oscar Roofing ===========================================================================
-- Oz owns it; Opal is in the office with every area; Ona is in the office with a role that has
-- automations but not subs; Cy is on the crew. Apex Roofing (Al signs in) and Birch Gutters (Sid,
-- with his own account) are subs. The roof job has 24 squares of shingles and three visits.
begin;
set local role authenticated;
select t1120.as_user(:'oz');
select public.create_company('Oscar Roofing', 'roofing', 'America/New_York') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Automations clerk', 'office', '{automations}') returning id as clerk \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'opal', 'office', null), (:'co', :'ona', 'office', :'clerk'), (:'co', :'cy', 'field_crew', null);
insert into public.subcontractors (id, company_id, name, contact_name, phone, email) values
  (:'apex', :'co', 'Apex Roofing', 'Al Apex', '+15405550101', 'Al@Apex.test'),
  (:'birch', :'co', 'Birch Gutters', 'Sid Own', '+15405550102', 'sid@own.test');
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Architectural shingles', 'sq', 450, 300) returning id as shingles \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '1 Oak St') returning id as prop \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Smith roof') returning id as j1 \gset
insert into public.job_line_items (company_id, job_id, service_id, name, quantity, unit, unit_price, unit_cost) values (:'co', :'j1', :'shingles', 'Architectural shingles', 24, 'sq', 450, 300);
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Garage roof') returning id as j2 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Tear off', current_date) returning id as v1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Shingle', current_date + 1) returning id as v2 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Walk-through', current_date) returning id as v3 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j2', :'prop', 'Garage', current_date) returning id as w1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j2', :'prop', 'Rain day', current_date + 1) returning id as w2 \gset
insert into public.pay_rates (company_id, subcontractor_id, basis, service_id, rate) values (:'co', :'apex', 'per_unit', :'shingles', 75);
insert into public.pay_rates (company_id, user_id, basis, service_id, rate) values (:'co', :'cy', 'per_unit', :'shingles', 10);
commit;
-- Al's sign-in made by Crewtavo for Apex (marked), Sid's his own; as the server makes them.
update auth.users set raw_app_meta_data = jsonb_build_object('crewtavo_sub', :'co' || ':' || :'apex') where id = :'al';
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'al', 'subcontractor', :'apex'), (:'co', :'sid', 'subcontractor', :'birch');

-- Papa Paving: Al subs for Papa too, with a sign-in Papa's office made for its own record of him.
begin;
set local role authenticated;
select t1120.as_user(:'pat');
select public.create_company('Papa Paving', 'paving', 'America/Chicago') as other \gset
insert into public.subcontractors (id, company_id, name, phone, email) values (:'papasub', :'other', 'Al''s Paving', '(540) 555-0101', 'al@apex.test');
commit;
update auth.users set raw_app_meta_data = jsonb_build_object('crewtavo_sub', :'other' || ':' || :'papasub') where id = :'dan';
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'other', :'dan', 'subcontractor', :'papasub');

\o
\echo 'Review fixes for subcontractors'
\o /dev/null

-- ===== Rules about subs' offers (20261025007001_sub_offer_rules.sql) ==========================
begin;
set local role authenticated;
select t1120.as_user(:'ona');
select t1120.check(t1120.error_of(format('insert into public.automation_rules (company_id, name, trigger, actions) values (%L, %L, %L, %L)',
    :'co', 'Prices to me', 'sub_offer.declined', '[{"type": "notify", "roles": ["office"], "title": "{{sub.price}}"}]')) like '42501:%',
  'without the subs area, a rule about subs'' offers isn''t made');
insert into public.automation_rules (company_id, name, trigger, actions) values (:'co', 'Quote sent', 'quote.sent', '[{"type": "notify", "roles": ["office"], "title": "Sent"}]') returning id as quote_rule \gset
commit;
begin;
set local role authenticated;
select t1120.as_user(:'opal');
insert into public.automation_rules (company_id, name, trigger, actions) values (:'co', 'Tell me', 'sub_offer.declined', '[{"type": "notify", "roles": ["owner", "office"], "title": "{{sub.name}} said no"}]') returning id as sub_rule \gset
select t1120.check(t1120.error_of(format('insert into public.automation_rules (company_id, name, trigger, actions) values (%L, %L, %L, %L)',
    :'co', 'Text the client', 'sub_offer.declined', '[{"type": "send_sms", "body": "{{sub.price}}"}]')) like '22023: A rule about a sub''s offer can only notify the office or make a task.%',
  'with it, a rule about an offer only notifies or makes a task, however it''s saved');
select t1120.check(t1120.error_of(format('update public.automation_rules set actions = %L where id = %L', '[{"type": "notify", "roles": ["field_crew"], "title": "x"}]', :'sub_rule'))
    like '22023: Only the office hears about subs'' offers, never the crew.%',
  'and tells only owners, admins and the office');
select t1120.check(t1120.error_of(format('update public.automation_rules set actions = %L where id = %L', '[{"type": "notify", "roles": ["assigned"], "title": "x"}]', :'sub_rule'))
    like '22023:%', 'not the people on the visit either');
commit;
-- Runs for both, as the database queues them.
insert into public.automation_runs (company_id, rule_id, subject_type, subject_id) values (:'co', :'sub_rule', 'job', :'j1'), (:'co', :'quote_rule', 'job', :'j1');
begin;
set local role authenticated;
select t1120.as_user(:'ona');
select t1120.check(not exists (select 1 from public.automation_rules where starts_with(trigger, 'sub_offer.')) and exists (select 1 from public.automation_rules where id = :'quote_rule')
    and (select array_agg(rule_id) from public.automation_runs) = array[:'quote_rule']::uuid[],
  'without the area, neither the rule about offers nor its runs are seen');
select t1120.check(t1120.error_of(format('delete from public.automation_rules where id = %L', :'sub_rule')) = 'none'
  and exists (select 1 from public.automation_rules where id = :'quote_rule'), 'or deleted (nothing to delete)');
select t1120.as_user(:'opal');
select t1120.check(exists (select 1 from public.automation_rules where id = :'sub_rule') and (select count(*) from public.automation_runs) = 2, 'with it, both rules and their runs');
rollback;
select t1120.check(exists (select 1 from public.automation_rules where id = :'sub_rule'), 'the rule about offers is still there');

-- ===== Pay periods are for the team (20261025007002_payroll_is_for_the_team.sql) ================
insert into public.memberships (company_id, user_id, role) values (:'co', :'ex', 'field_crew');
delete from public.memberships where company_id = :'co' and user_id = :'ex';
begin;
set local role authenticated;
select t1120.as_user(:'opal');
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', current_date - 6, current_date) returning id as period \gset
select t1120.check(t1120.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount) values (%L, %L, %L, 8, 0)', :'co', :'period', :'al'))
    like '22023: Subs are paid by the job, under Subs, not with a pay period.%',
  'a sub on the clock isn''t put on a pay period line');
select t1120.check(t1120.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount) values (%L, %L, %L, 8, 160)', :'co', :'period', :'cy')) = 'none',
  'someone on the team is');
select t1120.check(t1120.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount) values (%L, %L, %L, 8, 160)', :'co', :'period', :'ex')) = 'none',
  'and so is a former employee, for their last period');
select t1120.check(t1120.error_of(format('update public.pay_period_lines set user_id = %L where period_id = %L and user_id = %L', :'al', :'period', :'ex')) like '22023: Subs are paid by the job%',
  'a line isn''t moved to a sub either');
select t1120.check(t1120.error_of(format('update public.pay_period_lines set amount = 150 where period_id = %L and user_id = %L', :'period', :'cy')) = 'none',
  'and other changes to a line still work');
rollback;

-- ===== An offer turned down, with a reason over several lines (20261025007003) ==================
begin;
set local role authenticated;
select t1120.as_user(:'opal');
select public.job_pay_start(:'j1', :'apex', null, array[:'v1', :'v2']::uuid[]) as offer \gset
select status from public.send_sub_offer(:'offer');
commit;
delete from public.notifications;
begin;
set local role authenticated;
select t1120.as_user(:'al');
select t1120.check(public.answer_sub_offer(:'offer', false, E'Too far.\n\n https://evil.example/login \n\n\tThanks'), 'Al turns it down with a reason over several lines');
commit;
select t1120.check((select decline_reason from public.job_pay where id = :'offer') = 'Too far. https://evil.example/login Thanks', 'it''s kept on one line');
select t1120.check((select bool_and(body !~ E'\n') and count(*) > 0 from public.notifications where kind = 'subs'), 'and the office''s notice has no line breaks in it');

-- ===== Agreed, then some of its visits cancelled (20261025007004_job_pay_cancelled_visits.sql) ===
begin;
set local role authenticated;
select t1120.as_user(:'opal');
select public.job_pay_start(:'j1', :'apex', null, array[:'v1', :'v2']::uuid[]) as roof \gset
select t1120.check((select total = 1800 from public.job_pay where id = :'roof'), 'Apex''s new pay: 24 squares at $75');
select status from public.job_pay_accept(:'roof');
-- Agreed by phone at 18 of the squares (the office changes the line while it's agreed).
update public.job_pay_lines set quantity = 18 where job_pay_id = :'roof';
update public.visits set status = 'completed', completed_at = now() where id = :'v1';
update public.visits set status = 'cancelled' where id = :'v2';
commit;
select t1120.check((select status from public.job_pay where id = :'roof') = 'accepted'
  and (select cancelled_while_agreed from public.job_pay_visits where job_pay_id = :'roof' and visit_id = :'v2'),
  'with the rest of its work cancelled after it was agreed, the pay stays agreed, so its lines can be checked');
select t1120.check(not exists (select 1 from public.notifications where user_id = :'al' and title like 'Owed:%'), 'and Al isn''t told it''s owed yet');
begin;
set local role authenticated;
select t1120.as_user(:'opal');
select t1120.check((select status = 'done' and total = 1350 from public.job_pay_mark_done(:'roof')), 'the office marks the work done at the price it checked');
commit;
-- A visit cancelled before the price was agreed doesn't hold it up.
begin;
set local role authenticated;
select t1120.as_user(:'opal');
update public.visits set status = 'cancelled' where id = :'w2';
select public.job_pay_start(:'j2', :'apex', null, array[:'w1', :'w2']::uuid[]) as garage \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, rate) values (:'co', :'garage', 'Garage roof', 600);
select status from public.job_pay_accept(:'garage');
update public.visits set status = 'completed', completed_at = now() where id = :'w1';
commit;
select t1120.check((select status from public.job_pay where id = :'garage') = 'done', 'pay agreed with a visit already cancelled is done by itself once the rest is');

-- ===== Each payee's share of the squares (20261025007005_per_unit_pay_shares.sql) ===============
begin;
set local role authenticated;
select t1120.as_user(:'opal');
select t1120.check((select row(trim_scale(quantity), check_it, note)::text from public.job_pay_suggest(:'j1', null, :'cy'))
    = row(6, true, '18 of 24 squares are already on other pay on this job. Check it.')::text,
  'Cy''s suggested squares are what Apex''s pay leaves of the roof, flagged');
select t1120.check((select row(trim_scale(quantity), check_it)::text from public.job_pay_suggest(:'j1', :'apex')) = row(24, false)::text,
  'Apex''s own pay isn''t counted against Apex');
rollback;

-- ===== A sub taken off a visit while clocked in (20261025007006_sub_clock_off_visit.sql) =========
update public.subcontractors set uses_clock = true where id = :'apex';
begin;
set local role authenticated;
select t1120.as_user(:'opal');
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v3', :'al');
commit;
begin;
set local role authenticated;
select t1120.as_user(:'al');
insert into public.time_entries (company_id, user_id, visit_id, category, started_at) values (:'co', :'al', :'v3', 'visit', now() - interval '1 hour') returning id as al_clock \gset
commit;
begin;
set local role authenticated;
select t1120.as_user(:'opal');
delete from public.visit_assignees where visit_id = :'v3' and user_id = :'al';
commit;
select t1120.check((select ended_at is not null from public.time_entries where id = :'al_clock'), 'taken off the visit, Al''s running clock on it stops');
update public.subcontractors set uses_clock = false where id = :'apex';

-- ===== What counts toward the 1099 (20261025007008_sub_paid_this_year_1099.sql) =================
begin;
set local role authenticated;
select t1120.as_user(:'opal');
select status from public.job_pay_mark_paid(array[:'roof']::uuid[], 'check');
select status from public.job_pay_mark_paid(array[:'garage']::uuid[], 'card_or_app');
commit;
begin;
set local role authenticated;
select t1120.as_user(:'al');
select t1120.check((select row(paid, payments, counted)::text from public.my_sub_pay_totals(:'co')) = row(1950.00, 2, 1350.00)::text,
  'Al sees what he was paid this year, and that the card payment doesn''t count toward his 1099');
rollback;

-- ===== A code for each business's sign-in (20261025007009_sign_in_codes_for_each_sign_in.sql) ====
begin;
set local role service_role;
select t1120.check(t1120.error_of(format('select public.sign_in_codes_save(%L, %L, %L, %L)', 'text', t1120.h('n'), array[:'al', :'dan']::uuid[], array[t1120.h('c1')]::text[])) like '22023:%',
  'a code for each account, no more and no fewer');
select t1120.check(t1120.error_of(format('select public.sign_in_codes_save(%L, %L, %L, %L)', 'text', t1120.h('n'), array[:'al', :'al']::uuid[], array[t1120.h('c1'), t1120.h('c2')]::text[])) like '22023:%',
  'each account once');
-- Al's number, on Oscar's sign-in and Papa's: one ask, a code for each.
select public.sign_in_codes_save('text', t1120.h('n'), array[:'al', :'dan']::uuid[], array[t1120.h('al:111111'), t1120.h('dan:222222')], t1120.h('ip'));
reset role;
select t1120.check((select count(distinct ask) = 1 and count(*) = 2 from private.sign_in_codes where address_hash = t1120.h('n')), 'saved together, as one ask');
set local role service_role;
select t1120.check((select row(result, user_id)::text from public.sign_in_codes_check('text', t1120.h('n'), array[:'al', :'dan']::uuid[], array[t1120.h('al:333333'), t1120.h('dan:333333')], t1120.h('ip')))
    = row('wrong', null::uuid)::text, 'a code that''s neither is wrong');
select t1120.check((select row(result, user_id)::text from public.sign_in_codes_check('text', t1120.h('n'), array[:'al', :'dan']::uuid[], array[t1120.h('al:222222'), t1120.h('dan:222222')], t1120.h('ip')))
    = row('ok', :'dan'::uuid)::text, 'Papa''s code signs in to Papa''s sign-in');
select t1120.check((select row(result, user_id)::text from public.sign_in_codes_check('text', t1120.h('n'), array[:'al', :'dan']::uuid[], array[t1120.h('al:111111'), t1120.h('dan:111111')], t1120.h('ip')))
    = row('wrong', null::uuid)::text, 'and then the ask is used: Oscar''s code from it doesn''t work');
reset role;
select t1120.check((select array_agg(row(attempts, used_at is not null)::text) from private.sign_in_codes where address_hash = t1120.h('n')) = '{"(2,t)","(2,t)"}',
  'its tries are the ask''s, on both codes');
set local role service_role;
-- Five wrong tries use the whole ask up, whichever code it is.
select public.sign_in_codes_save('text', t1120.h('m'), array[:'al', :'dan']::uuid[], array[t1120.h('al:444444'), t1120.h('dan:555555')], t1120.h('ip'));
select public.sign_in_code_check('text', t1120.h('m'), t1120.h('al:000000'), :'al', t1120.h('ip')) from generate_series(1, 4);
select t1120.check((select result from public.sign_in_codes_check('text', t1120.h('m'), array[:'al', :'dan']::uuid[], array[t1120.h('al:000000'), t1120.h('dan:000000')], t1120.h('ip'))) = 'dead',
  'five wrong tries use the ask up');
select t1120.check((select result from public.sign_in_codes_check('text', t1120.h('m'), array[:'al', :'dan']::uuid[], array[t1120.h('al:555555'), t1120.h('dan:555555')], t1120.h('ip'))) = 'dead',
  'even for the other business''s right code');
-- An address with no sign-in: one code for nobody, never right.
select public.sign_in_codes_save('email', t1120.h('nobody'), '{}'::uuid[], array[t1120.h('nobody:666666')], t1120.h('ip'));
select t1120.check((select row(result, user_id)::text from public.sign_in_codes_check('email', t1120.h('nobody'), '{}'::uuid[], array[t1120.h('nobody:666666')], t1120.h('ip'))) = row('wrong', null::uuid)::text,
  'a code for nobody is never right');
rollback;
select t1120.check(not has_function_privilege('authenticated', 'public.sign_in_codes_save(text, text, uuid[], text[], text)', 'execute')
  and not has_function_privilege('authenticated', 'public.sign_in_codes_check(text, text, uuid[], text[], text)', 'execute')
  and not has_function_privilege('anon', 'public.sign_in_codes_check(text, text, uuid[], text[], text)', 'execute'),
  'and it''s the server''s alone');

-- ===== Where a sub's notices go (20261025007010_sub_notice_contacts.sql) ========================
begin;
set local role service_role;
select t1120.check((select array_agg(row(user_id, company_id, email, phone)::text order by company_id = :'co' desc) from public.sub_notice_contacts(array[:'al', :'dan', :'sid', :'cy']::uuid[]))
    = array[row(:'al'::uuid, :'co'::uuid, 'al@apex.test', '+15405550101')::text, row(:'dan'::uuid, :'other'::uuid, 'al@apex.test', '(540) 555-0101')::text],
  'each sign-in made for a sub gets the email and phone on its office''s record (not someone''s own account, or the team)');
rollback;
update public.subcontractors set email = 'sub-' || :'apex' || '@subs.invalid', phone = '+15405550199' where id = :'apex';
begin;
set local role service_role;
select t1120.check((select row(email, phone)::text from public.sub_notice_contacts(array[:'al']::uuid[])) = row(null::text, '+15405550199')::text,
  'never a stand-in address, and a corrected number at once');
rollback;
insert into public.memberships (company_id, user_id, role) values (:'other', :'al', 'field_crew');
begin;
set local role service_role;
select t1120.check(not exists (select 1 from public.sub_notice_contacts(array[:'al']::uuid[])), 'not a sign-in that''s also someone''s elsewhere');
rollback;
delete from public.memberships where company_id = :'other' and user_id = :'al';
select t1120.check(not has_function_privilege('authenticated', 'public.sub_notice_contacts(uuid[])', 'execute'), 'and it''s the server''s alone');

\o
\echo 'All subcontractor review fix tests passed.'
