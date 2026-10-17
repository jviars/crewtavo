-- Campaign sends claim their recipients before emailing them. Runs can overlap (the run started by
-- Send, the every-minute task, /api/cron/campaigns, a second server), and each used to read the
-- same pending recipients, so people got the same email twice. Now a run marks a batch 'sending'
-- with the time it claimed them; no other run takes those rows unless the claim is old enough that
-- the run must have crashed, and then they're retried.

alter table public.campaign_recipients drop constraint campaign_recipients_status_check;
alter table public.campaign_recipients add constraint campaign_recipients_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped'));
alter table public.campaign_recipients add column claimed_at timestamptz;

drop index public.campaign_recipients_pending_idx;
create index campaign_recipients_unsent_idx on public.campaign_recipients (campaign_id, id) where status in ('pending', 'sending');

-- Claim up to p_limit of a campaign's recipients (in order). Claims older than p_timeout_seconds
-- belong to a run that stopped partway, so they can be claimed again.
create function public.claim_campaign_recipients(p_campaign uuid, p_limit integer default 25, p_timeout_seconds integer default 1800)
returns setof public.campaign_recipients
language sql security definer set search_path = '' as $$
  update public.campaign_recipients r set status = 'sending', claimed_at = now()
  where r.id in (
    select x.id from public.campaign_recipients x
    where x.campaign_id = p_campaign
      and (x.status = 'pending'
           or (x.status = 'sending' and x.claimed_at < now() - make_interval(secs => greatest(p_timeout_seconds, 60))))
    order by x.id
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  )
  returning r.*
$$;
revoke execute on function public.claim_campaign_recipients(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_campaign_recipients(uuid, integer, integer) to service_role;

notify pgrst, 'reload schema';
