/**
 * The roofing project page in plain functions the page and the tests share: where the price range
 * stands with the homeowner (from the lowest option to the highest when the estimate offers options),
 * what each step says it's at, how the estimate was signed and whether a copy went out, the deposit
 * button, who can go out on a site visit, the words the range and the options are sent with, and the
 * strip under the address on the estimate document.
 */
import { optionsIntroText, optionsRange, priceRange, rangeIntroText, type RangeSettings } from "@crewtavo/core/estimates";
import { optionBaseTotal, optionTierLabels, toCents, type Amount, type OptionLine, type TotalsPromo } from "@crewtavo/core/money";
import { SALES, type Role } from "@crewtavo/core/roles";
import { statusText } from "@/components/ui/StatusPill";
import { formatMoney } from "@/lib/format";
import type { QuoteApproval } from "../../documents/build";
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
 * text or in person): while it's out and waiting for their answer, the same as their own Yes on the
 * link, or before it's gone out, when the office told them the range itself (the server saves it as
 * they were told it, without sending them anything). Not once they've said yes, it's signed, or the
 * exact price went out.
 */
export const canMarkAgreed = (q: RangeQuote) => rangeState(q) === "waiting" || rangeState(q) === "unsent";

/**
 * What the range is worked out from: the quote's total, or with options each option's price before
 * add-ons (its lines, the shared ones and its tax and discount: core optionBaseTotal).
 */
export interface RangeEstimate {
  total: number;
  options?: ReadonlyArray<{ id: string }>;
  lines?: readonly OptionLine[];
  tax_rate?: Amount;
  discount_amount?: Amount;
  promo?: TotalsPromo | null;
}

/**
 * Each option's price before its add-ons, for the options that have one, in the order offered: what
 * the range runs across and what the Client Hub prices each option's card at. The server counts the
 * same ones (services/sales.ts optionPrices).
 */
export function optionPrices(q: RangeEstimate): Array<{ id: string; total: number }> {
  const opts = { taxRate: q.tax_rate ?? 0, discountAmount: q.discount_amount ?? 0, promo: q.promo ?? null };
  return (q.options ?? []).flatMap((o) => {
    const total = optionBaseTotal(q.lines ?? [], o.id, opts);
    return total === null ? [] : [{ id: o.id, total }];
  });
}

/** Whether there's a price to make a range from: an option with lines of its own, or the estimate's lines. */
export const isPriced = (q: RangeEstimate) => (q.options?.length ? optionPrices(q).some((p) => p.total > 0) : (q.lines?.length ?? 0) > 0 && q.total > 0);

/**
 * The options a homeowner can say they're leaning toward when the office marks their yes, in the
 * order offered: each with its tier word (as its card has it, core optionTierLabels) and its own
 * range, worked out as the estimate's is (null while it has no price yet).
 */
export function leaningChoices<O extends { id: string; tier: string | null }>(q: Omit<RangeEstimate, "options"> & { options: readonly O[] }, settings: RangeSettings) {
  const prices = optionPrices(q);
  const totalOf = (id: string) => prices.find((p) => p.id === id)?.total ?? null;
  const tiers = optionTierLabels(q.options.map((o) => ({ id: o.id, tier: o.tier, total: totalOf(o.id) })));
  return q.options.map((option) => {
    const total = totalOf(option.id);
    return { option, tier: tiers.get(option.id) ?? null, range: total === null ? null : priceRange(total, settings) };
  });
}

/**
 * The range this estimate would go out at now, to the business's settings: from the cheapest
 * option's low end to the priciest one's high end when it offers options (the server's sendRange
 * works it out the same way), else around its total.
 */
export function rangeNow(q: RangeEstimate, settings: RangeSettings): { low: number; high: number } {
  if (!q.options?.length) return priceRange(q.total, settings);
  return optionsRange(optionPrices(q).map((p) => p.total), settings);
}

/**
 * The price an estimate that offers options starts from: its cheapest option's, before add-ons
 * (optionPrices). Null without options, or before any has a price. Lists show it ("From $18,300")
 * until it's signed, when the quote's own total is the option chosen.
 */
