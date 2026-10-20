-- Profile photos: a picture of someone in place of their initials, wherever the team sees them.
--
--   * The photo is a small square JPEG in the private files bucket, at
--     <company>/avatars/<user>/<uuid>.jpg, so the team reads it like other files (files_read).
--   * Only the API sets profiles.avatar_url (PUT /api/team/:id/photo), after checking the picture
--     and who's changing it: someone sets their own, an owner or admin with the team area sets
--     anyone's on the team. Replacing or removing a photo deletes the old file, so the column only
--     ever points at that person's own photo.

update public.profiles
set avatar_url = null
where avatar_url is not null
  and avatar_url !~ ('^[0-9a-f-]{36}/avatars/' || user_id::text || '/[0-9a-f-]{36}\.jpg$');

revoke update (avatar_url) on public.profiles from authenticated;

alter table public.profiles add constraint profiles_avatar_url_check
  check (avatar_url is null or avatar_url ~ ('^[0-9a-f-]{36}/avatars/' || user_id::text || '/[0-9a-f-]{36}\.jpg$'));

comment on column public.profiles.avatar_url is 'Their photo: <company>/avatars/<user>/<uuid>.jpg in the files bucket. Set by the API only.';

notify pgrst, 'reload schema';
