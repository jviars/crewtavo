/**
 * How a job is billed, in Jobber's two questions (supabase/migrations/20261104000800_recurring_billing.sql
 * keeps the same rules):
 *   - How is it priced? A recurring job is per visit, or a fixed price: its lines are the price for
 *     each invoice, however many visits.
 *   - When do you invoice? After each visit, monthly (on the last day of the month, or a day the
 *     office picks), or as needed (no reminders).
 * A one-off job is invoiced when the job is done, or by progress billing. jobs.billing_mode is kept
 * in step for the SQL that reads it: per_visit is per visit after each visit, and every other
 * recurring choice is fixed_schedule.
 */
import { addDays, localDate, localTime } from "./time";

export type JobPricing = "per_visit" | "fixed";
export type InvoiceSchedule = "after_visit" | "monthly" | "as_needed";

/** The fields of a job these read. */
export interface JobBilling {
  kind?: string | null;
  billing_mode: string;
  pricing?: string | null;
  invoice_schedule?: string | null;
  /** 1 to 28; null is the last day of the month. */
  invoice_day?: number | null;
}

/** The choices, each with its one line of help, as the job details dialog lists them. */
export const PRICING_CHOICES: ReadonlyArray<{ value: JobPricing; label: string; hint: string }> = [
  { value: "per_visit", label: "Per visit", hint: "Each visit is billed at the job's price." },
  { value: "fixed", label: "Fixed price", hint: "The job's price covers each invoice, however many visits." },
];
export const SCHEDULE_CHOICES: ReadonlyArray<{ value: InvoiceSchedule; label: string; hint: string }> = [
  { value: "after_visit", label: "After each visit", hint: "Each finished visit is ready to invoice." },
  { value: "monthly", label: "Monthly", hint: "On the invoice day, the month shows as needing its invoice." },
  { value: "as_needed", label: "As needed", hint: "No reminders. Invoice whenever you like." },
];
export const ONE_OFF_CHOICES: ReadonlyArray<{ value: "on_completion" | "progress"; label: string; hint: string }> = [
  { value: "on_completion", label: "When the job is done", hint: "One invoice once the work is marked complete." },
  { value: "progress", label: "Progress billing", hint: "Bill parts of the contract as the work goes." },
];

/** billing_mode for the two answers (private.align_billing). */
export const billingModeOf = (pricing: JobPricing, schedule: InvoiceSchedule) => (pricing === "per_visit" && schedule === "after_visit" ? "per_visit" : "fixed_schedule");

/** The two answers, or null for a job invoiced when it's done or by progress. A job saved before they were asked reads from billing_mode, as the database moved it across. */
export function billingAnswers(job: JobBilling): { pricing: JobPricing; schedule: InvoiceSchedule } | null {
  if (job.pricing === "per_visit" || job.pricing === "fixed") {
    const schedule = job.invoice_schedule === "monthly" || job.invoice_schedule === "as_needed" || job.invoice_schedule === "after_visit" ? job.invoice_schedule : job.pricing === "fixed" ? "monthly" : "after_visit";
    return { pricing: job.pricing, schedule };
  }
  if (job.billing_mode === "per_visit") return { pricing: "per_visit", schedule: "after_visit" };
  if (job.billing_mode === "fixed_schedule") return { pricing: "fixed", schedule: "monthly" };
  return null;
}

/** Whether a job is a monthly plan: recurring, a fixed price, invoiced monthly (the one autopay charges by the month). */
export function monthlyPlan(job: JobBilling): boolean {
  const a = billingAnswers(job);
  return job.kind === "recurring" && a?.pricing === "fixed" && a.schedule === "monthly";
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "the last day of the month", "the 15th". */
export const invoiceDayText = (day: number | null | undefined) => (day ? `the ${ordinal(day)}` : "the last day of the month");

/** "Per visit, after each visit", "Fixed price, monthly on the 15th", "When the job is done". */
export function billingText(job: JobBilling): string {
  const a = billingAnswers(job);
  if (!a) return job.billing_mode === "progress" ? "Progress billing" : "When the job is done";
  const price = a.pricing === "fixed" ? "Fixed price" : "Per visit";
  const when = a.schedule === "after_visit" ? "after each visit" : a.schedule === "as_needed" ? "as needed" : `monthly on ${invoiceDayText(job.invoice_day)}`;
  return `${price}, ${when}`;
}

// ---------------------------------------------------------------------------------------------
// Monthly
// ---------------------------------------------------------------------------------------------

/** A month's invoice: the month (its first day), and the days it covers, from the day after last month's invoice day to this month's. */
export interface InvoicePeriod {
  month: string;
  start: string;
  end: string;
}

const firstOf = (date: string) => `${date.slice(0, 7)}-01`;
const lastOf = (date: string) => addDays(firstOf(addDays(firstOf(date), 32)), -1);

/** The invoice period of the month a date is in (private.invoice_period): the invoice day is the job's, or the month's last. */
export function invoicePeriod(day: number | null | undefined, date: string): InvoicePeriod {
  const month = firstOf(date);
  if (!day) return { month, start: month, end: lastOf(month) };
  const before = firstOf(addDays(month, -1));
  return { month, start: addDays(before, day), end: addDays(month, day - 1) };
}

/**
 * The period whose invoice is due now, where the company is: today is the job's invoice day and it's
 * 8 in the morning or later (emit_invoice_reminders, hourly). Null on any other day. Every hour of
 * the day gives the same month, which the database keeps one reminder for.
 */
export function invoiceDue(day: number | null | undefined, now: Date, timeZone: string): InvoicePeriod | null {
  const today = localDate(now, timeZone);
  const period = invoicePeriod(day, today);
  return period.end === today && localTime(now, timeZone) >= "08:00" ? period : null;
}

/** "November 2026". */
export const monthText = (month: string) => new Date(`${firstOf(month)}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export interface BillableVisit {
  kind?: string | null;
  status: string;
  invoice_id: string | null;
  scheduled_on: string | null;
  completed_at: string | null;
}

/** A visit's day: the day it was scheduled for, or the day it was finished where the company is (private.visit_day). */
export const visitDay = (v: Pick<BillableVisit, "scheduled_on" | "completed_at">, timeZone: string) =>
  v.scheduled_on ?? (v.completed_at ? localDate(new Date(v.completed_at), timeZone) : null);

/** What a monthly per-visit invoice bills (create_invoice_for_job with p_month): the finished job visits of the period not on an invoice yet. */
export function monthlyVisits<V extends BillableVisit>(visits: readonly V[], period: InvoicePeriod, timeZone: string): V[] {
  return visits.filter((v) => {
    const day = visitDay(v, timeZone);
    return (v.kind ?? "job") === "job" && v.status === "completed" && !v.invoice_id && day !== null && day >= period.start && day <= period.end;
  });
}
