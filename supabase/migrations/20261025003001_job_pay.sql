-- Job pay (docs/subcontractors-plan.md, phase C: "One job pay table covers sub pay and per-square
-- crew pay"): what a sub is paid for a job, and what someone on the team earns on it at per-square,
-- per-job or day-rate pay. It isn't called "payouts", which are Stripe deposits.
--
--   pay_rates        a rate card for each sub, and each team member on piece pay: so much per unit of
--                    a price-list service (per square of shingles, per foot of gutter), per job or per
--                    day. A rate per square says which squares it counts: the job's (the job line's
--                    quantity, what the client pays for, waste included) or the roof's without waste.
--   job_pay          one live row per payee per job: a draft, then agreed (accepted: in this phase the
--                    office says so, for a price agreed by phone; offers come later and use offered,
--                    declined, withdrawn and expired), done once the work is (earned_on: the day it
--                    finished, the company's), then paid. Cancelled ends it.
--   job_pay_lines    what it comes to: a description, quantity × rate, and the amount, worked out
--                    here to the cent. The pay's total follows its lines.
--   job_pay_visits   the visits it covers, all on its job. A sub's agreed pay puts their sign-ins on
--                    those visits, and takes them off again when a visit comes out of it or the pay is
--                    cancelled (not off a visit that's done: who did it stays on record). The pay is
--                    done by itself once every visit it covers is.
--
-- job_pay_suggest() fills lines in from the payee's rates: the service's quantity on the job (change
-- orders in, discounts out), the roof's squares without the measurement's waste, the days among the
-- visits, or once; job_pay_covers() says which visits new pay covers unless others are chosen.
-- Starting, agreeing, marking done, cancelling and marking paid go through the functions here,
-- which check who's asking; the office changes the lines, the visits covered and the notes itself
-- while the pay is a draft or agreed, and nothing once the work is done.
--
-- Who sees it: a sub's pay, the office with the subs area; a team member's, the office with job
-- costs, as pay periods. Nobody else on the team, and crew leads and field crew never. A sub reads
-- their own (not drafts), its lines and the visits it covers, to see their price, so notes are
-- written for them. A team member doesn't read their own piece pay, as they don't read their hourly
-- rate.
--
-- A sub's pay is marked paid here (20261025003002_sub_pay_reports.sql adds it up for the 1099); a
-- team member's is paid with their pay period (20261025003003_piece_pay_periods.sql), not one by one.
-- A job, or a sub, with pay on record isn't deleted from the app: archive the job, turn the sub off.

-- ---------------------------------------------------------------------------------------------
-- Small rules
-- ---------------------------------------------------------------------------------------------

-- "sq", "square", "squares": a unit counted in roofing squares. Mirrors isSquareUnit in
-- packages/core/src/jobPay.ts.
create function private.is_square_unit(p_unit text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select lower(btrim(coalesce(p_unit, ''), ' .')) in ('sq', 'sqs', 'square', 'squares')
$$;

-- "24 squares", "3 days", "120 lf": a quantity as a note reads it.
create function private.amount_words(p_quantity numeric, p_unit text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select trim_scale(p_quantity)::text || ' ' || case
    when private.is_square_unit(p_unit) then case when p_quantity = 1 then 'square' else 'squares' end
    when lower(btrim(coalesce(p_unit, ''))) = 'day' then case when p_quantity = 1 then 'day' else 'days' end
    else coalesce(nullif(btrim(p_unit), ''), 'ea')
  end
$$;

-- Pay still in play: one per payee per job. Declined, withdrawn, expired and cancelled pay is history.
create function private.job_pay_live(p_status text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select p_status not in ('declined', 'withdrawn', 'expired', 'cancelled')
$$;

-- How pay moves along. Offers (offered, and its answers) are for later; nothing here offers yet. A
-- draft isn't cancelled but deleted: cancelled pay is the sub's to read, and nobody agreed a draft.
create function private.job_pay_moves(p_from text, p_to text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select (p_from, p_to) in (values
    ('draft', 'offered'), ('draft', 'accepted'),
    ('offered', 'accepted'), ('offered', 'declined'), ('offered', 'withdrawn'), ('offered', 'expired'), ('offered', 'draft'),
    ('accepted', 'done'), ('accepted', 'cancelled'),
    ('done', 'accepted'), ('done', 'paid'), ('done', 'cancelled'),
    ('paid', 'done'))
$$;

-- Someone on the team (any level but Subcontractor): who piece pay and their rates are for.
create function private.on_team(p_company uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = p_user and m.role <> 'subcontractor')
$$;

-- The office with the area for this payee: the subs area for a sub's pay, job costs for a team
-- member's. For the functions below (the policies say the same in their own words).
create function private.handles_pay(p_company uuid, p_subcontractor uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_company, '{owner,admin,office}')
    and ((p_subcontractor is not null and p_user is null and private.has_perm(p_company, 'subs'))
      or (p_user is not null and p_subcontractor is null and private.has_perm(p_company, 'job_costs')))
$$;

revoke all on function private.is_square_unit(text), private.amount_words(numeric, text), private.job_pay_live(text),
  private.job_pay_moves(text, text), private.on_team(uuid, uuid), private.handles_pay(uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.pay_rates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Who it's for: a sub, or someone on the team. Exactly one.
  subcontractor_id uuid,
  user_id uuid references auth.users (id) on delete cascade,
  basis text not null check (basis in ('per_unit', 'per_job', 'per_day')),
  -- Per unit: the price-list service whose quantity on a job it's counted on, and its unit (the
  -- service's, kept here by the database).
  service_id uuid,
  unit text check (length(unit) <= 20),
  -- Per square: the job's squares (its line's quantity) or the roof's without waste.
  squares_basis text not null default 'job' check (squares_basis in ('job', 'roof_no_waste')),
  rate numeric(12, 4) not null check (rate >= 0 and rate <= 1000000),
  description text check (length(description) <= 200),
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check ((subcontractor_id is null) <> (user_id is null)),
  check ((basis = 'per_unit') = (service_id is not null)),
  check (basis = 'per_unit' or squares_basis = 'job'),
  foreign key (company_id, subcontractor_id) references public.subcontractors (company_id, id) on delete cascade,
  foreign key (company_id, service_id) references public.services (company_id, id) on delete cascade
);
create index pay_rates_sub_idx on public.pay_rates (company_id, subcontractor_id) where subcontractor_id is not null;
create index pay_rates_user_idx on public.pay_rates (company_id, user_id) where user_id is not null;

create table public.job_pay (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  job_id uuid not null,
  subcontractor_id uuid,
  user_id uuid references auth.users (id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft', 'offered', 'accepted', 'declined', 'withdrawn', 'expired', 'done', 'paid', 'cancelled')),
  -- The sum of its lines (kept by the database).
  total numeric(12, 2) not null default 0,
  -- The day the work on the job finished, the company's.
  earned_on date,
  paid_at timestamptz,
  paid_amount numeric(12, 2) check (paid_amount >= 0 and paid_amount <= 10000000),
  -- Card and payment-app payments are left out of the 1099 (the processor reports them on a 1099-K).
  method text check (method in ('check', 'ach', 'cash', 'card_or_app', 'payroll', 'other')),
  reference text check (length(reference) <= 200),
  paid_by uuid references auth.users (id) on delete set null,
  -- A team member's: the pay period it was paid with.
  pay_period_id uuid,
  -- Shown to the sub with their price.
  notes text check (length(notes) <= 2000),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check ((subcontractor_id is null) <> (user_id is null)),
  check (status not in ('done', 'paid') or earned_on is not null),
  check (status <> 'paid' or (paid_at is not null and paid_amount is not null and method is not null)),
  check (status = 'paid' or (paid_at is null and paid_amount is null and method is null and reference is null and paid_by is null and pay_period_id is null)),
  check (pay_period_id is null or user_id is not null),
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete cascade,
  foreign key (company_id, subcontractor_id) references public.subcontractors (company_id, id) on delete cascade,
  foreign key (company_id, pay_period_id) references public.pay_periods (company_id, id) on delete set null (pay_period_id)
);
-- One live pay per payee per job.
create unique index job_pay_live_sub_idx on public.job_pay (job_id, subcontractor_id)
  where subcontractor_id is not null and status not in ('declined', 'withdrawn', 'expired', 'cancelled');
create unique index job_pay_live_user_idx on public.job_pay (job_id, user_id)
  where user_id is not null and status not in ('declined', 'withdrawn', 'expired', 'cancelled');
create index job_pay_company_idx on public.job_pay (company_id, status, paid_at);
create index job_pay_sub_idx on public.job_pay (subcontractor_id, status) where subcontractor_id is not null;
create index job_pay_user_idx on public.job_pay (company_id, user_id, earned_on) where user_id is not null;
create index job_pay_period_idx on public.job_pay (pay_period_id) where pay_period_id is not null;

create table public.job_pay_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  job_pay_id uuid not null,
  description text not null check (length(btrim(description)) between 1 and 200),
  basis text not null default 'per_job' check (basis in ('per_unit', 'per_job', 'per_day')),
  unit text check (length(unit) <= 20),
  quantity numeric(14, 3) not null default 1 check (quantity >= 0 and quantity <= 1000000),
  rate numeric(12, 4) not null default 0 check (rate >= 0 and rate <= 1000000),
  -- quantity × rate, to the cent (kept by the database).
  amount numeric(12, 2) not null default 0 check (amount <= 10000000),
  service_id uuid,
  pay_rate_id uuid,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, job_pay_id) references public.job_pay (company_id, id) on delete cascade,
  foreign key (company_id, service_id) references public.services (company_id, id) on delete set null (service_id),
  foreign key (company_id, pay_rate_id) references public.pay_rates (company_id, id) on delete set null (pay_rate_id)
);
create index job_pay_lines_pay_idx on public.job_pay_lines (job_pay_id, sort);

create table public.job_pay_visits (
  company_id uuid not null,
  job_pay_id uuid not null,
  visit_id uuid not null,
  -- The sub's sign-ins this pay put on the visit (and takes off again).
  assigned uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (job_pay_id, visit_id),
  foreign key (company_id, job_pay_id) references public.job_pay (company_id, id) on delete cascade,
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade
);
create index job_pay_visits_visit_idx on public.job_pay_visits (visit_id);

select private.add_touch_triggers(array['pay_rates', 'job_pay', 'job_pay_lines']);

-- ---------------------------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------------------------

alter table public.pay_rates enable row level security;
create policy pay_rates_office on public.pay_rates for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and (
    (subcontractor_id is not null and private.has_perm(company_id, 'subs')) or (user_id is not null and private.has_perm(company_id, 'job_costs'))))
  with check (private.has_role(company_id, '{owner,admin,office}') and (
    (subcontractor_id is not null and private.has_perm(company_id, 'subs')) or (user_id is not null and private.has_perm(company_id, 'job_costs'))));

alter table public.job_pay enable row level security;
create policy job_pay_office on public.job_pay for all to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and (
    (subcontractor_id is not null and private.has_perm(company_id, 'subs')) or (user_id is not null and private.has_perm(company_id, 'job_costs'))))
  with check (private.has_role(company_id, '{owner,admin,office}') and (
    (subcontractor_id is not null and private.has_perm(company_id, 'subs')) or (user_id is not null and private.has_perm(company_id, 'job_costs'))));
-- A sub's own, once it's more than the office's draft.
create policy job_pay_sub_read on public.job_pay for select to authenticated
  using (status <> 'draft' and (company_id, subcontractor_id) in (select s.company_id, s.subcontractor_id from private.my_subs() s));

-- Lines and covered visits go with the pay: whoever reads it reads them, and the office that
-- handles it changes them.
alter table public.job_pay_lines enable row level security;
create policy job_pay_lines_read on public.job_pay_lines for select to authenticated
  using ((company_id, job_pay_id) in (select p.company_id, p.id from public.job_pay p));
create policy job_pay_lines_insert on public.job_pay_lines for insert to authenticated
  with check (private.has_role(company_id, '{owner,admin,office}') and (company_id, job_pay_id) in (select p.company_id, p.id from public.job_pay p));
create policy job_pay_lines_update on public.job_pay_lines for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and (company_id, job_pay_id) in (select p.company_id, p.id from public.job_pay p))
  with check (private.has_role(company_id, '{owner,admin,office}') and (company_id, job_pay_id) in (select p.company_id, p.id from public.job_pay p));
create policy job_pay_lines_delete on public.job_pay_lines for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and (company_id, job_pay_id) in (select p.company_id, p.id from public.job_pay p));

