-- Database tests for 20261125100100_dates_in_the_business_country.sql: private.date_text writes the
-- database's to_char patterns the way the business's country writes them, as core writtenDate does
-- (the examples are packages/core/test/regional.test.ts WRITTEN), and exactly as to_char does in the
-- US. private.money_pattern writes an amount in the business's currency, "$" exactly as before.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tdtx;
create function tdtx.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;

-- ===== core's examples ==========================================================================
-- [date or moment, time zone, the US pattern, country, words], as in regional.test.ts; a moment is
-- written at the business's time zone, as the functions write them.
create table tdtx.written (value text, zone text, pattern text, country text, words text);
insert into tdtx.written values
  ('2026-10-06', null, 'Mon DD, YYYY', 'US', 'Oct 06, 2026'),
  ('2026-10-06', null, 'Mon DD, YYYY', 'CA', 'Oct 06, 2026'),
  ('2026-10-06', null, 'Mon DD, YYYY', 'GB', '6 Oct 2026'),
  ('2026-10-06', null, 'Mon FMDD, YYYY', 'AU', '6 Oct 2026'),
  ('2026-10-06', null, 'Mon FMDD', 'US', 'Oct 6'),
  ('2026-10-06', null, 'Mon FMDD', 'GB', '6 Oct'),
  ('2026-10-06', null, 'FMMon FMDD', 'IE', '6 Oct'),
  ('2026-10-06', null, 'Dy Mon FMDD', 'US', 'Tue Oct 6'),
  ('2026-10-06', null, 'Dy Mon FMDD', 'GB', 'Tue 6 Oct'),
  ('2026-10-06', null, 'FMMonth FMDD, YYYY', 'US', 'October 6, 2026'),
  ('2026-10-06', null, 'FMMonth FMDD, YYYY', 'NZ', '6 October 2026'),
  ('2026-10-06', null, 'FMMonth FMDD', 'ZA', '6 October'),
  ('2026-10-06', null, 'FMMonth YYYY', 'GB', 'October 2026'),
  ('2026-10-06T21:05:00Z', 'America/New_York', 'FMHH12:MI AM', 'US', '5:05 PM'),
  ('2026-10-06T21:05:00Z', 'America/Toronto', 'FMHH12:MI AM', 'CA', '5:05 p.m.'),
  ('2026-10-06T21:05:00Z', 'Europe/London', 'FMHH12:MI AM', 'GB', '22:05'),
  ('2026-10-06T21:05:00Z', 'Australia/Sydney', 'FMHH12:MI AM', 'AU', '8:05 am'),
  ('2026-10-06T08:05:00Z', 'Europe/Berlin', 'FMHH12:MI AM', 'DE', '10:05'),
  ('2026-10-06T21:05:00Z', 'Europe/London', 'Dy Mon FMDD', 'GB', 'Tue 6 Oct'),
  ('2026-10-06T23:30:00Z', 'Australia/Sydney', 'Dy Mon FMDD', 'AU', 'Wed 7 Oct');

select tdtx.check(
  case when w.zone is null then private.date_text(w.value::date, w.pattern, w.country)
       else private.date_text(w.value::timestamptz at time zone w.zone, w.pattern, w.country) end = w.words,
  format('%s %s %s is "%s"', w.value, w.pattern, w.country, w.words))
from tdtx.written w;

-- ===== A US business's words are to_char's =====================================================
-- Every pattern the database writes words with, at every hour of a year (both sides of noon and
-- midnight, single- and double-digit days), for a moment, a date and a wall-clock time.
create table tdtx.patterns (pattern text);
insert into tdtx.patterns values ('Mon DD, YYYY'), ('Mon FMDD, YYYY'), ('Mon FMDD'), ('FMMon FMDD'), ('Dy Mon FMDD'), ('Dy'),
  ('FMMonth FMDD, YYYY'), ('FMMonth FMDD'), ('FMMonth YYYY'), ('FMMonth'), ('FMHH12:MI AM'), ('YYYY-MM-DD');
create table tdtx.moments as
  select t from generate_series('2026-01-01 00:00:00+00'::timestamptz, '2027-01-01 00:00:00+00'::timestamptz, interval '7 hours 13 minutes') t;

select tdtx.check(not exists (
  select 1 from tdtx.moments m cross join tdtx.patterns p cross join (values ('US'), ('PR'), (''), (null)) c (country)
  where private.date_text(m.t at time zone 'America/Chicago', p.pattern, c.country) is distinct from to_char(m.t at time zone 'America/Chicago', p.pattern)
     or private.date_text((m.t at time zone 'America/Chicago')::date, p.pattern, c.country) is distinct from to_char((m.t at time zone 'America/Chicago')::date, p.pattern)
     or private.date_text(m.t, p.pattern, c.country) is distinct from to_char(m.t, p.pattern)
), 'in the US, its territories and with no country, every pattern is written as to_char writes it');

