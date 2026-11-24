-- What a client agrees to and what a sub is offered say the business's own money: "£500.00",
-- "R 2,040", not "$" whatever companies.currency is.
--
--   Autopay      The bank account paragraph of what a client agrees to (autopay_bank_text; core
--                autopayBankText has the same words) names the limit in the business's currency.
--                A business in dollars (US, Canadian, Australian, New Zealand) reads exactly as
--                before, so its words and their version don't change. An agreement already made
--                keeps the words it was made with, and the limit in them is still read:
--                autopay_agreed_cap finds it after any of the symbols.
--   Sub offers   A sub's offer, a new price, owed and paid, and the office's notes about them
--                (money_short; core moneyShort), in the business's currency.
--
-- The symbol is the one people there write, as the screens show it (core moneyPrefix): "$" for
-- every dollar, "£", "€", and "R " for rand (money_prefix).
--
-- The release before this one keeps working with it: these are private functions only the database
-- calls, and the ones it had keep their arguments and their words (the one-argument money_short and
-- autopay_bank_text say US dollars, as they always did). The office's own notifications and activity
-- (private.money, in about 50 places) still write "$": changing them means redefining each of those
-- functions, for words only the office reads.
--
-- supabase/tests/money_in_the_business_currency_test.sql covers it.

-- ---------------------------------------------------------------------------------------------
-- The symbol
-- ---------------------------------------------------------------------------------------------