alter table public.job_pay_visits enable row level security;
create policy job_pay_visits_read on public.job_pay_visits for select to authenticated
  using ((company_id, job_pay_id) in (select p.company_id, p.id from public.job_pay p));
create policy job_pay_visits_insert on public.job_pay_visits for insert to authenticated
  with check (private.has_role(company_id, '{owner,admin,office}') and (company_id, job_pay_id) in (select p.company_id, p.id from public.job_pay p));
create policy job_pay_visits_delete on public.job_pay_visits for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and (company_id, job_pay_id) in (select p.company_id, p.id from public.job_pay p));

-- Status, money and who's on which visit are the database's (the functions below); from a browser,
-- a rate's terms, a pay's notes, its lines and which visits it covers.
revoke all on public.pay_rates, public.job_pay, public.job_pay_lines, public.job_pay_visits from anon;
revoke insert, update on public.pay_rates, public.job_pay, public.job_pay_lines, public.job_pay_visits from authenticated;
grant insert (company_id, subcontractor_id, user_id, basis, service_id, squares_basis, rate, description, active) on public.pay_rates to authenticated;
grant update (basis, service_id, squares_basis, rate, description, active) on public.pay_rates to authenticated;
grant insert (company_id, job_id, subcontractor_id, user_id, notes) on public.job_pay to authenticated;
grant update (notes) on public.job_pay to authenticated;
grant insert (company_id, job_pay_id, description, basis, unit, quantity, rate, service_id, pay_rate_id, sort) on public.job_pay_lines to authenticated;
grant update (description, basis, unit, quantity, rate, service_id, pay_rate_id, sort) on public.job_pay_lines to authenticated;
grant insert (company_id, job_pay_id, visit_id) on public.job_pay_visits to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Rates
-- ---------------------------------------------------------------------------------------------

