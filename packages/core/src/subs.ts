/**
 * Subcontractors and their paperwork: the kinds of document the office keeps for a sub, the W-9's
 * tax classifications, and whether each piece of required paperwork is OK, running out, run out or
 * missing. The same rules as the public.sub_paperwork view in Postgres
 * (supabase/migrations/20261025001001_subcontractors.sql), so the web app and the API agree.
 */
import { greetingName } from "./automations";
import { isCallingCode } from "./phone";
import { addDays } from "./time";

export const SUB_DOCUMENT_KINDS = [
  { key: "w9", label: "W-9" },
  { key: "liability", label: "Liability insurance" },
  { key: "workers_comp", label: "Workers' comp certificate" },
  { key: "wc_exemption", label: "Workers' comp exemption" },
  { key: "license", label: "License" },
  { key: "other", label: "Other" },
] as const;
export type SubDocumentKind = (typeof SUB_DOCUMENT_KINDS)[number]["key"];

export const isSubDocumentKind = (value: unknown): value is SubDocumentKind => SUB_DOCUMENT_KINDS.some((k) => k.key === value);
export const subDocumentLabel = (kind: string) => SUB_DOCUMENT_KINDS.find((k) => k.key === kind)?.label ?? "Document";

/** Kinds that carry an end date. A W-9 never runs out. */
export const SUB_DOCUMENT_EXPIRES: Record<SubDocumentKind, boolean> = {
  w9: false, liability: true, workers_comp: true, wc_exemption: true, license: true, other: true,
};

/** Box 3 of the W-9. */
export const TAX_CLASSIFICATIONS = [
  { key: "individual", label: "Individual or sole proprietor" },
  { key: "c_corp", label: "C corporation" },
  { key: "s_corp", label: "S corporation" },
  { key: "partnership", label: "Partnership" },
  { key: "llc_c_corp", label: "LLC taxed as a C corporation" },
  { key: "llc_s_corp", label: "LLC taxed as an S corporation" },
  { key: "llc_partnership", label: "LLC taxed as a partnership" },
  { key: "other", label: "Other" },
] as const;
export type TaxClassification = (typeof TAX_CLASSIFICATIONS)[number]["key"];
export const taxClassificationLabel = (key: string | null | undefined) => TAX_CLASSIFICATIONS.find((t) => t.key === key)?.label ?? null;
/** Taxed as a corporation: usually no 1099 (public.sub_1099_totals flags the same ones). */
export const CORPORATE_CLASSIFICATIONS: readonly TaxClassification[] = ["c_corp", "s_corp", "llc_c_corp", "llc_s_corp"];
export const isCorporation = (key: string | null | undefined) => (CORPORATE_CLASSIFICATIONS as readonly string[]).includes(key ?? "");

/**
 * What every sub needs on file. Workers' comp is covered by a certificate or by an exemption.
 * Licenses and other documents are kept, but not required.
 */
export const PAPERWORK_REQUIREMENTS = [
  { key: "w9", label: "W-9", kinds: ["w9"] },
  { key: "liability", label: "Liability insurance", kinds: ["liability"] },
  { key: "workers_comp", label: "Workers' comp", kinds: ["workers_comp", "wc_exemption"] },
] as const satisfies ReadonlyArray<{ key: string; label: string; kinds: readonly SubDocumentKind[] }>;
export type PaperworkRequirement = (typeof PAPERWORK_REQUIREMENTS)[number]["key"];

/** A document "expiring" ends within this many days (the company's today included). */
export const PAPERWORK_WARNING_DAYS = 30;

export type PaperworkState = "ok" | "expiring" | "expired" | "missing";

/** The parts of a public.sub_documents row the status needs. */
export interface PaperworkDocument {
  id: string;
  kind: string;
  expires_on: string | null;
  verified_at: string | null;
  superseded_at: string | null;
  created_at?: string | null;
}

export interface PaperworkStatus {
  requirement: PaperworkRequirement;
  state: PaperworkState;
  /** The document that counts (null when missing). */
  document_id: string | null;
  kind: string | null;
  expires_on: string | null;
  /** Days from the company's today to the end date: 0 on the day it ends, below 0 once it has. */
  days_left: number | null;
  /** False when the one that counts was sent by the sub and not checked by the office yet. Still counts as on file. */
  verified: boolean | null;
  /** The sub sent one the office hasn't checked yet (and it hasn't run out), whichever counts. */
  waiting: boolean;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** One document's state on `today` (the company's YYYY-MM-DD). No end date counts as OK. */
export function documentState(expiresOn: string | null, today: string): Exclude<PaperworkState, "missing"> {
  if (!expiresOn) return "ok";
  if (expiresOn < today) return "expired";
  return expiresOn <= addDays(today, PAPERWORK_WARNING_DAYS) ? "expiring" : "ok";
}

