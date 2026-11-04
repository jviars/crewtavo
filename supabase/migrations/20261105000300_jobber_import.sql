-- Coming from Jobber: the open work brought over from Jobber's report exports (Settings → Your data;
-- the files are read in packages/core/src/jobberImport.ts). import_jobber takes rows the browser has
-- read and matched to clients, and makes
--   * open quotes (draft, sent, changes requested or approved) with their lines;
--   * unpaid invoices, sent, with what was already paid in Jobber as one payment, so each owes what
--     it owed there;
--   * active jobs, one-off or recurring (a recurring one Jobber didn't say how it repeats comes in as
--     a one-off, for the office to set its schedule).
-- Each keeps Jobber's number as its source_id ("jobber:123"): one already here is left as it is, so
-- importing the same file again adds nothing. Crewtavo numbers each as usual, so its numbering
-- carries on; Jobber's number shows in a "Jobber quote #" ("Jobber job #", "Jobber invoice #") field
-- the import adds.
--
-- What's brought in already happened, so it's quiet (crewtavo.quiet, as Stripe's import is, see
-- 20261018000300_stripe.sql): no activity, so no automations (no "quote sent" follow-up, no invoice
-- or past-due email, no receipt), and no accounting or Stripe sync. Nothing is sent or charged, and
-- being quiet, it's an owner's or admin's to do. Afterwards each is like any other: an invoice that
-- falls past due later gets the usual reminder. And it isn't charged anything Jobber didn't charge:
--   * no "Add to every job" trip charge (20261104000100_trip_fee_minimum.sql) on its quotes or jobs;
--   * no minimum charge on its invoices;
--   * no late fee (20261104000200_client_billing_late_fees.sql): Jobber's balance is what's owed;
--   * its due date is Jobber's, not one from the client's payment terms.
-- Its invoices are each Jobber's total to the cent: when Crewtavo's adding up comes to something else
-- (a tax-exempt client here, say), the total comes in as one untaxed line.

alter table public.quotes add column source_id text check (length(source_id) between 1 and 100);
alter table public.jobs add column source_id text check (length(source_id) between 1 and 100);
alter table public.invoices add column source_id text check (length(source_id) between 1 and 100);
comment on column public.quotes.source_id is 'Its number in the system it was brought in from ("jobber:123"), so a second import finds it.';
comment on column public.jobs.source_id is 'Its number in the system it was brought in from ("jobber:123"), so a second import finds it.';
comment on column public.invoices.source_id is 'Its number in the system it was brought in from ("jobber:123"), so a second import finds it.';
create unique index quotes_source_idx on public.quotes (company_id, source_id) where source_id is not null;
create unique index jobs_source_idx on public.jobs (company_id, source_id) where source_id is not null;
create unique index invoices_source_idx on public.invoices (company_id, source_id) where source_id is not null;

-- A job brought in has Jobber's lines: no "Add to every job" item goes on it.
drop trigger every_job_items on public.jobs;
create constraint trigger every_job_items after insert on public.jobs deferrable initially deferred
  for each row when (new.quote_id is null and new.source_id is null) execute function private.every_job_items_job();

