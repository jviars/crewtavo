-- Database tests for campaign sending claims: runs that overlap (Send, the every-minute task, a
-- second server) each claim their own recipients, so nobody gets the same email twice; a crashed
-- run's claims are retried once they run out; only the server can claim.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tcamp;
grant usage on schema tcamp to anon, authenticated, service_role;
create function tcamp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tcamp.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tcamp to anon, authenticated, service_role;
-- A second connection, to claim at the same time as this one.
create extension dblink schema tcamp;
create table tcamp.claims (claimer text not null, id bigint not null);

insert into auth.users (id, email, raw_user_meta_data) values
  ('9c000000-0000-0000-0000-000000000001', 'owner@mike.test', '{"full_name": "Mia Owner"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Mike Lawn Care, LLC', 'lawn_care') as co \gset
insert into public.clients (company_id, display_name, email)
select :'co', 'Client ' || n, 'client' || n || '@example.com' from generate_series(1, 30) n;
insert into public.campaigns (company_id, name, subject, body) values (:'co', 'Fall cleanup', 'Book your fall cleanup', 'Hi {{client.first_name}}, leaves are coming.') returning id as camp \gset
commit;

-- What Send does: snapshot the audience, then the campaign starts sending.
insert into public.campaign_recipients (company_id, campaign_id, client_id, email, name)
select company_id, :'camp', id, email, display_name from public.clients where company_id = :'co';
update public.campaigns set status = 'sending' where id = :'camp';

-- Two runs at once: the other connection claims a batch and is still sending it (uncommitted)
-- while this one claims.
select tcamp.dblink_connect('other', 'dbname=' || current_database());
select tcamp.dblink_exec('other', 'begin');
insert into tcamp.claims select 'other', id from tcamp.dblink('other', format('select id from public.claim_campaign_recipients(%L, 10)', :'camp')) as t(id bigint);
insert into tcamp.claims select 'this', id from public.claim_campaign_recipients(:'camp', 10);
select tcamp.check((select count(*) from tcamp.claims where claimer = 'other') = 10 and (select count(*) from tcamp.claims where claimer = 'this') = 10, 'two runs at once each claim a full batch');
select tcamp.check((select count(distinct id) from tcamp.claims) = 20, 'and never the same recipient');
select tcamp.dblink_exec('other', 'commit');
select tcamp.dblink_disconnect('other');

-- Later runs (within the timeout) get only recipients nobody has claimed.
insert into tcamp.claims select 'third', id from public.claim_campaign_recipients(:'camp', 25);
select tcamp.check((select count(*) from tcamp.claims where claimer = 'third') = 10, 'the next run gets the rest');
select tcamp.check((select count(distinct id) from tcamp.claims) = 30, 'none of them claimed before');
select tcamp.check((select count(*) from public.claim_campaign_recipients(:'camp', 25)) = 0, 'claimed recipients aren''t handed out again while the claim lasts');
select tcamp.check((select bool_and(status = 'sending' and claimed_at is not null and locked_until > now()) from public.campaign_recipients where campaign_id = :'camp'), 'claimed recipients are marked as being sent, with the time');

-- Sent ones are done; a run that crashed mid-batch leaves claims that are retried once they run out.
update public.campaign_recipients set status = 'sent', sent_at = now() where id in (select id from tcamp.claims where claimer = 'this');
update public.campaign_recipients set locked_until = now() + interval '1 minute' where id in (select id from tcamp.claims where claimer = 'other');
select tcamp.check((select count(*) from public.claim_campaign_recipients(:'camp', 25)) = 0, 'a claim that hasn''t run out is left alone');
update public.campaign_recipients set locked_until = now() - interval '1 second' where id in (select id from tcamp.claims where claimer = 'other');
select array_agg(id order by id) = (select array_agg(id order by id) from tcamp.claims where claimer = 'other') as retried from public.claim_campaign_recipients(:'camp', 25) \gset
select tcamp.check(:'retried', 'a crashed run''s claims are retried once they run out');
select tcamp.check((select count(*) from public.claim_campaign_recipients(:'camp', 25)) = 0, 'and then held by the run that took them');
select tcamp.check((select count(*) from public.campaign_recipients where campaign_id = :'camp' and status = 'sent') = 10, 'sent recipients are never claimed again');

-- Only the server claims.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "9c000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tcamp.expect_error(format('select * from public.claim_campaign_recipients(%L)', :'camp'), 'people can''t claim campaign recipients, even the owner');
commit;
begin;
set local role anon;
select tcamp.expect_error(format('select * from public.claim_campaign_recipients(%L)', :'camp'), 'or anyone signed out');
commit;
begin;
set local role service_role;
select tcamp.check((select count(*) from public.claim_campaign_recipients(:'camp')) = 0, 'the server can');
commit;

delete from public.companies where id = :'co';
\echo 'All campaign claim tests passed.'
