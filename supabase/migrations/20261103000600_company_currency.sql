-- A company's currency is a three-letter code like USD or CAD (Settings → Company, sign-up). Every
-- screen, email and Stripe charge formats money with it, and anything else stops them, so the
-- database refuses it. Owners can set it directly, so a value in lower case becomes upper case and
-- anything else becomes USD; the owner can pick the right one again in Settings.
update public.companies set currency = upper(btrim(currency)) where currency is distinct from upper(btrim(currency)) and upper(btrim(currency)) ~ '^[A-Z]{3}$';
update public.companies set currency = 'USD' where currency !~ '^[A-Z]{3}$';
alter table public.companies add constraint companies_currency_code check (currency ~ '^[A-Z]{3}$');