/**
 * The state of each required piece of paperwork, from a sub's documents, on the company's `today`.
 * Replaced documents don't count. Of the rest, a checked one counts before one the sub sent that
 * the office hasn't checked (so an upload can't hide when the checked one ends), then the one that
 * runs longest (no end date first), then the newest. Mirrors public.sub_paperwork.
 */
export function paperworkStatus(documents: readonly PaperworkDocument[], today: string): PaperworkStatus[] {
  const current = documents.filter((d) => !d.superseded_at);
  return PAPERWORK_REQUIREMENTS.map((req) => {
    const mine = current.filter((d) => (req.kinds as readonly string[]).includes(d.kind));
    const best = [...mine].sort(
      (a, b) =>
        (b.verified_at ? 1 : 0) - (a.verified_at ? 1 : 0) ||
        (a.expires_on === null ? 0 : 1) - (b.expires_on === null ? 0 : 1) ||
        (b.expires_on ?? "").localeCompare(a.expires_on ?? "") ||
        (b.created_at ?? "").localeCompare(a.created_at ?? "") ||
        b.id.localeCompare(a.id),
    )[0];
    const waiting = mine.some((d) => !d.verified_at && (!d.expires_on || d.expires_on >= today));
    if (!best) return { requirement: req.key, state: "missing", document_id: null, kind: null, expires_on: null, days_left: null, verified: null, waiting };
    return {
      requirement: req.key,
      state: documentState(best.expires_on, today),
      document_id: best.id,
      kind: best.kind,
      expires_on: best.expires_on,
      days_left: best.expires_on ? daysBetween(today, best.expires_on) : null,
      verified: Boolean(best.verified_at),
      waiting,
    };
  });
}

const RANK: Record<PaperworkState, number> = { ok: 0, expiring: 1, missing: 2, expired: 3 };

/** The worst of a sub's paperwork, for one badge on the Subs list or the offer picker. */
export function paperworkSummary(statuses: ReadonlyArray<Pick<PaperworkStatus, "state">>): PaperworkState {
  return statuses.reduce<PaperworkState>((worst, s) => (RANK[s.state] > RANK[worst] ? s.state : worst), "ok");
}

/** Insurance that has run out or isn't on file: what the office is warned about (it never stops anything). */
export function uninsured(statuses: ReadonlyArray<Pick<PaperworkStatus, "requirement" | "state">>): PaperworkRequirement[] {
  return statuses.filter((s) => s.requirement !== "w9" && (s.state === "expired" || s.state === "missing")).map((s) => s.requirement);
}

/** "Ends in 12 days", "Ends tomorrow", "Ends today", "Ran out 3 days ago", "Missing", "On file". */
export function paperworkSummaryText(s: Pick<PaperworkStatus, "state" | "days_left">): string {
  if (s.state === "missing") return "Missing";
  if (s.days_left === null) return "On file";
  if (s.days_left < 0) return s.days_left === -1 ? "Ran out yesterday" : `Ran out ${-s.days_left} days ago`;
  if (s.days_left === 0) return "Ends today";
  if (s.days_left === 1) return "Ends tomorrow";
  return `Ends in ${s.days_left} days`;
}

/** Status pill tone for a paperwork state. */
export const paperworkTone = (state: string): "danger" | "warning" | "good" =>
  state === "expired" || state === "missing" ? "danger" : state === "expiring" ? "warning" : "good";

/** What a sub's link asks for: a required document that's missing, running out or run out. */
export interface NeededPaperwork {
  requirement: PaperworkRequirement;
  label: string;
  state: Exclude<PaperworkState, "ok">;
  expires_on: string | null;
}

/**
 * From a sub's paperwork status (public.sub_paperwork rows or paperworkStatus()): what's still
 * needed, and what the sub already sent that the office hasn't checked yet (and that hasn't run
 * out), which isn't asked for again.
 */
export function neededPaperwork(
  statuses: ReadonlyArray<{ requirement: string | null; state: string | null; expires_on: string | null; verified: boolean | null; waiting?: boolean | null }>,
): { needed: NeededPaperwork[]; waiting: PaperworkRequirement[] } {
  const needed: NeededPaperwork[] = [];
  const waiting: PaperworkRequirement[] = [];
  for (const req of PAPERWORK_REQUIREMENTS) {
    const row = statuses.find((r) => r.requirement === req.key);
    const state = (row?.state ?? "missing") as PaperworkState;
    if (row?.waiting ?? (row?.verified === false && state !== "expired")) waiting.push(req.key);
    else if (state !== "ok") needed.push({ requirement: req.key, label: req.label, state, expires_on: state === "missing" ? null : row?.expires_on ?? null });
  }
  return { needed, waiting };
}

