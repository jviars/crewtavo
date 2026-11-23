-- Price list pictures (<company>/services/<uuid>.jpg, 20261025000200_service_pictures.sql) are
-- written only by the server, which checks they're pictures and then shows them to anyone with a
-- client's link, like the logo, letterhead and package pictures. The rule that keeps the browser out
-- of those folders (20261025000100_contracts_and_options.sql) didn't name this one, so anyone on the
-- team could put a file there. It names it now.
--
-- (Marking a photo OK to share now asks for someone who can see it:
-- 20261122000100_prices_and_own_pay_stay_with_their_roles.sql.)
--
-- supabase/tests/service_pictures_and_photo_sharing_test.sql covers both.

-- ---------------------------------------------------------------------------------------------
-- Pictures only the server writes
-- ---------------------------------------------------------------------------------------------

drop policy files_server_pictures_insert on storage.objects;
drop policy files_server_pictures_update on storage.objects;
drop policy files_server_pictures_delete on storage.objects;
create policy files_server_pictures_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'files' or split_part(name, '/', 2) not in ('logo', 'letterhead', 'packages', 'services'));
create policy files_server_pictures_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'files' or split_part(name, '/', 2) not in ('logo', 'letterhead', 'packages', 'services'))
  with check (bucket_id <> 'files' or split_part(name, '/', 2) not in ('logo', 'letterhead', 'packages', 'services'));
create policy files_server_pictures_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'files' or split_part(name, '/', 2) not in ('logo', 'letterhead', 'packages', 'services'));

notify pgrst, 'reload schema';
