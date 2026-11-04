/** What the screens say about equipment at a property (features/clients/propertyAssets.ts), and its history's order. */
import { describe, expect, it } from "vitest";
import { assetDetails, byNewest, warrantyNote, type ServiceVisit } from "../src/features/clients/propertyAssets";

const visit = (id: string, scheduled_on: string | null, completed_at: string | null = null): ServiceVisit => ({ id, title: id, scheduled_on, completed_at, crew: null, assignees: [], checklists: [] });

describe("equipment at a property", () => {
  it("tells one item from another by make, model, serial and where it is, leaving out what's missing", () => {
    expect(assetDetails({ make: "Lennox", model: "EL296", serial: "SN-1", location: "Basement" })).toBe("Lennox EL296 · Serial SN-1 · Basement");
    expect(assetDetails({ make: null, model: "EL296", serial: null, location: "Attic" })).toBe("EL296 · Attic");
    expect(assetDetails({ make: null, model: null, serial: null, location: null })).toBe("");
  });

  it("says whether it's under warranty, through the last day", () => {
    expect(warrantyNote(null, "2026-11-03")).toBeNull();
    expect(warrantyNote("2026-11-03", "2026-11-03")).toBe("Under warranty until Nov 3, 2026");
    expect(warrantyNote("2026-11-02", "2026-11-03")).toBe("Warranty ended Nov 2, 2026");
  });

  it("lists the visits that serviced it newest first, by the day done or else the day scheduled", () => {
    const order = byNewest([visit("spring", "2026-04-01", "2026-04-02T15:00:00Z"), visit("fall", "2026-10-01"), visit("unscheduled", null)]).map((v) => v.id);
    expect(order).toEqual(["fall", "spring", "unscheduled"]);
  });
});
