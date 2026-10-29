/**
 * Storage limits (Settings → Storage; packages/core/src/storage.ts), checked before anything is
 * stored: at the gateway, for uploads from the browser (lib/gateway.ts), and for files brought in
 * from Google Drive (routes/drive.ts), which the server stores itself.
 *
 * Only a signed-in team member's uploads are checked, and the gateway reads who's uploading the way
 * Storage itself will, so the two never disagree:
 *  - a resumable upload or a file sent in one request is the person whose token (Authorization,
 *    with or without "Bearer ") has role "authenticated" and a sub;
 *  - an upload to a signed upload link is whoever the link was made for (the owner in its token;
 *    Storage ignores Authorization there). Links the server makes (booking forms, sub paperwork) are
 *    made for nobody, so they're never checked.
 * Every token is checked as Storage checks it (HS256, signed with the instance's JWT_SECRET, not run
 * out) before anything is read for it: one that isn't genuine is nobody's, so it's sent on for
 * Storage to turn down, and nobody's numbers are read or shown for it. The numbers are read, and a
 * refusal says them, only for an active member of the company's team (subs can't store anything a
 * limit refuses). Server work (the service key), anonymous visitors and a storage move are never
 * checked, and nothing a crew needs to finish a job ever is (STORAGE_FIELD_FOLDERS).
 *
 * What's checked is the upload's own word for its size: a resumable upload's Upload-Length as it's
 * created (its pieces aren't checked again), and a direct or signed upload's Content-Length (a
 * form's is a little more than its file). At the gateway, a signed-in person's upload that doesn't
 * say its size isn't taken where a limit applies (411). The company comes from the stored path's
 * first part and the folder from its second. The numbers to check against come from the database
 * (public.storage_snapshot, service role only), kept here for CACHE_MS per company and person, with
 * each upload let through counted on top until a reading has it, so a burst of uploads can't run
 * far past a limit. Uploads at the same moment may still go a little over; that's accepted. A
 * refusal is never given from numbers kept here: they're read again first, so a raised limit, a new
 * allowance or an emptied Trash counts at once. If the numbers can't be read, uploads go ahead: a
 * limit is a budget, and work never stops for it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { companyStorageFull, personStorageFull, STORAGE_FULL, storageFolderRule } from "@crewtavo/core/storage";
import type { Db } from "./supabase";

/** How long one reading of a company's and a person's numbers is used. */
export const CACHE_MS = 30_000;
/** How long to wait for the database's numbers before letting an upload go ahead. */
const SNAPSHOT_TIMEOUT_MS = 5_000;
/** Storage's bucket for Crewtavo's files: the only one limits apply to. */
const FILES = "files";
/** A company's folder, as private.path_company reads it (lowercase only: anything else isn't one). */
const COMPANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A company's and one person's numbers, in bytes. A null limit is no limit. */
export interface StorageSnapshot {
  companyUsed: number;
  companyLimit: number | null;
  userUsed: number;
  /** Their own limit, else their role's; null for owners. */
  userLimit: number | null;
  owner: boolean;
  /**
   * They're an active member of the company's team (not a sub). Only then is anything checked or
   * said: Storage lets nobody else store anything a limit refuses. False means nothing else was read.
   */
  member: boolean;
}

/** Where the numbers come from: public.storage_snapshot, or a stand-in in tests. */
export type SnapshotSource = (company: string, user: string) => Promise<StorageSnapshot>;

const bytesOf = (value: unknown): number | null => (value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null);

