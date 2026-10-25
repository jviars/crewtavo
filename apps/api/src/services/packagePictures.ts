/**
 * A package's picture (roof_packages.picture), so the salesperson can tell the packages apart at a
 * glance and the homeowner sees what each option looks like: a JPEG the browser makes from the
 * photo chosen (apps/web/src/lib/files.ts packagePicture), kept at <company>/packages/<uuid>.jpg in
 * the files bucket. An option keeps the picture its package had when it was offered
 * (quote_options.picture), so a picture is never replaced or deleted: a new one is a new file, and
 * taking it off a package only clears the package's columns. Clients see them from
 * /api/public/package/<company>/<uuid>.jpg (core packagePictureSrc). Route: routes/packages.ts.
 */
import { PACKAGE_LIMITS } from "@crewtavo/core/presets";
import { dbError, HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";

/** The browser sends at most 1600 pixels on the long side, usually 150–500 KB. Requests are capped at 2 MB, and this as base64 stays under it. */
export const PACKAGE_PICTURE_MAX_BYTES = 1_400_000;

const TOO_LARGE = "That picture is too large. Try a smaller one.";

/** A JPEG starts FF D8 FF. Anything else (a page, a script) never goes in as a picture. */
export const isJpeg = (bytes: Uint8Array) => bytes.length > 24 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/**
 * Width and height from a JPEG's frame header (SOF0–SOF15, not DHT, JPG or DAC), walking the
 * segments after the start. Null when there's no frame header before the picture data starts.
 */
export function jpegSize(bytes: Uint8Array): [number, number] | null {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined) return null;
    // Markers without a length: the start, restarts and TEM.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // The end, or the picture data (SOS), before any frame header.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (at + 2 > bytes.length) return null;
    const length = (bytes[at]! << 8) | bytes[at + 1]!;
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 7 > bytes.length) return null;
      return [(bytes[at + 5]! << 8) | bytes[at + 6]!, (bytes[at + 3]! << 8) | bytes[at + 4]!];
    }
    at += length;
  }
  return null;
}

const NOT_FOUND = "That package wasn't found. It may have been deleted.";

/**
 * Saves `base64` (a JPEG) as the picture of one of the business's packages and returns where it went
 * and its size. `db` is the person's own client (their access to packages applies); Storage is
 * written with the server's.
 */
export async function setPackagePicture(db: Db, admin: Db, companyId: string, packageId: string, base64: string): Promise<{ path: string; width: number; height: number }> {
  // Too long to be a picture that size, before it's read: every 4 characters are 3 bytes.
  if (base64.length > Math.ceil(PACKAGE_PICTURE_MAX_BYTES / 3) * 4) throw new HttpError(413, TOO_LARGE);
  const bytes = Buffer.from(base64, "base64");
  if (!isJpeg(bytes)) throw new HttpError(400, "That picture didn't come through. Try a different one.");
  if (bytes.length > PACKAGE_PICTURE_MAX_BYTES) throw new HttpError(413, TOO_LARGE);
  const [width, height] = jpegSize(bytes) ?? [0, 0];
  if (!width || !height || width > PACKAGE_LIMITS.picturePixels || height > PACKAGE_LIMITS.picturePixels) throw new HttpError(400, "That picture didn't come through. Try a different one.");
  must(await db.from("roof_packages").select("id").eq("id", packageId).eq("company_id", companyId).maybeSingle(), NOT_FOUND);

  const files = admin.storage.from("files");
  const path = `${companyId}/packages/${crypto.randomUUID()}.jpg`;
  // A path is never reused and its file never changes, so browsers can keep it as long as they like.
  const { error } = await files.upload(path, bytes, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
  if (error) throw new HttpError(502, `Couldn't save the picture: ${error.message}`);
  const saved = await db.from("roof_packages").update({ picture: path, picture_width: width, picture_height: height }).eq("id", packageId).eq("company_id", companyId).select("id");
  if (saved.error || !saved.data?.length) {
    // Nothing points at it yet, so it can go.
    await files.remove([path]);
    if (saved.error) throw dbError(saved.error);
    throw new HttpError(404, NOT_FOUND);
  }
  return { path, width, height };
}

/** Back to the package's drawing. The file stays: options already offered with it keep showing it. */
export async function removePackagePicture(db: Db, companyId: string, packageId: string): Promise<void> {
  const saved = await db.from("roof_packages").update({ picture: null, picture_width: null, picture_height: null }).eq("id", packageId).eq("company_id", companyId).select("id");
  if (saved.error) throw dbError(saved.error);
  if (!saved.data?.length) throw new HttpError(404, NOT_FOUND);
}
