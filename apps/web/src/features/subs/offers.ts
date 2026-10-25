/**
 * How a job offer to a sub reads for the office (docs/subcontractors-plan.md, phase D): the time to
 * answer by, picked in words and turned into a time in the company's time zone; the chip and line for
 * each pay a sub has on a job; what can be done with it next; which pay shows on the job; and a new
 * price for agreed pay, as it's typed. The database runs the offer (20261025004001_sub_offers.sql)
 * and checks everything again; nothing here talks to it, so it's tested on its own
 * (test/subOffers.test.ts).
 */
import { isLivePay } from "@crewtavo/core/jobPay";
import { isChangeOffer, moneyShort, respondByProblem } from "@crewtavo/core/subOffers";
import { addDays, localDate, parseZonedTime, zonedTimeToUtc } from "@crewtavo/core/time";
import { PAPERWORK_REQUIREMENTS } from "@crewtavo/core/subs";
import type { Tone } from "@/components/ui/StatusPill";
import { dateIn, formatDate, formatDateTime } from "@/lib/format";
import { paperworkChip, type PaperworkRow } from "./paperwork";
import { draftAmount, draftOf, payStatusLabel, payTone, readQuantity, readRate, type LineDraft, type PayAction, type Payee, type PayLine } from "./pay";

// ---------------------------------------------------------------------------------------------
// The time to answer by
// ---------------------------------------------------------------------------------------------

export const REPLY_BY_CHOICES = [
  { key: "none", label: "No deadline" },
  { key: "2h", label: "In 2 hours" },
  { key: "today", label: "End of today" },
  { key: "noon", label: "Tomorrow at noon" },
  { key: "pick", label: "Pick a time" },
] as const;
export type ReplyBy = (typeof REPLY_BY_CHOICES)[number]["key"];

/** A time picked by hand: a date and a time of day, in the company's time zone. */
export interface PickedTime { date: string; time: string }

/**
 * The time to answer by, as an ISO timestamp, or null for no deadline (and for a picked time that
 * isn't filled in yet). "End of today" is 11:59 PM and "tomorrow at noon" is 12:00 PM, both by the
 * company's clock, not the browser's.
 */
export function replyByAt(choice: ReplyBy, timeZone: string, now: Date = new Date(), picked?: PickedTime): string | null {
  const today = localDate(now, timeZone);
  switch (choice) {
    case "none":
      return null;
    case "2h":
      return new Date(now.getTime() + 2 * 3_600_000).toISOString();
    case "today":
      return zonedTimeToUtc(today, "23:59", timeZone).toISOString();
    case "noon":
      return zonedTimeToUtc(addDays(today, 1), "12:00", timeZone).toISOString();
    case "pick":
      return picked ? (parseZonedTime(picked.date, picked.time, timeZone)?.toISOString() ?? null) : null;
  }
}

/** What's wrong with the choice, or null: a picked time has to be filled in, still to come and within 90 days. */
export function replyByProblem(choice: ReplyBy, at: string | null, now: Date = new Date()): string | null {
  if (choice === "pick" && !at) return "Pick a day and a time.";
  return respondByProblem(at, now);
}

/** Under the choice: "They answer by Tue, Nov 3, 12:00 PM." or that it waits for them. */
export const replyByWords = (at: string | null, timeZone: string) =>
  at ? `They answer by ${formatDateTime(at, timeZone)}. If they don't, it runs out and you'll hear.` : "It waits until they answer, or you withdraw it.";

/**
 * Telling the office how an offer reaches the sub: in the app always, and by email or text as the
 * sub's own settings allow (texts only when texting is set up). They choose, so nothing more is
 * promised.
 */
export const reachWords = (sms: boolean) =>
  `They get it in Crewtavo, and by email${sms ? " or text" : ""} as their notification settings allow. They accept or decline it in one tap.`;

// ---------------------------------------------------------------------------------------------
// A sub's pay on the job: its chip, its line, and what's next
// ---------------------------------------------------------------------------------------------

/** A sub's pay with its offer (job_pay's offer columns). */
export interface OfferState {
  status: string;
  total: number | string;
  respond_by?: string | null;
  offered_at?: string | null;
  offer_outcome?: string | null;
  answered_at?: string | null;
  decline_reason?: string | null;
  accepted_snapshot?: { total?: number | string } | null;
}