/** Gives up on `work` after SNAPSHOT_TIMEOUT_MS. */
async function inTime<T>(work: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The database took too long to say how much is stored.")), SNAPSHOT_TIMEOUT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * public.storage_snapshot through a service-role client (made when first needed), for a member of
 * the company's team. Whether they are is asked first, so nobody else's upload has the company's
 * files added up.
 */
export function snapshotsFrom(admin: () => Db): SnapshotSource {
  let client: Db | null = null;
  return async (company, user) => {
    client ??= admin();
    const membership = await inTime(client.from("memberships").select("role").eq("company_id", company).eq("user_id", user).eq("active", true).maybeSingle());
    if (membership.error) throw new Error(membership.error.message);
    const role = (membership.data as { role?: unknown } | null)?.role;
    if (typeof role !== "string" || role === "subcontractor") {
      return { companyUsed: 0, companyLimit: null, userUsed: 0, userLimit: null, owner: false, member: false };
    }
    const { data, error } = await inTime(client.rpc("storage_snapshot", { p_company: company, p_user: user }));
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
    return {
      companyUsed: bytesOf(row?.company_used) ?? 0,
      companyLimit: bytesOf(row?.company_limit),
      userUsed: bytesOf(row?.user_used) ?? 0,
      userLimit: bytesOf(row?.user_limit),
      owner: row?.user_is_owner === true,
      member: true,
    };
  };
}

/** An upload the limits look at: into `folder` of `company`'s files, by `user` (null: no signed-in person). */
export interface StorageUpload {
  company: string;
  user: string | null;
  folder: string;
  /** What it says its size is; null when it doesn't say. */
  bytes: number | null;
  /** A resumable upload being made: its file comes later, in pieces. */
  resumable?: boolean;
}

/**
 * Let through, or refused with why. One let through counts toward the numbers until a reading has
 * it: `stored` says it's in Storage now (the next reading has it), `release` that it never will be.
 */
export type StorageVerdict = { ok: true; release: () => void; stored: () => void } | { ok: false; message: string };

/** One reading of the database's numbers. */
interface Count {
  /** When it was asked for, for how long it's used. */
  at: number;
  /** Its place in line with uploads being stored (tick): one stored before it was asked for is in it. */
  seq: number;
  used: number;
  limit: number | null;
}
interface PersonCount extends Count {
  owner: boolean;
  member: boolean;
}

/** An upload let through, counted until a reading has it (or for CACHE_MS, if Storage never says). */
interface Hold {
  bytes: number;
  at: number;
  /** tick when Storage said it was stored; null while it's still arriving. */
  stored: number | null;
}

const companies = new Map<string, Count>();
const people = new Map<string, PersonCount>();
/** Uploads let through, by company and by company:person. */
const holds = new Map<string, Set<Hold>>();
const reading = new Map<string, Promise<void>>();
const personKey = (company: string, user: string) => `${company}:${user}`;
/** Puts readings and stored uploads in the order they happened (two can share a millisecond). */
let tick = 0;

/**
 * Forgets every reading and every upload counted: when the server sets a new default limit (a
 * lower one counts at once), and in tests. A raised one needs nothing: a refusal reads again first.
 */
export function forgetStorageUsage() {
  forgetStorageReadings();
  holds.clear();
  arriving.clear();
}

/**
 * Forgets the readings only, so the next upload reads the numbers again (a new default limit counts
 * at once), while uploads still arriving, which no reading has yet, stay counted.
 */
export function forgetStorageReadings() {
  companies.clear();
  people.clear();
  reading.clear();
}

let warnedAt = 0;
function couldNotRead(error: unknown) {
  // Once a minute at most: every upload would say it otherwise.
  if (Date.now() - warnedAt < 60_000) return;
  warnedAt = Date.now();
  console.warn("Storage limits: couldn't read how much is stored, so uploads go ahead unchecked:", error instanceof Error ? error.message : error);
}

const fresh = (count: Count | undefined, now: number): count is Count => Boolean(count && now - count.at < CACHE_MS);

/** What's let through under `key` that `count` doesn't have yet; forgets what it has, and what's too old. */
function pending(key: string, count: Count, now: number): number {
  const set = holds.get(key);
  if (!set) return 0;
  let bytes = 0;
  for (const held of set) {
    if (now - held.at >= CACHE_MS || (held.stored !== null && held.stored < count.seq)) set.delete(held);
    else bytes += held.bytes;
  }
  if (!set.size) holds.delete(key);
  return bytes;
}

/**
 * The company's and the person's numbers: kept ones under CACHE_MS old, else read again (once, for
 * uploads that arrive together). `read`: these were asked for since this upload arrived.
 */
async function countsFor(source: SnapshotSource, company: string, user: string): Promise<{ company: Count; person: PersonCount; read: boolean }> {
  const key = personKey(company, user);
  // Someone not on the company's team has no company numbers: nothing of the company's is read for them.
  const counted = (person: PersonCount) => (person.member ? companies.get(company) : { at: person.at, seq: person.seq, used: 0, limit: null });
  const now = Date.now();
  const kept = people.get(key);
  const keptCompany = kept && counted(kept);
  if (fresh(kept, now) && fresh(keptCompany, now)) return { company: keptCompany, person: kept, read: false };
  let pending = reading.get(key);
  if (!pending) {
    const at = Date.now();
    const seq = ++tick;
    pending = source(company, user)
      .then((snapshot) => {
        sweep();
        // Someone else's reading, asked for after this one, is the newer: it stays.
        if (snapshot.member && !((companies.get(company)?.seq ?? 0) > seq)) companies.set(company, { at, seq, used: snapshot.companyUsed, limit: snapshot.companyLimit });
        if (!((people.get(key)?.seq ?? 0) > seq)) {
          people.set(key, { at, seq, used: snapshot.userUsed, limit: snapshot.owner ? null : snapshot.userLimit, owner: snapshot.owner, member: snapshot.member });
        }
      })
      .finally(() => reading.delete(key));
    reading.set(key, pending);
  }
  await pending;
  const person = people.get(key);
  const companyCount = person && counted(person);
  if (!person || !companyCount) throw new Error("No storage reading");
  return { company: companyCount, person, read: true };
}

let sweptAt = 0;
/** Forgets readings and uploads counted that are past CACHE_MS. */
function sweep() {
  const now = Date.now();
  sweptAt = now;
  for (const [k, v] of companies) if (now - v.at >= CACHE_MS) companies.delete(k);
  for (const [k, v] of people) if (now - v.at >= CACHE_MS) people.delete(k);
  for (const [k, set] of holds) {
    for (const held of set) if (now - held.at >= CACHE_MS) set.delete(held);
    if (!set.size) holds.delete(k);
  }
}

/** Counts an upload under `keys` until a reading has it. */
function hold(keys: string[], bytes: number): { release: () => void; stored: () => void } {
  // Uploads nobody reads numbers for (visit photos, say) are forgotten in time too.
  if (Date.now() - sweptAt >= CACHE_MS) sweep();
  const held: Hold = { bytes, at: Date.now(), stored: null };
  for (const key of keys) {
    let set = holds.get(key);
    if (!set) holds.set(key, (set = new Set()));
    set.add(held);
  }
  let done = false;
  return {
    release: () => {
      if (done) return;
      done = true;
      for (const key of keys) holds.get(key)?.delete(held);
    },
    stored: () => {
      if (done) return;
      done = true;
      held.stored = ++tick;
    },
  };
}

type Decision = { ok: true } | { ok: false; message: string };

function decide(rule: { company: boolean; person: boolean }, upload: StorageUpload, counts: { company: Count; person: PersonCount }, keys: [string, string]): Decision {
  const now = Date.now();
  const need = Math.max(upload.bytes ?? 0, 1);
  const { company, person } = counts;
  const companyUsed = company.used + pending(keys[0], company, now);
  const personUsed = person.used + pending(keys[1], person, now);
  if (rule.company && company.limit !== null && companyUsed + need > company.limit) {
    return { ok: false, message: companyStorageFull(companyUsed, company.limit, upload.bytes) };
  }
  if (rule.person && !person.owner && person.limit !== null && personUsed + need > person.limit) {
    return { ok: false, message: personStorageFull(personUsed, person.limit, upload.bytes) };
  }
  return { ok: true };
}

/**
 * Whether an upload may be stored, and if so it's counted. The company's limit applies to the
 * folders storageFolderRule says, a person's to Drive and plan files and guides; owners have no
 * personal limit. A size that isn't said counts as a byte, so a full company still refuses it.
 */
export async function reserveStorage(source: SnapshotSource, upload: StorageUpload): Promise<StorageVerdict> {
  const rule = storageFolderRule(upload.folder);
  const bytes = Math.max(0, upload.bytes ?? 0);
  const ahead = { ok: true as const, release: () => undefined, stored: () => undefined };
  if (!upload.user) return ahead;
  const keys: [string, string] = [upload.company, personKey(upload.company, upload.user)];
  // Never refused, so there's nothing to read; it still counts toward the numbers.
  if (!rule.company && !rule.person) return { ok: true, ...hold(keys, bytes) };
  try {
    let counts = await countsFor(source, upload.company, upload.user);
    if (!counts.person.member) return ahead;
    let decision = decide(rule, upload, counts, keys);
    if (!decision.ok && !counts.read) {
      // Never refused by numbers kept from before: the limit may have been raised, or the Trash
      // emptied, since. Uploads still arriving stay counted.
      companies.delete(upload.company);
      people.delete(keys[1]);
      counts = await countsFor(source, upload.company, upload.user);
      if (!counts.person.member) return ahead;
      decision = decide(rule, upload, counts, keys);
    }
    if (!decision.ok) return decision;
  } catch (error) {
    couldNotRead(error);
    return ahead;
  }
  // Everything a person stores counts toward their own total, whichever folder it's in.
  return { ok: true, ...hold(keys, bytes) };
}

// ---------------------------------------------------------------------------------------------
// At the gateway
// ---------------------------------------------------------------------------------------------

/**
 * A token's claims, when it's genuine as Storage checks one (internal/auth/jwt.ts, with jose):
 * HS256, signed with the instance's JWT_SECRET, a JSON object, and not run out (exp) or early (nbf)
 * if it says. Null for anything else, or when there's no secret to check with.
 */
export function verifiedClaims(token: string | null | undefined, secret: string | null | undefined): Record<string, unknown> | null {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown } | null;
    if (head?.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    const { exp, nbf, iat } = claims as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (iat !== undefined && typeof iat !== "number") return null;
    if (nbf !== undefined && (typeof nbf !== "number" || nbf > now)) return null;
    if (exp !== undefined && (typeof exp !== "number" || exp <= now)) return null;
    return claims as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The signed-in person a request is from: its Authorization token read as Storage reads it (an
 * optional "Bearer " before it, else the whole header), when it's genuine and a signed-in person's
 * (role "authenticated", with a sub), not a key or an anonymous visitor's.
 */
export function signedInUser(request: Request, secret: string | null | undefined): string | null {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const claims = verifiedClaims(token, secret);
  return claims?.role === "authenticated" && typeof claims.sub === "string" && claims.sub ? claims.sub : null;
}

/**
 * Whom a signed upload link was made for: the owner in its token (Storage's signUploadObjectUrl
 * puts the person who asked for the link there), when the token is genuine and for uploading.
 * Null for a link the server made (no owner), or a token that isn't one.
 */
export function linkOwner(token: string | null | undefined, secret: string | null | undefined): string | null {
  const claims = verifiedClaims(token, secret);
  if (!claims) return null;
  const forUploading = claims.scope === "upload" || (claims.scope === undefined && "upsert" in claims);
  return forUploading && typeof claims.owner === "string" && claims.owner ? claims.owner : null;
}

const tusKey = (key: string) => {
  if (!key.length) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.codePointAt(i)!;
    if (code > 127 || code === 32 || code === 44) return false;
  }
  return true;
};
const tusValue = (value: string) => value.length % 4 === 0 && /^[\d+/A-Za-z]*={0,2}$/.test(value);

/**
 * A resumable upload's Upload-Metadata, read exactly as Storage's tus server reads it (@tus/utils
 * Metadata.parse): split on "," and each pair on a single " ", nothing trimmed; a key is ASCII
 * with no space or comma and said once, a value is base64. Null when tus would turn the header
 * down, and then Storage refuses the upload itself.
 */
export function tusMetadata(header: string | null): Record<string, string | null> | null {
  if (!header || !header.trim().length) return null;
  const meta: Record<string, string | null> = {};
  for (const pair of header.split(",")) {
    const tokens = pair.split(" ");
    const [key = "", value] = tokens;
    const valid = (tokens.length === 1 && tusKey(key)) || (tokens.length === 2 && tusKey(key) && tusValue(value!));
    // As tus asks: "in", so a name objects already have ("constructor") counts as said.
    if (!valid || key in meta) return null;
    meta[key] = value ? Buffer.from(value, "base64").toString("utf8") : null;
  }
  return meta;
}

const sizeOf = (header: string | null) => (header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null);

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/**
 * A path as Storage's router (find-my-way) matches it: escapes decoded, except those of the
 * characters that mean something in an address (/ ? # : and the like), which decodeURI keeps too,
 * and %25, which stays as it is. Null when it can't be decoded: Storage turns that request down.
 */
export function routedPath(path: string): string | null {
  if (!path.includes("%")) return path;
  try {
    return decodeURI(path.replace(/%25/g, "%2525"));
  } catch {
    return null;
  }
}

/** The stricter folder of two: refused by both limits, else by the company's, else by neither. */
const strictness = (folder: string) => {
  const rule = storageFolderRule(folder);
  return rule.person ? 2 : rule.company ? 1 : 0;
};

/**
 * The company and folder of a stored name. A name in an address may be read decoded or as it is,
 * so the company is whichever reading is a company, and the folder whichever a limit is stricter
 * about: an encoded name can't slip a Drive file past as a visit photo.
 */
function placeOf(name: string, encoded: boolean): { company: string; folder: string } | null {
  const readings = encoded ? [decoded(name), name].filter((n): n is string => n !== null) : [name];
  const parts = readings.map((n) => n.split("/"));
  const company = parts.map((p) => p[0] ?? "").find((c) => COMPANY.test(c));
  if (!company) return null;
  // A reading whose first part isn't the company isn't one Storage would let in (row-level security
  // wants a company's folder), so only the others count.
  const folders = parts.filter((p) => p[0] === company).map((p) => p[1] ?? "");
  const folder = folders.sort((a, b) => strictness(b) - strictness(a))[0] ?? "";
  return { company, folder };
}

/** Storage's resumable uploads: "/" and "/*", and the same under "/sign" for signed upload links. */
const RESUMABLE = /^\/storage\/v1\/upload\/resumable(?:\/|$)/;
const RESUMABLE_SIGNED = /^\/storage\/v1\/upload\/resumable\/sign(?:\/|$)/;
const SIGNED_UPLOAD = /^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/;
const DIRECT_UPLOAD = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/;

/**
 * The upload a request to Storage starts, for the limits, read as Storage will route and read it.
 * A resumable upload being created: any POST under upload/resumable, whatever follows it (Storage
 * routes "/" and "/*" there to tus, and tus goes by the request's own method: neither takes
 * X-HTTP-Method-Override); under upload/resumable/sign it's a signed link's (x-signature). A file
 * sent in one request (POST or PUT object/files/<name>), or to a signed upload link (PUT
 * object/upload/sign/files/<name>?token=). Null for everything else, including a resumable upload's
 * pieces, making an upload link, and anything outside the files bucket or a company's folder
 * (Storage refuses those itself). `secret` checks the tokens (JWT_SECRET).
 */
export function uploadOf(request: Request, secret: string | null | undefined): StorageUpload | null {
  const url = new URL(request.url);
  const path = routedPath(url.pathname);
  if (path === null) return null;
  const method = request.method.toUpperCase();
  if (RESUMABLE.test(path)) {
    if (method !== "POST") return null;
    const meta = tusMetadata(request.headers.get("upload-metadata"));
    if (!meta || meta.bucketName !== FILES || !meta.objectName) return null;
    const place = placeOf(meta.objectName, false);
    // On a signed link's route Storage goes by the link and ignores Authorization.
    const user = RESUMABLE_SIGNED.test(path) ? linkOwner(request.headers.get("x-signature"), secret) : signedInUser(request, secret);
    return place && { ...place, user, bytes: sizeOf(request.headers.get("upload-length")), resumable: true };
  }
  const signed = path.match(SIGNED_UPLOAD);
  if (signed) {
    if (method !== "PUT" || decoded(signed[1]!) !== FILES) return null;
    const place = placeOf(signed[2]!, true);
    return place && { ...place, user: linkOwner(url.searchParams.get("token"), secret), bytes: sizeOf(request.headers.get("content-length")) };
  }
  const direct = path.match(DIRECT_UPLOAD);
  if (direct && (method === "POST" || method === "PUT") && decoded(direct[1]!) === FILES) {
    const place = placeOf(direct[2]!, true);
    return place && { ...place, user: signedInUser(request, secret), bytes: sizeOf(request.headers.get("content-length")) };
  }
  return null;
}

/** What Storage-style clients get for an upload a limit refuses. */
export function storageFull(message: string): Response {
  return Response.json({ statusCode: String(STORAGE_FULL.status), error: STORAGE_FULL.error, message }, { status: STORAGE_FULL.status });
}

/**
 * The gateway's part, for a request that may store a file (gateway.ts's storesFile): refuses an
 * upload a limit doesn't allow with 507, and sends the rest on. An upload Storage doesn't take
 * comes off the numbers again. `secret`: the instance's JWT_SECRET, which checks who's uploading.
 */
export async function guardStorage(source: SnapshotSource, secret: string | null | undefined, request: Request, send: (request: Request) => Promise<Response>): Promise<Response> {
  const piece = arrivingAt(request);
  if (piece) {
    // A resumable upload's piece: once the last one is in, the file is stored, so the next reading
    // has it and it stops counting here (counting it in both would refuse a file that fits).
    const res = await send(request);
    if (res.ok && Number(res.headers.get("upload-offset")) >= piece.bytes) {
      arriving.delete(piece.key);
      piece.stored();
    }
    return res;
  }
  const upload = uploadOf(request, secret);
  if (!upload?.user) return send(request);
  const rule = storageFolderRule(upload.folder);
  // One that doesn't say its size could be any size (a resumable upload's pieces aren't checked
  // again, and a form can be sent without a length), so where a limit applies a signed-in person
  // says it. Crewtavo's own uploads always do.
  if (upload.bytes === null && (rule.company || rule.person)) {
    const message = upload.resumable ? "Send the file's size (Upload-Length) when the upload starts." : "Send the file's size (Content-Length) with the upload.";
    return Response.json({ statusCode: "411", error: "Length Required", message }, { status: 411 });
  }
  const verdict = await reserveStorage(source, upload);
  if (!verdict.ok) return storageFull(verdict.message);
  const res = await send(request);
  if (!res.ok) verdict.release();
  // A file sent whole is stored once Storage answers; a resumable one arrives later, in pieces
  // (sent to the address Storage gives back), unless it came whole with the request that made it.
  else if (!upload.resumable || Number(res.headers.get("upload-offset")) >= (upload.bytes ?? 0)) verdict.stored();
  else rememberArriving(res.headers.get("location"), upload.bytes ?? 0, verdict.stored);
  return res;
}

/** Resumable uploads let through whose pieces are still arriving, by their address's path. */
const arriving = new Map<string, { bytes: number; at: number; stored: () => void }>();

function rememberArriving(location: string | null, bytes: number, stored: () => void) {
  if (!location) return;
  let key: string | null;
  try {
    key = routedPath(new URL(location, "http://storage").pathname);
  } catch {
    return;
  }
  if (!key) return;
  // Kept no longer than its count is (CACHE_MS): past that it no longer counts anyway.
  const now = Date.now();
  for (const [k, v] of arriving) if (now - v.at >= CACHE_MS) arriving.delete(k);
  arriving.set(key, { bytes, at: now, stored });
}

/** The resumable upload a PATCH sends a piece of, when it's one let through and still arriving. */
function arrivingAt(request: Request): ({ key: string } & { bytes: number; stored: () => void }) | null {
  if (request.method.toUpperCase() !== "PATCH" || !arriving.size) return null;
  const key = routedPath(new URL(request.url).pathname);
  const piece = key ? arriving.get(key) : undefined;
  return key && piece ? { key, ...piece } : null;
}