export function lowestOption(q: RangeEstimate): number | null {
  const prices = optionPrices(q);
  return prices.length ? Math.min(...prices.map((p) => p.total)) : null;
}

/** The estimate changed since its range went out, so sending it again sends a different range. */
export function rangeOutdated(q: RangeQuote & RangeEstimate, settings: RangeSettings): boolean {
  if (!hasRange(q)) return false;
  const now = rangeNow(q, settings);
  return toCents(now.low) !== toCents(q.range_low) || toCents(now.high) !== toCents(q.range_high);
}

/** "$18,300 to $21,050" */
export const rangeWords = (range: { low: number; high: number }) => `${formatMoney(range.low)} to ${formatMoney(range.high)}`;

/** What a range across options runs between, said after it. */
export const ACROSS_OPTIONS = "from the lowest option to the highest";

/**
 * Whether the estimate's range runs across its options: two or more with a price (optionPrices), as
 * rangeNow works it out and the server's words count them.
 */
export const rangeAcrossOptions = (q: RangeEstimate) => optionPrices(q).length >= 2;

/** "$18,300 to $21,050", and across options "$18,300 to $32,600, from the lowest option to the highest". */
export const rangeWordsFor = (range: { low: number; high: number }, q: RangeEstimate) => `${rangeWords(range)}${rangeAcrossOptions(q) ? `, ${ACROSS_OPTIONS}` : ""}`;

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

/** Whole dollars in the business's currency, as the server words its messages. */
const wholeMoney = (amount: number, currency: string | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: 0 }).format(amount);

/**
 * The words a range goes out with unless the office writes their own: the server's own (core
 * rangeIntroText, services/sales.ts rangeMessage), across the options when `optionCount` (the options
 * with a price, optionPrices) is two or more.
 */
export const rangeIntro = (range: { low: number; high: number }, optionCount = 0, currency?: string | null) =>
  rangeIntroText(wholeMoney(range.low, currency), wholeMoney(range.high, currency), optionCount);

/**
 * The words the exact price goes out with unless the office writes their own, for an estimate that
 * offers options: how many have a price and the lowest (core optionsIntroText, as services/sales.ts
 * optionsMessage words it). Empty with fewer than two, when the server's own words say the total.
 */
export function optionsIntro(prices: ReadonlyArray<{ total: number }>, currency?: string | null): string {
  if (prices.length < 2) return "";
  const from = new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(Math.min(...prices.map((p) => p.total)));
  return optionsIntroText(prices.length, from);
}

/** One option on the range card: where its price sits on the bar (0 to 1, of the range's high end). */
export interface OptionTick {
  id: string;
  /** Its tier word, else its name. */
  label: string;
  total: number;
  at: number;
}

/**
 * The options as ticks along the range card's bar, cheapest first: each at its price before add-ons
 * (optionPrices), as a share of the range's high end, labelled with its tier word (core
 * optionTierLabels) or its name. Options with no price yet aren't on it.
 */
export function optionTicks(q: Omit<RangeEstimate, "options"> & { options: ReadonlyArray<{ id: string; name: string; tier: string | null }> }, high: number): OptionTick[] {
  const prices = optionPrices(q);
  const tiers = optionTierLabels(q.options.map((o) => ({ id: o.id, tier: o.tier, total: prices.find((p) => p.id === o.id)?.total ?? null })));
  return prices
    .map(({ id, total }) => ({ id, total, label: tiers.get(id) ?? q.options.find((o) => o.id === id)!.name, at: estimateShare(total, high) }))
    .sort((a, b) => toCents(a.total) - toCents(b.total));
}

/** The email subject a roof estimate goes out with. */
export const estimateSubject = (companyName: string) => `Your roof estimate from ${companyName}`;

/**
 * What sending an estimate quotes, as the server works it out: the range it goes out at now, the
 * options with a price, and the words the message starts as unless the office writes its own (the
 * range's, or for the exact price with options how many there are and the lowest; empty when the
 * server's own words say the total). Null until the estimate's options are known (`options`
 * undefined: the quote page loads them), so it never reads as one estimate when it offers options.
 */