select tdtx.check(not exists (
  select 1 from tdtx.moments m cross join tdtx.patterns p cross join (values ('CA'), ('PH')) c (country)
  where p.pattern <> 'FMHH12:MI AM' and private.date_text((m.t at time zone 'America/Toronto')::date, p.pattern, c.country) is distinct from to_char((m.t at time zone 'America/Toronto')::date, p.pattern)
), 'Canada and the Philippines write their dates as the US does');
select tdtx.check(private.date_text('2026-10-06 09:05'::timestamp, 'FMHH12:MI AM', 'PH') = '9:05 AM'
  and private.date_text('2026-10-06 00:05'::timestamp, 'FMHH12:MI AM', 'CA') = '12:05 a.m.'
  and private.date_text('2026-10-06 12:00'::timestamp, 'FMHH12:MI AM', 'CA') = '12:00 p.m.', 'and their times their own way');

select tdtx.check(not exists (
  select 1 from tdtx.moments m cross join (values ('FMMonth YYYY'), ('FMMonth'), ('YYYY-MM-DD'), ('Dy')) p (pattern)
    cross join (values ('GB'), ('AU'), ('DE'), ('CA')) c (country)
  where private.date_text(m.t at time zone 'UTC', p.pattern, c.country) is distinct from to_char(m.t at time zone 'UTC', p.pattern)
), 'a pattern that reads the same everywhere is written as it is');

select tdtx.check(private.date_text('2026-03-09 00:05'::timestamp, 'FMHH12:MI AM', 'GB') = '00:05'
  and private.date_text('2026-03-09 09:05'::timestamp, 'FMHH12:MI AM', 'IE') = '09:05'
  and private.date_text('2026-03-09 12:30'::timestamp, 'FMHH12:MI AM', 'NZ') = '12:30 pm'
  and private.date_text('2026-03-09 00:30'::timestamp, 'FMHH12:MI AM', 'IN') = '12:30 am', 'a 24-hour clock writes the hour in two digits (core TIME_PATTERNS), an "am" country its own words');
select tdtx.check(private.date_text('2026-03-09'::date, 'Mon DD, YYYY', 'GB') = '9 Mar 2026'
  and private.date_text('2026-03-09'::date, 'Mon DD, YYYY', 'US') = 'Mar 09, 2026', 'the day first, without the zero the US writes before it');
select tdtx.check(private.date_text(null::date, 'Mon FMDD', 'GB') is null and private.date_text(null::timestamp, 'FMHH12:MI AM', 'US') is null,
  'no date is no words, as to_char has it');

select tdtx.check(not exists (
  select 1 from generate_series(0, 1439) m cross join (values ('US'), ('PR'), (null)) c (country)
  where private.date_text(time '00:00' + make_interval(mins => m), 'FMHH12:MI AM', c.country) is distinct from to_char(time '00:00' + make_interval(mins => m), 'FMHH12:MI AM')
), 'a time of day in the US is written as to_char writes it, every minute of the day');
select tdtx.check(private.date_text(time '06:00', 'FMHH12:MI AM', 'GB') = '06:00' and private.date_text(time '17:30', 'FMHH12:MI AM', 'CA') = '5:30 p.m.'
  and private.date_text(time '00:15', 'FMHH12:MI AM', 'AU') = '12:15 am', 'and elsewhere the country''s way');

-- ===== The countries ============================================================================
select tdtx.check(private.month_first('US') and private.month_first('CA') and private.month_first('PR') and private.month_first(null)
  and not private.month_first('GB') and not private.month_first('AU') and not private.month_first('DE') and not private.month_first('ZA'),
  'the month first in the US and Canada, the day first elsewhere (core monthFirst)');
select tdtx.check(array[private.clock_style('US'), private.clock_style('CA'), private.clock_style('AU'), private.clock_style('NZ'),
  private.clock_style('GB'), private.clock_style('IE'), private.clock_style('DE'), private.clock_style(null)]
  = array['AM', 'a.m.', 'am', 'am', '24', '24', '24', 'AM'], 'time kept the country''s way (core clockStyle)');

-- ===== Money ====================================================================================
select tdtx.check(private.money_pattern('USD') = 'FM$999,999,990.00' and private.money_pattern('CAD') = 'FM$999,999,990.00'
  and private.money_pattern('AUD') = 'FM$999,999,990.00' and private.money_pattern(null) = 'FM$999,999,990.00',
  'every dollar is written with the pattern the functions used');
select tdtx.check(to_char(1250.5, private.money_pattern('GBP')) = '£1,250.50' and to_char(1250.5, private.money_pattern('EUR')) = '€1,250.50'
  and to_char(1250.5, private.money_pattern('ZAR')) = 'R 1,250.50', 'pounds, euros and rand with their own symbol');
select tdtx.check(not exists (
  select 1 from (values (-5::numeric), (0), (0.004), (-0.004), (1234567.891), (999999999.99)) a (x) cross join (values ('GBP'), ('EUR'), ('ZAR'), ('USD')) c (cur)
  where to_char(a.x, private.money_pattern(c.cur)) is distinct from private.money_in(a.x, c.cur)
), 'as private.money_in writes them');
select tdtx.check(to_char(null::numeric, private.money_pattern('GBP')) is null, 'and nothing for no amount, as before');
