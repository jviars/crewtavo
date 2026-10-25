import { describe, expect, it } from "vitest";
import {
  askingFor,
  documentState,
  endDateProblem,
  neededPaperwork,
  paperworkLinkIntro,
  paperworkLinkMessages,
  paperworkAlert,
  paperworkStatus,
  paperworkSummary,
  paperworkSummaryText,
  paperworkTone,
  subDocumentLabel,
  subSettings,
  taxClassificationLabel,
  uninsured,
  type PaperworkDocument,
} from "../src/subs";

const TODAY = "2026-10-25";
let n = 0;
const doc = (kind: string, expires_on: string | null, extra: Partial<PaperworkDocument> = {}): PaperworkDocument => ({
  id: `d${++n}`, kind, expires_on, verified_at: "2026-10-01T12:00:00Z", superseded_at: null, created_at: `2026-10-${String(n).padStart(2, "0")}T00:00:00Z`, ...extra,
});
const states = (docs: PaperworkDocument[], today = TODAY) => Object.fromEntries(paperworkStatus(docs, today).map((s) => [s.requirement, s.state]));

describe("subcontractor paperwork", () => {
  it("is missing until something is on file", () => {
    expect(states([])).toEqual({ w9: "missing", liability: "missing", workers_comp: "missing" });
    expect(paperworkStatus([], TODAY)[0]).toEqual({ requirement: "w9", state: "missing", document_id: null, kind: null, expires_on: null, days_left: null, verified: null, waiting: false });
  });

  it("goes by the company's today: OK, ending within 30 days (the day it ends too), then run out", () => {
    expect(documentState("2026-11-25", TODAY)).toBe("ok");
    expect(documentState("2026-11-24", TODAY)).toBe("expiring");
    expect(documentState(TODAY, TODAY)).toBe("expiring");
    expect(documentState("2026-10-24", TODAY)).toBe("expired");
    expect(documentState(null, TODAY)).toBe("ok");
    // The same certificate a day later, where the company's day has moved on.
    expect(states([doc("liability", TODAY)], "2026-10-26").liability).toBe("expired");
  });

  it("never runs a W-9 out, and counts a workers' comp exemption as cover", () => {
    const status = paperworkStatus([doc("w9", null), doc("wc_exemption", "2027-03-01"), doc("liability", "2026-11-01")], TODAY);
    expect(status.map((s) => [s.requirement, s.state, s.kind, s.days_left])).toEqual([
      ["w9", "ok", "w9", null],
      ["liability", "expiring", "liability", 7],
      ["workers_comp", "ok", "wc_exemption", 127],
    ]);
  });

  it("ignores replaced documents, and counts the one that runs longest", () => {
    const old = doc("liability", "2027-01-01", { superseded_at: "2026-10-20T00:00:00Z" });
    const lapsed = doc("workers_comp", "2026-10-01");
    const current = doc("workers_comp", "2026-12-31");
    const status = paperworkStatus([old, doc("liability", "2026-10-20"), lapsed, current], TODAY);
    expect(status.find((s) => s.requirement === "liability")?.state).toBe("expired");
    expect(status.find((s) => s.requirement === "workers_comp")?.document_id).toBe(current.id);
  });

  it("still counts paperwork the office hasn't checked, and says so", () => {
    const sent = doc("liability", "2027-06-01", { verified_at: null });
    const status = paperworkStatus([doc("liability", "2027-06-01"), sent], TODAY).find((s) => s.requirement === "liability")!;
    expect(status).toMatchObject({ state: "ok", verified: true, waiting: true }); // a checked one wins a tie
    expect(paperworkStatus([sent], TODAY).find((s) => s.requirement === "liability")).toMatchObject({ state: "ok", verified: false, waiting: true });
    // One that has run out isn't waiting for anything.
    expect(paperworkStatus([doc("w9", null), doc("liability", "2026-10-01", { verified_at: null })], TODAY).map((s) => s.waiting)).toEqual([false, false, false]);
  });

  it("counts a checked certificate before anything the sub sent, whatever its end date", () => {
    const checked = doc("liability", "2026-11-01");
    for (const sent of [doc("liability", "9999-12-31", { verified_at: null }), doc("wc_exemption", null, { verified_at: null })]) {
      const req = sent.kind === "liability" ? "liability" : "workers_comp";
      const status = paperworkStatus([{ ...checked, kind: sent.kind === "liability" ? "liability" : "workers_comp" }, sent], TODAY).find((s) => s.requirement === req)!;
      expect(status).toMatchObject({ state: "expiring", days_left: 7, verified: true, waiting: true, document_id: checked.id });
    }
    // Then by end date, then the newest, then the id, the way the view orders them.
    const a = doc("w9", null, { id: "a", created_at: "2026-10-01T00:00:00Z" });
    const b = doc("w9", null, { id: "b", created_at: "2026-10-01T00:00:00Z" });
    expect(paperworkStatus([a, b], TODAY)[0]!.document_id).toBe("b");
  });

  it("sums a sub up by the worst of it, and warns about insurance only", () => {
    expect(paperworkSummary(paperworkStatus([doc("w9", null), doc("liability", "2027-01-01"), doc("workers_comp", "2027-01-01")], TODAY))).toBe("ok");
    expect(paperworkSummary([{ state: "ok" }, { state: "expiring" }])).toBe("expiring");
    expect(paperworkSummary([{ state: "missing" }, { state: "expiring" }])).toBe("missing");
    expect(paperworkSummary([{ state: "missing" }, { state: "expired" }])).toBe("expired");
    expect(uninsured(paperworkStatus([doc("liability", "2026-10-01")], TODAY))).toEqual(["liability", "workers_comp"]);
    expect(paperworkTone("expiring")).toBe("warning");
    expect(paperworkTone("missing")).toBe("danger");
  });

  it("says when in a few words", () => {
    expect(paperworkSummaryText({ state: "missing", days_left: null })).toBe("Missing");
    expect(paperworkSummaryText({ state: "ok", days_left: null })).toBe("On file");
    expect(paperworkSummaryText({ state: "expiring", days_left: 12 })).toBe("Ends in 12 days");
    expect(paperworkSummaryText({ state: "expiring", days_left: 1 })).toBe("Ends tomorrow");
    expect(paperworkSummaryText({ state: "expiring", days_left: 0 })).toBe("Ends today");
    expect(paperworkSummaryText({ state: "expired", days_left: -1 })).toBe("Ran out yesterday");
    expect(paperworkSummaryText({ state: "expired", days_left: -3 })).toBe("Ran out 3 days ago");
  });

  it("reminds at 30 days, 7 days and on the day it ends", () => {
    // The same edges as supabase/tests/subcontractors_test.sql checks private.sub_alert_due() at.
    expect([45, 31, 30, 8, 7, 1, 0, -5, null].map(paperworkAlert)).toEqual([null, null, "d30", "d30", "d7", "d7", "expired", "expired", null]);
  });

  it("needs a certificate's end date, not one past or years away", () => {
    expect(endDateProblem("liability", "", TODAY)).toBe("Enter the date it ends. It's on the certificate.");
    expect(endDateProblem("workers_comp", null, TODAY)).toBe("Enter the date it ends. It's on the certificate.");
    expect(endDateProblem("liability", "2026-10-24", TODAY)).toBe("That date has already passed. Check it, or send the newer one.");
    expect(endDateProblem("liability", TODAY, TODAY)).toBeNull();
    expect(endDateProblem("wc_exemption", "2031-10-25", TODAY)).toBeNull();
    expect(endDateProblem("wc_exemption", "2032-01-01", TODAY)).toBe("Check the date it ends. It's more than five years away.");
    expect(endDateProblem("license", "2040-01-01", TODAY)).toBeNull();
    expect(endDateProblem("liability", "next year", TODAY)).toBe("Enter the date it ends.");
    expect(endDateProblem("wc_exemption", null, TODAY)).toBeNull();
    expect(endDateProblem("w9", "2030-01-01", TODAY)).toBeNull();
  });

  it("labels kinds and tax classifications, and reminds subs unless turned off", () => {
    expect(subDocumentLabel("wc_exemption")).toBe("Workers' comp exemption");
    expect(subDocumentLabel("nope")).toBe("Document");
    expect(taxClassificationLabel("llc_s_corp")).toBe("LLC taxed as an S corporation");
    expect(taxClassificationLabel(null)).toBeNull();
    expect(subSettings({})).toEqual({ remind_subs: true, sign_in_countries: [] });
    expect(subSettings({ subs: { remind_subs: false } })).toEqual({ remind_subs: false, sign_in_countries: [] });
    expect(subSettings(null)).toEqual({ remind_subs: true, sign_in_countries: [] });
  });

  it("asks a sub for what's missing or running out, and not for what's waiting to be checked", () => {
    const { needed, waiting } = neededPaperwork([
      { requirement: "w9", state: "ok", expires_on: null, verified: false },
      { requirement: "liability", state: "expiring", expires_on: "2026-11-10", verified: true },
    ]);
    expect(waiting).toEqual(["w9"]);
    expect(needed).toEqual([
      { requirement: "liability", label: "Liability insurance", state: "expiring", expires_on: "2026-11-10" },
      { requirement: "workers_comp", label: "Workers' comp", state: "missing", expires_on: null },
    ]);
    // Something sent in that has already run out is asked for again.
    const ranOut = neededPaperwork([{ requirement: "liability", state: "expired", expires_on: "2026-10-01", verified: false }]);
    expect(ranOut.waiting).toEqual([]);
    expect(ranOut.needed.map((n) => [n.requirement, n.state])).toEqual([["w9", "missing"], ["liability", "expired"], ["workers_comp", "missing"]]);
    expect(askingFor(needed)).toBe("your liability insurance and workers' comp");
    expect(askingFor([{ label: "W-9" }, { label: "Liability insurance" }, { label: "Workers' comp" }])).toBe("your W-9, liability insurance and workers' comp");
    expect(askingFor([])).toBe("your latest paperwork");
    expect(paperworkLinkIntro([{ label: "W-9" }])).toBe("Please send us your W-9. You can upload it from your phone or computer here:");
    expect(paperworkLinkIntro(needed)).toBe("Please send us your liability insurance and workers' comp. You can upload them from your phone or computer here:");
    // Something sent that's waiting isn't asked for again, even when the one on file is running out.
    expect(neededPaperwork([{ requirement: "liability", state: "expiring", expires_on: "2026-11-10", verified: true, waiting: true }]).waiting).toEqual(["liability"]);
  });

  it("writes the email and the text that send a sub their link", () => {
    const m = paperworkLinkMessages({ companyName: "Uniform Roofing", subName: "Apex Roofing LLC", contactName: "Al Apex", intro: "Please send us your W-9.", link: "https://x.test/paperwork/t" });
    expect(m.subject).toBe("Paperwork for Uniform Roofing");
    expect(m.text).toBe("Hi Al,\n\nPlease send us your W-9.\n\nhttps://x.test/paperwork/t\n\nThe link works for 30 days.\n\nThanks,\nUniform Roofing");
    expect(m.sms).toBe("Uniform Roofing: Please send us your W-9. https://x.test/paperwork/t");
    expect(paperworkLinkMessages({ companyName: "U", subName: "Apex Roofing LLC", intro: "i", link: "l" }).text).toMatch(/^Hi Apex Roofing LLC,/);
  });
});
