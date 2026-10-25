/**
 * Job pay (docs/subcontractors-plan.md, phase C): a sub's price on a job and a team member's piece
 * pay, from rate cards; what each sub was paid in a year, for their 1099; and the workers' comp audit.
 * The money is worked out in Postgres (supabase/migrations/20261025003001_job_pay.sql and after);
 * these are its words, the rules the screens need to agree with it, and the downloads.
 */
import { toUnits } from "./money";
import { isCorporation, taxClassificationLabel } from "./subs";

export const JOB_PAY_STATUSES = [
  { key: "draft", label: "Draft" },
  { key: "offered", label: "Offered" },
  { key: "accepted", label: "Agreed" },
  { key: "declined", label: "Declined" },
  { key: "withdrawn", label: "Withdrawn" },
  { key: "expired", label: "Expired" },
  { key: "done", label: "Work done" },
  { key: "paid", label: "Paid" },
  { key: "cancelled", label: "Cancelled" },
] as const;
export type JobPayStatus = (typeof JOB_PAY_STATUSES)[number]["key"];
export const jobPayStatusLabel = (status: string) => JOB_PAY_STATUSES.find((s) => s.key === status)?.label ?? status;

/** Pay still in play, one per payee per job. Mirrors private.job_pay_live(). */
export const isLivePay = (status: string) => !["declined", "withdrawn", "expired", "cancelled"].includes(status);
/** Pay that counts as labor in job costs: agreed, done or paid. */
export const LABOR_STATUSES: readonly JobPayStatus[] = ["accepted", "done", "paid"];
/** Lines and visits change while pay is a draft or agreed, not once the work is done. */
export const isPayEditable = (status: string) => status === "draft" || status === "accepted";

/** How a payment was made. A team member's is paid with their pay period; a sub may be paid through a payroll service too. */
export const JOB_PAY_METHODS = [
  { key: "check", label: "Check" },
  { key: "ach", label: "Bank transfer" },
  { key: "cash", label: "Cash" },
  { key: "card_or_app", label: "Card or payment app" },
  { key: "payroll", label: "Payroll" },
  { key: "other", label: "Other" },
] as const;
export type JobPayMethod = (typeof JOB_PAY_METHODS)[number]["key"];
/** How a sub can be paid (job_pay_mark_paid): a payroll service's contractor payments count too. */
export const SUB_PAY_METHODS = ["check", "ach", "cash", "card_or_app", "payroll", "other"] as const satisfies readonly JobPayMethod[];
export type SubPayMethod = (typeof SUB_PAY_METHODS)[number];
export const jobPayMethodLabel = (method: string | null | undefined) => JOB_PAY_METHODS.find((m) => m.key === method)?.label ?? "";

/** A pay period line's method as job pay records it. Mirrors private.payroll_method(). */
export function payrollMethod(periodMethod: string | null | undefined): JobPayMethod {
  return ({ direct_deposit: "ach", check: "check", cash: "cash", other: "other" } as Record<string, JobPayMethod>)[periodMethod ?? ""] ?? "payroll";
}

export const PAY_BASES = [
  { key: "per_unit", label: "Per unit" },
  { key: "per_job", label: "Per job" },
  { key: "per_day", label: "Per day" },
] as const;
export type PayBasis = (typeof PAY_BASES)[number]["key"];

/** Which squares a rate per square counts. */
export const SQUARES_BASES = [
  { key: "job", label: "The job's squares", hint: "The job line's quantity: what the client pays for, waste included." },
  { key: "roof_no_waste", label: "Roof squares without waste", hint: "The roof measurement's waste taken back out." },
] as const;
export type SquaresBasis = (typeof SQUARES_BASES)[number]["key"];

/** "sq", "square", "squares". Mirrors private.is_square_unit(). */
export const isSquareUnit = (unit: string | null | undefined) => ["sq", "sqs", "square", "squares"].includes((unit ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, ""));

/**
 * quantity × rate to the cent, as the database works out a line's amount: quantity to 3 places and
 * rate to 4, as their columns keep them, then rounded half away from zero.
 */
export function payLineAmount(quantity: number | string, rate: number | string): number {
  const n = toUnits(quantity, 3) * toUnits(rate, 4); // in 10^-7 dollars
  const cents = (2n * (n < 0n ? -n : n) + 100_000n) / 200_000n;
  return Number(n < 0n ? -cents : cents) / 100;
}

// ---------------------------------------------------------------------------------------------
// Yearly totals for the 1099
// ---------------------------------------------------------------------------------------------

/**
 * The 1099-NEC reporting threshold by the year paid: $600 through 2025, $2,000 for 2026 (the One Big
 * Beautiful Bill Act). From 2027 it's adjusted for inflation, so later years use $2,000 until the
 * table has the IRS figure, and say to check it. Check these against the IRS 1099-NEC instructions.
 */
export const NEC_THRESHOLDS: ReadonlyArray<{ through: number; amount: number }> = [
  { through: 2025, amount: 600 },
  { through: 2026, amount: 2000 },
];

