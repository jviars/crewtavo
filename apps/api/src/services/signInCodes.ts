/**
 * Signing in with a code, for a sub on a new phone (docs/subcontractors-plan.md §7, phases E and E2;
 * supabase/migrations/20261025005001_sign_in_codes.sql and 20261025006001_email_sign_in_codes.sql; the
 * routes are in routes/signInCodes.ts). The sign-in page asks for their phone number and texts them a
 * 6-digit code from the instance's number, or, when texting isn't there for them, asks for their email
 * address and emails one the way their company's other email goes out. The right code makes a one-time
 * sign-in link, which the browser redeems at once, as it does an emailed one (verifyOtp with its
 * token_hash, apps/web/src/lib/session.tsx). Auth's own phone sign-in stays off, and the sign-in guard
 * keeps refusing phone fields (lib/signInGuard.ts).
 *
 * Only the number or email the office keeps for a sub counts, never the one on the person's profile
 * or account, and only for a sign-in Crewtavo made for that sub, while it and the sub are on, and that
 * isn't also someone's sign-in elsewhere (public.sub_sign_ins_for_phone and _for_email; `ours` in
 * services/subAccess.ts): whoever has the code gets into the whole account. Someone who subs for two
 * businesses has a sign-in at each, often with the same number and address: one ask then gets a code
 * for each (one message per business), and the code typed in signs in to the business it was for
 * (public.sign_in_codes_save and _check, 20261025007009_sign_in_codes_for_each_sign_in.sql). Two of
 * one business's subs on the same number or address get none there, and the operator hears, without it.
 *
 * Nobody learns from any of it whether a number or address has a sign-in. Asking always gets the same
 * answer, and the code goes out after it, so how long the answer takes says nothing either. One with
 * no sign-in still gets a code row, with a code nobody has, so its tries answer as a real one's do:
 * "isn't right", then "has run out". Only the visitor who asked hears more than "isn't right", so
 * trying someone else's doesn't show that they asked for a code. Numbers, addresses and codes are kept
 * only as keyed hashes, each code tied to the account it went to; an account has one code that works
 * at a time, by either way. Texts cost money and emails cost the sender's good name, so asking is
 * limited per number or address and per visitor, and sending for the whole instance; a limit that
 * can't be counted refuses (allowStrict). Guessing is limited too: 5 wrong tries a code, 15 a day a
 * number, address or account.
 */
import { isIP } from "node:net";
import { emailKey, isSubLogin, phoneE164, SIGN_IN_CODE_DIGITS, signInCodeEmail, signInCodeText } from "@crewtavo/core";
import type { Env } from "../env";
import { keyedHash } from "../lib/crypto";
import { renderEmail } from "../lib/email";
import { dbError, HttpError } from "../lib/http";
import { allowStrict } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import { anyMailbox, emailConfigured, emailReady, sendEmail, sendSms, smsConfigured } from "../lib/notify";
import { adminClient } from "../lib/supabase";
import { logoImage } from "./logo";

/** How often, as [attempts, seconds]: asking for a code, and trying one. */
interface CodeLimits {
  /** `all` counts the codes the instance sends, not the asks: asks for one with no sign-in send nothing, so they can't use it up. */
  ask: { ip: readonly [number, number]; address: readonly [number, number]; addressDay: readonly [number, number]; all: readonly [number, number] };
  check: { ip: readonly [number, number]; address: readonly [number, number] };
}
export const TEXT_CODE_LIMITS: CodeLimits = {
  ask: { ip: [10, 3600], address: [3, 15 * 60], addressDay: [8, 86_400], all: [200, 3600] },
  check: { ip: [20, 3600], address: [10, 15 * 60] },
};
export const EMAIL_CODE_LIMITS: CodeLimits = {
  ask: { ip: [10, 3600], address: [3, 15 * 60], addressDay: [8, 86_400], all: [200, 3600] },
  check: { ip: [20, 3600], address: [10, 15 * 60] },
};

