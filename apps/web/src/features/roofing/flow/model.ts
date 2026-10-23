/**
 * The roofing project page in plain functions the page and the tests share: where the price range
 * stands with the homeowner, what each step says it's at, how the estimate was signed and whether a
 * copy went out, the deposit button, who can go out on a site visit, the words the range is sent
 * with, and the strip under the address on the estimate document.
 */
import { priceRange, type RangeSettings } from "@crewtavo/core/estimates";
import { toCents } from "@crewtavo/core/money";
import { SALES, type Role } from "@crewtavo/core/roles";
import { formatMoney, formatNumber } from "@/lib/format";
import type { QuoteApproval } from "../../documents/build";
import type { TakeoffRow } from "../../paving/data";
import { firstName, money, rangePosition, whenText } from "../estimate/rows";

// ---------------------------------------------------------------------------------------------
// The price range, as it stands with the homeowner
// ---------------------------------------------------------------------------------------------

/** The parts of a roof estimate its range reads. */
export interface RangeQuote {
  status: string;
  total: number;
  range_low: number | null;
  range_high: number | null;
  range_sent_at: string | null;
  range_accepted_at: string | null;
  /** When the salesperson set the exact price on site (PUT /roofing/:id/site-price). */
  priced_on_site_at: string | null;
  /** When the office sent the exact price instead of the range: nobody went out. */
  exact_sent_at?: string | null;
}

/**
 * - unsent: nothing's gone to the homeowner yet (a draft).
 * - waiting: the range is out; they haven't said yes.
 * - accepted: they said yes and want someone out.
 * - exact: they have an exact price: sent without a range or instead of it, or set on site.
 * - signed: approved or turned into a job.
 * - closed: lost or archived.
 */
export type RangeState = "unsent" | "waiting" | "accepted" | "exact" | "signed" | "closed";

export const SIGNED = ["approved", "converted"];
export const OPEN = ["draft", "sent", "changes_requested"];

/** Whether a range was saved on the quote (sent, or being sent). */
export function hasRange<T extends Pick<RangeQuote, "range_low" | "range_high">>(q: T): q is T & { range_low: number; range_high: number } {
  return q.range_low !== null && q.range_low !== undefined && q.range_high !== null && q.range_high !== undefined;
}

export function rangeState(q: RangeQuote): RangeState {
  if (SIGNED.includes(q.status)) return "signed";
  if (!OPEN.includes(q.status)) return "closed";
  if (q.priced_on_site_at || q.exact_sent_at) return "exact";
  // A draft with a range saved but not delivered (the email didn't go) still has to go out.
  if (q.status === "draft") return "unsent";
  if (!hasRange(q)) return "exact";
  return q.range_accepted_at ? "accepted" : "waiting";
}

/**
 * Whether the office can mark the range as agreed for the homeowner (they said yes on the phone, by
 * text or in person): only while it's out and waiting for their answer, the same as their own Yes
 * on the link. Not once they've said yes, it's signed, or the exact price went out.
 */
export const canMarkAgreed = (q: RangeQuote) => rangeState(q) === "waiting";

/** The range this estimate would go out at now, to the business's settings. */
export const rangeNow = (q: Pick<RangeQuote, "total">, settings: RangeSettings) => priceRange(q.total, settings);

/** The estimate changed since its range went out, so sending it again sends a different range. */
export function rangeOutdated(q: RangeQuote, settings: RangeSettings): boolean {
  if (!hasRange(q)) return false;
  const now = rangeNow(q, settings);
  return toCents(now.low) !== toCents(q.range_low) || toCents(now.high) !== toCents(q.range_high);
}

/** "$18,300 to $21,050" */
export const rangeWords = (range: { low: number; high: number }) => `${formatMoney(range.low)} to ${formatMoney(range.high)}`;

/** How much of the range bar is the estimate itself; the rest is the room on top. */
export function estimateShare(total: number, high: number): number {
  if (!(high > 0)) return 1;
  return Math.min(1, Math.max(0, total / high));
}

/** Where a signed price sits on the range it was sent at. */
export function rangePill(price: number, range: { low: number; high: number }): { label: string; tone: "good" | "warning" | "info" } {
  const where = rangePosition(range.low, range.high, price).where;
  if (where === "above") return { label: "Above the range", tone: "warning" };
  if (where === "below") return { label: "Below the range", tone: "info" };
  return { label: "Inside the range", tone: "good" };
}

/** The words a range goes out with unless the office writes their own (the server's own, routes/roofing.ts). */
export const rangeIntro = (range: { low: number; high: number }) =>
  `Thanks for having us look at your roof. From our measurements, your new roof will cost between ${formatMoney(range.low)} and ${formatMoney(range.high)}. You can see what's included and let us know when you'd like us to come out:`;

/** The email subject a roof estimate goes out with. */
export const estimateSubject = (companyName: string) => `Your roof estimate from ${companyName}`;

