/**
 * The business's own letterhead on an estimate template (core documents.ts): the top and bottom of
 * its stationery, which the browser cuts into PNGs in the template builder, kept at
 * <company>/letterhead/<uuid>.png in the files bucket. The template keeps each picture's path and
 * size, and so does every quote signed with it (quotes.approval.template), so a picture is never
 * replaced or deleted: a signed estimate keeps printing on the letterhead it was signed on. Clients
 * see them from /api/public/letterhead/<company>/<uuid>.png.
 */
import { LETTERHEAD_MAX_PIXELS, type LetterheadPicture } from "@crewtavo/core/documents";
import { HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import { isPng, pngSize } from "./logo";

/**
 * The top or bottom of a letter page at 200 dpi is usually 30–600 KB. Requests are capped at 2 MB,
 * and this sent as base64 stays under it; the browser makes a larger one smaller first.
 */
export const LETTERHEAD_MAX_BYTES = 1_400_000;

/** Saves `base64` (a PNG) as a new letterhead picture and returns where it went and its size. */
export async function saveLetterheadPicture(admin: Db, companyId: string, base64: string): Promise<LetterheadPicture> {
  const bytes = Buffer.from(base64, "base64");
  if (!isPng(bytes)) throw new HttpError(400, "That letterhead didn't come through. Try again.");
  if (bytes.length > LETTERHEAD_MAX_BYTES) throw new HttpError(413, "That letterhead is too large. Try a smaller picture or PDF.");
  const [width, height] = pngSize(bytes);
  if (!width || !height || width > LETTERHEAD_MAX_PIXELS || height > LETTERHEAD_MAX_PIXELS) throw new HttpError(400, "That letterhead didn't come through. Try again.");
  const path = `${companyId}/letterhead/${crypto.randomUUID()}.png`;
  // A path is never reused and its file never changes, so browsers can keep it as long as they like.
  const { error } = await admin.storage.from("files").upload(path, bytes, { contentType: "image/png", cacheControl: "31536000", upsert: false });
  if (error) throw new HttpError(502, `Couldn't save the letterhead: ${error.message}`);
  return { path, width, height };
}