-- A rate is for a sub or someone on the team, and keeps to them. A rate per unit takes its service's
-- unit; per day and per job are "day" and "job". Roof squares without waste are only for squares.
create function private.pay_rate_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.company_id <> old.company_id or new.subcontractor_id is distinct from old.subcontractor_id
     or new.user_id is distinct from old.user_id) then
    raise exception 'A rate stays with whoever it''s for. Add a new one instead.' using errcode = '22023';
  end if;
  if new.user_id is not null and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) and not private.on_team(new.company_id, new.user_id) then
    raise exception 'Pay rates are for subs and people on your team.' using errcode = '22023';
  end if;
  if new.basis = 'per_unit' then
    select s.unit into new.unit from public.services s where s.company_id = new.company_id and s.id = new.service_id;
  else
    new.service_id := null;
    new.unit := case new.basis when 'per_day' then 'day' else 'job' end;
    new.squares_basis := 'job';
  end if;
  if new.squares_basis = 'roof_no_waste' and not private.is_square_unit(new.unit) then
    raise exception 'Roof squares without waste is only for a rate per square.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger defaults before insert or update on public.pay_rates for each row execute function private.pay_rate_defaults();

-- ---------------------------------------------------------------------------------------------
-- Keeping pay straight
-- ---------------------------------------------------------------------------------------------

-- New pay starts as a draft with nothing on it yet; what it comes to is its lines'. Piece pay is
-- for someone on the team (a sub is paid as a sub).
create function private.job_pay_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is not null and not private.on_team(new.company_id, new.user_id) then
    raise exception 'Piece pay is for people on your team. Pay a sub as a sub.' using errcode = '22023';
  end if;
  new.status := 'draft';
  new.total := 0;
  new.earned_on := null;
  new.paid_at := null;
  new.paid_amount := null;
  new.method := null;
  new.reference := null;
  new.paid_by := null;
  new.pay_period_id := null;
  if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
  return new;
end $$;
create trigger defaults before insert on public.job_pay for each row execute function private.job_pay_defaults();

-- The rules for every change, whoever makes it:
--   - Pay stays with its job and its payee.
--   - It moves along only as private.job_pay_moves allows. Before the work is done there's no
--     earned_on; paid needs when, how much and how, and leaving paid clears them (unpaying goes back
--     to done).
--   - A team member's is paid only with their pay period. One paid with a period that's then deleted
--     is done again, waiting for the next.
--   - In a pay period that's been marked paid, it stays as it was paid (as the time in it does) until
--     the mark is taken back. Only that period's own triggers (a level down) change it.
--   - A team member's work isn't marked done on a day in a period that's been paid already: it would
--     never be paid with it. (Done by itself, a level down, private.job_pay_sync_done moves the day
--     past such periods instead.)
create function private.job_pay_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.company_id <> old.company_id or new.job_id <> old.job_id
     or new.subcontractor_id is distinct from old.subcontractor_id or new.user_id is distinct from old.user_id then
    raise exception 'Pay stays with its job and whoever it''s for. Cancel it and start another.' using errcode = '22023';
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if new.user_id is not null and new.status = 'paid' and new.pay_period_id is null then
    if old.status = 'paid' and old.pay_period_id is not null then
      new.status := 'done';
    else
      raise exception 'Pay for people on your team is paid with their pay period, under Timesheets → Pay.' using errcode = '22023';
    end if;
  end if;
  if pg_trigger_depth() = 1 and old.pay_period_id is not null and exists (
    select 1 from public.pay_period_lines l where l.period_id = old.pay_period_id and l.user_id = old.user_id and l.paid_at is not null
  ) then
    raise exception 'This pay is in a pay period that''s been marked paid. Take back the paid mark first (Timesheets → Pay).' using errcode = '22023';
  end if;
  if new.status is distinct from old.status then
    if not private.job_pay_moves(old.status, new.status) then
      raise exception 'Pay that''s % can''t be %.', replace(old.status, 'accepted', 'agreed'), replace(new.status, 'accepted', 'agreed') using errcode = '22023';
    end if;
    if new.status in ('draft', 'offered', 'accepted') then
      new.earned_on := null;
    end if;
  end if;
  if new.status <> 'paid' then
    new.paid_at := null;
    new.paid_amount := null;
    new.method := null;
    new.reference := null;
    new.paid_by := null;
    new.pay_period_id := null;
  end if;
  if pg_trigger_depth() = 1 and new.user_id is not null and new.status = 'done'
     and (old.status <> 'done' or new.earned_on is distinct from old.earned_on)
     and private.paid_for(new.company_id, new.user_id, new.earned_on) then
    raise exception 'That day is in a pay period that''s been marked paid. Pick a later day, or take back the paid mark first (Timesheets → Pay).' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger guard before update on public.job_pay for each row execute function private.job_pay_guard();

