/**
 * Job offers to subs (docs/subcontractors-plan.md, phase D), as the screens read them. For the
 * office: which buttons show for each pay, its chip and line, the time to answer by worked out in the
 * company's time zone, which pay shows on the job, and a new price's lines. For the sub: an offer's
 * one line, where each of their jobs goes in My jobs, this year's total (the server's), that an
 * answer needs signal, and a link to an offer that isn't here.
 */
import type { SubOffer } from "@crewtavo/core/subOffers";
import { describe, expect, it } from "vitest";
import { answeredToast, answerState, missingOfferNote, myJobSection, myJobSections, offerCardLine, paidTotalNote, totalsWords } from "../src/features/field/myJobs";
import type { PaperworkRow } from "../src/features/subs/paperwork";
import {
  AGREE_CHANGE_LABEL,
  agreeChangeConfirm,
  agreedAmount,
  countsAsAgreed,
  offerActionLabel,
  offerActions,
  offerChip,
  offerLine,
  otherWork,
  priceDrafts,
  priceLines,
  priceTotal,
  paperworkWords,
  ranOut,
  reachWords,
  replyByAt,
  replyByProblem,
  replyByWords,
  samePrice,
  shownOnJob,
  subChoices,
  visitsForElsewhere,
  withdrawConfirm,
  withdrawnToast,
  type OfferState,
} from "../src/features/subs/offers";
import type { PayLine } from "../src/features/subs/pay";

// Newer ICU puts a narrow no-break space before AM/PM.
const plain = (s: string | null) => (s ?? "").replace(/ /g, " ");
const CHICAGO = "America/Chicago";
// Monday Nov 2, 2026, 2:30 PM in Chicago (CST, after the clocks went back on Nov 1).
const NOW = new Date("2026-11-02T20:30:00Z");
const pay = (patch: Partial<OfferState> = {}): OfferState => ({ status: "draft", total: 2040, ...patch });

