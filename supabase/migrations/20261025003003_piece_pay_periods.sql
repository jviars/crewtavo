-- Piece pay in pay periods (docs/subcontractors-plan.md, phase C: "Employees on per-square pay keep
-- the clock"). A team member's job pay that's done, earned on a day in the period, joins their
-- hourly pay there (Timesheets → Pay, packages/core/src/pay.ts paySummary): pay_period_lines gets
-- piece_amount, and amount is hourly and piece pay together.
--
-- Marking someone paid for a period marks their piece pay in it paid too, with the period (method
-- from the line's: payroll unless it says otherwise), and only if it's what the office was shown: a
-- line marked paid has to carry the piece pay the database counts for it, or it's refused with
-- "look again". Taking the mark back, or the line or period going, puts that pay back to done. While
-- the mark holds, the pay is locked as the period's time is (20261025003001_job_pay.sql,
-- job_pay_guard). Hours over 40 are still flagged as before; overtime on piece pay is worked out by
-- the payroll service from total pay and hours.

alter table public.pay_period_lines add column piece_amount numeric(12, 2) not null default 0 check (piece_amount >= 0);
comment on column public.pay_period_lines.piece_amount is 'Their job pay (per square, per job, per day) done in the period. amount is hourly and this together.';

-- A pay period line's method as job pay records it.
create function private.payroll_method(p_method text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case p_method when 'direct_deposit' then 'ach' when 'check' then 'check' when 'cash' then 'cash' when 'other' then 'other' else 'payroll' end
$$;

-- The person's piece pay a period pays: done and earned on a day in it, or already paid with it.
create function private.period_piece(p_period uuid, p_user uuid) returns table (id uuid, total numeric, status text)
language sql stable security definer set search_path = '' as $$
  select jp.id, jp.total, jp.status
  from public.job_pay jp join public.pay_periods pp on pp.id = p_period
  where jp.company_id = pp.company_id and jp.user_id = p_user
    and ((jp.status = 'done' and jp.earned_on between pp.starts_on and pp.ends_on) or (jp.status = 'paid' and jp.pay_period_id = p_period))
$$;
revoke all on function private.payroll_method(text), private.period_piece(uuid, uuid) from public;

-- A line marked paid carries the piece pay the database counts for it.
create function private.pay_line_piece() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_piece numeric;
begin
  if new.paid_at is null then return new; end if;
  select coalesce(sum(x.total), 0) into v_piece from private.period_piece(new.period_id, new.user_id) x;
  if v_piece <> new.piece_amount then
    raise exception 'Their piece pay for this period has changed since you looked (it''s now %). Look again, then mark them paid.', '$' || to_char(v_piece, 'FM999,999,990.00')
      using errcode = '22023';
  end if;
  return new;
end $$;
create trigger piece_pay before insert or update on public.pay_period_lines for each row execute function private.pay_line_piece();

-- Marked paid: their done piece pay in the period is paid with it. Taken back or gone: done again.
create function private.pay_line_job_pay() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.paid_at is not null and new.paid_at is null) then
    update public.job_pay set status = 'done' where pay_period_id = old.period_id and user_id = old.user_id and status = 'paid';
  end if;
  if tg_op <> 'DELETE' and new.paid_at is not null then
    update public.job_pay jp set status = 'paid', paid_at = new.paid_at, paid_amount = jp.total, method = private.payroll_method(new.method),
      reference = new.reference, paid_by = new.paid_by, pay_period_id = new.period_id
    where jp.id in (select x.id from private.period_piece(new.period_id, new.user_id) x where x.status = 'done');
  end if;
  return null;
end $$;
create trigger job_pay after insert or update or delete on public.pay_period_lines for each row execute function private.pay_line_job_pay();

notify pgrst, 'reload schema';