-- A draft, or pay that's over, can go; anything else is cancelled, so it stays on record.
create function private.job_pay_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and old.status not in ('draft', 'declined', 'withdrawn', 'expired', 'cancelled') then
    raise exception 'Only a draft or cancelled pay can be deleted. Cancel this one instead.' using errcode = '22023';
  end if;
  return old;
end $$;
create trigger delete_guard before delete on public.job_pay for each row execute function private.job_pay_delete_guard();

-- A job or a sub with pay on record isn't deleted (it would take the pay, and what a sub was paid,
-- with it): the job is archived and the sub turned off. Drafts and cancelled pay go with them.
create function private.job_pay_record_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then return old; end if;
  if tg_table_name = 'jobs' then
    if exists (select 1 from public.job_pay p where p.job_id = old.id and p.status in ('offered', 'accepted', 'done', 'paid')) then
      raise exception 'This job has pay on record for a sub or the crew. Archive the job instead, or cancel that pay first.' using errcode = '22023';
    end if;
  elsif exists (select 1 from public.job_pay p where p.subcontractor_id = old.id and p.status in ('offered', 'accepted', 'done', 'paid')) then
    raise exception '% has pay on record. Turn them off instead.', old.name using errcode = '22023';
  end if;
  return old;
end $$;
create trigger pay_guard before delete on public.jobs for each row execute function private.job_pay_record_guard();
create trigger pay_guard before delete on public.subcontractors for each row execute function private.job_pay_record_guard();

-- A pay's lines and visits change while it's a draft or agreed, not once the work is done or paid.
-- A visit comes out of pay that's over (so the visit itself can be deleted). When the pay itself is
-- being deleted, they go with it; when a service or rate a line names is deleted, the database
-- clearing it (a level down) isn't a change to the pay.
create function private.job_pay_part_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then return new; end if;
  select p.status into v_status from public.job_pay p where p.id = coalesce(new.job_pay_id, old.job_pay_id);
  if not found then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and (new.company_id <> old.company_id or new.job_pay_id <> old.job_pay_id) then
    raise exception 'A line stays on its pay.' using errcode = '22023';
  end if;
  if v_status in ('draft', 'accepted')
     or (tg_table_name = 'job_pay_visits' and tg_op = 'DELETE' and v_status not in ('done', 'paid')) then
    return coalesce(new, old);
  end if;
  if v_status in ('done', 'paid') then
    if tg_table_name = 'job_pay_lines' then
      raise exception 'This pay''s work is done, so its lines stay as they are.' using errcode = '22023';
    end if;
    raise exception 'This pay''s work is done, so the visits it covers stay as they are. To take a visit off the schedule, cancel it instead of deleting it.' using errcode = '22023';
  end if;
  raise exception 'Change pay while it''s a draft or agreed.' using errcode = '22023';
end $$;
create trigger guard before insert or update or delete on public.job_pay_lines for each row execute function private.job_pay_part_guard();
create trigger guard before insert or delete on public.job_pay_visits for each row execute function private.job_pay_part_guard();

-- A line's amount is its quantity × rate, to the cent; per day and per job lines count days and jobs.
create function private.job_pay_line_amount() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.unit := coalesce(nullif(btrim(new.unit), ''), case new.basis when 'per_day' then 'day' when 'per_job' then 'job' end);
  new.amount := round(new.quantity * new.rate, 2);
  return new;
end $$;
create trigger amount before insert or update on public.job_pay_lines for each row execute function private.job_pay_line_amount();

-- The pay's total follows its lines.
create function private.job_pay_total() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_pay uuid;
begin
  foreach v_pay in array array[case when tg_op <> 'DELETE' then new.job_pay_id end, case when tg_op <> 'INSERT' then old.job_pay_id end] loop
    continue when v_pay is null;
    update public.job_pay p set total = x.total
    from (select coalesce(sum(l.amount), 0) as total from public.job_pay_lines l where l.job_pay_id = v_pay) x
    where p.id = v_pay and p.total is distinct from x.total;
  end loop;
  return null;
end $$;
create trigger total after insert or update or delete on public.job_pay_lines for each row execute function private.job_pay_total();

-- A visit it covers is on the pay's job.
create function private.job_pay_visit_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.visits v join public.job_pay p on p.id = new.job_pay_id
    where v.id = new.visit_id and v.company_id = p.company_id and v.job_id = p.job_id
  ) then
    raise exception 'That visit isn''t on this pay''s job.' using errcode = '22023';
  end if;
  new.assigned := '{}';
  return new;
end $$;
create trigger on_job before insert on public.job_pay_visits for each row execute function private.job_pay_visit_check();

-- ---------------------------------------------------------------------------------------------
-- Putting a sub on the visits, and done when the work is
-- ---------------------------------------------------------------------------------------------

