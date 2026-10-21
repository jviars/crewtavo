-- The business logo: at the top of the Client Hub (so on printed and PDF quotes and invoices) and
-- of the emails clients get.
--
--   * The logo is a PNG the browser makes from the picture chosen (transparency kept), in the
--     private files bucket at <company>/logo/<uuid>.png.
--   * companies.settings.branding.logo holds that path, and branding.logo_size its [width, height].
--     The API sets them (PUT /api/company/logo) after checking the picture; replacing or removing
--     the logo deletes the old file.
--   * Clients load it from /api/public/logo/<company>/<uuid>.png, which serves only the file this
--     column points at, so it can only ever point into the company's own logo folder.

update public.companies
set settings = settings #- '{branding,logo}'
where settings #>> '{branding,logo}' is not null
  and settings #>> '{branding,logo}' !~ ('^' || id::text || '/logo/[0-9a-f-]{36}\.png$');

alter table public.companies add constraint companies_logo_check
  check (settings #>> '{branding,logo}' is null or settings #>> '{branding,logo}' ~ ('^' || id::text || '/logo/[0-9a-f-]{36}\.png$'));

notify pgrst, 'reload schema';
