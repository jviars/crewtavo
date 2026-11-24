-- The country a business works in (Settings → Company, and sign-up), as an ISO 3166-1 code: US, CA,
-- GB. What follows the place rather than the language goes by it: finding addresses on the map,
-- what the address boxes are called, completing phone numbers typed without a country code, the
-- US-only parts (1099s, postcards, the FTC's 3-day notice) and the paper PDFs are made on.
--
-- Every business so far was taken to be in the US. Each gets the guess from its time zone, as
-- sign-up guesses it (packages/core/src/countries.ts countryFor, the same table), and the owner can
-- change it in Settings → Company. A business made by the release before this one is in the US until
-- they do.
--
-- supabase/tests/business_country_test.sql covers it.

-- The country a business in this time zone is most likely in; the US otherwise (core countryFor).
create function private.country_for_zone(p_zone text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_zone ~ '^America/(Toronto|Montreal|Vancouver|Edmonton|Calgary|Winnipeg|Regina|Swift_Current|Halifax|Glace_Bay|Moncton|Goose_Bay|St_Johns|Whitehorse|Dawson|Dawson_Creek|Fort_Nelson|Creston|Yellowknife|Inuvik|Iqaluit|Rankin_Inlet|Cambridge_Bay|Resolute|Atikokan|Nipigon|Thunder_Bay|Rainy_River)$' then 'CA'
    when p_zone ~ '^Australia/' then 'AU'
    when p_zone in ('Pacific/Auckland', 'Pacific/Chatham') then 'NZ'
    when p_zone = 'Africa/Johannesburg' then 'ZA'
    when p_zone in ('Atlantic/Madeira', 'Atlantic/Azores') then 'PT'
    when p_zone in ('Atlantic/Canary', 'Africa/Ceuta') then 'ES'
    when p_zone in ('Asia/Nicosia', 'Asia/Famagusta', 'Europe/Nicosia') then 'CY'
    when p_zone in ('Europe/London', 'Europe/Belfast', 'Europe/Guernsey', 'Europe/Jersey', 'Europe/Isle_of_Man') then 'GB'
    when p_zone = 'Europe/Dublin' then 'IE'
    when p_zone = 'Europe/Andorra' then 'AD'
    when p_zone = 'Europe/Monaco' then 'MC'
    when p_zone = 'Europe/Podgorica' then 'ME'
    when p_zone = 'Europe/San_Marino' then 'SM'
    when p_zone = 'Europe/Vatican' then 'VA'
    when p_zone = 'Europe/Amsterdam' then 'NL'
    when p_zone = 'Europe/Athens' then 'GR'
    when p_zone in ('Europe/Berlin', 'Europe/Busingen') then 'DE'
    when p_zone = 'Europe/Bratislava' then 'SK'
    when p_zone = 'Europe/Brussels' then 'BE'
    when p_zone = 'Europe/Helsinki' then 'FI'
    when p_zone = 'Europe/Lisbon' then 'PT'
    when p_zone = 'Europe/Ljubljana' then 'SI'
    when p_zone = 'Europe/Luxembourg' then 'LU'
    when p_zone = 'Europe/Madrid' then 'ES'
    when p_zone = 'Europe/Malta' then 'MT'
    when p_zone = 'Europe/Paris' then 'FR'
    when p_zone = 'Europe/Riga' then 'LV'
    when p_zone = 'Europe/Rome' then 'IT'
    when p_zone = 'Europe/Sofia' then 'BG'
    when p_zone = 'Europe/Tallinn' then 'EE'
    when p_zone = 'Europe/Vienna' then 'AT'
    when p_zone = 'Europe/Vilnius' then 'LT'
    when p_zone = 'Europe/Zagreb' then 'HR'
    else 'US'
  end
$$;

-- A code Crewtavo knows (core countries.ts COUNTRY_CODES; packages/core/test/countries.test.ts
-- checks the two lists match), so the browser and the server read the same country.
alter table public.companies add column country text not null default 'US' constraint companies_country_code check (country in (
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE',
    'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD',
    'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM',
    'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
    'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
    'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
    'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME',
    'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
    'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
    'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI',
    'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK',
    'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
    'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
  ));
update public.companies set country = private.country_for_zone(timezone) where country is distinct from private.country_for_zone(timezone);

-- The browser reads the columns it's granted (20261123100100_prices_and_settings_for_the_office.sql);
-- owners and admins change it as they change the time zone (companies_update).
grant select (country) on public.companies to authenticated;