-- The sub's active sign-ins, put on the pay's visits (one, or all it covers, not cancelled ones),
-- noting who this pay put there. Someone already on a visit stays the office's to take off. Their
-- usual notices go out ("You're on ...").
create function private.job_pay_assign(p_pay uuid, p_visit uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; x record; v_added uuid[];
begin
  select * into p from public.job_pay where id = p_pay;
  if p.subcontractor_id is null then return; end if;
  for x in
    select jv.visit_id from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
    where jv.job_pay_id = p_pay and (p_visit is null or jv.visit_id = p_visit) and v.status <> 'cancelled'
  loop
    with added as (
      insert into public.visit_assignees (company_id, visit_id, user_id)
      select p.company_id, x.visit_id, m.user_id
      from public.memberships m
      join public.subcontractors s on s.company_id = m.company_id and s.id = m.subcontractor_id
      where m.company_id = p.company_id and m.subcontractor_id = p.subcontractor_id and m.active and s.active
      on conflict do nothing
      returning user_id
    )
    select coalesce(array_agg(user_id), '{}') into v_added from added;
    if cardinality(v_added) > 0 then
      update public.job_pay_visits set assigned = array(select distinct u from unnest(assigned || v_added) u)
      where job_pay_id = p_pay and visit_id = x.visit_id;
    end if;
  end loop;
end $$;

-- Taking off a visit those this pay put there, unless it's done (who did the work stays on record).
create function private.job_pay_unassign(p_visit uuid, p_users uuid[]) returns void
language sql security definer set search_path = '' as $$
  delete from public.visit_assignees a using public.visits v
  where a.visit_id = p_visit and v.id = p_visit and v.status <> 'completed' and a.user_id = any (p_users)
$$;

-- Agreed pay whose visits are all finished (completed, or cancelled with at least one completed) is
-- done, earned on the day the last one was completed, the company's (not later than today). For a
-- team member, a day in a pay period they've been paid for moves to the day after it (and after any
-- paid period that follows), so the pay is counted in the next one they haven't been: done in a paid
-- period, it would never be paid. That day can still be to come, when a week is paid before it
-- ends. Nothing is refused here: it would stop the visit being completed.
create function private.job_pay_sync_done(p_pay uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_open integer; v_done integer; v_last timestamptz; v_tz text; v_day date; v_next date;
begin
  select * into p from public.job_pay where id = p_pay for update;
  if not found or p.status <> 'accepted' then return; end if;
  select count(*) filter (where v.status not in ('completed', 'cancelled')), count(*) filter (where v.status = 'completed'),
         max(coalesce(v.completed_at, v.updated_at)) filter (where v.status = 'completed')
    into v_open, v_done, v_last
  from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
  where jv.job_pay_id = p_pay;
  if v_open = 0 and v_done > 0 then
    select c.timezone into v_tz from public.companies c where c.id = p.company_id;
    v_day := (least(v_last, now()) at time zone coalesce(v_tz, 'UTC'))::date;
    while p.user_id is not null loop
      select max(pp.ends_on) + 1 into v_next
      from public.pay_period_lines l join public.pay_periods pp on pp.id = l.period_id
      where l.user_id = p.user_id and pp.company_id = p.company_id and l.paid_at is not null and v_day between pp.starts_on and pp.ends_on;
      exit when v_next is null;
      v_day := v_next;
    end loop;
    update public.job_pay set status = 'done', earned_on = v_day where id = p_pay;
  end if;
end $$;

revoke all on function private.job_pay_assign(uuid, uuid), private.job_pay_unassign(uuid, uuid[]), private.job_pay_sync_done(uuid) from public;

-- Agreed: the sub goes on its visits. Cancelled: off them again. Agreed after the work (it's all
-- done already): done straight away.
create function private.job_pay_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x record;
begin
  if new.subcontractor_id is not null then
    if new.status = 'accepted' and old.status in ('draft', 'offered') then
      perform private.job_pay_assign(new.id, null);
    elsif new.status = 'cancelled' then
      for x in select jv.visit_id, jv.assigned from public.job_pay_visits jv where jv.job_pay_id = new.id and cardinality(jv.assigned) > 0 loop
        perform private.job_pay_unassign(x.visit_id, x.assigned);
      end loop;
      update public.job_pay_visits set assigned = '{}' where job_pay_id = new.id and cardinality(assigned) > 0;
    end if;
  end if;
  if new.status = 'accepted' then
    perform private.job_pay_sync_done(new.id);
  end if;
  return null;
end $$;
create trigger status_change after update of status on public.job_pay
  for each row when (old.status is distinct from new.status) execute function private.job_pay_status_change();

-- A visit added to agreed pay puts the sub on it; one taken out takes them off. Either way the pay
-- may now be done.
create function private.job_pay_visit_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay;
begin
  select * into p from public.job_pay where id = coalesce(new.job_pay_id, old.job_pay_id);
  if not found or p.status <> 'accepted' then return null; end if;
  if p.subcontractor_id is not null then
    if tg_op = 'INSERT' then
      perform private.job_pay_assign(p.id, new.visit_id);
    elsif cardinality(old.assigned) > 0 then
      perform private.job_pay_unassign(old.visit_id, old.assigned);
    end if;
  end if;
  perform private.job_pay_sync_done(p.id);
  return null;
end $$;
create trigger assign after insert or delete on public.job_pay_visits for each row execute function private.job_pay_visit_change();

-- A visit completed (or cancelled) may finish the pay that covers it. One reopened puts done pay
-- back to agreed, to be done again when it's finished, unless the pay covers another visit that
-- isn't finished: then the office marked it done itself, and it stays so.
create function private.visit_job_pay() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x record;
begin
  if old.status = 'completed' and new.status not in ('completed', 'cancelled') then
    update public.job_pay jp set status = 'accepted'
    where jp.status = 'done' and jp.id in (select jv.job_pay_id from public.job_pay_visits jv where jv.visit_id = new.id)
      and not exists (
        select 1 from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
        where jv.job_pay_id = jp.id and v.id <> new.id and v.status not in ('completed', 'cancelled')
      );
  elsif new.status in ('completed', 'cancelled') then
    for x in select jv.job_pay_id from public.job_pay_visits jv where jv.visit_id = new.id loop
      perform private.job_pay_sync_done(x.job_pay_id);
    end loop;
  end if;
  return null;
end $$;
create trigger job_pay after update of status on public.visits
  for each row when (old.status is distinct from new.status) execute function private.visit_job_pay();

-- ---------------------------------------------------------------------------------------------
-- Filling in the lines
-- ---------------------------------------------------------------------------------------------

-- The visits on a job that a payee is on: a sub's sign-ins, or the person (on the visit, or on or
-- leading its crew). Not cancelled ones.
create function private.payee_visits(p_job uuid, p_subcontractor uuid, p_user uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(v.id order by v.scheduled_on, v.starts_at, v.id), '{}')
  from public.visits v
  where v.job_id = p_job and v.status <> 'cancelled' and (
    exists (
      select 1 from public.visit_assignees a
      where a.visit_id = v.id and (a.user_id = p_user or a.user_id in (
        select m.user_id from public.memberships m where m.company_id = v.company_id and m.subcontractor_id = p_subcontractor))
    )
    or (p_user is not null and v.crew_id is not null and (
      exists (select 1 from public.crews c where c.id = v.crew_id and c.lead_user_id = p_user)
      or exists (select 1 from public.crew_members cm where cm.crew_id = v.crew_id and cm.user_id = p_user)))
  )
