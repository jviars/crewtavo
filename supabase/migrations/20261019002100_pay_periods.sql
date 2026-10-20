-- Pay periods: for each stretch of dates, each person's approved hours, the pay they come to at their
-- rates, and whether they've been paid. Crewtavo doesn't pay anyone: the business pays through its
-- own payroll or bank, then marks the period (or each person) paid here, with how and a reference.
-- Hours over 40 in a week are counted as overtime hours for the payroll service; the amount is at
-- straight time. Time in a period someone was marked paid for is locked until the mark is taken
-- back, so what was paid stays what's on record. Office and up with "Job costs and profit" only,
-- like pay rates themselves (Timesheets → Pay, and AI assistants' pay tools).

create table public.pay_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  status text not null default 'open' check (status in ('open', 'paid')),
  paid_at timestamptz,
  paid_by uuid references auth.users (id) on delete set null,
  notes text check (length(notes) <= 2000),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, starts_on, ends_on),
  unique (company_id, id)
);

create table public.pay_period_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  period_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  hours numeric(8, 2) not null default 0,
  overtime_hours numeric(8, 2) not null default 0,
  break_hours numeric(8, 2) not null default 0,
  amount numeric(12, 2) not null default 0,
  paid_amount numeric(12, 2),
  method text check (method in ('direct_deposit', 'check', 'cash', 'payroll_service', 'other')),
  reference text check (length(reference) <= 200),
  paid_at timestamptz,
  paid_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id, user_id),
  foreign key (company_id, period_id) references public.pay_periods (company_id, id) on delete cascade
);
create index pay_period_lines_user_idx on public.pay_period_lines (company_id, user_id);

select private.add_touch_triggers(array['pay_periods', 'pay_period_lines']);

alter table public.pay_periods enable row level security;
alter table public.pay_period_lines enable row level security;
create policy pay_periods_all on public.pay_periods for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'job_costs'))
  with check (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'job_costs'));
create policy pay_period_lines_all on public.pay_period_lines for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'job_costs'))
  with check (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'job_costs'));
revoke all on public.pay_periods, public.pay_period_lines from anon;
grant select, insert, update, delete on public.pay_periods, public.pay_period_lines to authenticated;

/** Whether this person was marked paid for a period that has this day in it. */
create function private.paid_for(p_company uuid, p_user uuid, p_day date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.pay_period_lines l join public.pay_periods p on p.id = l.period_id
    where l.company_id = p_company and l.user_id = p_user and l.paid_at is not null and p_day between p.starts_on and p.ends_on
  )
$$;
revoke all on function private.paid_for(uuid, uuid, date) from public;
grant execute on function private.paid_for(uuid, uuid, date) to authenticated, service_role;

/** Time in a paid period stays as it was paid, for everyone (the server's own upkeep aside). */
create function private.paid_time_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_row public.time_entries := coalesce(old, new);
begin
  if (select auth.uid()) is null then return coalesce(new, old); end if;
  select timezone into v_tz from public.companies where id = v_row.company_id;
  if (tg_op <> 'INSERT' and private.paid_for(old.company_id, old.user_id, (old.started_at at time zone coalesce(v_tz, 'UTC'))::date))
    or (tg_op <> 'DELETE' and private.paid_for(new.company_id, new.user_id, (new.started_at at time zone coalesce(v_tz, 'UTC'))::date)) then
    raise exception 'This time is in a pay period that''s been marked paid. Take back the paid mark first (Timesheets → Pay).' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger paid_time_guard before insert or update or delete on public.time_entries
  for each row execute function private.paid_time_guard();

-- The policies above, rewritten to look the person's companies up once per query (20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
