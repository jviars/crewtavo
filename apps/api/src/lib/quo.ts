/**
 * Quo (once called OpenPhone): a business's own Quo number for its texts, instead of Twilio
 * (Apps → Quo). Its API key and the number picked are kept like a Twilio account's: the number in
 * integrations.settings (provider "quo"), the key AES-encrypted in integration_secrets, with the
 * signing key of the webhook Crewtavo made in Quo for it.
 *
 * Quo's API, version 2026-03-30 (https://www.quo.com/docs/2026-03-30/introduction):
 *   - https://api.quo.com, the key bare in Authorization, and Quo-Api-Version on every request.
 *   - 10 requests a second for each key; a 429 or a 5xx is tried again after a pause.
 *   - Lists come 50 at most at a time, with `after` set to the last page's nextCursor.
 *   - Webhooks are signed the Standard Webhooks way: HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}`
 *     with the base64 key after `whsec_`, sent as space-separated `v1,<base64>` (verifyQuoWebhook).
 *
 * When a business has Quo connected, every text it sends goes through Quo (lib/notify.ts), Twilio or
 * not: one business, one texting number.
 */
import { phoneDisplay } from "@crewtavo/core/phone";
import type { Env } from "../env";
import { decryptJson } from "./crypto";
import { reportError } from "./monitoring";
import { adminClient } from "./supabase";

export const QUO_VERSION = "2026-03-30";
const QUO_API = "https://api.quo.com";
/** Quo not answering in time counts as unreachable. */
const TIMEOUT_MS = 15_000;
const CACHE_MS = 60_000;
/** How old a signed delivery may be, either way, before it's refused as a replay. */
const SIGNATURE_AGE_S = 5 * 60;

/** Where Quo's API is: Quo's own, unless the server is pointed at a stand-in for testing (QUO_API_URL). */
export const quoApi = (env: Pick<Env, "QUO_API_URL">) => (env.QUO_API_URL || QUO_API).replace(/\/+$/, "");

type FetchLike = typeof fetch;

/** The events Crewtavo's webhook in Quo listens for (calls only while calls are kept). */
export const QUO_TEXT_EVENTS = ["message.received", "message.delivered", "message.failed", "message.undelivered"] as const;
export const QUO_CALL_EVENTS = ["call.completed", "call.summary.completed", "call.voicemail.completed"] as const;

/** What's kept on the integration (integrations.settings, provider "quo"). Nothing secret. */
export interface QuoSettings {
  /** Quo's id for the number texts go from (PN...). */
  phone_number_id: string;
  /** That number, in E.164. */
  from_number: string;
  /** Its name in Quo ("Main line"). */
  number_name?: string | null;
  /** The webhook Crewtavo made in Quo, its address, and why it couldn't be made when it couldn't. */
  webhook_id?: string | null;
  webhook_url?: string | null;
  webhook_problem?: string | null;
  /** When Quo's last delivery got through (noted every few minutes at most), to show the webhook works. */
  heard_at?: string | null;
  /** Put the number's calls on clients' timelines, with Quo's summaries. On unless turned off. */
  calls?: boolean;
  /** Texts Crewtavo sends by itself (reminders, on-my-way, invoices) go to Quo's Done view, not its inbox. On unless turned off. */
  quiet?: boolean;
  /** The last bringing in of past texts and calls (services/quoImport.ts). */
  import?: QuoImportState | null;
}

export interface QuoImportState {
  status: "running" | "done" | "failed";
  /** From this day (YYYY-MM-DD), or everything Quo has. */
  since: string | null;
  started_at: string;
  finished_at?: string;
  /** When it last said how far it got: one that hasn't in a while died with its server. */
  updated_at?: string;
  error?: string;
  counts: {
    texts: number;
    calls: number;
    /** Texts and calls with a number that isn't a client's or a contact's, left in Quo. */
    skipped: number;
  };
}

/** What integration_secrets keeps for it (an integrations/tokens.ts StoredSecret). */
interface QuoSecret {
  api_key?: string;
  extra?: { webhook_key?: string };
}

