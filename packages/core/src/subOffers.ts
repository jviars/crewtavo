/**
 * Job offers to subs (docs/subcontractors-plan.md, phase D): the office sends a sub their price on a
 * job, and the sub takes it or turns it down in the field app. The rules live in Postgres
 * (supabase/migrations/20261025004001_sub_offers.sql); these are their words, so the screens say
 * what the database says: the offer's one line, what's wrong with a sub's insurance (it only warns),
 * the time to answer by, and why an answer didn't go through.
 */
import { isSquareUnit } from "./jobPay";
import type { PaperworkStatus } from "./subs";

/** How an offer ended. A new price for agreed work that isn't taken leaves the pay agreed at the old one. */
export const OFFER_OUTCOMES = [
  { key: "accepted", office: "Accepted", sub: "Accepted" },
  { key: "declined", office: "Declined", sub: "Declined" },
  { key: "expired", office: "No answer in time", sub: "Ran out" },
  { key: "withdrawn", office: "Withdrawn", sub: "Withdrawn by the office" },
] as const;
export type OfferOutcome = (typeof OFFER_OUTCOMES)[number]["key"];
export const offerOutcomeLabel = (outcome: string | null | undefined, who: "office" | "sub" = "office") =>
  OFFER_OUTCOMES.find((o) => o.key === outcome)?.[who] ?? "";

/** A new price for agreed pay, waiting for an answer: offered, with the agreed price kept. */
export const isChangeOffer = (pay: { status: string; accepted_snapshot?: unknown }) => pay.status === "offered" && pay.accepted_snapshot != null;

/** The most days ahead an offer can be answered by. Mirrors private.sub_offer_checks(). */
export const RESPOND_BY_MAX_DAYS = 90;

/** What's wrong with a time to answer by, or null: still to come, and at most 90 days off. Mirrors private.sub_offer_checks(). */
export function respondByProblem(respondBy: string | Date | null | undefined, now: Date = new Date()): string | null {
  if (respondBy == null || respondBy === "") return null;
  const at = respondBy instanceof Date ? respondBy.getTime() : Date.parse(respondBy);
  if (!Number.isFinite(at)) return "Pick a time to answer by.";
  if (at <= now.getTime()) return "Pick a time to answer by that's still to come.";
  if (at > now.getTime() + RESPOND_BY_MAX_DAYS * 86_400_000) return `Give them at most ${RESPOND_BY_MAX_DAYS} days to answer.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The offer in one line
// ---------------------------------------------------------------------------------------------

/** "$2,040", "$2,040.50": cents only when there are some. Mirrors private.money_short(). */
export function moneyShort(amount: number | string | null | undefined): string {
  const n = Number(amount ?? 0) || 0;
  const cents = Math.round(n * 100);
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
}

/** "24 squares", "1 day", "120 lf", "2 ea": a quantity as a note reads it. Mirrors private.amount_words(). */
export function amountWords(quantity: number | string, unit: string | null | undefined): string {
  const n = Number(quantity);
  const u = (unit ?? "").trim();
  const words = isSquareUnit(u) ? (n === 1 ? "square" : "squares") : u.toLowerCase() === "day" ? (n === 1 ? "day" : "days") : u || "ea";
  return `${String(n)} ${words}`;
}

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** "Tue Nov 3" for a YYYY-MM-DD date (as Postgres's to_char 'Dy Mon FMDD'). */
export function offerDate(date: string): string {
  const at = Date.parse(`${date.slice(0, 10)}T12:00:00Z`);
  return `${DAY.format(at)} ${MONTH_DAY.format(at)}`;
}

/** "Tue Nov 3", or "Tue Nov 3 to Thu Nov 5" for the first and last of several days; null for none. */
export function offerDays(dates: ReadonlyArray<string | null | undefined>): string | null {
  const days = [...new Set(dates.filter((d): d is string => Boolean(d)).map((d) => d.slice(0, 10)))].sort();
  if (!days.length) return null;
  return days.length === 1 ? offerDate(days[0]!) : `${offerDate(days[0]!)} to ${offerDate(days[days.length - 1]!)}`;
}

export interface OfferLineInput {
  /** The job's title. */
  title: string;
  /** The dates of the visits it covers (cancelled ones left out). */
  dates: ReadonlyArray<string | null | undefined>;
  /** Its lines, in their order. */
  lines: ReadonlyArray<{ basis: string; unit: string | null; quantity: number | string; amount: number | string }>;
  total: number | string;
}

/**
 * "Smith roof, Tue Nov 3, 24 squares, $2,040": the job, its days, the quantity of the per-unit line
 * that comes to the most, and the total. Mirrors private.sub_offer_line().
 */
export function offerLine(o: OfferLineInput): string {
  const perUnit = o.lines
    .map((l, i) => ({ ...l, i }))
    .filter((l) => l.basis === "per_unit" && Number(l.quantity) > 0)
    .sort((a, b) => Number(b.amount) - Number(a.amount) || a.i - b.i)[0];
  return [o.title, offerDays(o.dates), perUnit ? amountWords(perUnit.quantity, perUnit.unit) : null, moneyShort(o.total)].filter(Boolean).join(", ");
}

/**
 * "Mon Nov 2, 5:00 PM": a moment in the company's time zone, as an offer's time to answer by reads.
 * Mirrors private.local_time_words().
 */
export function offerTimeWords(at: string | Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone })
      .formatToParts(at instanceof Date ? at : new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}`;
}

