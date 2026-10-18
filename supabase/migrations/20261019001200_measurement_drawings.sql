-- Drawings on quotes and invoices. A measurement can now be attached to an invoice as well as a
-- quote, and shown to the client on either one: show_on_quote and show_on_invoice are separate, so
-- hiding it from the invoice leaves the quote as it was. It keeps a picture of the map
-- (snapshot_path, in the private files bucket) so the Client Hub and printed PDFs show the drawing
-- without loading a map, and where the map was (view: center, zoom, imagery) so reopening it starts
-- in the same place.

alter table public.measurements
  add column invoice_id uuid,
  add column show_on_quote boolean not null default false,
  add column show_on_invoice boolean not null default false,
  add column snapshot_path text,
  add column view jsonb,
  add constraint measurements_invoice_fk foreign key (company_id, invoice_id)
    references public.invoices (company_id, id) on delete set null (invoice_id),
  -- The Hub reads this file with the service key, so it must be one of this company's map pictures
  -- (never a receipt or another company's file).
  add constraint measurements_snapshot_path_check check (
    snapshot_path is null or (
      snapshot_path ~ '^[0-9a-f-]{36}/measurements/[0-9a-f-]{36}\.(jpg|png)$'
      and split_part(snapshot_path, '/', 1) = company_id::text
    )
  ),
  add constraint measurements_view_check check (view is null or jsonb_typeof(view) = 'object');

create index measurements_quote_idx on public.measurements (company_id, quote_id) where quote_id is not null;
create index measurements_invoice_idx on public.measurements (company_id, invoice_id) where invoice_id is not null;
create index measurements_property_idx on public.measurements (company_id, property_id) where property_id is not null;

comment on column public.measurements.show_on_quote is 'The client sees this drawing on its quote (Client Hub and PDF).';
comment on column public.measurements.show_on_invoice is 'The client sees this drawing on its invoice (Client Hub and PDF).';
comment on column public.measurements.snapshot_path is 'Picture of the drawing on the map: <company>/measurements/<uuid>.jpg in the files bucket.';

-- Moving a drawing to another quote or invoice (or off one, including when that quote or invoice
-- is deleted) hides it there until someone chooses to show it, unless the same change says so.
create function private.measurement_reset_shown() returns trigger
language plpgsql as $$
begin
  if new.quote_id is distinct from old.quote_id and new.show_on_quote = old.show_on_quote then
    new.show_on_quote := false;
  end if;
  if new.invoice_id is distinct from old.invoice_id and new.show_on_invoice = old.show_on_invoice then
    new.show_on_invoice := false;
  end if;
  return new;
end $$;
create trigger measurement_reset_shown before update on public.measurements
  for each row execute function private.measurement_reset_shown();