// ---------------------------------------------------------------------------------------------
// Dates and names
// ---------------------------------------------------------------------------------------------

/** "Oct 22" (with the year when it isn't this year), in the business's time zone. */
export function dayText(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const year = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: year(at) === year(now) ? undefined : "numeric", timeZone });
}

/** "on Oct 24 at 2:14 PM", "today at 9:12 AM". */
export function onWhen(iso: string, timeZone: string, now: Date = new Date()): string {
  const when = whenText(iso, timeZone, now);
  return /^(today|yesterday)/.test(when) ? when : `on ${when}`;
}

/** The homeowner as the page names them: their first name, else "the homeowner". */
export const homeownerName = (clientName: string | null | undefined) => firstName(clientName) || "the homeowner";

/** The same, at the start of a sentence. */
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------------------------
// What each step says it's at
// ---------------------------------------------------------------------------------------------

/** "Sent Oct 22, waiting on Dana", "Dana said yes Oct 23", "The exact price went out Oct 23", "Not sent yet". */
export function rangeStepStatus(q: RangeQuote & { lines: readonly unknown[] }, clientName: string | null | undefined, timeZone: string, now: Date = new Date()): string {
  const who = homeownerName(clientName);
  const sent = q.range_sent_at ? ` ${dayText(q.range_sent_at, timeZone, now)}` : "";
  const yes = q.range_accepted_at ? `${capital(who)} said yes ${dayText(q.range_accepted_at, timeZone, now)}` : null;
  const state = rangeState(q);
  if (state === "unsent") return q.lines.length ? "Not sent yet" : "After the estimate";
  if (state === "waiting") return `Sent${sent}, waiting on ${who}`;
  if (yes) return yes;
  if (q.exact_sent_at && !q.priced_on_site_at && state === "exact") return `The exact price went out ${dayText(q.exact_sent_at, timeZone, now)}`;
  if (hasRange(q)) return `Sent${sent}`;
  if (state === "closed") return "Not sent";
  return state === "exact" ? "Skipped: the exact price went out" : "Skipped";
}

/** The parts of a quote the site visit step reads. */
export interface VisitQuote extends RangeQuote {
  lines: readonly unknown[];
  sent_at?: string | null;
  approved_at: string | null;
  approval: QuoteApproval | null;
}

/** "Signed Oct 24 by Dana Whitfield", "Priced on site Oct 24", "After Dana says yes". */
export function visitStepStatus(q: VisitQuote, clientName: string | null | undefined, timeZone: string, now: Date = new Date()): string {
  const who = homeownerName(clientName);
  const day = (iso: string | null | undefined) => (iso ? ` ${dayText(iso, timeZone, now)}` : "");
  const state = rangeState(q);
  if (state === "signed") {
    if (q.approval?.method === "manual") return `Marked approved${day(q.approved_at)}`;
    return `Signed${day(q.approval?.signed_at ?? q.approved_at)}${q.approval?.name ? ` by ${q.approval.name}` : ""}`;
  }
  if (state === "closed") return q.status === "lost" ? "Lost" : "Archived";
  if (!q.lines.length) return "After the estimate";
  if (q.priced_on_site_at) return `Priced on site${day(q.priced_on_site_at)}`;
  if (state === "accepted") return "Ready to book";
  if (state === "exact") return `Sent${day(q.exact_sent_at ?? q.sent_at)}, waiting on ${who}`;
  if (state === "waiting") return `After ${who} says yes`;
  return "After the range";
}

// ---------------------------------------------------------------------------------------------
// Signed
// ---------------------------------------------------------------------------------------------

/** "Signed on site for $19,524", "Signed online for $19,524", "Marked approved for $19,524". */
export function signedHeadline(approval: Pick<QuoteApproval, "method"> | null, total: number): string {
  if (approval?.method === "manual") return `Marked approved for ${money(total)}`;
  if (approval?.method === "in_person") return `Signed on site for ${money(total)}`;
  return `Signed online for ${money(total)}`;
}

/**
 * Who signed and when: "Dana Whitfield and Mike Torres signed on Oct 24 at 2:14 PM.", "Dana Whitfield
 * signed online today at 9:12 AM. Mike Torres signed for Ridgeline Roofing."
 */
export function signedSentence(approval: QuoteApproval | null, approvedAt: string | null, companyName: string, timeZone: string, now: Date = new Date()): string {
  const iso = approval?.signed_at ?? approvedAt;
  const at = iso ? ` ${onWhen(iso, timeZone, now)}` : "";
  if (!approval) return `Approved${at}.`;
  if (approval.method === "manual") return `${approval.name || "The office"} marked it approved${at}, without a signature.`;
  const customer = approval.name || "The homeowner";
  const rep = approval.company?.name || null;
  if (approval.method === "in_person") return rep ? `${customer} and ${rep} signed${at}.` : `${customer} signed${at}.`;
  return `${customer} signed online${at}.${approval.company ? ` ${rep ?? "Your team"} signed for ${companyName}.` : ""}`;
}

