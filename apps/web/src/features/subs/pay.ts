/**
 * How job pay reads on screen (docs/subcontractors-plan.md, phase C): rates in words, a pay's status
 * and what can be done with it next, editing its lines before they're saved, the paperwork warning
 * on the job (it only ever warns), what's owed and paid, and the year-end and workers' comp pages'
 * words. The database works the money out (packages/core/src/jobPay.ts mirrors it); nothing here
 * talks to it, so it's tested on its own (test/jobPay.test.ts).
 */
import { isLivePay, isSquareUnit, jobPayMethodLabel, jobPayStatusLabel, payLineAmount } from "@crewtavo/core/jobPay";
import { toUnits } from "@crewtavo/core/money";
import { PAPERWORK_REQUIREMENTS } from "@crewtavo/core/subs";
import type { Tone } from "@/components/ui/StatusPill";
import { addDaysIso, dateIn, formatDate, formatMoneyCents } from "@/lib/format";
import type { PaperworkRow } from "./paperwork";

// ---------------------------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------------------------

/** "$75.00", or "$0.4500" for a rate kept to 4 places (per square foot of sealcoat). */
export function formatRate(rate: number | string): string {
  const n = Number(rate);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** "per square", "per day", "per job", "each", "per lf". */
export function perUnit(unit: string | null | undefined): string {
  const u = (unit ?? "").trim();
  if (isSquareUnit(u)) return "per square";
  if (!u || ["ea", "each"].includes(u.toLowerCase())) return "each";
  return `per ${u}`;
}

/** "24 squares", "3 days", "120 lf", "1 job". */
export function quantityWords(quantity: number | string, unit: string | null | undefined): string {
  const n = Number(quantity);
  const shown = n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const u = (unit ?? "").trim();
  if (isSquareUnit(u)) return `${shown} ${n === 1 ? "square" : "squares"}`;
  if (u === "day" || u === "job") return `${shown} ${u}${n === 1 ? "" : "s"}`;
  return `${shown} ${u || "ea"}`;
}

export interface RateLike {
  basis: string;
  unit: string | null;
  rate: number | string;
  description?: string | null;
  squares_basis?: string | null;
  /** The price-list service a rate per unit counts. */
  service?: { name: string; unit?: string | null } | null;
}

/** "$75.00 per square of Architectural shingles", "$8.00 per lf of Gutters", "$400.00 per job", "$250.00 per day". */
export function rateText(r: RateLike): string {
  const money = formatRate(r.rate);
  if (r.basis === "per_job") return `${money} per job`;
  if (r.basis === "per_day") return `${money} per day`;
  const name = r.service?.name ?? "a service that's been deleted";
  const per = perUnit(r.unit ?? r.service?.unit);
  return per === "each" ? `${money} each for ${name}` : `${money} ${per} of ${name}`;
}

/** Under a rate per square: which squares it counts. Nothing for any other rate. */
export function squaresText(r: Pick<RateLike, "basis" | "unit" | "squares_basis">): string | null {
  if (r.basis !== "per_unit" || !isSquareUnit(r.unit)) return null;
  return r.squares_basis === "roof_no_waste" ? "Roof squares without waste" : "The job's squares (what the client pays for)";
}

/** A rate as typed: up to 4 places, 0 to $1,000,000. Null when it won't do. */
export function readRate(draft: string): number | null {
  return readDecimal(draft, 4, 1_000_000);
}

/** A quantity as typed: up to 3 places, 0 to 1,000,000. Null when it won't do. */
export function readQuantity(draft: string): number | null {
  return readDecimal(draft, 3, 1_000_000);
}

function readDecimal(draft: string, places: number, max: number): number | null {
  const s = draft.trim().replace(/[$,]/g, "");
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return null;
  const n = Number(toUnits(s, places)) / 10 ** places;
  return n >= 0 && n <= max ? n : null;
}

// ---------------------------------------------------------------------------------------------
// A pay and what's next for it
// ---------------------------------------------------------------------------------------------

export type Payee = "sub" | "team";
export const payeeOf = (p: { subcontractor_id?: string | null }): Payee => (p.subcontractor_id ? "sub" : "team");

export const PAY_TONES: Record<string, Tone> = {
  draft: "muted",
  offered: "info",
  accepted: "info",
  done: "warning",
  paid: "good",
  declined: "muted",
  withdrawn: "muted",
  expired: "muted",
  cancelled: "muted",
};
export const payTone = (status: string): Tone => PAY_TONES[status] ?? "muted";
export const payStatusLabel = jobPayStatusLabel;

export type PayAction = "accept" | "done" | "paid" | "unpaid" | "cancel" | "delete";

/**
 * What can be done with pay next, the main one first. A team member's is paid with their pay period
 * (Timesheets → Pay), so it's never marked paid or unpaid here. The database checks every one again.
 */
export function payActions(status: string, payee: Payee): PayAction[] {
  switch (status) {
    case "draft":
      return ["accept", "delete"];
    case "offered":
      return ["accept", "cancel"];
    case "accepted":
      return ["done", "cancel"];
    case "done":
      return payee === "sub" ? ["paid", "cancel"] : ["cancel"];
    case "paid":
      return payee === "sub" ? ["unpaid"] : [];
    default:
      return ["delete"];
  }
}

/**
 * A button's words. Agreeing a sub's pay puts their sign-ins on its visits, so it says so only when
 * `signIns` (how many they have) is known to be more than none: a sub who doesn't sign in isn't put
 * on anything.
 */
export function actionLabel(action: PayAction, payee: Payee, signIns?: number | null): string {
  switch (action) {
    case "accept":
      return payee === "sub" && (signIns ?? 0) > 0 ? "Agree and put them on the job" : "Agree to this pay";
    case "done":
      return "Mark work done";
    case "paid":
      return "Mark paid";
    case "unpaid":
      return "Take back paid";
    case "cancel":
      return "Cancel this pay";
    case "delete":
      return "Delete";
  }
}

export interface PayState {
  status: string;
  subcontractor_id?: string | null;
  earned_on: string | null;
  paid_at: string | null;
  paid_amount: number | string | null;
  method: string | null;
  reference: string | null;
  pay_period_id?: string | null;
}

/** Under the visits it covers: what they're for, by whose pay it is and whether a sub signs in (null: not known). */
export function visitsHint(payee: Payee, signIns: number | null | undefined, agreed = false): string {
  if (payee === "team" || signIns == null) return "Day rates count the days among these. Once they're all complete, the work is marked done by itself.";
  if (signIns === 0) return "They don't sign in, so they aren't put on these visits: the visits count their days and say when the work is done.";
  return agreed ? "Ticking a visit puts them on it; unticking takes them off unless it's done." : "When they take the offer, or you agree the pay, they go on these visits.";
}

/** The note when it's agreed: a sub who signs in is on the job now. */
export const agreedToast = (payee: Payee, name: string, signIns: number | null | undefined) =>
  payee === "sub" && (signIns ?? 0) > 0 ? `Agreed. ${name} is on the job.` : "Pay agreed";

/**
 * Whether to warn about a sub's paperwork on this pay: before and during the work (draft, offered or
 * agreed), for a sub who's still on (a sub who's been turned off has no paperwork status, which would
 * read as nothing on file; done pay is only waiting to be paid).
 */
export const warnsPaperwork = (status: string, subActive: boolean | null | undefined) => ["draft", "offered", "accepted"].includes(status) && subActive !== false;

/**
 * One line under the status: what it means now. `finishedOn` is the day the last visit it covers was
 * completed (the company's), which a team member's work done in a pay period they've already been
 * paid for is counted after.
 */
export function payStatusLine(p: PayState, timeZone: string, finishedOn?: string | null): string {
  const team = payeeOf(p) === "team";
  switch (p.status) {
    case "draft":
      return team ? "Not agreed yet." : "Not agreed yet. They don't see it until it is.";
    case "offered":
      return "Waiting for their answer.";
    case "accepted":
      return "Agreed. It's marked done by itself once the visits it covers are complete.";
    case "done":
      if (team && finishedOn && p.earned_on && finishedOn < p.earned_on) {
        return `Work finished ${formatDate(finishedOn)}. They'd been paid for that pay period already, so it counts from ${formatDate(p.earned_on)}, with their next one under Timesheets → Pay.`;
      }
      return team
        ? `Work done ${formatDate(p.earned_on)}. It's paid with their pay period, under Timesheets → Pay.`
        : `Work done ${formatDate(p.earned_on)}. Owed.`;
    case "paid": {
      const how = [jobPayMethodLabel(p.method), p.reference].filter(Boolean).join(" · ");
      const when = p.paid_at ? formatDate(dateIn(p.paid_at, timeZone)) : "";
      return `Paid ${formatMoneyCents(Number(p.paid_amount ?? 0))} on ${when}${how ? ` (${how})` : ""}${team ? ", with their pay period" : ""}.`;
    }
    case "cancelled":
      return "Cancelled.";
    default:
      return `${jobPayStatusLabel(p.status)}.`;
  }
}

/** The order pay is listed in on a job: live pay first (owed, agreed, drafts, paid), then what's over. */
const ORDER = ["done", "accepted", "offered", "draft", "paid", "declined", "withdrawn", "expired", "cancelled"];
export const byPayOrder = <T extends { status: string; created_at: string }>(a: T, b: T) =>
  ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.created_at.localeCompare(b.created_at);

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

export interface PayLine {
  id: string;
  description: string;
  basis: string;
  unit: string | null;
  quantity: number | string;
  rate: number | string;
  amount: number | string;
  service_id?: string | null;
  pay_rate_id: string | null;
  sort: number;
}

/** A line being typed in: its description, quantity and rate as written. */
export interface LineDraft { description: string; quantity: string; rate: string }

export const draftOf = (l: Pick<PayLine, "description" | "quantity" | "rate">): LineDraft => ({
  description: l.description,
  quantity: String(Number(l.quantity)),
  rate: String(Number(l.rate)),
});

/** What a draft line would be saved as, or why it can't be. Only what changed is in the patch. */
export function lineChange(line: Pick<PayLine, "description" | "quantity" | "rate">, draft: LineDraft):
  { patch: Partial<{ description: string; quantity: number; rate: number }>; problem: null } | { patch: null; problem: string } {
  const description = draft.description.trim();
  if (!description) return { patch: null, problem: "Say what it's for." };
  if (description.length > 200) return { patch: null, problem: "Keep the description under 200 characters." };
  const quantity = readQuantity(draft.quantity);
  if (quantity === null) return { patch: null, problem: "Enter a quantity: a number, up to 3 decimal places." };
  const rate = readRate(draft.rate);
  if (rate === null) return { patch: null, problem: "Enter a rate: a dollar amount, up to 4 decimal places." };
  const patch: Partial<{ description: string; quantity: number; rate: number }> = {};
  if (description !== line.description) patch.description = description;
  if (quantity !== Number(line.quantity)) patch.quantity = quantity;
  if (rate !== Number(line.rate)) patch.rate = rate;
  return { patch, problem: null };
}

/** A draft line's amount, as the database will work it out; null while it isn't a number. */
export function draftAmount(draft: Pick<LineDraft, "quantity" | "rate">): number | null {
  const q = readQuantity(draft.quantity);
  const r = readRate(draft.rate);
  return q === null || r === null ? null : payLineAmount(q, r);
}

/** The total of the lines, with any being typed in counted as typed. */
export function linesTotal(lines: readonly PayLine[], drafts: Readonly<Record<string, LineDraft>> = {}): number {
  const cents = lines.reduce((s, l) => {
    const typed = drafts[l.id] ? draftAmount(drafts[l.id]!) : null;
    return s + Math.round((typed ?? Number(l.amount)) * 100);
  }, 0);
  return cents / 100;
}

/** A new line at the end, for anything the rates don't cover. */
export const newLine = (lines: readonly Pick<PayLine, "sort">[]) => ({
  description: "Other work",
  basis: "per_job",
  unit: "job",
  quantity: 1,
  rate: 0,
  sort: lines.reduce((m, l) => Math.max(m, l.sort), 0) + 1,
});

export interface Suggestion {
  pay_rate_id: string | null;
  description: string;
  quantity: number | string;
  unit: string | null;
  note: string | null;
  check_it: boolean;
}

/**
 * Beside a line that came from a rate: where its quantity came from (the rate's suggestion now), and
 * what the suggestion says when the line has been changed since.
 */
export function lineNote(line: Pick<PayLine, "pay_rate_id" | "quantity" | "unit">, suggestions: readonly Suggestion[] | undefined): { text: string; check: boolean } | null {
  const s = line.pay_rate_id ? suggestions?.find((x) => x.pay_rate_id === line.pay_rate_id) : undefined;
  if (!s?.note) return null;
  const changed = Number(s.quantity) !== Number(line.quantity);
  // Changing a quantity is normal (a crew member's share of the squares), so only the database's own
  // flag reads as a warning.
  return { text: changed ? `${s.note} Suggested: ${quantityWords(s.quantity, s.unit ?? line.unit)}.` : s.note, check: s.check_it };
}

// ---------------------------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------------------------

export interface PayVisit { id: string; status: string; scheduled_on: string | null; assignees?: ReadonlyArray<{ user_id: string }> }

/**
 * The visits new pay covers to start with: the ones the database says (POST /api/job-pay/suggest's
 * visit_ids, which counts a crew's visits and a sub's sign-ins), shown among the job's visits.
 */
export const startingVisits = (visits: readonly PayVisit[], fromServer: readonly string[] | undefined) =>
  fromServer ? visits.filter((v) => fromServer.includes(v.id)).map((v) => v.id) : [];

/** The day the last of the visits it covers was completed (the company's), once none is still to do. */
export function finishedOn(visits: ReadonlyArray<PayVisit & { completed_at?: string | null }>, covered: readonly string[], timeZone: string): string | null {
  const mine = visits.filter((v) => covered.includes(v.id));
  if (!mine.length || mine.some((v) => !["completed", "cancelled"].includes(v.status))) return null;
  const days = mine.filter((v) => v.status === "completed" && v.completed_at).map((v) => dateIn(v.completed_at!, timeZone));
  return days.length ? days.sort().at(-1)! : null;
}

/** The last day of work it covers (the latest scheduled visit that isn't cancelled), for the paperwork check. */
export function lastWorkDay(visits: readonly PayVisit[], covered: readonly string[]): string | null {
  const days = visits.filter((v) => covered.includes(v.id) && v.status !== "cancelled" && v.scheduled_on).map((v) => v.scheduled_on!);
  return days.length ? days.sort().at(-1)! : null;
}

// ---------------------------------------------------------------------------------------------
// The paperwork warning on a job
// ---------------------------------------------------------------------------------------------

const REQUIREMENT_WORDS: Record<string, string> = { w9: "W-9", liability: "liability insurance", workers_comp: "workers' comp" };

/**
 * Before or while a sub works a job: anything missing, run out, or ending before their last day on
 * it, in a sentence. Only ever a warning: the office can still give them the work (the owner's
 * decision). Null when their paperwork is fine for it.
 */
export function payPaperworkWarning(statuses: ReadonlyArray<Pick<PaperworkRow, "requirement" | "state" | "expires_on">>, lastDay: string | null, today: string): string | null {
  const gaps: string[] = [];
  let insurance = false;
  for (const req of PAPERWORK_REQUIREMENTS) {
    const s = statuses.find((x) => x.requirement === req.key);
    const words = REQUIREMENT_WORDS[req.key] ?? req.label;
    const state = s?.state ?? "missing";
    const isInsurance = req.key !== "w9";
    if (state === "missing") gaps.push(req.key === "w9" ? "there's no W-9 on file (you'll need it for their 1099)" : `${words} isn't on file`);
    else if (state === "expired" || (s?.expires_on && s.expires_on < today)) gaps.push(`${words} has run out`);
    else if (isInsurance && s?.expires_on && lastDay && s.expires_on < lastDay) gaps.push(`${words} ends ${formatDate(s.expires_on)}, before their last day on this job (${formatDate(lastDay)})`);
    else continue;
    if (isInsurance) insurance = true;
  }
  if (!gaps.length) return null;
  const list = gaps.length === 1 ? gaps[0]! : `${gaps.slice(0, -1).join(", ")} and ${gaps.at(-1)}`;
  const sentence = list.startsWith("there's") ? `For this sub, ${list}.` : `Their ${list}.`;
  return insurance
    ? `${sentence} You can still give them the work, but without current certificates your insurance company may charge you for it at your audit.`
    : `${sentence} You can still give them the work.`;
}

// ---------------------------------------------------------------------------------------------
// Owed and paid
// ---------------------------------------------------------------------------------------------

export interface PaidRow { status: string; total: number | string; paid_amount: number | string | null; paid_at: string | null; method: string | null }

/** What's selected adds up to: how many and how much. */
export function owedSelection(rows: ReadonlyArray<{ id: string; total: number | string }>, selected: ReadonlySet<string>) {
  const picked = rows.filter((r) => selected.has(r.id));
  return { count: picked.length, total: Math.round(picked.reduce((s, r) => s + Number(r.total) * 100, 0)) / 100 };
}

/**
 * A sub's pay in a calendar year, by the day it was paid (the company's): everything paid, and what
 * counts toward their 1099 (card and payment-app payments are left out), and what's owed now.
 */
export function yearPaid(rows: readonly PaidRow[], year: number, timeZone: string) {
  const inYear = rows.filter((r) => r.status === "paid" && r.paid_at && dateIn(r.paid_at, timeZone).startsWith(`${year}-`));
  const cents = (list: readonly PaidRow[], f: (r: PaidRow) => number) => Math.round(list.reduce((s, r) => s + f(r) * 100, 0)) / 100;
  return {
    paid: cents(inYear, (r) => Number(r.paid_amount ?? 0)),
    for1099: cents(inYear.filter((r) => r.method !== "card_or_app"), (r) => Number(r.paid_amount ?? 0)),
    payments: inYear.length,
    owed: cents(rows.filter((r) => r.status === "done"), (r) => Number(r.total)),
  };
}

// ---------------------------------------------------------------------------------------------
// Year-end totals and the workers' comp audit
// ---------------------------------------------------------------------------------------------

/** The years to pick from: this one and the three before. */
export function yearChoices(today: string): number[] {
  const y = Number(today.slice(0, 4));
  return [y, y - 1, y - 2, y - 3];
}

/** The year the page opens on: last year in January and February, when 1099s are sent; else this one. */
export function defaultYear(today: string): number {
  const y = Number(today.slice(0, 4));
  return Number(today.slice(5, 7)) <= 2 ? y - 1 : y;
}

/** "For 2026, a 1099-NEC goes to each sub you paid $2,000 or more, unless they're a corporation." */
export function thresholdText(year: number, threshold: number): string {
  return `For ${year}, a 1099-NEC goes to each sub you paid ${threshold.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} or more, unless they're a corporation.`;
}

/** The policy periods to pick from for the audit: the last 12 months, this year and last year. */
export function auditPresets(today: string) {
  const y = Number(today.slice(0, 4));
  return [
    { key: "12m", label: "Last 12 months", from: addDaysIso(today, -364), to: today },
    { key: "this", label: String(y), from: `${y}-01-01`, to: `${y}-12-31` },
    { key: "last", label: String(y - 1), from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ] as const;
}

/** "Oct 2, Oct 3, Oct 9" for the days worked; with the year when they're not all in one. */
export function workDays(dates: readonly string[]): string {
  if (!dates.length) return "";
  const oneYear = new Set(dates.map((d) => d.slice(0, 4))).size === 1;
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: oneYear ? undefined : "numeric", timeZone: "UTC" });
  return dates.length > 6 ? `${fmt(dates[0]!)} to ${fmt(dates.at(-1)!)} (${dates.length} days)` : dates.map(fmt).join(", ");
}

