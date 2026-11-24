-- Dates and times the database writes into words people read, the way the business's country
-- writes them (companies.country): "Oct 6, 2026" and "5:05 PM" in the US, "6 Oct 2026" and "17:05"
-- in the UK, "5:05 p.m." in Canada, "5:05 pm" in Australia.
--
-- private.date_text is the twin of writtenDate in packages/core/src/regional.ts: it takes a to_char
-- pattern written as the US writes it and writes it the country's way (core patternFor): the day
-- before the month where the country puts it first, and the time as the country keeps it. In the
-- US, its territories, Canada and the Philippines a date reads exactly as to_char wrote it, and in
-- the US the time too, so a US business's words don't change. A pattern that reads the same
-- everywhere ("FMMonth YYYY") is written as it is.
--
-- private.money_pattern is the to_char pattern of an amount in the business's currency, "$" as
-- before for every dollar.
--
-- These only write words; the functions that write them are redefined in the migrations after
-- this one. They're new functions, so the release before this one keeps working with them.
--
-- supabase/tests/date_text_test.sql checks the examples core's regional.test.ts checks (WRITTEN).

-- Where the month comes first ("Oct 6, 2026"): the US and its territories, Canada and the
-- Philippines. A business with no country is taken to be in the US (core monthFirst).
create function private.month_first(p_country text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(nullif(p_country, ''), 'US') in ('US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'CA', 'PH')
$$;

-- How a country writes the time of day (core clockStyle): "AM" (2:05 PM, the US), "a.m." (2:05 p.m.,
-- Canada), "am" (2:05 pm, Australia, New Zealand, India) or "24" (14:05, the UK and most of the world).
create function private.clock_style(p_country text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case
    when coalesce(nullif(p_country, ''), 'US') = 'CA' then 'a.m.'
    when private.month_first(p_country) then 'AM'
    when p_country in ('AU', 'NZ', 'IN') then 'am'
    else '24'
  end
$$;

-- The pattern a country writes `p_pattern` (a to_char pattern as the US writes it) in, as core
-- patternFor has it (DAY_FIRST_PATTERNS, TIME_PATTERNS): the date the other way round, the time its
-- own way. Any other pattern is written as it is.
create function private.date_pattern(p_pattern text, p_country text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_pattern = 'FMHH12:MI AM' then case private.clock_style(p_country)
      when 'AM' then 'FMHH12:MI AM' when 'a.m.' then 'FMHH12:MI a.m.' when 'am' then 'FMHH12:MI am' else 'HH24:MI' end
    when private.month_first(p_country) then p_pattern
    else case p_pattern
      when 'Mon DD, YYYY' then 'FMDD Mon YYYY'
      when 'Mon FMDD, YYYY' then 'FMDD Mon YYYY'
      when 'Mon FMDD' then 'FMDD Mon'
      when 'FMMon FMDD' then 'FMDD Mon'
      when 'Dy Mon FMDD' then 'Dy FMDD Mon'
      when 'FMMonth FMDD, YYYY' then 'FMDD FMMonth YYYY'
      when 'FMMonth FMDD' then 'FMDD FMMonth'
      else p_pattern
    end
  end
$$;

-- to_char(p_value, p_pattern), written the country's way: a wall-clock time (a moment `at time
-- zone` the business's, as the functions write them), a date, or a moment as the session's time
-- zone has it (as to_char writes one). The patterns write English names (no TM), so a date and a
-- wall-clock time always read the same.
create function private.date_text(p_value timestamp, p_pattern text, p_country text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select to_char(p_value, private.date_pattern(p_pattern, p_country))
$$;

create function private.date_text(p_value date, p_pattern text, p_country text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select to_char(p_value::timestamp, private.date_pattern(p_pattern, p_country))
$$;

create function private.date_text(p_value timestamptz, p_pattern text, p_country text) returns text
language sql stable parallel safe set search_path = '' as $$
  select to_char(p_value, private.date_pattern(p_pattern, p_country))
$$;

-- The to_char pattern of an amount to the cent in the business's currency: 'FM$999,999,990.00', as
-- the functions wrote "$" amounts, for every dollar; '£', '€' and 'R ' before the number otherwise
-- (private.money_prefix). Nothing for no amount, as before.
create function private.money_pattern(p_currency text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case when private.money_prefix(p_currency) = '$' then 'FM$999,999,990.00'
    else 'FM"' || private.money_prefix(p_currency) || '"999,999,990.00' end
$$;

-- Some of the functions that write these words run as the person signed in (the dashboard, making
-- an invoice, a payment schedule's problems), as private.money, which they wrote amounts with, did.
revoke all on function private.month_first(text), private.clock_style(text), private.date_pattern(text, text),
  private.date_text(timestamp, text, text), private.date_text(date, text, text), private.date_text(timestamptz, text, text),
  private.money_pattern(text) from public;
grant execute on function private.month_first(text), private.clock_style(text), private.date_pattern(text, text),
  private.date_text(timestamp, text, text), private.date_text(date, text, text), private.date_text(timestamptz, text, text),
  private.money_pattern(text), private.money_prefix(text), private.money_in(numeric, text) to authenticated, service_role;
