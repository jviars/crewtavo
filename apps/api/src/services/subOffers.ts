/**
 * Job offers to subs (supabase/migrations/20261025004001_sub_offers.sql): the office sends a sub their
 * price on a job, changes an agreed price (which goes back to the sub as a new offer) or takes an
 * offer back, each as itself, so the database checks the subs area again; a sub reads their own offers
 * and answers one, as themselves, through their own sign-in.
 *
 * Who hears is the database's: the sub's sign-ins get a "jobs" notification ("Smith roof, Tue Nov 3,
 * 24 squares, $2,040. Open Crewtavo to accept or decline."), which the notify task
 * (services/delivery.ts) also sends by push, email and text as each sign-in's notification settings
 * say. Texts for it are on until they turn them off, so a sub with a phone is texted when texting is
 * set up, with a link to the offer in My jobs; the office with the subs area hears each answer.
 */
import { offerClosedMessage, type PayBasis, type SubOffer } from "@crewtavo/core";
import { dbError, HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";
import { payById, type JobPayScope } from "./jobPay";

/** A line of a new price, as change_sub_offer takes it. */
export interface OfferLine {
  description: string;
  basis?: PayBasis;
  unit?: string | null;
  quantity?: number;
  rate: number;
  service_id?: string | null;
  pay_rate_id?: string | null;
}

/** The pay, as the office person sees it, if it's a sub's: offers are only for subs. */
async function subPay(s: JobPayScope, id: string) {
  const pay = await payById(s, id);
  if (!pay.subcontractor_id) throw new HttpError(400, "Offers are for subs. Agree pay for your team yourself.");
  return pay;
}

/** Sends the sub a draft as an offer, to answer by `respondBy` if given (an ISO time). */
export async function sendOffer(s: JobPayScope, id: string, respondBy?: string | null) {
  await subPay(s, id);
  must(await s.db.rpc("send_sub_offer", { p_pay: id, ...(respondBy ? { p_respond_by: respondBy } : {}) }));
  return payById(s, id);
}

/** A new price for agreed pay, sent to the sub as an offer; the agreed one stands until they take it. */
export async function changeOffer(s: JobPayScope, id: string, body: { lines: readonly OfferLine[]; respond_by?: string | null }) {
  await subPay(s, id);
  const lines = body.lines.map((l) => ({
    description: l.description,
    basis: l.basis ?? "per_job",
    unit: l.unit ?? null,
    quantity: l.quantity ?? 1,
    rate: l.rate,
    service_id: l.service_id ?? null,
    pay_rate_id: l.pay_rate_id ?? null,
  }));
  must(await s.db.rpc("change_sub_offer", { p_pay: id, p_lines: lines, ...(body.respond_by ? { p_respond_by: body.respond_by } : {}) }));
  return payById(s, id);
}

/** Takes back an offer the sub hasn't answered: a first offer is over; a new price leaves the agreed one. */
export async function withdrawOffer(s: JobPayScope, id: string) {
  await subPay(s, id);
  must(await s.db.rpc("withdraw_sub_offer", { p_pay: id }));
  return payById(s, id);
}

/**
 * The signed-in sub's offers at this company: those waiting for an answer, then the ones that ended
 * in the last 30 days; with `all`, also their work coming up, done and paid lately (for My jobs).
 * The database picks this company's, so its limit counts only these.
 */
export async function myOffers(db: Db, companyId: string, all = false): Promise<SubOffer[]> {
  const rows = must(await db.rpc("my_sub_offers", { p_company: companyId, ...(all ? { p_all: true } : {}) }));
  // The database has picked them already; this keeps another company's out whatever it answers.
  return (rows as unknown as SubOffer[]).filter((o) => o.company_id === companyId);
}

/**
 * What the sub has been paid this year here (by the company's calendar) and is owed now; counted: of
 * what was paid this year, what counts toward a 1099 (not card or payment-app payments).
 */
export interface SubPayTotals { year: number; paid: number; payments: number; owed: number; owed_jobs: number; counted: number }

export async function myPayTotals(db: Db, companyId: string, now = new Date()): Promise<SubPayTotals> {
  const rows = must(await db.rpc("my_sub_pay_totals", { p_company: companyId })) as unknown as SubPayTotals[];
  const row = rows[0];
  if (!row) return { year: now.getUTCFullYear(), paid: 0, payments: 0, owed: 0, owed_jobs: 0, counted: 0 };
  return { year: Number(row.year), paid: Number(row.paid), payments: Number(row.payments), owed: Number(row.owed), owed_jobs: Number(row.owed_jobs), counted: Number(row.counted ?? row.paid) };
}

/**
 * Which company an offer of theirs is from, or null (not theirs, or still the office's draft): for a
 * link that opens My jobs at one company when it's from another they work for. Read as themselves,
 * under row-level security (a sub reads their own pay at every company they sign in to).
 */
export async function offerCompany(db: Db, id: string): Promise<string | null> {
  const { data, error } = await db.from("job_pay").select("company_id").eq("id", id).maybeSingle();
  if (error) throw dbError(error);
  return data?.company_id ?? null;
}

/**
 * The sub takes an offer or turns it down (with a reason, if they give one). `round` is the offer
 * they were looking at. When it didn't go through (answered already, run out, taken back, changed
 * since, or not theirs), a 409 says why, in their words.
 */
export async function answerOffer(db: Db, companyId: string, id: string, body: { accept: boolean; reason?: string | null; round?: number | null }) {
  const reason = body.reason?.trim();
  const answered = must(
    await db.rpc("answer_sub_offer", {
      p_pay: id,
      p_accept: body.accept,
      // Only an offer from the company they have open: one from another is answered there.
      p_company: companyId,
      ...(reason && !body.accept ? { p_reason: reason } : {}),
      ...(body.round != null ? { p_round: body.round } : {}),
    }),
  );
  const offer = (await myOffers(db, companyId, true)).find((o) => o.id === id) ?? null;
  if (!answered) {
    if (!offer) {
      const from = await offerCompany(db, id);
      if (from && from !== companyId) throw new HttpError(404, "This offer is from another company you work for. Switch to it to answer.");
    }
    throw new HttpError(409, offerClosedMessage(offer, body.round));
  }
  return { offer };
}