export const coverageTone = (c: string): Tone => (c === "yes" ? "good" : c === "partly" ? "warning" : "danger");

// ---------------------------------------------------------------------------------------------
// Checks across the job's pay
// ---------------------------------------------------------------------------------------------

/**
 * Agreed pay whose work is finished but wasn't marked done by itself, because a visit it covers was
 * cancelled after the price was agreed (job_pay_visits.cancelled_while_agreed): the price may need
 * changing first. Null otherwise.
 */
export function cutShortNote(pay: { status: string; visits: ReadonlyArray<{ visit_id: string; cancelled_while_agreed?: boolean }> }, visits: ReadonlyArray<{ id: string; status: string }>): string | null {
  if (pay.status !== "accepted" || !pay.visits.some((v) => v.cancelled_while_agreed)) return null;
  const covered = visits.filter((v) => pay.visits.some((x) => x.visit_id === v.id));
  if (covered.some((v) => v.status !== "completed" && v.status !== "cancelled")) return null;
  return "Some visits it covers were cancelled after the price was agreed, so it wasn't marked done by itself. Check the lines, then mark the work done.";
}

/**
 * Where the per-unit quantities on the job's pay in play (drafts, offers, agreed, done and paid) come
 * to more than the job has of that service: each person is paid their share (one line each), so more
 * than the job's means some of it is paid twice. "Pay on this job counts 48 squares of Architectural
 * shingles, and the job has 24."
 */
