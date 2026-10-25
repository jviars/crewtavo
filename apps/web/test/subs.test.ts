import { describe, expect, it } from "vitest";
import { NAV_GROUPS, navVisible } from "../src/components/shell/nav";
import {
  documentTitle,
  endDateProblem,
  endsText,
  greeting,
  inOrder,
  insuranceWarning,
  kindsFor,
  needsAttention,
  neededWhy,
  paperworkBySub,
  paperworkChip,
  uploadProblem,
  withType,
  WRONG_TYPE,
  type PaperworkRow,
} from "../src/features/subs/paperwork";

const row = (requirement: string, state: string, extra: Partial<PaperworkRow> = {}): PaperworkRow => ({
  subcontractor_id: "s1", requirement, state, expires_on: null, days_left: null, verified: state === "missing" ? null : true, ...extra,
});
const MB = 1024 * 1024;

describe("subcontractor paperwork chips", () => {
  it("says OK, how long is left, expired, missing, or not verified yet", () => {
    expect(paperworkChip(row("w9", "ok"))).toEqual({ label: "OK", tone: "good" });
    expect(paperworkChip(row("liability", "expiring", { days_left: 12 }))).toEqual({ label: "Expires in 12 days", tone: "warning" });
    expect(paperworkChip(row("liability", "expiring", { days_left: 1 })).label).toBe("Expires tomorrow");
    expect(paperworkChip(row("liability", "expiring", { days_left: 0 })).label).toBe("Expires today");
    expect(paperworkChip(row("liability", "expired", { days_left: -3 }))).toEqual({ label: "Expired", tone: "danger" });
    expect(paperworkChip(row("workers_comp", "missing"))).toEqual({ label: "Missing", tone: "danger" });
    // Sent in by the sub: on file but not checked. Running out still shows as not checked; run out wins.
    expect(paperworkChip(row("w9", "ok", { verified: false }))).toEqual({ label: "Not verified yet", tone: "info" });
    expect(paperworkChip(row("liability", "expiring", { days_left: 5, verified: false })).label).toBe("Not verified yet");
    expect(paperworkChip(row("liability", "expired", { verified: false })).label).toBe("Expired");
    // The checked one on file runs out while a new one the sub sent waits: the office should verify it.
    expect(paperworkChip(row("liability", "expired", { verified: true, waiting: true }))).toEqual({ label: "Not verified yet", tone: "info" });
    expect(paperworkChip(row("liability", "expiring", { days_left: 3, verified: true, waiting: true })).label).toBe("Not verified yet");
    expect(paperworkChip(row("liability", "missing", { waiting: false })).label).toBe("Missing");
  });

  it("needs attention for anything but checked, current paperwork", () => {
    expect(needsAttention([row("w9", "ok"), row("liability", "ok"), row("workers_comp", "ok")])).toBe(false);
    expect(needsAttention([row("w9", "ok"), row("liability", "expiring", { days_left: 20 })])).toBe(true);
    expect(needsAttention([row("w9", "ok", { verified: false })])).toBe(true);
    expect(needsAttention([row("workers_comp", "missing")])).toBe(true);
    expect(needsAttention([row("liability", "ok", { waiting: true })])).toBe(true);
  });

  it("groups the view's rows by sub, in order, with anything absent as missing", () => {
    const bySub = paperworkBySub([
      row("workers_comp", "ok"),
      row("w9", "ok"),
      row("liability", "expired", { subcontractor_id: "s2" }),
    ]);
    expect(bySub.get("s1")!.map((r) => [r.requirement, r.state])).toEqual([["w9", "ok"], ["liability", "missing"], ["workers_comp", "ok"]]);
    expect(bySub.get("s2")!.map((r) => r.state)).toEqual(["missing", "expired", "missing"]);
    expect(inOrder([]).map((r) => paperworkChip(r).label)).toEqual(["Missing", "Missing", "Missing"]);
  });

  it("warns about insurance, never the W-9, and never stops anything", () => {
    expect(insuranceWarning([row("w9", "missing"), row("liability", "ok"), row("workers_comp", "expiring", { days_left: 9 })])).toBeNull();
    expect(insuranceWarning([row("w9", "ok"), row("liability", "expired"), row("workers_comp", "ok")])).toBe(
      "Their liability insurance has run out. You can still give them work, but without current certificates your insurance company may charge you for their work at your audit.",
    );
    expect(insuranceWarning([row("liability", "missing"), row("workers_comp", "expired")])).toMatch(/^Their liability insurance isn't on file and workers' comp has run out\. You can/);
    expect(insuranceWarning([row("liability", "expired", { waiting: true })])).toMatch(/^Their liability insurance has run out\. They've sent a new one: verify it below\. You can still/);
  });

  it("names documents and their end dates", () => {
    expect(kindsFor("workers_comp")).toEqual(["workers_comp", "wc_exemption"]);
    expect(kindsFor("w9")).toEqual(["w9"]);
    expect(documentTitle({ kind: "liability", title: "ignored" })).toBe("Liability insurance");
    expect(documentTitle({ kind: "license", title: "State contractor license" })).toBe("State contractor license");
    expect(documentTitle({ kind: "other", title: null })).toBe("Other");
    expect(endsText("2026-11-10", "2026-10-25")).toBe("Ends Nov 10, 2026");
    expect(endsText("2026-10-01", "2026-10-25")).toBe("Ended Oct 1, 2026");
    expect(endsText(null, "2026-10-25")).toBe("No end date");
  });
});

describe("the sub's upload page", () => {
  it("takes PDFs and photos up to the limit, in plain words otherwise", () => {
    expect(uploadProblem({ name: "COI 2027.pdf", size: 2 * MB, type: "application/pdf" }, 200 * MB)).toBeNull();
    expect(uploadProblem({ name: "IMG_0042.HEIC", size: 3 * MB, type: "" }, 200 * MB)).toBeNull();
    expect(uploadProblem({ name: "IMG_0042.heic", size: 3 * MB, type: "image/heif" }, 200 * MB)).toBeNull();
    expect(uploadProblem({ name: "photo.jpg", size: MB, type: "image/jpg" }, 200 * MB)).toBeNull();
    expect(uploadProblem({ name: "w9.docx", size: MB, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, 200 * MB)).toBe(WRONG_TYPE);
    expect(uploadProblem({ name: "scan.pdf", size: MB, type: "image/png" }, 200 * MB)).toBe(WRONG_TYPE);
    expect(uploadProblem({ name: "noextension", size: MB }, 200 * MB)).toBe(WRONG_TYPE);
    expect(uploadProblem({ name: "big.pdf", size: 201 * MB, type: "application/pdf" }, 200 * MB)).toBe("That file is bigger than 200 MB. Send a smaller one, or a photo of the page.");
    expect(uploadProblem({ name: "empty.pdf", size: 0, type: "application/pdf" }, 200 * MB)).toMatch(/empty/);
  });

  it("fills in a photo's type when the phone leaves it out", () => {
    const heic = withType(new File(["x"], "IMG_1.HEIC", { type: "" }));
    expect(heic.type).toBe("image/heic");
    expect(heic.name).toBe("IMG_1.HEIC");
    expect(withType(new File(["x"], "a.jpg", { type: "image/jpg" })).type).toBe("image/jpeg");
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    expect(withType(pdf)).toBe(pdf);
  });

  it("asks for the end date on certificates, and not a past one", () => {
    const today = "2026-10-25";
    expect(endDateProblem("liability", "", today)).toBe("Enter the date it ends. It's on the certificate.");
    expect(endDateProblem("workers_comp", "2026-10-24", today)).toBe("That date has already passed. Check it, or send the newer one.");
    expect(endDateProblem("workers_comp", "2026-10-25", today)).toBeNull();
    expect(endDateProblem("liability", "2027-10-25", today)).toBeNull();
    // The same check the server makes: a date years off is a typo.
    expect(endDateProblem("liability", "2035-10-25", today)).toBe("Check the date it ends. It's more than five years away.");
    // An exemption or a license may not end; a W-9 never does.
    expect(endDateProblem("wc_exemption", "", today)).toBeNull();
    expect(endDateProblem("license", "", today)).toBeNull();
    expect(endDateProblem("w9", "", today)).toBeNull();
  });

  it("greets the sub and says why each item is asked for", () => {
    expect(greeting("Apex Roofing LLC", "Uniform Roofing")).toBe("Hi Apex Roofing LLC, Uniform Roofing needs these from you:");
    expect(neededWhy({ state: "missing", expires_on: null })).toBe("We don't have one on file yet.");
    expect(neededWhy({ state: "expiring", expires_on: "2026-11-10" })).toBe("The one we have ends Nov 10, 2026.");
    expect(neededWhy({ state: "expired", expires_on: "2026-10-01" })).toBe("The one we have ran out Oct 1, 2026.");
  });
});

describe("Subcontractors in the menu", () => {
  const SUBS = NAV_GROUPS.flat().find((item) => item.to === "/subs")!;
  const person = (role: string, permissions: string[]) => ({ role, permissions, company: { settings: {} } });

  it("shows to owners, and admins and office staff with the Subcontractors area", () => {
    expect(navVisible(person("owner", []), SUBS)).toBe(true);
    expect(navVisible(person("admin", ["subs"]), SUBS)).toBe(true);
    expect(navVisible(person("office", ["subs", "invoices"]), SUBS)).toBe(true);
    expect(navVisible(person("office", ["invoices"]), SUBS)).toBe(false);
    expect(navVisible(person("estimator", ["subs"]), SUBS)).toBe(false);
    expect(navVisible(person("crew_lead", ["subs"]), SUBS)).toBe(false);
    expect(navVisible(person("field_crew", []), SUBS)).toBe(false);
  });
});