export const PHONE_PROBLEM = "Enter your phone number with the area code.";
export const EMAIL_PROBLEM = "Enter your email address, like name@example.com.";
export const CODE_WRONG = "That code isn't right. Check the text and try again.";
export const EMAIL_CODE_WRONG = "That code isn't right. Check the email and try again.";
export const CODE_EXPIRED = "That code has run out. Ask for a new one.";
export const TOO_MANY_CODES = "Too many codes asked for. Wait a while and try again, or ask the office for a sign-in link.";
export const TOO_MANY_TRIES = "Too many tries. Wait a while and try again.";
/** 15 wrong tries for a number, address or account in a day, across its codes. */
export const TOO_MANY_WRONG = "Too many wrong tries. Wait a while and try again, or ask the office for a sign-in link.";
export const NO_SIGN_IN = "Couldn't sign you in. Ask for a new code and try again.";

/** The answer to asking for a code by text: the same for every number, unless the instance can't text at all. */
export type TextCodeAnswer = { sent: true } | { sent: false; reason: "sms_off" };
/** The answer to asking for a code by email: always the same. Whether a sub's company can send email is never said. */
export type EmailCodeAnswer = { sent: true };

/** What the browser redeems to sign in: supabase.auth.verifyOtp({ token_hash, type }). */
export interface CodeSignIn {
  token_hash: string;
  type: "magiclink";
}

/** A new code: 6 digits, every one as likely as any other. */
export function newSignInCode(): string {
  const range = 10 ** SIGN_IN_CODE_DIGITS;
  // Drawn from 2^32 values; the few at the top that would favor low codes are drawn again.
  const limit = 2 ** 32 - (2 ** 32 % range);
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (n < limit) return String(n % range).padStart(SIGN_IN_CODE_DIGITS, "0");
  }
}

/** Tied to the account, so a code only ever opens the account it went to. */
export const signInCodeHash = (env: Env, userId: string, code: string) => keyedHash(env, `sign-in-code:${userId}:${code}`);
export const signInPhoneHash = (env: Env, e164: string) => keyedHash(env, `sign-in-phone:${e164}`);
/** `key` as emailKey() spells it. */
export const signInEmailHash = (env: Env, key: string) => keyedHash(env, `sign-in-email:${key}`);
const visitorHash = (env: Env, ip: string) => keyedHash(env, `sign-in-visitor:${visitorBlock(ip)}`);

/**
 * A visitor's address as limits and codes count it. An IPv6 visitor usually has a whole /64 to
 * themselves (a phone changes address within it often), so the /64 counts as one visitor; otherwise
 * anyone could get round the per-visitor limits with a new address each time.
 */
export function visitorBlock(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail] = ip.split("::");
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const all = [...front, ...Array(Math.max(8 - front.length - back.length, 0)).fill("0"), ...back];
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
/** The account a number or address with no sign-in has its code hashed for: nobody's. */
const NOBODY = "nobody";

/** A row of public.sub_sign_ins_for_phone or _for_email. */
interface SubSignIn {
  user_id: string;
  company_id: string;
  subcontractor_id: string;
  company_name: string;
}

/**
 * A way a code goes: by text to a number (E.164), or by email to an address (emailKey's spelling).
 * Codes by either way share one table and its rules; each way has its own limits and lookup.
 */
interface Way {
  channel: "text" | "email";
  /** Rate limit keys: `<limit>:ip:…`, `<limit>:<kind>:…`, `<limit>:<kind>-day:…` and `<limit>:all`; tries `<limit>-check:…`. */
  limit: "text-code" | "email-code";
  kind: "phone" | "email";
  limits: CodeLimits;
  hash: (env: Env, address: string) => Promise<string>;
  lookup: (env: Env, address: string) => PromiseLike<{ data: SubSignIn[] | null; error: { message: string } | null }>;
  /** For the operator's log. */
  name: string;
  /** "a phone number", "an email address": for the operator's log, never the thing itself. */
  thing: string;
  wrong: string;
}

const TEXT: Way = {
  channel: "text",
  limit: "text-code",
  kind: "phone",
  limits: TEXT_CODE_LIMITS,
  hash: signInPhoneHash,
  lookup: (env, e164) => adminClient(env).rpc("sub_sign_ins_for_phone", { p_phone: e164 }),
  name: "Text sign-in",
  thing: "a phone number",
  wrong: CODE_WRONG,
};
const EMAIL: Way = {
  channel: "email",
  limit: "email-code",
  kind: "email",
  limits: EMAIL_CODE_LIMITS,
  hash: signInEmailHash,
  lookup: (env, key) => adminClient(env).rpc("sub_sign_ins_for_email", { p_email: key }),
  name: "Email sign-in",
  thing: "an email address",
  wrong: EMAIL_CODE_WRONG,
};

