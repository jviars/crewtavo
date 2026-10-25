-- A picture for each price list item, so the salesperson can tap what they found on the roof (a pipe
-- boot, chimney flashing, a sheet of rotten decking) on the iPad's site visit. Stored by the server
-- (PUT /api/services/:id/picture) in the business's own folder as <company>/services/<uuid>.jpg,
-- never reused, the way package pictures are. Without one, the visit draws the item instead.

alter table public.services
  add column picture text,
  add column picture_width integer,
  add column picture_height integer,
  add constraint services_picture_check
    check (picture is null or picture ~ ('^' || company_id::text || '/services/[0-9a-f-]{36}\.jpg$')),
  add constraint services_picture_size_check
    check ((picture is null) = (picture_width is null) and (picture is null) = (picture_height is null)
       and (picture is null or (picture_width between 1 and 4000 and picture_height between 1 and 4000)));

comment on column public.services.picture is 'Its picture on the iPad''s site visit, <company>/services/<uuid>.jpg in the files bucket; a new picture is a new file.';
