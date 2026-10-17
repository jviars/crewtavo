-- Marketing: email campaigns to client segments, Google review requests and referral tracking.
-- Company settings hold the review link (settings.review_url) and referral reward
-- (settings.referral_reward, e.g. {"amount": 50}).

alter table public.requests drop constraint requests_source_check;
alter table public.requests add constraint requests_source_check
  check (source in ('manual', 'phone', 'web_form', 'hub', 'email', 'assistant', 'referral'));

-- ---------------------------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------------------------

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  subject text not null default '' check (length(subject) <= 200),
  body text not null default '' check (length(body) <= 20000),
  -- {statuses: ['active'], tags_any: [], tags_none: [], no_visit_days: 180}
  audience jsonb not null default '{}' check (jsonb_typeof(audience) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  recipients_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index campaigns_company_idx on public.campaigns (company_id, created_at desc);
create index campaigns_due_idx on public.campaigns (status, scheduled_at) where status in ('scheduled', 'sending');

create table public.campaign_recipients (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  campaign_id uuid not null,
  client_id uuid,
  email text not null,
  name text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  error text,
  sent_at timestamptz,
  unique (campaign_id, email),
  foreign key (company_id, campaign_id) references public.campaigns (company_id, id) on delete cascade,
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete set null (client_id)
);
create index campaign_recipients_pending_idx on public.campaign_recipients (campaign_id) where status = 'pending';

select private.add_touch_triggers(array['campaigns']);
select private.apply_policies('campaigns', '{owner,admin,office}', '{owner,admin,office}');
alter table public.campaign_recipients enable row level security;
create policy campaign_recipients_read on public.campaign_recipients for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
revoke insert, update, delete on public.campaign_recipients from authenticated;

-- Only drafts are edited in the browser; sending, scheduling and cancelling go through the API.
create function private.campaign_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) = 'authenticated' then
    if tg_op = 'DELETE' then
      if old.status in ('sending') then
        raise exception 'A campaign can''t be deleted while it''s sending' using errcode = '22023';
      end if;
      return old;
    end if;
    if old.status <> 'draft' then
      raise exception 'Only draft campaigns can be edited' using errcode = '22023';
    end if;
    if new.status <> 'draft' or new.sent_count <> old.sent_count or new.recipients_count <> old.recipients_count then
      raise exception 'Use Send or Schedule to send a campaign' using errcode = '22023';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger campaign_guard before update or delete on public.campaigns
  for each row execute function private.campaign_guard();

-- Who a campaign reaches: clients with a usable email who haven't opted out, filtered by status,
-- tags and (for win-back campaigns) how long since their last completed visit.
create function public.campaign_audience(p_company_id uuid, p_audience jsonb)
returns table (client_id uuid, display_name text, email text)
language sql stable security invoker set search_path = '' as $$
  select distinct on (lower(c.email)) c.id, c.display_name, lower(trim(c.email))
  from public.clients c
  where c.company_id = p_company_id
    and c.email is not null
    and trim(c.email) ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and not c.marketing_opt_out
    and (coalesce(jsonb_array_length(p_audience -> 'statuses'), 0) = 0
         or c.status in (select jsonb_array_elements_text(p_audience -> 'statuses')))
    and (coalesce(jsonb_array_length(p_audience -> 'tags_any'), 0) = 0
         or c.tags && array(select jsonb_array_elements_text(p_audience -> 'tags_any')))
    and not (c.tags && array(select jsonb_array_elements_text(coalesce(p_audience -> 'tags_none', '[]'))))
    and (coalesce((p_audience ->> 'no_visit_days')::integer, 0) <= 0 or not exists (
         select 1 from public.visits v join public.jobs j on j.id = v.job_id
         where j.client_id = c.id and v.status = 'completed'
           and v.completed_at > now() - make_interval(days => (p_audience ->> 'no_visit_days')::integer)))
  order by lower(c.email), c.created_at
