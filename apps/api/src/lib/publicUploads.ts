/**
 * Files people without an account send in: a booking form's files and photos (routes/public.ts),
 * a sub's paperwork through their link (routes/subs.ts), and a job application's résumé
 * (routes/websiteForms.ts). Nobody signed in stands behind them, so the storage limits don't see
 * them (lib/storageLimits.ts), and without more a script could fill the business's disk or bucket.
 * Three things hold them:
 *
 *  - Each upload link the server makes for a form or a sub is on record (public.upload_links,
 *    20261123100500_public_upload_links.sql) with the size its visitor gave for the file and when
 *    it runs out. At the gateway, an upload through such a link has to say its size, and may be no
 *    bigger than that (a form's envelope aside: FORM_ROOM); a link with no record isn't taken.
 *  - What arrives counts against a day's worth for each business (UPLOAD_BYTES_A_DAY) and for each
 *    visitor's address (VISITOR_BYTES_A_DAY), counted where the bytes arrive: at the gateway for
 *    a link, and as the server stores an application's files. Counted in the database
 *    (rate_limit_spend) so every replica shares it. Past it, more are turned away until the day is
 *    over, and owners and admins hear once a day; new links aren't handed out meanwhile. Far more
 *    than real visitors send: a request's files are 500 MB at most. A count that can't be made lets
 *    the upload through: a budget never stops normal use.
 *  - A file nobody recorded goes once its link has run out (services/planFiles.ts
 *    tidyExpiredUploads, in the hourly upkeep), not a day later.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";
import { tellAdmins } from "./linkBudget";
import { allow } from "./limit";
import { reportError } from "./monitoring";
import { adminClient, type Db } from "./supabase";
import { visitorBlock } from "./visitor";

/** What strangers' uploads may bring a business in a day: 5 GB. */
export const UPLOAD_BYTES_A_DAY = 5_000_000_000;
/** What one visitor's address may send in a day, to all businesses together: 2 GB. */
export const VISITOR_BYTES_A_DAY = 2_000_000_000;
/** A file sent as a form (the way the app sends one to a link) is a little more than the file: its other field, the boundaries and its name. */
export const FORM_ROOM = 64 * 1024;
/** A link's record outlives its files token by this much, so the sweep never takes a file /files is recording just then. */
const RECORD_GRACE_MS = 10 * 60_000;

const DAY_SECONDS = 86_400;
/** Counted in KB, so a day's worth fits the database's count. */
const KB = 1000;

export const UPLOADS_PAUSED = "This business has taken in a lot of files today, so it can't take more until tomorrow. Email them instead.";
export const LINK_RUN_OUT = "This upload link has run out. Send the file again from the page you started on.";
export const BIGGER_THAN_SAID = "This file is bigger than the one this upload was made for. Send it again from the page you started on.";

export type UploadKind = "form" | "paperwork";

/** The record of an upload link the server made: whose, how big its file may be, and when it runs out (ms). */
export interface UploadRecord {
  company: string;
  maxBytes: number;
  expiresAt: number;
}

/** What the gateway asks about an upload through a link the server made. */
export interface PublicUploads {
  /** The link's record, null when it has none. Throws when it can't be read. */
  find(path: string): Promise<UploadRecord | null>;
  /** Counts `bytes` against the visitor's and the company's day: false once either is spent. */
  spend(company: string, visitor: string, bytes: number): Promise<boolean>;
}

/** The new table, as the server's client reaches it: the generated database types learn it only when they're regenerated. */
const loose = (db: Db) => db as unknown as SupabaseClient;

/** public.upload_links and the day's counts, through a service-role client made when first needed. */
export function publicUploadsFrom(env: Env, admin: () => Db = () => adminClient(env)): PublicUploads {
  let client: Db | null = null;
  return {
    async find(path) {
      client ??= admin();
      const { data, error } = await loose(client).from("upload_links").select("company_id, max_bytes, expires_at").eq("path", path).maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { company_id: string; max_bytes: number | string; expires_at: string } | null;
      return row ? { company: row.company_id, maxBytes: Number(row.max_bytes), expiresAt: Date.parse(row.expires_at) } : null;
    },
    spend: (company, visitor, bytes) => spendUploadBytes(env, company, visitor, bytes),
  };
}

