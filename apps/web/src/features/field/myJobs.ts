/**
 * A sub's My jobs in words (docs/subcontractors-plan.md, phase D): each offer in one line, which
 * section their work goes in (waiting for their answer, coming up, done and owed, paid, or over), this
 * year's total and what's owed (counted by the server, as the list only has recent pay), whether they
 * can answer now (it takes signal: an answer never waits on the phone to go later), and what a link
 * to an offer that isn't here says. The rows are public.my_sub_offers()'s; nothing here talks to the
 * server, so it's tested on its own (test/subOffers.test.ts).
 */
import { necThreshold } from "@crewtavo/core/jobPay";
import { amountWords, moneyShort, offerDays, type SubOffer } from "@crewtavo/core/subOffers";
import { formatMoneyCents } from "@/lib/format";

/** "Smith roof · Tue Nov 3 · Springfield · 24 squares · $2,040": the job, its days, its town, the biggest per-unit line and the total. */
export function offerCardLine(o: Pick<SubOffer, "job_title" | "visits" | "city" | "region" | "lines" | "total">): string {
  const perUnit = o.lines
    .map((l, i) => ({ ...l, i }))
    .filter((l) => l.basis === "per_unit" && Number(l.quantity) > 0)
    .sort((a, b) => Number(b.amount) - Number(a.amount) || a.i - b.i)[0];
  return [o.job_title, offerDays(o.visits.map((v) => v.scheduled_on)), o.city || o.region, perUnit ? amountWords(perUnit.quantity, perUnit.unit) : null, moneyShort(o.total)]
    .filter(Boolean)
    .join(" · ");
}

export type MyJobSection = "waiting" | "upcoming" | "done" | "paid" | "over";

/**
 * Where a row goes. A new price they can't answer any more (it ran out, and the upkeep hasn't put the
 * agreed one back yet) is still work they've agreed; a first offer that ran out is over. Cancelled
 * work isn't listed.
 */
export function myJobSection(o: Pick<SubOffer, "status" | "is_change" | "can_answer">): MyJobSection | null {
  switch (o.status) {
    case "offered":
      return o.can_answer ? "waiting" : o.is_change ? "upcoming" : "over";
    case "accepted":
      return "upcoming";
    case "done":
      return "done";
    case "paid":
      return "paid";
    case "declined":
    case "expired":
    case "withdrawn":
      return "over";
    default:
      return null;
  }
}

/** How long offers that are over stay on the screen. */
const OVER_DAYS = 30;

/**
 * Their work by section, each in its order: offers by the time to answer by (the soonest first, no
 * deadline last), coming up by the first day, done by the day it was done, paid newest first, and
 * offers that are over from the last 30 days, newest first.
 */
export function myJobSections(offers: readonly SubOffer[], now: Date = new Date()): Record<MyJobSection, SubOffer[]> {
  const out: Record<MyJobSection, SubOffer[]> = { waiting: [], upcoming: [], done: [], paid: [], over: [] };
  for (const o of offers) {
    const section = myJobSection(o);
    if (!section) continue;
    if (section === "over" && o.answered_at && Date.parse(o.answered_at) < now.getTime() - OVER_DAYS * 86_400_000) continue;
    out[section].push(o);
  }
  const firstDay = (o: SubOffer) => o.visits.map((v) => v.scheduled_on).filter(Boolean).sort()[0] ?? "9999";
  out.waiting.sort((a, b) => (a.respond_by ?? "9999").localeCompare(b.respond_by ?? "9999") || (a.offered_at ?? "").localeCompare(b.offered_at ?? ""));
  out.upcoming.sort((a, b) => firstDay(a).localeCompare(firstDay(b)));
  out.done.sort((a, b) => (a.earned_on ?? "").localeCompare(b.earned_on ?? ""));
  out.paid.sort((a, b) => (b.paid_at ?? "").localeCompare(a.paid_at ?? ""));
  out.over.sort((a, b) => (b.answered_at ?? b.offered_at ?? "").localeCompare(a.answered_at ?? a.offered_at ?? ""));
  return out;
}

/**
 * What they've been paid this year (by the day it was paid, the company's) and what they're owed
 * now, from the server (GET /api/sub/offers/totals, public.my_sub_pay_totals()): every payment, not
 * only those the list has. counted: of what was paid, what counts toward a 1099 (card and payment-app
 * payments don't: the processor reports those on a 1099-K).
 */
export interface PayTotals { year: number; paid: number; payments: number; owed: number; owed_jobs: number; counted?: number }

/**
 * Under Paid: how this year's total is counted, how much of it counts toward their 1099 when that's
 * less (card and payment-app payments), and to ask for the 1099 once it reaches the amount that needs
 * one (necThreshold, as the office's 1099 totals go by).
 */
export function paidTotalNote(t: PayTotals | undefined, companyName: string): string {
  const base = "This year's total goes by the day you were paid, and counts every payment, not only the latest ones here.";
  if (!t) return base;
  const counted = t.counted ?? t.paid;
  const part = counted < t.paid
    ? ` ${formatMoneyCents(counted)} of it counts toward your 1099: card and payment-app payments are reported on a 1099-K instead.`
    : "";
  const ask = counted > 0 && counted >= necThreshold(t.year).amount ? ` Ask ${companyName} for your 1099.` : "";
  return base + part + ask;
}

/** Under Paid and Done: "$54,210.00 in 2026" and "$2,210.00 owed", or null for what isn't known yet or is nothing. */
export function totalsWords(t: PayTotals | undefined): { paid: string | null; owed: string | null } {
  if (!t) return { paid: null, owed: null };
  return { paid: `${formatMoneyCents(t.paid)} in ${t.year}`, owed: t.owed > 0 ? `${formatMoneyCents(t.owed)} owed` : null };
}

/**
 * A link to an offer that isn't in the list here (a text or notification opens /field/jobs/<id>): when
 * it's from another company they work for, offer to switch to it; otherwise say plainly it isn't here,
 * without guessing why.
 */
export function missingOfferNote(fromCompany: { id: string; name: string } | null | undefined, currentCompanyId: string): { text: string; switchTo: string | null } {
  if (fromCompany && fromCompany.id !== currentCompanyId) return { text: `This job offer is from ${fromCompany.name}.`, switchTo: fromCompany.id };
  return { text: "We can't find that job here. It may be over. Call the office if you're not sure.", switchTo: null };
}

/**
 * Whether they can take or turn down an offer now, and if not why. An answer needs signal: it isn't
 * kept on the phone to go later, as an office could give the work to someone else meanwhile.
 */
export function answerState(online: boolean, offer: Pick<SubOffer, "can_answer">): { disabled: boolean; note: string | null } {
  if (!offer.can_answer) return { disabled: true, note: "This offer ran out. Call the office if you'd still like the work." };
  if (!online) return { disabled: true, note: "No signal. You can accept or decline this job once you have signal." };
  return { disabled: false, note: null };
}

/** After an answer: what they're told. */
export function answeredToast(accept: boolean, o: Pick<SubOffer, "is_change" | "job_title" | "agreed_total">): string {
  if (o.is_change) return accept ? `New price accepted for ${o.job_title}.` : `Declined. ${o.job_title} stays at ${moneyShort(o.agreed_total)}.`;
  return accept ? `It's yours. ${o.job_title} is on My day for the days it's on.` : "Declined. We've told the office.";
}

