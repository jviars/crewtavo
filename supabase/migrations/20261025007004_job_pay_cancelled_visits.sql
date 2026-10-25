-- Agreed pay isn't finished by itself when some of the visits it covers were cancelled after it was
-- agreed.
--
-- Pay is done (owed) by itself once every visit it covers is finished (private.job_pay_sync_done,
-- 20261025003001_job_pay.sql). Until now a visit cancelled after the price was agreed counted as
-- finished, so cancelling the rest of a sub's visits after the first day marked the whole agreed
-- price owed, told the sub "Owed: $3,000", and locked the lines, though the cancellation probably
-- changed what they're owed.
--
--   job_pay_visits.cancelled_while_agreed   set when a visit the pay covers is cancelled while the pay
--                                           is agreed (or a new price for it is waiting), and cleared if
--                                           the visit is put back. A visit cancelled before the price
--                                           was agreed doesn't count: the price was agreed without it.
--
-- Such pay stays agreed when the rest of its work is finished: the office checks the lines, then
-- presses Mark work done (the job's pay card says so). Done pay that goes back to agreed (a visit it
-- covers reopened) also stays agreed while one of these is there, so its lines can be corrected.

alter table public.job_pay_visits add column cancelled_while_agreed boolean not null default false;
comment on column public.job_pay_visits.cancelled_while_agreed is
  'The visit was cancelled after this pay was agreed: the pay isn''t finished by itself, the office checks its lines and marks the work done.';

-- As in 20261025003001_job_pay.sql, but not while a visit it covers was cancelled after it was agreed.
create or replace function private.job_pay_sync_done(p_pay uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_open integer; v_done integer; v_cut boolean; v_last timestamptz; v_tz text; v_day date; v_next date;
begin
  select * into p from public.job_pay where id = p_pay for update;
  if not found or p.status <> 'accepted' then return; end if;
  select count(*) filter (where v.status not in ('completed', 'cancelled')), count(*) filter (where v.status = 'completed'),
         coalesce(bool_or(v.status = 'cancelled' and jv.cancelled_while_agreed), false),
         max(coalesce(v.completed_at, v.updated_at)) filter (where v.status = 'completed')
    into v_open, v_done, v_cut, v_last
  from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
  where jv.job_pay_id = p_pay;
  if v_open = 0 and v_done > 0 and not v_cut then
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

-- As in 20261025003001_job_pay.sql, and a visit cancelled while pay that covers it is agreed is
-- marked so on that pay (cleared if the visit is put back).
create or replace function private.visit_job_pay() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x record;
begin
  if new.status = 'cancelled' then
    update public.job_pay_visits jv set cancelled_while_agreed = true
    from public.job_pay p
    where jv.visit_id = new.id and p.id = jv.job_pay_id and not jv.cancelled_while_agreed
      and (p.status = 'accepted' or (p.status = 'offered' and p.accepted_snapshot is not null));
  elsif old.status = 'cancelled' then
    update public.job_pay_visits set cancelled_while_agreed = false where visit_id = new.id and cancelled_while_agreed;
  end if;
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
