/**
 * Profile photos (supabase/migrations/20261020000100_profile_photos.sql): a small square JPEG the
 * browser makes from the picture someone chose, kept at <company>/avatars/<user>/<uuid>.jpg in the
 * files bucket, where the team reads it like any other file. Only this sets profiles.avatar_url,
 * and replacing or removing a photo deletes the old file.
 *
 * The photo sits in the folder of the business it was set in. Someone on two businesses' teams
 * (rare: an instance is usually one business) shows their initials at the other one.
 */
import { dbError, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";

/** The browser sends 512-pixel squares of 30–150 KB; this leaves room for a very detailed one. */
export const PHOTO_MAX_BYTES = 1_000_000;

/** One of this person's photos, as the database allows (profiles_avatar_url_check). */
export const isPhotoPath = (path: string, userId: string) => new RegExp(`^[0-9a-f-]{36}/avatars/${userId}/[0-9a-f-]{36}\\.jpg$`).test(path);

/** A JPEG starts FF D8 FF. Anything else (a page, a script) never goes in as someone's photo. */
export const isJpeg = (bytes: Uint8Array) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** Saves `base64` (a JPEG) as the person's photo and returns its path. */
export async function setPhoto(admin: Db, companyId: string, userId: string, base64: string): Promise<string> {
  const bytes = Buffer.from(base64, "base64");
  if (!isJpeg(bytes)) throw new HttpError(400, "That picture didn't come through. Try a different photo.");
  if (bytes.length > PHOTO_MAX_BYTES) throw new HttpError(413, "That photo is too large. Try a different one.");
  const files = admin.storage.from("files");
  const path = `${companyId}/avatars/${userId}/${crypto.randomUUID()}.jpg`;
  // A path is never reused, so browsers can keep a photo as long as they like.
  const { error } = await files.upload(path, bytes, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
  if (error) throw new HttpError(502, `Couldn't save the photo: ${error.message}`);
  const old = await currentPhoto(admin, userId);
  const saved = await admin.from("profiles").update({ avatar_url: path }).eq("user_id", userId);
  if (saved.error) {
    await files.remove([path]);
    throw dbError(saved.error);
  }
  if (old && old !== path) await files.remove([old]);
  return path;
}

/** Back to initials. */
export async function removePhoto(admin: Db, userId: string): Promise<void> {
  const old = await currentPhoto(admin, userId);
  const saved = await admin.from("profiles").update({ avatar_url: null }).eq("user_id", userId);
  if (saved.error) throw dbError(saved.error);
  if (old) await admin.storage.from("files").remove([old]);
}

async function currentPhoto(admin: Db, userId: string): Promise<string | null> {
  const { data, error } = await admin.from("profiles").select("avatar_url").eq("user_id", userId).maybeSingle();
  if (error) throw dbError(error);
  const path = data?.avatar_url ?? null;
  // Only ever deletes the person's own photo, whatever the column holds.
  return path && isPhotoPath(path, userId) ? path : null;
}
