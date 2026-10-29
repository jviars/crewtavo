/**
 * Settings → Storage: how much room this Crewtavo's photos and files may take, and who's using it
 * (supabase/migrations/20261028000400_storage_limits.sql, GET /api/storage).
 *
 * A company limit, set by owners and admins, defaults to a bit under what Railway allows
 * (defaultStorageLimit); owners can also give a person, or everyone with a role, their own limit.
 * The server checks each upload before anything is stored (apps/api/src/lib/storageLimits.ts):
 *  - the company limit refuses uploads into Drive and plan files, guides, résumés, chat and
 *    equipment photos (and any folder not listed below);
 *  - a person's limit refuses only Drive and plan files and guides (PERSON_LIMITED_FOLDERS);
 *  - nothing a crew needs to finish a job is ever refused (STORAGE_FIELD_FOLDERS), though it counts;
 *  - owners are never limited by a personal limit, and server work, public forms and one-time
 *    upload links never are.
 * Sizes are in decimal units throughout (1 GB is 1,000,000,000 bytes), as Railway counts them and
 * as Settings → Hosting shows them.
 */
import { STORAGE_PRICES, type RailwayPlan, type StorageBackend } from "./hosting";

/**
 * Folders (a stored path's second part, <company>/<folder>/...) whose uploads no limit ever
 * refuses, so crews can always finish a job: visit and quote photos, sub paperwork, ticket photos,
 * receipts, measurement pictures, and what the server stores itself (profile photos, the logo,
 * letterheads, package and price-list pictures). They still count toward the totals.
 */
export const STORAGE_FIELD_FOLDERS = ["visit", "quote", "subs", "tickets", "receipts", "measurements", "avatars", "logo", "letterhead", "packages", "services"] as const;

/** Folders a person's own limit (or their role's) refuses: Drive and plan files, and guides. */
export const PERSON_LIMITED_FOLDERS = ["plans", "kb"] as const;

/** Which limits can refuse an upload into a folder. */
export interface StorageFolderRule {
  /** The company limit. */
  company: boolean;
  /** A person's own limit, or their role's. */
  person: boolean;
}

/** Which limits can refuse an upload into `folder` (a stored path's second part). */
export function storageFolderRule(folder: string): StorageFolderRule {
  if ((STORAGE_FIELD_FOLDERS as readonly string[]).includes(folder)) return { company: false, person: false };
  return { company: true, person: (PERSON_LIMITED_FOLDERS as readonly string[]).includes(folder) };
}

/** Warn owners and admins when the company's files reach these shares of its limit. */
export const STORAGE_WARN_AT = [0.8, 0.95] as const;

/** What the server answers an upload a limit refuses: HTTP 507, with one of the sentences below as `message`. */
export const STORAGE_FULL = { status: 507, error: "Storage full" } as const;

const UNITS = ["KB", "MB", "GB", "TB", "PB"] as const;

/**
 * A size for people: "45 GB", "812 MB", "12.4 GB", "3.4 KB", "1 TB". Decimal units, like Railway
 * and Settings → Hosting: a GB is 1,000,000,000 bytes. One decimal under 100, none above.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  if (bytes < 1000) return `${Math.round(bytes)} byte${Math.round(bytes) === 1 ? "" : "s"}`;
  let value = bytes / 1000;
  let unit = 0;
  for (;;) {
    const shown = value < 100 ? Math.round(value * 10) / 10 : Math.round(value);
    // 999.96 MB rounds to 1000 MB: say 1 GB instead.
    if (shown >= 1000 && unit < UNITS.length - 1) {
      value /= 1000;
      unit++;
      continue;
    }
    return `${shown} ${UNITS[unit]}`;
  }
}

/** A GB in bytes. */
export const GB = 1_000_000_000;

/**
 * What a Railway bucket may hold before the limit stops uploads, by plan: Hobby's 1 TB is shared by
 * the whole Railway workspace, so the default leaves room for the rest of it; Pro has no cap, so 1 TB
 * is a safety net (about $15 a month if it filled). The trial and Free plans hold far less.
 */
export const BUCKET_DEFAULTS: Record<RailwayPlan, { bytes: number; basis: string }> = {
  trial: { bytes: 45 * GB, basis: "Railway trial bucket" },
  free: { bytes: 9 * GB, basis: "Railway Free bucket" },
  hobby: { bytes: 900 * GB, basis: "Railway Hobby bucket" },
  pro: { bytes: 1000 * GB, basis: "Railway Pro bucket" },
};

/** On a volume, the default limit is this share of its size, so it never quite fills. */
export const VOLUME_SHARE = 0.9;

/**
 * The company limit when the owner hasn't set one, from where files live: 90% of the storage
 * service's volume, or what the Railway plan allows a bucket. Null (no default limit) when that's
 * not known: not on Railway, Railway not connected, or not read yet.
 */
export function defaultStorageLimit({ backend, volumeBytes, plan }: { backend: StorageBackend | null; volumeBytes: number | null; plan: RailwayPlan | null }): { bytes: number | null; basis: string | null } {
  if (backend === "volume" && volumeBytes && volumeBytes > 0) {
    return { bytes: Math.floor(volumeBytes * VOLUME_SHARE), basis: `${Math.round(VOLUME_SHARE * 100)}% of your ${formatBytes(volumeBytes)} volume` };
  }
  if (backend === "bucket" && plan) return { ...BUCKET_DEFAULTS[plan] };
  return { bytes: null, basis: null };
}

/** What Railway charges a month to keep a GB where files live (for the cost of a limit). */
export const storagePricePerGb = (backend: StorageBackend | null): number | null => (backend ? STORAGE_PRICES[backend] : null);

/** What keeping `bytes` costs a month at `pricePerGbMonth`, in dollars. */
export const storageMonthlyCost = (bytes: number, pricePerGbMonth: number) => (bytes / GB) * pricePerGbMonth;

/** An upload's size as said before "file": "This 2.4 MB file", "This 512-byte file". Null when it isn't known. */
const fileSize = (bytes: number | null | undefined): string | null => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes < 1000 ? `${Math.round(bytes)}-byte` : formatBytes(bytes);
};

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The upload refused because it would take the company's files past its limit: `bytes` is the
 * upload's size (left out of the sentence when it isn't known), `used` and `limit` the company's.
 * Only ever said to someone on the company's team.
 */
export function companyStorageFull(used: number, limit: number, bytes?: number | null): string {
  const why = `${formatBytes(used)} of the ${formatBytes(limit)} storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.`;
  const size = fileSize(bytes);
  return size ? `This ${size} file doesn't fit: ${why}` : sentence(why);
}

/** The upload refused because it would take the person past their own limit (or their role's): `used` of `limit`. */
export function personStorageFull(used: number, limit: number, bytes?: number | null): string {
  const why = `you've used ${formatBytes(used)} of your ${formatBytes(limit)}. Ask an owner to raise it, or move old files to the Trash.`;
  const size = fileSize(bytes);
  return size ? `This ${size} file doesn't fit in your storage: ${why}` : sentence(why);
}

/** How a company limit is set (companies.settings.storage.limit_bytes: absent, null, or a number). */
export type StorageLimitMode = "default" | "none" | "custom";