export interface QuoAccount {
  companyId: string;
  key: string;
  /** The webhook's signing key (whsec_...), once Crewtavo made the webhook. */
  webhookKey: string | null;
  settings: QuoSettings;
  /** integrations.status: "connected", or "error" once Quo refused the key. */
  status: string;
}

const cache = new Map<string, { at: number; value: QuoAccount | null }>();
let some: { at: number; value: boolean } | null = null;
/** At most this many companies are remembered: a busy server has fewer, and strangers' guesses don't pile up. */
const CACHE_MAX = 2000;

/** Remembers `value` under `key`, letting the oldest go once the map is full. */
export function remember<K, V>(map: Map<K, V>, key: K, value: V, max = CACHE_MAX) {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

export const forgetQuo = (companyId?: string) => {
  if (companyId) cache.delete(companyId);
  else cache.clear();
  some = null;
};

/**
 * The company's connected Quo number, if any (cached for a minute; reminders send many at once).
 * Throws when it can't be told (the database didn't answer, or the key can't be decrypted), and
 * that isn't remembered: a business with Quo mustn't have its texts go out from another number
 * because a read failed.
 */
export async function companyQuo(env: Env, companyId: string): Promise<QuoAccount | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const admin = adminClient(env);
  const [row, secret] = await Promise.all([
    admin.from("integrations").select("status, settings").eq("company_id", companyId).eq("provider", "quo").maybeSingle(),
    admin.from("integration_secrets").select("ciphertext").eq("company_id", companyId).eq("provider", "quo").maybeSingle(),
  ]);
  if (row.error || secret.error) throw new Error(`Couldn't read the company's Quo connection: ${(row.error ?? secret.error)!.message}`);
  let value: QuoAccount | null = null;
  const settings = (row.data?.settings ?? null) as unknown as QuoSettings | null;
  if (row.data && row.data.status !== "disconnected" && secret.data && settings?.phone_number_id && settings.from_number) {
    let kept: QuoSecret;
    try {
      kept = await decryptJson<QuoSecret>(env, secret.data.ciphertext);
    } catch (error) {
      reportError(error, { feature: "quo" });
      throw new Error("The company's Quo key can't be read (was ENCRYPTION_KEY changed?).");
    }
    if (kept.api_key) value = { companyId, key: kept.api_key, webhookKey: kept.extra?.webhook_key ?? null, settings, status: row.data.status };
  }
  remember(cache, companyId, { at: Date.now(), value });
  return value;
}

/** Whether any company here texts through Quo (cached for a minute), for what the sign-in page offers. Null when it can't be told. */
export async function anyQuo(env: Env): Promise<boolean | null> {
  if (some && Date.now() - some.at < CACHE_MS) return some.value;
  const { data, error } = await adminClient(env).from("integrations").select("company_id").eq("provider", "quo").neq("status", "disconnected").limit(1);
  if (error) {
    reportError(new Error(`Couldn't tell whether any company texts through Quo: ${error.message}`), { feature: "quo" });
    return null;
  }
  some = { at: Date.now(), value: Boolean(data?.length) };
  return some.value;
}

// ---------------------------------------------------------------------------------------------
// Quo's API
// ---------------------------------------------------------------------------------------------

/** Quo turned a request down, or couldn't be reached: `status` is Quo's HTTP status (0 unreachable), `title` its error class. */
export class QuoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly title: string | null = null,
  ) {
    super(message);
  }
}

