-- The instance's own web address (Settings → Web address). An owner picks an address like
-- app.theirbusiness.com; the API adds it on Railway (or says what to do by hand), checks the DNS
-- records as they go in, and switches APP_URL over once the new address answers. One row per
-- company: the change in progress, or the last one finished, whose old addresses keep working
-- (links already sent, webhooks) and forward people to the new one.
-- Written only by the API with the service key; owners and admins read it.

create table public.web_address (
  company_id uuid primary key references public.companies (id) on delete cascade,
  domain text not null check (domain ~ '^[a-z0-9.-]{3,253}$'),
  status text not null default 'waiting' check (status in ('waiting', 'switching', 'done', 'failed')),
  -- Crewtavo holds Railway access and finishes the switch itself.
  automatic boolean not null default false,
  railway_domain_id text,
  -- DNS records to add, as Railway (or the platform) gave them: [{type, purpose, name, host, value}].
  records jsonb not null default '[]',
  certificate text check (certificate in ('pending', 'issued', 'failed')),
  error text,
  -- The address before this change, and every earlier one this instance answered on.
  from_url text,
  previous_urls text[] not null default '{}',
  started_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  switching_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
select private.add_touch_triggers(array['web_address']);
alter table public.web_address enable row level security;
create policy web_address_read on public.web_address for select to authenticated
  using (private.has_role(company_id, '{owner,admin}'));
