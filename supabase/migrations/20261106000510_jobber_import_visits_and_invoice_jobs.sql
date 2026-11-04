-- Jobber import: one-off jobs come with their visits, and invoices with their job
-- (20261105000300_jobber_import.sql, packages/core/src/jobberImport.ts).
--   * A one-off job is made with the visits still to do that the files give (the visits report's,
--     or the one-off report's schedule start date): on that day, any time, on no crew, as the office
--     would put one on the schedule. A recurring job's visits still come from its schedule.
--   * An invoice whose row names its Jobber job ("Job #s") is linked to it, when that job came in
--     (now or in an earlier import) for the same client. Jobs come in before invoices for that.
--     Anything else (several jobs named, a closed job, another client's) comes in without one, and
--     the import says so; nothing is matched by guesswork.

-- As in 20261105000300_jobber_import.sql, plus visit_dates on jobs and job_source_id on invoices.
/**
 * Up to 200 rows of one kind ('quotes', 'invoices' or 'jobs') for p_company, each with its source_id,
 * Jobber's number, client_id (and property_id), and lines [{name, description, quantity,
 * unit_price, taxable}]:
 *   quotes    title, status (draft, sent, changes_requested, approved), discount_amount, tax_rate,
 *             deposit_amount, created_on, sent_on, approved_on;
 *   invoices  subject, issued_on, due_on, discount_amount, tax_rate, total, paid, created_on,
 *             job_source_id (its job's, when it has one);
 *   jobs      title, kind (one_off, recurring), recurrence_rule, starts_on, ends_on,
 *             visit_duration_min, pricing (per_visit, fixed), created_on, visit_dates (a one-off's).
 * An owner's or admin's; runs as them, so it makes only what they could make by hand. Returns [{source_id, id,
 * number, new}] (and an invoice's job_id), new false for one brought in before.
 */
create or replace function public.import_jobber(p_company uuid, p_kind text, p_rows jsonb) returns jsonb
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
  v_job uuid;
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
      select id, number, job_id into v_id, v_number, v_job from public.invoices where company_id = p_company and source_id = r ->> 'source_id';
      v_new := not found;
      if v_new then
        v_issued := coalesce((r ->> 'issued_on')::date, current_date);
        v_due := coalesce((r ->> 'due_on')::date, v_issued);
        v_total := coalesce((r ->> 'total')::numeric, 0);
        v_paid := least(greatest(coalesce((r ->> 'paid')::numeric, 0), 0), v_total);
        -- Its job, brought in from Jobber (now or before) for the same client; else none.
        select j.id into v_job from public.jobs j
         where j.company_id = p_company and j.source_id = r ->> 'job_source_id' and j.client_id = (r ->> 'client_id')::uuid;
        -- late_fee_at: Jobber's balance is what's owed, so no late fee is added to it.
        insert into public.invoices (company_id, client_id, job_id, subject, issued_on, due_on, discount_amount, tax_rate, source_id, custom_fields, created_at, late_fee_at)
        values (p_company, (r ->> 'client_id')::uuid, v_job, nullif(left(r ->> 'subject', 200), ''), v_issued, v_due,
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
        -- A one-off's visits still to do, any time that day. A recurring job's come from its schedule.
        if v_rule is null and r ->> 'kind' is distinct from 'recurring' then
          insert into public.visits (company_id, job_id, property_id, title, scheduled_on)
          select distinct p_company, v_id, (r ->> 'property_id')::uuid, left(coalesce(nullif(btrim(r ->> 'title'), ''), 'Job from Jobber'), 200), d::date
            from jsonb_array_elements_text(coalesce(r -> 'visit_dates', '[]')) as x(d);
        end if;
      end if;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object('source_id', r ->> 'source_id', 'id', v_id, 'number', v_number, 'new', v_new)
                                        || case when p_kind = 'invoices' then jsonb_build_object('job_id', v_job) else '{}' end);
  end loop;
  return v_out;
end $$;
revoke execute on function public.import_jobber(uuid, text, jsonb) from public, anon;
grant execute on function public.import_jobber(uuid, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