interface QuoErrorBody {
  title?: string;
  message?: string;
  trace?: string;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request to Quo. Reads, and anything Quo refused for its rate limit (it didn't act on it),
 * are tried again with a growing pause: a 429 up to three times, and a read's 5xx too. A write
 * that failed some other way isn't repeated, so a text is never sent twice.
 */
export async function quoRequest<T>(
  env: Pick<Env, "QUO_API_URL">,
  key: string,
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  fetcher: FetchLike = fetch,
): Promise<T> {
  const method = options.method ?? "GET";
  const url = new URL(`${quoApi(env)}${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== "") url.searchParams.set(name, value);
  const headers: Record<string, string> = { Authorization: key, "Quo-Api-Version": QUO_VERSION, Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    const again = attempt < 3 && (res === null ? method === "GET" : res.status === 429 || (res.status >= 500 && method === "GET"));
    if (again) {
      const wait = Number(res?.headers.get("retry-after"));
      await pause(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 5) * 1000 : 400 * 2 ** attempt + Math.random() * 200);
      continue;
    }
    if (!res) throw new QuoError("Couldn't reach Quo. Try again in a minute.", 0);
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as T & QuoErrorBody;
    if (!res.ok) throw new QuoError(json.message || `Quo answered ${res.status}.`, res.status, json.title ?? null);
    return json;
  }
}

/** A page of a Quo list. */
interface Page<T> {
  data?: T[];
  nextCursor?: string | null;
}

/** Every item of a list, page by page (50 at a time), up to `max`. */
export async function quoList<T>(env: Pick<Env, "QUO_API_URL">, key: string, path: string, query: Record<string, string | undefined> = {}, max = 500, fetcher: FetchLike = fetch): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  do {
    const page = await quoRequest<Page<T>>(env, key, path, { query: { ...query, limit: "50", after } }, fetcher);
    items.push(...(page.data ?? []));
    after = page.nextCursor ?? undefined;
  } while (after && items.length < max);
  return items.slice(0, max);
}

/** Why a key can't be used, in words for the person connecting it. */
export class QuoProblem extends Error {}

/** A number in the Quo workspace, as the Apps page lists them to pick from. */
export interface QuoNumber {
  id: string;
  /** E.164. */
  number: string;
  name: string;
}

interface QuoPhoneNumber {
  id?: string;
  name?: string | null;
  phoneNumber?: string;
  formattedNumber?: string | null;
}

/**
 * The workspace's numbers, which also checks the key: Quo answers 401 to a key it doesn't know.
 * Throws a QuoProblem that says what to fix.
 */
export async function quoNumbers(env: Pick<Env, "QUO_API_URL">, key: string, fetcher: FetchLike = fetch): Promise<QuoNumber[]> {
  const trimmed = key.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new QuoProblem("Paste the whole API key, without spaces.");
  try {
    const numbers = await quoList<QuoPhoneNumber>(env, trimmed, "/phone-numbers", {}, 200, fetcher);
    return numbers
      .filter((n): n is QuoPhoneNumber & { id: string; phoneNumber: string } => Boolean(n.id && n.phoneNumber))
      .map((n) => ({ id: n.id, number: n.phoneNumber, name: (n.name ?? "").trim() || n.formattedNumber || phoneDisplay(n.phoneNumber) }));
  } catch (error) {
    if (!(error instanceof QuoError)) throw error;
    if (error.status === 401) throw new QuoProblem("Quo didn't accept that API key. Copy it again from Quo: Workspace Settings → API.");
    if (error.status === 403) throw new QuoProblem("That key can't read your Quo numbers. Make one as a workspace owner or admin in Quo: Workspace Settings → API.");
    if (error.status === 0) throw new QuoProblem(error.message);
    throw new QuoProblem(`Quo couldn't check the key right now (error ${error.status}). Try again in a minute.`);
  }
}

/** A member of a Quo number: who a text is sent as. */
export interface QuoUser {
  id: string;
  email: string;
  name: string;
}

const usersCache = new Map<string, { at: number; value: QuoUser[] }>();

/** The people on the number (cached for ten minutes), to send a text as the person in Crewtavo who wrote it. */
export async function quoNumberUsers(env: Pick<Env, "QUO_API_URL">, account: Pick<QuoAccount, "companyId" | "key" | "settings">, fetcher: FetchLike = fetch): Promise<QuoUser[]> {
  const cacheKey = `${account.companyId}:${account.settings.phone_number_id}`;
  const hit = usersCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * CACHE_MS) return hit.value;
  const rows = await quoList<{ id?: string; email?: string; firstName?: string | null; lastName?: string | null }>(env, account.key, `/phone-numbers/${encodeURIComponent(account.settings.phone_number_id)}/users`, {}, 500, fetcher);
  const value = rows
    .filter((u): u is { id: string; email: string; firstName?: string | null; lastName?: string | null } => Boolean(u.id && u.email))
    .map((u) => ({ id: u.id, email: u.email.toLowerCase(), name: [u.firstName, u.lastName].filter(Boolean).join(" ") }));
  remember(usersCache, cacheKey, { at: Date.now(), value });
  return value;
}

/** The Quo user with this email on the number, if there is one. */
export async function quoUserFor(env: Pick<Env, "QUO_API_URL">, account: Pick<QuoAccount, "companyId" | "key" | "settings">, email: string | null | undefined): Promise<string | null> {
  const wanted = (email ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const users = await quoNumberUsers(env, account).catch(() => []);
  return users.find((u) => u.email === wanted)?.id ?? null;
}

/**
 * quo_sent's second row for a text whose sender keeps it on a timeline (a message with Quo's id,
 * SmsMessage.kept): a report on it that comes before that message is saved is worth waiting for
 * (services/quo.ts textWentOut). A text nobody keeps (a sign-in code, a notice to the team) has only
 * its own row, and its reports are let go at once. A row, because quo_sent has no column to say it
 * in, and it's only ever read by a text's exact id. Null for an id too long to mark (never Quo's).
 */
export const quoKeptMark = (messageId: string): string | null => (messageId.length <= 195 ? `${messageId} kept` : null);

/** What Quo said to a text: its id, or why it didn't take it. */
export type QuoSent = { ok: true; id: string } | { ok: false; status: number; title: string | null; message: string };

/**
 * One text from the number. `quiet` files the conversation under Done in Quo (a reminder nobody
 * needs to answer); `senderUserId` sends it as that person on the number.
 */
export async function postQuoText(
  env: Pick<Env, "QUO_API_URL">,
  account: Pick<QuoAccount, "key" | "settings">,
  message: { to: string; body: string; quiet?: boolean; senderUserId?: string | null },
  fetcher: FetchLike = fetch,
): Promise<QuoSent> {
  try {
    const sent = await quoRequest<{ data?: { id?: string } }>(
      env,
      account.key,
      "/messages",
      {
        method: "POST",
        body: {
          content: message.body,
          from: account.settings.phone_number_id,
          to: [message.to],
          ...(message.senderUserId ? { senderUserId: message.senderUserId } : {}),
          ...(message.quiet ? { inboxStatus: "done" } : {}),
        },
      },
      fetcher,
    );
    return sent?.data?.id ? { ok: true, id: sent.data.id } : { ok: false, status: 502, title: null, message: "Quo didn't say it took the text." };
  } catch (error) {
    if (error instanceof QuoError) return { ok: false, status: error.status, title: error.title, message: error.message };
    throw error;
  }
}

/** The webhook Crewtavo makes in Quo for the number: its id and signing key (whsec_...). */
export async function createQuoWebhook(
  env: Pick<Env, "QUO_API_URL">,
  key: string,
  input: { url: string; phoneNumberId: string; calls: boolean },
  fetcher: FetchLike = fetch,
): Promise<{ id: string; key: string }> {
  const made = await quoRequest<{ data?: { id?: string | number; key?: string } }>(
    env,
    key,
    "/webhooks",
    {
      method: "POST",
      body: {
        url: input.url,
        events: [...QUO_TEXT_EVENTS, ...(input.calls ? QUO_CALL_EVENTS : [])],
        resourceIds: [input.phoneNumberId],
        label: "Crewtavo",
      },
    },
    fetcher,
  );
  const id = made?.data?.id;
  if (id === undefined || id === null || !made.data?.key) throw new QuoError("Quo made the webhook but didn't return its signing key.", 502);
  return { id: String(id), key: made.data.key };
}

/**
 * Changes the webhook in Quo, keeping its signing key: its address (this Crewtavo moved), its
 * events (calls kept or not) or its number. Throws a QuoError with status 404 when it's gone.
 */
export async function updateQuoWebhook(
  env: Pick<Env, "QUO_API_URL">,
  key: string,
  id: string,
  input: { url: string; phoneNumberId: string; calls: boolean },
  fetcher: FetchLike = fetch,
): Promise<void> {
  await quoRequest(env, key, `/webhooks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { url: input.url, events: [...QUO_TEXT_EVENTS, ...(input.calls ? QUO_CALL_EVENTS : [])], resourceIds: [input.phoneNumberId], status: "enabled" },
  }, fetcher);
}

/** Asks Quo to send the webhook a sample delivery, to see that it gets through. */
export async function testQuoWebhook(env: Pick<Env, "QUO_API_URL">, key: string, id: string, fetcher: FetchLike = fetch): Promise<void> {
  await quoRequest(env, key, `/webhooks/${encodeURIComponent(id)}/events/test`, { method: "POST", body: { eventType: "message.received" } }, fetcher);
}

/** A new signing key for the webhook (Quo's rotate), when the one Crewtavo kept was lost. */
export async function rotateQuoWebhook(env: Pick<Env, "QUO_API_URL">, key: string, id: string, fetcher: FetchLike = fetch): Promise<string> {
  const rotated = await quoRequest<{ data?: { key?: string } }>(env, key, `/webhooks/${encodeURIComponent(id)}/rotate`, { method: "POST" }, fetcher);
  if (!rotated?.data?.key) throw new QuoError("Quo didn't return the webhook's new signing key.", 502);
  return rotated.data.key;
}

/** The workspace's webhooks (Quo lists them all at once): their ids and addresses. */
export async function listQuoWebhooks(env: Pick<Env, "QUO_API_URL">, key: string, fetcher: FetchLike = fetch): Promise<Array<{ id: string; url: string }>> {
  const listed = await quoRequest<{ data?: Array<{ id?: string | number; url?: string }> }>(env, key, "/webhooks", {}, fetcher);
  return (listed?.data ?? []).filter((w) => w.id !== undefined && w.url).map((w) => ({ id: String(w.id), url: w.url! }));
}

/** Takes the webhook out of Quo. One that's already gone is fine. */
export async function deleteQuoWebhook(env: Pick<Env, "QUO_API_URL">, key: string, id: string, fetcher: FetchLike = fetch): Promise<void> {
  try {
    await quoRequest(env, key, `/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }, fetcher);
  } catch (error) {
    if (error instanceof QuoError && error.status === 404) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------------------------

const base64Bytes = (value: string): Uint8Array | null => {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
};

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The signature Quo sends for a delivery: base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)). */
export async function quoSignature(secret: string, id: string, timestamp: string, body: string): Promise<string | null> {
  const raw = base64Bytes(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
  if (!raw?.length) return null;
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))));
}

/** Compared without stopping at the first difference. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether a delivery is Quo's, signed with this webhook's key, and recent: its webhook-id,
 * webhook-timestamp (within five minutes of now, either way) and one of the `v1,<base64>`
 * signatures in webhook-signature, over the body exactly as it came.
 */
export async function verifyQuoWebhook(
  secret: string,
  headers: { id: string | null | undefined; timestamp: string | null | undefined; signature: string | null | undefined },
  body: string,
  now = Date.now(),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const at = Number(timestamp);
  if (!/^[0-9]+$/.test(timestamp) || !Number.isFinite(at) || Math.abs(now / 1000 - at) > SIGNATURE_AGE_S) return false;
  const expected = await quoSignature(secret, id, timestamp, body);
  if (!expected) return false;
  return signature
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      const [version, value] = entry.split(",", 2);
      return version === "v1" && Boolean(value) && sameString(value!, expected);
    });
}
