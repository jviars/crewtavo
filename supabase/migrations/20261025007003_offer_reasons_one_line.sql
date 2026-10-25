-- A sub's reason for turning down a job is kept on one line.
--
-- A sub types the reason in the field app (answer_sub_offer, 20261025004001_sub_offers.sql), and it's
-- put in the office's notice ("“Too far.” You can offer it to another sub from the job."), which also
-- goes out by email. Kept as typed, blank lines in it would split the email into paragraphs, and a
-- paragraph that's only a web address shows as a button, so a sub could put a button to any site in
-- an email sent in the company's name. The reason is now saved with its spaces, tabs and line breaks
-- run together into single spaces, whoever saves it. (Emailed notices are also kept one paragraph
-- each: apps/api/src/services/delivery.ts.)

create function private.job_pay_reason_one_line() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.decline_reason := nullif(btrim(regexp_replace(new.decline_reason, '\s+', ' ', 'g')), '');
  return new;
end $$;
revoke all on function private.job_pay_reason_one_line() from public;

create trigger reason_one_line before insert or update of decline_reason on public.job_pay
  for each row when (new.decline_reason is not null) execute function private.job_pay_reason_one_line();
