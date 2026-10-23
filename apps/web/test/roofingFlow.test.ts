import { describe, expect, it } from "vitest";
import { readApproval } from "../src/features/documents/build";
import { currentStep, STEPS, type TakeoffRow } from "../src/features/paving/data";
import { ROOF_STEPS, roofStep, type RoofStepQuote } from "../src/features/roofing/data";
import {
  autoApplyKey,
  canMarkAgreed,
  copySentence,
  dayText,
  depositLabel,
  documentFacts,
  estimateShare,
  estimateSubject,
  homeownerName,
  isSignedCopy,
  notesTitle,
  onWhen,
  personName,
  rangeIntro,
  rangeOutdated,
  rangePill,
  rangeState,
  rangeStepStatus,
  salesPeople,
  signedHeadline,
  signedSentence,
  skippedNote,
  visitStepStatus,
  type RangeQuote,
  type TeamMember,
  type VisitQuote,
} from "../src/features/roofing/flow/model";

const TZ = "America/New_York";
// Friday Oct 24 2026, 3 PM in New York.
const NOW = new Date("2026-10-24T19:00:00Z");

const takeoff = { id: "m1" };
const roofQuote = (patch: Partial<RoofStepQuote> = {}): RoofStepQuote => ({ status: "draft", lines: [{}], jobs: [], range_low: null, range_accepted_at: null, priced_on_site_at: null, ...patch });
const range = (patch: Partial<RangeQuote & { lines: unknown[] }> = {}): RangeQuote & { lines: unknown[] } => ({
  status: "draft",
  total: 18304,
  range_low: null,
  range_high: null,
  range_sent_at: null,
  range_accepted_at: null,
  priced_on_site_at: null,
  lines: [{}],
  ...patch,
});
const out = { status: "sent", range_low: 18300, range_high: 21050, range_sent_at: "2026-10-22T13:20:00Z" };

describe("the roofing project's steps", () => {
  it("has six steps of its own, and paving keeps its five", () => {
    expect(ROOF_STEPS.map((s) => s.id)).toEqual(["takeoff", "estimate", "range", "visit", "schedule", "invoice"]);
    expect(ROOF_STEPS.map((s) => s.label)).toEqual(["Measure", "Estimate", "Range", "Site visit", "Schedule", "Invoice"]);
    expect(STEPS.map((s) => s.id)).toEqual(["takeoff", "estimate", "proposal", "schedule", "invoice"]);
  });

  it("measures, then prices, then sends the range", () => {
    expect(roofStep(null, null)).toBe("takeoff");
    expect(roofStep(roofQuote(), null)).toBe("takeoff");
    expect(roofStep(roofQuote({ lines: [] }), takeoff)).toBe("estimate");
    expect(roofStep(roofQuote(), takeoff)).toBe("range");
    // A range saved on a draft whose email didn't go out still has to be sent.
    expect(roofStep(roofQuote({ range_low: 18300 }), takeoff)).toBe("range");
  });

  it("waits on the range until the homeowner says yes, then it's the site visit", () => {
    expect(roofStep(roofQuote({ status: "sent", range_low: 18300 }), takeoff)).toBe("range");
    expect(roofStep(roofQuote({ status: "changes_requested", range_low: 18300 }), takeoff)).toBe("range");
    expect(roofStep(roofQuote({ status: "sent", range_low: 18300, range_accepted_at: "2026-10-23T23:41:00Z" }), takeoff)).toBe("visit");
  });

  it("goes to the site visit when the exact price went out instead, or it was priced on site", () => {
    expect(roofStep(roofQuote({ status: "sent" }), takeoff)).toBe("visit");
    expect(roofStep(roofQuote({ status: "sent", range_low: 18300, priced_on_site_at: "2026-10-24T18:00:00Z" }), takeoff)).toBe("visit");
    // Priced on site before anything was sent.
    expect(roofStep(roofQuote({ priced_on_site_at: "2026-10-24T18:00:00Z" }), takeoff)).toBe("visit");
    // The office sent the exact price while the range was out.
    expect(roofStep(roofQuote({ status: "sent", range_low: 18300, exact_sent_at: "2026-10-23T14:00:00Z" }), takeoff)).toBe("visit");
  });

  it("schedules once signed, then invoices, then it's done", () => {
    expect(roofStep(roofQuote({ status: "approved" }), takeoff)).toBe("schedule");
    expect(roofStep(roofQuote({ status: "converted", jobs: [] }), takeoff)).toBe("schedule");
    expect(roofStep(roofQuote({ status: "converted", jobs: [{ status: "active" }] }), takeoff)).toBe("invoice");
    expect(roofStep(roofQuote({ status: "converted", jobs: [{ status: "active" }] }), takeoff, [{ status: "sent" }])).toBe("invoice");
    expect(roofStep(roofQuote({ status: "converted", jobs: [{ status: "completed" }] }), takeoff, [{ status: "paid" }, { status: "void" }])).toBe("done");
  });

  it("leaves paving's steps as they were", () => {
    const m = {} as TakeoffRow;
    expect(currentStep({ status: "draft", lines: [{}], jobs: [] }, m)).toBe("proposal");
    expect(currentStep({ status: "approved", lines: [{}], jobs: [] }, m)).toBe("schedule");
    expect(currentStep({ status: "converted", lines: [{}], jobs: [{ id: "j", status: "completed" }] }, m, [{ status: "paid" }])).toBe("done");
  });
});