/** Waiting for an answer, but past the time to answer by: the hourly upkeep hasn't marked it yet. */
export const ranOut = (p: Pick<OfferState, "status" | "respond_by">, now: Date = new Date()) =>
  p.status === "offered" && Boolean(p.respond_by) && Date.parse(p.respond_by!) <= now.getTime();

/** The price they agreed, for pay that's agreed or has a new price waiting (counted at the agreed one). */
export function agreedAmount(p: OfferState & { paid_amount?: number | string | null }): number {
  if (p.status === "paid") return Number(p.paid_amount ?? 0);
  if (isChangeOffer(p)) return Number(p.accepted_snapshot?.total ?? 0);
  return Number(p.total);
}

/** Counted in what the job's sub and crew pay comes to: agreed, done or paid, and agreed with a new price waiting. */
export const countsAsAgreed = (p: OfferState) => ["accepted", "done", "paid"].includes(p.status) || isChangeOffer(p);

const OFFER_CHIPS: Record<string, { label: string; tone: Tone }> = {
  offered: { label: "Offered, waiting for an answer", tone: "info" },
  accepted: { label: "Accepted", tone: "info" },
  declined: { label: "Declined", tone: "danger" },
  expired: { label: "No answer in time", tone: "muted" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
};

/** The chip for a pay: a sub's offer in its words; anything else (and a team member's) as before. */
export function offerChip(p: OfferState, payee: Payee, now: Date = new Date()): { label: string; tone: Tone } {
  if (payee === "sub") {
    if (isChangeOffer(p)) return ranOut(p, now) ? { label: "Accepted", tone: "info" } : { label: "New price waiting", tone: "info" };
    if (ranOut(p, now)) return OFFER_CHIPS.expired!;
    const chip = OFFER_CHIPS[p.status];
    if (chip) return chip;
  }
  return { label: payStatusLabel(p.status), tone: payTone(p.status) };
}

/**
 * One line about the offer under its chip, or null when there's nothing to say about one: when it's
 * to be answered by, what was turned down and why, or that a new price is waiting (with the agreed one).
 */
export function offerLine(p: OfferState, timeZone: string, now: Date = new Date()): string | null {
  const when = (at: string | null | undefined) => (at ? formatDate(dateIn(at, timeZone)) : "");
  const reason = p.decline_reason ? ` "${p.decline_reason}"` : "";
  if (isChangeOffer(p)) {
    const prices = `${moneyShort(p.total)} (agreed ${moneyShort(p.accepted_snapshot?.total)})`;
    if (ranOut(p, now)) return `They didn't answer the new price of ${prices} in time, so the price they agreed stands.`;
    return `New price waiting: ${prices}. ${p.respond_by ? `They answer by ${formatDateTime(p.respond_by, timeZone)}.` : "No deadline."} If they say no, the agreed price stays.`;
  }
  switch (p.status) {
    case "offered":
      if (ranOut(p, now)) return `They didn't answer by ${formatDateTime(p.respond_by!, timeZone)}.`;
      return p.respond_by ? `Sent ${when(p.offered_at)}. They answer by ${formatDateTime(p.respond_by, timeZone)}.` : `Sent ${when(p.offered_at)}. No deadline.`;
    case "declined":
      return `They declined it ${when(p.answered_at)}.${reason ? ` They said:${reason}.` : ""}`;
    case "expired":
      return p.respond_by ? `They didn't answer by ${formatDateTime(p.respond_by, timeZone)}.` : "They didn't answer in time.";
    case "withdrawn":
      return `You withdrew the offer ${when(p.answered_at)}.`;
    case "accepted":
      // A new price that wasn't taken leaves the pay agreed at the old one.
      if (p.offer_outcome === "declined") return `They declined the new price ${when(p.answered_at)}, so the price they agreed stands.${reason ? ` They said:${reason}.` : ""}`;
      if (p.offer_outcome === "expired") return `They didn't answer the new price in time, so the price they agreed stands.`;
      if (p.offer_outcome === "withdrawn") return `You withdrew the new price ${when(p.answered_at)}. The price they agreed stands.`;
      if (p.offer_outcome === "accepted" && p.answered_at) return `They accepted ${when(p.answered_at)}.`;
      return null;
    default:
      return null;
  }
}

/** What the office can do with a sub's pay, beyond the team's: send it as an offer, withdraw one, change the price, offer the job to someone else. */
export type OfferAction = PayAction | "send" | "withdraw" | "change" | "other";

/**
 * What can be done with a sub's pay next, the main one first. `signIns` is how many sign-ins they
 * have (null while it isn't known): a sub who doesn't sign in has no offer to answer, so the office
 * agrees with them by phone and presses Agree, and changes an agreed price on its lines. Agreeing
 * stays for an offer too (they said yes on the phone). A new price that ran out is still waiting
 * until the hourly upkeep ends it: withdrawing it puts the agreed price back now, and the work can
 * be marked done after that. The database checks every one again.
 */
export function offerActions(p: OfferState, signIns: number | null | undefined, now: Date = new Date()): OfferAction[] {
  const asks = signIns == null || signIns > 0;
  if (isChangeOffer(p)) return ranOut(p, now) ? ["withdraw", "cancel"] : ["accept", "withdraw", "cancel"];
  switch (p.status) {
    case "draft":
      return asks ? ["send", "accept", "delete"] : ["accept", "delete"];
    case "offered":
      return ranOut(p, now) ? ["other"] : ["accept", "withdraw"];
    case "accepted":
      return asks ? ["done", "change", "cancel"] : ["done", "cancel"];
    case "done":
      return ["paid", "cancel"];
    case "paid":
      return ["unpaid"];
    case "declined":
    case "expired":
      return ["other", "delete"];
    default:
      return ["delete"];
  }
}

/** The offer buttons' words; the rest are actionLabel's. */
export function offerActionLabel(action: "send" | "withdraw" | "change" | "other", p: OfferState): string {
  switch (action) {
    case "send":
      return "Send offer";
    case "withdraw":
      return isChangeOffer(p) ? "Withdraw the new price" : "Withdraw the offer";
    case "change":
      return "Change the price";
    case "other":
      return "Offer to someone else";
  }
}

/** Agree, on a new price waiting for their answer: it sets their price without waiting for them. */
export const AGREE_CHANGE_LABEL = "They agreed the new price";

/** What's asked before the office agrees a new price for the sub (they said yes on the phone). */
export function agreeChangeConfirm(p: OfferState, name: string) {
  return {
    title: "Agree the new price for them?",
    body: `This sets ${name}'s price to ${moneyShort(p.total)} (was ${moneyShort(p.accepted_snapshot?.total)}) without waiting for their answer. They're told.`,
    confirmLabel: "Agree the new price",
    cancelLabel: "Wait for them",
  };
}

/** What's asked before an offer is withdrawn, and what's said after: one word for it throughout. */
export function withdrawConfirm(p: OfferState & { paid_amount?: number | string | null }, name: string) {
  const change = isChangeOffer(p);
  return {
    title: change ? "Withdraw the new price?" : "Withdraw the offer?",
    body: change
      ? `The price they agreed (${moneyShort(agreedAmount(p))}) stays, and ${name} is told.`
      : `${name} is told it was withdrawn. To offer the job again, to them or someone else, add new pay.`,
    confirmLabel: "Withdraw",
    cancelLabel: "Keep it",
    danger: !change,
  };
}
export const withdrawnToast = (name: string) => `Withdrawn. ${name} has been told.`;

/**
 * The visits an offer to someone else starts with: those the offer that ended covered, less any
 * cancelled since, so the new sub's pay covers the same work.
 */
export const visitsForElsewhere = (covered: readonly string[], visits: ReadonlyArray<{ id: string; status: string }>) =>
  covered.filter((id) => visits.some((v) => v.id === id && v.status !== "cancelled"));

/**
 * A sub's paperwork in a few words for picking who gets a job: "Workers' comp expired, W-9
 * missing", or null when it's all in order. Only ever a warning.
 */
export function paperworkWords(statuses: readonly PaperworkRow[]): string | null {
  const words = PAPERWORK_REQUIREMENTS.flatMap((req) => {
    const s = statuses.find((x) => x.requirement === req.key) ?? { requirement: req.key, state: "missing", expires_on: null, days_left: null, verified: null };
    const chip = paperworkChip(s);
    return chip.tone === "good" ? [] : [`${req.label} ${chip.label.charAt(0).toLowerCase()}${chip.label.slice(1)}`];
  });
  return words.length ? words.join(", ") : null;
}

/**
 * The subs to choose from, each with its paperwork ("Apex Roofing (roofing) · Workers' comp
 * expired"): those whose papers are in order first, then by name. Without the paperwork yet (still
 * loading), just the names.
 */
export function subChoices(
  subs: ReadonlyArray<{ id: string; name: string; trade?: string | null; active: boolean }>,
  statusesOf: ((id: string) => readonly PaperworkRow[]) | null,
): Array<{ id: string; name: string; ok: boolean }> {
  return subs
    .filter((s) => s.active)
    .map((s) => {
      const name = s.trade ? `${s.name} (${s.trade})` : s.name;
      const words = statusesOf ? paperworkWords(statusesOf(s.id)) : null;
      return { id: s.id, name: words ? `${name} · ${words}` : name, ok: !words, sortName: s.name };
    })
    .sort((a, b) => Number(b.ok) - Number(a.ok) || a.sortName.localeCompare(b.sortName))
    .map(({ id, name, ok }) => ({ id, name, ok }));
}

/**
 * Which pay shows on the job without asking: what's in play, and an offer that ended (turned down,
 * not answered, taken back) until other sub pay was started after it. The rest (cancelled, and offers
 * dealt with since) waits behind "Show".
 */
export function shownOnJob<T extends { status: string; created_at: string; subcontractor_id?: string | null }>(list: readonly T[]): { shown: T[]; hidden: T[] } {
  const ended = (p: T) => ["declined", "expired", "withdrawn"].includes(p.status);
  const dealtWith = (p: T) => list.some((q) => q !== p && q.subcontractor_id && isLivePay(q.status) && q.created_at > p.created_at);
  const shown = list.filter((p) => isLivePay(p.status) || (ended(p) && !dealtWith(p)));
  return { shown, hidden: list.filter((p) => !shown.includes(p)) };
}

// ---------------------------------------------------------------------------------------------
// A new price for agreed pay
// ---------------------------------------------------------------------------------------------

/** A line of the new price as it's typed, with what it came from kept as it was. */
export interface PriceDraft extends LineDraft {
  key: string;
  basis: string;
  unit: string | null;
  service_id: string | null;
  pay_rate_id: string | null;
}

/** The agreed lines, to start the new price from. */
export const priceDrafts = (lines: readonly PayLine[]): PriceDraft[] =>
  lines.map((l) => ({ key: l.id, ...draftOf(l), basis: l.basis, unit: l.unit, service_id: l.service_id ?? null, pay_rate_id: l.pay_rate_id }));

/** A line for anything else, at the end. */
export const otherWork = (key: string): PriceDraft => ({ key, description: "Other work", quantity: "1", rate: "0", basis: "per_job", unit: "job", service_id: null, pay_rate_id: null });

/** The new price's lines as change_sub_offer takes them, or why they won't do. */
export function priceLines(drafts: readonly PriceDraft[]):
  | { lines: Array<{ description: string; basis: string; unit: string | null; quantity: number; rate: number; service_id: string | null; pay_rate_id: string | null }>; problem: null }
  | { lines: null; problem: string } {
  if (!drafts.length) return { lines: null, problem: "Add what you'll pay them." };
  if (drafts.length > 50) return { lines: null, problem: "Keep it to 50 lines." };
  const lines = [];
  for (const d of drafts) {
    const description = d.description.trim();
    if (!description || description.length > 200) return { lines: null, problem: "Give each line a description (200 characters at most)." };
    const quantity = readQuantity(d.quantity);
    const rate = readRate(d.rate);
    if (quantity === null || rate === null) return { lines: null, problem: `Check the quantity and rate on "${description}".` };
    lines.push({ description, basis: d.basis, unit: d.unit, quantity, rate, service_id: d.service_id, pay_rate_id: d.pay_rate_id });
  }
  return { lines, problem: null };
}

/** The new price comes to the same as the agreed one, line for line (the database refuses that too). */
export function samePrice(drafts: readonly PriceDraft[], agreed: readonly PayLine[]): boolean {
  const next = priceLines(drafts);
  if (!next.lines || next.lines.length !== agreed.length) return false;
  return next.lines.every((l, i) => {
    const a = agreed[i]!;
    return l.description === a.description && l.basis === a.basis && (l.unit ?? null) === (a.unit ?? null) && l.quantity === Number(a.quantity) && l.rate === Number(a.rate);
  });
}

/** What the new price's lines come to, as typed (lines that aren't numbers yet count as nothing). */
export const priceTotal = (drafts: readonly PriceDraft[]) => Math.round(drafts.reduce((s, d) => s + Math.round((draftAmount(d) ?? 0) * 100), 0)) / 100;
