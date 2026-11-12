-- Hours are paid once. Pay periods can overlap (Timesheets → Pay offers "Last week" and "Last 2
-- weeks", and any dates), and time is locked by the day: a day someone is marked paid for, under
-- any period, is paid (private.paid_for). Until now a second period over the same days still summed
-- that time as owed and was marked paid at the full amount. Now a period pays only what's left:
-- the server leaves hours on already-paid days out of what's owed and out of the line it records
-- (apps/api/src/services/pay.ts), and this is the database's side of it, as piece pay has its own
-- (20261025003003_piece_pay_periods.sql):
--
--   * A line being marked paid for someone who's also marked paid for an overlapping period can't
--     carry more hours than their time on the days no other period has paid. It's refused with
--     "look again", which also settles two people marking overlapping periods at the same moment.
--   * Each line says when it was marked (marked_at). A period marked after another one it overlaps
--     left the shared days out, so the earlier mark can't be taken back while the later one stands:
--     those days would then be on record with neither. Take back the later one first.
--
-- Existing rows aren't changed. Lines marked before this have no marked_at: they recorded every
-- hour in their dates and left nothing out, so they count as marked before any line that has one.
-- Where two overlapping periods were both marked paid in full before this, the lines stay as
-- recorded (they say what was paid); each keeps showing what it recorded, and nothing in their
-- shared days is owed.

alter table public.pay_period_lines add column marked_at timestamptz;
comment on column public.pay_period_lines.marked_at is 'When this line was last marked paid (set by the database). Null while not paid, and on lines marked before 20261112000400.';

-- The person's finished time on the period's days that no other period has paid: the most a line
-- for it can carry. Days are the company's, as the lock on paid time counts them.
create function private.hours_left_to_pay(p_period uuid, p_user uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(greatest(extract(epoch from (e.ended_at - e.started_at)), 0)) / 3600, 0)::numeric
  from public.pay_periods pp
  join public.companies c on c.id = pp.company_id
  join public.time_entries e on e.company_id = pp.company_id and e.user_id = p_user and e.ended_at is not null
    and e.started_at >= (pp.starts_on::timestamp at time zone coalesce(c.timezone, 'UTC'))
    and e.started_at < ((pp.ends_on + 1)::timestamp at time zone coalesce(c.timezone, 'UTC'))
  where pp.id = p_period
    and not exists (
      select 1 from public.pay_period_lines l join public.pay_periods o on o.id = l.period_id
      where l.company_id = pp.company_id and l.user_id = p_user and l.paid_at is not null and o.id <> pp.id
        and (e.started_at at time zone coalesce(c.timezone, 'UTC'))::date between o.starts_on and o.ends_on
    )
$$;
revoke all on function private.hours_left_to_pay(uuid, uuid) from public;

create function private.pay_line_paid_once() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_left numeric;
  v_later record;
begin
  if new.paid_at is not null and (tg_op = 'INSERT' or old.paid_at is null) then
    -- One mark at a time in a company, so two at once over the same days see each other.
    perform pg_advisory_xact_lock(hashtextextended('pay_marks:' || new.company_id::text, 0));
    new.marked_at := clock_timestamp();
    if exists (
      select 1 from public.pay_period_lines l
      join public.pay_periods o on o.id = l.period_id
      join public.pay_periods mine on mine.id = new.period_id
      where l.company_id = new.company_id and l.user_id = new.user_id and l.paid_at is not null and l.period_id <> new.period_id
        and o.starts_on <= mine.ends_on and o.ends_on >= mine.starts_on
    ) then
      v_left := private.hours_left_to_pay(new.period_id, new.user_id);
      if new.hours > v_left + 0.01 then
        raise exception 'Some of their hours in this period have already been paid with another period (% h are left to pay). Look again, then mark them paid.', to_char(v_left, 'FM999,990.00')
          using errcode = '22023';
      end if;
    end if;
  elsif tg_op = 'UPDATE' and old.paid_at is not null and new.paid_at is null then
    select o.starts_on, o.ends_on into v_later
    from public.pay_period_lines l
    join public.pay_periods o on o.id = l.period_id
    join public.pay_periods mine on mine.id = old.period_id
    where l.company_id = old.company_id and l.user_id = old.user_id and l.paid_at is not null and l.period_id <> old.period_id
      and o.starts_on <= mine.ends_on and o.ends_on >= mine.starts_on
      and l.marked_at > coalesce(old.marked_at, '-infinity')
    order by l.marked_at desc limit 1;
    if found then
      raise exception '% was also marked paid for % to % after this, and that mark left out the days the two share as already paid. Take back that one first.',
        coalesce((select p.full_name from public.profiles p where p.user_id = old.user_id), 'Someone'), to_char(v_later.starts_on, 'FMMon FMDD'), to_char(v_later.ends_on, 'FMMon FMDD')
        using errcode = '22023';
    end if;
    new.marked_at := null;
  elsif tg_op = 'UPDATE' then
    new.marked_at := old.marked_at;
  else
    new.marked_at := null;
  end if;
  return new;
end $$;
create trigger paid_once before insert or update on public.pay_period_lines for each row execute function private.pay_line_paid_once();

notify pgrst, 'reload schema';