describe("where the range stands", () => {
  it("knows each state", () => {
    expect(rangeState(range())).toBe("unsent");
    expect(rangeState(range({ range_low: 18300, range_high: 21050 }))).toBe("unsent");
    expect(rangeState(range(out))).toBe("waiting");
    expect(rangeState(range({ ...out, range_accepted_at: "2026-10-23T23:41:00Z" }))).toBe("accepted");
    expect(rangeState(range({ status: "sent" }))).toBe("exact");
    expect(rangeState(range({ ...out, priced_on_site_at: "2026-10-24T18:00:00Z" }))).toBe("exact");
    expect(rangeState(range({ ...out, exact_sent_at: "2026-10-23T14:00:00Z" }))).toBe("exact");
    expect(rangeState(range({ ...out, status: "approved" }))).toBe("signed");
    expect(rangeState(range({ status: "converted" }))).toBe("signed");
    expect(rangeState(range({ status: "lost" }))).toBe("closed");
  });

  it("lets the office mark a yes only while the range is waiting for an answer", () => {
    expect(canMarkAgreed(range(out))).toBe(true);
    // They asked a question first, then said yes on the phone.
    expect(canMarkAgreed(range({ ...out, status: "changes_requested" }))).toBe(true);
    expect(canMarkAgreed(range())).toBe(false);
    // Saved on a draft but never delivered: they haven't seen it.
    expect(canMarkAgreed(range({ range_low: 18300, range_high: 21050 }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, range_accepted_at: "2026-10-23T23:41:00Z" }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, exact_sent_at: "2026-10-23T14:00:00Z" }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, priced_on_site_at: "2026-10-24T18:00:00Z" }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, status: "approved" }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, status: "lost" }))).toBe(false);
    expect(canMarkAgreed(range({ status: "sent" }))).toBe(false);
  });

  it("notices the estimate changed since the range went out", () => {
    const settings = { pct: 15, round: 50 };
    expect(rangeOutdated(range(out), settings)).toBe(false);
    expect(rangeOutdated(range({ ...out, total: 18950 }), settings)).toBe(true);
    expect(rangeOutdated(range(), settings)).toBe(false);
  });

  it("says where the step is", () => {
    expect(rangeStepStatus(range({ lines: [] }), "Dana Whitfield", TZ, NOW)).toBe("After the estimate");
    expect(rangeStepStatus(range(), "Dana Whitfield", TZ, NOW)).toBe("Not sent yet");
    expect(rangeStepStatus(range(out), "Dana Whitfield", TZ, NOW)).toBe("Sent Oct 22, waiting on Dana");
    expect(rangeStepStatus(range({ ...out, range_accepted_at: "2026-10-23T23:41:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Dana said yes Oct 23");
    expect(rangeStepStatus(range({ status: "sent" }), "Dana Whitfield", TZ, NOW)).toBe("Skipped: the exact price went out");
    expect(rangeStepStatus(range({ status: "approved" }), null, TZ, NOW)).toBe("Skipped");
    expect(rangeStepStatus(range({ ...out, status: "approved" }), null, TZ, NOW)).toBe("Sent Oct 22");
    expect(rangeStepStatus(range(out), null, TZ, NOW)).toBe("Sent Oct 22, waiting on the homeowner");
    expect(rangeStepStatus(range({ ...out, exact_sent_at: "2026-10-23T14:00:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("The exact price went out Oct 23");
  });

  it("puts the year on dates from another year", () => {
    expect(dayText("2025-12-30T15:00:00Z", TZ, NOW)).toBe("Dec 30, 2025");
    expect(dayText("2026-10-24T02:00:00Z", TZ, NOW)).toBe("Oct 23");
  });

  it("splits the bar into the estimate and the room on top", () => {
    expect(estimateShare(18304, 21050)).toBeCloseTo(0.8695, 3);
    expect(estimateShare(100, 0)).toBe(1);
    expect(estimateShare(30000, 21050)).toBe(1);
  });

  it("says where a signed price sits on the range", () => {
    const r = { low: 18300, high: 21050 };
    expect(rangePill(19524, r)).toEqual({ label: "Inside the range", tone: "good" });
    expect(rangePill(21050, r).label).toBe("Inside the range");
    expect(rangePill(21050.01, r)).toEqual({ label: "Above the range", tone: "warning" });
    expect(rangePill(18000, r)).toEqual({ label: "Below the range", tone: "info" });
  });

  it("sends the range with the server's own words", () => {
    expect(rangeIntro({ low: 18300, high: 21050 })).toBe(
      "Thanks for having us look at your roof. From our measurements, your new roof will cost between $18,300 and $21,050. You can see what's included and let us know when you'd like us to come out:",
    );
    expect(estimateSubject("Ridgeline Roofing")).toBe("Your roof estimate from Ridgeline Roofing");
  });
});

describe("the site visit step", () => {
  const visit = (patch: Partial<VisitQuote> = {}): VisitQuote => ({ ...range(out), approved_at: null, approval: null, sent_at: "2026-10-22T13:20:00Z", ...patch });

  it("says where it stands before signing", () => {
    expect(visitStepStatus(visit({ lines: [] }), "Dana Whitfield", TZ, NOW)).toBe("After the estimate");
    expect(visitStepStatus(visit({ status: "draft", range_low: null, range_high: null }), "Dana Whitfield", TZ, NOW)).toBe("After the range");
    expect(visitStepStatus(visit(), "Dana Whitfield", TZ, NOW)).toBe("After Dana says yes");
    expect(visitStepStatus(visit({ range_accepted_at: "2026-10-23T23:41:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Ready to book");
    expect(visitStepStatus(visit({ range_low: null, range_high: null }), "Dana Whitfield", TZ, NOW)).toBe("Sent Oct 22, waiting on Dana");
    expect(visitStepStatus(visit({ priced_on_site_at: "2026-10-24T18:00:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Priced on site Oct 24");
    // Sent from the office instead of the range: nobody priced it on site.
    expect(visitStepStatus(visit({ exact_sent_at: "2026-10-23T14:00:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Sent Oct 23, waiting on Dana");
    expect(visitStepStatus(visit({ range_accepted_at: "2026-10-23T12:00:00Z", exact_sent_at: "2026-10-23T14:00:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Sent Oct 23, waiting on Dana");
    expect(visitStepStatus(visit({ status: "lost" }), "Dana Whitfield", TZ, NOW)).toBe("Lost");
  });

  it("says who signed once it's signed", () => {
    const approval = readApproval({ name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", signed_at: "2026-10-24T18:14:00Z", method: "in_person" });
    expect(visitStepStatus(visit({ status: "approved", approved_at: "2026-10-24T18:14:00Z", approval }), "Dana Whitfield", TZ, NOW)).toBe("Signed Oct 24 by Dana Whitfield");
    const manual = readApproval({ name: "Sarah Lopez", method: "manual" });
    expect(visitStepStatus(visit({ status: "approved", approved_at: "2026-10-24T18:14:00Z", approval: manual }), "Dana Whitfield", TZ, NOW)).toBe("Marked approved Oct 24");
  });
});

describe("signed", () => {
  const company = { name: "Mike Torres", user_id: "u1", signature: "data:image/png;base64,BBBB", signed_at: "2026-10-24T18:14:00Z" };

  it("says how it was signed, and for how much", () => {
    expect(signedHeadline(readApproval({ name: "Dana", method: "in_person" }), 19524)).toBe("Signed on site for $19,524");
    expect(signedHeadline(readApproval({ name: "Dana", signature: "data:image/png;base64,AAAA" }), 19524.5)).toBe("Signed online for $19,524.50");
    expect(signedHeadline(readApproval({ name: "Sarah", method: "manual" }), 19524)).toBe("Marked approved for $19,524");
  });

  it("says who signed and when", () => {
    const onSite = readApproval({ name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", signed_at: "2026-10-23T18:14:00Z", method: "in_person", company });
    expect(signedSentence(onSite, null, "Ridgeline Roofing", TZ, NOW)).toBe("Dana Whitfield and Mike Torres signed yesterday at 2:14 PM.");
    const earlier = readApproval({ name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", signed_at: "2026-10-20T18:14:00Z", method: "in_person" });
    expect(signedSentence(earlier, null, "Ridgeline Roofing", TZ, NOW)).toBe("Dana Whitfield signed on Oct 20 at 2:14 PM.");
    const online = readApproval({ name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", signed_at: "2026-10-24T13:12:00Z", company });
    expect(signedSentence(online, null, "Ridgeline Roofing", TZ, NOW)).toBe("Dana Whitfield signed online today at 9:12 AM. Mike Torres signed for Ridgeline Roofing.");
    const manual = readApproval({ name: "Sarah Lopez", method: "manual" });
    expect(signedSentence(manual, "2026-10-24T13:12:00Z", "Ridgeline Roofing", TZ, NOW)).toBe("Sarah Lopez marked it approved today at 9:12 AM, without a signature.");
    expect(onWhen("2026-10-20T18:14:00Z", TZ, NOW)).toBe("on Oct 20 at 2:14 PM");
  });

  it("finds the signed copies that went out", () => {
    expect(isSignedCopy({ channel: "email", subject: "Your signed estimate from Ridgeline Roofing" })).toBe(true);
    expect(isSignedCopy({ channel: "sms", subject: "Signed estimate #1042" })).toBe(true);
    expect(isSignedCopy({ channel: "email", subject: "Your roof estimate from Ridgeline Roofing" })).toBe(false);
    expect(copySentence([{ channel: "email" }], "Dana Whitfield")).toBe("A copy was emailed to Dana.");
    expect(copySentence([{ channel: "sms" }], "Dana Whitfield")).toBe("A link to it was texted to Dana.");
    expect(copySentence([{ channel: "email" }, { channel: "sms" }], null)).toBe("A copy was emailed and texted to the homeowner.");
    expect(copySentence([], "Dana")).toBeNull();
  });
});

describe("the job", () => {
  it("names the deposit and its share when it's a round one", () => {
    expect(depositLabel(5857.2, 19524)).toBe("Bill the 30% deposit, $5,857.20");
    expect(depositLabel(5000, 20000)).toBe("Bill the 25% deposit, $5,000");
    expect(depositLabel(1000, 0)).toBe("Bill the deposit, $1,000");
  });
});

describe("the team", () => {
  const team: TeamMember[] = [
    { user_id: "u1", role: "estimator", active: true, profile: { full_name: "Mike Torres" } },
    { user_id: "u2", role: "office", active: true, profile: { full_name: "Sarah Lopez" } },
    { user_id: "u3", role: "field_crew", active: true, profile: { full_name: "Ana Cruz" } },
    { user_id: "u4", role: "estimator", active: false, profile: { full_name: "Jess Carver" } },
    { user_id: "u5", role: "owner", active: true, profile: { full_name: "", email: "boss@example.com" } },
  ];

  it("offers the people who price work, by name, keeping the one already picked", () => {
    expect(salesPeople(team).map((p) => p.name)).toEqual(["boss@example.com", "Mike Torres", "Sarah Lopez"]);
    expect(salesPeople(team, "u4").map((p) => `${p.name}${p.active ? "" : " (gone)"}`)).toEqual(["boss@example.com", "Jess Carver (gone)", "Mike Torres", "Sarah Lopez"]);
    expect(personName(team, "u1")).toBe("Mike Torres");
    expect(personName(team, "nobody")).toBeNull();
    expect(personName(undefined, "u1")).toBeNull();
  });

  it("titles the notes for whoever goes out", () => {
    expect(notesTitle("Mike Torres")).toBe("Notes for Mike");
    expect(notesTitle(null)).toBe("Notes for the site visit");
    expect(homeownerName("Dana Whitfield")).toBe("Dana");
    expect(homeownerName("  ")).toBe("the homeowner");
  });
});

describe("putting the package on", () => {
  const quote = { id: "q1", roof_package_id: "p1", lines: [] as unknown[] };
  const ready = { editable: true, busy: false, hadLines: false };

  it("puts it on once, for a measured estimate with a package and no lines", () => {
    expect(autoApplyKey(quote, takeoff, ready)).toBe("q1:p1:m1");
    expect(autoApplyKey({ ...quote, lines: [{}] }, takeoff, ready)).toBeNull();
    expect(autoApplyKey({ ...quote, roof_package_id: null }, takeoff, ready)).toBeNull();
    expect(autoApplyKey(quote, null, ready)).toBeNull();
    expect(autoApplyKey(quote, takeoff, { ...ready, editable: false })).toBeNull();
    // Not while edits are saving, and never for one whose lines were all taken off by hand.
    expect(autoApplyKey(quote, takeoff, { ...ready, busy: true })).toBeNull();
    expect(autoApplyKey(quote, takeoff, { ...ready, hadLines: true })).toBeNull();
    // A new measurement is a new try.
    expect(autoApplyKey(quote, { id: "m2" }, ready)).toBe("q1:p1:m2");
  });

  it("says what it left off", () => {
    expect(skippedNote([])).toBeNull();
    expect(skippedNote([{ name: "Steep roof charge", reason: "None on this roof" }])).toBe("Left off, with nothing to measure on this roof: Steep roof charge.");
    expect(skippedNote([
      { name: "Valley flashing", reason: "None on this roof" },
      { name: "Ridge vent", reason: "None on this roof" },
      { name: "Steep roof charge", reason: "None on this roof" },
      { name: "Drip edge", reason: "eave_ft has no value" },
    ])).toBe("Left off, with nothing to measure on this roof: Valley flashing, Ridge vent and Steep roof charge. Couldn't work out Drip edge from the roof. Check the measurements, then add it below.");
  });

  it("puts the package and the roof under the document's address", () => {
    expect(documentFacts("Architectural shingle", { roofing_squares: 22, roof_pitch: "6/12" })).toEqual(["Architectural shingle", "22.0 squares", "6/12 pitch"]);
    expect(documentFacts(null, { roofing_squares: null, roof_pitch: null })).toEqual([]);
    expect(documentFacts(" ", null)).toEqual([]);
  });
});
