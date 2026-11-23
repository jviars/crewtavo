-- More of what clients pay, held to the money areas for an AI assistant (Claude, ChatGPT over MCP),
-- after 20261123100600_assistant_prices_are_money.sql:
--
--   visits' price and price_note    what one visit bills (a storm's, say): Prices
--   jobs' retainage_pct             the share held back from each of a job's invoices: Prices
--   jobs' autopay                   whether the client's saved card is charged for the job: Invoices
--   a job made with its billing     how a new job is billed, given when it's made, as when it's changed
--                                   later: Prices. A job made the plain way (billed when the work is
--                                   done, or per visit when it repeats) needs only Jobs, as before.
--
-- The MCP tools never change these; a request straight to the Data API is held to the same.
-- Ordinary sign-ins are unaffected.
--
-- supabase/tests/assistant_job_and_visit_money_test.sql covers it.

-- ---------------------------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------------------------

-- As 20261123100600_assistant_prices_are_money.sql, with a job's retainage and autopay, and a new
-- job's billing. Only the request's own change counts: align_billing, which runs first, only follows
-- what the request wrote, and autopay_guard, which runs after, turns autopay on by the company's
-- default by itself. A job made by a function an assistant may call (a quote turned into a job) goes
-- by that function's area, and a change the database makes itself (another trigger's) isn't the
-- request's.
create or replace function private.assistant_job_billing_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_plain boolean;
begin
  if private.assistant_client() is null or pg_trigger_depth() > 1 then return new; end if;
  if tg_op = 'INSERT' then
    if current_setting('request.path', true) is distinct from '/jobs' then return new; end if;
    v_plain := new.invoice_day is null and new.retainage_pct = 0 and case when new.kind = 'recurring'
      then new.billing_mode = 'per_visit' and new.pricing is not distinct from 'per_visit' and new.invoice_schedule is not distinct from 'after_visit'
      else new.billing_mode = 'on_completion' and new.pricing is null and new.invoice_schedule is null end;
    if not v_plain and not private.assistant_may_change('prices', false) then
      raise exception 'This assistant can''t change how a job is priced or billed. To let it, choose Price list and job prices for it, or give it Full access, in Crewtavo, under Settings → AI assistants.'
        using errcode = '42501';
    end if;
    if new.autopay and not private.assistant_may_change('invoices', false) then
      raise exception 'This assistant can''t turn autopay on or off for a job: it goes with invoices. To let it, choose Invoices and payments for it, or give it Full access, in Crewtavo, under Settings → AI assistants.'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.billing_mode, new.pricing, new.invoice_schedule, new.invoice_day, new.retainage_pct) is distinct from (old.billing_mode, old.pricing, old.invoice_schedule, old.invoice_day, old.retainage_pct)
    and not private.assistant_may_change('prices', false) then
    raise exception 'This assistant can''t change how a job is priced or billed. To let it, choose Price list and job prices for it, or give it Full access, in Crewtavo, under Settings → AI assistants.'
      using errcode = '42501';
  end if;
  if new.autopay is distinct from old.autopay and not private.assistant_may_change('invoices', false) then
    raise exception 'This assistant can''t turn autopay on or off for a job: it goes with invoices. To let it, choose Invoices and payments for it, or give it Full access, in Crewtavo, under Settings → AI assistants.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger assistant_billing_guard on public.jobs;
create trigger assistant_billing_guard before insert or update on public.jobs
  for each row execute function private.assistant_job_billing_guard();

-- ---------------------------------------------------------------------------------------------
-- What a visit bills
-- ---------------------------------------------------------------------------------------------

-- Alongside visit_price_guard (20261113000100_snow_app.sql), which holds a person to the office: an
-- assistant also needs Prices, whoever it's connected as.
create function private.assistant_visit_price_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null or pg_trigger_depth() > 1 then return new; end if;
  if ((tg_op = 'INSERT' and (new.price is not null or new.price_note is not null))
      or (tg_op = 'UPDATE' and (new.price is distinct from old.price or new.price_note is distinct from old.price_note)))
    and not private.assistant_may_change('prices', false) then
    raise exception 'This assistant can''t change what a visit bills. To let it, choose Price list and job prices for it, or give it Full access, in Crewtavo, under Settings → AI assistants.'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.assistant_visit_price_guard() from public;
create trigger assistant_price_guard before insert or update of price, price_note on public.visits
  for each row execute function private.assistant_visit_price_guard();

notify pgrst, 'reload schema';