export function necThreshold(year: number): { amount: number; note: string | null } {
  const known = NEC_THRESHOLDS.find((t) => year <= t.through);
  if (known) return { amount: known.amount, note: null };
  const last = NEC_THRESHOLDS[NEC_THRESHOLDS.length - 1]!;
  return { amount: last.amount, note: `From 2027 the IRS adjusts this for inflation. Check the 1099-NEC instructions for ${year}: we've used $${last.amount.toLocaleString("en-US")}.` };
}

/** A row of public.sub_1099_totals(). */
export interface SubYearTotalRow {
  subcontractor_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: unknown;
  tax_classification: string | null;
  active?: boolean | null;
  corporation: boolean;
  total: number | string;
  payments: number;
  card_or_app_total: number | string;
  card_or_app_payments: number;
  /** What of the total went through a payroll service (counted in it: the service may file that 1099 itself). */
  payroll_total?: number | string | null;
  payroll_payments?: number | null;
}

export interface SubYearTotal extends Omit<SubYearTotalRow, "total" | "card_or_app_total" | "payroll_total"> {
  total: number;
  card_or_app_total: number;
  payroll_total: number;
  needs_1099: boolean;
  /** What to know about this one, in a sentence or two; empty when there's nothing to say. */
  note: string;
}

const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Who needs a 1099-NEC for `year`: not a corporation (by their W-9), and paid at least the year's
 * threshold, card and payment-app payments left out (the processor reports those on a 1099-K).
 * Payments through a payroll service count, with a note: the service may file that 1099 already.
 */
export function yearTotals(rows: readonly SubYearTotalRow[], year: number) {
  const threshold = necThreshold(year);
  const subs: SubYearTotal[] = rows.map((r) => {
    const total = Number(r.total);
    const card = Number(r.card_or_app_total);
    const payroll = Number(r.payroll_total ?? 0);
    const corporation = r.corporation || isCorporation(r.tax_classification);
    const notes: string[] = [];
    if (corporation) notes.push("A corporation usually doesn't get a 1099.");
    else if (!r.tax_classification) notes.push("No W-9 on file: get one to check.");
    if (!corporation && total < threshold.amount) notes.push(`Under the ${dollars(threshold.amount)} threshold for ${year}.`);
    if (card > 0) notes.push(`${dollars(card)} paid by card or payment app is left out: that's reported on a 1099-K.`);
    if (payroll > 0) notes.push(`${dollars(payroll)} was paid through payroll: check whether your payroll service already files their 1099.`);
    return { ...r, total, card_or_app_total: card, payroll_total: payroll, corporation, needs_1099: !corporation && total >= threshold.amount, note: notes.join(" ") };
  });
  return {
    year,
    threshold: threshold.amount,
    threshold_note: threshold.note,
    subs,
    total: Math.round(subs.reduce((s, r) => s + r.total, 0) * 100) / 100,
    needing_1099: subs.filter((s) => s.needs_1099).length,
  };
}

// ---------------------------------------------------------------------------------------------
// The workers' comp audit
// ---------------------------------------------------------------------------------------------

export type Coverage = "yes" | "no" | "partly";

/** A certificate that covered some of the work (sub_wc_audit's documents). */
export interface WcCertificate {
  id: string;
  kind: string;
  title?: string | null;
  carrier: string | null;
  policy_number: string | null;
  starts_on: string | null;
  expires_on: string | null;
  replaced: boolean;
  /**
   * A date is missing, so the audit assumed it: a certificate is taken as a one-year policy from the
   * date it has; an exemption as a year up to its end date (with no dates, from the day it was added),
   * or, with no end date, as still in force.
   */
  dates_assumed?: boolean;
}

/** A row of public.sub_wc_audit(). */
export interface WcAuditRow {
  job_pay_id: string;
  subcontractor_id: string;
  sub_name: string;
  job_id: string;
  job_number: number | null;
  job_title: string;
  status: string;
  /** Its share for the days worked in the report's dates (what was paid, else what was agreed). */
  amount: number | string;
  /** The whole pay, when some of its work is outside the dates (then amount is split by days). */
  pay_amount?: number | string | null;
  work_dates: string[];
  covered_dates: string[];
  coverage: Coverage;
  covered_amount: number | string;
  uncovered_amount: number | string;
  documents: WcCertificate[] | unknown;
}

export const coverageLabel = (c: string) => (c === "yes" ? "Covered" : c === "partly" ? "Partly covered" : "Not covered");

/**
 * The report's totals: the sub work in it (paid, and agreed or done but not paid yet), and what was
 * covered by a certificate or exemption on file, and what wasn't.
 */