describe("the office's buttons for a sub's pay", () => {
  it("send a draft as an offer, and still agree work done on the phone", () => {
    expect(offerActions(pay(), 1, NOW)).toEqual(["send", "accept", "delete"]);
    // While the sign-ins are being counted, Send shows; the database says if they have none.
    expect(offerActions(pay(), null, NOW)).toEqual(["send", "accept", "delete"]);
  });

  it("have no Send for a sub who doesn't sign in: the office agrees it with them", () => {
    expect(offerActions(pay(), 0, NOW)).toEqual(["accept", "delete"]);
    expect(offerActions(pay({ status: "accepted" }), 0, NOW)).toEqual(["done", "cancel"]);
  });

  it("withdraw an offer waiting for an answer (not cancel it), or agree it for them", () => {
    expect(offerActions(pay({ status: "offered", respond_by: "2026-11-03T18:00:00Z" }), 1, NOW)).toEqual(["accept", "withdraw"]);
    expect(offerActions(pay({ status: "offered" }), 1, NOW)).toEqual(["accept", "withdraw"]);
  });

  it("change an agreed price, take back a new price, or cancel the pay while it waits", () => {
    expect(offerActions(pay({ status: "accepted" }), 1, NOW)).toEqual(["done", "change", "cancel"]);
    const change = pay({ status: "offered", total: 2210, accepted_snapshot: { total: 2040 } });
    expect(offerActions(change, 1, NOW)).toEqual(["accept", "withdraw", "cancel"]);
    expect(offerActionLabel("withdraw", change)).toBe("Withdraw new price");
    expect(offerActionLabel("withdraw", pay({ status: "offered" }))).toBe("Withdraw offer");
    expect(offerActionLabel("change", pay({ status: "accepted" }))).toBe("Change price");
  });

  it("offer the job to someone else after a decline or no answer in time", () => {
    expect(offerActions(pay({ status: "declined" }), 1, NOW)).toEqual(["other", "delete"]);
    expect(offerActions(pay({ status: "expired" }), 1, NOW)).toEqual(["other", "delete"]);
    // Past its time and not marked yet by the hourly upkeep: it can't be answered any more.
    expect(offerActions(pay({ status: "offered", respond_by: "2026-11-02T20:00:00Z" }), 1, NOW)).toEqual(["other"]);
    expect(offerActionLabel("other", pay({ status: "declined" }))).toBe("Offer someone else");
    expect(offerActions(pay({ status: "withdrawn" }), 1, NOW)).toEqual(["delete"]);
  });

  it("are the usual ones once the work's done or paid", () => {
    expect(offerActions(pay({ status: "done" }), 1, NOW)).toEqual(["paid", "cancel"]);
    expect(offerActions(pay({ status: "paid" }), 1, NOW)).toEqual(["unpaid"]);
    expect(offerActions(pay({ status: "cancelled" }), 1, NOW)).toEqual(["delete"]);
  });

  it("a new price that ran out, not marked yet, can be withdrawn now (the work is marked done once it's agreed again)", () => {
    const late = pay({ status: "offered", respond_by: "2026-11-02T20:00:00Z", accepted_snapshot: { total: 2040 } });
    expect(ranOut(late, NOW)).toBe(true);
    // Still "offered" until the hourly upkeep: Mark work done would be refused ("Agree the pay first").
    expect(offerActions(late, 1, NOW)).toEqual(["withdraw", "cancel"]);
    expect(offerActions({ ...late, status: "accepted" }, 1, NOW)).toEqual(["done", "change", "cancel"]);
  });

  it("agreeing a new price for them says so first, with both prices", () => {
    const change = pay({ status: "offered", total: 1800, accepted_snapshot: { total: 2040 } });
    expect(AGREE_CHANGE_LABEL).toBe("Agree new price");
    expect(agreeChangeConfirm(change, "Apex Roofing")).toEqual({
      title: "Agree the new price for them?",
      body: "This sets Apex Roofing's price to $1,800 (was $2,040) without waiting for their answer. They're told.",
      confirmLabel: "Agree new price",
      cancelLabel: "Wait for them",
    });
  });

  it("withdraw an offer with one word throughout: button, question and toast", () => {
    const first = withdrawConfirm(pay({ status: "offered" }), "Apex Roofing");
    expect(first).toMatchObject({ title: "Withdraw the offer?", confirmLabel: "Withdraw", danger: true });
    expect(first.body).toBe("Apex Roofing is told it was withdrawn. To offer the job again, to them or someone else, add new pay.");
    const change = withdrawConfirm(pay({ status: "offered", total: 2210, accepted_snapshot: { total: 2040 } }), "Apex Roofing");
    expect(change).toMatchObject({ title: "Withdraw the new price?", body: "The price they agreed ($2,040) stays, and Apex Roofing is told.", danger: false });
    expect(withdrawnToast("Apex Roofing")).toBe("Withdrawn. Apex Roofing has been told.");
  });

  it("promise only what their settings allow about how an offer reaches them", () => {
    expect(reachWords(false)).toBe("They get it in Crewtavo, and by email as their notification settings allow. They accept or decline it in one tap.");
    expect(reachWords(true)).toBe("They get it in Crewtavo, and by email or text as their notification settings allow. They accept or decline it in one tap.");
  });
});

describe("offering the job to someone else", () => {
  it("starts with the visits the offer that ended covered, less any cancelled since", () => {
    const visits = [{ id: "v1", status: "scheduled" }, { id: "v2", status: "cancelled" }, { id: "v3", status: "completed" }];
    expect(visitsForElsewhere(["v1", "v2", "v3", "gone"], visits)).toEqual(["v1", "v3"]);
    expect(visitsForElsewhere([], visits)).toEqual([]);
  });

  it("lists subs with their paperwork, those in order first", () => {
    const ok: PaperworkRow[] = [
      { requirement: "w9", state: "ok", expires_on: null, days_left: null, verified: true },
      { requirement: "liability", state: "ok", expires_on: "2027-06-01", days_left: 200, verified: true },
      { requirement: "workers_comp", state: "ok", expires_on: "2027-06-01", days_left: 200, verified: true },
    ];
    const lapsed: PaperworkRow[] = [ok[0]!, ok[1]!, { requirement: "workers_comp", state: "expired", expires_on: "2026-10-01", days_left: -31, verified: true }];
    expect(paperworkWords(ok)).toBeNull();
    expect(paperworkWords(lapsed)).toBe("Workers' comp expired");
    expect(paperworkWords([])).toBe("W-9 missing, Liability insurance missing, Workers' comp missing");
    expect(paperworkWords([{ ...ok[0]! }, { ...ok[1]!, verified: false }, { ...ok[2]!, state: "expiring", days_left: 12 }])).toBe("Liability insurance not verified yet, Workers' comp expires in 12 days");
    const subs = [
      { id: "a", name: "Apex Roofing", trade: "roofing", active: true },
      { id: "b", name: "Birch Gutters", trade: null, active: true },
      { id: "c", name: "Cedar Siding", trade: null, active: false },
    ];
    const papers: Record<string, PaperworkRow[]> = { a: lapsed, b: ok };
    expect(subChoices(subs, (id) => papers[id] ?? [])).toEqual([
      { id: "b", name: "Birch Gutters", ok: true },
      { id: "a", name: "Apex Roofing (roofing) · Workers' comp expired", ok: false },
    ]);
    // The paperwork not in yet: names only, in order.
    expect(subChoices(subs, null).map((c) => c.name)).toEqual(["Apex Roofing (roofing)", "Birch Gutters"]);
  });
});