/** A message that was the signed copy (services/signing.ts words its subject like this). */
export const isSignedCopy = (m: { channel: string; subject: string | null }) =>
  (m.channel === "email" && /^Your signed estimate from /.test(m.subject ?? "")) || (m.channel === "sms" && /^Signed estimate #/.test(m.subject ?? ""));

/** "A copy was emailed to Dana.", or null when none went. */
export function copySentence(copies: ReadonlyArray<{ channel: string }>, clientName: string | null | undefined): string | null {
  const who = homeownerName(clientName);
  const emailed = copies.some((c) => c.channel === "email");
  const texted = copies.some((c) => c.channel === "sms");
  if (emailed && texted) return `A copy was emailed and texted to ${who}.`;
  if (emailed) return `A copy was emailed to ${who}.`;
  if (texted) return `A link to it was texted to ${who}.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

/** "Bill the 30% deposit, $5,857", or "Bill the deposit, $500" when it isn't a round share. */
export function depositLabel(deposit: number, total: number): string {
  const pct = total > 0 ? (deposit / total) * 100 : 0;
  const whole = Math.round(pct);
  const share = whole >= 1 && whole <= 99 && Math.abs(pct - whole) < 0.5 ? ` ${whole}%` : "";
  return `Bill the${share} deposit, ${money(deposit)}`;
}

// ---------------------------------------------------------------------------------------------
// The team
// ---------------------------------------------------------------------------------------------

/** A team member as GET /team returns them. */
export interface TeamMember {
  user_id: string;
  role: string;
  active: boolean;
  profile: { full_name: string | null; email?: string | null } | null;
}

export interface Salesperson {
  id: string;
  name: string;
  active: boolean;
}

const nameOf = (m: TeamMember) => m.profile?.full_name?.trim() || m.profile?.email?.trim() || "Someone on your team";

/**
 * Who can go out on a site visit: everyone active who prices work (owners, admins, the office and
 * estimators), by name. The one already picked stays in the list even if they've left.
 */
export function salesPeople(team: readonly TeamMember[], keep?: string | null): Salesperson[] {
  return team
    .filter((m) => (m.active && (SALES as readonly string[]).includes(m.role as Role)) || (keep && m.user_id === keep))
    .map((m) => ({ id: m.user_id, name: nameOf(m), active: m.active }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A team member's name, or null when they aren't on the team list. */
export function personName(team: readonly TeamMember[] | undefined, userId: string | null | undefined): string | null {
  const m = userId ? team?.find((t) => t.user_id === userId) : undefined;
  return m ? nameOf(m) : null;
}

/** "Notes for Mike", or "Notes for the site visit" before anyone's picked. */
export const notesTitle = (salesperson: string | null | undefined) => (firstName(salesperson) ? `Notes for ${firstName(salesperson)}` : "Notes for the site visit");

// ---------------------------------------------------------------------------------------------
// The package, and the document
// ---------------------------------------------------------------------------------------------

/**
 * Whether to put the estimate's package on it now, and the key that makes sure it's tried once:
 * an estimate that's never had lines on this screen, with a package and a measured roof. One that
 * had lines and lost them all (taken off by hand) is left alone.
 */
export function autoApplyKey(q: { id: string; roof_package_id: string | null; lines: readonly unknown[] }, takeoff: { id: string } | null, options: { editable: boolean; busy: boolean; hadLines: boolean }): string | null {
  if (!options.editable || options.busy || options.hadLines || !q.roof_package_id || !takeoff || q.lines.length) return null;
  return `${q.id}:${q.roof_package_id}:${takeoff.id}`;
}

/** What a package left off, worth saying: a service that can't be measured, or isn't on this roof. */
export function skippedNote(skipped: ReadonlyArray<{ name: string; reason: string }> | undefined): string | null {
  if (!skipped?.length) return null;
  const none = skipped.filter((s) => s.reason === "None on this roof").map((s) => s.name);
  const other = skipped.filter((s) => s.reason !== "None on this roof").map((s) => s.name);
  const list = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  return [
    none.length ? `Left off, with nothing to measure on this roof: ${list(none)}.` : null,
    other.length ? `Couldn't work out ${list(other)} from the roof. Check the measurements, then add ${other.length === 1 ? "it" : "them"} below.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The strip under the address on the document: the package and the roof ("22.0 squares", "6/12 pitch"). */
export function documentFacts(packageName: string | null | undefined, takeoff: Pick<TakeoffRow, "roofing_squares" | "roof_pitch"> | null | undefined): string[] {
  const facts = packageName?.trim() ? [packageName.trim()] : [];
  const squares = takeoff?.roofing_squares != null ? Number(takeoff.roofing_squares) : 0;
  if (squares > 0) facts.push(`${formatNumber(squares, 1)} squares`);
  if (takeoff?.roof_pitch) facts.push(`${takeoff.roof_pitch} pitch`);
  return facts;
}