/** "your W-9 and liability insurance": what a sub is asked for, in a sentence. */
export function askingFor(needed: ReadonlyArray<Pick<NeededPaperwork, "label">>): string {
  const names = needed.map((n) => (n.label === "W-9" ? n.label : n.label.toLowerCase()));
  if (!names.length) return "your latest paperwork";
  return `your ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;
}

/** The opening of the message that sends a sub their link, unless the office writes its own. */
export const paperworkLinkIntro = (needed: ReadonlyArray<Pick<NeededPaperwork, "label">>) =>
  `Please send us ${askingFor(needed)}. You can upload ${needed.length > 1 ? "them" : "it"} from your phone or computer here:`;

/**
 * The email and the text that send a sub their link (Office → the sub → Send upload link), so the
 * dialog shows exactly what goes out. `intro` is the office's own words, or paperworkLinkIntro().
 */
export function paperworkLinkMessages(m: { companyName: string; subName: string; contactName?: string | null; intro: string; link: string }) {
  return {
    subject: `Paperwork for ${m.companyName}`,
    text: `Hi ${greetingName(m.contactName || m.subName)},\n\n${m.intro}\n\n${m.link}\n\nThe link works for 30 days.\n\nThanks,\n${m.companyName}`,
    sms: `${m.companyName}: ${m.intro} ${m.link}`,
  };
}

/** Insurance runs a year or so; an end date further out than this is a typo. */
export const PAPERWORK_MAX_YEARS = 5;

/**
 * Why the end date a sub (or the office) gives won't do, or null. Certificates need one: without it
 * they'd read OK for good. `today` is YYYY-MM-DD (the company's on the server, the sub's own on
 * their page).
 */
export function endDateProblem(kind: string, expiresOn: string | null | undefined, today: string): string | null {
  if (!SUB_DOCUMENT_EXPIRES[kind as SubDocumentKind]) return null;
  if (!expiresOn) return kind === "liability" || kind === "workers_comp" ? "Enter the date it ends. It's on the certificate." : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return "Enter the date it ends.";
  if (expiresOn < today) return "That date has already passed. Check it, or send the newer one.";
  if (kind !== "license" && kind !== "other" && expiresOn > addDays(today, PAPERWORK_MAX_YEARS * 366)) return "Check the date it ends. It's more than five years away.";
  return null;
}

/**
 * Reminders go out 30 days before a certificate ends, 7 days before, and on the day it ends, once
 * each (sub_documents.alerted_state). Null when none is due yet. Mirrors private.sub_alert_due().
 */
export type PaperworkAlert = "d30" | "d7" | "expired";
export function paperworkAlert(daysLeft: number | null): PaperworkAlert | null {
  if (daysLeft === null) return null;
  if (daysLeft <= 0) return "expired";
  if (daysLeft <= 7) return "d7";
  return daysLeft <= 30 ? "d30" : null;
}

/**
 * The company's settings about subs (companies.settings.subs): whether reminders go to the subs
 * themselves (on unless turned off, public.set_sub_reminders), and the countries, besides the US and
 * Canada, whose numbers get sign-in codes by text, as calling codes like "44"
 * (public.set_sub_sign_in_countries; phone.ts).
 */
export interface SubSettings {
  remind_subs: boolean;
  sign_in_countries: string[];
}
export function subSettings(settings: unknown): SubSettings {
  const subs = settings && typeof settings === "object" ? (settings as { subs?: { remind_subs?: unknown; sign_in_countries?: unknown } }).subs : undefined;
  const countries = Array.isArray(subs?.sign_in_countries) ? subs.sign_in_countries.map(String).filter((code) => isCallingCode(code) && code !== "1") : [];
  return { remind_subs: subs?.remind_subs !== false, sign_in_countries: [...new Set(countries)] };
}

// ---------------------------------------------------------------------------------------------
// Signing in (phase B): a sub's own sign-in, with a link the office texts or emails them
// ---------------------------------------------------------------------------------------------

/**
 * The address every sign-in Crewtavo makes for a sub is on (signing in needs an email): one on the
 * .invalid domain, which Crewtavo never sends to (isPlaceholderEmail). The sub's real email stays on
 * the office's record, where codes, links and notices go (apps/api/src/services/subAccess.ts).
 */
export const subLoginEmail = (subId: string) => `sub-${subId.toLowerCase()}@subs.invalid`;

/**
 * The mark on an account Crewtavo made as a sub's sign-in (in its app_metadata, which only the
 * server can set): "<company id>:<sub id>". Only such an account is sent sign-in links; someone's own
 * account never is, since whoever opens a link gets into all of it.
 */
export const SUB_LOGIN_MARK = "crewtavo_sub";
export const subLoginMark = (companyId: string, subId: string) => `${companyId.toLowerCase()}:${subId.toLowerCase()}`;
/** Whether an account (its app_metadata) was made as a sub's sign-in: for that sub, or any. */
export function isSubLogin(appMetadata: unknown, companyId?: string, subId?: string): boolean {
  const mark = appMetadata && typeof appMetadata === "object" ? (appMetadata as Record<string, unknown>)[SUB_LOGIN_MARK] : undefined;
  if (typeof mark !== "string" || !mark) return false;
  return companyId && subId ? mark === subLoginMark(companyId, subId) : true;
}

/**
 * Where a sub's sign-in stands, for the office: "none" (they can't sign in), "invited" (they have
 * a sign-in and haven't used it yet) or "active" (they've signed in).
 */
export type SubAccessState = "none" | "invited" | "active";

/**
 * "Signed in Oct 12", "Hasn't signed in yet", "Can't sign in", for the sub's page; "Own sign-in" for
 * someone who signs in with an account of their own (`shared`), whose sign-ins aren't the office's
 * to see.
 */
export function subAccessText(access: { state: SubAccessState; last_sign_in_at?: string | null; shared?: boolean }, timeZone = "UTC"): string {
  if (access.state === "none") return "Can't sign in";
  if (access.shared) return "Own sign-in";
  if (access.state === "invited" || !access.last_sign_in_at) return "Hasn't signed in yet";
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(Date.parse(access.last_sign_in_at));
  return `Signed in ${day}`;
}

/**
 * The text and email that send a sub their sign-in link (Subs → the sub → Text sign-in link), so
 * the screen shows exactly what goes out. The link works once, within a day (Auth's link lifetime),
 * and a newer one stops it working. A sub signs in in their phone's browser and stays signed in
 * there: an app added to an iPhone's Home Screen keeps its own sign-in, which a link can't reach.
 */
export function signInLinkMessages(m: { companyName: string; subName: string; contactName?: string | null; link: string }) {
  return {
    subject: `Your sign-in for ${m.companyName}`,
    text: `Hi ${greetingName(m.contactName || m.subName)},\n\nHere's your link to sign in to ${m.companyName} on Crewtavo, where you'll see the jobs you're on with us and send us your paperwork:\n\n${m.link}\n\nIt works once, within a day. On your phone, open it in your browser and you'll stay signed in there.\n\nThanks,\n${m.companyName}`,
    sms: `${m.companyName}: here's your link to sign in and see your jobs with us. It works once, within a day: ${m.link}`,
  };
}