describe("a sub's pay on the job: chip and line", () => {
  it("say each offer's state in plain words", () => {
    const label = (p: OfferState) => offerChip(p, "sub", NOW).label;
    expect(label(pay({ status: "offered", respond_by: "2026-11-03T18:00:00Z" }))).toBe("Offered, waiting for an answer");
    expect(label(pay({ status: "accepted" }))).toBe("Accepted");
    expect(label(pay({ status: "declined" }))).toBe("Declined");
    expect(label(pay({ status: "expired" }))).toBe("No answer in time");
    expect(label(pay({ status: "offered", respond_by: "2026-11-02T20:00:00Z" }))).toBe("No answer in time");
    expect(label(pay({ status: "withdrawn" }))).toBe("Withdrawn");
    expect(label(pay({ status: "offered", accepted_snapshot: { total: 2040 } }))).toBe("New price waiting");
    expect(label(pay({ status: "done" }))).toBe("Work done");
    expect(label(pay({ status: "draft" }))).toBe("Draft");
    // A team member's pay reads as before.
    expect(offerChip(pay({ status: "accepted" }), "team", NOW).label).toBe("Agreed");
  });

  it("give the time to answer by in the company's time zone", () => {
    expect(plain(offerLine(pay({ status: "offered", offered_at: "2026-11-02T19:00:00Z", respond_by: "2026-11-03T18:00:00Z" }), CHICAGO, NOW)))
      .toBe("Sent Nov 2, 2026. They answer by Tue, Nov 3, 12:00 PM.");
    expect(plain(offerLine(pay({ status: "offered", offered_at: "2026-11-02T19:00:00Z" }), CHICAGO, NOW))).toBe("Sent Nov 2, 2026. No deadline.");
    // 1 AM UTC on the 3rd is still the 2nd in Chicago.
    expect(plain(offerLine(pay({ status: "offered", offered_at: "2026-11-03T01:00:00Z" }), CHICAGO, NOW))).toBe("Sent Nov 2, 2026. No deadline.");
  });

  it("give the reason a sub turned it down", () => {
    expect(offerLine(pay({ status: "declined", answered_at: "2026-11-02T16:00:00Z", decline_reason: "Booked that week" }), CHICAGO, NOW))
      .toBe('They declined it Nov 2, 2026. They said: "Booked that week".');
    expect(offerLine(pay({ status: "declined", answered_at: "2026-11-02T16:00:00Z" }), CHICAGO, NOW)).toBe("They declined it Nov 2, 2026.");
  });

  it("say when nobody answered, or the office withdrew it", () => {
    expect(plain(offerLine(pay({ status: "expired", respond_by: "2026-11-02T18:00:00Z" }), CHICAGO, NOW))).toBe("They didn't answer by Mon, Nov 2, 12:00 PM.");
    expect(plain(offerLine(pay({ status: "offered", respond_by: "2026-11-02T18:00:00Z" }), CHICAGO, NOW))).toBe("They didn't answer by Mon, Nov 2, 12:00 PM.");
    expect(offerLine(pay({ status: "withdrawn", answered_at: "2026-11-02T16:00:00Z" }), CHICAGO, NOW)).toBe("You withdrew the offer Nov 2, 2026.");
  });

  it("show a new price waiting beside the agreed one, and that the agreed one stays if it isn't taken", () => {
    expect(plain(offerLine(pay({ status: "offered", total: 2210, accepted_snapshot: { total: 2040 } }), CHICAGO, NOW)))
      .toBe("New price waiting: $2,210 (agreed $2,040). No deadline. If they say no, the agreed price stays.");
    expect(offerLine(pay({ status: "accepted", offer_outcome: "declined", answered_at: "2026-11-02T16:00:00Z" }), CHICAGO, NOW))
      .toBe("They declined the new price Nov 2, 2026, so the price they agreed stands.");
    expect(offerLine(pay({ status: "accepted", offer_outcome: "expired" }), CHICAGO, NOW)).toMatch(/didn't answer the new price in time/);
    expect(offerLine(pay({ status: "accepted", offer_outcome: "withdrawn", answered_at: "2026-11-02T16:00:00Z" }), CHICAGO, NOW)).toBe("You withdrew the new price Nov 2, 2026. The price they agreed stands.");
    expect(offerLine(pay({ status: "accepted", offer_outcome: "accepted", answered_at: "2026-11-02T16:00:00Z" }), CHICAGO, NOW)).toBe("They accepted Nov 2, 2026.");
    // Agreed without an offer, and done or paid: the usual line under it.
    expect(offerLine(pay({ status: "accepted" }), CHICAGO, NOW)).toBeNull();
    expect(offerLine(pay({ status: "done" }), CHICAGO, NOW)).toBeNull();
  });

  it("count a new price waiting at the agreed price in what's agreed on the job", () => {
    const change = pay({ status: "offered", total: 2210, accepted_snapshot: { total: 2040 } });
    expect(countsAsAgreed(change)).toBe(true);
    expect(agreedAmount(change)).toBe(2040);
    expect(countsAsAgreed(pay({ status: "offered" }))).toBe(false);
    expect(agreedAmount({ ...pay({ status: "paid" }), paid_amount: 2000 })).toBe(2000);
    expect(agreedAmount(pay({ status: "accepted" }))).toBe(2040);
  });
});

describe("the time to answer by", () => {
  it("is none, in 2 hours, the end of today or tomorrow at noon, by the company's clock", () => {
    expect(replyByAt("none", CHICAGO, NOW)).toBeNull();
    expect(replyByAt("2h", CHICAGO, NOW)).toBe("2026-11-02T22:30:00.000Z");
    // 11:59 PM Nov 2 in Chicago (CST, UTC-6).
    expect(replyByAt("today", CHICAGO, NOW)).toBe("2026-11-03T05:59:00.000Z");
    expect(replyByAt("noon", CHICAGO, NOW)).toBe("2026-11-03T18:00:00.000Z");
    // The same moment in Denver is an hour behind Chicago's clock.
    expect(replyByAt("noon", "America/Denver", NOW)).toBe("2026-11-03T19:00:00.000Z");
  });

  it("goes by the company's day, not UTC's", () => {
    // 9 PM Nov 2 in Chicago is 3 AM Nov 3 in UTC: today is still the 2nd.
    const evening = new Date("2026-11-03T03:00:00Z");
    expect(replyByAt("today", CHICAGO, evening)).toBe("2026-11-03T05:59:00.000Z");
    expect(replyByAt("noon", CHICAGO, evening)).toBe("2026-11-03T18:00:00.000Z");
  });

  it("follows the clocks changing overnight", () => {
    // 3 PM Oct 31 (CDT, UTC-5); noon tomorrow is after the clocks go back (CST, UTC-6).
    expect(replyByAt("noon", CHICAGO, new Date("2026-10-31T20:00:00Z"))).toBe("2026-11-01T18:00:00.000Z");
  });

  it("takes a day and time picked, in the company's time zone", () => {
    expect(replyByAt("pick", CHICAGO, NOW, { date: "2026-11-05", time: "17:00" })).toBe("2026-11-05T23:00:00.000Z");
    expect(replyByAt("pick", CHICAGO, NOW, { date: "", time: "17:00" })).toBeNull();
    expect(replyByAt("pick", CHICAGO, NOW, { date: "2026-11-05", time: "" })).toBeNull();
  });

  it("must be still to come and within 90 days", () => {
    expect(replyByProblem("none", null, NOW)).toBeNull();
    expect(replyByProblem("pick", null, NOW)).toBe("Pick a day and a time.");
    expect(replyByProblem("pick", "2026-11-02T20:00:00.000Z", NOW)).toBe("Pick a time to answer by that's still to come.");
    expect(replyByProblem("pick", "2027-02-15T20:00:00.000Z", NOW)).toBe("Give them at most 90 days to answer.");
    expect(replyByProblem("noon", replyByAt("noon", CHICAGO, NOW), NOW)).toBeNull();
  });

  it("is said in words under the choice", () => {
    expect(plain(replyByWords("2026-11-03T18:00:00.000Z", CHICAGO))).toBe("They answer by Tue, Nov 3, 12:00 PM. If they don't, it runs out and you'll hear.");
    expect(replyByWords(null, CHICAGO)).toBe("It waits until they answer, or you withdraw it.");
  });
});

describe("which pay shows on the job", () => {
  const row = (id: string, status: string, created_at: string, subcontractor_id: string | null = "s1") => ({ id, status, created_at, subcontractor_id });

  it("keeps a turned-down offer in sight until the job is offered to someone else", () => {
    const declined = row("a", "declined", "2026-11-01T10:00:00Z");
    expect(shownOnJob([declined]).shown.map((p) => p.id)).toEqual(["a"]);
    const next = row("b", "draft", "2026-11-02T10:00:00Z", "s2");
    const { shown, hidden } = shownOnJob([declined, next]);
    expect(shown.map((p) => p.id)).toEqual(["b"]);
    expect(hidden.map((p) => p.id)).toEqual(["a"]);
  });

  it("hides cancelled pay, and keeps what's in play", () => {
    const { shown, hidden } = shownOnJob([row("a", "cancelled", "2026-11-01T10:00:00Z"), row("b", "accepted", "2026-11-01T11:00:00Z"), row("c", "expired", "2026-11-01T12:00:00Z", "s3")]);
    expect(shown.map((p) => p.id)).toEqual(["b", "c"]);
    expect(hidden.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("a new price for agreed pay", () => {
  const lines: PayLine[] = [
    { id: "l1", description: "Architectural shingles", basis: "per_unit", unit: "sq", quantity: 24, rate: 75, amount: 1800, service_id: "svc", pay_rate_id: "r1", sort: 1 },
    { id: "l2", description: "Haul-off", basis: "per_job", unit: "job", quantity: 1, rate: 240, amount: 240, pay_rate_id: null, sort: 2 },
  ];

  it("starts from the agreed lines and keeps what they came from", () => {
    const drafts = priceDrafts(lines);
    expect(drafts[0]).toMatchObject({ description: "Architectural shingles", quantity: "24", rate: "75", basis: "per_unit", unit: "sq", service_id: "svc", pay_rate_id: "r1" });
    expect(samePrice(drafts, lines)).toBe(true);
    expect(priceTotal(drafts)).toBe(2040);
  });

  it("goes out as change_sub_offer takes it once something's changed", () => {
    const drafts = priceDrafts(lines).map((d) => (d.key === "l1" ? { ...d, rate: "82.5" } : d));
    expect(samePrice(drafts, lines)).toBe(false);
    expect(priceTotal(drafts)).toBe(2220);
    expect(priceLines(drafts).lines).toEqual([
      { description: "Architectural shingles", basis: "per_unit", unit: "sq", quantity: 24, rate: 82.5, service_id: "svc", pay_rate_id: "r1" },
      { description: "Haul-off", basis: "per_job", unit: "job", quantity: 1, rate: 240, service_id: null, pay_rate_id: null },
    ]);
    expect(samePrice([...priceDrafts(lines), otherWork("n1")], lines)).toBe(false);
  });

  it("says what's wrong with a line", () => {
    expect(priceLines([]).problem).toBe("Add what you'll pay them.");
    expect(priceLines([{ ...otherWork("n1"), description: " " }]).problem).toBe("Give each line a description (200 characters at most).");
    expect(priceLines([{ ...otherWork("n1"), rate: "abc" }]).problem).toBe('Check the quantity and rate on "Other work".');
  });
});

// ---------------------------------------------------------------------------------------------
// The sub's My jobs
// ---------------------------------------------------------------------------------------------

const offer = (patch: Partial<SubOffer> = {}): SubOffer => ({
  id: "p1",
  company_id: "c1",
  subcontractor_id: "s1",
  job_id: "j1",
  job_title: "Smith roof",
  city: "Springfield",
  region: "IL",
  status: "offered",
  is_change: false,
  can_answer: true,
  total: 2040,
  lines: [
    { description: "Haul-off", basis: "per_job", unit: "job", quantity: 1, rate: 240, amount: 240 },
    { description: "Architectural shingles", basis: "per_unit", unit: "sq", quantity: 24, rate: 75, amount: 1800 },
  ],
  agreed_total: null,
  agreed_lines: null,
  visits: [{ id: "v1", scheduled_on: "2026-11-03", starts_at: "2026-11-03T13:00:00Z", ends_at: null, status: "scheduled" }],
  scope: [{ name: "Architectural shingles", description: null, quantity: 24, unit: "sq" }],
  notes: null,
  respond_by: null,
  offered_at: "2026-11-02T15:00:00Z",
  offer_round: 1,
  outcome: null,
  answered_at: null,
  decline_reason: null,
  insurance_warning: [],
  earned_on: null,
  paid_at: null,
  paid_amount: null,
  ...patch,
});

describe("an offer's card", () => {
  it("reads job · day · town · squares · price", () => {
    expect(offerCardLine(offer())).toBe("Smith roof · Tue Nov 3 · Springfield · 24 squares · $2,040");
  });

  it("gives the first and last day of several, and leaves out what isn't known", () => {
    const days = offer({
      visits: [
        { id: "v2", scheduled_on: "2026-11-05", starts_at: null, ends_at: null, status: "scheduled" },
        { id: "v1", scheduled_on: "2026-11-03", starts_at: null, ends_at: null, status: "scheduled" },
      ],
    });
    expect(offerCardLine(days)).toBe("Smith roof · Tue Nov 3 to Thu Nov 5 · Springfield · 24 squares · $2,040");
    expect(offerCardLine(offer({ visits: [], city: null, region: null, lines: [{ description: "Gutters", basis: "per_job", unit: "job", quantity: 1, rate: 450.5, amount: 450.5 }], total: 450.5 })))
      .toBe("Smith roof · $450.50");
    expect(offerCardLine(offer({ city: null }))).toBe("Smith roof · Tue Nov 3 · IL · 24 squares · $2,040");
  });
});

describe("My jobs' sections", () => {
  it("puts offers to answer at the top, soonest deadline first", () => {
    const list = [offer({ id: "a" }), offer({ id: "b", respond_by: "2026-11-04T00:00:00Z" }), offer({ id: "c", respond_by: "2026-11-03T00:00:00Z" })];
    expect(myJobSections(list, NOW).waiting.map((o) => o.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts the rest into coming up, done and owed, paid, and over", () => {
    expect(myJobSection(offer({ status: "accepted" }))).toBe("upcoming");
    expect(myJobSection(offer({ status: "done" }))).toBe("done");
    expect(myJobSection(offer({ status: "paid" }))).toBe("paid");
    expect(myJobSection(offer({ status: "declined" }))).toBe("over");
    expect(myJobSection(offer({ status: "withdrawn" }))).toBe("over");
    expect(myJobSection(offer({ status: "expired" }))).toBe("over");
    expect(myJobSection(offer({ status: "cancelled" }))).toBeNull();
    // Past its time: a first offer is over; a new price leaves the agreed work coming up.
    expect(myJobSection(offer({ can_answer: false }))).toBe("over");
    expect(myJobSection(offer({ can_answer: false, is_change: true }))).toBe("upcoming");
    expect(myJobSection(offer({ is_change: true }))).toBe("waiting");
  });

  it("drops offers that ended over 30 days ago", () => {
    const sections = myJobSections([offer({ id: "old", status: "declined", answered_at: "2026-09-01T00:00:00Z" }), offer({ id: "new", status: "declined", answered_at: "2026-10-30T00:00:00Z" })], NOW);
    expect(sections.over.map((o) => o.id)).toEqual(["new"]);
  });

  it("lists what's owed and paid, newest payment first", () => {
    const list = [
      offer({ id: "d", status: "done", total: 900, earned_on: "2026-10-30" }),
      offer({ id: "p1", status: "paid", paid_at: "2026-10-01T15:00:00Z", paid_amount: 1000 }),
      offer({ id: "p2", status: "paid", paid_at: "2026-10-20T15:00:00Z", paid_amount: 500 }),
    ];
    expect(myJobSections(list, NOW).paid.map((o) => o.id)).toEqual(["p2", "p1"]);
  });
});

describe("this year's total", () => {
  // The server counts it (my_sub_pay_totals, by the company's calendar), as the list holds only recent pay.
  it("says the server's total for the year, and what's owed only when something is", () => {
    expect(totalsWords({ year: 2026, paid: 54210, payments: 521, owed: 2210, owed_jobs: 1 })).toEqual({ paid: "$54,210.00 in 2026", owed: "$2,210.00 owed" });
    expect(totalsWords({ year: 2027, paid: 0, payments: 0, owed: 0, owed_jobs: 0 })).toEqual({ paid: "$0.00 in 2027", owed: null });
    // Not in yet: nothing rather than a wrong total.
    expect(totalsWords(undefined)).toEqual({ paid: null, owed: null });
  });

  it("says how much counts toward their 1099 when card or app payments make it less, and to ask for one only when it's needed", () => {
    const base = "This year's total goes by the day you were paid, and counts every payment, not only the latest ones here.";
    expect(paidTotalNote({ year: 2026, paid: 54210, payments: 521, owed: 0, owed_jobs: 0, counted: 54210 }, "Romeo Roofing")).toBe(`${base} Ask Romeo Roofing for your 1099.`);
    expect(paidTotalNote({ year: 2026, paid: 5400, payments: 3, owed: 0, owed_jobs: 0, counted: 3000 }, "Romeo Roofing")).toBe(
      `${base} $3,000.00 of it counts toward your 1099: card and payment-app payments are reported on a 1099-K instead. Ask Romeo Roofing for your 1099.`,
    );
    // Under the year's amount (2026: $2,000), or all by card: no 1099 to ask for.
    expect(paidTotalNote({ year: 2026, paid: 1500, payments: 1, owed: 0, owed_jobs: 0, counted: 1500 }, "Romeo Roofing")).toBe(base);
    expect(paidTotalNote({ year: 2026, paid: 2400, payments: 1, owed: 0, owed_jobs: 0, counted: 0 }, "Romeo Roofing")).toBe(
      `${base} $0.00 of it counts toward your 1099: card and payment-app payments are reported on a 1099-K instead.`,
    );
    expect(paidTotalNote(undefined, "Romeo Roofing")).toBe(base);
  });
});

describe("a link to an offer that isn't here", () => {
  it("offers to switch when it's from another company they work for, and otherwise doesn't guess why", () => {
    expect(missingOfferNote({ id: "sierra", name: "Sierra Paving" }, "romeo")).toEqual({ text: "This job offer is from Sierra Paving.", switchTo: "sierra" });
    expect(missingOfferNote(null, "romeo")).toEqual({ text: "We can't find that job here. It may be over. Call the office if you're not sure.", switchTo: null });
    expect(missingOfferNote({ id: "romeo", name: "Romeo Roofing" }, "romeo").switchTo).toBeNull();
  });
});

describe("answering an offer", () => {
  it("needs signal: no signal disables Accept and Decline and says so", () => {
    expect(answerState(true, offer())).toEqual({ disabled: false, note: null });
    const off = answerState(false, offer());
    expect(off.disabled).toBe(true);
    expect(off.note).toBe("No signal. You can accept or decline this job once you have signal.");
  });

  it("can't be done once it ran out", () => {
    expect(answerState(true, offer({ can_answer: false }))).toEqual({ disabled: true, note: "This offer ran out. Call the office if you'd still like the work." });
  });

  it("says what happens next", () => {
    expect(answeredToast(true, offer())).toBe("Smith roof accepted, it's on My day");
    expect(answeredToast(false, offer())).toBe("Job declined, the office knows");
    expect(answeredToast(false, offer({ is_change: true, agreed_total: 2040 }))).toBe("New price declined, Smith roof stays at $2,040");
    expect(answeredToast(true, offer({ is_change: true, agreed_total: 2040 }))).toBe("New price accepted for Smith roof");
  });
});