$$;

-- The visits pay covers: the ones chosen (all on the job), else those of the payee's pay on the job
-- already, else the visits they're on.
create function private.job_pay_cover(p_job uuid, p_subcontractor uuid, p_user uuid, p_visits uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare v_visits uuid[];
begin
  if p_visits is not null then
    if exists (select 1 from unnest(p_visits) x where not exists (select 1 from public.visits v where v.id = x and v.job_id = p_job)) then
      raise exception 'Choose visits on this job.' using errcode = '22023';
    end if;
    return array(select distinct x from unnest(p_visits) x);
  end if;
  select array_agg(jv.visit_id order by v.scheduled_on, v.starts_at, v.id) into v_visits
  from public.job_pay p join public.job_pay_visits jv on jv.job_pay_id = p.id join public.visits v on v.id = jv.visit_id
  where p.job_id = p_job and (p.subcontractor_id = p_subcontractor or p.user_id = p_user) and private.job_pay_live(p.status);
  return coalesce(v_visits, private.payee_visits(p_job, p_subcontractor, p_user));
end $$;

revoke all on function private.payee_visits(uuid, uuid, uuid), private.job_pay_cover(uuid, uuid, uuid, uuid[]) from public;

/**
 * The lines a payee's active rates come to on a job, for the office that handles their pay (a sub
 * or p_user, someone on the team), with a plain note of where each quantity came from:
 *   - per unit: the service's quantity on the job's lines, approved change orders in and discount
 *     lines out. Counting the roof's squares without waste, that's divided by 1 + the waste of the
 *     latest measurement on the job's quote, to 2 places; with none, it's the job's, flagged.
 *   - per day: the days among the visits it covers (p_visits, else those of their pay on the job,
 *     else the visits they're on), the company's dates.
 *   - per job: once.
 * check_it is true when the quantity needs a look (nothing to count, or waste couldn't be taken out).
 */
create function public.job_pay_suggest(p_job uuid, p_subcontractor uuid default null, p_user uuid default null, p_visits uuid[] default null)
returns table (pay_rate_id uuid, description text, basis text, unit text, service_id uuid, quantity numeric, rate numeric, amount numeric,
               note text, check_it boolean, sort integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  j public.jobs;
  r record;
  v_visits uuid[];
  v_qty numeric;
  v_lines integer;
  v_changes integer;
  v_waste numeric;
  v_days date[];
  v_n integer := 0;
begin
  select * into j from public.jobs x where x.id = p_job and x.company_id = any (private.role_companies('{owner,admin,office}'));
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  if not private.handles_pay(j.company_id, p_subcontractor, p_user) then
    raise exception 'Your role can''t set this pay' using errcode = '42501';
  end if;
  v_visits := private.job_pay_cover(p_job, p_subcontractor, p_user, p_visits);
  select m.waste_pct into v_waste from public.measurements m
  where j.quote_id is not null and m.company_id = j.company_id and m.quote_id = j.quote_id
  order by m.created_at desc, m.id desc limit 1;
  for r in
    select pr.id, pr.basis, pr.unit, pr.service_id, pr.squares_basis, pr.rate, pr.description, s.name as service_name
    from public.pay_rates pr left join public.services s on s.id = pr.service_id
    where pr.company_id = j.company_id and pr.active
      and (pr.subcontractor_id = p_subcontractor or pr.user_id = p_user)
    order by case pr.basis when 'per_unit' then 0 when 'per_day' then 1 else 2 end, s.sort, coalesce(pr.description, s.name), pr.created_at, pr.id
  loop
    v_n := v_n + 1;
    pay_rate_id := r.id;
    basis := r.basis;
    unit := r.unit;
    service_id := r.service_id;
    rate := r.rate;
    check_it := false;
    sort := v_n;
    description := coalesce(nullif(btrim(r.description), ''), r.service_name, case r.basis when 'per_day' then 'Day rate' else 'Price for the job' end);
    if r.basis = 'per_unit' then
      select coalesce(sum(li.quantity), 0), count(*), count(*) filter (where li.source_quote_id is not null)
        into v_qty, v_lines, v_changes
      from public.job_line_items li
      where li.job_id = p_job and li.service_id = r.service_id and li.unit_price >= 0;
      if v_lines = 0 then
        quantity := 0;
        check_it := true;
        note := format('There''s no %s on this job.', r.service_name);
      elsif r.squares_basis = 'roof_no_waste' and v_waste is not null then
        quantity := round(v_qty / (1 + v_waste / 100), 2);
        note := format('%s without the roof measurement''s %s%% waste. The job has %s.',
          private.amount_words(quantity, r.unit), trim_scale(v_waste), private.amount_words(v_qty, r.unit));
      elsif r.squares_basis = 'roof_no_waste' then
        quantity := v_qty;
        check_it := true;
        note := format('The job''s %s, waste included: its quote has no roof measurement to take the waste out. Check it.', private.amount_words(v_qty, r.unit));
      else
        quantity := v_qty;
        note := format('%s of %s on the job', private.amount_words(v_qty, r.unit), r.service_name)
          || case when v_changes > 0 then ', change orders included.' else '.' end;
      end if;
    elsif r.basis = 'per_day' then
      select coalesce(array_agg(distinct v.scheduled_on order by v.scheduled_on), '{}') into v_days
      from public.visits v where v.id = any (v_visits) and v.status <> 'cancelled' and v.scheduled_on is not null;
      quantity := cardinality(v_days);
      if quantity = 0 then
        check_it := true;
        note := 'Choose the visits it covers to count the days.';
      else
        note := format('%s on the visits it covers: %s.', private.amount_words(quantity, 'day'),
          (select string_agg(to_char(d, 'Mon FMDD'), ', ' order by d) from unnest(v_days) d));
      end if;
    else
      quantity := 1;
      note := 'Once for the job.';
    end if;
    amount := round(quantity * rate, 2);
    return next;
  end loop;
end $$;

/**
 * Before pay is started, for the office that handles it: the visits it covers unless others are
 * chosen (those of the payee's pay on the job already, else the visits they're on, by their own
 * assignment or their crew's), so the screen ticks the same ones the database will. For a sub, how
 * many sign-ins of theirs would go on those visits when it's agreed (none for a sub who doesn't
 * sign in); null for someone on the team.
 */
create function public.job_pay_covers(p_job uuid, p_subcontractor uuid default null, p_user uuid default null)
returns table (visit_ids uuid[], sign_ins integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare j public.jobs;
begin
  select * into j from public.jobs x where x.id = p_job and x.company_id = any (private.role_companies('{owner,admin,office}'));
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  if not private.handles_pay(j.company_id, p_subcontractor, p_user) then
    raise exception 'Your role can''t set this pay' using errcode = '42501';
  end if;
  visit_ids := private.job_pay_cover(p_job, p_subcontractor, p_user, null);
  if p_subcontractor is not null then
    select count(*)::integer into sign_ins
    from public.memberships m join public.subcontractors s on s.company_id = m.company_id and s.id = m.subcontractor_id
    where m.company_id = j.company_id and m.subcontractor_id = p_subcontractor and m.active and s.active;
  end if;
  return next;
end $$;

-- ---------------------------------------------------------------------------------------------
-- What the office does with pay
-- ---------------------------------------------------------------------------------------------

/**
 * New pay for a sub (p_subcontractor) or someone on the team (p_user) on a job: a draft covering the
 * visits chosen (else the ones they're on), with the lines their rates suggest. The office then
 * changes the lines as it likes and agrees it.
 */
create function public.job_pay_start(p_job uuid, p_subcontractor uuid default null, p_user uuid default null, p_visits uuid[] default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; v_visits uuid[]; v_id uuid;
begin
  select * into j from public.jobs x where x.id = p_job and x.company_id = any (private.role_companies('{owner,admin,office}'));
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  if not private.handles_pay(j.company_id, p_subcontractor, p_user) then
    raise exception 'Your role can''t set this pay' using errcode = '42501';
  end if;
  if exists (select 1 from public.job_pay p where p.job_id = p_job and (p.subcontractor_id = p_subcontractor or p.user_id = p_user) and private.job_pay_live(p.status)) then
    raise exception 'They already have pay on this job. Open it to change it.' using errcode = '22023';
  end if;
  v_visits := private.job_pay_cover(p_job, p_subcontractor, p_user, p_visits);
  insert into public.job_pay (company_id, job_id, subcontractor_id, user_id) values (j.company_id, p_job, p_subcontractor, p_user) returning id into v_id;
  insert into public.job_pay_visits (company_id, job_pay_id, visit_id) select j.company_id, v_id, x from unnest(v_visits) x;
  insert into public.job_pay_lines (company_id, job_pay_id, description, basis, unit, quantity, rate, service_id, pay_rate_id, sort)
  select j.company_id, v_id, s.description, s.basis, s.unit, s.quantity, s.rate, s.service_id, s.pay_rate_id, s.sort
  from public.job_pay_suggest(p_job, p_subcontractor, p_user, v_visits) s;
  return v_id;
end $$;

-- The pay, locked, if the person handles it.
create function private.job_pay_for_office(p_pay uuid) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay;
begin
  select * into p from public.job_pay where id = p_pay for update;
  if not found or not private.handles_pay(p.company_id, p.subcontractor_id, p.user_id) then
    raise exception 'Pay not found' using errcode = 'P0002';
  end if;
  return p;
end $$;
revoke all on function private.job_pay_for_office(uuid) from public;

/**
 * The office agrees the pay (for a sub, standing for "agreed by phone"; offers come later): it can
 * set the visits it covers first (p_visits; else they stay as they are, none meaning none). A sub
 * then goes on those visits. Pay agreed after the work is done straight away.
 */
create function public.job_pay_accept(p_pay uuid, p_visits uuid[] default null) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay;
begin
  p := private.job_pay_for_office(p_pay);
  if p.status not in ('draft', 'offered') then
    raise exception '%', case p.status
      when 'accepted' then 'This pay is already agreed.'
      when 'done' then 'This pay is already agreed, and the work is done.'
      when 'paid' then 'This pay is already paid.'
      else 'This pay is over. Start new pay for them instead.' end using errcode = '22023';
  end if;
  if p_visits is not null then
    p_visits := private.job_pay_cover(p.job_id, p.subcontractor_id, p.user_id, p_visits);
    delete from public.job_pay_visits where job_pay_id = p.id and visit_id <> all (p_visits);
    insert into public.job_pay_visits (company_id, job_pay_id, visit_id) select p.company_id, p.id, x from unnest(p_visits) x on conflict do nothing;
  end if;
  update public.job_pay set status = 'accepted' where id = p.id;
  select * into p from public.job_pay where id = p_pay;
  return p;
end $$;

/**
 * The office marks agreed work done: on p_earned_on, else the day the last visit it covers was
 * completed (when they all are), else today, the company's. For pay with no visits, or work finished
 * without them.
 */
create function public.job_pay_mark_done(p_pay uuid, p_earned_on date default null) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_tz text; v_today date; v_last date;
begin
  p := private.job_pay_for_office(p_pay);
  if p.status <> 'accepted' then
    raise exception '%', case
      when p.status in ('done', 'paid') then 'This work is already marked done.'
      when p.status in ('draft', 'offered') then 'Agree the pay first.'
      else 'This pay is over.' end using errcode = '22023';
  end if;
  select c.timezone into v_tz from public.companies c where c.id = p.company_id;
  v_today := private.company_today(p.company_id);
  if p_earned_on > v_today then
    raise exception 'Pick the day the work was done. It can''t be in the future.' using errcode = '22023';
  end if;
  if p_earned_on is null and not exists (
    select 1 from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id where jv.job_pay_id = p.id and v.status not in ('completed', 'cancelled')
  ) then
    select (max(v.completed_at) at time zone coalesce(v_tz, 'UTC'))::date into v_last
    from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id where jv.job_pay_id = p.id and v.status = 'completed';
  end if;
  update public.job_pay set status = 'done', earned_on = coalesce(p_earned_on, v_last, v_today) where id = p.id;
  select * into p from public.job_pay where id = p_pay;
  return p;
end $$;

/**
 * The office calls it off. A sub comes off the visits it put them on, unless they're done. A draft
 * is deleted instead (cancelled pay is the sub's to read).
 */
create function public.job_pay_cancel(p_pay uuid) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay;
begin
  p := private.job_pay_for_office(p_pay);
  if p.status = 'draft' then
    raise exception 'This pay is still a draft. Delete it instead.' using errcode = '22023';
  end if;
  if p.status = 'paid' then
    raise exception 'This pay is marked paid. Take that back first.' using errcode = '22023';
  end if;
  if not private.job_pay_live(p.status) then
    raise exception 'This pay is already over.' using errcode = '22023';
  end if;
  update public.job_pay set status = 'cancelled' where id = p.id;
  select * into p from public.job_pay where id = p_pay;
  return p;
end $$;

/**
 * Subs' pay for work that's done, marked paid: how (p_method; payroll is a payroll service's contractor
 * payment, which counts toward their 1099 as a check does), on p_paid_on (the company's day; today
 * unless given, never later), a reference, and p_amount (only for one, else each one's total). One or
 * several at once. A team member's is paid with their pay period, under Timesheets → Pay.
 */
create function public.job_pay_mark_paid(p_pays uuid[], p_method text, p_paid_on date default null, p_reference text default null, p_amount numeric default null)
returns setof public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_id uuid; v_tz text; v_today date; v_paid date;
begin
  if coalesce(cardinality(p_pays), 0) = 0 then
    raise exception 'Choose what to mark paid.' using errcode = '22023';
  end if;
  if p_amount is not null and cardinality(p_pays) > 1 then
    raise exception 'Mark them paid one at a time to give each its own amount.' using errcode = '22023';
  end if;
  if p_method is null or p_method not in ('check', 'ach', 'cash', 'card_or_app', 'payroll', 'other') then
    raise exception 'Choose how you paid them.' using errcode = '22023';
  end if;
  for v_id in select distinct x from unnest(p_pays) x order by 1 loop
    p := private.job_pay_for_office(v_id);
    if p.user_id is not null then
      raise exception 'Pay for people on your team is paid with their pay period, under Timesheets → Pay.' using errcode = '22023';
    end if;
    if p.status <> 'done' then
      raise exception '%', case p.status
        when 'paid' then 'Some of this is already marked paid.'
        when 'accepted' then 'Mark the work done first.'
        else 'Only pay for work that''s done can be marked paid.' end using errcode = '22023';
    end if;
    select c.timezone into v_tz from public.companies c where c.id = p.company_id;
    v_today := private.company_today(p.company_id);
    v_paid := coalesce(p_paid_on, v_today);
    if v_paid > v_today then
      raise exception 'Pick the day you paid them. It can''t be in the future.' using errcode = '22023';
    end if;
    update public.job_pay set status = 'paid',
      paid_at = (v_paid + time '12:00') at time zone coalesce(v_tz, 'UTC'),
      paid_amount = round(coalesce(p_amount, p.total), 2),
      method = p_method,
      reference = nullif(btrim(p_reference), ''),
      paid_by = (select auth.uid())
    where id = p.id
    returning * into p;
    return next p;
  end loop;
end $$;

/** A paid mark taken back: the work is done and owed again. A team member's, with their pay period. */
create function public.job_pay_unmark_paid(p_pays uuid[]) returns setof public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_id uuid;
begin
  if coalesce(cardinality(p_pays), 0) = 0 then
    raise exception 'Choose what to take the paid mark off.' using errcode = '22023';
  end if;
  for v_id in select distinct x from unnest(p_pays) x order by 1 loop
    p := private.job_pay_for_office(v_id);
    if p.user_id is not null then
      raise exception 'This was paid with a pay period. Take back that period''s paid mark instead (Timesheets → Pay).' using errcode = '22023';
    end if;
    if p.status <> 'paid' then
      raise exception 'Some of this isn''t marked paid.' using errcode = '22023';
    end if;
    update public.job_pay set status = 'done' where id = p.id returning * into p;
    return next p;
  end loop;
end $$;

revoke execute on function public.job_pay_suggest(uuid, uuid, uuid, uuid[]), public.job_pay_covers(uuid, uuid, uuid), public.job_pay_start(uuid, uuid, uuid, uuid[]),
  public.job_pay_accept(uuid, uuid[]), public.job_pay_mark_done(uuid, date), public.job_pay_cancel(uuid),
  public.job_pay_mark_paid(uuid[], text, date, text, numeric), public.job_pay_unmark_paid(uuid[]) from public, anon;
grant execute on function public.job_pay_suggest(uuid, uuid, uuid, uuid[]), public.job_pay_covers(uuid, uuid, uuid), public.job_pay_start(uuid, uuid, uuid, uuid[]),
  public.job_pay_accept(uuid, uuid[]), public.job_pay_mark_done(uuid, date), public.job_pay_cancel(uuid),
  public.job_pay_mark_paid(uuid[], text, date, text, numeric), public.job_pay_unmark_paid(uuid[]) to authenticated, service_role;

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
-- One quick try (half a second at most) while this migration holds its own locks: if a table is
-- busy, nothing is changed, and scripts/migrate.mjs folds the rest a table at a time right after.
select private.fold_member_checks(null, interval '0');

notify pgrst, 'reload schema';
