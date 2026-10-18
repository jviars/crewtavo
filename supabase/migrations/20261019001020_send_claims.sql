-- Automation runs and campaign emails go out once, even when the mail server is slow.
--
-- A worker claims a batch, then sends one email after another, and a mail server can take a couple
-- of minutes per message. Claims lasted five minutes for automation runs and thirty for campaign
-- recipients, so a slow batch outlasted its claim, and the next run (Send, the every-minute task, a
-- second server, or the old release during a deploy) claimed the same rows and sent them again.
-- Finishing wasn't checked either, so a worker whose claim had gone could mark another's done.
--
-- Now each claim has a token, and an expiry from the database clock. Right before each email the
-- worker renews its claim on that row with the token; false means another worker has it now, so
-- this one leaves it. Finishing, failing, skipping and putting rows back go through functions that
-- only touch rows the worker still holds, and rows it never started go back as soon as it stops.

-- ---------------------------------------------------------------------------------------------
-- Automation runs
-- ---------------------------------------------------------------------------------------------

alter table public.automation_runs add column claim_token uuid;

-- As in 20261018000500_recurrence_skips_and_runs.sql, plus a token for the batch.
create or replace function public.claim_automation_runs(p_limit integer default 25, p_company uuid default null)
returns setof public.automation_runs language plpgsql security definer set search_path = '' as $$
declare v_token uuid := gen_random_uuid();
begin
  -- Runs that crashed three times stop retrying.
  update public.automation_runs
     set status = 'failed', finished_at = now(), locked_until = null, claim_token = null, error = coalesce(error, 'Stopped after 3 attempts')
   where status = 'running' and locked_until < now() and attempts >= 3;

  return query
  update public.automation_runs r
     set status = 'running', locked_until = now() + interval '5 minutes', claim_token = v_token
   where r.id in (
     select x.id from public.automation_runs x
      where ((x.status = 'pending' and x.run_after <= now()) or (x.status = 'running' and x.locked_until < now()))
        and (p_company is null or x.company_id = p_company)
      order by x.run_after
      limit least(greatest(p_limit, 1), 100)
      for update skip locked)
  returning r.*;
end $$;

-- Replaced by start_automation_run, which goes by the claim's token instead of its expiry.
drop function public.extend_automation_run(bigint, timestamptz);