function readPhone(phone: string): string {
  const e164 = phoneE164(phone);
  if (!e164) throw new HttpError(400, PHONE_PROBLEM);
  return e164;
}

function readEmail(email: string): string {
  const key = emailKey(email);
  if (!key) throw new HttpError(400, EMAIL_PROBLEM);
  return key;
}

/** At most this many businesses' sign-ins get a code from one ask (the database's limit too). */
const MOST_SIGN_INS = 10;

/**
 * The sub sign-ins a number or address belongs to now, one per business. Two or more of one
 * business's subs on it get none (the operator hears, without it): which of them is asking can't be
 * told, and the office's Sign-in card says codes go to neither.
 */
async function signInsFor(env: Env, way: Way, address: string): Promise<SubSignIn[]> {
  const { data, error } = await way.lookup(env, address);
  if (error) throw dbError(error);
  const byCompany = new Map<string, SubSignIn[]>();
  for (const row of data ?? []) byCompany.set(row.company_id, [...(byCompany.get(row.company_id) ?? []), row]);
  for (const rows of byCompany.values()) {
    if (rows.length > 1) {
      console.warn(
        `${way.name}: ${way.thing} is on ${rows.length} sub sign-ins at one business (subs ${rows.map((r) => r.subcontractor_id).join(", ")}), so no code was sent for them. Each sub needs ${way.kind === "phone" ? "a number" : "an email address"} of their own.`,
      );
    }
  }
  return [...byCompany.values()].filter((rows) => rows.length === 1).map((rows) => rows[0]!).slice(0, MOST_SIGN_INS);
}

/** The code typed (or made), hashed for each sign-in it could be for, or for nobody when there's none. */
const codeHashes = (env: Env, logins: readonly SubSignIn[], code: (login: SubSignIn | null) => string) =>
  Promise.all(logins.length ? logins.map((l) => signInCodeHash(env, l.user_id, code(l))) : [signInCodeHash(env, NOBODY, code(null))]);

/**
 * A new code for each sign-in the number or address belongs to (or one for nobody), kept together as
 * one ask, once the limits allow it: per visitor first, so one visitor's flood doesn't use up anyone's
 * number or address, then per number or address. Counted for every one alike, before finding out
 * whether it has a sign-in. Each business's code is different, so the code typed says which.
 */
async function newCodes(env: Env, way: Way, address: string, ip: string): Promise<Array<{ login: SubSignIn; code: string }>> {
  const addressHash = await way.hash(env, address);
  const { ip: perIp, address: perAddress, addressDay } = way.limits.ask;
  const allowed =
    (await allowStrict(env, `${way.limit}:ip:${visitorBlock(ip)}`, ...perIp)) &&
    (await allowStrict(env, `${way.limit}:${way.kind}:${addressHash}`, ...perAddress)) &&
    (await allowStrict(env, `${way.limit}:${way.kind}-day:${addressHash}`, ...addressDay));
  if (!allowed) throw new HttpError(429, TOO_MANY_CODES);

  const logins = await signInsFor(env, way, address);
  const made = new Set<string>();
  const fresh = () => {
    let code = newSignInCode();
    while (made.has(code)) code = newSignInCode();
    made.add(code);
    return code;
  };
  const codes = logins.map((login) => ({ login, code: fresh() }));
  const nobody = fresh();
  const { error } = await adminClient(env).rpc("sign_in_codes_save", {
    p_channel: way.channel,
    p_address_hash: addressHash,
    p_users: codes.map((c) => c.login.user_id),
    p_code_hashes: await codeHashes(env, logins, (login) => codes.find((c) => c.login === login)?.code ?? nobody),
    p_ip_hash: await visitorHash(env, ip),
  });
  if (error) throw dbError(error);
  return codes;
}