export function wcAuditTotals(rows: readonly WcAuditRow[]) {
  const cents = (n: number) => Math.round(n * 100) / 100;
  return {
    amount: cents(rows.reduce((s, r) => s + Number(r.amount), 0)),
    paid: cents(rows.filter((r) => r.status === "paid").reduce((s, r) => s + Number(r.amount), 0)),
    not_paid_yet: cents(rows.filter((r) => r.status !== "paid").reduce((s, r) => s + Number(r.amount), 0)),
    covered: cents(rows.reduce((s, r) => s + Number(r.covered_amount), 0)),
    not_covered: cents(rows.reduce((s, r) => s + Number(r.uncovered_amount), 0)),
    subs: new Set(rows.map((r) => r.subcontractor_id)).size,
    not_covered_subs: new Set(rows.filter((r) => r.coverage !== "yes").map((r) => r.subcontractor_id)).size,
  };
}

const shortDate = (d: string | null) => (d ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(Date.parse(`${d}T12:00:00Z`)) : "");

/** What the audit assumed for a document missing a date (private.wc_doc_term), so the office adds it. */
function assumedText(c: WcCertificate): string {
  if (!c.dates_assumed) return "";
  if (c.kind === "wc_exemption") {
    if (!c.starts_on && !c.expires_on) return "no dates on file, so it's counted from the day it was added";
    if (!c.starts_on) return "no start date on file, so a year up to its end date is assumed";
    return "no end date on file, so it's counted as still in force";
  }
  return `${c.starts_on ? "no end date" : "no start date"} on file, so a one-year policy is assumed`;
}

/**
 * "Workers' comp certificate, Acme Mutual WC-1, Jan 1, 2026 to Oct 12, 2026 (replaced)". A
 * document missing a date says what the audit assumed, so the office adds it.
 */
export function certificateText(c: WcCertificate): string {
  const kind = c.kind === "wc_exemption" ? "Workers' comp exemption" : "Workers' comp certificate";
  const policy = [c.carrier, c.policy_number].filter(Boolean).join(" ");
  const dates = c.starts_on || c.expires_on ? `${c.starts_on ? shortDate(c.starts_on) : "no start date"} to ${c.expires_on ? shortDate(c.expires_on) : "no end date"}` : "";
  return [kind, policy, dates, assumedText(c)].filter(Boolean).join(", ") + (c.replaced ? " (replaced)" : "");
}

/** Beside a row whose pay was split by days: "Part of $4,000.00 pay: some of the work is outside these dates." */
export function wcPartNote(r: Pick<WcAuditRow, "amount" | "pay_amount">): string | null {
  return r.pay_amount != null && Number(r.pay_amount) !== Number(r.amount) ? `Part of ${dollars(Number(r.pay_amount))} pay: some of the work is outside these dates.` : null;
}

// ---------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------

// RFC 4180, with a leading = + - @ (or tab or CR) quoted out so a spreadsheet doesn't run it as a
// formula. Plain numbers like -250.5 are left alone. As apps/web/src/lib/csv.ts.
const cell = (value: unknown) => {
  const s = value == null ? "" : String(value);
  const isNumber = typeof value === "number" || /^-?\d+(\.\d+)?$/.test(s);
  const safe = !isNumber && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (header: readonly string[], rows: ReadonlyArray<readonly unknown[]>) => [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
const money = (n: number | string) => Number(n).toFixed(2);

const addressParts = (address: unknown) => {
  const a = (address && typeof address === "object" ? address : {}) as Record<string, unknown>;
  const part = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  return [part("line1"), part("line2"), part("city"), part("region"), part("postal_code")];
};

/**
 * The year's totals for the bookkeeper: one row per sub with their legal name, contact, mailing
 * address, W-9 classification, total, payments, whether a 1099 is needed, and the note. No tax ID
 * numbers: they stay on the W-9.
 */
export function yearTotalsCsv(totals: ReturnType<typeof yearTotals>): string {
  return csv(
    ["Legal name", "Contact", "Email", "Phone", "Address", "Address line 2", "City", "State", "ZIP", "Tax classification", `Total paid in ${totals.year}`, "Payments", "Needs a 1099", "Note"],
    totals.subs.map((s) => [
      s.name, s.contact_name ?? "", s.email ?? "", s.phone ?? "", ...addressParts(s.address), taxClassificationLabel(s.tax_classification) ?? "",
      money(s.total), s.payments, s.needs_1099 ? "Yes" : "No", s.note,
    ]),
  );
}

/**
 * The workers' comp audit for the auditor: one row per sub's pay, with its status (paid, or agreed
 * and not paid yet), the days worked, its amount for those days and the certificates.
 */
export function wcAuditCsv(rows: readonly WcAuditRow[]): string {
  return csv(
    ["Subcontractor", "Job", "Status", "Days worked", "Amount (paid, or agreed if not paid yet)", "Workers' comp", "Covered", "Not covered", "Certificates", "Note"],
    rows.map((r) => [
      r.sub_name, `${r.job_number ? `#${r.job_number} ` : ""}${r.job_title}`, jobPayStatusLabel(r.status), r.work_dates.join("; "), money(r.amount), coverageLabel(r.coverage),
      money(r.covered_amount), money(r.uncovered_amount), (Array.isArray(r.documents) ? (r.documents as WcCertificate[]) : []).map(certificateText).join("; "), wcPartNote(r) ?? "",
    ]),
  );
}