-- The field that shows Jobber's number on a quote, job or invoice, made the first time it's needed.
-- An owner's or admin's (who bring work in quietly, so not the rest of the office), whether or not
-- their role has the Settings area.
create function private.jobber_number_field(p_company uuid, p_record text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_key text := 'jobber_' || p_record;
begin
  if p_record not in ('quote', 'job', 'invoice') or not private.has_role(p_company, '{owner,admin}') then
    raise exception 'Only an owner or admin can bring work in from Jobber' using errcode = '42501';
  end if;
  insert into public.custom_field_definitions (company_id, record_type, key, label, type, sort)
  select p_company, p_record, v_key, 'Jobber ' || p_record || ' #', 'text',
         coalesce((select max(sort) + 1 from public.custom_field_definitions where company_id = p_company and record_type = p_record), 0)
  on conflict (company_id, record_type, key) do nothing;
  return v_key;
end $$;
revoke execute on function private.jobber_number_field(uuid, text) from public;
grant execute on function private.jobber_number_field(uuid, text) to authenticated;

-- A day from the file as a time on it: midday UTC, so it reads as that day in the Americas.
create function private.jobber_noon(p_day text) returns timestamptz
language sql stable set search_path = '' as $$
  select (p_day::date + time '12:00') at time zone 'UTC'
$$;

/**
 * Up to 200 rows of one kind ('quotes', 'invoices' or 'jobs') for p_company, each with its source_id,
 * Jobber's number, client_id (and property_id), and lines [{name, description, quantity,
 * unit_price, taxable}]:
 *   quotes    title, status (draft, sent, changes_requested, approved), discount_amount, tax_rate,
 *             deposit_amount, created_on, sent_on, approved_on;
 *   invoices  subject, issued_on, due_on, discount_amount, tax_rate, total, paid, created_on;
 *   jobs      title, kind (one_off, recurring), recurrence_rule, starts_on, ends_on,
 *             visit_duration_min, pricing (per_visit, fixed), created_on.
 * An owner's or admin's; runs as them, so it makes only what they could make by hand. Returns [{source_id, id,
 * number, new}], new false for one brought in before.
 */
create function public.import_jobber(p_company uuid, p_kind text, p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  r jsonb;
  v_id uuid;
  v_number bigint;
  v_new boolean;
  v_field text;
  v_status text;
  v_rule text;
  v_issued date;
  v_due date;
  v_total numeric;
  v_paid numeric;
  v_out jsonb := '[]';
begin
  if p_kind not in ('quotes', 'invoices', 'jobs') then
    raise exception 'Bring in quotes, invoices or jobs' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'Bring in up to 200 at a time' using errcode = '22023';
  end if;
  v_field := private.jobber_number_field(p_company, left(p_kind, -1));
  perform set_config('crewtavo.quiet', 'on', true);

  for r in select value from jsonb_array_elements(p_rows) loop
    if coalesce(r ->> 'source_id', '') = '' then
      raise exception 'Each row needs its source_id' using errcode = '22023';
    end if;

    if p_kind = 'quotes' then
      v_status := r ->> 'status';
      if v_status is null or v_status not in ('draft', 'sent', 'changes_requested', 'approved') then
        raise exception 'A quote comes in as draft, sent, changes_requested or approved' using errcode = '22023';
      end if;
      select id, number into v_id, v_number from public.quotes where company_id = p_company and source_id = r ->> 'source_id';
      v_new := not found;
      if v_new then
        -- A draft first, so its lines can go on; every_job_items_added: no trip charge joins them.
        insert into public.quotes (company_id, client_id, property_id, title, discount_amount, tax_rate, deposit_amount, every_job_items_added,
                                   source_id, custom_fields, created_at, sent_at, approved_at)
        values (p_company, (r ->> 'client_id')::uuid, (r ->> 'property_id')::uuid, left(coalesce(nullif(btrim(r ->> 'title'), ''), 'Quote from Jobber'), 200),
                coalesce((r ->> 'discount_amount')::numeric, 0), coalesce((r ->> 'tax_rate')::numeric, 0), coalesce((r ->> 'deposit_amount')::numeric, 0), true,
                r ->> 'source_id', jsonb_build_object(v_field, r ->> 'number'), coalesce(private.jobber_noon(r ->> 'created_on'), now()),
                case when v_status <> 'draft' then coalesce(private.jobber_noon(r ->> 'sent_on'), now()) end,
                case when v_status = 'approved' then coalesce(private.jobber_noon(r ->> 'approved_on'), now()) end)
        returning id, number into v_id, v_number;
        insert into public.quote_line_items (company_id, quote_id, name, description, quantity, unit_price, taxable, sort)
        select p_company, v_id, left(l ->> 'name', 200), nullif(left(l ->> 'description', 1000), ''), (l ->> 'quantity')::numeric, (l ->> 'unit_price')::numeric,
               coalesce((l ->> 'taxable')::boolean, true), n
          from jsonb_array_elements(coalesce(r -> 'lines', '[]')) with ordinality as x(l, n);
        if v_status <> 'draft' then
          update public.quotes set status = v_status where id = v_id;
        end if;
      end if;

    elsif p_kind = 'invoices' then
      select id, number into v_id, v_number from public.invoices where company_id = p_company and source_id = r ->> 'source_id';
      v_new := not found;
      if v_new then
        v_issued := coalesce((r ->> 'issued_on')::date, current_date);
        v_due := coalesce((r ->> 'due_on')::date, v_issued);
        v_total := coalesce((r ->> 'total')::numeric, 0);
        v_paid := least(greatest(coalesce((r ->> 'paid')::numeric, 0), 0), v_total);
        -- late_fee_at: Jobber's balance is what's owed, so no late fee is added to it.
        insert into public.invoices (company_id, client_id, subject, issued_on, due_on, discount_amount, tax_rate, source_id, custom_fields, created_at, late_fee_at)
        values (p_company, (r ->> 'client_id')::uuid, nullif(left(r ->> 'subject', 200), ''), v_issued, v_due,
                coalesce((r ->> 'discount_amount')::numeric, 0), coalesce((r ->> 'tax_rate')::numeric, 0),
                r ->> 'source_id', jsonb_build_object(v_field, r ->> 'number'), coalesce(private.jobber_noon(r ->> 'created_on'), now()), now())
        returning id, number into v_id, v_number;
        -- Made with the business's minimum charge and the client's terms: Jobber's lines and due date stand instead.
        update public.invoices set minimum_charge = null, due_on = v_due where id = v_id;
        insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit_price, taxable, sort)
        select p_company, v_id, left(l ->> 'name', 200), nullif(left(l ->> 'description', 1000), ''), (l ->> 'quantity')::numeric, (l ->> 'unit_price')::numeric,
               coalesce((l ->> 'taxable')::boolean, true), n
          from jsonb_array_elements(coalesce(r -> 'lines', '[]')) with ordinality as x(l, n);
        -- Jobber's total to the cent.
        if (select total from public.invoices where id = v_id) is distinct from v_total then
          delete from public.invoice_line_items where invoice_id = v_id;
          update public.invoices set tax_rate = 0, discount_amount = 0 where id = v_id;
          insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable, sort)
          values (p_company, v_id, left(coalesce(nullif(btrim(r ->> 'subject'), ''), 'Invoice from Jobber'), 200), 1, v_total, false, 1);
        end if;
        -- Sent when Jobber issued it; past due now if its due date has gone (invoice_totals says which).
        update public.invoices set status = 'sent', sent_at = private.jobber_noon(v_issued::text) where id = v_id;
        if v_paid > 0 then
          insert into public.payments (company_id, client_id, invoice_id, amount, method, received_at, notes)
          values (p_company, (r ->> 'client_id')::uuid, v_id, v_paid, 'other', private.jobber_noon(v_issued::text), 'Paid in Jobber before the move');
        end if;
      end if;

    else
      select id, number into v_id, v_number from public.jobs where company_id = p_company and source_id = r ->> 'source_id';
      v_new := not found;
      if v_new then
        -- Recurring needs a schedule: without one it's a one-off until the office sets it.
        v_rule := case when r ->> 'kind' = 'recurring' and nullif(r ->> 'starts_on', '') is not null then nullif(r ->> 'recurrence_rule', '') end;
        insert into public.jobs (company_id, client_id, property_id, title, kind, status, recurrence_rule, starts_on, ends_on, visit_duration_min,
                                 pricing, invoice_schedule, source_id, custom_fields, created_at)
        values (p_company, (r ->> 'client_id')::uuid, (r ->> 'property_id')::uuid, left(coalesce(nullif(btrim(r ->> 'title'), ''), 'Job from Jobber'), 200),
                case when v_rule is null then 'one_off' else 'recurring' end, 'active', v_rule,
                case when v_rule is not null then (r ->> 'starts_on')::date end, case when v_rule is not null then (r ->> 'ends_on')::date end,
                coalesce(nullif((r ->> 'visit_duration_min')::integer, 0), 60),
                -- Per visit, invoiced after each; a fixed price is invoiced when the office chooses, not monthly by itself.
                case when v_rule is not null then case when r ->> 'pricing' = 'fixed' then 'fixed' else 'per_visit' end end,
                case when v_rule is not null then case when r ->> 'pricing' = 'fixed' then 'as_needed' else 'after_visit' end end,
                r ->> 'source_id', jsonb_build_object(v_field, r ->> 'number'), coalesce(private.jobber_noon(r ->> 'created_on'), now()))
        returning id, number into v_id, v_number;
        insert into public.job_line_items (company_id, job_id, name, description, quantity, unit_price, taxable, sort)
        select p_company, v_id, left(l ->> 'name', 200), nullif(left(l ->> 'description', 1000), ''), (l ->> 'quantity')::numeric, (l ->> 'unit_price')::numeric,
               coalesce((l ->> 'taxable')::boolean, true), n
          from jsonb_array_elements(coalesce(r -> 'lines', '[]')) with ordinality as x(l, n);
      end if;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object('source_id', r ->> 'source_id', 'id', v_id, 'number', v_number, 'new', v_new));
  end loop;
  return v_out;
end $$;
revoke execute on function public.import_jobber(uuid, text, jsonb) from public, anon;
grant execute on function public.import_jobber(uuid, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