export function overCounted(
  pays: ReadonlyArray<{ status: string; lines: ReadonlyArray<{ basis: string; service_id?: string | null; quantity: number | string; unit?: string | null }> }>,
  jobLines: ReadonlyArray<{ service_id: string | null; name: string; quantity: number | string; unit?: string | null; unit_price?: number | string | null }>,
): string[] {
  const paid = new Map<string, { quantity: number; unit: string | null }>();
  for (const p of pays) {
    if (!isLivePay(p.status)) continue;
    for (const l of p.lines) {
      if (l.basis !== "per_unit" || !l.service_id) continue;
      const was = paid.get(l.service_id);
      paid.set(l.service_id, { quantity: (was?.quantity ?? 0) + Number(l.quantity), unit: was?.unit ?? l.unit ?? null });
    }
  }
  const out: string[] = [];
  for (const [serviceId, counted] of paid) {
    // Discount lines (a credit) are left out, as the suggested quantities leave them out.
    const lines = jobLines.filter((l) => l.service_id === serviceId && Number(l.unit_price ?? 0) >= 0);
    if (!lines.length) continue;
    const onJob = lines.reduce((s, l) => s + Number(l.quantity), 0);
    if (counted.quantity > onJob + 0.005) {
      const unit = counted.unit ?? lines[0]!.unit ?? null;
      out.push(`Pay on this job counts ${quantityWords(counted.quantity, unit)} of ${lines[0]!.name}, and the job has ${quantityWords(onJob, unit)}. Each person's line should be their share.`);
    }
  }
  return out;
}
