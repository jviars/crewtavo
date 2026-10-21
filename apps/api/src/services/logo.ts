/**
 * The business logo (supabase/migrations/20261020005300_company_logo.sql): a PNG the browser makes
 * from the picture chosen, kept at <company>/logo/<uuid>.png in the files bucket, with its path in
 * companies.settings.branding.logo and its size in branding.logo_size. Clients see it on the Client
 * Hub and in emails, from /api/public/logo/<company>/<uuid>.png. Replacing or removing it deletes
 * the old file.
 */
import { dbError, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";

/** The browser sends at most 720 × 240 pixels, usually 10–100 KB; this leaves room for a photo. */
export const LOGO_MAX_BYTES = 1_000_000;

/** This company's logo, as the database allows (companies_logo_check). */
export const isLogoPath = (path: string, companyId: string) => new RegExp(`^${companyId}/logo/[0-9a-f-]{36}\\.png$`).test(path);

/** A PNG starts 89 50 4E 47 0D 0A 1A 0A. Anything else (a page, a script) never goes in as a logo. */
export const isPng = (bytes: Uint8Array) => bytes.length > 24 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);

/** Width and height from a PNG's header (IHDR, right after the signature). */
const pngSize = (bytes: Uint8Array): [number, number] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};

type Settings = Record<string, unknown> & { branding?: Record<string, unknown> };

/** Saves `base64` (a PNG) as the company's logo and returns its path. */
export async function setLogo(admin: Db, companyId: string, base64: string): Promise<string> {
  const bytes = Buffer.from(base64, "base64");
  if (!isPng(bytes)) throw new HttpError(400, "That picture didn't come through. Try a different one.");
  if (bytes.length > LOGO_MAX_BYTES) throw new HttpError(413, "That logo is too large. Try a smaller picture.");
  const [width, height] = pngSize(bytes);
  if (!width || !height || width > 4000 || height > 4000) throw new HttpError(400, "That picture didn't come through. Try a different one.");
  const files = admin.storage.from("files");
  const path = `${companyId}/logo/${crypto.randomUUID()}.png`;
  // A path is never reused, so browsers and email apps can keep a logo as long as they like.
  const { error } = await files.upload(path, bytes, { contentType: "image/png", cacheControl: "31536000", upsert: false });
  if (error) throw new HttpError(502, `Couldn't save the logo: ${error.message}`);
  const settings = await currentSettings(admin, companyId);
  const old = logoOf(settings, companyId);
  const saved = await admin
    .from("companies")
    .update({ settings: { ...settings, branding: { ...(settings.branding ?? {}), logo: path, logo_size: [width, height] } } as never })
    .eq("id", companyId);
  if (saved.error) {
    await files.remove([path]);
    throw dbError(saved.error);
  }
  if (old && old !== path) await files.remove([old]);
  return path;
}

/** Back to the business name alone. */
export async function removeLogo(admin: Db, companyId: string): Promise<void> {
  const settings = await currentSettings(admin, companyId);
  const old = logoOf(settings, companyId);
  const { logo: _logo, logo_size: _size, ...branding } = settings.branding ?? {};
  const saved = await admin.from("companies").update({ settings: { ...settings, branding } as never }).eq("id", companyId);
  if (saved.error) throw dbError(saved.error);
  if (old) await admin.storage.from("files").remove([old]);
}

async function currentSettings(admin: Db, companyId: string): Promise<Settings> {
  const { data, error } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new HttpError(404, "Company not found.");
  return (data.settings ?? {}) as Settings;
}

/** The company's logo path, if it has one. Only ever one in its own logo folder, whatever the column holds. */
export function logoOf(settings: unknown, companyId: string): string | null {
  const path = (settings as Settings | null)?.branding?.logo;
  return typeof path === "string" && isLogoPath(path, companyId) ? path : null;
}

/**
 * Where clients' browsers and email apps load the logo from (`base` is the app's address, or "" on
 * its own pages), with the size it shows at: 48 pixels tall, or narrower for a very wide one.
 */
export function logoImage(base: string, companyId: string, settings: unknown, height = 48, maxWidth = 220): { src: string; width: number; height: number } | null {
  const path = logoOf(settings, companyId);
  if (!path) return null;
  const size = (settings as Settings).branding?.logo_size;
  const [w, h] = Array.isArray(size) && size.length === 2 && size.every((n) => typeof n === "number" && n > 0) ? (size as [number, number]) : [height, height];
  const scale = Math.min(height / h, maxWidth / w);
  return { src: `${base}/api/public/logo/${path.replace("/logo/", "/")}`, width: Math.round(w * scale), height: Math.round(h * scale) };
}