-- What goes before an amount in the business's currency (core moneyPrefix): "$" for every dollar
-- and anything else, "£", "€", "R " for rand.
create function private.money_prefix(p_currency text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case upper(btrim(coalesce(p_currency, ''))) when 'GBP' then '£' when 'EUR' then '€' when 'ZAR' then 'R ' else '$' end
$$;

-- An amount as private.money writes it, to the cent, in a currency's symbol: "$1,250.50", "£1,250.50".
create function private.money_in(p_amount numeric, p_currency text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select private.money_prefix(p_currency) || to_char(coalesce(p_amount, 0), 'FM999,999,990.00')
$$;

-- As private.money_short in 20261025004001_sub_offers.sql ("$2,040", "$2,040.50": cents only when
-- there are some), in a currency's symbol. Mirrors moneyShort in packages/core/src/subOffers.ts.
create function private.money_short(p_amount numeric, p_currency text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select private.money_prefix(p_currency) || case when round(coalesce(p_amount, 0), 2) = trunc(coalesce(p_amount, 0))
    then to_char(trunc(coalesce(p_amount, 0)), 'FM999,999,990') else to_char(round(p_amount, 2), 'FM999,999,990.00') end
$$;

revoke all on function private.money_prefix(text), private.money_in(numeric, text), private.money_short(numeric, text) from public;

-- ---------------------------------------------------------------------------------------------
-- What a client paying from a bank account agrees to
-- ---------------------------------------------------------------------------------------------

-- As private.autopay_bank_text in 20261116000100_bank_charges_over_the_limit_go_to_the_client.sql,
-- with the limit in the business's currency (core autopayBankText's words, exactly).
create function private.autopay_bank_text(p_autopay jsonb, p_currency text) returns text
language sql immutable security definer set search_path = '' as $$
  select case when private.autopay_cap(p_autopay) is null
    then 'If you pay from a bank account: each charge is for the invoice it pays, and is taken automatically whatever its amount.'
    else 'If you pay from a bank account: charges of ' || private.money_in(private.autopay_cap(p_autopay), p_currency)
      || ' or less are taken automatically. An invoice for more than ' || private.money_in(private.autopay_cap(p_autopay), p_currency)
      || ' is not taken from your bank account: we send it to you to pay.'
  end
$$;
revoke all on function private.autopay_bank_text(jsonb, text) from public;

-- As in 20261113001820_autopay_bank_account_terms.sql, with the bank account paragraph in the
-- business's currency.
create or replace function private.autopay_terms_shown(p_company uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(case when jsonb_typeof(a -> 'terms') = 'string' then nullif(btrim(a ->> 'terms'), '') end, private.autopay_starter_terms(c.trade_preset))
    || E'\n\n' || 'We charge ' || private.autopay_timing_text(a) || '.'
    || E'\n\n' || private.autopay_bank_text(a, c.currency)
  from public.companies c cross join lateral (select private.autopay_of(c.settings) as a) x
  where c.id = p_company
$$;

-- As in 20261116000100_bank_charges_over_the_limit_go_to_the_client.sql, after any currency's
-- symbol: "more than $500.00", "more than £500.00", "more than R 500.00" (core autopayAgreedCap).
create or replace function private.autopay_agreed_cap(p_terms text) returns numeric
language sql immutable set search_path = '' as $$
  select nullif(replace((regexp_match(substring(p_terms from '.*(If you pay from a bank account:.*)$'),
                                      'more than (?:\$|£|€|R )([0-9][0-9,]*(?:\.[0-9]+)?)'))[1], ',', ''), '')::numeric
$$;

-- ---------------------------------------------------------------------------------------------
-- What a sub is offered, owed and paid
-- ---------------------------------------------------------------------------------------------

-- As in 20261025004001_sub_offers.sql: "Smith roof, Tue Nov 3, 24 squares, £2,040", the total in the
-- business's currency. Mirrors offerLine in packages/core/src/subOffers.ts.
create or replace function private.sub_offer_line(p_pay uuid) returns text
language sql stable security definer set search_path = '' as $$
  select concat_ws(', ', j.title, d.days, q.words, private.money_short(p.total, (select c.currency from public.companies c where c.id = p.company_id)))
  from public.job_pay p
  join public.jobs j on j.id = p.job_id
  left join lateral (
    select case
      when count(v.scheduled_on) = 0 then null
      when min(v.scheduled_on) = max(v.scheduled_on) then to_char(min(v.scheduled_on), 'Dy Mon FMDD')
      else to_char(min(v.scheduled_on), 'Dy Mon FMDD') || ' to ' || to_char(max(v.scheduled_on), 'Dy Mon FMDD')
    end as days
    from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
    where jv.job_pay_id = p.id and v.status <> 'cancelled'
  ) d on true
  left join lateral (
    select private.amount_words(l.quantity, l.unit) as words from public.job_pay_lines l
    where l.job_pay_id = p.id and l.basis = 'per_unit' and l.quantity > 0
    order by l.amount desc, l.sort, l.created_at, l.id limit 1
  ) q on true
  where p.id = p_pay
$$;

-- As in 20261025004001_sub_offers.sql, with every amount in the business's currency.
create or replace function private.sub_offer_told(p public.job_pay, p_event text, p_change boolean, p_offered numeric default null, p_was numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job text := (select j.title from public.jobs j where j.id = p.job_id);
  v_sub text := (select s.name from public.subcontractors s where s.id = p.subcontractor_id);
  v_offered numeric := coalesce(p_offered, p.total);
  v_was numeric := case when p_change then coalesce(p_was, (p.accepted_snapshot ->> 'total')::numeric) end;
  v_currency text := (select c.currency from public.companies c where c.id = p.company_id);
  v_price text := private.money_short(v_offered, v_currency);
  v_agreed text := private.money_short((p.accepted_snapshot ->> 'total')::numeric, v_currency);
  v_mine text := '/field/jobs/' || p.id;
  v_job_page text := '/jobs/' || p.job_id;
  -- In the title too, as a text carries only the title.
  v_by text := case when p.respond_by is not null then 'Answer by ' || private.local_time_words(p.company_id, p.respond_by) || '.' end;
  v_data jsonb := jsonb_build_object('job_pay_id', p.id, 'subcontractor_id', p.subcontractor_id, 'sub_name', v_sub, 'total', v_offered,
    'change', p_change, 'round', p.offer_round) || case when p_change then jsonb_build_object('was', v_was) else '{}'::jsonb end;
begin
  if p_event = 'sent' then
    if p_change then
      perform private.tell_sub(p.company_id, p.subcontractor_id,
        concat_ws(' ', format('New price for %s: %s (was %s).', v_job, v_price, private.money_short(v_was, v_currency)), v_by, 'Open Crewtavo to accept or decline.'),
        'If you don''t accept it, the price you agreed stands.', v_mine);
      perform private.emit(p.company_id, 'sub_offer.sent', 'job', p.job_id, format('New price for %s sent to %s (%s, was %s)', v_job, v_sub, v_price, private.money_short(v_was, v_currency)),
        v_data || jsonb_build_object('insurance_warning', p.insurance_warning is not null));
    else
      perform private.tell_sub(p.company_id, p.subcontractor_id, concat_ws(' ', private.sub_offer_line(p.id) || '.', v_by, 'Open Crewtavo to accept or decline.'),
        'New job offer.', v_mine);
      perform private.emit(p.company_id, 'sub_offer.sent', 'job', p.job_id, format('%s offered to %s (%s)', v_job, v_sub, v_price),
        v_data || jsonb_build_object('insurance_warning', p.insurance_warning is not null));
    end if;
  elsif p_event = 'accepted' then
    perform private.emit(p.company_id, 'sub_offer.accepted', 'job', p.job_id,
      case when p_change then format('%s accepted the new price for %s (%s, was %s)', v_sub, v_job, v_price, private.money_short(v_was, v_currency)) else format('%s accepted %s (%s)', v_sub, v_job, v_price) end, v_data);
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('%s accepted the new price for %s', v_sub, v_job) else format('%s accepted %s', v_sub, v_job) end,
      case when p_change then format('Now %s.', v_price) else format('%s. They''re on its visits now.', v_price) end, v_job_page);
  elsif p_event = 'declined' then
    perform private.emit(p.company_id, 'sub_offer.declined', 'job', p.job_id,
      case when p_change then format('%s declined the new price for %s (%s)', v_sub, v_job, v_price) else format('%s declined %s (%s)', v_sub, v_job, v_price) end
        || coalesce(': ' || p.decline_reason, ''),
      v_data || jsonb_build_object('reason', p.decline_reason));
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('%s declined the new price for %s', v_sub, v_job) else format('%s declined %s', v_sub, v_job) end,
      concat_ws(' ', '“' || p.decline_reason || '”',
        case when p_change then format('The price they agreed (%s) stands.', v_agreed) else 'You can offer it to another sub from the job.' end), v_job_page);
  elsif p_event = 'expired' then
    perform private.emit(p.company_id, 'sub_offer.expired', 'job', p.job_id,
      case when p_change then format('The new price for %s (%s) ran out before %s answered', v_job, v_price, v_sub) else format('%s didn''t answer the offer for %s in time', v_sub, v_job) end,
      v_data);
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('The new price for %s ran out', v_job) else format('%s didn''t answer in time: %s', v_sub, v_job) end,
      case when p_change then format('%s didn''t answer. The price they agreed (%s) stands.', v_sub, v_agreed)
        else 'The offer ran out. You can offer it again, or to another sub, from the job.' end, v_job_page);
  elsif p_event = 'withdrawn' then
    perform private.tell_sub(p.company_id, p.subcontractor_id,
      case when p_change then format('The new price for %s was withdrawn', v_job) else format('The offer for %s was withdrawn', v_job) end,
      case when p_change then format('The price you agreed (%s) stands.', v_agreed) else 'You don''t need to do anything.' end, v_mine);
  elsif p_event = 'agreed' then
    -- The office agreed an offer for them (they said yes on the phone): it's theirs at that price.
    perform private.tell_sub(p.company_id, p.subcontractor_id,
      case when p_change then format('Your price for %s is now %s (was %s)', v_job, v_price, private.money_short(v_was, v_currency))
        else format('%s is yours at %s', v_job, v_price) end,
      case when p_change then 'The office agreed the new price with you.' else 'The office agreed it with you. It''s on My day.' end, v_mine);
  end if;
end $$;

-- As in 20261025004002_sub_pay_seams.sql: a sub's pay done or paid, in the business's currency.
create or replace function private.job_pay_sub_notices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_job text := (select j.title from public.jobs j where j.id = new.job_id);
  v_tz text := (select c.timezone from public.companies c where c.id = new.company_id);
  v_currency text := (select c.currency from public.companies c where c.id = new.company_id);
begin
  if new.status = 'done' and old.status = 'accepted' then
    perform private.tell_sub(new.company_id, new.subcontractor_id, format('Owed: %s for %s', private.money_short(new.total, v_currency), v_job),
      'The work''s done. We''ll let you know when it''s paid.', '/field/jobs/' || new.id, true);
  elsif new.status = 'paid' then
    perform private.tell_sub(new.company_id, new.subcontractor_id,
      format('Paid %s on %s', private.money_short(new.paid_amount, v_currency), to_char(new.paid_at at time zone coalesce(v_tz, 'UTC'), 'Mon FMDD')),
      v_job || case new.method
        when 'check' then ', by check.' when 'ach' then ', by bank transfer.' when 'cash' then ', in cash.'
        when 'card_or_app' then ', by card or payment app.' when 'payroll' then ', through payroll.' else '.' end,
      '/field/jobs/' || new.id, true);
  end if;
  return null;
end $$;