export function sendWords(q: RangeEstimate, mode: "range" | "exact", settings: RangeSettings, currency?: string | null): { range: { low: number; high: number }; prices: Array<{ id: string; total: number }>; message: string } | null {
  if (!q.options) return null;
  const range = rangeNow(q, settings);
  const prices = optionPrices(q);
  return { range, prices, message: mode === "range" ? rangeIntro(range, prices.length, currency) : optionsIntro(prices, currency) };
}

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
  if (state === "closed") return statusText("quote", q.status === "lost" ? "lost" : "archived");
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

/**
 * What a signed estimate brings to its job, in a sentence: every line, or with options the ones on
 * every option and the chosen option's (the job takes the lines that count, and another option's
 * never do). Once signed, the option shown is the one chosen.
 */
export function jobLinesText(q: { option_id: string | null; options: ReadonlyArray<{ id: string; name: string }> }): string {
  if (!q.options.length) return "Every line comes along, so nothing gets typed twice.";
  const chosen = q.options.find((o) => o.id === q.option_id)?.name.trim();
  return chosen ? `The lines for ${chosen} and the ones on every option come along, so nothing gets typed twice.` : "The lines they signed for come along, so nothing gets typed twice.";
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
 * Whether to fill the estimate in from its packages now (POST /quotes/:id/options/fill), and the key
 * that makes sure it's tried once: with a measured roof, the options picked before it was measured,
 * while none of them has a line of its own (keyed on the options and the measurement), or for an
 * estimate without options, the package it remembers. Either way only when it's never had them on
 * this screen (`hadLines`: any line, or with options any option's own line): what was taken off by
 * hand stays off. An option still empty beside ones with lines is filled only when asked
 * (emptyOptionsText), since the fill would bring back lines taken off another empty option too.
 */
export function autoFillKey(
  q: { id: string; roof_package_id: string | null; lines: ReadonlyArray<{ option_id: string | null }>; options: ReadonlyArray<{ id: string }> },
  takeoff: { id: string } | null,
  state: { editable: boolean; busy: boolean; hadLines: boolean },
): string | null {
  if (!state.editable || state.busy || !takeoff || state.hadLines) return null;
  if (q.options.length) {
    if (q.lines.some((l) => l.option_id !== null)) return null;
    return `${q.id}:${q.options.map((o) => o.id).sort().join(",")}:${takeoff.id}`;
  }
  if (!q.roof_package_id || q.lines.length) return null;
  return `${q.id}:${q.roof_package_id}:${takeoff.id}`;
}

/** Whether the estimate has the lines autoFillKey fills: any line, or with options any option's own. */
export const hasFilledLines = (q: { lines: ReadonlyArray<{ option_id: string | null }>; options: readonly unknown[] }) =>
  q.options.length ? q.lines.some((l) => l.option_id !== null) : q.lines.length > 0;

/** The options with no lines of their own yet, in order. */
export const emptyOptions = <O extends { id: string }>(options: readonly O[], lines: ReadonlyArray<{ option_id: string | null }>): O[] =>
  options.filter((o) => !lines.some((l) => l.option_id === o.id));

const listWords = (names: readonly string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * What the estimate step says about the options with nothing of their own on them yet (`empty`, by
 * their tier word or name, of `count` options), and what its button does, or null when every option
 * has lines. Before the roof is measured they're priced once it is (the measure link); after, they
 * can be priced from their packages now (`fromPackages`: one of them still has its package), or
 * their lines added by hand.
 */
export function emptyOptionsText(empty: readonly string[], count: number, { measured, fromPackages }: { measured: boolean; fromPackages: boolean }): { text: string; action: string | null } | null {
  if (!empty.length) return null;
  const one = empty.length === 1;
  const names = listWords(empty);
  if (!measured) {
    return { text: empty.length === count ? "Each option is priced from its package once the roof is measured." : `${names} ${one ? "is" : "are"} priced from ${one ? "its package" : "their packages"} once the roof is measured.`, action: "Measure the roof" };
  }
  const nothing = `${names} ${one ? "has nothing on it" : "have nothing on them"} yet.`;
  if (!fromPackages) return { text: `${nothing} Add ${one ? "its" : "their"} lines from your price list.`, action: null };
  return { text: nothing, action: one ? "Price it from its package" : "Price them from their packages" };
}

