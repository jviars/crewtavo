-- Per-unit pay suggests each payee's share of the squares, not the whole job's again.
--
-- The owner decided per-square crew pay is one line per person, each with their share of the squares
-- (docs/subcontractors-plan.md, decisions). job_pay_suggest() (20261025003001_job_pay.sql) filled every
-- payee's per-unit line with the job's whole quantity, so starting pay for two crew members, or a sub
-- and a crew member, on the same roof suggested 24 squares to each, and agreeing the defaults paid the
-- roof twice. Now the quantity already on someone else's pay on the job (live pay: a draft, an offer,
-- agreed, done or paid; the same service, per unit) is taken off, and the line is flagged with a note:
-- "18 of 24 squares are already on other pay on this job. Check it." The job's pay card also warns
-- when the quantities across everyone's pay come to more than the job's.

/**
 * As in 20261025003001_job_pay.sql, and a per-unit line counts only what's left of the service's
 * quantity once other payees' live pay on the job is taken off (flagged, with a note saying so).
 */
create or replace function public.job_pay_suggest(p_job uuid, p_subcontractor uuid default null, p_user uuid default null, p_visits uuid[] default null)
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
  v_taken numeric;
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
      -- Someone else's pay on the job (a sub's, or another person's piece pay) already counts some
      -- of it: each is paid their share, so this is what's left, flagged.
      select coalesce(sum(l.quantity), 0) into v_taken
      from public.job_pay p join public.job_pay_lines l on l.job_pay_id = p.id
      where p.job_id = p_job and private.job_pay_live(p.status) and l.basis = 'per_unit' and l.service_id = r.service_id
        and not (p.subcontractor_id is not distinct from p_subcontractor and p.user_id is not distinct from p_user);
      if v_lines > 0 and v_taken > 0 then
        note := case when v_taken >= quantity
          then format('Other pay on this job already counts %s, so none is left. Check it.', private.amount_words(v_taken, r.unit))
          else format('%s of %s are already on other pay on this job. Check it.', trim_scale(v_taken), private.amount_words(quantity, r.unit)) end;
        quantity := greatest(quantity - v_taken, 0);
        check_it := true;
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