/** The instance's hourly limit on codes it sends, counted only for codes that would go out. Past it (or uncounted), none. */
async function withinBudget(env: Env, way: Way): Promise<boolean> {
  if (await allowStrict(env, `${way.limit}:all`, ...way.limits.ask.all)) return true;
  console.error(`${way.name}: the instance's hourly limit on code ${way.channel === "text" ? "texts" : "emails"} was reached (or couldn't be counted), so a code didn't go out.`);
  reportError(new Error(`${way.name}: hourly limit on code ${way.channel === "text" ? "texts" : "emails"} reached`), { limit: way.limit });
  return false;
}

/**
 * Text me a code (POST /api/auth/text-code): texts a code when the number belongs to a sub's sign-in,
 * and answers { sent: true } either way. The text goes out after the answer, through `later`. Only
 * when the instance can't text at all does it say so, which says nothing about anyone's number.
 */
export async function askForCode(env: Env, phone: string, ip: string, later: (work: Promise<unknown>) => void): Promise<TextCodeAnswer> {
  if (!smsConfigured(env)) return { sent: false, reason: "sms_off" };
  const e164 = readPhone(phone);
  for (const { login, code } of await newCodes(env, TEXT, e164, ip)) later(textCode(env, e164, code, login.company_name));
  return { sent: true };
}

/**
 * Texts the code, after the answer. The instance's hourly limit on texts is counted here, only for
 * texts that would go out, and never shows in the answer or how long it takes: past it, no text.
 */
async function textCode(env: Env, to: string, code: string, companyName: string) {
  if (!(await withinBudget(env, TEXT))) return;
  const sent = await sendSms(env, { to, body: signInCodeText(code, companyName) });
  // The provider's reason can repeat the number, which stays out of the log.
  if (!sent.sent) console.error(`Text sign-in: a code didn't go out. ${(sent.reason ?? "").replace(/\+?\d[\d ().-]{5,}\d/g, "(number)")}`.trim());
}

/**
 * Get a sign-in code by email (POST /api/auth/email-code): emails a code when the address is the one
 * the office keeps for a sub's sign-in, and answers { sent: true } either way, whether or not the sub's
 * company can send email (that's the company's, and says nothing here). The email goes out after the
 * answer, through `later`.
 */
export async function askForEmailCode(env: Env, baseUrl: string, email: string, ip: string, later: (work: Promise<unknown>) => void): Promise<EmailCodeAnswer> {
  const key = readEmail(email);
  for (const { login, code } of await newCodes(env, EMAIL, key, ip)) later(emailCode(env, baseUrl, key, code, login));
  return { sent: true };
}

/**
 * Emails the code, after the answer, the way the sub's company sends its other email: its own
 * mailbox, or the instance's sender. A company with neither sends nothing (the operator hears), and
 * isn't counted against the instance's hourly limit on code emails, which is counted here, only for
 * emails that would go out.
 */
async function emailCode(env: Env, baseUrl: string, to: string, code: string, login: SubSignIn) {
  if (!(await emailReady(env, login.company_id))) {
    console.warn(`Email sign-in: company ${login.company_id} has no way to send email yet (Settings → Email), so a code for sub ${login.subcontractor_id} didn't go out.`);
    return;
  }
  if (!(await withinBudget(env, EMAIL))) return;
  const admin = adminClient(env);
  const [company, sub] = await Promise.all([
    admin.from("companies").select("id, name, email, settings").eq("id", login.company_id).maybeSingle(),
    admin.from("subcontractors").select("name, contact_name").eq("id", login.subcontractor_id).maybeSingle(),
  ]);
  if (company.error || sub.error) throw dbError((company.error ?? sub.error)!);
  const companyName = company.data?.name ?? login.company_name;
  const message = signInCodeEmail({ code, companyName, name: sub.data?.contact_name || sub.data?.name });
  const sent = await sendEmail(
    env,
    {
      to,
      subject: message.subject,
      ...renderEmail({ companyName, logo: company.data ? logoImage(baseUrl, company.data.id, company.data.settings) : null, text: message.text, code }),
      replyTo: company.data?.email ?? undefined,
      fromName: companyName,
    },
    login.company_id,
  );
  // The provider's reason can repeat the address, which stays out of the log.
  if (!sent.sent) console.error(`Email sign-in: a code didn't go out. ${(sent.reason ?? "").replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, "(address)")}`.trim());
}