/** The time to answer by, if there is one: when the offer runs out, and the company's time zone. */
export interface AnswerBy { respondBy: string | null | undefined; timeZone: string }
const answerByWords = (by: AnswerBy | null | undefined) => (by?.respondBy ? ` Answer by ${offerTimeWords(by.respondBy, by.timeZone)}.` : "");

/** What the sub's sign-ins get (and their text says) when an offer goes out, with the time to answer by. */
export const offerText = (o: OfferLineInput, by?: AnswerBy | null) => `${offerLine(o)}.${answerByWords(by)} Open Crewtavo to accept or decline.`;

/** What they get for a new price on agreed work. */
export const changeText = (o: { title: string; total: number | string; agreed: number | string }, by?: AnswerBy | null) =>
  `New price for ${o.title}: ${moneyShort(o.total)} (was ${moneyShort(o.agreed)}).${answerByWords(by)} Open Crewtavo to accept or decline.`;

// ---------------------------------------------------------------------------------------------
// What's wrong with a sub's insurance (it only warns)
// ---------------------------------------------------------------------------------------------

export const INSURANCE_PROBLEMS = ["missing", "expired", "ends_before_work", "unverified"] as const;
export type InsuranceProblem = (typeof INSURANCE_PROBLEMS)[number];

/** One entry of job_pay.insurance_warning. */
export interface InsuranceWarningItem {
  requirement: "liability" | "workers_comp";
  problem: InsuranceProblem;
  /** The document that counts (null when missing): liability, workers_comp or wc_exemption. */
  kind: string | null;
  document_id: string | null;
  expires_on: string | null;
  /** The last day of work the pay covers (null when it covers no dated visit). */
  work_until: string | null;
  /** The sub has sent a newer one that's waiting to be checked. */
  waiting: boolean;
}

/**
 * What's wrong with a sub's liability insurance and workers' comp for work through `workUntil`, from
 * their paperwork status (public.sub_paperwork): missing, run out, ending before the last day of
 * work, or sent by them and not checked yet, the first that applies. What the office is warned about
 * before it sends an offer, and what the offer records. Mirrors private.sub_offer_insurance().
 */
export function insuranceWarning(
  statuses: ReadonlyArray<Pick<PaperworkStatus, "requirement" | "state" | "kind" | "document_id" | "expires_on" | "verified" | "waiting">>,
  workUntil: string | null | undefined,
): InsuranceWarningItem[] {
  const out: InsuranceWarningItem[] = [];
  for (const requirement of ["liability", "workers_comp"] as const) {
    const s = statuses.find((x) => x.requirement === requirement);
    if (!s) continue;
    const problem: InsuranceProblem | null =
      s.state === "missing" ? "missing"
      : s.state === "expired" ? "expired"
      : s.expires_on && workUntil && s.expires_on < workUntil ? "ends_before_work"
      : s.verified === false ? "unverified"
      : null;
    if (problem) out.push({ requirement, problem, kind: s.kind, document_id: s.document_id, expires_on: s.expires_on, work_until: workUntil ?? null, waiting: Boolean(s.waiting) });
  }
  return out;
}

/** job_pay.insurance_warning as stored (null when nothing was wrong), as a list. */
export function insuranceWarningItems(value: unknown): InsuranceWarningItem[] {
  return Array.isArray(value)
    ? value.filter((i): i is InsuranceWarningItem => Boolean(i) && typeof i === "object" && (INSURANCE_PROBLEMS as readonly string[]).includes((i as { problem?: string }).problem ?? ""))
    : [];
}

/** "workers' comp certificate", as a sentence reads a kind. Mirrors private.sub_document_words(). */
function documentWords(kind: string | null | undefined): string {
  switch (kind) {
    case "w9":
      return "W-9";
    case "liability":
      return "liability insurance";
    case "workers_comp":
      return "workers' comp certificate";
    case "wc_exemption":
      return "workers' comp exemption";
    case "license":
      return "license";
    default:
      return "document";
  }
}

