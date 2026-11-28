/**
 * Which Twilio account a company's texts go through, and Twilio's REST calls.
 *
 *   1. The company's own account, connected on the Apps page (Apps → Twilio): its Account SID and
 *      sending number in integrations.settings (provider "twilio"), its Auth Token AES-encrypted in
 *      integration_secrets, as a company's own mailbox or Stripe key is kept.
 *   2. Else the server's (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER), if whoever
 *      installed it set one: every company without its own shares that number, as before.
 *
 * Texts that come in are signed by Twilio with the Auth Token of the account the number is in, so
 * the webhook first works out whose account a request names (inboundAccounts) and checks the
 * signature with that account's token (routes/messages.ts).
 */
import { internationalPhone, phoneE164, phoneExample } from "@crewtavo/core/phone";
import { phoneMatchKey } from "@crewtavo/core/recipients";
import { serviceUrl, type Env } from "../env";
import { decryptJson } from "./crypto";
import { reportError } from "./monitoring";
import { adminClient, type Db } from "./supabase";

/** Non-secret, in integrations.settings. */
export interface TwilioSettings {
  /** The sending number, in E.164. */
  from_number: string;
  /** Twilio's id for that number (PN...), for pointing its incoming texts here. */
  phone_sid?: string | null;
  /** Where Twilio sends that number's incoming texts, as last read or set. */
  sms_url?: string | null;
}

/** What integration_secrets holds for it (an integrations/tokens.ts StoredSecret). */
interface TwilioSecret {
  api_key?: string;
  extra?: { account_sid?: string };
}

export interface TwilioAccount {
  sid: string;
  token: string;
  from: string;
  /** The company's own account, not the server's. */
  own: boolean;
  /** integrations.status for the company's own: "connected", or "error" once Twilio refused it. */
  status?: string;
}

const api = (env: Pick<Env, "LOOKALYKE_URL">) => `${serviceUrl(env, "twilio", "https://api.twilio.com")}/2010-04-01`;
const CACHE_MS = 60_000;
/** Twilio not answering in time counts as unreachable. */
const TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

const cache = new Map<string, { at: number; value: TwilioAccount | null }>();
/** Whether any company has its own account (anyTwilio), cached alongside. */
let some: { at: number; value: boolean } | null = null;

export const forgetTwilio = (companyId?: string) => {
  if (companyId) {
    cache.delete(companyId);
    countries.delete(companyId);
  } else {
    cache.clear();
    countries.clear();
  }
  some = null;
};

/** The server's own account, when all three variables are set. */
export function serverTwilio(env: Env): TwilioAccount | null {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = env;
  return sid && token && from ? { sid, token, from, own: false } : null;
}