/**
 * The code typed in (POST /api/auth/text-code/verify). The right one, for the number's sign-in now,
 * signs in: a one-time link's token for the browser to redeem. Otherwise "isn't right", or, to the
 * visitor who asked for the code, "has run out" (10 minutes or 5 wrong tries) or "too many wrong
 * tries" (15 in a day): the same whether or not the number has a sign-in. Each wrong try counts.
 */
export async function signInWithCode(env: Env, baseUrl: string, phone: string, code: string, ip: string): Promise<CodeSignIn> {
  return tryCode(env, TEXT, baseUrl, readPhone(phone), code, ip);
}

/** The code from the email typed in (POST /api/auth/email-code/verify): as signInWithCode, for the address. */
export async function signInWithEmailCode(env: Env, baseUrl: string, email: string, code: string, ip: string): Promise<CodeSignIn> {
  return tryCode(env, EMAIL, baseUrl, readEmail(email), code, ip);
}

async function tryCode(env: Env, way: Way, baseUrl: string, address: string, code: string, ip: string): Promise<CodeSignIn> {
  const addressHash = await way.hash(env, address);
  const { ip: perIp, address: perAddress } = way.limits.check;
  const allowed =
    (await allowStrict(env, `${way.limit}-check:ip:${visitorBlock(ip)}`, ...perIp)) &&
    (await allowStrict(env, `${way.limit}-check:${way.kind}:${addressHash}`, ...perAddress));
  if (!allowed) throw new HttpError(429, TOO_MANY_TRIES);

  // Whose number or address it is now: a sub or sign-in turned off since the code went out doesn't
  // sign in. The code is tried as each of their codes, and signs in to the one it was made for.
  const logins = await signInsFor(env, way, address);
  const digits = code.replace(/\D/g, "");
  const { data, error } = await adminClient(env).rpc("sign_in_codes_check", {
    p_channel: way.channel,
    p_address_hash: addressHash,
    p_users: logins.map((l) => l.user_id),
    p_code_hashes: await codeHashes(env, logins, () => digits),
    p_ip_hash: await visitorHash(env, ip),
  });
  if (error) throw dbError(error);
  const answer = (data ?? [])[0];
  // A code used up by 5 wrong tries needs replacing just as one past its 10 minutes does.
  if (answer?.result === "expired" || answer?.result === "dead") throw new HttpError(400, CODE_EXPIRED);
  if (answer?.result === "locked") throw new HttpError(429, TOO_MANY_WRONG);
  const login = logins.find((l) => l.user_id === answer?.user_id);
  if (answer?.result !== "ok" || !login) throw new HttpError(400, way.wrong);
  return signInLink(env, way, baseUrl, login);
}

/** A one-time sign-in link for the account (as services/subAccess.ts makes them), its placeholder email included. */
async function signInLink(env: Env, way: Way, baseUrl: string, login: SubSignIn): Promise<CodeSignIn> {
  const admin = adminClient(env);
  const { data: account, error: lookup } = await admin.auth.admin.getUserById(login.user_id);
  if (lookup || !account.user?.email) {
    console.error(`${way.name}: couldn't look up the account for a right code`, lookup);
    throw new HttpError(500, NO_SIGN_IN);
  }
  // The database went by the same mark; this is the account's own copy of it.
  if (!isSubLogin(account.user.app_metadata, login.company_id, login.subcontractor_id)) {
    console.error(`${way.name}: a right code was for an account that isn't sub ${login.subcontractor_id}'s sign-in, so it didn't sign in.`);
    throw new HttpError(400, way.wrong);
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: account.user.email, options: { redirectTo: `${baseUrl}/` } });
  if (error || !data.properties?.hashed_token) {
    console.error(`${way.name}: couldn't make the sign-in link`, error);
    throw new HttpError(500, NO_SIGN_IN);
  }
  return { token_hash: data.properties.hashed_token, type: "magiclink" };
}

/**
 * Whether the sign-in page offers codes by email (GET /api/config, features.emailCodes): when this
 * Crewtavo can send email at all, through its own sender or at least one company's own mailbox. It's
 * the same for everyone: whether a particular sub's company can send is never said, and asking answers
 * the same either way. When it can't be told, it's offered.
 */
export async function emailCodesOffered(env: Env): Promise<boolean> {
  return emailConfigured(env) || ((await anyMailbox(env)) ?? true);
}