/**
 * A link that opens the office's own Messages app with the text filled in, for when Crewtavo can't
 * text (no Twilio). The "?&" form works on both iPhone and Android.
 */
export const smsLink = (phone: string, body: string) => `sms:${phone.replace(/[^0-9+]/g, "")}?&body=${encodeURIComponent(body)}`;

// ---------------------------------------------------------------------------------------------
// Signing in on a new phone (phases E and E2): a code by text, or by email
// ---------------------------------------------------------------------------------------------

/** A code for signing in, by text or by email, has this many digits, and works once, for this long, for this many tries (private.sign_in_codes). */
export const SIGN_IN_CODE_DIGITS = 6;
export const SIGN_IN_CODE_MINUTES = 10;
export const SIGN_IN_CODE_TRIES = 5;

/**
 * The text with a code for signing in (Text me a code on the sign-in page). The code comes first,
 * where the phone's notification shows it and offers to fill it in.
 */
export const signInCodeText = (code: string, companyName: string) =>
  `${code} is your sign-in code for ${companyName} on Crewtavo. It runs out in ${SIGN_IN_CODE_MINUTES} minutes. If you didn't ask for it, ignore this text.`;

/**
 * The email with a code for signing in (Get a sign-in code by email on the sign-in page, for when
 * texting isn't there for them), from the sub's company. The code is a paragraph of its own, which the
 * email shows large (renderEmail's `code` in apps/api/src/lib/email.ts).
 */
export function signInCodeEmail(m: { code: string; companyName: string; name?: string | null }) {
  return {
    subject: `Your sign-in code for ${m.companyName}`,
    text: `Hi ${greetingName(m.name)},\n\nHere's your code to sign in to ${m.companyName} on Crewtavo:\n\n${m.code}\n\nIt runs out in ${SIGN_IN_CODE_MINUTES} minutes. If you didn't ask for it, ignore this email.\n\nThanks,\n${m.companyName}`,
  };
}