-- Right before doing a run: true if the worker still holds it (and five more minutes from now).
-- That's when the attempt counts, so runs waiting their turn in a slow batch don't use attempts.
create function public.start_automation_run(p_id bigint, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_runs
     set locked_until = now() + interval '5 minutes', attempts = attempts + 1
   where id = p_id and status = 'running' and claim_token = p_token;
  return found;
end $$;

-- Before each action after the first: true if the worker still holds the run, which gets five more
-- minutes and keeps the actions done so far (p_result), so whoever does it next skips those.
create function public.renew_automation_run(p_id bigint, p_token uuid, p_result jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_runs
     set locked_until = now() + interval '5 minutes', result = coalesce(p_result, result)
   where id = p_id and status = 'running' and claim_token = p_token;
  return found;
end $$;

-- How the run went (done, skipped or failed), if the worker still holds it. False means another
-- worker has it now, and this one's outcome isn't recorded over theirs.
create function public.finish_automation_run(p_id bigint, p_token uuid, p_status text, p_result jsonb, p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status is null or p_status not in ('done', 'skipped', 'failed') then
    raise exception 'A run finishes as done, skipped or failed' using errcode = '22023';
  end if;
  update public.automation_runs
     set status = p_status, result = coalesce(p_result, '[]'), error = left(p_error, 1000), finished_at = now(), locked_until = null, claim_token = null
   where id = p_id and status = 'running' and claim_token = p_token;
  return found;
end $$;

-- Runs the worker claimed but never started (the batch stopped early) wait again for the next one,
-- right away and without using an attempt. Runs it no longer holds are left alone.
create function public.release_automation_runs(p_token uuid, p_ids bigint[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.automation_runs
     set status = 'pending', locked_until = null, claim_token = null
   where id = any (p_ids) and status = 'running' and claim_token = p_token;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function public.start_automation_run(bigint, uuid) from public, anon, authenticated;
revoke execute on function public.renew_automation_run(bigint, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.finish_automation_run(bigint, uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.release_automation_runs(uuid, bigint[]) from public, anon, authenticated;
grant execute on function public.start_automation_run(bigint, uuid) to service_role;
grant execute on function public.renew_automation_run(bigint, uuid, jsonb) to service_role;
grant execute on function public.finish_automation_run(bigint, uuid, text, jsonb, text) to service_role;
grant execute on function public.release_automation_runs(uuid, bigint[]) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Campaign recipients
-- ---------------------------------------------------------------------------------------------

alter table public.campaign_recipients add column claim_token uuid, add column locked_until timestamptz;
-- Claims taken before this keep the thirty minutes they were taken with.
update public.campaign_recipients set locked_until = claimed_at + interval '30 minutes' where status = 'sending';

-- As in 20261018000200_campaign_claims.sql, except a claim lasts five minutes on the database's
-- clock (renewed before each email) instead of a timeout each claimer picked, and has a token.
drop function public.claim_campaign_recipients(uuid, integer, integer);
create function public.claim_campaign_recipients(p_campaign uuid, p_limit integer default 25)
returns setof public.campaign_recipients language plpgsql security definer set search_path = '' as $$
declare v_token uuid := gen_random_uuid();
begin
  return query
  update public.campaign_recipients r
     set status = 'sending', claimed_at = now(), locked_until = now() + interval '5 minutes', claim_token = v_token
   where r.id in (
     select x.id from public.campaign_recipients x
      where x.campaign_id = p_campaign
        and (x.status = 'pending' or (x.status = 'sending' and x.locked_until < now()))
      order by x.id
      limit least(greatest(p_limit, 1), 100)
      for update skip locked)
  returning r.*;
end $$;

-- Right before emailing a recipient: true if the worker still holds them (and five more minutes).
create function public.renew_campaign_recipient(p_id bigint, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.campaign_recipients
     set locked_until = now() + interval '5 minutes'
   where id = p_id and status = 'sending' and claim_token = p_token;
  return found;
end $$;

-- What happened to recipients the worker holds: sent, failed or skipped (p_error says why). Returns
-- how many it recorded; recipients another worker has claimed since are theirs to record. Stop
-- marks a campaign's unsent recipients skipped, the one being emailed too, and keeps the claim, so
-- an email that went out anyway is still recorded as sent.
create function public.finish_campaign_recipients(p_token uuid, p_ids bigint[], p_status text, p_error text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_status is null or p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'A recipient is sent, failed or skipped' using errcode = '22023';
  end if;
  update public.campaign_recipients
     set status = p_status,
         error = case when p_status = 'sent' then null else left(p_error, 1000) end,
         sent_at = case when p_status = 'sent' then now() else sent_at end,
         locked_until = null, claim_token = null
   where id = any (p_ids) and claim_token = p_token and status in ('sending', 'skipped');
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Recipients the worker claimed but didn't email (rate limited, or the run stopped early) go back
-- for the next run. Recipients it no longer holds are left alone.
create function public.release_campaign_recipients(p_token uuid, p_ids bigint[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.campaign_recipients
     set status = 'pending', claimed_at = null, locked_until = null, claim_token = null
   where id = any (p_ids) and status = 'sending' and claim_token = p_token;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function public.claim_campaign_recipients(uuid, integer) from public, anon, authenticated;
revoke execute on function public.renew_campaign_recipient(bigint, uuid) from public, anon, authenticated;
revoke execute on function public.finish_campaign_recipients(uuid, bigint[], text, text) from public, anon, authenticated;
revoke execute on function public.release_campaign_recipients(uuid, bigint[]) from public, anon, authenticated;
grant execute on function public.claim_campaign_recipients(uuid, integer) to service_role;
grant execute on function public.renew_campaign_recipient(bigint, uuid) to service_role;
grant execute on function public.finish_campaign_recipients(uuid, bigint[], text, text) to service_role;
grant execute on function public.release_campaign_recipients(uuid, bigint[]) to service_role;

-- Older releases (0.1.1) don't claim: each run emails up to 25 'pending' recipients, then marks the
-- campaign sent once none are 'pending'. Next to this release (while a deploy overlaps, or after
-- going back to 0.1.1) that marked campaigns sent while recipients were still claimed, so the newer
-- run stopped and skipped them as "Campaign stopped", and claims a stopped run left behind were
-- never sent. Now a campaign stays 'sending' while it has recipients to send, and every refresh of
-- its counts puts claims that ran out back in the queue, where either release picks them up.
create function private.campaign_unsent_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.campaign_recipients
     set status = 'pending', claimed_at = null, locked_until = null, claim_token = null
   where campaign_id = new.id and status = 'sending' and locked_until < now();
  if new.status = 'sent' and exists (select 1 from public.campaign_recipients where campaign_id = new.id and status in ('pending', 'sending')) then
    new.status := old.status;
    new.finished_at := old.finished_at;
  end if;
  return new;
end $$;
create trigger campaign_unsent_check before update of status, sent_count on public.campaigns
  for each row when (old.status = 'sending') execute function private.campaign_unsent_check();

notify pgrst, 'reload schema';
