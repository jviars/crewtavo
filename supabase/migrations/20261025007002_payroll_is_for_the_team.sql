-- Pay periods are for the team, never for a sub.
--
-- A sub the office keeps the hours of (Uses the clock) has time entries, and the office approves them
-- on Timesheets. But a sub is paid by the job: their pay is marked paid under Subs and added up for
-- their 1099 (20261025003001_job_pay.sql, 20261025003002_sub_pay_reports.sql). Timesheets → Pay
-- leaves their hours out (apps/api/src/services/pay.ts), and here the database refuses to put a sub on
-- a pay period line, whoever asks.
--
-- Only someone who is a sub now is refused: a former employee whose membership was removed can still
-- be paid their last period. Only new lines, or a line moved to someone else, are checked, so taking
-- back or changing a mark on an older line still works.

create function private.pay_line_not_sub() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.memberships m
    where m.company_id = new.company_id and m.user_id = new.user_id and m.role = 'subcontractor'
  ) then
    raise exception 'Subs are paid by the job, under Subs, not with a pay period.' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function private.pay_line_not_sub() from public;

create trigger not_sub before insert or update of user_id on public.pay_period_lines
  for each row execute function private.pay_line_not_sub();