const shortDate = (date: string | null) => (date ? MONTH_DAY.format(Date.parse(`${date.slice(0, 10)}T12:00:00Z`)) : "");

/**
 * The warning in words. For the sub: "Your workers' comp certificate on file ends before this job."
 * (mirrors private.sub_offer_warning_words()). For the office: "Their workers' comp certificate ends
 * Nov 1, before the last day of work (Nov 5)."
 */
export function insuranceWarningText(item: InsuranceWarningItem, who: "office" | "sub"): string {
  const doc = documentWords(item.kind);
  const missing = item.requirement === "liability" ? "liability insurance" : "workers' comp certificate or exemption";
  if (who === "sub") {
    const words =
      item.problem === "missing" ? `We don't have your ${missing} on file.`
      : item.problem === "expired" ? `Your ${doc} on file has run out.`
      : item.problem === "ends_before_work" ? `Your ${doc} on file ends before this job.`
      : `We haven't checked the ${doc} you sent yet.`;
    return item.waiting && item.problem !== "unverified" ? `${words} We'll check the new one you sent.` : words;
  }
  const words =
    item.problem === "missing" ? `No ${missing} on file.`
    : item.problem === "expired" ? `Their ${doc} ran out${item.expires_on ? ` ${shortDate(item.expires_on)}` : ""}.`
    : item.problem === "ends_before_work" ? `Their ${doc} ends ${shortDate(item.expires_on)}, before the last day of work (${shortDate(item.work_until)}).`
    : `The ${doc} they sent hasn't been checked yet.`;
  return item.waiting && item.problem !== "unverified" ? `${words} They've sent a new one to check.` : words;
}

// ---------------------------------------------------------------------------------------------
// The sub's offers, and answering one
// ---------------------------------------------------------------------------------------------

/** A line of an offer, as public.my_sub_offers() gives it (the sub's own price). */
export interface SubOfferLine {
  id?: string;
  description: string;
  basis: string;
  unit: string | null;
  quantity: number;
  rate: number;
  amount: number;
}

/** A row of public.my_sub_offers(). Only the job's town: the address shows in My day once they've taken it. */
export interface SubOffer {
  id: string;
  company_id: string;
  subcontractor_id: string;
  job_id: string;
  job_title: string;
  city: string | null;
  region: string | null;
  status: string;
  /** A new price for agreed work: agreed_total and agreed_lines are what stands if it isn't taken. */
  is_change: boolean;
  /** Waiting for an answer, and not past the time to answer by. */
  can_answer: boolean;
  total: number;
  lines: SubOfferLine[];
  agreed_total: number | null;
  agreed_lines: SubOfferLine[] | null;
  /** The visits it covers (not cancelled ones): dates and times. */
  visits: Array<{ id: string; scheduled_on: string | null; starts_at: string | null; ends_at: string | null; status: string }>;
  /** The work, without prices (as job_scope()). */
  scope: Array<{ name: string; description: string | null; quantity: number; unit: string | null }>;
  notes: string | null;
  respond_by: string | null;
  offered_at: string | null;
  /** Send this back with the answer: an offer changed since isn't answered. */
  offer_round: number;
  outcome: OfferOutcome | null;
  answered_at: string | null;
  decline_reason: string | null;
  /** For an offer waiting for an answer: what's wrong with their insurance now, in their words. */
  insurance_warning: string[];
  earned_on: string | null;
  paid_at: string | null;
  paid_amount: number | null;
}

/**
 * Why an answer didn't go through (answer_sub_offer said false), from the offer as it now is (null
 * when it isn't theirs to see) and the round the sub answered. The API answers 409 with it.
 */
export function offerClosedMessage(offer: Pick<SubOffer, "status" | "outcome" | "can_answer" | "offer_round"> | null | undefined, round?: number | null): string {
  if (!offer) return "This offer isn't open any more.";
  if (offer.status === "offered") {
    if (round != null && offer.offer_round !== round) return "The office changed this offer. Have a look at it again.";
    if (!offer.can_answer) return "This offer ran out. Call the office if you'd still like the work.";
    return "This offer isn't open any more. Try again.";
  }
  switch (offer.outcome) {
    case "expired":
      return "This offer ran out. Call the office if you'd still like the work.";
    case "withdrawn":
      return "The office withdrew this offer.";
    case "accepted":
      // Each offer goes to one sub: theirs already (another tap of theirs, or the office agreed it).
      return "You've already accepted this job. It's on My day.";
    case "declined":
      return "This offer has already been declined.";
    default:
      return "This offer isn't open any more.";
  }
}