/** Counts `bytes` under `key` for the day, against `budget`: false once it's spent, null when it couldn't be counted. 0 only asks. */
async function spendOn(env: Env, key: string, bytes: number, budget: number): Promise<boolean | null> {
  try {
    const { data, error } = await adminClient(env).rpc("rate_limit_spend", {
      p_key: key.slice(0, 200),
      p_amount: Math.ceil(Math.max(0, bytes) / KB),
      p_max: Math.floor(budget / KB),
      p_window_seconds: DAY_SECONDS,
    });
    if (error) throw new Error(error.message);
    return data !== false;
  } catch (error) {
    reportError(new Error(`Uploads' daily budget couldn't be counted: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
}

const visitorKey = (visitor: string) => `upload-bytes:ip:${visitorBlock(visitor || "unknown")}`;
const companyKey = (company: string) => `upload-bytes:company:${company}`;

/**
 * Counts `bytes` a visitor is sending a business against both their days: false once either is
 * spent (the visitor's first, so one address over its own doesn't use up the business's). A count
 * that can't be made lets it through. The first time the business's day runs out, its owners and
 * admins hear, once a day.
 */
export async function spendUploadBytes(env: Env, company: string, visitor: string, bytes: number): Promise<boolean> {
  if ((await spendOn(env, visitorKey(visitor), bytes, VISITOR_BYTES_A_DAY)) === false) return false;
  if ((await spendOn(env, companyKey(company), bytes, UPLOAD_BYTES_A_DAY)) !== false) return true;
  if (await allow(env, `upload-bytes-told:${company}`, 1, DAY_SECONDS)) {
    await tellAdmins(env, {
      company,
      title: "Files sent to you are paused for today",
      body: "Booking forms, subs' paperwork links and job applications brought in far more files today than they usually do, so more are turned away until tomorrow and people are asked to email them. If you didn't expect that many, someone may be sending them to fill your storage.",
      open: "/settings?tab=storage",
    }).catch((error: unknown) => console.warn("Couldn't say uploads were paused:", error instanceof Error ? error.message : error));
  }
  return false;
}

/** Whether the business can still take strangers' files today: only asks, counts nothing. True when it can't be asked. */
export async function uploadsLeftToday(env: Env, company: string): Promise<boolean> {
  return (await spendOn(env, companyKey(company), 0, UPLOAD_BYTES_A_DAY)) !== false;
}

/**
 * Signed upload links for these files (each a path of its own, and the size its visitor gave), with
 * their records, which outlive `expiresAt` (when the files token that records them runs out) a
 * little. The records are kept first: a link is never handed out without one. In the files' order,
 * null where Storage couldn't make a link; all null when the records can't be kept.
 */
export async function uploadLinks(
  admin: Db,
  { company, kind, files, expiresAt }: { company: string; kind: UploadKind; files: Array<{ path: string; bytes: number }>; expiresAt: number },
): Promise<Array<{ path: string; token: string } | null>> {
  if (!files.length) return [];
  const until = new Date(expiresAt + RECORD_GRACE_MS).toISOString();
  const { error } = await loose(admin)
    .from("upload_links")
    .insert(files.map((f) => ({ path: f.path, company_id: company, kind, max_bytes: Math.max(1, Math.ceil(f.bytes)), expires_at: until })));
  if (error) {
    console.error("Couldn't keep the record of upload links", error.message);
    return files.map(() => null);
  }
  return Promise.all(
    files.map(async (f) => {
      const { data, error: linkError } = await admin.storage.from("files").createSignedUploadUrl(f.path);
      return linkError || !data ? null : { path: f.path, token: data.token };
    }),
  );
}