/** The company's own connected account, if any (cached for a minute; reminders send many at once). */
export async function companyTwilio(env: Env, companyId: string): Promise<TwilioAccount | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const admin = adminClient(env);
  const [row, secret] = await Promise.all([
    admin.from("integrations").select("status, external_account_id, settings").eq("company_id", companyId).eq("provider", "twilio").maybeSingle(),
    admin.from("integration_secrets").select("ciphertext").eq("company_id", companyId).eq("provider", "twilio").maybeSingle(),
  ]);
  let value: TwilioAccount | null = null;
  if (row.data && row.data.status !== "disconnected" && secret.data) {
    try {
      const kept = await decryptJson<TwilioSecret>(env, secret.data.ciphertext);
      const sid = row.data.external_account_id ?? kept.extra?.account_sid ?? "";
      const from = (row.data.settings as unknown as TwilioSettings | null)?.from_number ?? "";
      if (sid && kept.api_key && from) value = { sid, token: kept.api_key, from, own: true, status: row.data.status };
    } catch (error) {
      reportError(error, { feature: "twilio" });
    }
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

/** Each company's country (companies.country), cached alongside its account. */
const countries = new Map<string, { at: number; value: string | null }>();

/**
 * The country whose numbers a company's texts are completed for (companies.country, core
 * internationalPhone), cached for a minute as its account is. Null when it can't be read.
 */
export async function textingCountry(env: Env, companyId: string): Promise<string | null> {
  const hit = countries.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { data, error } = await adminClient(env).from("companies").select("country").eq("id", companyId).maybeSingle();
  if (error) return null;
  const value = data?.country ?? null;
  countries.set(companyId, { at: Date.now(), value });
  return value;
}

/** The account a company's texts go through: its own, else the server's. Null when there's neither. */
export async function twilioFor(env: Env, companyId?: string | null): Promise<TwilioAccount | null> {
  const own = companyId ? await companyTwilio(env, companyId).catch(() => null) : null;
  return own ?? serverTwilio(env);
}

/**
 * Whether any company here texts from its own account (cached for a minute), for what the sign-in
 * page offers before anyone is known (GET /api/config). Null when it can't be told.
 */
export async function anyTwilio(env: Env): Promise<boolean | null> {
  if (some && Date.now() - some.at < CACHE_MS) return some.value;
  // An account connected here has its Account SID; a key saved before accounts could be never sent anything.
  const { data, error } = await adminClient(env).from("integrations").select("company_id, external_account_id").eq("provider", "twilio").neq("status", "disconnected").limit(50);
  if (error) {
    reportError(new Error(`Couldn't tell whether any company has its own Twilio account: ${error.message}`), { feature: "twilio" });
    return null;
  }
  some = { at: Date.now(), value: Boolean(data?.some((row) => row.external_account_id)) };
  return some.value;
}

const auth = (sid: string, token: string) => ({ Authorization: `Basic ${btoa(`${sid}:${token}`)}` });

/**
 * Where Twilio reports what became of a company's text once it has taken it (its StatusCallback,
 * routes/messages.ts): delivered, or not and why. Null when Twilio couldn't reach it: it only
 * calls a public https address (in development, a stand-in for Twilio on this machine calls any).
 */
export function twilioStatusUrl(env: Pick<Env, "APP_URL" | "LOOKALYKE_URL">, companyId: string): string | null {
  const base = (env.APP_URL ?? "").replace(/\/$/, "");
  const reachable = /^https:\/\//.test(base) && !/^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(base);
  return base && (reachable || env.LOOKALYKE_URL) ? `${base}/api/webhooks/twilio/status/${companyId}` : null;
}

/** One text through an account: Twilio's answer. Throws, as fetch does, when Twilio couldn't be reached or didn't answer in time. */
export function postMessage(env: Pick<Env, "LOOKALYKE_URL">, account: Pick<TwilioAccount, "sid" | "token" | "from">, message: { to: string; body: string; statusCallback?: string | null }): Promise<Response> {
  return fetch(`${api(env)}/Accounts/${account.sid}/Messages.json`, {
    method: "POST",
    headers: { ...auth(account.sid, account.token), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: message.to, From: account.from, Body: message.body, ...(message.statusCallback ? { StatusCallback: message.statusCallback } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export interface TwilioCheck {
  /** The account's name in Twilio. */
  name: string;
  /** The sending number in E.164, and Twilio's id for it. */
  from_number: string;
  phone_sid: string;
  /** Where the number's incoming texts go now ("" when nowhere). */
  sms_url: string;
  /** A trial account only texts numbers verified in Twilio. */
  trial: boolean;
}

/** Why credentials can't be used, in words for the person connecting them. */
export class TwilioProblem extends Error {}

const SID = /^AC[0-9a-fA-F]{32}$/;

/**
 * Checks an Account SID, Auth Token and sending number with Twilio before they're saved: the
 * account is read (free, and it only answers the right token), then the number is looked up in it.
 * Throws a TwilioProblem that says what to fix. `country` is the company's (companies.country): a
 * number typed as it's written there ("07700 900123" in the UK) is completed with its country code.
 */
export async function checkTwilio(env: Pick<Env, "LOOKALYKE_URL">, input: { account_sid: string; auth_token: string; from_number: string; country?: string | null }, fetcher: FetchLike = fetch): Promise<TwilioCheck> {
  const sid = input.account_sid.trim();
  const token = input.auth_token.trim();
  if (!SID.test(sid)) throw new TwilioProblem("That doesn't look like an Account SID. It starts with AC and is 34 characters long, on your Twilio console's first page.");
  const from = phoneE164(internationalPhone(input.from_number, input.country));
  if (!from) throw new TwilioProblem(`Enter your Twilio number in full, with its area code, like ${phoneExample(input.country) ?? "(540) 555-0100"}.`);
  const read = async (path: string) => {
    const res = await fetcher(`${api(env)}/Accounts/${sid}${path}`, { headers: auth(sid, token), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!res) throw new TwilioProblem("Couldn't reach Twilio to check these. Try again in a minute.");
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new TwilioProblem("Twilio didn't accept that Account SID and Auth Token. Copy both again from your Twilio console's first page (click the eye to show the token).");
    }
    if (!res.ok) throw new TwilioProblem(`Twilio couldn't check these right now (error ${res.status}). Try again in a minute.`);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  };
  const account = await read(".json");
  if (account.status === "suspended" || account.status === "closed") throw new TwilioProblem(`This Twilio account is ${account.status}, so it can't send texts. Check it in Twilio, or ask Twilio's support why.`);
  const numbers = await read(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`);
  const number = (Array.isArray(numbers.incoming_phone_numbers) ? numbers.incoming_phone_numbers : [])[0] as { sid?: string; sms_url?: string; capabilities?: { sms?: boolean } } | undefined;
  if (!number?.sid) throw new TwilioProblem(`${input.from_number.trim()} isn't a number in this Twilio account. Copy it from Phone Numbers → Active numbers in Twilio.`);
  if (number.capabilities?.sms === false) throw new TwilioProblem("That Twilio number can't send texts. Pick one with SMS in Phone Numbers → Active numbers, or buy one that has it.");
  return { name: typeof account.friendly_name === "string" ? account.friendly_name : "Twilio account", from_number: from, phone_sid: number.sid, sms_url: number.sms_url ?? "", trial: account.type === "Trial" };
}

/** Points the number's incoming texts at `url` (the number's "A message comes in" webhook, HTTP POST). */
export async function setSmsWebhook(env: Pick<Env, "LOOKALYKE_URL">, account: Pick<TwilioAccount, "sid" | "token">, phoneSid: string, url: string, fetcher: FetchLike = fetch): Promise<void> {
  const res = await fetcher(`${api(env)}/Accounts/${account.sid}/IncomingPhoneNumbers/${phoneSid}.json`, {
    method: "POST",
    headers: { ...auth(account.sid, account.token), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ SmsUrl: url, SmsMethod: "POST" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new TwilioProblem("Couldn't reach Twilio to set that. Try again in a minute.");
  if (res.status === 401 || res.status === 403) throw new TwilioProblem("Twilio didn't accept the Auth Token anymore. Connect your Twilio account again, then try this.");
  if (!res.ok) throw new TwilioProblem(`Twilio couldn't change the number's settings (error ${res.status}). Set it yourself in Twilio, with the address above.`);
}

/** An account whose token may have signed a request, and the companies its texts are for (null: the server's, shared). */
export interface InboundAccount {
  token: string;
  companies: string[] | null;
}

/**
 * The accounts an incoming request could be from, by what it says about itself: companies' own
 * accounts with its AccountSid whose number is the one texted (To), then the server's. The caller
 * checks Twilio's signature against each token; only the one that signed it says whose text it is.
 * A request that names no account or number matches nobody's own.
 */
export async function inboundAccounts(env: Env, admin: Db, form: { AccountSid?: string; To?: string }): Promise<InboundAccount[]> {
  const accounts: InboundAccount[] = [];
  const sid = (form.AccountSid ?? "").trim();
  const to = phoneMatchKey(form.To);
  if (SID.test(sid) && to) {
    const { data, error } = await admin.from("integrations").select("company_id, settings").eq("provider", "twilio").eq("external_account_id", sid).neq("status", "disconnected").limit(50);
    if (error) throw new Error(`Couldn't read which company a text is for: ${error.message}`);
    for (const row of data ?? []) {
      if (phoneMatchKey((row.settings as unknown as TwilioSettings | null)?.from_number) !== to) continue;
      const own = await companyTwilio(env, row.company_id).catch(() => null);
      if (!own || own.sid !== sid) continue;
      // Two companies on one account and number (one business, two books) get the text together.
      const same = accounts.find((a) => a.token === own.token);
      if (same) same.companies!.push(row.company_id);
      else accounts.push({ token: own.token, companies: [row.company_id] });
    }
  }
  // The server's number, as before: whether it's this one's request is for its signature to say.
  if (env.TWILIO_AUTH_TOKEN) accounts.push({ token: env.TWILIO_AUTH_TOKEN, companies: null });
  return accounts;
}
