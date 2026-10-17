-- Connected apps (QuickBooks, Zoho, Google Calendar...), encrypted tokens, external ID links,
-- and the outbox that background tasks drain.

create table public.integrations (
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null, -- 'quickbooks' | 'zoho_books' | 'google_calendar' | 'anthropic' | ...
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'error')),
  account_label text,       -- e.g. the QuickBooks company name
  external_account_id text, -- QuickBooks realm ID, Zoho organization ID
  settings jsonb not null default '{}', -- non-secret: environment, api domain, item mappings
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (company_id, provider)
);
select private.add_touch_triggers(array['integrations']);
alter table public.integrations enable row level security;
create policy integrations_read on public.integrations for select to authenticated
  using (private.has_role(company_id, '{owner,admin}'));
-- Writes happen in the API with the service key, after the OAuth exchange.

-- Tokens and API keys, AES-GCM encrypted by the API before they arrive here.
-- RLS on and no policies: only the service key can read or write.
create table public.integration_secrets (
  company_id uuid not null,
  provider text not null,
  ciphertext text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (company_id, provider),
  foreign key (company_id, provider) references public.integrations (company_id, provider) on delete cascade
);
alter table public.integration_secrets enable row level security;
revoke all on public.integration_secrets from authenticated, anon;

create table public.sync_links (
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null,
  entity text not null,   -- 'client' | 'invoice' | 'payment' | 'service'
  local_id uuid not null,
  external_id text not null,
  sync_token text,        -- QuickBooks SyncToken for updates
  synced_at timestamptz not null default now(),
  primary key (company_id, provider, entity, local_id)
);
alter table public.sync_links enable row level security;
create policy sync_links_read on public.sync_links for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));

create table public.outbox (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  topic text not null,     -- 'accounting.invoice' | 'accounting.payment'
  payload jsonb not null default '{}',
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  done_at timestamptz,
  dead_at timestamptz,     -- gave up after too many attempts
  created_at timestamptz not null default now()
);
create index outbox_pending_idx on public.outbox (run_after) where done_at is null and dead_at is null;
alter table public.outbox enable row level security;
revoke all on public.outbox from authenticated, anon;

-- Queue accounting pushes when an invoice leaves draft or a payment is recorded, if a company
-- has an accounting app connected.
create function private.enqueue_accounting() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.integrations
    where company_id = new.company_id and provider in ('quickbooks', 'zoho_books') and status = 'connected'
  ) then
    return null;
  end if;

  if tg_table_name = 'invoices' then
    if new.status not in ('draft', 'void') and (tg_op = 'INSERT' or old.status = 'draft') then
      insert into public.outbox (company_id, topic, payload)
      values (new.company_id, 'accounting.invoice', jsonb_build_object('invoice_id', new.id));
    end if;
  elsif tg_table_name = 'payments' then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'accounting.payment', jsonb_build_object('payment_id', new.id));
  end if;
  return null;
end $$;
create trigger enqueue_accounting after insert or update of status on public.invoices
  for each row execute function private.enqueue_accounting();
create trigger enqueue_accounting after insert on public.payments
  for each row execute function private.enqueue_accounting();

-- Claim a batch of due outbox rows (service key only). SKIP LOCKED lets overlapping runs coexist.
create function public.claim_outbox(p_limit integer default 25) returns setof public.outbox
language sql security definer set search_path = '' as $$
  update public.outbox o
  set locked_until = now() + interval '5 minutes', attempts = o.attempts + 1
  where o.id in (
    select id from public.outbox
    where done_at is null and dead_at is null and run_after <= now()
      and (locked_until is null or locked_until < now())
    order by id
    limit p_limit
    for update skip locked
  )
  returning o.*
$$;
revoke execute on function public.claim_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_outbox(integer) to service_role;