$$;
revoke execute on function public.campaign_audience(uuid, jsonb) from public, anon;
grant execute on function public.campaign_audience(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Review requests
-- ---------------------------------------------------------------------------------------------

create table public.review_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null,
  job_id uuid,
  channel text not null default 'email' check (channel in ('email', 'sms', 'link')),
  status text not null default 'sent' check (status in ('sent', 'clicked', 'failed')),
  error text,
  sent_at timestamptz not null default now(),
  clicked_at timestamptz,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (company_id, id),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id)
);
create index review_requests_company_idx on public.review_requests (company_id, sent_at desc);
create index review_requests_client_idx on public.review_requests (client_id, sent_at desc);
alter table public.review_requests enable row level security;
create policy review_requests_read on public.review_requests for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
revoke insert, update, delete on public.review_requests from authenticated;

-- ---------------------------------------------------------------------------------------------
-- Referrals
-- ---------------------------------------------------------------------------------------------

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  referrer_client_id uuid not null,
  referred_client_id uuid,
  request_id uuid,
  referred_name text not null,
  status text not null default 'new' check (status in ('new', 'quoted', 'won', 'lost')),
  reward_amount numeric(12, 2) not null default 0 check (reward_amount >= 0),
  reward_status text not null default 'pending' check (reward_status in ('pending', 'issued', 'none')),
  reward_issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, referrer_client_id) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, referred_client_id) references public.clients (company_id, id) on delete set null (referred_client_id),
  foreign key (company_id, request_id) references public.requests (company_id, id) on delete set null (request_id)
);
create index referrals_company_idx on public.referrals (company_id, created_at desc);
create index referrals_referred_idx on public.referrals (referred_client_id);
select private.add_touch_triggers(array['referrals']);
alter table public.referrals enable row level security;
create policy referrals_read on public.referrals for select to authenticated using (private.has_role(company_id, '{owner,admin,office}'));
create policy referrals_update on public.referrals for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office}')) with check (private.has_role(company_id, '{owner,admin,office}'));
create policy referrals_delete on public.referrals for delete to authenticated using (private.has_role(company_id, '{owner,admin,office}'));
revoke insert on public.referrals from authenticated;

-- A referral advances as the referred client's work does.
create function private.referral_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if new.status in ('approved', 'converted') then
      update public.referrals set status = 'won'
       where company_id = new.company_id and referred_client_id = new.client_id and status in ('new', 'quoted');
    elsif new.status = 'sent' then
      update public.referrals set status = 'quoted'
       where company_id = new.company_id and referred_client_id = new.client_id and status = 'new';
    end if;
  end if;
  return null;
end $$;
create trigger referral_progress after update of status on public.quotes
  for each row execute function private.referral_progress();

-- Marketing reads for the dashboard's marketing page.
create function public.marketing_summary(p_company_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'campaigns_sent', (select count(*) from public.campaigns where company_id = p_company_id and status = 'sent'),
    'emails_sent_30d', (select count(*) filter (where r.status = 'sent') from public.campaign_recipients r
                         where r.company_id = p_company_id and r.sent_at > now() - interval '30 days'),
    'reviews_requested_30d', (select count(*) from public.review_requests where company_id = p_company_id and sent_at > now() - interval '30 days'),
    'reviews_clicked_30d', (select count(*) from public.review_requests where company_id = p_company_id and clicked_at > now() - interval '30 days'),
    'referrals_total', (select count(*) from public.referrals where company_id = p_company_id),
    'referrals_won', (select count(*) from public.referrals where company_id = p_company_id and status = 'won'),
    'rewards_pending', (select coalesce(sum(reward_amount), 0) from public.referrals where company_id = p_company_id and status = 'won' and reward_status = 'pending'),
    'opted_out', (select count(*) from public.clients where company_id = p_company_id and marketing_opt_out)
  )
$$;
revoke execute on function public.marketing_summary(uuid) from public, anon;
grant execute on function public.marketing_summary(uuid) to authenticated;

-- Refresh PostgREST's schema cache so new tables and relationships are available at once.
notify pgrst, 'reload schema';
